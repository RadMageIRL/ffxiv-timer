// Tests for Crafting's foundation (v0.12.0 Phase 1): the recipe catalog (js/recipes.js and its lock file, built by
// tools/build-recipes.mjs), the vendor reading of the shop tables (tools/lib/shops.mjs), the timed-node mapping,
// and the calculation engine (js/craft-calc.js). Run alone with
// `node tests/crafting.mjs`, or through tests/run.mjs. No network.
//
// Expected values come from outside the code under test where they can: a second extraction of the game tables
// from XIVAPI (tests/fixtures/xivapi-recipes.json), the market list (js/market-items.js), the timed nodes
// (js/gathering-data.js), and hand-worked cases. The counts are 7.58's; a patch that changes them must change them
// here on purpose.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { buildRecipeData, decodeRecipes, FLAG, FORMAT, MQF_DEFAULT, recipeLines, renderModule, SEP } from '../tools/build-recipes.mjs';
import { decodeItems } from '../tools/build-market.mjs';
import { compareRecipesXivapi } from '../tools/lib/compare-recipes.mjs';
import { DATASET, RECIPE_SHEETS, loadTables } from '../tools/lib/gamedata.mjs';
import { gilVendorItems, reachableGilShops } from '../tools/lib/shops.mjs';
import { SAMPLE_ITEMS } from '../tools/verify-recipes.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const D = require('../js/recipes.js');
const C = require('../js/craft-calc.js');
const M = require('../js/market-items.js');
const G = require('../js/gathering-data.js');
const GE = require('../js/gathering.js');
const ITEMS = decodeItems(M.items);
const ON_BOARD = new Set(ITEMS.map((i) => i.id));
const CAT = C.createCatalog(D, { items: ITEMS });
const RECIPES = decodeRecipes(D.recipes);
const LOCK = JSON.parse(readFileSync(join(ROOT, 'data', 'recipes.lock.json'), 'utf8'));
const CACHE = join(ROOT, 'tools', '.cache', DATASET.commit);
const DASH = new RegExp(`[${String.fromCharCode(0x2013)}-${String.fromCharCode(0x2015)}]`);
const name = (id) => CAT.item(id)?.name;
const byName = (n) => { const it = ITEMS.find((i) => i.name === n); assert.ok(it, n); return it.id; };

let passed = 0, failed = 0;
const pending = [];
const fail = (n, e) => { failed++; console.error(`FAIL ${n}\n  ${String(e.message).split('\n').join('\n  ')}`); };
function test(n, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') pending.push(r.then(() => { passed++; }, (e) => fail(n, e)));
    else passed++;
  } catch (e) { fail(n, e); }
}

// A small catalog in the real format, for cases the game data does not isolate. recipes: [id, result, yield,
// [[ingredient, amount], ...], job?]
function fake(list) {
  const recipes = list.map(([id, result, y, ings, job = 0]) => ({ id, result, job, yield: y, rlvl: 1, flags: 0, book: 0, mqf: MQF_DEFAULT, craftsmanship: 0, control: 0, ings }))
    .sort((a, b) => a.id - b.id);
  return C.createCatalog({ format: FORMAT, source: {}, count: recipes.length, flags: FLAG, mqfDefault: MQF_DEFAULT, sep: SEP, jobs: D.jobs,
    levels: [[1, 1, 0]], books: [], extra: [], timed: [], vendors: '', vendorPricesUnverified: '', recipes: recipeLines(recipes) });
}
const plan = (cat, id, q, o) => { const p = C.expand(cat, id, q, o); assert.ok(p.ok, JSON.stringify(p)); return p; };
const mats = (p) => Object.fromEntries(p.materials.map((m) => [m.item, m.quantity]));
const steps = (p) => Object.fromEntries(p.steps.map((s) => [s.item, [s.need, s.crafts, s.made, s.surplus]]));

// ---- the catalog file ----
test('the lock file describes js/recipes.js exactly: bytes, SHA-256, source, sheet pins, nodes file and counts', () => {
  const text = readFileSync(join(ROOT, 'js', 'recipes.js'));
  assert.equal(LOCK.format, FORMAT);
  assert.equal(LOCK.file, 'js/recipes.js');
  assert.equal(LOCK.bytes, text.length);
  assert.equal(LOCK.sha256, createHash('sha256').update(text).digest('hex'));
  assert.deepEqual(LOCK.source, { dataset: DATASET.repo, commit: DATASET.commit, patch: DATASET.patch, language: DATASET.language });
  assert.deepEqual(D.source, LOCK.source);
  assert.deepEqual(LOCK.sheets, Object.fromEntries(RECIPE_SHEETS.map((s) => [s, DATASET.sha256[s]])));
  assert.equal(LOCK.supportedNodes, createHash('sha256').update(readFileSync(join(ROOT, 'data', 'supported-nodes.json'))).digest('hex'));
  assert.equal(D.format, FORMAT);
  assert.equal(D.count, RECIPES.length);
});

test('7.58 counts: 9,644 recipes making 9,490 market items, 111 with several recipes, 2,701 ingredients, 6 not on the board', () => {
  const outputs = new Set(RECIPES.map((r) => r.result));
  const per = new Map(); for (const r of RECIPES) per.set(r.result, (per.get(r.result) || 0) + 1);
  const ings = new Set(RECIPES.flatMap((r) => r.ings.map(([i]) => i)));
  assert.deepEqual([RECIPES.length, outputs.size, [...per.values()].filter((n) => n > 1).length, ings.size, D.extra.length],
    [9644, 9490, 111, 2701, 6]);
  assert.deepEqual([LOCK.recipes, LOCK.outputs, LOCK.outputsWithSeveralRecipes, LOCK.ingredients, LOCK.notOnTheBoard], [9644, 9490, 111, 2701, 6]);
  assert.deepEqual([LOCK.vendorItems, LOCK.vendorItemsGated, LOCK.timedItems, LOCK.books, LOCK.levels], [447, 57, 189, 110, 134]);
  assert.deepEqual(LOCK.graph, { cycles: 0, maxDepth: 5, maxMarketIds: 42, maxCraftSteps: 14 });
  assert.equal(CAT.count, 9644);
  assert.equal(CAT.outputs().length, 9490);
});

test('every result is on the market board, every ingredient is a market item or one of the named extras', () => {
  for (const r of RECIPES) assert.ok(ON_BOARD.has(r.result), `recipe ${r.id}: result ${r.result}`);
  const extra = new Map(D.extra.map(([id, n, hq, untradable]) => [id, { n, hq, untradable }]));
  for (const r of RECIPES) for (const [i] of r.ings) assert.ok(ON_BOARD.has(i) || extra.has(i), `recipe ${r.id}: ingredient ${i}`);
  for (const id of extra.keys()) assert.ok(!ON_BOARD.has(id), `${id} is on the board`);
  assert.deepEqual(D.extra.map(([id, n, , u]) => `${id} ${n}${u ? ' (untradable)' : ''}`), ['6155 Behemoth Horn (untradable)', "6164 Odin's Mantle (untradable)",
    '10112 Urushi (untradable)', '12990 Haddock', '23371 Oroniri Cloth (untradable)', '23372 Dotharli Cloth (untradable)']);
  // and every market item that has a recipe is in the catalog: none is lost by the board rule
  const outputs = new Set(RECIPES.map((r) => r.result));
  assert.equal(ITEMS.filter((i) => outputs.has(i.id)).length, 9490);
});

test('records are well formed: ids ascending and unique, jobs 0 to 7, known levels and books, amounts 1 to 99, no ingredient twice', () => {
  const levels = new Map(D.levels.map(([rl, l, s]) => [rl, [l, s]]));
  const books = new Map(D.books);
  let prev = 0;
  for (const r of RECIPES) {
    assert.ok(r.id > prev, `recipe ${r.id} after ${prev}`); prev = r.id;
    assert.ok(Number.isInteger(r.job) && r.job >= 0 && r.job < 8, `recipe ${r.id} job`);
    assert.ok(levels.has(r.rlvl), `recipe ${r.id} level ${r.rlvl}`);
    assert.ok(!r.book || books.has(r.book), `recipe ${r.id} book ${r.book}`);
    assert.ok(Number.isInteger(r.yield) && r.yield >= 1);
    assert.ok(r.ings.length >= 1 && r.ings.length <= 8);
    assert.equal(new Set(r.ings.map(([i]) => i)).size, r.ings.length, `recipe ${r.id}: an ingredient twice`);
    for (const [i, n] of r.ings) assert.ok(Number.isInteger(i) && i > 0 && Number.isInteger(n) && n >= 1 && n <= 99, `recipe ${r.id}: ${i}*${n}`);
    assert.equal(r.flags & ~(FLAG.canHq | FLAG.quickSynth | FLAG.expert | FLAG.specialist), 0);
  }
  for (const [, l, s] of D.levels) assert.ok(l >= 1 && l <= 100 && s >= 0 && s <= 5);
  assert.deepEqual(D.jobs.map((j) => j.abbr), ['CRP', 'BSM', 'ARM', 'GSM', 'LTW', 'WVR', 'ALC', 'CUL']);
  for (const [, n] of D.books) assert.match(n, /^Master .+|.+/);
  // the separators never appear inside a field
  for (const rec of D.recipes.split(SEP.record)) assert.match(rec, /^-?\d+ -?\d+ \d \d* \d+ \d+ \d* \d* \d* \d* [\d*,]+$/);
});

test('XIVAPI agrees on every sampled recipe (87, including the special cases)', () => {
  const x = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'xivapi-recipes.json'), 'utf8'));
  assert.equal(x.version, '7.58');
  assert.deepEqual(compareRecipesXivapi(x, RECIPES, D.levels), []);
  assert.equal(x.recipes.length, 87);
  const sampled = new Set(x.recipes.map((r) => r.result));
  for (const id of SAMPLE_ITEMS) assert.ok(sampled.has(id), `item ${id} sampled`);
  assert.ok(x.recipes.some((r) => r.yield > 1) && x.recipes.some((r) => r.expert) && x.recipes.some((r) => r.specialist) && x.recipes.some((r) => r.book));
  // and the comparison notices each kind of disagreement
  const planted = (fn) => { const y = JSON.parse(JSON.stringify(x)); fn(y.recipes.find((r) => r.id === 1)); return compareRecipesXivapi(y, RECIPES, D.levels); };
  assert.equal(planted((r) => { r.ingredients[0][1] = 3; }).length, 1, 'an amount');
  assert.equal(planted((r) => { r.ingredients[1][0] = 5108; }).length, 1, 'an ingredient');
  assert.equal(planted((r) => { r.yield = 2; }).length, 1, 'a yield');
  assert.equal(planted((r) => { r.job = 2; }).length, 1, 'a job');
  assert.equal(planted((r) => { r.canHq = false; }).length, 1, 'a flag');
  assert.equal(planted((r) => { r.stars = 1; }).length, 1, 'stars');
  assert.equal(planted((r) => { r.id = 999999; }).length, 1, 'a recipe the catalog lacks');
});

test('generated data is reproducible: the build gives exactly the committed files, and row order does not matter', async () => {
  if (!existsSync(join(CACHE, 'Recipe.csv'))) { console.log('  (skipped: run node tools/build-recipes.mjs once to cache the game tables)'); return; }
  execFileSync(process.execPath, [join(ROOT, 'tools', 'build-recipes.mjs'), '--check', '--csv', CACHE], { stdio: 'pipe' });
  const t = await loadTables(CACHE, RECIPE_SHEETS);
  const bases = JSON.parse(readFileSync(join(ROOT, 'data', 'supported-nodes.json'), 'utf8')).nodes.map((n) => n.base);
  const once = renderModule(buildRecipeData(t, bases));
  const shuffled = { ...t };
  for (const k of ['Recipe', 'GilShopItem', 'GatheringPointBase', 'ENpcBase']) shuffled[k] = [...t[k]].reverse();
  assert.equal(renderModule(buildRecipeData(shuffled, [...bases].reverse())), once);
  assert.equal(once, readFileSync(join(ROOT, 'js', 'recipes.js'), 'utf8'));
});

test('the catalog stays off the first load and compact: not in index.html outside the lazy template, under 82 KB gzipped', () => {
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8').replace(/<template id="lazy-scripts">[\s\S]*?<\/template>/, '');
  assert.ok(!html.includes('js/recipes.js') && !html.includes('js/craft-calc.js'));
  const gz = zlib.gzipSync(readFileSync(join(ROOT, 'js', 'recipes.js')), { level: 9 }).length;
  assert.ok(gz < 82000, `js/recipes.js is ${gz} bytes gzipped`);
});

// ---- graph ----
test('graph: no cycle, longest chain 5 crafts, at most 42 market items and 14 craftable steps under any item (every recipe counted)', () => {
  const kids = (id) => [...new Set(CAT.recipesFor(id).flatMap((r) => r.ingredients.map((i) => i.item)))];
  const memo = new Map();
  const depth = (id, path = new Set()) => {
    assert.ok(!path.has(id), `cycle through ${id}`);
    if (memo.has(id)) return memo.get(id);
    if (!CAT.craftable(id)) return 0;
    path.add(id);
    const d = 1 + Math.max(0, ...kids(id).map((k) => depth(k, path)));
    path.delete(id); memo.set(id, d);
    return d;
  };
  let maxD = 0, maxIds = 0, maxSteps = 0, deepest = 0;
  for (const id of CAT.outputs()) {
    const d = depth(id); if (d > maxD) { maxD = d; deepest = id; }
    const seen = new Set([id]), st = [id];
    while (st.length) for (const k of kids(st.pop())) if (!seen.has(k)) { seen.add(k); st.push(k); }
    maxIds = Math.max(maxIds, [...seen].filter((k) => ON_BOARD.has(k)).length);
    maxSteps = Math.max(maxSteps, [...seen].filter((k) => k !== id && CAT.craftable(k)).length);
  }
  assert.deepEqual([maxD, maxIds, maxSteps], [5, 42, 14]);
  assert.equal(name(deepest), 'Camping Furniture');
  assert.ok(maxIds <= 100, 'one aggregated price request covers any tree');
});

test('every item expands: crafts = ceil(need / yield), need adds up every use, materials add up every use, nothing is dropped', () => {
  let maxPoints = 0;
  for (const id of CAT.outputs()) {
    const p = plan(CAT, id, 1);
    const stepOf = new Map(p.steps.map((s) => [s.item, s]));
    assert.equal(p.steps[0].item, id);
    for (const s of p.steps) {
      const r = CAT.recipe(s.recipe);
      assert.equal(r.item, s.item);
      assert.equal(s.crafts, Math.ceil(s.need / r.yield));
      assert.equal(s.made, s.crafts * r.yield);
      assert.equal(s.surplus, s.made - s.need);
      if (s.item !== id) assert.equal(s.need, s.uses.reduce((n, u) => n + u.quantity, 0));
      for (const ing of r.ingredients) assert.ok(stepOf.has(ing.item) || p.materials.some((m) => m.item === ing.item), `${ing.item} dropped under ${id}`);
    }
    assert.equal(new Set(p.materials.map((m) => m.item)).size, p.materials.length, `a material listed twice under ${id}`);
    assert.equal(new Set(p.steps.map((s) => s.item)).size, p.steps.length, `a step listed twice under ${id}`);
    for (const m of p.materials) {
      assert.ok(!CAT.craftable(m.item), `${m.item} craftable but listed as a material with nothing bought`);
      assert.equal(m.quantity, m.uses.reduce((n, u) => n + u.quantity, 0));
      for (const u of m.uses) assert.equal(u.quantity, stepOf.get(u.item).crafts * CAT.recipe(stepOf.get(u.item).recipe).ingredients.find((i) => i.item === m.item).amount);
    }
    // every step comes after every step that uses it
    const at = new Map(p.steps.map((s, k) => [s.item, k]));
    for (const s of p.steps) for (const u of s.uses) assert.ok(at.get(u.item) < at.get(s.item));
    maxPoints = Math.max(maxPoints, C.decisionPoints(CAT, id).length);
  }
  assert.ok(maxPoints <= 14, `${maxPoints} buy-or-craft choices`);
});

// ---- the engine on real recipes ----
test('recipe lookup: Bronze Ingot on BSM (recipe 1) then ARM (170), Mythril Ingot on three jobs, a raw ore has none', () => {
  const bronze = byName('Bronze Ingot');
  assert.deepEqual(CAT.recipesFor(bronze).map((r) => [r.id, CAT.jobs[r.job].abbr]), [[1, 'BSM'], [170, 'ARM']]);
  const r = CAT.recipe(1);
  assert.deepEqual({ item: r.item, yield: r.yield, level: r.level, stars: r.stars, canHq: r.canHq, ings: r.ingredients.map((i) => [name(i.item), i.amount]) },
    { item: bronze, yield: 1, level: 1, stars: 0, canHq: true, ings: [['Copper Ore', 2], ['Tin Ore', 1], ['Fire Shard', 1]] });
  assert.deepEqual(CAT.recipesFor(byName('Mythril Ingot')).map((x) => CAT.jobs[x.job].abbr), ['BSM', 'ARM', 'GSM']);
  assert.deepEqual(CAT.recipesFor(byName('Copper Ore')), []);
  assert.equal(CAT.craftable(byName('Copper Ore')), false);
  assert.equal(CAT.recipe(999999), null);
  const ids = CAT.recipeIds(), gap = ids.find((id, k) => k && id - ids[k - 1] > 1) - 1;
  assert.ok(!ids.includes(gap));
  assert.equal(CAT.recipe(gap), null, `recipe ${gap} is not in the catalog (inside the id range)`);
  for (const bad of [0, -1, 1.5, '1', null]) assert.equal(CAT.recipe(bad), null, String(bad));
  assert.equal(CAT.recipe(1).id, 1);
  assert.equal(CAT.recipe(ids[ids.length - 1]).id, ids[ids.length - 1], 'the last record');
  assert.equal(CAT.recipesFor(bronze), CAT.recipesFor(bronze), 'the same list each time');
});

test('alternative recipes: default first job, a preferred job, an explicit recipe, and a recipe of another item refused', () => {
  const bronze = byName('Bronze Ingot');
  assert.equal(plan(CAT, bronze, 1).recipe, 1);
  assert.equal(mats(plan(CAT, bronze, 1))[2], 1, 'Fire Shard on BSM');
  const arm = plan(CAT, bronze, 1, { jobs: [2] });
  assert.equal(arm.recipe, 170);
  assert.deepEqual(mats(arm), { 5106: 2, 5107: 1, 3: 1 }, 'Ice Shard on ARM');
  assert.equal(plan(CAT, bronze, 1, { jobs: [7, 2, 1] }).recipe, 170, 'first preferred job that has a recipe');
  assert.equal(plan(CAT, bronze, 1, { recipes: { [bronze]: 170 } }).recipe, 170);
  assert.equal(plan(CAT, bronze, 1, { recipes: new Map([[bronze, 170]]), jobs: [1] }).recipe, 170, 'an explicit recipe beats a job preference');
  assert.deepEqual(C.expand(CAT, bronze, 1, { recipes: { [bronze]: 43 } }), { ok: false, error: 'bad-recipe', item: bronze }, 'recipe 43 makes Iron Ingot');
  // an intermediate's choice applies wherever it is used
  const rivets = byName('Bronze Rivets');
  const p = plan(CAT, rivets, 3, { recipes: { [bronze]: 170 } });
  assert.equal(p.steps.find((s) => s.item === bronze).recipe, 170);
  // Glamour Prism: seven jobs, seven different materials
  const glamour = CAT.recipesFor(byName('Glamour Prism'));
  assert.equal(glamour.length, 7);
  assert.equal(new Set(glamour.map((r) => r.ingredients.filter((i) => i.item > 19).map((i) => i.item).sort().join())).size, 7);
});

test('yields and rounding: Table Salt makes 6; 1 needs 1 craft (5 left), 6 needs 1, 7 needs 2 (5 left)', () => {
  const salt = byName('Table Salt');
  assert.equal(CAT.recipesFor(salt)[0].yield, 6);
  for (const [q, crafts, surplus] of [[1, 1, 5], [6, 1, 0], [7, 2, 5], [12, 2, 0], [13, 3, 5]]) {
    const p = plan(CAT, salt, q);
    assert.deepEqual(steps(p)[salt], [q, crafts, crafts * 6, surplus], `x${q}`);
    assert.deepEqual(mats(p), { [byName('Rock Salt')]: crafts, 2: crafts }, `x${q} materials`);
    assert.deepEqual(p.surplus, surplus ? [{ item: salt, quantity: surplus }] : []);
  }
});

test('shared intermediates are added up before rounding: Heavy Crowsbeak Hammer needs Clove Oil twice, 1 craft of 3', () => {
  const hammer = byName('Heavy Crowsbeak Hammer'), oil = byName('Clove Oil');
  const p = plan(CAT, hammer, 1);
  const s = p.steps.find((x) => x.item === oil);
  assert.deepEqual(s.uses.map((u) => [name(u.item), u.quantity]), [['Heavy Crowsbeak Hammer', 1], ['Crowsbeak Hammer', 1]]);
  assert.deepEqual([s.need, s.crafts, s.made, s.surplus], [2, 1, 3, 1], 'per branch it would be 2 crafts');
  assert.deepEqual(p.surplus.map((x) => [name(x.item), x.quantity]), [['Clove Oil', 1]]);
  // Velveteen Wedge Cap of Crafting: Cotton Yarn (makes 2) used 2 + 1 times: 2 crafts, 1 left
  const cap = plan(CAT, byName('Velveteen Wedge Cap of Crafting'), 1);
  assert.deepEqual(steps(cap)[byName('Cotton Yarn')], [3, 2, 4, 1]);
  assert.deepEqual(mats(cap)[byName('Cotton Boll')], 4);
});

test('quantities scale through the tree: 10 Bronze Ingots take 20 Copper Ore, 10 Tin Ore, 10 Fire Shards', () => {
  assert.deepEqual(mats(plan(CAT, byName('Bronze Ingot'), 10)), { 5106: 20, 5107: 10, 2: 10 });
  const p = plan(CAT, byName('Bronze Rivets'), 5);
  assert.deepEqual(steps(p)[byName('Bronze Ingot')], [5, 5, 5, 0]);
  assert.deepEqual(mats(p), { 5106: 10, 5107: 5, 2: 10 }, 'Fire Shards for the rivets and the ingots, added up');
  assert.equal(p.materials.find((m) => m.item === 2).uses.length, 2);
});

test('craft or buy: a bought intermediate is a material and its own ingredients go; buy all keeps only direct materials', () => {
  const rivets = byName('Bronze Rivets'), ingot = byName('Bronze Ingot');
  const p = plan(CAT, rivets, 5, { buy: [ingot] });
  assert.deepEqual(mats(p), { [ingot]: 5, 2: 5 });
  assert.equal(p.materials.find((m) => m.item === ingot).craftable, true);
  assert.deepEqual(p.steps.map((s) => s.item), [rivets]);
  assert.equal(p.tree.children.find((c) => c.item === ingot).action, 'buy');
  const hammer = byName('Heavy Crowsbeak Hammer');
  const all = plan(CAT, hammer, 1, { buy: 'all' });
  assert.deepEqual(all.steps.map((s) => s.item), [hammer]);
  assert.deepEqual(all.materials.map((m) => m.item), CAT.recipe(all.recipe).ingredients.map((i) => i.item));
  assert.deepEqual(C.decisionPoints(CAT, hammer).map(name), plan(CAT, hammer, 1).steps.slice(1).map((s) => name(s.item)));
  // buying something not in the tree changes nothing
  assert.deepEqual(plan(CAT, rivets, 5, { buy: [byName('Iron Ingot')] }), plan(CAT, rivets, 5));
});

test('gathered, timed, vendor and crystal materials are listed like any other: none is free or skipped', () => {
  const timedId = CAT.timedItems().find((id) => CAT.recipeIds().some((r) => CAT.recipe(r).ingredients.some((i) => i.item === id) && CAT.recipe(r).ingredients.length >= 2));
  const r = CAT.recipeIds().map(CAT.recipe).find((x) => x.ingredients.some((i) => i.item === timedId));
  const p = plan(CAT, r.item, 2, { recipes: { [r.item]: r.id } });
  assert.ok(p.materials.some((m) => m.item === timedId) || p.steps.some((s) => s.item === timedId));
  const bronze = plan(CAT, byName('Bronze Ingot'), 1);
  assert.ok(CAT.vendor(5106) && bronze.materials.some((m) => m.item === 5106), 'Copper Ore is sold by a vendor and still listed');
  assert.ok(bronze.materials.some((m) => m.item === 2), 'crystals listed');
});

test('the tree shows each use with its own amount; an intermediate used twice appears under both parents', () => {
  const hammer = byName('Heavy Crowsbeak Hammer');
  const p = plan(CAT, hammer, 2);
  assert.deepEqual([p.tree.item, p.tree.amount, p.tree.action], [hammer, 2, 'craft']);
  const find = (n, id, out = []) => { if (n.item === id) out.push(n); for (const c of n.children || []) find(c, id, out); return out; };
  assert.equal(find(p.tree, byName('Clove Oil')).length, 2);
  for (const n of find(p.tree, byName('Clove Oil'))) assert.deepEqual([n.action, n.recipe], ['craft', p.steps.find((s) => s.item === n.item).recipe]);
  assert.equal(find(p.tree, 5111)[0].action, 'material', 'Iron Ore cannot be crafted');
});

// ---- the engine on small made-up catalogs ----
test('consolidation before rounding: B and C each need 1 D, D makes 2, so 1 craft of D, not 2', () => {
  const cat = fake([[1, 100, 1, [[200, 1], [300, 1]]], [2, 200, 1, [[400, 1]]], [3, 300, 1, [[400, 1]]], [4, 400, 2, [[500, 1]]]]);
  const p = plan(cat, 100, 1);
  assert.deepEqual(steps(p), { 100: [1, 1, 1, 0], 200: [1, 1, 1, 0], 300: [1, 1, 1, 0], 400: [2, 1, 2, 0] });
  assert.deepEqual(mats(p), { 500: 1 });
  assert.deepEqual(p.steps.find((s) => s.item === 400).uses, [{ item: 200, quantity: 1 }, { item: 300, quantity: 1 }]);
  const q = plan(cat, 100, 3);
  assert.deepEqual(steps(q)[400], [6, 3, 6, 0]);
  assert.deepEqual(plan(cat, 100, 1, { buy: [200] }).materials.map((m) => [m.item, m.quantity]), [[200, 1], [500, 1]], 'only C still needs D: 1 needed, 1 craft of 2');
  assert.deepEqual(steps(plan(cat, 100, 1, { buy: [200] }))[400], [1, 1, 2, 1]);
});

test('a deep chain multiplies at every level and rounds at every level', () => {
  // A needs 3 B; B makes 2 and needs 5 C; C makes 4 and needs 1 E.
  const cat = fake([[1, 10, 1, [[20, 3]]], [2, 20, 2, [[30, 5]]], [3, 30, 4, [[40, 1]]]]);
  const p = plan(cat, 10, 1);
  assert.deepEqual(steps(p), { 10: [1, 1, 1, 0], 20: [3, 2, 4, 1], 30: [10, 3, 12, 2] });
  assert.deepEqual(mats(p), { 40: 3 });
  assert.equal(p.crafts, 6);
});

test('errors: bad quantity, not craftable, bad buy, cycle, too deep; never a throw', () => {
  const bronze = byName('Bronze Ingot');
  for (const q of [0, -1, 1.5, 10000, NaN, '5', null, undefined, Infinity]) assert.deepEqual(C.expand(CAT, bronze, q), { ok: false, error: 'bad-quantity', item: bronze }, String(q));
  assert.ok(C.expand(CAT, bronze, 9999).ok, 'the most');
  assert.deepEqual(C.expand(CAT, 5106, 1), { ok: false, error: 'not-craftable', item: 5106 });
  assert.deepEqual(C.expand(CAT, 99999999, 1), { ok: false, error: 'not-craftable', item: 99999999 });
  assert.deepEqual(C.expand(CAT, bronze, 1, { buy: [bronze] }), { ok: false, error: 'bad-buy', item: bronze });
  assert.deepEqual(C.expand(CAT, bronze, 1, { buy: ['5106'] }), { ok: false, error: 'bad-buy', item: '5106' });
  const loop = fake([[1, 100, 1, [[200, 1]]], [2, 200, 1, [[300, 1]]], [3, 300, 1, [[100, 1]]]]);
  const c = C.expand(loop, 100, 1);
  assert.deepEqual([c.ok, c.error, c.path], [false, 'cycle', [100, 200, 300, 100]]);
  assert.ok(C.expand(loop, 100, 1, { buy: [300] }).ok, 'buying one link breaks the cycle');
  const chain = fake(Array.from({ length: 40 }, (_, k) => [k + 1, 1000 + k, 1, [[1001 + k, 1]]]));
  assert.equal(C.expand(chain, 1000, 1).error, 'too-deep');
  assert.ok(C.expand(chain, 1020, 1).ok, '20 deep is fine');
  for (const e of [c.error, 'bad-quantity', 'not-craftable', 'bad-buy', 'bad-recipe', 'too-deep']) assert.ok(C.ERRORS.includes(e));
  assert.throws(() => C.createCatalog({ format: 2 }), /format 1/);
  assert.throws(() => C.createCatalog({ ...D, count: 1 }), /says 1 recipes/);
});

test('deterministic and side-effect free: the catalog is frozen, answers are new objects, the same input gives the same answer', () => {
  const hammer = byName('Heavy Crowsbeak Hammer');
  const r = CAT.recipe(1);
  assert.ok(Object.isFrozen(r) && Object.isFrozen(r.ingredients) && r.ingredients.every(Object.isFrozen));
  assert.ok(Object.isFrozen(CAT) && Object.isFrozen(CAT.recipesFor(5056)) && Object.isFrozen(CAT.outputs()));
  const a = plan(CAT, hammer, 3), b = plan(CAT, hammer, 3);
  assert.deepEqual(a, b);
  a.steps[0].need = 999; a.materials.length = 0; a.steps[1].uses.push({ item: 1, quantity: 1 });
  assert.deepEqual(plan(CAT, hammer, 3), b, 'changing an answer changes nothing else');
  const fresh = C.createCatalog(D, { items: ITEMS });
  assert.equal(JSON.stringify(plan(fresh, hammer, 3)), JSON.stringify(b));
  const before = JSON.stringify(D);
  for (const id of CAT.outputs().slice(0, 500)) C.expand(CAT, id, 7, { buy: C.decisionPoints(CAT, id).slice(0, 1) });
  assert.equal(JSON.stringify(D), before, 'the data object is untouched');
});

// ---- HQ and NQ ----
test('HQ in the data: recipe CanHq, the item\'s own HQ flag from the market list, HQ material factor 0, 50 or 75', () => {
  const all = CAT.recipeIds().map(CAT.recipe);
  assert.equal(all.filter((r) => r.canHq).length, 8035);
  assert.equal(all.filter((r) => r.canHq && !CAT.item(r.item).hq).length, 0, 'a recipe that can be HQ makes an item that can be HQ (collectables are not in the catalog)');
  assert.equal(all.filter((r) => !r.canHq && CAT.item(r.item).hq).length, 0);
  assert.deepEqual([...new Set(all.map((r) => r.hqMaterialFactor))].sort((a, b) => a - b), [0, 50, 75]);
  assert.equal(CAT.item(5056).hq, true);
  assert.equal(CAT.item(2).hq, false, 'crystals are never HQ');
  assert.deepEqual(CAT.item(12990), { id: 12990, name: 'Haddock', hq: false, untradable: false, onBoard: false });
  assert.equal(C.createCatalog(D).item(5056), null, 'without the market list, market items have no name here');
  assert.deepEqual([all.filter((r) => r.expert).length, all.filter((r) => r.specialist).length, all.filter((r) => r.book).length], [40, 19, 3411]);
});

// ---- vendors ----
test('vendors: 447 ingredients an NPC sells for gil (57 behind a quest); listed prices kept apart and marked unverified', () => {
  assert.equal(CAT.vendorItems().length, 447);
  assert.equal(CAT.vendorItems().filter((id) => CAT.vendor(id).gated).length, 57);
  assert.deepEqual(CAT.vendor(5106), { gated: false, hq: false, priceUnverified: 2 }, 'Copper Ore at the Material Supplier');
  assert.deepEqual(CAT.vendor(12990), { gated: false, hq: false, priceUnverified: 4 }, 'Haddock, not on the board');
  assert.equal(CAT.vendor(5065).gated, true, 'Mythril Ingot: the Amalj\'aa vendor, after a beast tribe quest');
  assert.equal(CAT.vendor(4603), null, 'Hi-Potion of Mind: in a shop no NPC opens');
  assert.equal(CAT.vendor(23372), null, 'Dotharli Cloth: in a shop no NPC opens');
  assert.equal(CAT.vendor(2), null, 'crystals are never sold by vendors');
  const ings = new Set(RECIPES.flatMap((r) => r.ings.map(([i]) => i)));
  for (const id of CAT.vendorItems()) {
    assert.ok(ings.has(id), `${id} is not an ingredient`);
    const v = CAT.vendor(id);
    assert.ok(Number.isSafeInteger(v.priceUnverified) && v.priceUnverified > 0);
    assert.equal(v.hq, false);
  }
  assert.ok(!Object.keys(D).some((k) => /^vendorPrice/.test(k) && k !== 'vendorPricesUnverified'), 'the price field says it is unverified');
  assert.equal(D.vendorPricesUnverified.split(',').length, D.vendors.split(SEP.record).length);
});

test('shop reachability on made-up tables: direct, menu, gated pre-handler, script, nested handler, unreachable, seasonal, row quest', () => {
  const row = (id, extra = {}) => ({ '#': String(id), Quest: '0', FestivalId: '0', ...extra });
  const item = (shop, sub, it, extra = {}) => ({ '#': `${shop}.${sub}`, Item: String(it), 'QuestRequired[0]': '0', 'QuestRequired[1]': '0', AchievementRequired: '0', StateRequired: '100', IsHQ: 'False', ...extra });
  const topic = (id, shops) => Object.fromEntries([['#', String(id)], ...Array.from({ length: 10 }, (_, k) => [`Shop[${k}]`, String(shops[k] || 0)])]);
  const t = {
    GilShop: [row(262144), row(262145), row(262146), row(262147), row(262148), row(262149), row(262150, { FestivalId: '5' })],
    GilShopItem: [item(262144, 0, 1), item(262145, 0, 2), item(262146, 0, 3), item(262147, 0, 4), item(262148, 0, 5), item(262149, 0, 6),
      item(262150, 0, 7), item(262144, 1, 8, { 'QuestRequired[0]': '65000' }), item(262144, 2, 9, { AchievementRequired: '12' }), item(262150, 1, 1)],
    ENpcBase: [{ '#': '1000001', 'ENpcData[0]': '262144', 'ENpcData[1]': '3276800', 'ENpcData[2]': '3538944' },
      { '#': '1000002', 'ENpcData[0]': '720896', 'ENpcData[1]': '262150', 'ENpcData[2]': '5' }],
    TopicSelect: [topic(3276800, [262145])],
    PreHandler: [{ '#': '3538944', Target: '262146', UnlockQuest: '66000' }],
    CustomTalk: [{ '#': '720896', 'Script[0].ScriptArg': '262147', 'Script[1].ScriptArg': '262144999' }],
    CustomTalkNestHandlers: [{ '#': '720896.0', NestHandler: '262148' }],
  };
  const shops = reachableGilShops(t);
  assert.deepEqual([...shops.keys()].sort(), [262144, 262145, 262146, 262147, 262148, 262150], '262149: no NPC opens it');
  assert.deepEqual(shops.get(262146), { npcs: [1000001], open: false }, 'behind an unlock quest');
  assert.equal(shops.get(262144).open, true);
  const sold = gilVendorItems(t, shops);
  const g = (id) => sold.get(id) && sold.get(id).gated;
  assert.deepEqual([1, 2, 3, 4, 5, 7, 8, 9].map(g), [false, false, true, false, false, true, true, true]);
  assert.equal(sold.has(6), false);
  assert.deepEqual(sold.get(1).shops, [262144, 262150], 'open in one shop, seasonal in another: open');
});

// ---- timed gathering ----
test('timed nodes: 189 ingredients on 147 of the supported nodes, each on the node js/gathering-data.js names, none missed', () => {
  const nodes = new Map(G.nodes.map((n) => [n.id, n]));
  const pairs = CAT.timedItems().flatMap((id) => CAT.timedNodes(id).map((b) => [id, b]));
  assert.deepEqual([CAT.timedItems().length, pairs.length, new Set(pairs.map(([, b]) => b)).size], [189, 214, 147]);
  for (const [id, b] of pairs) {
    assert.ok(nodes.has(b), `node ${b}`);
    assert.ok(nodes.get(b).items.some((i) => i.name === name(id)), `${name(id)} on node ${b}`);
  }
  const ingredientByName = new Map(); for (const r of RECIPES) for (const [i] of r.ings) if (name(i)) ingredientByName.set(name(i), i);
  for (const n of G.nodes) for (const it of n.items) {
    const id = ingredientByName.get(it.name);
    if (id) assert.ok(CAT.timedNodes(id).includes(n.id), `${it.name} on node ${n.id} is an ingredient but not mapped`);
  }
  assert.deepEqual(CAT.timedNodes(5106), [], 'Copper Ore is on no supported timed node');
  assert.ok(Object.isFrozen(CAT.timedNodes(CAT.timedItems()[0])));
});

test('timed nodes reuse the gathering engine: a mapped node\'s next window comes from js/gathering.js as the timers show it', () => {
  const id = CAT.timedItems()[0], node = G.nodes.find((n) => n.id === CAT.timedNodes(id)[0]);
  const t = Date.UTC(2026, 10, 18, 12, 0, 0);
  const up = GE.upcoming(node, t, 2);
  assert.ok(Array.isArray(up) && up.length === 2 && up[0].start <= up[1].start, JSON.stringify(up));
  assert.deepEqual(GE.upcoming(node, t, 2), up);
});

// ---- house rules ----
test('no dash characters (U+2013 to U+2015) in the new files', () => {
  for (const f of ['js/recipes.js', 'js/craft-calc.js', 'tools/build-recipes.mjs', 'tools/verify-recipes.mjs', 'tools/lib/shops.mjs',
    'tools/lib/compare-recipes.mjs', 'tools/lib/gamedata.mjs', 'tests/crafting.mjs', 'tests/fixtures/xivapi-recipes.json', 'data/recipes.lock.json']) {
    assert.doesNotMatch(readFileSync(join(ROOT, f), 'utf8'), DASH, f);
  }
});

await Promise.all(pending);
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
