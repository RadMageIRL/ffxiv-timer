// Tests for Crafting's money (v0.12.0 Phase 2): what a material is bought at, cash outlay and economic cost, the
// cheapest buy-or-craft plan, profit estimates and their basis, the price requests a recipe and Crafting Watch
// make, and what Crafting saves (js/craft-calc.js, js/crafting.js). Run alone with `node tests/crafting-costs.mjs`,
// or through tests/run.mjs. No network.
//
// Prices here are made up on purpose (quotes in js/craft-calc.js's shape), so every figure can be worked out by
// hand; recipes are the real 7.58 catalog or small made-up ones.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { decodeItems } from '../tools/build-market.mjs';
import { FLAG, FORMAT, MQF_DEFAULT, recipeLines, SEP } from '../tools/build-recipes.mjs';
import { chunkIds, MAX_IDS, upstreamFor } from '../radmagelabs/api/_ffxiv-prices/contract.mjs';

const require = createRequire(import.meta.url);
const D = require('../js/recipes.js');
const C = require('../js/craft-calc.js');
const M = require('../js/market-items.js');
const Crafting = require('../js/crafting.js');
const ITEMS = decodeItems(M.items);
const ON = new Set(ITEMS.map((i) => i.id));
const onBoard = (id) => ON.has(id);
const CAT = C.createCatalog(D, { items: ITEMS });
const canBeHq = (id) => Boolean(CAT.item(id) && CAT.item(id).hq);
const byName = (n) => ITEMS.find((i) => i.name === n).id;
const DAY = 86400000, NOW = Date.UTC(2026, 10, 18, 12);

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { failed++; console.error(`FAIL ${name}\n  ${String(e.message).split('\n').join('\n  ')}`); }
}

// A loaded quote: nq and hq as [lowest listing, 4-day average, sold a day, age of the listing in days, age of the
// last sale in days]; null for a side with nothing.
function quote(nq, hq) {
  const side = (s) => (s ? { min: { price: s[0], worldId: 79, at: NOW - (s[3] || 0) * DAY }, avg: s[1], vel: s[2], recent: s[4] === undefined ? { price: s[1] || s[0], at: NOW - DAY / 2 } : s[4] === null ? null : { price: s[1] || s[0], at: NOW - s[4] * DAY } } : null);
  const n = side(nq), h = side(hq);
  return { state: 'loaded', nq: n && n.min.price ? n.min : null, hq: h && h.min.price ? h.min : null, avg: { nq: n ? n.avg : null, hq: h ? h.avg : null },
    velocity: { nq: n ? n.vel : null, hq: h ? h.vel : null }, recent: { nq: n ? n.recent : null, hq: h ? h.recent : null } };
}
const book = (map) => (id) => (map.has(id) ? map.get(id) : onBoard(id) ? { state: 'idle' } : { state: 'off-board' });
// A small catalog in the real format: [id, result, yield, [[ingredient, amount], ...]].
function fake(list) {
  const recipes = list.map(([id, result, y, ings]) => ({ id, result, job: 0, yield: y, rlvl: 1, flags: 0, book: 0, mqf: MQF_DEFAULT, craftsmanship: 0, control: 0, ings })).sort((a, b) => a.id - b.id);
  return C.createCatalog({ format: FORMAT, source: {}, count: recipes.length, flags: FLAG, mqfDefault: MQF_DEFAULT, sep: SEP, jobs: D.jobs, levels: [[1, 1, 0]], books: [], extra: [], timed: [], vendors: '', vendorPricesUnverified: '', recipes: recipeLines(recipes) });
}
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} vs ${b}`);
let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

const COPPER = byName('Copper Ore'), TIN = byName('Tin Ore'), FIRE = 2, ICE = 3, BRONZE = byName('Bronze Ingot'), RIVETS = byName('Bronze Rivets');

// ---- what a material is bought at ----
test('buyAt: the cheaper of NQ and HQ; HQ materials only where the item can be HQ; nothing for a missing, zero or unloaded price', () => {
  const q = quote([100], [80]);
  assert.deepEqual(C.buyAt(q, 'any', true), { price: 80, worldId: 79, at: NOW, quality: 'hq' });
  assert.equal(C.buyAt(quote([100], [120]), 'any', true).quality, 'nq');
  assert.equal(C.buyAt(q, 'any', false).quality, 'nq', 'an item that cannot be HQ is never bought as HQ');
  assert.equal(C.buyAt(quote([100], [120]), 'hq', true).price, 120, 'HQ materials: the HQ listing even when NQ is cheaper');
  assert.equal(C.buyAt(quote([100], null), 'hq', true), null, 'HQ materials and no HQ listing: no price, not the NQ one');
  assert.equal(C.buyAt(quote([100], null), 'hq', false).price, 100, 'an NQ-only material keeps its NQ price');
  assert.equal(C.buyAt(quote([0], null), 'any', false), null);
  assert.equal(C.buyAt(quote(null, null), 'any', true), null);
  for (const state of ['off-board', 'pending', 'failed', 'missing', 'empty', 'idle', 'no-scope']) assert.equal(C.buyAt({ state }, 'any', true), null, state);
  assert.equal(C.buyAt(null, 'any', true), null);
});

// ---- cash outlay and economic cost ----
test('costPlan: 10 Bronze Ingots at known prices; tax on what is bought only; owned materials leave cash, not value', () => {
  const prices = new Map([[COPPER, quote([12])], [TIN, quote([20])], [FIRE, quote([3])], [ICE, quote([4])]]);
  const o = { quote: book(prices), canBeHq };
  const p = C.costPlan(CAT, BRONZE, 10, o);
  assert.deepEqual(p.lines.map((l) => [l.item, l.quantity, l.unit.price, l.cash, l.value]), [[COPPER, 20, 12, 240, 240], [TIN, 10, 20, 200, 200], [FIRE, 10, 3, 30, 30]]);
  assert.deepEqual([p.cash, p.value, p.perUnit], [{ total: 470, missing: 0 }, { total: 470, missing: 0 }, 47]);
  const taxed = C.costPlan(CAT, BRONZE, 10, { ...o, tax: 0.05 });
  close(taxed.cash.total, 493.5, 'cash with 5 %');
  close(taxed.value.total, 493.5, 'value with 5 %');
  const own = C.costPlan(CAT, BRONZE, 10, { ...o, tax: 0.05, owned: new Set([COPPER]) });
  close(own.cash.total, 241.5, 'owned copper is not paid for');
  close(own.value.total, 240 + 241.5, 'but is worth its listing, untaxed');
  assert.deepEqual(own.lines[0], { item: COPPER, quantity: 20, craftable: false, owned: true, unit: { price: 12, worldId: 79, at: NOW, quality: 'nq' }, cash: 0, value: 240, why: null });
  assert.equal(C.costPlan(CAT, BRONZE, 10, { ...o, tax: -1 }).cash.total, 470, 'a negative tax counts as none');
});

test('costPlan: a missing price is never zero: known totals, how many are missing, no cost per item; the reason is kept', () => {
  const prices = new Map([[COPPER, quote([12])], [TIN, { state: 'empty' }], [FIRE, quote(null)]]);
  const p = C.costPlan(CAT, BRONZE, 2, { quote: book(prices), canBeHq });
  assert.deepEqual([p.cash, p.value, p.perUnit], [{ total: 48, missing: 2 }, { total: 48, missing: 2 }, null]);
  assert.deepEqual(p.lines.map((l) => [l.item, l.cash, l.why]), [[COPPER, 48, null], [TIN, null, 'empty'], [FIRE, null, 'no-listing']]);
  const owned = C.costPlan(CAT, BRONZE, 2, { quote: book(prices), canBeHq, owned: new Set([TIN]) });
  assert.deepEqual([owned.cash.missing, owned.value.missing], [1, 2], 'owned without a price: nothing to pay, value unknown');
  const fish = byName('Battered Fish'), haddock = 12990;
  const bf = C.costPlan(CAT, fish, 1, { quote: book(new Map()), canBeHq });
  assert.equal(bf.lines.find((l) => l.item === haddock).why, 'off-board', 'Haddock is not on the board: no price, said so');
  assert.equal(C.costPlan(CAT, BRONZE, 2, { canBeHq }).value.missing, 3, 'no prices at all');
  assert.equal(C.costPlan(CAT, 5106, 1, {}).error, 'not-craftable', 'expand errors pass through');
});

test('costPlan: the oldest listing time it used', () => {
  const prices = new Map([[COPPER, quote([12, 0, 0, 5])], [TIN, quote([20, 0, 0, 1])], [FIRE, quote([3])]]);
  assert.equal(C.costPlan(CAT, BRONZE, 1, { quote: book(prices), canBeHq }).oldest, NOW - 5 * DAY);
});

// ---- the cheapest plan ----
test('cheapest: rounding decides: 1 of an intermediate that makes 6 is cheaper bought, even when crafting is cheaper per unit', () => {
  // A needs 1 B and 1 E; B makes 6 from 6 C. Bought, B is 10; crafted, a batch costs 6 x 2 = 12 for 6 (2 each).
  const cat = fake([[1, 100, 1, [[200, 1], [500, 1]]], [2, 200, 6, [[300, 6]]]]);
  const q = book(new Map([[200, quote([10])], [300, quote([2])], [500, quote([1])]]));
  const o = { quote: (id) => (id === 100 || id === 200 || id === 300 || id === 500 ? q(id) : { state: 'off-board' }), canBeHq: () => false };
  const c = C.cheapest(cat, 100, 1, o);
  assert.deepEqual([c.buy, c.value, c.missing, c.evaluated, c.exhaustive], [[200], 11, 0, 2, true]);
  const six = C.cheapest(cat, 100, 6, o);
  assert.deepEqual([six.buy, six.value], [[], 18], 'for 6, one batch (12) beats buying 6 (60)');
  assert.equal(C.cheapest(cat, 100, 1, { ...o, force: new Map([[200, 'craft']]) }).value, 13, 'a forced craft is kept');
});

test('cheapest: equals the brute-force minimum over every buy-or-craft choice, on real trees with random prices (and the value it reports is costPlan\'s)', () => {
  const trees = [byName('High House Supper Set'), byName('Heavy Crowsbeak Hammer'), byName('Velveteen Wedge Cap of Crafting'), byName('Camping Furniture'), RIVETS, byName('Crumbling Aqueduct')];
  for (const id of trees) {
    for (let round = 0; round < 3; round++) {
      const prices = new Map();
      for (const x of C.priceIds(CAT, id, onBoard)) if (rnd() > 0.06) prices.set(x, quote([Math.round(1 + rnd() * 400)], canBeHq(x) && rnd() > 0.5 ? [Math.round(1 + rnd() * 600)] : null));
      const o = { quote: book(prices), canBeHq, tax: round === 2 ? 0.05 : 0, owned: round === 1 ? new Set([...prices.keys()].filter(() => rnd() > 0.7)) : new Set() };
      const qty = [1, 3, 7][round];
      const c = C.cheapest(CAT, id, qty, o);
      const points = C.decisionPoints(CAT, id);
      let best = null;
      for (let m = 0; m < 2 ** points.length; m++) {
        const buy = points.filter((_, b) => (m >> b) & 1);
        const p = C.costPlan(CAT, id, qty, { ...o, buy });
        const r = [p.value.missing, p.value.total];
        if (!best || r[0] < best[0] || (r[0] === best[0] && r[1] < best[1] - 1e-9)) best = r;
      }
      assert.equal(c.missing, best[0], `${id} round ${round}: missing`);
      close(c.value, best[1], `${id} round ${round}: value`);
      const again = C.costPlan(CAT, id, qty, { ...o, buy: c.buy });
      assert.equal(again.value.missing, c.missing);
      close(again.value.total, c.value, `${id} round ${round}: costPlan of the chosen plan`);
      assert.equal(c.evaluated, 2 ** points.length);
    }
  }
});

test('cheapest: past 16 free choices it improves step by step instead of trying them all, and is never worse than crafting everything', () => {
  const list = [[1, 100, 1, Array.from({ length: 8 }, (_, k) => [200 + k, 1])]];
  // 8 intermediates, each with one intermediate under it: 16 choices; add 2 more levels on two of them: 18.
  for (let k = 0; k < 8; k++) list.push([2 + k, 200 + k, 1, [[300 + k, 1]]], [20 + k, 300 + k, 1, [[400 + k, 2]]]);
  list.push([40, 400, 1, [[500, 1]]], [41, 401, 1, [[501, 1]]]);
  const cat = fake(list);
  const prices = (id) => (id >= 500 ? quote([5]) : id >= 400 ? quote([20]) : id >= 300 ? quote([30]) : id >= 200 ? quote([1000]) : { state: 'off-board' });
  const o = { quote: prices, canBeHq: () => false };
  const c = C.cheapest(cat, 100, 1, o);
  assert.equal(C.decisionPoints(cat, 100).length, 18);
  assert.equal(c.exhaustive, false);
  assert.ok(c.evaluated < 2 ** 16);
  assert.ok(c.value <= C.costPlan(cat, 100, 1, { ...o, buy: [] }).value.total);
  assert.equal(c.missing, 0);
});

test('cheapest: an owned intermediate counts at its listing, untaxed, when the search weighs it against crafting', () => {
  // A needs 1 B; B (owned, listed at 100) or crafted from C (98 + 5 % tax = 102.9): keep using what you have.
  const cat = fake([[1, 100, 1, [[200, 1]]], [2, 200, 1, [[300, 1]]]]);
  const o = { quote: (id) => (id === 200 ? quote([100]) : id === 300 ? quote([98]) : { state: 'off-board' }), canBeHq: () => false, tax: 0.05, owned: new Set([200]) };
  const c = C.cheapest(cat, 100, 1, o);
  assert.deepEqual([c.buy, c.value], [[200], 100]);
  assert.deepEqual(C.cheapest(cat, 100, 1, { ...o, owned: new Set() }).buy, [], 'not owned: 105 to buy, 102.9 to craft');
});

test('cheapest: past 16 choices the search starts from each step\'s cheaper way per unit, so it finds what no single change reaches', () => {
  // 17 filler steps that do not matter, then X: crafting X needs Y, dear to craft (1000) and cheap to buy (10).
  // From "craft everything", one change at a time stops at buying X (100): crafting X pays only once Y is bought too.
  // Worked out from the bottom up, Y is bought and X crafted for 10 + 5.
  const list = [[1, 100, 1, [[200, 1], ...Array.from({ length: 17 }, (_, k) => [500 + k, 1])]], [2, 200, 1, [[300, 1], [400, 1]]], [3, 300, 1, [[600, 1]]]];
  for (let k = 0; k < 17; k++) list.push([10 + k, 500 + k, 1, [[700, 1]]]);
  const cat = fake(list);
  const prices = (id) => ({ 200: quote([100]), 300: quote([10]), 400: quote([5]), 600: quote([1000]), 700: quote([1]) }[id] || (id >= 500 && id < 517 ? quote([50]) : { state: 'off-board' }));
  const c = C.cheapest(cat, 100, 1, { quote: prices, canBeHq: () => false });
  assert.equal(c.exhaustive, false);
  assert.deepEqual([c.buy, c.value], [[300], 15 + 17]);
});

test('cheapest: fewest missing prices first, then the lowest value', () => {
  // A needs 1 B; B (craftable, from C) has a price, C has none: buying B is the only complete plan, though dearer.
  const cat = fake([[1, 100, 1, [[200, 1]]], [2, 200, 1, [[300, 1]]]]);
  const c = C.cheapest(cat, 100, 1, { quote: (id) => (id === 200 ? quote([999]) : id === 300 ? quote(null) : { state: 'off-board' }), canBeHq: () => false });
  assert.deepEqual([c.buy, c.value, c.missing], [[200], 999, 0]);
});

// ---- profit ----
test('profitOf: the lower of listing and 4-day average when both are there; otherwise the one there is, named; never an invented reference', () => {
  const cost = 600;
  const both = C.profitOf(quote([900, 800, 4], [1500, 1700, 2]), 'hq', cost);
  assert.deepEqual([both.basis, both.headline.ref, both.headline.profit], ['lower', 1500, 900]);
  close(both.headline.margin, 900 / 1500, 'margin');
  assert.deepEqual([both.estimates.listing.ref, both.estimates.average.ref, both.velocity], [1500, 1700, 2], 'HQ side only');
  const nq = C.profitOf(quote([900, 800, 4], [1500, 1700, 2]), 'nq', cost);
  assert.deepEqual([nq.basis, nq.headline.ref, nq.velocity], ['lower', 800, 4], 'the NQ side, with its own sales');
  const listingOnly = C.profitOf(quote([900, null, 0]), 'nq', cost);
  assert.deepEqual([listingOnly.basis, listingOnly.headline.ref, listingOnly.estimates.average], ['listing only', 900, null]);
  const salesOnly = C.profitOf(quote([0, 800, 1]), 'nq', cost);
  assert.deepEqual([salesOnly.basis, salesOnly.headline.ref, salesOnly.listing], ['sales only', 800, null]);
  const loss = C.profitOf(quote([500, 550, 3]), 'nq', cost);
  assert.deepEqual([loss.headline.profit, loss.basis], [-100, 'lower']);
  const noCost = C.profitOf(quote([900, 800, 4]), 'nq', null);
  assert.deepEqual([noCost.headline, noCost.basis, noCost.estimates], [null, null, { listing: null, average: null }], 'no cost, no estimate');
  assert.equal(noCost.listing.price, 900, 'the references are still shown');
  for (const q of [{ state: 'empty' }, { state: 'pending' }, null]) assert.deepEqual([C.profitOf(q, 'hq', cost).headline, C.profitOf(q, 'hq', cost).listing], [null, null]);
  assert.equal(C.profitOf(quote([900, 800, 4], null), 'hq', cost).headline, null, 'no HQ data: no HQ estimate, never the NQ one');
});

// ---- requests ----
test('priceIds: the item and every market item under it, every recipe counted, sorted, nothing off the board; at most 42, one request each', () => {
  assert.deepEqual(C.priceIds(CAT, RIVETS, onBoard), [FIRE, ICE, BRONZE, RIVETS, COPPER, TIN].sort((a, b) => a - b));
  assert.ok(!C.priceIds(CAT, byName('Battered Fish'), onBoard).includes(12990), 'Haddock is never asked for');
  let most = 0;
  for (const id of CAT.outputs()) {
    const ids = C.priceIds(CAT, id, onBoard);
    most = Math.max(most, ids.length);
    assert.ok(ids.every((x, k) => onBoard(x) && (k === 0 || ids[k - 1] < x)), `${id}: sorted, unique, on the board`);
    assert.deepEqual(chunkIds(ids), [ids], `${id}: one request, the same address every time`);
  }
  assert.equal(most, 42);
});

test('Crafting Watch: 132 items, 3 fixed requests of 100, 100 and 51 ids, the same for everyone; each a valid price path; covers every tree', () => {
  const w = C.watchList(CAT, onBoard);
  assert.equal(w.outputs.length, 132);
  assert.deepEqual(w.chunks.map((c) => c.length), [100, 100, 51]);
  assert.deepEqual(C.watchList(C.createCatalog(D, { items: ITEMS }), onBoard), w, 'deterministic');
  const all = w.chunks.flat();
  assert.equal(new Set(all).size, all.length);
  assert.deepEqual(all, [...all].sort((a, b) => a - b));
  for (const c of w.chunks) {
    assert.ok(c.length <= MAX_IDS);
    assert.deepEqual(chunkIds(c), [c], 'the client sends a batch as it is');
    assert.equal(upstreamFor(`aggregated/Aether/${c.join(',')}`).ids.length, c.length);
  }
  const covered = new Set(all);
  for (const id of w.outputs) {
    assert.ok(CAT.recipesFor(id).some((r) => r.level === 100 && (r.stars >= 4 || r.expert)));
    for (const x of C.priceIds(CAT, id, onBoard)) assert.ok(covered.has(x), `${x} under ${id}`);
  }
  assert.ok(w.outputs.every(onBoard));
});

test('Crafting Watch rows: ranked only with every price, both references, 1 sold a day and data under 3 days; thin otherwise; unpriced never ranked', () => {
  const w = C.watchList(CAT, onBoard);
  const target = w.outputs.find((id) => !canBeHq(id) && C.priceIds(CAT, id, onBoard).length > 3);
  const under = C.priceIds(CAT, target, onBoard).filter((x) => x !== target);
  const run = (rootQuote, more = {}) => {
    const prices = new Map(under.map((x) => [x, quote([10])]));
    prices.set(target, rootQuote);
    return C.watchRows(CAT, [target], { quote: book(prices), canBeHq, quality: 'hq', now: NOW, ...more })[0];
  };
  const good = run(quote([100000, 90000, 5]));
  assert.deepEqual([good.group, good.quality, good.profit.basis, good.stale, good.lowVolume], ['ranked', 'nq', 'lower', false, false]);
  assert.ok(good.cost > 0 && good.profit.headline.ref === 90000);
  assert.equal(run(quote([100000, 90000, 0.5])).group, 'thin', 'under 1 a day');
  assert.equal(run(quote([100000, 90000, 5, 4])).group, 'thin', 'a listing 4 days old');
  assert.equal(run(quote([100000, 90000, 5, 0, 5])).group, 'thin', 'last sale 5 days ago');
  assert.equal(run(quote([100000, 90000, 5, 0, null])).group, 'thin', 'no sale on record');
  assert.equal(run(quote([100000, null, 5])).group, 'thin', 'listing only');
  assert.equal(run(quote([100000, 90000, 0.5]), { minDaily: 0 }).group, 'ranked', 'the floor is an option');
  assert.equal(run({ state: 'empty' }).group, 'unpriced');
  const holes = C.watchRows(CAT, [target], { quote: book(new Map([[target, quote([100000, 90000, 5])]])), canBeHq, now: NOW })[0];
  assert.deepEqual([holes.group, holes.cost], ['unpriced', null], 'materials missing: not ranked, no cost');
  const hqItem = w.outputs.find(canBeHq);
  assert.equal(C.watchRows(CAT, [hqItem], { quote: book(new Map()), canBeHq, quality: 'hq', now: NOW })[0].quality, 'hq');
  assert.equal(C.watchRows(CAT, [hqItem], { quote: book(new Map()), canBeHq, quality: 'nq', now: NOW })[0].quality, 'nq');
});

test('Crafting Watch rows: each item at its cheapest recipe and plan, for one craft', () => {
  const w = C.watchList(CAT, onBoard);
  const multi = w.outputs.find((id) => CAT.recipesFor(id).length > 1);
  assert.ok(multi, 'a shortlist item with several recipes');
  const prices = new Map(C.priceIds(CAT, multi, onBoard).map((x) => [x, quote([Math.round(5 + rnd() * 90)], canBeHq(x) ? [200] : null)]));
  const row = C.watchRows(CAT, [multi], { quote: book(prices), canBeHq, now: NOW })[0];
  const per = CAT.recipesFor(multi).map((r) => {
    const o = { quote: book(prices), canBeHq, recipes: { [multi]: r.id }, jobs: [r.job] };
    return C.costPlan(CAT, multi, r.yield, { ...o, buy: C.cheapest(CAT, multi, r.yield, o).buy }).perUnit;
  });
  close(row.cost, Math.min(...per), 'the cheapest recipe');
});

// ---- what Crafting saves ----
test('saved preferences: tax 0 to 10, HQ or NQ, materials any or HQ; anything else falls back to the default', () => {
  assert.deepEqual(Crafting.sanitizePrefs(null), { tax: 0, quality: 'hq', materials: 'any' });
  assert.deepEqual(Crafting.sanitizePrefs({ tax: 5, quality: 'nq', materials: 'hq' }), { tax: 5, quality: 'nq', materials: 'hq' });
  for (const bad of [{ tax: 11 }, { tax: -1 }, { tax: 2.5 }, { tax: '5' }, { quality: 'HQ' }, { materials: 'nq' }, [], 'x', 7]) {
    const s = Crafting.sanitizePrefs(bad);
    assert.ok(s.tax === 0 && s.quality === 'hq' && s.materials === 'any', JSON.stringify(bad));
  }
  assert.deepEqual(Object.keys(Crafting.sanitizePrefs({ tax: 1, extra: 'x', owned: [1, 2] })), ['tax', 'quality', 'materials'], 'nothing else is kept');
});

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
