// Generates the recipe catalog js/recipes.js and its lock file data/recipes.lock.json from the pinned game tables
// (tools/lib/gamedata.mjs, RECIPE_SHEETS) and the supported timed nodes (data/supported-nodes.json). Nothing is
// crawled and no other tool's data is used.
//
//   node tools/build-recipes.mjs              download (once, into tools/.cache) and build
//   node tools/build-recipes.mjs --csv DIR    read the CSVs from DIR instead
//   node tools/build-recipes.mjs --check      fail if either file is not what this builds
//
// What is in it: every recipe whose result can be sold on the market board (the same rule as
// tools/build-market.mjs: the item has an ItemSearchCategory), with every recipe for such an item, including the
// same item on other jobs. Names of market items are not repeated: js/market-items.js has them. The few
// ingredients that are not on the board are listed with their names. Also: the jobs, recipe levels and master
// recipe books those recipes use; which ingredients an NPC sells for gil (tools/lib/shops.mjs), with the
// price the game lists for them kept apart and marked unverified; and which ingredients the supported timed
// nodes give, by node id (the GatheringPointBase id that js/gathering-data.js and data/supported-nodes.json use).
//
// The build fails on anything the page could not handle: an unknown job, level or book, an ingredient slot with
// an id but no amount, an ingredient the Item table does not have, a recipe that needs a quest, an item or a
// status (none does in 7.58 for a market result), or a cycle among the recipes.
//
// The output is deterministic: the same tables always give the same bytes.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DATASET, RECIPE_SHEETS, ROOT, loadTables, plainText } from './lib/gamedata.mjs';
import { gilVendorItems } from './lib/shops.mjs';

export const OUT = join('js', 'recipes.js');
export const LOCK = join('data', 'recipes.lock.json');
export const NODES = join('data', 'supported-nodes.json');
export const FORMAT = 1;
// Recipe flags, one bit each (the line's flags field).
export const FLAG = { canHq: 1, quickSynth: 2, expert: 4, specialist: 8 };
// Most recipes let high-quality materials count for half the starting quality; that value is left blank.
export const MQF_DEFAULT = 50;
// Separators inside the recipe and vendor strings.
export const SEP = { field: ' ', record: ';' };
// Disciples of the Hand in ClassJob; their DohDolJobIndex is Recipe.CraftType.
const DOH_CATEGORY = 33;

const num = (v) => Number(v) || 0;

export function buildRecipeData(t, supportedBases) {
  const items = new Map(t.Item.map((r) => [num(r['#']), r]));
  const nameOf = (id) => plainText(items.get(id)?.Name || '').trim();
  const marketable = (id) => num(items.get(id)?.ItemSearchCategory) > 0;

  const jobs = t.ClassJob.filter((r) => num(r.ClassJobCategory) === DOH_CATEGORY)
    .map((r) => ({ index: num(r.DohDolJobIndex), abbr: r.Abbreviation, name: r.NameEnglish }))
    .sort((a, b) => a.index - b.index);
  if (jobs.length !== 8 || jobs.some((j, i) => j.index !== i || !j.abbr || !j.name)) throw new Error(`crafting jobs: ${JSON.stringify(jobs)}`);
  const levelTable = new Map(t.RecipeLevelTable.map((r) => [num(r['#']), r]));
  const bookTable = new Map(t.SecretRecipeBook.map((r) => [num(r['#']), r]));

  const recipes = [];
  for (const r of t.Recipe) {
    const result = num(r.ItemResult);
    if (result <= 0 || !marketable(result)) continue;
    const id = num(r['#']), where = `recipe ${id} (${nameOf(result)})`;
    const job = num(r.CraftType);
    if (!Number.isInteger(job) || job < 0 || job >= jobs.length) throw new Error(`${where}: craft type ${r.CraftType}`);
    const amountResult = num(r.AmountResult);
    if (!Number.isInteger(amountResult) || amountResult < 1) throw new Error(`${where}: makes ${r.AmountResult}`);
    const rlvl = num(r.RecipeLevelTable);
    if (!levelTable.has(rlvl) || num(levelTable.get(rlvl).ClassJobLevel) < 1) throw new Error(`${where}: recipe level ${rlvl}`);
    const book = num(r.SecretRecipeBook);
    if (book && !(bookTable.get(book)?.Name)) throw new Error(`${where}: master book ${book} has no name`);
    if (num(r.Quest) || num(r.ItemRequired) || num(r.StatusRequired)) throw new Error(`${where}: needs a quest, item or status, which the catalog does not describe`);
    const ings = [];
    for (let i = 0; i < 8; i++) {
      const ing = num(r[`Ingredient[${i}]`]), amount = num(r[`AmountIngredient[${i}]`]);
      if (ing > 0 && amount > 0) {
        if (!nameOf(ing)) throw new Error(`${where}: ingredient ${ing} is not a named item`);
        if (ings.some((x) => x[0] === ing)) throw new Error(`${where}: ingredient ${ing} twice`);
        ings.push([ing, amount]);
      } else if (ing > 0 || amount > 0) throw new Error(`${where}: slot ${i} has item ${ing} and amount ${amount}`);
    }
    if (!ings.length) throw new Error(`${where}: no ingredients`);
    const flags = (r.CanHq === 'True' ? FLAG.canHq : 0) | (r.CanQuickSynth === 'True' ? FLAG.quickSynth : 0)
      | (r.IsExpert === 'True' ? FLAG.expert : 0) | (r.IsSpecializationRequired === 'True' ? FLAG.specialist : 0);
    recipes.push({ id, result, job, yield: amountResult, rlvl, flags, book, mqf: num(r.MaterialQualityFactor),
      craftsmanship: num(r.RequiredCraftsmanship), control: num(r.RequiredControl), ings });
  }
  recipes.sort((a, b) => a.id - b.id);

  const byResult = new Map();
  for (const r of recipes) { if (!byResult.has(r.result)) byResult.set(r.result, []); byResult.get(r.result).push(r); }
  const ingredientIds = new Set(recipes.flatMap((r) => r.ings.map(([i]) => i)));

  const levels = [...new Set(recipes.map((r) => r.rlvl))].sort((a, b) => a - b)
    .map((rl) => [rl, num(levelTable.get(rl).ClassJobLevel), num(levelTable.get(rl).Stars)]);
  const books = [...new Set(recipes.map((r) => r.book).filter(Boolean))].sort((a, b) => a - b)
    .map((b) => [b, plainText(bookTable.get(b).Name).trim()]);
  const extra = [...ingredientIds].filter((id) => !marketable(id)).sort((a, b) => a - b)
    .map((id) => [id, nameOf(id), items.get(id).CanBeHq === 'True' ? 1 : 0, items.get(id).IsUntradable === 'True' ? 1 : 0]);

  // Vendors, for ingredients (where a vendor changes whether to buy or craft): availability from the shop
  // tables; the listed price is the game's Item.PriceMid, unverified.
  const sold = gilVendorItems(t);
  const vendors = [...ingredientIds].filter((id) => sold.has(id)).sort((a, b) => a - b).map((id) => {
    const v = sold.get(id), price = num(items.get(id).PriceMid);
    if (price <= 0) throw new Error(`item ${id} ${nameOf(id)} is sold for gil but has no listed price`);
    return { id, gated: v.gated, hq: v.hq, price };
  });

  // Timed nodes: which supported node (GatheringPointBase id) gives each ingredient.
  const supported = new Set(supportedBases);
  const gItem = new Map(t.GatheringItem.map((r) => [num(r['#']), num(r.Item)]));
  const timedMap = new Map();
  for (const b of t.GatheringPointBase) {
    const base = num(b['#']);
    if (!supported.has(base)) continue;
    for (let i = 0; i < 8; i++) {
      const it = gItem.get(num(b[`Item[${i}]`]));
      if (!(it > 0) || !ingredientIds.has(it)) continue;
      if (!timedMap.has(it)) timedMap.set(it, new Set());
      timedMap.get(it).add(base);
    }
  }
  const timed = [...timedMap].sort((a, b) => a[0] - b[0]).map(([id, bases]) => [id, [...bases].sort((a, b) => a - b)]);

  return {
    source: { dataset: DATASET.repo, commit: DATASET.commit, patch: DATASET.patch, language: DATASET.language },
    jobs: jobs.map(({ abbr, name }) => ({ abbr, name })),
    levels, books, extra, recipes, vendors, timed,
    stats: graphStats(byResult, marketable),
  };
}

// Facts about the recipe graph, from every recipe for every item (so an upper bound for any choice of recipes):
// whether it has a cycle, the longest chain of crafts (the item itself counts as one), the most market items in
// one fully expanded tree (the item included: what pricing it would take), and the most craftable items under one
// item (each a craft-or-buy choice).
export function graphStats(byResult, marketable) {
  const kids = (id) => [...new Set((byResult.get(id) || []).flatMap((r) => r.ings.map(([i]) => i)))];
  const state = new Map(); // 1 = on the current path, 2 = done
  const depth = new Map();
  function visit(id, path) {
    if (state.get(id) === 2) return depth.get(id);
    if (state.get(id) === 1) throw new Error(`recipe cycle: ${[...path, id].join(' -> ')}`);
    if (!byResult.has(id)) { state.set(id, 2); depth.set(id, 0); return 0; }
    state.set(id, 1); path.push(id);
    let d = 0;
    for (const k of kids(id)) d = Math.max(d, visit(k, path));
    path.pop(); state.set(id, 2); depth.set(id, d + 1);
    return d + 1;
  }
  let maxDepth = 0, maxMarketIds = 0, maxCraftSteps = 0;
  for (const id of [...byResult.keys()].sort((a, b) => a - b)) {
    maxDepth = Math.max(maxDepth, visit(id, []));
    const seen = new Set([id]), stack = [id];
    while (stack.length) for (const k of kids(stack.pop())) if (!seen.has(k)) { seen.add(k); stack.push(k); }
    maxMarketIds = Math.max(maxMarketIds, [...seen].filter(marketable).length);
    maxCraftSteps = Math.max(maxCraftSteps, [...seen].filter((k) => k !== id && byResult.has(k)).length);
  }
  return { cycles: 0, maxDepth, maxMarketIds, maxCraftSteps };
}

// One record per recipe, sorted by recipe id (recipes of one job and patch sit together, so the steps stay
// small). Fields are separated by a space and records by a semicolon, characters a JSON string carries as they
// are (tabs and line breaks would each cost an escape: 2.4 KB gzipped). The fields:
//   id step, result step, job, yield, recipe level, flags, master book, HQ material factor, craftsmanship,
//   control, ingredients
// id step and result step: the recipe id and result item id minus those on the line before (from 0; the result
// step may be negative). Blank fields: yield 1, no master book, the factor MQF_DEFAULT, no craftsmanship or
// control needed. Ingredients: comma-separated `item` or `item*amount` (amount 1 when there is no *), in the
// game's slot order (crystals last).
export function recipeLines(recipes) {
  let rid = 0, res = 0;
  return recipes.map((r) => {
    const line = [r.id - rid, r.result - res, r.job, r.yield === 1 ? '' : r.yield, r.rlvl, r.flags, r.book || '',
      r.mqf === MQF_DEFAULT ? '' : r.mqf, r.craftsmanship || '', r.control || '',
      r.ings.map(([i, n]) => (n === 1 ? `${i}` : `${i}*${n}`)).join(',')].join(SEP.field);
    rid = r.id; res = r.result;
    return line;
  }).join(SEP.record);
}

// The reverse, as a test reads it (the page's reader is js/craft-calc.js).
export function decodeRecipes(text) {
  let rid = 0, res = 0;
  return text.split(SEP.record).map((line) => {
    const f = line.split(SEP.field);
    rid += Number(f[0]); res += Number(f[1]);
    return { id: rid, result: res, job: Number(f[2]), yield: f[3] ? Number(f[3]) : 1, rlvl: Number(f[4]), flags: Number(f[5]),
      book: f[6] ? Number(f[6]) : 0, mqf: f[7] ? Number(f[7]) : MQF_DEFAULT, craftsmanship: f[8] ? Number(f[8]) : 0,
      control: f[9] ? Number(f[9]) : 0, ings: f[10].split(',').map((x) => { const [i, n] = x.split('*'); return [Number(i), n ? Number(n) : 1]; }) };
  });
}

// Vendor items as `id step, flags` records (flags 1: every row is behind a quest, an achievement or a seasonal
// event; 2: a row sells it high quality), and their listed prices, unverified, in the same order.
export function vendorLines(vendors) {
  let prev = 0;
  return vendors.map((v) => { const s = v.id - prev; prev = v.id; return `${s}${SEP.field}${(v.gated ? 1 : 0) | (v.hq ? 2 : 0)}`; }).join(SEP.record);
}

export function renderModule(data) {
  const lines = [
    '// Generated by tools/build-recipes.mjs from the game\'s Recipe, RecipeLevelTable, SecretRecipeBook, ClassJob,',
    '// Item, shop (GilShop, GilShopItem, ENpcBase and the menus between) and gathering tables',
    `// (${data.source.dataset} @ ${data.source.commit.slice(0, 10)}, patch ${data.source.patch}) and data/supported-nodes.json.`,
    '// Do not edit by hand. Loaded only when Crafting first opens, never with the timers. js/craft-calc.js reads it.',
    '// recipes: one line per recipe whose result is on the market board, sorted by recipe id:',
    '//   id step, result step, job, yield, recipe level, flags, master book, HQ material factor, craftsmanship,',
    '//   control, ingredients (fields split by a space, records by a semicolon; tools/build-recipes.mjs',
    '//   recipeLines() says what each field means).',
    '// Item names are in js/market-items.js; extra holds the few ingredients that are not on the board.',
    '// vendorPricesUnverified: Item.PriceMid for each vendor item, in vendor order. The game lists it; nothing in',
    '// its tables confirms that the vendor charges it.',
    '(function (root) {',
    '  \'use strict\';',
    '  const data = {',
    `    format: ${FORMAT},`,
    `    source: ${JSON.stringify(data.source)},`,
    `    count: ${data.recipes.length},`,
    `    flags: ${JSON.stringify(FLAG)},`,
    `    mqfDefault: ${MQF_DEFAULT},`,
    `    sep: ${JSON.stringify(SEP)},`,
    `    jobs: ${JSON.stringify(data.jobs)},`,
    `    levels: ${JSON.stringify(data.levels)},`,
    `    books: ${JSON.stringify(data.books)},`,
    `    extra: ${JSON.stringify(data.extra)},`,
    `    timed: ${JSON.stringify(data.timed)},`,
    `    vendors: ${JSON.stringify(vendorLines(data.vendors))},`,
    `    vendorPricesUnverified: ${JSON.stringify(data.vendors.map((v) => v.price).join(','))},`,
    `    recipes: ${JSON.stringify(recipeLines(data.recipes))},`,
    '  };',
    '  if (typeof module === \'object\' && module.exports) module.exports = data;',
    '  else root.FFXIV_RECIPES = data;',
    '})(typeof globalThis !== \'undefined\' ? globalThis : this);',
    '',
  ];
  return lines.join('\n');
}

export function renderLock(data, text, nodesText) {
  const outputs = new Set(data.recipes.map((r) => r.result));
  const perItem = new Map(); for (const r of data.recipes) perItem.set(r.result, (perItem.get(r.result) || 0) + 1);
  const lock = {
    format: FORMAT,
    file: 'js/recipes.js',
    source: data.source,
    sheets: Object.fromEntries(RECIPE_SHEETS.map((s) => [s, DATASET.sha256[s]])),
    supportedNodes: createHash('sha256').update(nodesText, 'utf8').digest('hex'),
    recipes: data.recipes.length,
    outputs: outputs.size,
    outputsWithSeveralRecipes: [...perItem.values()].filter((n) => n > 1).length,
    ingredients: new Set(data.recipes.flatMap((r) => r.ings.map(([i]) => i))).size,
    notOnTheBoard: data.extra.length,
    vendorItems: data.vendors.length,
    vendorItemsGated: data.vendors.filter((v) => v.gated).length,
    timedItems: data.timed.length,
    books: data.books.length,
    levels: data.levels.length,
    graph: data.stats,
    bytes: Buffer.byteLength(text, 'utf8'),
    sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
  };
  return `${JSON.stringify(lock, null, 2)}\n`;
}

async function main() {
  const args = process.argv.slice(2);
  const csvDir = args.includes('--csv') ? args[args.indexOf('--csv') + 1] : undefined;
  const nodesText = readFileSync(join(ROOT, NODES), 'utf8');
  const bases = JSON.parse(nodesText).nodes.map((n) => n.base);
  const data = buildRecipeData(await loadTables(csvDir, RECIPE_SHEETS), bases);
  const text = renderModule(data);
  const outputs = [[OUT, text], [LOCK, renderLock(data, text, nodesText)]];
  if (args.includes('--check')) {
    let stale = false;
    for (const [rel, want] of outputs) {
      let have = null;
      try { have = readFileSync(join(ROOT, rel), 'utf8'); } catch (e) { /* missing */ }
      if (have !== want) { console.error(`${rel} is out of date; run node tools/build-recipes.mjs`); stale = true; }
    }
    if (stale) process.exit(1);
    console.log(`${outputs.map(([rel]) => rel).join(', ')} match the pinned game data`);
    return;
  }
  for (const [rel, body] of outputs) writeFileSync(join(ROOT, rel), body);
  console.log(`wrote ${OUT} (${data.recipes.length} recipes, patch ${DATASET.patch}) and ${LOCK}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
