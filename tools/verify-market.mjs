// Checks js/market-items.js against a second, independent extraction of the game data: XIVAPI v2
// (v2.xivapi.com), which reads the game files with its own code and schema. A fixed sample of
// items (every 400th by id, the names the game stores with a trailing space, and every name with
// characters outside ASCII) must agree on name, search category, item level and HQ.
//
//   node tools/verify-market.mjs                  compare (needs network)
//   node tools/verify-market.mjs --write-fixture  also save the capture to tests/fixtures/
//
// The fixture lets `node tests/run.mjs` repeat the comparison offline.
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { ROOT } from './lib/gamedata.mjs';
import { compareMarketXivapi } from './lib/compare-market.mjs';
import { decodeItems } from './build-market.mjs';

const XIVAPI_VERSION = '7.58';
const data = createRequire(import.meta.url)('../js/market-items.js');

export function sampleIds(items) {
  const ids = new Set();
  items.forEach((it, i) => { if (i % 400 === 0) ids.add(it.id); });
  for (const id of [34585, 36521, 39478, 52004]) ids.add(id); // stored with a trailing space
  for (const it of items) if (/[^\x20-\x7e]/.test(it.name)) ids.add(it.id);
  return [...ids].sort((a, b) => a - b);
}

async function getJson(url) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url);
    if (res.ok) return res.json();
    if (attempt === 3) throw new Error(`${url}: HTTP ${res.status}`);
    await new Promise((r) => setTimeout(r, 1000 * attempt));
  }
}

async function capture(ids) {
  const fields = 'Name,ItemSearchCategory,LevelItem,CanBeHq,IsUntradable';
  const out = [];
  let schema = null;
  for (let i = 0; i < ids.length; i += 50) {
    const rows = ids.slice(i, i + 50).join(',');
    const page = await getJson(`https://v2.xivapi.com/api/sheet/Item?rows=${rows}&fields=${encodeURIComponent(fields)}&version=${XIVAPI_VERSION}`);
    schema = page.schema;
    for (const r of page.rows) {
      out.push({ id: r.row_id, name: r.fields.Name, category: r.fields.ItemSearchCategory.value, level: r.fields.LevelItem.value, hq: r.fields.CanBeHq, untradable: r.fields.IsUntradable });
    }
  }
  return { source: 'v2.xivapi.com', version: XIVAPI_VERSION, schema, items: out.sort((a, b) => a.id - b.id) };
}

const items = decodeItems(data.items);
const x = await capture(sampleIds(items));
if (process.argv.includes('--write-fixture')) {
  const { items: list, ...head } = x;
  writeFileSync(join(ROOT, 'tests', 'fixtures', 'xivapi-market.json'), `${JSON.stringify(head).slice(0, -1)},"items":[\n${list.map((r) => `  ${JSON.stringify(r)}`).join(',\n')}\n]}\n`);
  console.log('wrote tests/fixtures/xivapi-market.json');
}
const problems = compareMarketXivapi(x, items);
if (x.items.length !== sampleIds(items).length) problems.push(`asked for ${sampleIds(items).length} items, XIVAPI returned ${x.items.length}`);
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
console.log(`${x.items.length} sampled items agree with XIVAPI ${XIVAPI_VERSION}`);
