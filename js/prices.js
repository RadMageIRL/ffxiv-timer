// Market prices for Market & Crafting, asked of this site's own prices/ paths. radmagelabs.com answers
// them with its price function (radmagelabs/api/ffxiv-prices.mjs), which asks Universalis itself, so
// the browser never contacts Universalis and nothing of the visitor's goes there. Loaded only when
// Market & Crafting is opened. Plain GETs with no cookies and no referrer.
//
// Every request goes through one queue: at most `concurrency` at a time and a token bucket of `perSec`
// a second (burst `burst`), well under what the function and its firewall rule allow. Ids go 100 to a
// request, sorted (contract.mjs: Universalis drops a 101st id silently, and the same set of ids is the
// same address, one cache entry). A request that times out, fails on the network, or is answered 502,
// 503 or 504 is tried again after `backoff` (5 then 15 seconds); a 429 or 503 holds the whole queue for
// its Retry-After (at most 60 s) before that. At most two tries more, never a loop: retries count
// against the limit too. Nothing here throws into the page: every answer is { ok: true, ... } or
// { ok: false, error }, and nothing is ever made up when no price comes back.
//
// Times: Universalis gives upload and purchase times in milliseconds and listing review and sale times
// in seconds; the parsers turn every time into milliseconds. A price's age is always one of these
// times, never when it was fetched.
//
// createClient() takes its fetch, clock and timers, so the Node tests drive it on a fake clock.
(function (root) {
  'use strict';

  const MAX_IDS = 100;
  const DEFAULTS = { base: 'prices/', perSec: 4, burst: 8, concurrency: 4, timeoutMs: 10000, backoff: [5000, 15000], holdDefaultMs: 30000, holdMaxMs: 60000 };
  /** The errors, worst first: a batch of requests reports the worst of its parts. */
  const ERRORS = ['rate-limited', 'unavailable', 'network', 'timeout', 'bad-data', 'http', 'aborted'];
  const LEVELS = ['world', 'dc', 'region'];

  const chunks = (ids) => {
    const s = [...new Set(ids)].filter((x) => Number.isSafeInteger(x) && x > 0).sort((a, b) => a - b);
    const out = [];
    for (let i = 0; i < s.length; i += MAX_IDS) out.push(s.slice(i, i + MAX_IDS));
    return out;
  };
  const worst = (a, b) => (!a ? b : !b ? a : ERRORS.indexOf(a) <= ERRORS.indexOf(b) ? a : b);
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const int = (v) => (Number.isSafeInteger(v) ? v : null);
  const price = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
  // A time in milliseconds after 2013 (A Realm Reborn) and not more than a day ahead of now.
  const when = (ms, now) => (typeof ms === 'number' && Number.isFinite(ms) && ms > 1356998400000 && ms < now + 86400000 ? ms : null);

  /** Seconds to wait from a Retry-After header (seconds, or an HTTP date), or null. */
  function retryAfterMs(value, now) {
    if (value == null || value === '') return null;
    const s = String(value).trim();
    if (/^\d{1,6}$/.test(s)) return Number(s) * 1000;
    const t = Date.parse(s);
    return Number.isFinite(t) ? Math.max(0, t - now) : null;
  }

  // ---- Parsers: Universalis shapes (as the function passes them on) into the page's ----

  /**
   * One side (nq or hq) of an aggregated entry: for each place (world, dc, region) the lowest listing,
   * the most recent purchase, the average sale price and the daily sale velocity, each only when it is
   * well formed. A world-level place names no world: it is the scope's own world.
   */
  function side(s, now) {
    const out = { min: {}, recent: {}, avg: {}, velocity: {} };
    if (!isObj(s)) return out;
    for (const lv of LEVELS) {
      const m = isObj(s.minListing) && s.minListing[lv];
      if (isObj(m) && price(m.price) !== null) out.min[lv] = { price: m.price, worldId: int(m.worldId) };
      const r = isObj(s.recentPurchase) && s.recentPurchase[lv];
      if (isObj(r) && price(r.price) !== null) out.recent[lv] = { price: r.price, at: when(r.timestamp, now), worldId: int(r.worldId) };
      const a = isObj(s.averageSalePrice) && s.averageSalePrice[lv];
      if (isObj(a) && price(a.price) !== null) out.avg[lv] = a.price;
      const v = isObj(s.dailySaleVelocity) && s.dailySaleVelocity[lv];
      if (isObj(v) && num(v.quantity) !== null && v.quantity >= 0) out.velocity[lv] = v.quantity;
    }
    return out;
  }
  const emptySide = (s) => !Object.keys(s.min).length && !Object.keys(s.recent).length && !Object.keys(s.avg).length && !Object.keys(s.velocity).length;

  /**
   * An aggregated answer for the ids asked: { ok: true, rows: Map(id -> { nq, hq, uploads: Map(worldId -> ms),
   * empty }), missing: Set } where missing holds the ids Universalis lists in failedItems (not on the board
   * there), or { ok: false, error: 'bad-data' } when the body is not such an answer. An entry with nothing in
   * it is a row marked empty: Universalis has no data for that item in that scope. An id asked for that comes
   * back in neither list is left out of both (its request is then a failure for it, never "no data").
   */
  function parseAggregated(body, asked, now) {
    if (!isObj(body) || !Array.isArray(body.results)) return { ok: false, error: 'bad-data' };
    const want = new Set(asked), rows = new Map(), missing = new Set();
    for (const r of body.results) {
      if (!isObj(r) || !want.has(r.itemId) || rows.has(r.itemId)) continue;
      const nq = side(r.nq, now), hq = side(r.hq, now), uploads = new Map();
      if (Array.isArray(r.worldUploadTimes)) {
        for (const u of r.worldUploadTimes) {
          const t = isObj(u) ? when(u.timestamp, now) : null;
          if (t !== null && int(u.worldId) !== null) uploads.set(u.worldId, Math.max(t, uploads.get(u.worldId) || 0));
        }
      }
      rows.set(r.itemId, { nq, hq, uploads, empty: emptySide(nq) && emptySide(hq) && !uploads.size });
    }
    if (Array.isArray(body.failedItems)) for (const id of body.failedItems) if (want.has(id) && !rows.has(id)) missing.add(id);
    return { ok: true, rows, missing };
  }

  /**
   * One item's details in one scope: the newest upload time, every world's upload time, the cheapest
   * current listings (offers to sell) and the most recent completed sales, each with its world and time,
   * plus Universalis's own figures. Rows that are not well formed are dropped. No names: the function
   * passes none, and nothing here would show one.
   */
  function parseItem(body, now) {
    if (!isObj(body) || !Number.isSafeInteger(body.itemID)) return { ok: false, error: 'bad-data' };
    const uploads = new Map();
    if (isObj(body.worldUploadTimes)) for (const [k, v] of Object.entries(body.worldUploadTimes)) { const t = when(v, now); if (t !== null && /^\d{1,5}$/.test(k)) uploads.set(Number(k), t); }
    const listings = (Array.isArray(body.listings) ? body.listings : []).filter((l) => isObj(l) && price(l.pricePerUnit) !== null && int(l.quantity) > 0)
      .map((l) => ({ price: l.pricePerUnit, qty: l.quantity, total: num(l.total), tax: num(l.tax), hq: l.hq === true, worldId: int(l.worldID), worldName: typeof l.worldName === 'string' ? l.worldName : null, reviewed: when(num(l.lastReviewTime) === null ? null : l.lastReviewTime * 1000, now) }))
      .sort((a, b) => a.price - b.price);
    const sales = (Array.isArray(body.recentHistory) ? body.recentHistory : []).filter((s) => isObj(s) && price(s.pricePerUnit) !== null && int(s.quantity) > 0)
      .map((s) => ({ price: s.pricePerUnit, qty: s.quantity, hq: s.hq === true, worldId: int(s.worldID), worldName: typeof s.worldName === 'string' ? s.worldName : null, at: when(num(s.timestamp) === null ? null : s.timestamp * 1000, now) }))
      .sort((a, b) => (b.at || 0) - (a.at || 0));
    return {
      ok: true,
      item: {
        id: body.itemID, worldId: int(body.worldID), lastUpload: when(body.lastUploadTime, now), uploads, listings, sales,
        hasData: body.hasData !== false, listingsCount: int(body.listingsCount), unitsForSale: int(body.unitsForSale), unitsSold: int(body.unitsSold),
        velocity: { nq: num(body.nqSaleVelocity), hq: num(body.hqSaleVelocity), all: num(body.regularSaleVelocity) },
      },
    };
  }

  /** The market tax rates for one world: [{ city, pct }] in the order Universalis lists them. */
  function parseTax(body) {
    if (!isObj(body)) return { ok: false, error: 'bad-data' };
    const rates = Object.entries(body).filter(([city, pct]) => /^[A-Za-z' ]{1,24}$/.test(city) && Number.isFinite(pct) && pct >= 0 && pct <= 100).map(([city, pct]) => ({ city, pct }));
    return rates.length ? { ok: true, rates } : { ok: false, error: 'bad-data' };
  }

  function createClient(options) {
    const o = Object.assign({}, DEFAULTS, options || {});
    if (typeof o.fetch !== 'function') throw new Error('createClient needs fetch');
    const now = o.now || (() => Date.now());
    const later = o.setTimeout || ((fn, ms) => setTimeout(fn, ms));
    const cancel = o.clearTimeout || ((t) => clearTimeout(t));
    const queue = [];
    let inFlight = 0, tokens = o.burst, filled = now(), pausedUntil = 0, wake = null, wakeAt = 0;
    const stats = { started: 0, maxInFlight: 0, retries: 0, rateLimited: 0, paths: [] };

    function refill() {
      const t = now();
      tokens = Math.min(o.burst, tokens + ((t - filled) * o.perSec) / 1000);
      filled = t;
    }
    function schedule(at) {
      if (wake && wakeAt <= at) return;
      if (wake) cancel(wake);
      wakeAt = at;
      wake = later(() => { wake = null; pump(); }, Math.max(0, at - now()));
    }
    function pump() {
      while (queue.length && inFlight < o.concurrency) {
        const t = now();
        if (t < pausedUntil) { schedule(pausedUntil); return; }
        refill();
        if (tokens < 1) { schedule(t + Math.ceil(((1 - tokens) * 1000) / o.perSec)); return; }
        const job = queue.shift();
        if (job.signal && job.signal.aborted) { job.done({ ok: false, error: 'aborted' }); continue; }
        tokens -= 1;
        inFlight++;
        stats.started++;
        stats.maxInFlight = Math.max(stats.maxInFlight, inFlight);
        attempt(job).then((r) => { inFlight--; job.settle(r); pump(); });
      }
    }

    /** One try: { ok, status, data, notFound } or { ok: false, error, status, retry, holdMs }. */
    function attempt(job) {
      return new Promise((resolve) => {
        const ctl = typeof AbortController === 'function' ? new AbortController() : null;
        let finished = false, timedOut = false;
        const end = (r) => { if (finished) return; finished = true; cancel(timer); if (job.signal) job.signal.removeEventListener('abort', onAbort); resolve(r); };
        const timer = later(() => { timedOut = true; if (ctl) ctl.abort(); end({ ok: false, error: 'timeout', retry: true }); }, o.timeoutMs);
        const onAbort = () => { if (ctl) ctl.abort(); end({ ok: false, error: 'aborted' }); };
        if (job.signal) job.signal.addEventListener('abort', onAbort);
        stats.paths.push(job.path);
        let req;
        try { req = o.fetch(o.base + job.path, { method: 'GET', credentials: 'omit', referrerPolicy: 'no-referrer', signal: ctl ? ctl.signal : undefined }); } catch (e) { end({ ok: false, error: 'network', retry: true }); return; }
        Promise.resolve(req).then(async (res) => {
          const status = res.status;
          const hold = () => { const ms = retryAfterMs(res.headers && res.headers.get ? res.headers.get('retry-after') : null, now()); return Math.min(o.holdMaxMs, ms === null ? o.holdDefaultMs : ms); };
          if (status === 429) { stats.rateLimited++; end({ ok: false, error: 'rate-limited', status, retry: true, holdMs: hold() }); return; }
          if (status === 503) { end({ ok: false, error: 'unavailable', status, retry: true, holdMs: hold() }); return; }
          if (status === 502 || status === 504 || status === 500) { end({ ok: false, error: 'unavailable', status, retry: true }); return; }
          if (status === 404) { end({ ok: true, status, data: null, notFound: true }); return; }
          if (status !== 200) { end({ ok: false, error: 'http', status }); return; }
          let body;
          try { body = await res.json(); } catch (e) { end(timedOut || (job.signal && job.signal.aborted) ? { ok: false, error: timedOut ? 'timeout' : 'aborted' } : { ok: false, error: 'bad-data', status }); return; }
          end({ ok: true, status, data: body });
        }, () => { end(job.signal && job.signal.aborted ? { ok: false, error: 'aborted' } : { ok: false, error: 'network', retry: true }); });
      });
    }

    /** A GET of prices/<path>, through the queue, tried again as described at the top. */
    function get(path, opts) {
      const signal = opts && opts.signal;
      return new Promise((resolve) => {
        let tries = 0;
        const job = { path, signal, done: resolve };
        job.settle = (r) => {
          if (r.ok || !r.retry || tries >= o.backoff.length || (signal && signal.aborted)) { const { retry, holdMs, ...out } = r; resolve(out); return; }
          const wait = Math.max(o.backoff[tries++], r.holdMs || 0);
          stats.retries++;
          if (r.holdMs) pausedUntil = Math.max(pausedUntil, now() + r.holdMs);
          if (o.onRetry) o.onRetry({ error: r.error, wait, pausedUntil });
          later(() => { if (signal && signal.aborted) { resolve({ ok: false, error: 'aborted' }); return; } queue.push(job); pump(); }, wait);
        };
        if (signal && signal.aborted) { resolve({ ok: false, error: 'aborted' }); return; }
        // Cancelled while waiting: out of the queue at once, so it never takes a request.
        if (signal) signal.addEventListener('abort', () => { const k = queue.indexOf(job); if (k >= 0) queue.splice(k, 1); resolve({ ok: false, error: 'aborted' }); }, { once: true });
        queue.push(job);
        pump();
      });
    }

    /**
     * Aggregated prices for many ids in one scope, 100 ids a request:
     *   { rows: Map(id -> row), missing: Set (not on the board there), failed: [ids with no usable answer],
     *     errors: Map(id -> error), error (the worst, or null), requests, answered, at (when the last answer came) }
     * onBatch({ requests, done, answered, failed }) after each request.
     */
    async function aggregated(scope, ids, opts) {
      const parts = chunks(ids);
      const rows = new Map(), missing = new Set(), failed = [], errors = new Map();
      let error = null, done = 0, answered = 0;
      const lose = (list, why) => { if (!list.length) return; for (const id of list) { failed.push(id); errors.set(id, why); } error = worst(error, why); };
      await Promise.all(parts.map(async (part) => {
        const r = await get(`aggregated/${scope}/${part.join(',')}`, opts);
        done++;
        if (r.ok && !r.notFound) {
          const p = parseAggregated(r.data, part, now());
          if (p.ok) {
            answered++;
            for (const [id, row] of p.rows) rows.set(id, row);
            for (const id of p.missing) missing.add(id);
            lose(part.filter((id) => !p.rows.has(id) && !p.missing.has(id)), 'bad-data');
          } else lose(part, 'bad-data');
        } else lose(part, r.ok ? 'http' : r.error);
        if (opts && opts.onBatch) opts.onBatch({ requests: parts.length, done, answered, failed: failed.length });
      }));
      return { rows, missing, failed, errors, error, requests: parts.length, answered, at: now() };
    }

    return {
      get,
      aggregated,
      /** One item in one scope: { ok, item }, { ok, notFound } or { ok: false, error }. */
      async item(scope, id, opts) {
        if (!Number.isSafeInteger(id) || id <= 0) return { ok: false, error: 'http' };
        const r = await get(`item/${scope}/${id}`, opts);
        if (!r.ok) return r;
        if (r.notFound) return { ok: true, notFound: true };
        const p = parseItem(r.data, now());
        return p.ok && p.item.id === id ? { ok: true, item: p.item, at: now() } : { ok: false, error: 'bad-data' };
      },
      /** The market tax rates of one world: { ok, rates } or { ok: false, error }. */
      async tax(worldId, opts) {
        if (!Number.isSafeInteger(worldId) || worldId <= 0) return { ok: false, error: 'http' };
        const r = await get(`tax/${worldId}`, opts);
        if (!r.ok) return r;
        if (r.notFound) return { ok: false, error: 'http', status: 404 };
        const p = parseTax(r.data);
        return p.ok ? { ok: true, rates: p.rates, at: now() } : p;
      },
      /** How many requests a set of ids takes. */
      requestsFor: (ids) => chunks(ids).length,
      stats: () => Object.assign({ inFlight, queued: queue.length, pausedUntil }, stats, { paths: stats.paths.slice() }),
      /** While a 429 or 503 holds the queue: the time it ends (ms), else 0. */
      pausedUntil: () => (now() < pausedUntil ? pausedUntil : 0),
    };
  }

  const Prices = { MAX_IDS, DEFAULTS, ERRORS, LEVELS, chunks, retryAfterMs, parseAggregated, parseItem, parseTax, createClient };
  if (typeof module === 'object' && module.exports) module.exports = Prices;
  else root.XivPrices = Prices;
})(typeof globalThis !== 'undefined' ? globalThis : this);
