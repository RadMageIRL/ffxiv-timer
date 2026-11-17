// Tests for the radmagelabs.com price function (radmagelabs/api/): what reaches Universalis, what
// reaches the visitor, which answers the CDN may cache, failures, the last good answer, the
// per-instance rate limit and backoff, and the vercel.json merge. Run alone with
// `node tests/prices-function.mjs`, or through tests/run.mjs. No network: Universalis is played by
// the captured answers in tests/fixtures/universalis/, in memory or from a local HTTP server.
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ALLOW from '../radmagelabs/api/_ffxiv-prices/allow.mjs';
import { FORBIDDEN_KEYS, ITEM_FIELDS, ITEM_TYPES, keysDeep, MAX_IDS, STALE, STALE_IF_ERROR, TTL } from '../radmagelabs/api/_ffxiv-prices/contract.mjs';
import { gzipSync } from 'node:zlib';
import diagnostics from 'node:diagnostics_channel';
import { allowFrom, createLimiter, createPricesHandler, DEFAULTS, ID_CEILING, routeOf, USER_AGENT } from '../radmagelabs/api/_ffxiv-prices/handler.mjs';
import { decodeItems } from '../tools/build-market.mjs';
import { FRAGMENT, mergeLabsConfig, mergeLabsText } from '../tools/labs-function.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const M = createRequire(import.meta.url)('../js/market-items.js');
const ITEMS = decodeItems(M.items);
const fx = (name) => JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'universalis', `${name}.json`), 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The handler logs each upstream failure (Vercel keeps the log); here those are expected.
const warn = console.warn;
console.warn = (m, ...rest) => { if (!String(m).startsWith('ffxiv-prices:')) warn(m, ...rest); };

let passed = 0, failed = 0;
const queue = [];
const test = (name, fn) => queue.push([name, fn]);

// ---- a Universalis made of the captured answers ----
const JSON_TYPE = { 'content-type': 'application/json; charset=utf-8' };
// The captured aggregated answer cut down to the ids asked for (ids it has no answer for become
// failedItems), as Universalis answers any id list.
function aggregatedFor(name, ids) {
  const base = fx(name);
  const results = base.results.filter((r) => ids.includes(r.itemId));
  return { results, failedItems: ids.filter((id) => !results.some((r) => r.itemId === id)) };
}
const DC_IDS = fx('aggregated-dc').results.map((r) => r.itemId).sort((a, b) => a - b);
// Answers by upstream URL. Each call is logged with the request it got.
function fakeUpstream(answer = defaultAnswer) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const a = await answer(url, init, calls.length);
    if (a instanceof Response) return a;
    return new Response(typeof a.body === 'string' ? a.body : JSON.stringify(a.body), { status: a.status || 200, headers: { ...JSON_TYPE, ...(a.headers || {}) } });
  };
  return { fetch, calls };
}
function defaultAnswer(url) {
  const u = new URL(url);
  let m;
  if ((m = /\/aggregated\/([^/]+)\/([0-9,]+)$/.exec(u.pathname))) {
    const name = m[1] === 'Gilgamesh' ? 'aggregated-world' : m[1] === 'North-America' ? 'aggregated-region' : 'aggregated-dc';
    return { body: aggregatedFor(name, m[2].split(',').map(Number)) };
  }
  if (u.pathname.endsWith('/tax-rates')) return { body: fx('tax-gilgamesh') };
  if ((m = /\/([A-Za-z-]+)\/([0-9]+)$/.exec(u.pathname))) {
    const item = { ...fx(m[1] === 'Gilgamesh' ? 'item-world' : 'item-dc-hq') };
    item.itemID = Number(m[2]);
    return { body: item };
  }
  return { status: 404, body: fx('error-unknown-scope') };
}
// A request as Vercel hands it to the function behind the rewrite: the visitor's address plus the
// rule's route parameter (measured on the prototype).
const ask = (h, path, init = {}) => h.fetch(new Request(`https://radmagelabs.com/ffxiv/prices/${path}?path=${encodeURIComponent(path)}`, init));
const askJson = async (h, path, init) => { const r = await ask(h, path, init); return { r, status: r.status, json: await r.json() }; };
const AGG = `aggregated/Aether/${DC_IDS.join(',')}`;
// Generous limits so tests that are not about limits never wait.
const OPEN = { rate: { perSecond: 1000, burst: 1000, concurrency: 100, maxQueue: 1000, maxWaitMs: 1000 } };
const handler = (fetch, extra = {}) => createPricesHandler({ fetch, ...OPEN, ...extra });

// ---- privacy: what reaches Universalis ----
test('privacy: the upstream request is GET, the contract URL and two fixed headers, whatever the visitor sends', async () => {
  const up = fakeUpstream();
  const h = handler(up.fetch);
  const loud = {
    cookie: 'session=secret; _4e875=affinity', referer: 'https://radmagelabs.com/ffxiv/#market/item/5057',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/131', 'accept-language': 'fr-FR,fr;q=0.9', authorization: 'Bearer x',
    'x-forwarded-for': '203.0.113.7', 'x-real-ip': '203.0.113.7', forwarded: 'for=203.0.113.7', 'x-vercel-forwarded-for': '203.0.113.7',
    'x-vercel-ip-country': 'country-sentinel', origin: 'https://origin-sentinel.example', 'sec-ch-ua': 'ua-hint-sentinel', dnt: 'dnt-sentinel',
  };
  await ask(h, 'item/Aether/5057', { headers: loud });
  await ask(h, 'item/Gilgamesh/5057');
  assert.equal(up.calls.length, 2);
  for (const { url, init } of up.calls) {
    assert.equal(init.method, 'GET');
    assert.equal(init.body, undefined);
    assert.equal(init.redirect, 'manual');
    assert.deepEqual(init.headers, { accept: 'application/json', 'user-agent': USER_AGENT });
    assert.match(url, /^https:\/\/universalis\.app\/api\/v2\/(Aether|Gilgamesh)\/5057\?listings=20&entries=20&fields=/);
    for (const v of Object.values(loud)) assert.ok(!url.includes(v) && !JSON.stringify(init.headers).includes(v));
  }
});

test('privacy: no answer carries a name or a player id, even when Universalis adds them, and unknown fields are dropped', async () => {
  const poison = (o) => ({ ...o, retainerName: 'Seller', creatorName: 'Maker', buyerName: 'Buyer', sellerID: 'abc', retainerID: 'def', creatorID: 'ghi', listingID: 'jkl', newField: 1 });
  const up = fakeUpstream((url) => {
    const a = defaultAnswer(url);
    const b = a.body;
    if (b.listings) { b.listings = b.listings.map(poison); b.recentHistory = b.recentHistory.map(poison); return { body: poison(b) }; }
    if (b.results) { b.results = b.results.map((r) => ({ ...poison(r), nq: { ...r.nq, minListing: { ...r.nq.minListing, dc: poison(r.nq.minListing.dc || {}) } } })); return { body: poison(b) }; }
    return a;
  });
  const h = handler(up.fetch);
  for (const path of ['item/Aether/5057', 'item/Gilgamesh/5057', AGG]) {
    const { status, json } = await askJson(h, path);
    assert.equal(status, 200, path);
    const keys = keysDeep(json);
    for (const k of [...FORBIDDEN_KEYS, 'newField']) assert.ok(!keys.has(k), `${path}: ${k}`);
  }
});

test('privacy: the function keeps every field of every captured answer, and nothing else', async () => {
  const cases = [
    ['item/Aether/5057', 'item-dc-hq'], ['item/Aether/5057', 'item-dc-nq'], ['item/Gilgamesh/5057', 'item-world'],
    ['item/Aether/5057', 'item-thin'], ['item/Aether/5057', 'item-empty'], ['tax/63', 'tax-gilgamesh'],
  ];
  for (const [path, name] of cases) {
    const body = fx(name);
    const id = Number(path.split('/').pop());
    if (body.itemID !== undefined) body.itemID = id;
    const h = handler(fakeUpstream(() => ({ body })).fetch);
    assert.deepEqual((await askJson(h, path)).json, body, name);
  }
  for (const [scope, name] of [['Aether', 'aggregated-dc'], ['North-America', 'aggregated-region'], ['Gilgamesh', 'aggregated-world'], ['Aether', 'aggregated-empty']]) {
    const ids = fx(name).results.map((r) => r.itemId).filter((id) => ITEMS.some((i) => i.id === id)).sort((a, b) => a - b);
    const body = aggregatedFor(name, ids);
    const h = handler(fakeUpstream(() => ({ body })).fetch);
    assert.deepEqual((await askJson(h, `aggregated/${scope}/${ids.join(',')}`)).json, body, name);
  }
});

test('privacy: what Universalis sends besides the body (cookies, error reporting) never reaches the visitor', async () => {
  const up = fakeUpstream((url) => ({ ...defaultAnswer(url), headers: { 'set-cookie': '_4e875=a; Path=/', nel: '{"report_to":"cf-nel"}', 'report-to': '{"group":"cf-nel"}', server: 'cloudflare', 'cf-ray': 'abc' } }));
  const r = await ask(handler(up.fetch), 'tax/63');
  assert.equal(r.status, 200);
  assert.deepEqual([...r.headers.keys()].sort(), ['cache-control', 'content-type', 'vercel-cdn-cache-control', 'x-content-type-options', 'x-prices-fetched', 'x-prices-source']);
});

test('privacy, over real HTTP: a visitor request full of identifying headers reaches the upstream server as the fixed request only', async () => {
  const seen = [];
  const upstream = createServer((req, res) => {
    seen.push({ url: req.url, raw: req.rawHeaders, remote: req.socket.remoteAddress });
    res.writeHead(200, { ...JSON_TYPE, 'set-cookie': '_4e875=a; Path=/', 'content-encoding': 'gzip' });
    res.end(gzipSync(JSON.stringify(fx('tax-gilgamesh'))));
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const h = createPricesHandler({ upstream: `http://127.0.0.1:${upstream.address().port}/api/v2`, ...OPEN });
  // Vercel's runtime adds its request id to every request made with fetch or Node's http client
  // (measured on the prototype). Here a diagnostics-channel hook plays that part; the function's
  // request must not go through that client at all.
  let hookRan = false;
  const created = (msg) => {
    if (!String(msg.request.path).startsWith('/api/v2/')) return; // the test's own visitor request uses the http client
    try { msg.request.setHeader('x-vercel-id', 'cle1::visitor-request'); msg.request.setHeader('x-invocation-id', 'cle1::visitor-request'); hookRan = true; } catch { /* headers already sent */ }
  };
  const channels = ['http.client.request.created', 'http.client.request.start'];
  for (const c of channels) diagnostics.subscribe(c, created);
  // The function behind a local HTTP server, the way Vercel hands it requests.
  const front = createServer(async (req, res) => {
    const r = await h.fetch(new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: req.headers }));
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise((r) => front.listen(0, '127.0.0.1', r));
  try {
    const visitor = { cookie: 'session=secret', referer: 'https://radmagelabs.com/ffxiv/', 'user-agent': 'Mozilla/5.0 Firefox/133', 'accept-language': 'de-DE', 'x-forwarded-for': '198.51.100.9', 'x-vercel-forwarded-for': '198.51.100.9', forwarded: 'for=198.51.100.9' };
    const answer = await new Promise((ok, no) => {
      const req = httpRequest({ host: '127.0.0.1', port: front.address().port, path: '/ffxiv/prices/tax/63?path=tax%2F63', headers: visitor }, (res) => {
        let body = '';
        res.on('data', (d) => { body += d; });
        res.on('end', () => ok({ status: res.statusCode, headers: res.headers, body }));
      });
      req.on('error', no);
      req.end();
    });
    assert.equal(answer.status, 200);
    assert.deepEqual(JSON.parse(answer.body), fx('tax-gilgamesh'), 'the gzipped answer, decompressed');
    assert.equal(answer.headers['set-cookie'], undefined);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, '/api/v2/tax-rates?world=63');
    // Exactly these headers, with these values, and nothing else.
    const got = {};
    for (let i = 0; i < seen[0].raw.length; i += 2) got[seen[0].raw[i].toLowerCase()] = seen[0].raw[i + 1];
    assert.deepEqual(got, { accept: 'application/json', 'user-agent': USER_AGENT, 'accept-encoding': 'gzip', connection: 'close', host: `127.0.0.1:${upstream.address().port}` });
    const raw = seen[0].raw.join('\n');
    for (const v of Object.values(visitor)) assert.ok(!raw.includes(v), `visitor value reached upstream: ${v}`);
    assert.ok(!raw.includes('visitor-request'), 'headers added by the runtime never leave');
    assert.equal(hookRan, false, 'the upstream request does not go through the http client of Node');
  } finally {
    for (const c of channels) diagnostics.unsubscribe(c, created);
    await new Promise((r) => front.close(r));
    await new Promise((r) => upstream.close(r));
  }
});

// ---- what may be asked ----
test('allow list: exactly the regions, data centers and worlds of js/market-items.js, and exactly its items on the board', () => {
  assert.deepEqual(ALLOW.REGIONS, M.regions.map((r) => r.scope));
  assert.deepEqual(ALLOW.DATA_CENTERS, M.dataCenters.map((d) => d.name));
  assert.deepEqual(new Map(ALLOW.WORLDS), new Map(M.dataCenters.flatMap((d) => d.worlds.map((w) => [w.id, w.name]))));
  assert.equal(ALLOW.SOURCE.commit, M.source.commit);
  const allow = allowFrom();
  const onBoard = new Set(ITEMS.map((i) => i.id));
  for (let id = 1; id <= ALLOW.ITEM_ID_MAX; id++) assert.equal(allow.itemOk(id), onBoard.has(id), `item ${id}`);
  assert.ok(allow.itemOk(ALLOW.ITEM_ID_MAX + 1) && allow.itemOk(ID_CEILING) && !allow.itemOk(ID_CEILING + 1), 'ids from a newer patch, up to the ceiling');
  for (const s of allow.scopes) assert.match(s, /^[A-Za-z0-9-]{1,32}$/);
});

test('refused before Universalis: unknown kinds, scopes, worlds and items, the wrong case, unsorted or repeated ids, queries, other methods', async () => {
  const up = fakeUpstream();
  const h = handler(up.fetch);
  const cases = [
    ['aggregated/aether/2', 404], ['aggregated/AETHER/2', 404], ['aggregated/63/2', 404], ['aggregated/Shadow/2', 404], ['aggregated/Cloud/2', 404],
    ['aggregated/Aether/14,2', 400], ['aggregated/Aether/2,2', 400], ['aggregated/Aether/02', 404], ['aggregated/Aether/1', 404],
    ['aggregated/Aether/30000', 404], [`aggregated/Aether/${ID_CEILING + 1}`, 404], ['aggregated/Aether/', 404], ['aggregated/Aether/2,', 404],
    [`aggregated/Aether/${ITEMS.slice(0, MAX_IDS + 1).map((i) => i.id).join(',')}`, 404],
    ['item/Aether/1', 404], ['item/Aether/5057/x', 404], ['item/Aether/5057,5058', 404], ['tax/9999', 404], ['tax/Gilgamesh', 404],
    ['history/Aether/5057', 404], ['aggregated/Aether/../../worlds', 400 /* the address resolves the dots; the rule's parameter no longer matches */], ['aggregated/Aether/2%2C5057', 404], ['marketable', 404], ['', 404],
    [`aggregated/Aether/${'1'.repeat(1300)}`, 404],
  ];
  for (const [path, status] of cases) {
    const r = await ask(h, path);
    assert.equal(r.status, status, path);
    assert.equal(r.headers.get('cache-control'), 'no-store', path);
    assert.equal(r.headers.get('vercel-cdn-cache-control'), 'no-store', path);
  }
  // Queries: Vercel adds path=<the path> (and p= when a rule names it); anything else is the visitor's.
  const raw = async (url, init) => (await h.fetch(new Request(url, init))).status;
  const page = 'https://radmagelabs.com/ffxiv/prices/tax/63';
  assert.equal(await raw(`${page}?path=tax%2F63&x=1`), 400, 'a visitor parameter beside the rule\'s');
  assert.equal(await raw(`${page}?x=1`), 400, 'a visitor parameter');
  assert.equal(await raw(`${page}?fields=retainerName`), 400, 'an attempt to widen the fields');
  assert.equal(await raw(`${page}?path=tax%2F64`), 400, 'a path parameter naming another path');
  assert.equal(await raw(`${page}?path=tax%2F63&path=tax%2F63`), 400, 'the parameter twice');
  assert.equal(await raw('https://radmagelabs.com/api/ffxiv-prices?p=tax%2F63'), 404, 'the function\'s own address: one address per answer');
  assert.equal(await raw('https://radmagelabs.com/api/ffxiv-prices?path=tax%2F63'), 404);
  const post = await h.fetch(new Request(`${page}?path=tax%2F63`, { method: 'POST', body: 'x' }));
  assert.deepEqual([post.status, post.headers.get('allow'), post.headers.get('cache-control')], [405, 'GET', 'no-store']);
  const head = await h.fetch(new Request(`${page}?path=tax%2F63`, { method: 'HEAD' }));
  assert.deepEqual([head.status, head.headers.get('vercel-cdn-cache-control')], [405, 'no-store'], 'HEAD too: on the prototype a HEAD missed the CDN and reached Universalis');
  assert.equal(up.calls.length, 0, 'none of these reached Universalis');
  // The accepted forms: as Vercel delivers them, with the rule's parameter, and with none (a plain server).
  for (const path of ['aggregated/Aether/2', 'aggregated/North-America/2,5057', 'aggregated/Gilgamesh/5057', `item/Aether/${ALLOW.ITEM_ID_MAX + 1}`, 'item/Gilgamesh/5057', 'tax/63']) {
    assert.equal(routeOf(`https://radmagelabs.com/ffxiv/prices/${path}?path=${encodeURIComponent(path)}`, allowFrom()).key, path);
    assert.equal(routeOf(`https://radmagelabs.com/ffxiv/prices/${path}?p=${encodeURIComponent(path)}&path=${encodeURIComponent(path)}`, allowFrom()).key, path);
    assert.equal(routeOf(`https://radmagelabs.com/ffxiv/prices/${path}`, allowFrom()).key, path);
  }
  assert.equal(routeOf('https://x.test/lab/prices/tax/63?path=tax%2F63', allowFrom(), undefined, '/lab/prices/').key, 'tax/63', 'another prefix when configured');
});

// ---- what the CDN may keep ----
test('cache: a good answer tells the CDN the planned lifetime and stale period, and the browser to ask every time', async () => {
  let t = 1_800_000_000_000;
  const h = handler(fakeUpstream().fetch, { now: () => t });
  for (const [path, kind] of [[AGG, 'aggregated'], ['item/Aether/5057', 'item'], ['tax/63', 'tax']]) {
    const r = await ask(h, path);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('vercel-cdn-cache-control'), `max-age=${TTL[kind]}, stale-while-revalidate=${STALE[kind]}, stale-if-error=${STALE_IF_ERROR[kind]}`);
    assert.equal(r.headers.get('cache-control'), 'no-cache');
    assert.equal(r.headers.get('x-prices-source'), 'live');
    assert.equal(r.headers.get('x-prices-fetched'), String(t));
    assert.equal(r.headers.get('content-type'), 'application/json; charset=utf-8');
  }
  assert.deepEqual([TTL.aggregated, TTL.item, TTL.tax], [300, 120, 3600], 'the TTLs in the plan');
});

test('cache: equal paths reaching one instance at once are one upstream request', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const up = fakeUpstream(async (url) => { await gate; return defaultAnswer(url); });
  const h = handler(up.fetch);
  const many = Promise.all(Array.from({ length: 8 }, () => ask(h, AGG)));
  await sleep(10);
  release();
  const answers = await many;
  assert.equal(up.calls.length, 1);
  const bodies = await Promise.all(answers.map((r) => r.text()));
  assert.ok(answers.every((r) => r.status === 200) && bodies.every((b) => b === bodies[0]));
  assert.equal(h.state.counters.coalesced, 7);
});

test('over real HTTP: a chunked gzip answer; corrupt gzip, a decompression bomb, an unknown encoding, not HTTP, a body cut short, a hang and a dropped connection', async () => {
  let mode = 'ok';
  const upstream = createServer((req, res) => {
    const body = JSON.stringify(fx('tax-gilgamesh'));
    if (mode === 'corrupt') { res.writeHead(200, { ...JSON_TYPE, 'content-encoding': 'gzip' }); res.end(Buffer.from('not gzip at all')); return; }
    if (mode === 'bomb') { res.writeHead(200, { ...JSON_TYPE, 'content-encoding': 'gzip' }); res.end(gzipSync(Buffer.alloc(20_000_000, 32))); return; }
    if (mode === 'encoding') { res.writeHead(200, { ...JSON_TYPE, 'content-encoding': 'compress' }); res.end(body); return; }
    if (mode === 'hang') return; // never answers
    if (mode === 'chunked') { res.writeHead(200, { ...JSON_TYPE, 'content-encoding': 'gzip' }); const z = gzipSync(body); res.write(z.subarray(0, 10)); setTimeout(() => res.end(z.subarray(10)), 20); return; }
    if (mode === 'garbage') { req.socket.end(Buffer.from('this is not http\r\n\r\n')); return; }
    if (mode === 'short') { res.writeHead(200, { ...JSON_TYPE, 'content-length': '500' }); res.write(body.slice(0, 50)); setTimeout(() => req.socket.destroy(), 20); return; }
    if (mode === 'drop') { req.socket.destroy(); return; }
    res.writeHead(200, JSON_TYPE);
    res.end(body);
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  try {
    const h = createPricesHandler({ upstream: `http://127.0.0.1:${upstream.address().port}/api/v2`, timeoutMs: 300, ...OPEN, backoff: { baseMs: 0, maxMs: 0 }, lastGood: { maxEntries: 0 } });
    const want = { ok: 200, chunked: 200, corrupt: 502, bomb: 502, encoding: 502, garbage: 502, short: 503, hang: 504, drop: 503 };
    for (const [m, status] of Object.entries(want)) {
      mode = m;
      const r = await ask(h, 'tax/63');
      assert.equal(r.status, status, m);
      if (status !== 200) assert.equal(r.headers.get('vercel-cdn-cache-control'), 'no-store', m);
    }
    assert.equal(h.state.inflight.size, 0);
  } finally {
    upstream.closeAllConnections();
    await new Promise((r) => upstream.close(r));
  }
});

// ---- failures ----
const ERROR_CASES = [
  ['503', () => ({ status: 503, body: { title: 'Service Unavailable' } }), 503],
  ['500', () => ({ status: 500, body: 'oops' }), 503],
  ['429', () => ({ status: 429, body: '', headers: { 'retry-after': '7' } }), 429],
  ['404', () => ({ status: 404, body: fx('error-unknown-scope') }), 404],
  ['redirect', () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/' } }), 502],
  ['HTML instead of JSON', () => new Response('<html>busy</html>', { status: 200, headers: { 'content-type': 'text/html' } }), 502],
  ['JSON cut short', () => ({ body: '{"results":[{"itemId":2' }), 502],
  ['not UTF-8', () => new Response(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]), { status: 200, headers: JSON_TYPE }), 502],
  ['an empty 200', () => new Response(null, { status: 200, headers: JSON_TYPE }), 502],
  ['results for other ids', () => ({ body: { results: [{ itemId: 99 }], failedItems: [] } }), 502],
  ['too many results', () => ({ body: { results: DC_IDS.concat(DC_IDS).map((itemId) => ({ itemId })), failedItems: [] } }), 502],
  ['results not a list', () => ({ body: { results: {}, failedItems: [] } }), 502],
  ['failedItems naming other ids', () => ({ body: { results: [], failedItems: [1] } }), 502],
  ['a body over the limit', () => ({ body: { results: [], failedItems: [], pad: 'x'.repeat(2_000_000) } }), 502],
  ['a declared length over the limit', () => new Response('{}', { status: 200, headers: { ...JSON_TYPE, 'content-length': '5000000' } }), 502],
  ['a dropped connection', () => { throw new TypeError('fetch failed'); }, 503],
];
test('failures: every kind of bad upstream answer becomes the planned status, uncached, with Retry-After where it helps', async () => {
  for (const [name, answer, status] of ERROR_CASES) {
    const h = handler(fakeUpstream(answer).fetch);
    const r = await ask(h, AGG);
    assert.equal(r.status, status, name);
    assert.equal(r.headers.get('cache-control'), 'no-store', name);
    assert.equal(r.headers.get('vercel-cdn-cache-control'), 'no-store', name);
    assert.equal(r.headers.get('set-cookie'), null, name);
    assert.ok(typeof (await r.json()).error === 'string', name);
    if (status === 429 || status === 503) assert.ok(Number(r.headers.get('retry-after')) >= 1, `${name}: Retry-After`);
  }
  const h = handler(fakeUpstream(answerFor({ status: 429, headers: { 'retry-after': '7' } })).fetch);
  assert.ok(Number((await ask(h, AGG)).headers.get('retry-after')) >= 7, '429 passes on the upstream Retry-After');
});
function answerFor(a) { return () => ({ body: '', ...a }); }

test('failures: an upstream that takes longer than the timeout is cut off with 504', async () => {
  const hang = (url, init) => new Promise((_, no) => init.signal.addEventListener('abort', () => no(init.signal.reason)));
  const h = createPricesHandler({ fetch: hang, timeoutMs: 60, ...OPEN });
  const started = Date.now();
  const r = await ask(h, AGG);
  assert.equal(r.status, 504);
  assert.ok(Date.now() - started < 1000);
  assert.equal(r.headers.get('vercel-cdn-cache-control'), 'no-store');
  // A body that stalls halfway is cut off the same way.
  const stall = (url, init) => Promise.resolve(new Response(new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode('{"results":')); init.signal.addEventListener('abort', () => c.error(init.signal.reason)); },
  }), { status: 200, headers: JSON_TYPE }));
  assert.equal((await ask(createPricesHandler({ fetch: stall, timeoutMs: 60, ...OPEN }), AGG)).status, 504);
});

test('last good: when Universalis fails, the last good answer is served, labeled, briefly cached; too old, the failure shows', async () => {
  let t = 1_800_000_000_000;
  let broken = false;
  const up = fakeUpstream((url) => (broken ? { status: 503, body: '' } : defaultAnswer(url)));
  const h = handler(up.fetch, { now: () => t });
  const good = await ask(h, AGG);
  const goodBody = await good.text();
  broken = true;
  t += 60_000;
  const lg = await ask(h, AGG);
  assert.equal(lg.status, 200);
  assert.equal(await lg.text(), goodBody);
  assert.equal(lg.headers.get('x-prices-source'), 'last-good');
  assert.equal(lg.headers.get('x-prices-fetched'), String(t - 60_000), 'labeled with when it was fetched');
  assert.equal(lg.headers.get('vercel-cdn-cache-control'), `max-age=${DEFAULTS.lastGood.cdnSeconds}, stale-if-error=${STALE_IF_ERROR.aggregated}`, 'cached briefly, and kept as the CDN\'s fallback');
  // During the backoff the last good answer is served without asking Universalis.
  const calls = up.calls.length;
  assert.equal((await ask(h, AGG)).headers.get('x-prices-source'), 'last-good');
  assert.equal(up.calls.length, calls);
  // Older than its limit, the failure shows instead.
  t += DEFAULTS.lastGood.maxAgeMs.aggregated;
  const old = await ask(h, AGG);
  assert.equal(old.status, 503);
  // A path never fetched has nothing to fall back on.
  assert.equal((await ask(h, 'tax/63')).status, 503);
  // Tax answers keep longer, and an item's lifetime caps the brief cache.
  assert.equal(DEFAULTS.lastGood.maxAgeMs.tax, 7 * 24 * 3600_000);
});

test('last good: the memory is bounded by entries and bytes, dropping the least recently used', async () => {
  const h = handler(fakeUpstream().fetch, { lastGood: { maxEntries: 3, maxBytes: 10_000_000 } });
  for (const id of [2, 14, 5057, 5121]) await ask(h, `item/Aether/${id}`);
  assert.deepEqual([...h.state.lastGood.keys()], ['item/Aether/14', 'item/Aether/5057', 'item/Aether/5121']);
  // A tax answer is 114 bytes, so 300 bytes hold the two most recent.
  const small = handler(fakeUpstream().fetch, { lastGood: { maxEntries: 100, maxBytes: 300 } });
  for (const world of [63, 73, 79]) await ask(small, `tax/${world}`);
  assert.deepEqual([...small.state.lastGood.keys()], ['tax/73', 'tax/79']);
  // Using an entry makes it the most recent: a failure serves tax/73, then a new answer drops tax/79.
  const flaky = fakeUpstream((url, init, n) => (n === 3 ? { status: 500, body: '' } : defaultAnswer(url)));
  const lru = handler(flaky.fetch, { lastGood: { maxEntries: 2, maxBytes: 10_000 }, backoff: { baseMs: 0, maxMs: 0 } });
  await ask(lru, 'tax/73'); await ask(lru, 'tax/79');
  assert.equal((await ask(lru, 'tax/73')).headers.get('x-prices-source'), 'last-good');
  await ask(lru, 'tax/63');
  assert.deepEqual([...lru.state.lastGood.keys()], ['tax/73', 'tax/63']);
});

// ---- the upstream rate limit and backoff ----
test('backoff: after a failure nothing goes upstream until the hold ends; holds double, a 429 Retry-After wins, success resets', async () => {
  let t = 1_800_000_000_000;
  let status = 503;
  const up = fakeUpstream(() => (status === 200 ? defaultAnswer(`https://u/aggregated/Aether/${DC_IDS.join(',')}`) : { status, body: '', headers: status === 429 ? { 'retry-after': '30' } : {} }));
  const h = handler(up.fetch, { now: () => t });
  assert.equal((await ask(h, AGG)).status, 503);
  assert.equal(up.calls.length, 1);
  assert.equal(h.state.circuit.until - t, DEFAULTS.backoff.baseMs);
  t += 1000;
  const held = await ask(h, 'tax/63');
  assert.deepEqual([held.status, held.headers.get('retry-after')], [503, '1'], 'every path waits, not just the failed one');
  assert.equal(up.calls.length, 1);
  t += 1001;
  assert.equal((await ask(h, AGG)).status, 503, 'the try after the hold fails again');
  assert.equal(h.state.circuit.until - t, DEFAULTS.backoff.baseMs * 2, 'doubled');
  t += 4001;
  status = 429;
  const limited = await ask(h, AGG);
  assert.equal(limited.status, 429);
  assert.equal(h.state.circuit.until - t, 30_000, 'Retry-After 30 s is longer than the 8 s doubling');
  t += 30_001;
  status = 200;
  assert.equal((await ask(h, AGG)).status, 200);
  assert.deepEqual([h.state.circuit.failures, h.state.circuit.until], [0, 0]);
  // Holds stop growing at the maximum, and a huge Retry-After is capped.
  status = 503;
  let hold = 0;
  for (let i = 0; i < 10; i++) { await ask(h, AGG); hold = h.state.circuit.until - t; t = h.state.circuit.until + 1; }
  assert.equal(hold, DEFAULTS.backoff.maxMs);
  status = 429;
  up.calls.length = 0;
  const huge = createPricesHandler({ fetch: fakeUpstream(answerFor({ status: 429, headers: { 'retry-after': '86400' } })).fetch, now: () => t, ...OPEN });
  await ask(huge, AGG);
  assert.equal(huge.state.circuit.until - t, DEFAULTS.backoff.maxRetryAfterMs);
});

test('backoff: after the hold, one request at a time tries Universalis; the others get the last good answer or wait', async () => {
  let t = 1_800_000_000_000;
  let release;
  let mode = 'fail';
  const up = fakeUpstream(async (url) => {
    if (mode === 'fail') return { status: 503, body: '' };
    if (mode === 'slow') { mode = 'ok'; await new Promise((r) => { release = r; }); }
    return defaultAnswer(url);
  });
  const h = handler(up.fetch, { now: () => t });
  await ask(h, 'tax/63');
  t += DEFAULTS.backoff.baseMs + 1;
  mode = 'slow';
  const probe = ask(h, 'tax/63');
  await sleep(10);
  const others = await Promise.all(['item/Aether/5057', 'tax/64'].map((p) => ask(h, p)));
  assert.deepEqual(others.map((r) => r.status), [503, 503]);
  assert.equal(up.calls.length, 2, 'only the probe went upstream');
  release();
  assert.equal((await probe).status, 200);
  assert.equal((await ask(h, 'tax/64')).status, 200, 'open again');
});

test('backoff: a malformed answer or an upstream 404 does not hold back other requests', async () => {
  const up = fakeUpstream((url) => (url.includes('tax-rates') ? defaultAnswer(url) : url.includes('Gilgamesh') ? { status: 404, body: '' } : { body: '{"cut' }));
  const h = handler(up.fetch);
  assert.equal((await ask(h, AGG)).status, 502);
  assert.equal((await ask(h, 'item/Gilgamesh/5057')).status, 404);
  assert.equal(h.state.circuit.failures, 0);
  assert.equal((await ask(h, 'tax/63')).status, 200);
});

test('rate limit: a burst goes at once, then requests are spaced at the set rate; all succeed', async () => {
  const starts = [];
  const up = fakeUpstream((url) => { starts.push(Date.now()); return defaultAnswer(url); });
  const h = createPricesHandler({ fetch: up.fetch, rate: { perSecond: 20, burst: 2, concurrency: 10, maxQueue: 50, maxWaitMs: 2000 } });
  const t0 = Date.now();
  const answers = await Promise.all([2, 14, 5057, 5121, 13115, 24511].map((id) => ask(h, `item/Aether/${id}`)));
  assert.ok(answers.every((r) => r.status === 200));
  const at = starts.map((s) => s - t0);
  assert.ok(at[0] < 30 && at[1] < 30, `burst: ${at}`);
  for (let i = 2; i < at.length; i++) assert.ok(at[i] - at[i - 1] >= 40, `spaced at about 50 ms: ${at}`);
  assert.ok(at[5] >= 180, `six requests at 20 a second with a burst of 2 take at least 200 ms: ${at}`);
});

test('rate limit: never more than the set number of upstream requests at once', async () => {
  let open = 0, most = 0;
  const up = fakeUpstream(async (url) => { open++; most = Math.max(most, open); await sleep(30); open--; return defaultAnswer(url); });
  const h = createPricesHandler({ fetch: up.fetch, rate: { perSecond: 1000, burst: 1000, concurrency: 2, maxQueue: 50, maxWaitMs: 2000 } });
  const answers = await Promise.all(ITEMS.slice(0, 9).map((i) => ask(h, `item/Aether/${i.id}`)));
  assert.ok(answers.every((r) => r.status === 200));
  assert.equal(most, 2);
});

test('rate limit: past the longest wait or a full queue, the visitor gets 429 at once and Universalis is not asked', async () => {
  const up = fakeUpstream(async (url) => { await sleep(200); return defaultAnswer(url); });
  const h = createPricesHandler({ fetch: up.fetch, rate: { perSecond: 1000, burst: 1000, concurrency: 1, maxQueue: 2, maxWaitMs: 50 } });
  const answers = await Promise.all(ITEMS.slice(0, 5).map((i) => ask(h, `item/Aether/${i.id}`)));
  const statuses = answers.map((r) => r.status);
  assert.equal(statuses[0], 200);
  assert.ok(statuses.slice(1).every((s) => s === 429), statuses.join());
  assert.ok(answers.slice(1).every((r) => r.headers.get('retry-after') === '1' && r.headers.get('vercel-cdn-cache-control') === 'no-store'));
  assert.equal(up.calls.length, 1);
  const lim = createLimiter({ perSecond: 1, burst: 1, concurrency: 1, maxQueue: 1, maxWaitMs: 20 });
  const first = await lim.acquire();
  assert.equal(typeof first, 'function');
  assert.equal(await lim.acquire(), null, 'no token within the wait');
  first();
});

// ---- the vercel.json merge ----
test('vercel.json merge: the price rewrite goes just before the /ffxiv/ catch-all; every other rule stays, in order', () => {
  const labs = {
    $schema: 'https://openapi.vercel.sh/vercel.json',
    redirects: [{ source: '/ffxiv', destination: '/ffxiv/', permanent: true }],
    rewrites: [
      { source: '/ffxi/:path*', destination: 'https://radmageirl.github.io/ffxi-timer/:path*' },
      { source: '/ffxiv/news/topics.xml', destination: 'https://na.finalfantasyxiv.com/lodestone/news/topics.xml' },
      { source: '/ffxiv/', destination: 'https://radmageirl.github.io/ffxiv-timer/' },
      { source: '/ffxiv/:path*', destination: 'https://radmageirl.github.io/ffxiv-timer/:path*' },
      { source: '/d4/news.json', destination: 'https://news.blizzard.com/en-us/api/feed/diablo-4' },
    ],
    headers: [{ source: '/ffxiv/news/:feed', headers: [{ key: 'CDN-Cache-Control', value: 'max-age=600' }] }],
  };
  const merged = mergeLabsConfig(labs);
  assert.deepEqual(merged.rewrites.map((r) => r.source), ['/ffxi/:path*', '/ffxiv/news/topics.xml', '/ffxiv/prices/:path*', '/ffxiv/', '/ffxiv/:path*', '/d4/news.json']);
  assert.deepEqual(merged.redirects, labs.redirects);
  assert.deepEqual(merged.headers, labs.headers);
  assert.deepEqual(merged.functions, FRAGMENT.functions);
  assert.deepEqual(Object.keys(merged), ['$schema', 'functions', 'redirects', 'rewrites', 'headers']);
  assert.throws(() => mergeLabsConfig(merged), /already/);
  assert.deepEqual(FRAGMENT.rewrites, [{ source: '/ffxiv/prices/:path*', destination: '/api/ffxiv-prices' }]);
  assert.ok(FRAGMENT.functions['api/ffxiv-prices.mjs'].maxDuration >= Math.ceil((DEFAULTS.rate.maxWaitMs + DEFAULTS.timeoutMs) / 1000), 'the function may run as long as a wait plus a timeout');
});

test('vercel.json merge on the text: only the added lines change, in the file\'s own layout', () => {
  const text = [
    '{',
    '  "$schema": "https://openapi.vercel.sh/vercel.json",',
    '  "redirects": [',
    '    { "source": "/ffxiv", "destination": "/ffxiv/", "permanent": true }',
    '  ],',
    '  "rewrites": [',
    '    { "source": "/ffxiv/news/news.xml", "destination": "https://na.finalfantasyxiv.com/lodestone/news/news.xml" },',
    '    { "source": "/ffxiv/", "destination": "https://radmageirl.github.io/ffxiv-timer/" },',
    '    { "source": "/ffxiv/:path*", "destination": "https://radmageirl.github.io/ffxiv-timer/:path*" }',
    '  ]',
    '}',
    '',
  ].join('\n');
  const merged = mergeLabsText(text);
  const added = merged.split('\n').filter((l) => !text.split('\n').includes(l));
  assert.deepEqual(added, [
    '  "functions": {',
    '    "api/ffxiv-prices.mjs": { "maxDuration": 20 }',
    '  },',
    '    { "source": "/ffxiv/prices/:path*", "destination": "/api/ffxiv-prices" },',
  ]);
  assert.equal(merged.split('\n').length, text.split('\n').length + 4);
  assert.deepEqual(JSON.parse(merged), mergeLabsConfig(JSON.parse(text)));
});

test('allow list: a damaged list stops the function from starting; an unexpected error is a plain 500, uncached', async () => {
  const runs = ALLOW.MARKETABLE.split(',');
  assert.throws(() => allowFrom({ ...ALLOW, MARKETABLE: runs.slice(0, -1).join(',') }), /expected 16845/, 'cut short');
  // One gap one too wide shifts every later id but keeps the count: the sum catches it.
  const wide = [...runs];
  const at = wide.findIndex((r, i) => i > 100 && !r.includes('.'));
  wide[at] = (parseInt(wide[at], 36) + 1).toString(36);
  assert.throws(() => allowFrom({ ...ALLOW, MARKETABLE: wide.join(',') }), /adding up to/, 'one gap off by one');
  assert.throws(() => allowFrom({ ...ALLOW, MARKETABLE: `${ALLOW.MARKETABLE},zz` }), /bad run|expected/, 'past the table');
  // A broken setting makes building the answer throw; every caller waiting on it gets the 500.
  const broken = handler(fakeUpstream().fetch, { ttl: null });
  const err = console.error;
  console.error = () => {};
  try {
    const answers = await Promise.all([ask(broken, 'tax/63'), ask(broken, 'tax/63')]);
    for (const r of answers) {
      assert.equal(r.status, 500);
      assert.equal(r.headers.get('vercel-cdn-cache-control'), 'no-store');
      assert.deepEqual(await r.json(), { error: 'internal error' });
    }
  } finally { console.error = err; }
});

test('contract: the item field types name exactly the pinned fields', () => {
  const flat = Object.entries(ITEM_TYPES).flatMap(([k, t]) => (typeof t === 'object' ? Object.keys(t).map((f) => `${k}.${f}`) : [k]));
  assert.deepEqual(flat, ITEM_FIELDS);
  for (const k of FORBIDDEN_KEYS) assert.ok(!flat.some((f) => f.split('.').pop() === k), k);
});

for (const [name, fn] of queue) {
  if (process.env.VERBOSE) console.log('...', name);
  try { await fn(); passed++; } catch (e) { failed++; console.error(`FAIL ${name}\n  ${String(e.stack || e.message).split('\n').slice(0, 6).join('\n  ')}`); }
}
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
