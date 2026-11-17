// Generates js/market-items.js and its lock file data/market-items.lock.json from the pinned game
// tables (see tools/lib/gamedata.mjs). Nothing is crawled: the list is the game's own.
//
//   node tools/build-market.mjs              download (once, into tools/.cache) and build
//   node tools/build-market.mjs --csv DIR    read Item.csv etc. from DIR instead
//   node tools/build-market.mjs --check      fail if either file is not what this builds
//
// An item can be sold on the market board when it has an ItemSearchCategory (the board's own
// categories); the game gives every such item a name and none of them is untradable. Universalis
// lists the same 16,845 ids for 7.58 (tests/fixtures/universalis-marketable.json).
//
// Data centers are the game's logical data centers (World.LogicalDataCenter, not the older
// physical World.DataCenter) in the four global regions, with their public worlds. A data center
// with no public world (Shadow in 7.58) and the cloud test data center are left out.
//
// The output is deterministic: the same tables always give the same bytes, and the lock file
// records the source commit, every sheet's SHA-256, the counts and the output's own SHA-256.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DATASET, MARKET_SHEETS, ROOT, loadTables, plainText } from './lib/gamedata.mjs';

export const OUT = join('js', 'market-items.js');
export const LOCK = join('data', 'market-items.lock.json');
export const FORMAT = 1;

// The board groups its categories in four tabs. The tables number the groups but do not name them,
// so these labels are this page's own words.
export const GROUPS = [
  { id: 1, name: 'Arms and tools' },
  { id: 2, name: 'Armor and accessories' },
  { id: 3, name: 'Items' },
  { id: 4, name: 'Housing' },
];

// WorldDCGroupType.Region numbers the regions without naming them. scope is the region's name in
// Universalis requests; key and name match XivResets.DATA_CENTERS (js/resets.js), so a data center
// chosen in Resets is the same one here. Listed in the order the Resets picker uses.
export const REGIONS = [
  { game: 2, key: 'north-america', name: 'North America', scope: 'North-America' },
  { game: 3, key: 'europe', name: 'Europe', scope: 'Europe' },
  { game: 4, key: 'oceania', name: 'Oceania', scope: 'Oceania' },
  { game: 1, key: 'japan', name: 'Japan', scope: 'Japan' },
];

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

export function buildMarketData(tables) {
  const categories = tables.ItemSearchCategory
    .filter((r) => Number(r['#']) > 0 && r.Name && GROUPS.some((g) => g.id === Number(r.Category)))
    .map((r) => ({ id: Number(r['#']), name: r.Name, group: Number(r.Category), order: Number(r.Order) }));
  const categoryIds = new Set(categories.map((c) => c.id));

  const items = [];
  for (const r of tables.Item) {
    const category = Number(r.ItemSearchCategory);
    if (!(category > 0)) continue;
    const id = Number(r['#']);
    // Four 7.58 names end in a space in the game text; shown and searched without it.
    const name = plainText(r.Name).trim();
    if (!name) throw new Error(`item ${id} is on the board but has no name`);
    if (r.IsUntradable === 'True') throw new Error(`item ${id} ${name} is on the board but untradable`);
    if (!categoryIds.has(category)) throw new Error(`item ${id} ${name}: category ${category} is not a board category`);
    if (/[\t\n\r]/.test(name)) throw new Error(`item ${id}: a tab or line break in its name`);
    const level = Number(r.LevelItem);
    if (!Number.isInteger(level) || level < 1) throw new Error(`item ${id} ${name}: item level ${r.LevelItem}`);
    items.push({ id, category, level, hq: r.CanBeHq === 'True', name });
  }
  items.sort((a, b) => a.id - b.id);

  // Only categories that hold an item, in the board's own order.
  const used = new Set(items.map((i) => i.category));
  const shown = categories.filter((c) => used.has(c.id)).sort((a, b) => a.group - b.group || a.order - b.order || a.id - b.id);

  const groupType = new Map(tables.WorldDCGroupType.map((r) => [Number(r['#']), r]));
  const dataCenters = [];
  for (const region of REGIONS) {
    const dcs = [];
    for (const [id, g] of groupType) {
      if (Number(g.Region) !== region.game || g.IsCloud === 'True' || !g.Name) continue;
      const worlds = tables.World
        .filter((w) => w.IsPublic === 'True' && Number(w.LogicalDataCenter) === id)
        .map((w) => ({ id: Number(w['#']), name: w.Name }))
        .sort(byName);
      if (!worlds.length) continue;
      dcs.push({ key: g.Name.toLowerCase(), name: g.Name, region: region.key, worlds });
    }
    dataCenters.push(...dcs.sort(byName));
  }
  const worldIds = dataCenters.flatMap((d) => d.worlds.map((w) => w.id));
  if (new Set(worldIds).size !== worldIds.length) throw new Error('a world is listed under two data centers');

  return {
    source: { dataset: DATASET.repo, commit: DATASET.commit, patch: DATASET.patch, language: DATASET.language },
    count: items.length,
    groups: GROUPS,
    categories: shown,
    regions: REGIONS.map(({ key, name, scope }) => ({ key, name, scope })),
    dataCenters,
    items,
  };
}

// One line per item keeps the file small and fast to parse, sorted by id: the id's step from the
// line before (from 0 for the first line), category, item level, 1 when the item can be high
// quality (else 0), name; tab-separated. Steps instead of ids save 23 % gzipped (169 KB to 131 KB).
export function itemLines(items) {
  let prev = 0;
  return items.map((i) => { const step = i.id - prev; prev = i.id; return `${step}\t${i.category}\t${i.level}\t${i.hq ? 1 : 0}\t${i.name}`; }).join('\n');
}
// The reverse, as the page will read it.
export function decodeItems(text) {
  let id = 0;
  return text.split('\n').map((line) => {
    const [step, category, level, hq, name] = line.split('\t');
    id += Number(step);
    return { id, category: Number(category), level: Number(level), hq: hq === '1', name };
  });
}

export function renderModule(data) {
  const lines = [
    '// Generated by tools/build-market.mjs from the game\'s Item, ItemSearchCategory, World and',
    `// WorldDCGroupType tables (${data.source.dataset} @ ${data.source.commit.slice(0, 10)}, patch ${data.source.patch}).`,
    '// Do not edit by hand. Loaded on the first visit to Market & Crafting, never with the timers.',
    '// items: one line per item on the market board, sorted by id:',
    '//   step TAB category TAB item level TAB 1 if it can be high quality, else 0 TAB name',
    '// where step is the id minus the id on the line before (the first line counts from 0).',
    '(function (root) {',
    '  \'use strict\';',
    '  const data = {',
    `    format: ${FORMAT},`,
    `    source: ${JSON.stringify(data.source)},`,
    `    count: ${data.count},`,
    `    groups: ${JSON.stringify(data.groups)},`,
    '    categories: [',
    ...data.categories.map((c) => `      ${JSON.stringify(c)},`),
    '    ],',
    `    regions: ${JSON.stringify(data.regions)},`,
    '    dataCenters: [',
    ...data.dataCenters.map((d) => `      ${JSON.stringify(d)},`),
    '    ],',
    `    items: ${JSON.stringify(itemLines(data.items))},`,
    '  };',
    '  if (typeof module === \'object\' && module.exports) module.exports = data;',
    '  else root.FFXIV_MARKET_ITEMS = data;',
    '})(typeof globalThis !== \'undefined\' ? globalThis : this);',
    '',
  ];
  return lines.join('\n');
}

export function renderLock(data, text) {
  const bytes = Buffer.byteLength(text, 'utf8');
  const lock = {
    format: FORMAT,
    file: 'js/market-items.js',
    source: data.source,
    sheets: Object.fromEntries(MARKET_SHEETS.map((s) => [s, DATASET.sha256[s]])),
    count: data.count,
    categories: data.categories.length,
    dataCenters: data.dataCenters.length,
    worlds: data.dataCenters.reduce((n, d) => n + d.worlds.length, 0),
    bytes,
    sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
  };
  return `${JSON.stringify(lock, null, 2)}\n`;
}

async function main() {
  const args = process.argv.slice(2);
  const csvDir = args.includes('--csv') ? args[args.indexOf('--csv') + 1] : undefined;
  const data = buildMarketData(await loadTables(csvDir, MARKET_SHEETS));
  const text = renderModule(data);
  const lock = renderLock(data, text);
  if (args.includes('--check')) {
    let stale = false;
    for (const [rel, want] of [[OUT, text], [LOCK, lock]]) {
      let have = null;
      try { have = readFileSync(join(ROOT, rel), 'utf8'); } catch (e) { /* missing */ }
      if (have !== want) { console.error(`${rel} is out of date; run node tools/build-market.mjs`); stale = true; }
    }
    if (stale) process.exit(1);
    console.log(`${OUT} and ${LOCK} match the pinned game data`);
    return;
  }
  writeFileSync(join(ROOT, OUT), text);
  writeFileSync(join(ROOT, LOCK), lock);
  console.log(`wrote ${OUT} (${data.count} items, ${data.categories.length} categories, ${data.dataCenters.length} data centers; patch ${DATASET.patch}) and ${LOCK}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
