// Checks js/gathering-data.js against two independent records of the same nodes:
//   XIVAPI v2  a second extraction of the game tables (its own reader and schema)
//   the wiki   ffxiv.consolegameswiki.com "Unspoiled Nodes" and "Folklore Nodes", which players
//              maintain from what they see in game (pinned revisions)
//
//   node tools/verify-gathering.mjs                   compare (needs network)
//   node tools/verify-gathering.mjs --write-fixtures  also save both captures to tests/fixtures/
//
// The fixtures let `node tests/run.mjs` repeat the comparison offline.
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { hhmmToMinutes } from './build-gathering.mjs';
import { ROOT } from './lib/gamedata.mjs';
import { WIKI_EXCEPTIONS, compareGatheringWiki, compareGatheringXivapi } from './lib/compare-gathering.mjs';
import { parseWikiTables } from './lib/wiki-gathering.mjs';

const XIVAPI = 'https://v2.xivapi.com/api', XIVAPI_VERSION = '7.57x1';
const WIKI = 'https://ffxiv.consolegameswiki.com/mediawiki';
// Revisions read on 2026-10-23. Pages are only read at these revisions, so a later wiki edit
// cannot change a result without this list changing.
const WIKI_PAGES = { 'Unspoiled Nodes': 1490944, 'Folklore Nodes': 1491386 };
const KINDS = { 2: 'unspoiled', 5: 'legendary' };
const data = createRequire(import.meta.url)('../js/gathering-data.js');

// Retries both HTTP errors and dropped connections, backing off a little more each time.
async function get(url, as = 'json') {
  for (let attempt = 1; ; attempt++) {
    let failure;
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'ffxiv-timer data check (github.com/RadMageIRL/ffxiv-timer)' } });
      if (res.ok) return as === 'json' ? await res.json() : await res.text();
      failure = `HTTP ${res.status}`;
    } catch (e) {
      failure = e.cause?.code || e.message;
    }
    if (attempt === 5) throw new Error(`${url}: ${failure}`);
    await new Promise((r) => setTimeout(r, 1500 * attempt));
  }
}
const xivapi = (path, fields) => get(`${XIVAPI}/${path}${path.includes('?') ? '&' : '?'}version=${XIVAPI_VERSION}&fields=${encodeURIComponent(fields)}`);

async function captureXivapi() {
  const nodes = [];
  for (const n of data.nodes) {
    const found = await xivapi(`search?sheets=GatheringPoint&query=GatheringPointBase%3D${n.id}`, 'Type,PlaceName.Name,TerritoryType.PlaceName.Name,GatheringSubCategory.Item.Name');
    const p = found.results[0].fields;
    const tr = await xivapi(`sheet/GatheringPointTransient/${found.results[0].row_id}`, 'GatheringRarePopTimeTable.StartTime,GatheringRarePopTimeTable.Duration');
    const pop = tr.fields.GatheringRarePopTimeTable.fields;
    const times = pop.StartTime.map((s, i) => [s, pop.Duration[i]]).filter(([s]) => s !== 65535).map(([s, d]) => [hhmmToMinutes(s), hhmmToMinutes(d)]);
    const base = await xivapi(`sheet/GatheringPointBase/${n.id}`, 'GatheringLevel,GatheringType.Name,Item[].Item,Item[].GatheringItemLevel.GatheringItemLevel,Item[].GatheringItemLevel.Stars,Item[].IsHidden');
    const items = [];
    for (const gi of base.fields.Item) {
      if (!gi.value || gi.sheet !== 'GatheringItem') continue;
      const it = await xivapi(`sheet/Item/${gi.fields.Item.value}`, 'Name,IsCollectable');
      items.push({ name: it.fields.Name, level: gi.fields.GatheringItemLevel.fields.GatheringItemLevel, stars: gi.fields.GatheringItemLevel.fields.Stars, collectable: it.fields.IsCollectable, hidden: gi.fields.IsHidden });
    }
    const tome = p.GatheringSubCategory.fields?.Item?.fields?.Name;
    nodes.push({
      id: n.id, points: found.results.length, kind: KINDS[p.Type] || `type ${p.Type}`, zone: p.TerritoryType.fields.PlaceName.fields.Name,
      area: p.PlaceName.fields.Name, gathering: base.fields.GatheringType.fields.Name, level: base.fields.GatheringLevel,
      folklore: tome || null, times, items,
    });
  }
  return { source: 'v2.xivapi.com', version: XIVAPI_VERSION, schema: (await xivapi('sheet/GatheringType/0', 'Name')).schema, nodes };
}

// Only the sections for expansions that have supported nodes are read.
async function captureWiki() {
  const rows = [], expansions = [...new Set(data.nodes.map((n) => n.expansion))];
  for (const [page, revision] of Object.entries(WIKI_PAGES)) {
    // Through the MediaWiki API, the wiki's route for programs.
    const res = await get(`${WIKI}/api.php?action=query&prop=revisions&revids=${revision}&rvprop=content&rvslots=main&format=json&formatversion=2`);
    const raw = res.query.pages[0].revisions[0].slots.main.content;
    rows.push(...parseWikiTables(page, raw, expansions));
  }
  return { source: 'ffxiv.consolegameswiki.com', revisions: WIKI_PAGES, expansions, rows };
}

const line = (v) => `  ${JSON.stringify(v)}`;
function writeFixture(name, head, list, key) {
  writeFileSync(join(ROOT, 'tests', 'fixtures', name), `${JSON.stringify(head).slice(0, -1)},"${key}":[\n${list.map(line).join(',\n')}\n]}\n`);
  console.log(`wrote tests/fixtures/${name}`);
}

const [x, w] = [await captureXivapi(), await captureWiki()];
const problems = [...compareGatheringXivapi(x, data), ...compareGatheringWiki(w, data, { exceptions: WIKI_EXCEPTIONS })];
if (process.argv.includes('--write-fixtures')) {
  const { nodes, ...xh } = x, { rows, ...wh } = w;
  writeFixture('xivapi-gathering.json', xh, nodes, 'nodes');
  writeFixture('wiki-gathering.json', wh, rows, 'rows');
}
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
console.log(`${data.nodes.length} nodes agree with XIVAPI ${XIVAPI_VERSION} and ${w.rows.length} wiki rows`);
