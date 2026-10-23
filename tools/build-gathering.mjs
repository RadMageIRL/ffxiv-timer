// Generates js/gathering-data.js: timed gathering nodes (unspoiled and legendary) from the pinned
// game tables (see tools/lib/gamedata.mjs).
//
//   node tools/build-gathering.mjs              download (once, into tools/.cache) and build
//   node tools/build-gathering.mjs --csv DIR    read the CSVs from DIR instead
//   node tools/build-gathering.mjs --check      fail if js/gathering-data.js is not what this builds
//
// Supported nodes come from data/supported-nodes.json.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DATASET, GATHERING_SHEETS, ROOT, loadTables, plainText } from './lib/gamedata.mjs';

const { slug } = createRequire(import.meta.url)('../js/format.js');

// GatheringPoint.Type, as named by the game's own GatheringPointName rows (unspoiled mineral
// deposit, legendary mature tree, ...). Only the two timed kinds are built.
const KINDS = { 2: 'unspoiled', 5: 'legendary' };
// GatheringType 0..3 (Mining, Quarrying, Logging, Harvesting). The first two are Miner work, the
// other two Botanist (GatheringSubCategory pairs them with ClassJob 16 and 17).
const JOB = { 0: 'Miner', 1: 'Miner', 2: 'Botanist', 3: 'Botanist' };

// Start times are HHMM in Eorzea Time. Durations use the same HHMM form, minutes allowed to reach
// 60: 160 is one hour sixty minutes (two hours) and 300 is three hours, which is what players see
// (the wiki: 2 hours from Heavensward on, 3 hours for A Realm Reborn nodes).
export const hhmmToMinutes = (v) => Math.floor(v / 100) * 60 + (v % 100);

// Map coordinates as the game shows them, from a position in the exported layout.
export function mapCoordinate(raw, sizeFactor, offset) {
  const c = sizeFactor / 100;
  return (41 / c) * (((raw + offset) * c + 1024) / 2048) + 1;
}

export function buildGatheringData(t, supported, weatherZones = new Set()) {
  const index = (rows) => new Map(rows.map((r) => [r['#'], r]));
  const territory = index(t.TerritoryType), place = new Map(t.PlaceName.map((r) => [r['#'], plainText(r.Name)]));
  const expansion = new Map(t.ExVersion.map((r) => [r['#'], r.Name]));
  const base = index(t.GatheringPointBase), gItem = index(t.GatheringItem), item = index(t.Item);
  const transient = index(t.GatheringPointTransient), pop = index(t.GatheringRarePopTimeTable);
  const gType = new Map(t.GatheringType.map((r) => [r['#'], r.Name])), sub = index(t.GatheringSubCategory);
  const exported = index(t.ExportedGatheringPoint), map = index(t.Map), level = index(t.GatheringItemLevelConvertTable);
  const pointsOf = new Map();
  for (const p of t.GatheringPoint) (pointsOf.get(p.GatheringPointBase) || pointsOf.set(p.GatheringPointBase, []).get(p.GatheringPointBase)).push(p);

  const nodes = [];
  for (const { base: id } of supported.nodes) {
    const b = base.get(String(id));
    const points = pointsOf.get(String(id)) || [];
    if (!b || !points.length) throw new Error(`node ${id}: no GatheringPointBase or no GatheringPoint rows`);
    const first = points[0];
    const kind = KINDS[first.Type];
    if (!kind) throw new Error(`node ${id}: GatheringPoint.Type ${first.Type} is not a timed kind`);
    // Every spawn point of a node must agree on what makes it a node.
    const describe = (p) => {
      const tr = transient.get(p['#']);
      const table = tr && pop.get(tr.GatheringRarePopTimeTable);
      if (!table || tr.GatheringRarePopTimeTable === '0') throw new Error(`node ${id}: point ${p['#']} has no spawn times`);
      const times = [0, 1, 2].filter((i) => table[`StartTime[${i}]`] !== '65535')
        .map((i) => [hhmmToMinutes(Number(table[`StartTime[${i}]`])), hhmmToMinutes(Number(table[`Duration[${i}]`]))]);
      return JSON.stringify([p.Type, p.TerritoryType, p.PlaceName, p.GatheringSubCategory, times]);
    };
    const shapes = new Set(points.map(describe));
    if (shapes.size !== 1) throw new Error(`node ${id}: spawn points disagree: ${[...shapes].join(' | ')}`);
    const times = JSON.parse([...shapes][0])[4];

    const terr = territory.get(first.TerritoryType);
    const zone = place.get(terr.PlaceName);
    // TerritoryType 1 is a blank placeholder; a node with no named zone cannot be shown anywhere.
    if (!zone) throw new Error(`node ${id}: territory ${first.TerritoryType} has no place name`);
    const m = map.get(terr.Map), e = exported.get(String(id));
    if (!m || !e) throw new Error(`node ${id}: no map or exported position`);
    const coords = [mapCoordinate(Number(e.X), Number(m.SizeFactor), Number(m.OffsetX)), mapCoordinate(Number(e.Y), Number(m.SizeFactor), Number(m.OffsetY))]
      .map((v) => Math.round(v * 10) / 10);

    const items = [];
    for (let i = 0; i < 8; i++) {
      const g = gItem.get(b[`Item[${i}]`]);
      if (!g || b[`Item[${i}]`] === '0') continue;
      const it = item.get(g.Item), lv = level.get(g.GatheringItemLevel);
      if (!it || !it.Name) throw new Error(`node ${id}: gathering item ${g['#']} has no item name`);
      items.push({ name: it.Name, level: Number(lv.GatheringItemLevel), stars: Number(lv.Stars), collectable: it.IsCollectable === 'True', hidden: g.IsHidden === 'True' });
    }
    if (!items.length) throw new Error(`node ${id}: no items`);
    const sc = sub.get(first.GatheringSubCategory);
    const folklore = sc && sc.Item !== '0' ? item.get(sc.Item).Name : null;

    nodes.push({
      id, kind, job: JOB[b.GatheringType], gathering: gType.get(b.GatheringType), level: Number(b.GatheringLevel),
      zone, zoneKey: weatherZones.has(slug(zone)) ? slug(zone) : null, area: place.get(first.PlaceName) || '',
      expansion: expansion.get(terr.ExVersion), coords, radius: Number(e.Radius), times, folklore, items,
    });
  }
  return { source: { dataset: DATASET.repo, commit: DATASET.commit, patch: DATASET.patch, language: DATASET.language }, nodes };
}

export function renderModule(data) {
  return [
    '// Generated by tools/build-gathering.mjs from the game\'s GatheringPoint, GatheringPointBase,',
    '// GatheringItem, GatheringPointTransient, GatheringRarePopTimeTable and related tables',
    `// (${data.source.dataset} @ ${data.source.commit.slice(0, 10)}, patch ${data.source.patch}). Do not edit by hand;`,
    '// change data/supported-nodes.json and rebuild.',
    '// times: [start, duration] in Eorzean minutes from ET midnight. coords: map coordinates.',
    '(function (root) {',
    '  \'use strict\';',
    '  const data = {',
    `    source: ${JSON.stringify(data.source)},`,
    '    nodes: [',
    ...data.nodes.map((n) => `      ${JSON.stringify(n)},`),
    '    ],',
    '  };',
    '  if (typeof module === \'object\' && module.exports) module.exports = data;',
    '  else root.FFXIV_GATHERING_DATA = data;',
    '})(typeof globalThis !== \'undefined\' ? globalThis : this);',
    '',
  ].join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const csvDir = args.includes('--csv') ? args[args.indexOf('--csv') + 1] : undefined;
  const supported = JSON.parse(readFileSync(join(ROOT, 'data', 'supported-nodes.json'), 'utf8'));
  const weather = createRequire(import.meta.url)('../js/weather-data.js');
  const text = renderModule(buildGatheringData(await loadTables(csvDir, GATHERING_SHEETS), supported, new Set(weather.zones.map((z) => z.key))));
  const out = join(ROOT, 'js', 'gathering-data.js');
  if (args.includes('--check')) {
    if (readFileSync(out, 'utf8') !== text) { console.error('js/gathering-data.js is out of date; run node tools/build-gathering.mjs'); process.exit(1); }
    console.log('js/gathering-data.js matches the pinned game data');
    return;
  }
  writeFileSync(out, text);
  console.log(`wrote js/gathering-data.js (${supported.nodes.length} nodes, patch ${DATASET.patch})`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
