// The radmagelabs.com function behind /ffxiv/prices/ (entry: ../ffxiv-prices.mjs). It checks the
// path against the contract and allow.mjs, asks Universalis itself, keeps only the price fields,
// and tells Vercel's CDN how long to keep the answer. Nothing about the visitor goes upstream: the
// request to Universalis is built from the checked path alone, with fixed headers and no cookies,
// and written straight to a TLS socket (fetch and Node's http client both get the visitor's
// request id added by Vercel's runtime), so Universalis sees Vercel's address and this function's
// User-Agent, never the visitor's address, cookies, referer, language, browser, location or
// request id.
//
// Plain JavaScript with no packages, so radmagelabs.com needs no build step and no package.json.
// createPricesHandler(options) returns { fetch(request) }, the Web-standard handler Vercel runs.
// Options exist for the tests and the isolated prototype; the defaults are production's.
//
// Answers (JSON, X-Content-Type-Options: nosniff, never Set-Cookie):
//   200  the price fields. Browser: Cache-Control: no-cache. CDN: Vercel-CDN-Cache-Control:
//        max-age=<TTL>, stale-while-revalidate=<STALE>, stale-if-error=<STALE_IF_ERROR>.
//        X-Prices-Source: live, X-Prices-Fetched: when this function got the answer from
//        Universalis (ms since 1970), which the CDN keeps with the answer.
//   200  X-Prices-Source: last-good, when Universalis fails and this instance still holds a good
//        answer for the same path (at most lastGood.maxAgeMs old); X-Prices-Fetched is its time.
//        The CDN keeps it for at most lastGood.cdnSeconds, then only as stale-if-error.
//   400  a path in the wrong form: ids out of order or repeated, or a query string of the visitor's
//   404  a path the page never asks for: unknown kind, scope, world or item; also Universalis 404
//   405  anything but GET (a HEAD missed the CDN and reached Universalis on the prototype)
//   429  Universalis asked to slow down, or this instance's own limit is full (Retry-After)
//   502  Universalis answered something that is not a price answer (malformed, too big, a redirect)
//   503  Universalis is failing or unreachable, or this function is waiting out a backoff (Retry-After)
//   504  Universalis took longer than the timeout
// Every answer except a 200 says no-store to the browser and the CDN, so nothing but a good answer
// is ever cached.
import { connect as netConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import * as CONTRACT from './contract.mjs';
import * as ALLOW from './allow.mjs';

const { AGGREGATED_PLACES, AGGREGATED_SIDE, ENTRIES, ITEM_TYPES, LISTINGS, PATTERNS, STALE, STALE_IF_ERROR, TAX_CITY, TTL, UPLOAD_TIME, UPSTREAM, upstreamFor } = CONTRACT;

// The path prefix the page uses; vercel.json rewrites everything under it to this function.
export const PREFIX = '/ffxiv/prices/';
// Query parameters a rewrite rule itself adds: its route parameter (:path*) and, when the
// destination names one, p. Each may only repeat the path.
const REWRITE_PARAMS = ['path', 'p'];
// What Universalis sees as the client. Fixed, the same for every visitor.
export const USER_AGENT = 'ffxiv-prices/1';
// Item ids above this patch's Item table (allow.ITEM_ID_MAX) may come from a newer patch than the
// tables the allow list was built from, so they pass up to this bound. Universalis lists an id it
// does not know in failedItems.
export const ID_CEILING = 99999;
const MAX_PATH = 1200; // 100 ids of 9 digits plus commas and the prefix fit in about 1,030

export const DEFAULTS = Object.freeze({
  upstream: UPSTREAM,
  userAgent: USER_AGENT,
  ttl: TTL,
  stale: STALE,
  // Upstream request: headers and body together must arrive within this time.
  timeoutMs: 8000,
  // Largest upstream body read, decompressed. Measured: 100 ids at world scope about 90 KB, an item
  // with 20 listings and 20 sales about 12 KB, tax rates 114 bytes.
  maxBytes: { aggregated: 1_000_000, item: 300_000, tax: 4_000 },
  // Per instance. Universalis documents 25 requests a second (burst 50) and 8 connections per
  // address; Vercel's outgoing addresses are shared, so this stays well under both.
  rate: { perSecond: 5, burst: 10, concurrency: 4, maxQueue: 50, maxWaitMs: 3000 },
  // After a 429, a 5xx, a timeout or a dropped connection, no request goes upstream until the hold
  // ends: baseMs, doubling with each failure in a row up to maxMs, or the upstream's Retry-After
  // (at most maxRetryAfterMs) if longer. Then one request at a time tries again.
  backoff: { baseMs: 2000, maxMs: 60_000, maxRetryAfterMs: 120_000 },
  // The last good answer per path, in this instance's memory, served when Universalis fails.
  lastGood: {
    maxEntries: 500, maxBytes: 32 * 1024 * 1024, cdnSeconds: 60,
    maxAgeMs: { aggregated: 12 * 3600_000, item: 12 * 3600_000, tax: 7 * 24 * 3600_000 },
  },
  // Seconds of stale-if-error per kind in the CDN header (null leaves it out).
  staleIfError: STALE_IF_ERROR,
  // Adds X-Prices-Instance and X-Prices-Upstream-Ms (prototype only).
  debug: false,
  // The path the rewrite rule matches (the prototype serves lab copies under other prefixes).
  prefix: PREFIX,
});

const merge = (base, over) => {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' ? merge(base[k], v) : v;
  }
  return out;
};

// ---- what may be asked ----
export function allowFrom(a = ALLOW) {
  const scopes = new Set([...a.REGIONS, ...a.DATA_CENTERS, ...a.WORLDS.map(([, name]) => name)]);
  const worldIds = new Set(a.WORLDS.map(([id]) => id));
  const bits = new Uint8Array((a.ITEM_ID_MAX >> 3) + 1);
  let count = 0, sum = 0, last = 0;
  for (const run of a.MARKETABLE.split(',')) {
    const [gap, extra = '0'] = run.split('.');
    const first = last + parseInt(gap, 36);
    last = first + parseInt(extra, 36);
    if (!(first > 0 && last >= first && last <= a.ITEM_ID_MAX)) throw new Error(`allow.mjs: bad run ${run}`);
    for (let id = first; id <= last; id++) { bits[id >> 3] |= 1 << (id & 7); count += 1; sum += id; }
  }
  // A damaged or cut-short list fails closed: the function will not start.
  if (count !== a.MARKETABLE_COUNT || sum !== a.MARKETABLE_SUM) {
    throw new Error(`allow.mjs: ${count} items adding up to ${sum}, expected ${a.MARKETABLE_COUNT} adding up to ${a.MARKETABLE_SUM}`);
  }
  const onBoard = (id) => (bits[id >> 3] & (1 << (id & 7))) !== 0;
  return { scopes, worldIds, itemOk: (id) => (id <= a.ITEM_ID_MAX ? onBoard(id) : id <= ID_CEILING) };
}

const refuse = (status, error) => ({ refuse: { status, error } });
const ID = /^[1-9][0-9]{0,8}$/;

// The checked route for a request URL, or { refuse: { status, error } }.
//
// Behind the rewrite, Vercel hands the function the visitor's own URL (/ffxiv/prices/<path>) with
// the rule's route parameter added to the query (path=<path>), and any query the visitor added
// (measured on the prototype 2026-11-17). So the path comes from the URL itself; the query may only
// repeat it, under the rule's parameter names, once each. Anything else is a query from the visitor,
// which would only split the cache, and is refused. One address per answer keeps CDN keys stable.
export function routeOf(requestUrl, allow, base = UPSTREAM, prefix = PREFIX) {
  let url;
  try { url = new URL(requestUrl); } catch { return refuse(400, 'bad address'); }
  if (!url.pathname.startsWith(prefix)) return refuse(404, 'unknown path');
  const path = url.pathname.slice(prefix.length);
  const seen = new Set();
  for (const [k, v] of url.searchParams) {
    if (!REWRITE_PARAMS.includes(k) || seen.has(k) || v !== path) return refuse(400, 'unexpected query');
    seen.add(k);
  }
  if (path.length > MAX_PATH) return refuse(404, 'unknown path');
  const route = upstreamFor(path, base);
  if (!route) return refuse(404, 'unknown path');
  if (route.kind === 'tax') return allow.worldIds.has(route.world) ? { ...route, key: path } : refuse(404, 'unknown world');
  if (!allow.scopes.has(route.scope)) return refuse(404, 'unknown scope');
  const raw = route.kind === 'item' ? [String(route.id)] : path.slice(path.lastIndexOf('/') + 1).split(',');
  let prev = 0;
  for (const s of raw) {
    if (!ID.test(s)) return refuse(404, 'unknown item');
    const id = Number(s);
    if (id <= prev) return refuse(400, 'ids must be ascending, each once');
    if (!allow.itemOk(id)) return refuse(404, 'not on the market board');
    prev = id;
  }
  return { ...route, key: path };
}

// ---- keeping only the price fields ----
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
function leaf(type, v) {
  if (type === 'num') return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  if (type === 'int') return Number.isSafeInteger(v) ? v : undefined;
  if (type === 'bool') return typeof v === 'boolean' ? v : undefined;
  if (type === 'str') return typeof v === 'string' && v.length <= 64 ? v : undefined;
  return undefined;
}
function pick(schema, obj) {
  const out = {};
  if (!isObj(obj)) return out;
  for (const [k, t] of Object.entries(schema)) {
    const v = leaf(t, obj[k]);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

// Each returns the answer rebuilt from the allowed fields, or null when it is not an answer to the
// question asked (then nothing is cached and the visitor gets 502 or the last good answer).
export const SHAPES = {
  aggregated(json, route) {
    if (!isObj(json) || !Array.isArray(json.results) || json.results.length > route.ids.length) return null;
    const want = new Set(route.ids);
    const seen = new Set();
    const results = [];
    for (const r of json.results) {
      if (!isObj(r) || !want.has(r.itemId) || seen.has(r.itemId)) return null;
      seen.add(r.itemId);
      const out = { itemId: r.itemId };
      for (const q of ['nq', 'hq']) {
        if (!isObj(r[q])) continue;
        out[q] = {};
        for (const [measure, fields] of Object.entries(AGGREGATED_SIDE)) {
          if (!isObj(r[q][measure])) continue;
          out[q][measure] = {};
          for (const place of AGGREGATED_PLACES) if (isObj(r[q][measure][place])) out[q][measure][place] = pick(fields, r[q][measure][place]);
        }
      }
      if (Array.isArray(r.worldUploadTimes)) out.worldUploadTimes = r.worldUploadTimes.slice(0, 200).filter(isObj).map((w) => pick(UPLOAD_TIME, w));
      results.push(out);
    }
    const failed = json.failedItems === undefined ? [] : json.failedItems;
    if (!Array.isArray(failed) || failed.length > route.ids.length || !failed.every((id) => want.has(id))) return null;
    return { results, failedItems: failed };
  },
  item(json, route) {
    if (!isObj(json) || json.itemID !== route.id) return null;
    const out = {};
    for (const [k, t] of Object.entries(ITEM_TYPES)) {
      const v = json[k];
      if (v === undefined) continue;
      if (isObj(t)) {
        if (!Array.isArray(v) || v.length > (k === 'listings' ? LISTINGS : ENTRIES)) return null;
        out[k] = v.map((x) => pick(t, x));
      } else if (t === 'times') {
        if (!isObj(v)) continue;
        const times = {};
        for (const [world, ms] of Object.entries(v).slice(0, 200)) if (/^[0-9]{1,5}$/.test(world) && leaf('num', ms) !== undefined) times[world] = ms;
        out[k] = times;
      } else {
        const kept = leaf(t, v);
        if (kept !== undefined) out[k] = kept;
      }
    }
    return out;
  },
  tax(json) {
    if (!isObj(json)) return null;
    const entries = Object.entries(json);
    if (entries.length > 16) return null;
    const out = {};
    for (const [city, rate] of entries) {
      if (!TAX_CITY.test(city) || !Number.isInteger(rate) || rate < 0 || rate > 100) return null;
      out[city] = rate;
    }
    return out;
  },
};

// ---- the request to Universalis ----
// The whole request: GET, the URL from the checked path, these headers. nodeRequest adds only
// Host, Accept-Encoding: gzip and Connection: close. Exported so the prototype's echo check sends
// exactly what the handler sends.
export function upstreamInit(userAgent, signal) {
  return { method: 'GET', headers: { accept: 'application/json', 'user-agent': userAgent }, redirect: 'manual', signal };
}

// A minimal HTTP/1.1 GET over a TLS (or, in the tests, plain TCP) socket, answering a standard
// Response with the body decoded. Not fetch and not Node's http client: Vercel's runtime adds
// X-Vercel-Id and X-Invocation-Id (the visitor's request id, which names the edge location they
// came through) to every request made with either, and removeHeader cannot take them off; fetch
// also adds Accept-Language and Sec-Fetch-Mode. Bytes written to a socket arrive as written (all
// measured on the prototype, 2026-11-17). One connection per request, closed after the answer.
// init.maxBytes bounds the decoded body; the raw answer may be at most that plus 64 KB.
class Malformed extends Error {}
const HEAD_LIMIT = 64 * 1024;
const DECODE = { gzip: gunzipSync, 'x-gzip': gunzipSync, deflate: inflateSync, br: brotliDecompressSync };

// The answer so far: null while it is incomplete, else { status, headers, body } with the body
// still in its transfer and content encodings. Throws Malformed when it cannot be an HTTP answer.
function parseAnswer(buf, ended) {
  const end = buf.indexOf('\r\n\r\n');
  if (end < 0) {
    if (buf.length > HEAD_LIMIT) throw new Malformed('header too long');
    if (ended) throw new Error('connection closed before an answer'); // a network failure, like a reset
    return null;
  }
  const lines = buf.subarray(0, end).toString('latin1').split('\r\n');
  const m = /^HTTP\/1\.[01] ([1-5][0-9][0-9])(?: |$)/.exec(lines[0]);
  if (!m) throw new Malformed('bad status line');
  const headers = new Headers();
  for (const line of lines.slice(1)) {
    const at = line.indexOf(':');
    if (at <= 0) throw new Malformed('bad header line');
    try { headers.append(line.slice(0, at).trim(), line.slice(at + 1).trim()); } catch { throw new Malformed('bad header'); }
  }
  const status = Number(m[1]);
  let body = buf.subarray(end + 4);
  if (status < 200) throw new Malformed('informational answer');
  if (/chunked/i.test(headers.get('transfer-encoding') || '')) {
    const parts = [];
    let at = 0;
    for (;;) {
      const lineEnd = body.indexOf('\r\n', at);
      if (lineEnd < 0) { if (ended) throw new Error('connection closed early'); return null; }
      const size = parseInt(body.subarray(at, lineEnd).toString('latin1').split(';')[0], 16);
      if (!Number.isInteger(size) || size < 0) throw new Malformed('bad chunk size');
      if (size === 0) break;
      if (body.length < lineEnd + 2 + size + 2) { if (ended) throw new Error('connection closed early'); return null; }
      parts.push(body.subarray(lineEnd + 2, lineEnd + 2 + size));
      at = lineEnd + 2 + size + 2;
    }
    body = Buffer.concat(parts);
  } else if (headers.has('content-length')) {
    const length = Number(headers.get('content-length'));
    if (!Number.isSafeInteger(length) || length < 0) throw new Malformed('bad content-length');
    if (body.length < length) { if (ended) throw new Error('connection closed early'); return null; }
    body = body.subarray(0, length);
  } else if (!ended) {
    return null; // the body runs to the end of the connection
  }
  return { status, headers, body };
}

export function nodeRequest(url, init) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const secure = u.protocol === 'https:';
    if (!secure && u.protocol !== 'http:') { reject(new TypeError(`unsupported protocol ${u.protocol}`)); return; }
    const lines = [`GET ${u.pathname}${u.search} HTTP/1.1`, `Host: ${u.host}`];
    for (const [k, v] of Object.entries({ ...init.headers, 'accept-encoding': 'gzip', connection: 'close' })) {
      if (/[\r\n]/.test(`${k}${v}`)) { reject(new TypeError('header with a line break')); return; }
      lines.push(`${k}: ${v}`);
    }
    const maxRaw = (init.maxBytes || 1_000_000) + HEAD_LIMIT;
    const port = Number(u.port) || (secure ? 443 : 80);
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const socket = secure ? tlsConnect({ host, port, servername: host, ALPNProtocols: ['http/1.1'] }) : netConnect({ host, port });
    const chunks = [];
    let size = 0, done = false;
    const finish = (err, answer) => {
      if (done) return;
      done = true;
      socket.destroy();
      init.signal?.removeEventListener('abort', onAbort);
      if (err) { reject(err); return; }
      try {
        const encoding = String(answer.headers.get('content-encoding') || 'identity').toLowerCase();
        let body = answer.body;
        if (encoding !== 'identity') {
          if (!DECODE[encoding]) throw new Malformed(`content-encoding ${encoding}`);
          try { body = DECODE[encoding](body, { maxOutputLength: init.maxBytes || 1_000_000 }); } catch (e) {
            throw e && e.code === 'ERR_BUFFER_TOO_LARGE' ? new TooBig() : e;
          }
          answer.headers.delete('content-encoding');
          answer.headers.delete('content-length');
        }
        const empty = answer.status === 204 || answer.status === 205 || answer.status === 304;
        resolve(new Response(empty ? null : body, { status: answer.status, headers: answer.headers }));
      } catch (e) { reject(e); }
    };
    const onAbort = () => finish(init.signal.reason || new Error('aborted'));
    if (init.signal?.aborted) { onAbort(); return; }
    init.signal?.addEventListener('abort', onAbort, { once: true });
    socket.once(secure ? 'secureConnect' : 'connect', () => socket.write(`${lines.join('\r\n')}\r\n\r\n`));
    const settle = (ended) => {
      if (done) return;
      try { const answer = parseAnswer(Buffer.concat(chunks), ended); if (answer) finish(null, answer); else if (ended) finish(new Error('connection closed early')); } catch (e) { finish(e); }
    };
    socket.on('data', (d) => {
      size += d.length;
      if (size > maxRaw) { finish(new TooBig()); return; }
      chunks.push(d);
      settle(false);
    });
    socket.on('end', () => settle(true));
    socket.on('close', () => settle(true));
    socket.on('error', (e) => finish(e));
  });
}

class TooBig extends Error {}
async function readCapped(res, max) {
  const declared = Number(res.headers.get('content-length'));
  if (declared > max) { await res.body?.cancel().catch(() => {}); throw new TooBig(); }
  if (!res.body) return ''; // no body at all: not JSON, so malformed
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel().catch(() => {}); throw new TooBig(); }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.byteLength; }
  return new TextDecoder('utf-8', { fatal: true }).decode(all);
}

// Seconds from a Retry-After header (seconds or an HTTP date), or 0.
function retryAfterSeconds(value, now) {
  if (!value) return 0;
  if (/^[0-9]{1,6}$/.test(value.trim())) return Number(value.trim());
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - now) / 1000)) : 0;
}

// ---- the per-instance limiter: a token bucket plus a cap on requests in flight ----
export function createLimiter({ perSecond, burst, concurrency, maxQueue, maxWaitMs }, now = Date.now) {
  let tokens = burst;
  let last = now();
  let active = 0;
  let timer = null;
  const queue = [];
  const refill = () => { const t = now(); tokens = Math.min(burst, tokens + ((t - last) * perSecond) / 1000); last = t; };
  const release = () => { let done = false; return () => { if (done) return; done = true; active -= 1; pump(); }; };
  function pump() {
    if (timer) { clearTimeout(timer); timer = null; }
    refill();
    while (queue.length && active < concurrency && tokens >= 1) {
      const w = queue.shift();
      clearTimeout(w.timeout);
      tokens -= 1;
      active += 1;
      w.resolve(release());
    }
    if (queue.length && active < concurrency) timer = setTimeout(pump, Math.max(1, Math.ceil(((1 - tokens) * 1000) / perSecond)));
  }
  return {
    // Resolves to a release function, or to null when the wait would pass maxWaitMs or the queue is full.
    acquire() {
      return new Promise((resolve) => {
        if (queue.length >= maxQueue) { resolve(null); return; }
        const w = { resolve };
        w.timeout = setTimeout(() => { const i = queue.indexOf(w); if (i >= 0) { queue.splice(i, 1); resolve(null); } }, maxWaitMs);
        queue.push(w);
        pump();
      });
    },
    stats: () => ({ tokens, active, queued: queue.length }),
  };
}

// ---- the handler ----
export function createPricesHandler(options = {}) {
  const o = merge(DEFAULTS, options);
  const fetchImpl = options.fetch || nodeRequest;
  const now = options.now || Date.now;
  const allow = options.allow ? allowFrom(options.allow) : allowFrom();
  const limiter = createLimiter(o.rate, now);
  const inflight = new Map(); // path -> promise of a result, so one upstream request serves every caller
  const lastGood = new Map(); // path -> { body, fetchedAt }, oldest use first
  let lastGoodBytes = 0;
  const circuit = { failures: 0, until: 0, probing: false };
  const instance = Math.random().toString(36).slice(2, 10);
  const counters = { upstream: 0, coalesced: 0, lastGood: 0, refused: 0 };

  const baseHeaders = () => ({ 'content-type': 'application/json; charset=utf-8', 'x-content-type-options': 'nosniff' });
  const noStore = (extra = {}) => ({ ...baseHeaders(), 'cache-control': 'no-store', 'vercel-cdn-cache-control': 'no-store', ...extra });
  const failure = (status, error, retryAfter = 0) => ({ status, body: JSON.stringify({ error }), headers: noStore(retryAfter ? { 'retry-after': String(retryAfter) } : {}) });

  function goodHeaders(kind, fetchedAt, source) {
    let cdn = source === 'live'
      ? `max-age=${o.ttl[kind]}, stale-while-revalidate=${o.stale[kind]}`
      : `max-age=${Math.min(o.lastGood.cdnSeconds, o.ttl[kind])}`;
    // Also on a last-good answer, so replacing a stale copy with it never loses the CDN's fallback.
    if (o.staleIfError && o.staleIfError[kind]) cdn += `, stale-if-error=${o.staleIfError[kind]}`;
    return { ...baseHeaders(), 'cache-control': 'no-cache', 'vercel-cdn-cache-control': cdn, 'x-prices-source': source, 'x-prices-fetched': String(fetchedAt) };
  }

  function remember(key, body, fetchedAt) {
    const had = lastGood.get(key);
    if (had) { lastGoodBytes -= had.body.length; lastGood.delete(key); }
    lastGood.set(key, { body, fetchedAt });
    lastGoodBytes += body.length;
    for (const [k, v] of lastGood) {
      if (lastGood.size <= o.lastGood.maxEntries && lastGoodBytes <= o.lastGood.maxBytes) break;
      lastGood.delete(k);
      lastGoodBytes -= v.body.length;
    }
  }

  // The last good answer for this path if it is young enough, else the failure.
  function fallback(route, status, error, retryAfter = 0) {
    const had = lastGood.get(route.key);
    if (had && now() - had.fetchedAt <= o.lastGood.maxAgeMs[route.kind]) {
      lastGood.delete(route.key); lastGood.set(route.key, had); // most recently used
      counters.lastGood += 1;
      return { status: 200, body: had.body, headers: goodHeaders(route.kind, had.fetchedAt, 'last-good') };
    }
    return failure(status, error, retryAfter);
  }

  function noteFailure(retryAfter) {
    circuit.failures += 1;
    const hold = Math.min(o.backoff.maxMs, o.backoff.baseMs * 2 ** (circuit.failures - 1));
    const asked = Math.min(o.backoff.maxRetryAfterMs, retryAfter * 1000);
    circuit.until = Math.max(circuit.until, now() + Math.max(hold, asked));
  }
  const holdSeconds = () => Math.max(1, Math.ceil((circuit.until - now()) / 1000));
  const holding = () => circuit.until > now() || (circuit.failures > 0 && circuit.probing);

  async function ask(route) {
    counters.upstream += 1;
    // One deadline for the headers and the whole body. A plain timer rather than
    // AbortSignal.timeout(), whose timer does not keep Node running on its own.
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new DOMException('Universalis took too long', 'TimeoutError')), o.timeoutMs);
    try { return await askWithin(route, deadline.signal); } finally { clearTimeout(timer); }
  }
  async function askWithin(route, signal) {
    // A deadline shows as an aborted signal whatever error the client raised for it.
    const broken = (e) => (signal.aborted ? 'timeout' : e instanceof Malformed || (e && /^Z_/.test(String(e.code))) ? 'malformed' : 'network');
    let res;
    try {
      res = await fetchImpl(route.url, { ...upstreamInit(o.userAgent, signal), maxBytes: o.maxBytes[route.kind] });
    } catch (e) {
      return { fail: e instanceof TooBig ? 'too-big' : broken(e) };
    }
    const drop = () => res.body?.cancel().catch(() => {});
    try {
      if (res.status === 429) { await drop(); return { fail: 'limited', retryAfter: retryAfterSeconds(res.headers.get('retry-after'), now()) }; }
      if (res.status >= 500) { await drop(); return { fail: 'status', retryAfter: retryAfterSeconds(res.headers.get('retry-after'), now()) }; }
      if (res.status === 404) { await drop(); return { fail: 'not-found' }; }
      if (res.status !== 200) { await drop(); return { fail: 'unexpected' }; }
      if (!/json/i.test(res.headers.get('content-type') || '')) { await drop(); return { fail: 'malformed' }; }
      const text = await readCapped(res, o.maxBytes[route.kind]);
      let json;
      try { json = JSON.parse(text); } catch { return { fail: 'malformed' }; }
      const shaped = SHAPES[route.kind](json, route);
      return shaped ? { ok: true, body: JSON.stringify(shaped) } : { fail: 'malformed' };
    } catch (e) {
      if (e instanceof TooBig) return { fail: 'too-big' };
      if (e instanceof TypeError && /decode|encoded/i.test(e.message)) return { fail: 'malformed' };
      return { fail: broken(e) };
    }
  }

  async function load(route) {
    if (holding()) return fallback(route, 503, 'Universalis is unavailable; trying again shortly', holdSeconds());
    const release = await limiter.acquire();
    if (!release) return fallback(route, 429, 'busy; try again shortly', 1);
    if (holding()) { release(); return fallback(route, 503, 'Universalis is unavailable; trying again shortly', holdSeconds()); }
    const probe = circuit.failures > 0;
    if (probe) circuit.probing = true;
    const started = now();
    let r;
    try { r = await ask(route); } finally { release(); if (probe) circuit.probing = false; }
    const tookMs = now() - started;
    let result;
    if (r.ok) {
      circuit.failures = 0; circuit.until = 0;
      const fetchedAt = now();
      remember(route.key, r.body, fetchedAt);
      result = { status: 200, body: r.body, headers: goodHeaders(route.kind, fetchedAt, 'live') };
    } else if (r.fail === 'not-found') {
      result = failure(404, 'Universalis does not know this');
    } else if (r.fail === 'limited') {
      noteFailure(r.retryAfter);
      result = fallback(route, 429, 'Universalis asked to slow down', holdSeconds());
    } else if (r.fail === 'status' || r.fail === 'network' || r.fail === 'timeout') {
      noteFailure(r.retryAfter || 0);
      result = r.fail === 'timeout' ? fallback(route, 504, 'Universalis took too long') : fallback(route, 503, 'Universalis is unavailable', holdSeconds());
    } else {
      result = fallback(route, 502, 'Universalis sent an answer this page cannot use');
    }
    if (!r.ok) console.warn(`ffxiv-prices: ${route.key.slice(0, 80)} ${r.fail} -> ${result.status}${result.headers['x-prices-source'] ? ' (last good)' : ''}`);
    if (o.debug) result.headers = { ...result.headers, 'x-prices-upstream-ms': String(tookMs) };
    return result;
  }

  async function handle(request) {
    let result;
    if (request.method !== 'GET') {
      result = { ...failure(405, 'GET only'), headers: noStore({ allow: 'GET' }) };
    } else {
      const route = routeOf(request.url, allow, o.upstream, o.prefix);
      if (route.refuse) {
        counters.refused += 1;
        result = failure(route.refuse.status, route.refuse.error);
      } else {
        let pending = inflight.get(route.key);
        if (pending) counters.coalesced += 1;
        else {
          pending = load(route)
            .catch((e) => { console.error(`ffxiv-prices: ${route.key.slice(0, 80)} internal error ${e && e.name}`); return failure(500, 'internal error'); })
            .finally(() => inflight.delete(route.key));
          inflight.set(route.key, pending);
        }
        result = await pending;
      }
    }
    const headers = o.debug ? { ...result.headers, 'x-prices-instance': instance } : result.headers;
    return new Response(result.body, { status: result.status, headers });
  }

  return { fetch: handle, state: { circuit, counters, lastGood, inflight, limiter, instance } };
}
