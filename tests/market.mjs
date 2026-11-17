// Tests for the Market & Crafting groundwork: the item list (js/market-items.js and its lock file),
// the price paths (tools/lib/prices-contract.mjs) against captured Universalis answers, the fake
// Universalis the browser tests use, and the hash router (js/router.js). Run alone with
// `node tests/market.mjs`, or through tests/run.mjs. No network.
//
// Expected values come from outside this code: Universalis's own list of marketable ids and its
// data centers (tests/fixtures/universalis/, captured once), a second extraction of the game
// tables from XIVAPI (tests/fixtures/xivapi-market.json), and the Resets panel's data centers.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { decodeItems, FORMAT, GROUPS, REGIONS } from '../tools/build-market.mjs';
import { compareMarketXivapi } from '../tools/lib/compare-market.mjs';
import { DATASET, MARKET_SHEETS } from '../tools/lib/gamedata.mjs';
import { chunkIds, FORBIDDEN_KEYS, ITEM_FIELDS, keysDeep, MAX_IDS, upstreamFor } from '../tools/lib/prices-contract.mjs';
import { serve } from '../tools/lib/static-server.mjs';
import { fakeUniversalis } from './lib/fake-universalis.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const M = require('../js/market-items.js');
const R = require('../js/resets.js');
const Router = require('../js/router.js');
const ITEMS = decodeItems(M.items);
const uni = (name) => JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'universalis', `${name}.json`), 'utf8'));
const DASH = new RegExp(`[${String.fromCharCode(0x2013)}-${String.fromCharCode(0x2015)}]`);

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

// ---- the item list ----
test('the lock file describes js/market-items.js exactly: bytes, SHA-256, source commit, sheet pins and counts', () => {
  const text = readFileSync(join(ROOT, 'js', 'market-items.js'));
  const lock = JSON.parse(readFileSync(join(ROOT, 'data', 'market-items.lock.json'), 'utf8'));
  assert.equal(lock.format, FORMAT);
  assert.equal(lock.file, 'js/market-items.js');
  assert.equal(lock.bytes, text.length);
  assert.equal(lock.sha256, createHash('sha256').update(text).digest('hex'));
  assert.deepEqual(lock.source, { dataset: DATASET.repo, commit: DATASET.commit, patch: DATASET.patch, language: DATASET.language });
  assert.deepEqual(lock.sheets, Object.fromEntries(MARKET_SHEETS.map((s) => [s, DATASET.sha256[s]])));
  assert.deepEqual([lock.count, lock.categories, lock.dataCenters, lock.worlds],
    [ITEMS.length, M.categories.length, M.dataCenters.length, M.dataCenters.reduce((n, d) => n + d.worlds.length, 0)]);
  assert.deepEqual(M.source, lock.source);
  assert.equal(M.count, ITEMS.length);
});

test('the list holds exactly the ids Universalis calls marketable (16,845 for 7.58)', () => {
  const theirs = uni('marketable');
  assert.equal(ITEMS.length, 16845);
  assert.equal(theirs.length, ITEMS.length);
  assert.deepEqual(ITEMS.map((i) => i.id), [...theirs].sort((a, b) => a - b));
});

test('items are sorted by id, each once, with a board category, a level, an HQ flag and a clean name', () => {
  const cats = new Set(M.categories.map((c) => c.id));
  for (let i = 0; i < ITEMS.length; i++) {
    const it = ITEMS[i];
    if (i) assert.ok(it.id > ITEMS[i - 1].id, `order at ${it.id}`);
    assert.ok(cats.has(it.category), `${it.id}: category ${it.category}`);
    assert.ok(Number.isInteger(it.level) && it.level >= 1, `${it.id}: level`);
    assert.equal(typeof it.hq, 'boolean');
    assert.ok(it.name && it.name === it.name.trim() && !/[\t\n\r]/.test(it.name), `${it.id}: name ${JSON.stringify(it.name)}`);
    assert.doesNotMatch(it.name, DASH, `${it.id}: a dash character in the name`);
  }
  assert.ok(ITEMS.some((i) => i.hq) && ITEMS.some((i) => !i.hq));
});

test('categories: every one shown holds an item, each in one of the four board groups, in board order', () => {
  const used = new Set(ITEMS.map((i) => i.category));
  assert.deepEqual(M.groups, GROUPS);
  for (const c of M.categories) {
    assert.ok(used.has(c.id), `${c.name} is empty`);
    assert.ok(GROUPS.some((g) => g.id === c.group), c.name);
  }
  for (let i = 1; i < M.categories.length; i++) {
    const a = M.categories[i - 1], b = M.categories[i];
    assert.ok(a.group < b.group || (a.group === b.group && a.order <= b.order), `${a.name} before ${b.name}`);
  }
  assert.equal(new Set(M.categories.map((c) => c.id)).size, M.categories.length);
  assert.equal(M.categories.length, 76);
});

test('names, categories, levels and HQ agree with a second extraction of the game data (XIVAPI 7.58)', () => {
  const x = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'xivapi-market.json'), 'utf8'));
  assert.ok(x.items.length >= 50, 'sample size');
  assert.deepEqual(compareMarketXivapi(x, ITEMS), []);
  // The comparison can fail.
  const bent = { ...x, items: x.items.map((r, i) => (i === 3 ? { ...r, name: `${r.name}x` } : i === 7 ? { ...r, level: r.level + 1 } : r)) };
  assert.equal(compareMarketXivapi(bent, ITEMS).length, 2);
});

test('data centers: the 11 global ones Universalis lists, with the same regions and the same worlds', () => {
  const dcs = uni('data-centers').filter((d) => REGIONS.some((r) => r.scope === d.region));
  const worlds = new Map(uni('worlds').map((w) => [w.id, w.name]));
  assert.equal(M.dataCenters.length, 11);
  assert.deepEqual(M.dataCenters.map((d) => d.name).sort(), dcs.map((d) => d.name).sort());
  for (const d of M.dataCenters) {
    const theirs = dcs.find((x) => x.name === d.name);
    assert.equal(REGIONS.find((r) => r.key === d.region).scope, theirs.region, d.name);
    assert.deepEqual(d.worlds.map((w) => w.id).sort((a, b) => a - b), [...theirs.worlds].sort((a, b) => a - b), d.name);
    for (const w of d.worlds) assert.equal(worlds.get(w.id), w.name, `world ${w.id}`);
  }
});

test('data centers use the Resets panel\'s keys, names, regions and order, so a saved choice carries over', () => {
  const regionName = new Map(M.regions.map((r) => [r.key, r.name]));
  assert.deepEqual(M.dataCenters.map((d) => ({ key: d.key, name: d.name, region: regionName.get(d.region) })), R.DATA_CENTERS);
});

test('js/market-items.js runs as a plain browser script and sets FFXIV_MARKET_ITEMS', () => {
  const sandbox = {};
  vm.runInNewContext(readFileSync(join(ROOT, 'js', 'market-items.js'), 'utf8'), sandbox);
  assert.equal(sandbox.FFXIV_MARKET_ITEMS.count, ITEMS.length);
  assert.equal(sandbox.FFXIV_MARKET_ITEMS.items, M.items);
});

test('the item list stays inside its share of the first Market visit (150 KB gzipped of the 200 KB budget)', () => {
  const gz = zlib.gzipSync(readFileSync(join(ROOT, 'js', 'market-items.js')), { level: 9 }).length;
  assert.ok(gz <= 150 * 1024, `${(gz / 1024).toFixed(1)} KB gzipped`);
});

test('js/market-items.js and its lock file are exactly what the generator builds from the cached game tables', () => {
  const cache = join(ROOT, 'tools', '.cache', DATASET.commit);
  if (!MARKET_SHEETS.every((s) => existsSync(join(cache, `${s}.csv`)))) { console.log('  (skipped: run node tools/build-market.mjs once to cache the game tables)'); return; }
  execFileSync(process.execPath, [join(ROOT, 'tools', 'build-market.mjs'), '--check', '--csv', cache], { stdio: 'pipe' });
});

// ---- the price paths ----
test('the pinned item fields name nothing that identifies a player', () => {
  for (const f of ITEM_FIELDS) for (const bad of FORBIDDEN_KEYS) assert.ok(!f.split('.').includes(bad), f);
  assert.equal(new Set(ITEM_FIELDS).size, ITEM_FIELDS.length);
});

test('no captured answer carries a name or a player id, and item answers carry only the pinned fields', () => {
  for (const f of readdirSync(join(ROOT, 'tests', 'fixtures', 'universalis'))) {
    const keys = keysDeep(JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'universalis', f), 'utf8')));
    for (const bad of FORBIDDEN_KEYS) assert.ok(!keys.has(bad), `${f}: ${bad}`);
  }
  const allowed = new Set(ITEM_FIELDS.flatMap((f) => f.split('.')));
  for (const name of ['item-dc-hq', 'item-dc-nq', 'item-world', 'item-thin', 'item-empty']) {
    const body = uni(name);
    for (const k of Object.keys(body)) assert.ok(allowed.has(k), `${name}: ${k}`);
    for (const row of [...body.listings, ...body.recentHistory]) for (const k of Object.keys(row)) assert.ok(allowed.has(k), `${name}: ${k}`);
    assert.ok(body.listings.length <= 20 && body.recentHistory.length <= 20, name);
  }
});

test('the page may ask for these price paths, and they map to the upstream as the rules will', () => {
  assert.equal(upstreamFor('aggregated/Aether/2,5057').url, 'https://universalis.app/api/v2/aggregated/Aether/2,5057');
  assert.equal(upstreamFor('aggregated/North-America/5057').scope, 'North-America');
  assert.deepEqual(upstreamFor('aggregated/Gilgamesh/2,5057').ids, [2, 5057]);
  assert.match(upstreamFor('item/Aether/5057').url, /^https:\/\/universalis\.app\/api\/v2\/Aether\/5057\?listings=20&entries=20&fields=itemID,/);
  assert.equal(upstreamFor('tax/63').url, 'https://universalis.app/api/v2/tax-rates?world=63');
  const hundred = Array.from({ length: MAX_IDS }, (_, i) => i + 1).join(',');
  assert.ok(upstreamFor(`aggregated/Aether/${hundred}`));
});

test('every other path is refused before the upstream: traversal, extra parts, 101 ids, odd scopes, queries', () => {
  const hundredOne = Array.from({ length: MAX_IDS + 1 }, (_, i) => i + 1).join(',');
  for (const p of [
    '', 'aggregated', 'aggregated/Aether', 'aggregated/Aether/', `aggregated/Aether/${hundredOne}`, 'aggregated/Aether/,2', 'aggregated/Aether/2,',
    'aggregated/Aether/2,,3', 'aggregated/../worlds/1', 'aggregated/Aether/2/../../worlds', 'aggregated/Ae ther/2', 'aggregated/Ae.ther/2',
    'aggregated/Aether/2?fields=x', 'item/Aether/5057/extra', 'item/Aether/abc', 'item/Aether/1234567890', 'item/Aether/5057%2F..',
    'tax/63?world=1', 'tax/abc', 'tax/123456', 'history/Aether/5057', 'data-centers', 'marketable', 'Aether/5057',
    `aggregated/${'x'.repeat(33)}/2`,
  ]) assert.equal(upstreamFor(p), null, p);
});

test('ids are sorted, de-duplicated and cut into requests of at most 100, the same for any order', () => {
  const ids = Array.from({ length: 250 }, (_, i) => 5000 + i);
  const shuffled = [...ids].reverse().concat([5001, 5002, 0, -3, 1.5, 'x']);
  const a = chunkIds(ids), b = chunkIds(shuffled);
  assert.deepEqual(a, b);
  assert.deepEqual(a.map((c) => c.length), [100, 100, 50]);
  for (const c of a) assert.ok(upstreamFor(`aggregated/Aether/${c.join(',')}`), 'each chunk is a valid path');
  assert.deepEqual(chunkIds([]), []);
});

test('captured answers: aggregated times in milliseconds, item review and sale times in seconds, upload times in milliseconds', () => {
  const ms = (t) => t > 1e12 && t < 4e12, s = (t) => t > 1e9 && t < 4e9;
  for (const name of ['aggregated-dc', 'aggregated-region', 'aggregated-world']) {
    for (const r of uni(name).results) {
      for (const side of [r.nq, r.hq]) for (const scope of Object.values(side.recentPurchase || {})) assert.ok(ms(scope.timestamp), `${name} ${r.itemId}`);
      for (const u of r.worldUploadTimes || []) assert.ok(ms(u.timestamp), `${name} ${r.itemId} upload`);
    }
  }
  for (const name of ['item-dc-hq', 'item-world', 'item-thin']) {
    const b = uni(name);
    assert.ok(ms(b.lastUploadTime), name);
    for (const l of b.listings) assert.ok(s(l.lastReviewTime), `${name} review`);
    for (const h of b.recentHistory) assert.ok(s(h.timestamp), `${name} sale`);
    for (const t of Object.values(b.worldUploadTimes || {})) assert.ok(ms(t), `${name} world upload`);
  }
});

test('captured answers: ids off the board are failedItems, items with no data are empty objects, worlds add a world level', () => {
  const dc = uni('aggregated-dc');
  assert.deepEqual([...dc.failedItems].sort((a, b) => a - b), [1, 30000]);
  assert.ok(dc.results.every((r) => ITEMS.some((i) => i.id === r.itemId)));
  const fire = dc.results.find((r) => r.itemId === 2);
  assert.deepEqual(fire.hq, { minListing: {}, recentPurchase: {}, averageSalePrice: {}, dailySaleVelocity: {} }, 'no HQ fire shards');
  assert.deepEqual(Object.keys(uni('aggregated-world').results.find((r) => r.itemId === 5057).nq.minListing).sort(), ['dc', 'region', 'world']);
  assert.deepEqual(Object.keys(dc.results.find((r) => r.itemId === 5057).nq.minListing).sort(), ['dc', 'region']);
  const empty = uni('aggregated-empty').results.find((r) => r.itemId === 5849);
  assert.equal(empty.worldUploadTimes, undefined);
  assert.deepEqual(empty.nq, { minListing: {}, recentPurchase: {}, averageSalePrice: {}, dailySaleVelocity: {} });
  const none = uni('item-empty');
  assert.deepEqual([none.listings.length, none.recentHistory.length, none.minPriceNQ], [0, 0, 0]);
  assert.equal(uni('error-unknown-scope').status, 404);
  assert.deepEqual(Object.keys(uni('tax-gilgamesh')).sort(), ['Crystarium', 'Gridania', 'Ishgard', 'Kugane', 'Limsa Lominsa', 'Old Sharlayan', 'Tuliyollal', "Ul'dah"]);
});

// ---- the fake Universalis ----
test('the fake Universalis answers like the rules: fixture shapes, failedItems, 404 for any other path, the query ignored', async () => {
  const fake = fakeUniversalis();
  const server = await serve({ mounts: [{ prefix: '/ffxiv/', dir: ROOT }], handlers: [{ prefix: '/ffxiv/prices/', handle: fake.handle }] });
  try {
    const get = async (p) => { const r = await fetch(`${server.origin}/ffxiv/prices/${p}`); return { status: r.status, type: r.headers.get('content-type'), text: await r.text() }; };
    let r = await get('aggregated/Aether/1,2,5057,30000,52712?fields=listings.retainerName');
    assert.equal(r.status, 200);
    let j = JSON.parse(r.text);
    assert.deepEqual(j.failedItems, [1, 30000]);
    assert.deepEqual(j.results.map((x) => x.itemId), [2, 5057, 52712], 'an item the fixtures lack still gets an answer');
    r = await get('aggregated/Primal/5057');
    assert.equal(JSON.parse(r.text).results[0].itemId, 5057, 'another data center reuses the shapes');
    r = await get('item/Gilgamesh/5057');
    j = JSON.parse(r.text);
    assert.deepEqual([j.itemID, j.worldName], [5057, 'Gilgamesh']);
    for (const bad of FORBIDDEN_KEYS) assert.ok(!keysDeep(j).has(bad));
    r = await get('item/Aether/2');
    assert.equal(JSON.parse(r.text).itemID, 2);
    assert.equal((await get('tax/63')).status, 200);
    assert.equal((await get('tax/9999')).status, 404, 'unknown world');
    assert.equal((await get('aggregated/Nowhere/2')).status, 404, 'unknown scope');
    assert.equal((await get('aggregated/Aether/2/../../worlds')).status, 404);
    assert.equal((await get('history/Aether/2')).status, 404);
    fake.empty([5057]);
    j = JSON.parse((await get('aggregated/Aether/5057')).text);
    assert.deepEqual(j.results[0].nq.minListing, {});
    assert.equal(JSON.parse((await get('item/Aether/5057')).text).listings.length, 0);
    assert.deepEqual(fake.calls.map((c) => c.kind), ['aggregated', 'aggregated', 'item', 'item', 'tax', 'tax', 'aggregated', 'aggregated', 'item'],
      'refused paths never reach the upstream');
  } finally { await server.close(); }
});

test('the fake Universalis fails on request: status codes, a dropped connection, a broken body, a delay, a hold', async () => {
  const fake = fakeUniversalis();
  const server = await serve({ mounts: [{ prefix: '/ffxiv/', dir: ROOT }], handlers: [{ prefix: '/ffxiv/prices/', handle: fake.handle }] });
  const url = `${server.origin}/ffxiv/prices/aggregated/Aether/2`;
  try {
    fake.failNext({ status: 503 }, 2);
    fake.failNext({ status: 429 });
    assert.deepEqual([(await fetch(url)).status, (await fetch(url)).status, (await fetch(url)).status, (await fetch(url)).status], [503, 503, 429, 200]);
    fake.failNext({ offline: true });
    await assert.rejects(fetch(url));
    fake.failNext({ mangle: true });
    const mangled = await fetch(url);
    assert.equal(mangled.status, 200);
    await assert.rejects(mangled.json(), SyntaxError);
    fake.failNext({ delay: 300 });
    const t0 = Date.now();
    assert.equal((await fetch(url)).status, 200);
    assert.ok(Date.now() - t0 >= 280, 'delayed');
    fake.hold();
    let done = false;
    const held = fetch(url).then((r) => { done = true; return r.status; });
    await new Promise((ok) => setTimeout(ok, 150));
    assert.equal(done, false, 'held');
    fake.release();
    assert.equal(await held, 200);
    // An aborted request shows as status 0 in the server's log.
    fake.hold();
    const ac = new AbortController();
    const aborted = fetch(url, { signal: ac.signal }).catch((e) => e.name);
    await new Promise((ok) => setTimeout(ok, 100));
    ac.abort();
    assert.equal(await aborted, 'AbortError');
    await new Promise((ok) => setTimeout(ok, 100)); // the server sees the connection close
    fake.release();
    await new Promise((ok) => setTimeout(ok, 100));
    assert.equal(server.requests.at(-1).status, 0, 'recorded as dropped, with no late answer after it');
    fake.reset();
    assert.equal(fake.calls.length, 0);
  } finally { await server.close(); }
});

// ---- the hash router ----
test('router: every address Timers & Weather has today still opens Timers & Weather', () => {
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const ids = [...html.matchAll(/\bid="([a-z][a-z0-9-]*)"/g)].map((m) => m[1]);
  assert.ok(ids.length > 50);
  for (const h of [
    '', '#', '#zone=middle-la-noscea', '#zone=eureka-pagos&fz=eureka-anemos&to=gales&bells=8',
    '#zone=eureka-pagos&fz=eureka-pagos&prev=fog&to=heat-waves', '#zone=zadnor', '#fz=eureka-anemos', '#zone=nowhere&fz=nowhere',
    '#marketplace', '#Market', '#markets/item/1', '#zone=market', '#%6Darket', '#market%2Fitem%2F5057', ' #market',
    ...ids.map((id) => `#${id}`),
  ]) assert.deepEqual(Router.modeOf(h), { mode: 'timers' }, h);
});

test('router: #market opens Prices, #market/item/<id> one item (1 to 9 digits, no leading zero), anything else under it a notice', () => {
  assert.deepEqual(Router.modeOf('#market'), { mode: 'market', view: 'home' });
  assert.deepEqual(Router.modeOf('market'), { mode: 'market', view: 'home' });
  assert.deepEqual(Router.modeOf('#market/'), { mode: 'market', view: 'home' });
  assert.deepEqual(Router.modeOf('#market/item/5057'), { mode: 'market', view: 'item', id: 5057 });
  assert.deepEqual(Router.modeOf('#market/item/1'), { mode: 'market', view: 'item', id: 1 });
  assert.deepEqual(Router.modeOf('#market/item/999999999'), { mode: 'market', view: 'item', id: 999999999 });
  for (const h of ['#market/item/0', '#market/item/05057', '#market/item/1234567890', '#market/item/', '#market/item/abc', '#market/item/5057/',
    '#market/item/5057?x=1', '#market/item/5057&zone=x', '#market/crafting', '#market/x', '#market//item/5057', '#market/item/-1', '#market/item/5e3']) {
    assert.deepEqual(Router.modeOf(h), { mode: 'market', view: 'notice' }, h);
  }
});

test('router: marketHash names the view modeOf reads back', () => {
  for (const v of [{ view: 'home' }, { view: 'item', id: 5057 }, { view: 'item', id: 999999999 }]) {
    const back = Router.modeOf(Router.marketHash(v));
    assert.equal(back.view, v.view);
    if (v.id) assert.equal(back.id, v.id);
  }
  for (const bad of [null, {}, { view: 'item' }, { view: 'item', id: 0 }, { view: 'item', id: 1e9 }, { view: 'item', id: 1.5 }]) assert.equal(Router.marketHash(bad), '#market');
});

test('router: js/router.js runs as a plain browser script and sets XivRouter', () => {
  const sandbox = {};
  vm.runInNewContext(readFileSync(join(ROOT, 'js', 'router.js'), 'utf8'), sandbox);
  assert.equal(JSON.stringify(sandbox.XivRouter.modeOf('#market/item/2')), JSON.stringify({ mode: 'market', view: 'item', id: 2 }));
});

await Promise.all(pending);
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
