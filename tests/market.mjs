// Tests for the Market & Crafting groundwork: the price paths (tools/lib/prices-contract.mjs)
// against captured Universalis answers. Run alone with `node tests/market.mjs`, or through
// tests/run.mjs. No network.
//
// Expected values come from outside this code: answers captured once from Universalis
// (tests/fixtures/universalis/).
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chunkIds, FORBIDDEN_KEYS, ITEM_FIELDS, keysDeep, MAX_IDS, upstreamFor } from '../tools/lib/prices-contract.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const uni = (name) => JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'universalis', `${name}.json`), 'utf8'));

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

await Promise.all(pending);
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
