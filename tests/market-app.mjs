// Tests for Market & Crafting's page code: the item list's search (js/market-catalog.js), and the price
// client and its parsers (js/prices.js) over captured Universalis answers and on a fake clock. Run
// alone with `node tests/market-app.mjs`, or through tests/run.mjs. No network.
//
// Expected values come from outside this code where they can: the captured answers in
// tests/fixtures/universalis/, the price function's allow list (the scopes it accepts), the contract's
// limits, and the plan's thresholds (V0.11.0 section 5: 100 ids a request).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ALLOW from '../radmagelabs/api/_ffxiv-prices/allow.mjs';
import { FORBIDDEN_KEYS, keysDeep, MAX_IDS, upstreamFor } from '../radmagelabs/api/_ffxiv-prices/contract.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const ITEMS = require('../js/market-items.js');
const Catalog = require('../js/market-catalog.js');
const Prices = require('../js/prices.js');
const uni = (name) => JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'universalis', `${name}.json`), 'utf8'));
const CAT = Catalog.parse(ITEMS).catalog;
const idx = (id) => CAT.byId.get(id);
// After every captured time (2026-11-17), so none is "in the future".
const NOW = Date.parse('2026-11-17T06:30:00Z');

let passed = 0, failed = 0;
const pending = [];
const fail = (name, e) => { failed++; console.error(`FAIL ${name}\n  ${String(e.message).split('\n').join('\n  ')}`); };
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') pending.push(r.then(() => { passed++; }, (e) => fail(name, e)));
    else passed++;
  } catch (e) { fail(name, e); }
}

// ---- the item list and its search ----
test('catalog: the item list parses whole: 16,845 items, every category counted, ids in order', () => {
  const r = Catalog.parse(ITEMS);
  assert.equal(r.ok, true, r.error);
  const c = r.catalog;
  assert.equal(c.count, 16845);
  assert.equal(c.ids.length, 16845);
  for (let i = 1; i < c.count; i++) assert.ok(c.ids[i] > c.ids[i - 1]);
  assert.equal([...c.categories.values()].reduce((n, x) => n + x.count, 0), 16845);
  assert.equal(c.names[idx(5057)], 'Iron Ingot');
  assert.equal(c.hq[idx(5057)], 1, 'Iron Ingot can be HQ');
  assert.equal(c.hq[idx(2)], 0, 'Fire Shard cannot');
  assert.equal(c.categories.get(c.cat[idx(2)]).name, 'Crystals');
});

test('catalog: a damaged list is refused whole, never searched', () => {
  const bad = (patch) => Catalog.parse({ ...ITEMS, ...patch });
  assert.equal(bad({ format: 2 }).ok, false);
  assert.equal(bad({ count: 16844 }).ok, false);
  assert.equal(bad({ items: ITEMS.items.replace('\tFire Shard', '\tFire Shard ') }).ok, false, 'a name with a trailing space');
  assert.equal(bad({ items: ITEMS.items.replace(/^2\t58\t/, '2\t999\t') }).ok, false, 'an unknown category');
  assert.equal(bad({ items: ITEMS.items.replace(/^2\t/, '0\t') }).ok, false, 'an id that does not move forward');
  assert.equal(bad({ items: ITEMS.items.replace(/^2\t58\t1\t0\t/, '2\t58\t1\t2\t') }).ok, false, 'an HQ flag that is not 0 or 1');
  assert.equal(Catalog.parse(null).ok, false);
  assert.equal(Catalog.parse('{"format":1}').ok, false);
});

test('catalog: the places are exactly the ones the price function accepts, spelled the same', () => {
  const s = CAT.scopes;
  assert.deepEqual(s.filter((x) => x.kind === 'region').map((x) => x.scope), ALLOW.REGIONS);
  assert.deepEqual(s.filter((x) => x.kind === 'dc').map((x) => x.scope), ALLOW.DATA_CENTERS);
  assert.deepEqual(s.filter((x) => x.kind === 'world').map((x) => x.scope).sort(), ALLOW.WORLDS.map(([, n]) => n).sort());
  for (const x of s) assert.ok(upstreamFor(`aggregated/${x.scope}/2`), `${x.id} is a path the contract allows`);
  assert.equal(s.length, 4 + 11 + 85);
  assert.equal(CAT.scopeById.get('dc:aether').scope, 'Aether');
  assert.deepEqual(CAT.scopeById.get('world:63'), { id: 'world:63', kind: 'world', name: 'Gilgamesh', scope: 'Gilgamesh', region: 'north-america', dc: 'aether', dcName: 'Aether', worldIds: [63] });
  assert.equal(CAT.scopeById.get('region:north-america').worldIds.length, 32);
  assert.deepEqual(CAT.scopeById.get('dc:aether').worldIds.sort((a, b) => a - b), [40, 54, 57, 63, 65, 73, 79, 99]);
});

test('catalog: search folds case, accents, apostrophes and punctuation, and every word typed must appear', () => {
  assert.equal(Catalog.fold("Dark Knight's  ARMS!"), 'dark knights arms');
  assert.equal(Catalog.fold(`R${String.fromCharCode(0x00e9)}sum${String.fromCharCode(0x00e9)}`), 'resume');
  assert.equal(Catalog.fold(`Knight${String.fromCharCode(0x2019)}s`), 'knights');
  const names = (r) => r.indexes.map((i) => CAT.names[i]);
  const r = Catalog.search(CAT, { query: 'popc caramel' });
  assert.equal(r.status, 'ok');
  assert.deepEqual(names(r), ['Caramel Popcorn']);
  assert.ok(names(Catalog.search(CAT, { query: 'IRON ingot' })).includes('Iron Ingot'));
});

test('catalog: ranking is the id, the whole name, the start, word starts, then the rest, each by name', () => {
  const r = Catalog.search(CAT, { query: 'iron ingot' });
  assert.equal(CAT.names[r.indexes[0]], 'Iron Ingot', 'the whole name first');
  const ranks = Catalog.search(CAT, { query: 'fire' }).indexes.map((i) => CAT.names[i]);
  assert.ok(ranks[0].toLowerCase().startsWith('fire'), 'names starting with it first');
  const firstNotStarting = ranks.findIndex((n) => !n.toLowerCase().startsWith('fire'));
  assert.ok(ranks.slice(firstNotStarting).every((n) => !n.toLowerCase().startsWith('fire')), 'every prefix match before the rest');
  assert.equal(CAT.names[Catalog.search(CAT, { query: '5057' }).indexes[0]], 'Iron Ingot', 'an id finds its item first');
  assert.deepEqual(Catalog.search(CAT, { query: '14' }).indexes.map((i) => CAT.names[i]), ['Fire Cluster', 'Construct 14 Identification Key'], 'item 14 before a name with 14 in it');
  const byName = Catalog.search(CAT, { query: 'fire', sort: 'name' }).indexes;
  for (let k = 1; k < byName.length; k++) assert.ok(CAT.pos[byName[k]] > CAT.pos[byName[k - 1]]);
});

test('catalog: nothing typed is the home; one letter asks for more; a type or favorites opens results; HQ and level only narrow', () => {
  assert.equal(Catalog.search(CAT, {}).status, 'idle');
  assert.equal(Catalog.search(CAT, { query: 'a' }).status, 'short');
  assert.equal(Catalog.search(CAT, { hq: true, minLevel: 700 }).status, 'idle', 'HQ and level alone stay on the home');
  const crystals = Catalog.search(CAT, { category: 58 });
  assert.equal(crystals.indexes.length, 18);
  assert.equal(Catalog.search(CAT, { query: 'a', category: 58 }).status, 'ok');
  assert.deepEqual(Catalog.search(CAT, { only: new Set([5057, 2]) }).indexes.map((i) => CAT.ids[i]).sort((a, b) => a - b), [2, 5057]);
  const hq = Catalog.search(CAT, { query: 'ingot', hq: true }).indexes;
  assert.ok(hq.length > 10 && hq.every((i) => CAT.hq[i] === 1));
  const lv = Catalog.search(CAT, { query: 'ingot', minLevel: 700, maxLevel: 770 }).indexes;
  assert.ok(lv.length > 0 && lv.every((i) => CAT.level[i] >= 700 && CAT.level[i] <= 770));
  assert.equal(Catalog.search(CAT, { query: 'ingot', category: 9999 }).indexes.length, Catalog.search(CAT, { query: 'ingot' }).indexes.length, 'an unknown type is no filter');
});

test('catalog: a value sort ranks what has a value, then what has none, then what is not loaded; never as 0', () => {
  const list = [idx(2), idx(3), idx(4), idx(5), idx(5057)];
  const v = { 2: 50, 3: null, 4: undefined, 5: 7, 5057: 50 };
  const r = Catalog.valueSort(CAT, list, (i) => v[CAT.ids[i]], 'asc');
  assert.deepEqual([r.ranked, r.noValue, r.unpriced], [3, 1, 1]);
  assert.deepEqual(r.order.map((i) => CAT.ids[i]), [5, 2, 5057, 3, 4], 'ties by name: Fire Shard before Iron Ingot');
  assert.deepEqual(Catalog.valueSort(CAT, list, (i) => v[CAT.ids[i]], 'desc').order.map((i) => CAT.ids[i]), [2, 5057, 5, 3, 4]);
});

test('catalog: browse groups follow the board: 4 groups, every category that holds an item', () => {
  const g = Catalog.browseGroups(CAT);
  assert.deepEqual(g.map((x) => x.name), ['Arms and tools', 'Armor and accessories', 'Items', 'Housing']);
  assert.equal(g.reduce((n, x) => n + x.categories.length, 0), 76);
  for (const x of g) for (let k = 1; k < x.categories.length; k++) assert.ok(x.categories[k].order > x.categories[k - 1].order);
});

test('catalog: a search over all 16,845 items takes under 16 ms a keystroke (median of 25, this machine)', () => {
  const times = [];
  for (const q of ['ir', 'iro', 'iron', 'iron i', 'iron in', 'grade 4 gem', 'materia xi', 'dye', 'wind crystal', 'zz', 'st', 'sto', 'ston', 'stone', 'a b', 'popoto', 'pot', 'ingot', 'leather', 'cloth', 'ma', 'mat', 'mate', 'mater', 'materi']) {
    const t = process.hrtime.bigint();
    Catalog.search(CAT, { query: q });
    times.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  times.sort((a, b) => a - b);
  assert.ok(times[12] < 16, `median ${times[12].toFixed(2)} ms`);
});

// ---- the price client's parsers, over captured answers ----
test('prices: aggregated answers at data center, region and world level; times in milliseconds; failedItems missing; empty entries marked', () => {
  const dc = uni('aggregated-dc'), asked = dc.results.map((r) => r.itemId).concat(dc.failedItems);
  const r = Prices.parseAggregated(dc, asked, NOW);
  assert.equal(r.ok, true);
  const iron = r.rows.get(5057);
  assert.deepEqual(iron.nq.min.dc, { price: 50, worldId: 57 });
  assert.deepEqual(iron.hq.min.region, { price: 50, worldId: 406 });
  assert.equal(iron.nq.recent.dc.at, 1794882425000, 'a purchase time in ms, kept as Universalis sent it');
  assert.equal(iron.uploads.get(79), 1794889439351);
  assert.equal(iron.nq.min.world, undefined, 'no world level at data center scope');
  assert.deepEqual([...r.missing].sort((a, b) => a - b), [1, 30000]);
  const world = Prices.parseAggregated(uni('aggregated-world'), [14], NOW).rows.get(14);
  assert.deepEqual(world.nq.min.world, { price: 13, worldId: null }, 'a world level names no world: it is the scope');
  assert.equal(Object.keys(world.hq.min).length, 0, 'an item with no HQ data has an empty HQ side');
  const empty = uni('aggregated-empty');
  const e = Prices.parseAggregated(empty, empty.results.map((x) => x.itemId), NOW);
  assert.ok([...e.rows.values()].some((x) => x.empty), 'an entry with nothing in it is no data, not a price of 0');
  for (const row of r.rows.values()) assert.deepEqual([...keysDeep(Object.fromEntries(Object.entries(row).filter(([k]) => k !== 'uploads')))].filter((k) => FORBIDDEN_KEYS.includes(k)), []);
});

test('prices: aggregated answers that are not answers are bad data, and ids not asked for are ignored', () => {
  assert.deepEqual(Prices.parseAggregated(null, [2], NOW), { ok: false, error: 'bad-data' });
  assert.deepEqual(Prices.parseAggregated({ results: 'x' }, [2], NOW), { ok: false, error: 'bad-data' });
  const r = Prices.parseAggregated({ results: [{ itemId: 999999, nq: {}, hq: {} }, { itemId: 2, nq: { minListing: { dc: { price: -5, worldId: 1 } } }, hq: {}, worldUploadTimes: [{ worldId: 57, timestamp: NOW + 5 * 86400000 }] }], failedItems: [] }, [2], NOW);
  assert.deepEqual([...r.rows.keys()], [2]);
  assert.equal(r.rows.get(2).nq.min.dc, undefined, 'a negative price is dropped');
  assert.equal(r.rows.get(2).uploads.size, 0, 'a time days in the future is dropped');
});

test('prices: item answers: listings cheapest first and sales newest first, review and sale times turned from seconds into ms', () => {
  const r = Prices.parseItem(uni('item-dc-hq'), NOW);
  assert.equal(r.ok, true);
  const it = r.item;
  assert.equal(it.id, 5057);
  assert.equal(it.lastUpload, 1794889439351);
  assert.equal(it.listings.length, 20);
  for (let k = 1; k < it.listings.length; k++) assert.ok(it.listings[k].price >= it.listings[k - 1].price);
  assert.deepEqual(it.listings[0], { price: 50, qty: 1, total: 50, tax: 2, hq: false, worldId: 57, worldName: 'Siren', reviewed: 1794883943000 });
  for (let k = 1; k < it.sales.length; k++) assert.ok(it.sales[k].at <= it.sales[k - 1].at);
  assert.equal(it.sales[0].at % 1000, 0, 'from seconds');
  assert.equal(it.uploads.get(57), 1794883954057);
  assert.ok(it.listings.some((l) => l.hq) && it.listings.some((l) => !l.hq));
  assert.deepEqual([...keysDeep(it)].filter((k) => FORBIDDEN_KEYS.includes(k)), []);
  const empty = Prices.parseItem(uni('item-empty'), NOW).item;
  assert.deepEqual([empty.listings.length, empty.sales.length], [0, 0]);
  assert.deepEqual(Prices.parseItem({ itemID: 'x' }, NOW), { ok: false, error: 'bad-data' });
});

test('prices: tax rates per city, in Universalis order; anything else is bad data', () => {
  assert.deepEqual(Prices.parseTax(uni('tax-gilgamesh')).rates.map((r) => `${r.city} ${r.pct}`), ['Limsa Lominsa 5', 'Gridania 5', "Ul'dah 5", 'Ishgard 3', 'Kugane 3', 'Crystarium 3', 'Old Sharlayan 3', 'Tuliyollal 3']);
  assert.deepEqual(Prices.parseTax({ '<b>': 5 }), { ok: false, error: 'bad-data' });
  assert.deepEqual(Prices.parseTax([]), { ok: false, error: 'bad-data' });
});

test('prices: ids go 100 to a request, sorted and once each, so 101 ids are two requests and never one', () => {
  assert.equal(Prices.MAX_IDS, MAX_IDS);
  const ids = Array.from({ length: 101 }, (_, k) => 1000 - k);
  const c = Prices.chunks(ids.concat(ids[0], -1, 0, 1.5, 'x'));
  assert.deepEqual(c.map((p) => p.length), [100, 1]);
  assert.deepEqual(c[0][0], 900);
  assert.ok(c.flat().every((v, k, a) => k === 0 || v > a[k - 1]));
  assert.equal(Prices.retryAfterMs('7', NOW), 7000);
  assert.equal(Prices.retryAfterMs(new Date(NOW + 9000).toUTCString(), NOW), 9000);
  assert.equal(Prices.retryAfterMs('soon', NOW), null);
});

// ---- the price client on a fake clock ----
function fakeWorld() {
  let t = NOW;
  const timers = [];
  const calls = [];
  const answers = [];
  const clock = {
    now: () => t,
    setTimeout: (fn, ms) => { const h = { at: t + ms, fn }; timers.push(h); return h; },
    clearTimeout: (h) => { const k = timers.indexOf(h); if (k >= 0) timers.splice(k, 1); },
  };
  const flush = async () => { for (let k = 0; k < 20; k++) await new Promise((r) => setImmediate(r)); };
  async function advance(ms) {
    const end = t + ms;
    for (;;) {
      await flush();
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (!next || next.at > end) break;
      timers.shift();
      t = next.at;
      next.fn();
    }
    t = end;
    await flush();
  }
  // Each fetch takes the next scripted answer: { status, body, headers } or 'throw' or 'never'.
  const fetch = (url, init) => {
    calls.push({ url, init, at: t });
    const a = fake.route ? fake.route(url) : answers.length ? answers.shift() : { status: 200, body: { results: [], failedItems: [] } };
    if (a === 'throw') throw new TypeError('no');
    return new Promise((ok, no) => {
      if (init.signal) init.signal.addEventListener('abort', () => no(new DOMException('aborted', 'AbortError')));
      if (a === 'never') return;
      if (a === 'reject') { no(new TypeError('network')); return; }
      ok({ status: a.status, headers: { get: (k) => (a.headers || {})[k.toLowerCase()] ?? null }, json: async () => { if (typeof a.body === 'string') return JSON.parse(a.body); return a.body; } });
    });
  };
  const fake = { clock, calls, answers, advance, flush, fetch, route: null };
  return fake;
}
const agg = (ids) => ({ status: 200, body: { results: ids.map((id) => ({ itemId: id, nq: { minListing: { dc: { price: 10, worldId: 57 } } }, hq: {}, worldUploadTimes: [{ worldId: 57, timestamp: NOW - 60000 }] })), failedItems: [] } });

test('client: same-origin prices/ paths only, no cookies or referrer, at most 4 at a time and paced', async () => {
  const w = fakeWorld();
  const c = Prices.createClient({ fetch: w.fetch, ...w.clock });
  for (let k = 0; k < 12; k++) w.answers.push('never');
  const jobs = Array.from({ length: 12 }, (_, k) => c.item('Aether', 100 + k));
  await w.flush();
  assert.equal(w.calls.length, 4, 'concurrency 4');
  for (const call of w.calls) {
    assert.match(call.url, /^prices\/item\/Aether\/\d+$/);
    assert.deepEqual([call.init.method, call.init.credentials, call.init.referrerPolicy], ['GET', 'omit', 'no-referrer']);
  }
  await w.advance(30000);
  void jobs;
  assert.ok(c.stats().maxInFlight <= 4);
});

test('client: a 429 holds every request for its Retry-After, then asks again; at most two tries more, never a loop', async () => {
  const w = fakeWorld();
  const c = Prices.createClient({ fetch: w.fetch, ...w.clock });
  w.route = (url) => (url.startsWith('prices/aggregated/') ? { status: 429, headers: { 'retry-after': '20' } } : { status: 200, body: { itemID: 5057 } });
  const p = c.aggregated('Aether', [2, 3]);
  await w.flush();
  assert.equal(w.calls.length, 1);
  assert.ok(c.pausedUntil() >= NOW + 20000, 'the queue is held');
  const other = c.item('Aether', 5057);
  await w.advance(19000);
  assert.equal(w.calls.length, 1, 'nothing at all is asked during the hold');
  await w.advance(2000);
  assert.ok(w.calls.length >= 2);
  assert.ok(w.calls.slice(1).every((x) => x.at >= NOW + 20000), 'the held request waited for the end of the hold');
  await w.advance(120000);
  const r = await p;
  const tries = w.calls.filter((x) => x.url.startsWith('prices/aggregated/')).length;
  assert.equal(tries, 3, 'one try and two more');
  assert.deepEqual([r.error, r.failed.sort((a, b) => a - b)], ['rate-limited', [2, 3]]);
  assert.equal((await other).ok, true, 'the request held behind it went out after the hold');
  assert.equal(c.stats().rateLimited, 3);
});

test('client: a 429 with no Retry-After waits 30 s, and a long one is capped at 60 s', async () => {
  const w = fakeWorld();
  const c = Prices.createClient({ fetch: w.fetch, ...w.clock });
  w.answers.push({ status: 429 });
  c.tax(63);
  await w.flush();
  assert.equal(c.pausedUntil(), NOW + 30000);
  const w2 = fakeWorld();
  const c2 = Prices.createClient({ fetch: w2.fetch, ...w2.clock });
  w2.answers.push({ status: 503, headers: { 'retry-after': '3600' } });
  c2.tax(63);
  await w2.flush();
  assert.equal(c2.pausedUntil(), NOW + 60000);
});

test('client: network failures, timeouts and 502/504 are tried again after 5 s and 15 s; a 404 is "not found"; bad JSON is bad data; nothing throws', async () => {
  const w = fakeWorld();
  const c = Prices.createClient({ fetch: w.fetch, ...w.clock });
  w.answers.push('reject', { status: 502 }, agg([2]));
  const p = c.aggregated('Aether', [2]);
  await w.advance(4999);
  assert.equal(w.calls.length, 1);
  await w.advance(1);
  assert.equal(w.calls.length, 2);
  await w.advance(15000);
  const r = await p;
  assert.equal(r.rows.get(2).nq.min.dc.price, 10);
  assert.equal(r.error, null);
  w.answers.push('never');
  const slow = c.tax(63);
  await w.advance(10000);
  assert.equal(w.calls.length, 4, 'timed out after 10 s and asked again');
  w.answers.push({ status: 404, body: { error: 'x' } });
  await w.advance(30000);
  assert.deepEqual(await slow, { ok: false, error: 'http', status: 404 });
  w.answers.push({ status: 200, body: '{"results": [' });
  assert.deepEqual((await c.aggregated('Aether', [2])).error, 'bad-data');
  w.answers.push('throw', { status: 200, body: { itemID: 2 } });
  const thrown = c.item('Aether', 2);
  await w.advance(30000);
  assert.equal((await thrown).ok, true, 'a fetch that throws is a network error, tried again');
  w.answers.push({ status: 404 });
  assert.deepEqual(await c.item('Aether', 7), { ok: true, notFound: true });
  w.answers.push({ status: 400, body: { error: 'bad' } });
  assert.deepEqual(await c.item('Aether', 8), { ok: false, error: 'http', status: 400 });
});

test('client: cancelled while waiting leaves the queue at once and asks nothing; cancelled in flight is "aborted"', async () => {
  const w = fakeWorld();
  const c = Prices.createClient({ fetch: w.fetch, ...w.clock, concurrency: 1 });
  w.answers.push('never');
  const ctl = new AbortController(), ctl2 = new AbortController();
  const a = c.item('Aether', 2, { signal: ctl.signal });
  const b = c.item('Aether', 3, { signal: ctl2.signal });
  await w.flush();
  assert.equal(w.calls.length, 1);
  ctl2.abort();
  assert.deepEqual(await b, { ok: false, error: 'aborted' });
  ctl.abort();
  assert.equal((await a).error, 'aborted');
  await w.advance(60000);
  assert.equal(w.calls.length, 1, 'the cancelled one was never asked for');
  const done = new AbortController(); done.abort();
  assert.deepEqual(await c.item('Aether', 4, { signal: done.signal }), { ok: false, error: 'aborted' });
});

test('client: an aggregated answer missing an id it was asked for is bad data for that id, never "no data"', async () => {
  const w = fakeWorld();
  const c = Prices.createClient({ fetch: w.fetch, ...w.clock });
  w.answers.push(agg([2]));
  const r = await c.aggregated('Aether', [2, 3]);
  assert.deepEqual([[...r.rows.keys()], r.failed, r.errors.get(3), r.missing.size], [[2], [3], 'bad-data', 0]);
  const many = Array.from({ length: 250 }, (_, k) => k + 1);
  w.answers.push(agg(many.slice(0, 100)), agg(many.slice(100, 200)), agg(many.slice(200)));
  const r2 = await c.aggregated('Aether', many);
  assert.equal(r2.requests, 3);
  assert.equal(r2.rows.size, 250);
  for (const call of w.calls.slice(1)) assert.ok(call.url.split('/').pop().split(',').length <= 100);
});

// ---- the files ----
test('files: the market asks only its own site (prices/), and the browser never names Universalis as an address to fetch', () => {
  for (const f of ['prices.js', 'market-catalog.js', 'app.js']) {
    const src = readFileSync(join(ROOT, 'js', f), 'utf8').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(src, /https?:\/\/universalis/i, `${f} names an address at Universalis`);
    assert.doesNotMatch(src, /new XMLHttpRequest|navigator\.sendBeacon|new WebSocket|new EventSource/, f);
  }
  const prices = readFileSync(join(ROOT, 'js', 'prices.js'), 'utf8');
  assert.match(prices, /base: 'prices\/'/);
});

await Promise.all(pending);
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
