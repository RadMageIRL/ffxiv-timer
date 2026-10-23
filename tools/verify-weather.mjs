// Checks js/weather-data.js against a second, independent extraction of the game data: XIVAPI v2
// (v2.xivapi.com), which reads the game files with its own code and schema, versus the CSV export
// the build uses. Every supported zone's name, WeatherRate row and ordered [weather, percent]
// pairs must agree, and so must the weather names.
//
//   node tools/verify-weather.mjs                  compare (needs network)
//   node tools/verify-weather.mjs --write-fixture  also save the capture to tests/fixtures/
//
// The fixture lets `node tests/run.mjs` repeat the comparison offline.
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { ROOT } from './lib/gamedata.mjs';
import { compareWeather } from './lib/compare-weather.mjs';

const XIVAPI_VERSION = '7.57x1'; // XIVAPI's name for game patch 7.57 hotfix 1
const data = createRequire(import.meta.url)('../js/weather-data.js');

async function getJson(url) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url);
    if (res.ok) return res.json();
    if (attempt === 3) throw new Error(`${url}: HTTP ${res.status}`);
    await new Promise((r) => setTimeout(r, 1000 * attempt));
  }
}

async function capture() {
  const zones = [];
  let schema = null;
  for (const z of data.zones) {
    const fields = 'PlaceName.Name,WeatherRate.Rate,WeatherRate.Weather[].Name';
    const row = await getJson(`https://v2.xivapi.com/api/sheet/TerritoryType/${z.territory}?fields=${encodeURIComponent(fields)}&version=${XIVAPI_VERSION}`);
    schema = row.schema;
    const rate = row.fields.WeatherRate;
    const rates = [], names = {};
    rate.fields.Rate.forEach((r, i) => {
      const w = rate.fields.Weather[i];
      if (r > 0) { rates.push([w.value, r]); names[w.value] = w.fields.Name; }
    });
    zones.push({ territory: z.territory, name: row.fields.PlaceName.fields.Name, weatherRate: rate.value, rates, names });
  }
  return { source: 'v2.xivapi.com', version: XIVAPI_VERSION, schema, zones };
}

const fixture = await capture();
const problems = compareWeather(fixture, data);
if (process.argv.includes('--write-fixture')) {
  const { zones, ...head } = fixture;
  const body = zones.map((z) => `  ${JSON.stringify(z)}`).join(',\n');
  writeFileSync(join(ROOT, 'tests', 'fixtures', 'xivapi-weather.json'), `${JSON.stringify(head).slice(0, -1)},"zones":[\n${body}\n]}\n`);
  console.log('wrote tests/fixtures/xivapi-weather.json');
}
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
console.log(`${data.zones.length} zones agree with XIVAPI ${XIVAPI_VERSION} (game data patch ${data.source.patch})`);
