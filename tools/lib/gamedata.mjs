// Loads the game's own data tables, as exported to CSV by the xivapi/ffxiv-datamining project
// (XIVData Oxidizer output, one commit per game patch). The commit and every file's SHA-256 are
// pinned so a build is reproducible; a changed or truncated download fails instead of building.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv } from './csv.mjs';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const DATASET = {
  repo: 'xivapi/ffxiv-datamining',
  commit: '44948e4cda5846eab0baa9872122a888fcc4f1b1',
  patch: '7.57h1',
  language: 'en',
  sha256: {
    TerritoryType: '47adcb76ebe86ea87393a943c06bec18282c49771331a2365f829e057dc7f813',
    WeatherRate: 'f60ae5367c25b45f95c81c4bd06f7f09914e0e8f57a518a7c91826a27e8808fb',
    Weather: '75b0fed1260f7ebaa36144b5abc875c8d2ab707ae3360f29004f6f8dd9890c62',
    PlaceName: '99bccbf52017878380337211f19925beb72ce85968ca44391615bdc28d9a262e',
    ExVersion: 'b5977e2d5312fbd98e27170c6f15d461058f27027c640d9c5d51d673ef2c1927',
    GatheringPoint: '838b106f058c97f8e1a786ab975a2a77c36546599f4e7c83a156412bfeb4d569',
    GatheringPointBase: '10559d5397177a22f0bfd9234649f4e590f2f545b7fa2e391c5768f5dd9cc669',
    GatheringItem: '53fdd67ad7bbd0da4c1490f5d6f3cc5e1dc207ff850fde0b25cbad655c562687',
    GatheringPointTransient: '651ba3acc425076e5a9ce9fcf66578dbb9105389d9824005ac8dfc5a39ad861f',
    GatheringRarePopTimeTable: '9bc16b55eab585ff15e2b53839af5531e9f2df287db3411878fdcc1548a85e69',
    GatheringType: 'fc35ee416853722b87e63ff162ce7ee229180719a577ac70cc96d0e28f6e3752',
    GatheringSubCategory: '11ca93382b5181cda56acfcea579117b0ca7f1465a29b39b044d1d7d2494d347',
    ExportedGatheringPoint: 'ff35bc2b956ada9938b5d634ad0aede762c1e0caa74d8c38c31e7428a5c34ed5',
    Item: '67dc31b8c0fa410bb878bfda8b27ca92696703a220c7e45efd8fcacb789218c3',
    Map: '758afc0be55bcf020376fdbd8f135db435583b1840d477c3b3eb5651c34e396a',
    GatheringItemLevelConvertTable: '0636fe4df504c574f66757c5d74c9295471860f8e2a44e3f4f654332fc0cdc27',
  },
};

export const WEATHER_SHEETS = ['TerritoryType', 'WeatherRate', 'Weather', 'PlaceName', 'ExVersion'];
export const GATHERING_SHEETS = ['TerritoryType', 'PlaceName', 'ExVersion', 'GatheringPoint', 'GatheringPointBase',
  'GatheringItem', 'GatheringPointTransient', 'GatheringRarePopTimeTable', 'GatheringType', 'GatheringSubCategory',
  'ExportedGatheringPoint', 'Item', 'Map', 'GatheringItemLevelConvertTable'];

const sourceUrl = (sheet) =>
  `https://raw.githubusercontent.com/${DATASET.repo}/${DATASET.commit}/csv/${DATASET.language}/${sheet}.csv`;

// Reads one sheet from `dir` when given, otherwise from tools/.cache (downloading it on first use).
export async function loadSheet(sheet, dir) {
  const want = DATASET.sha256[sheet];
  if (!want) throw new Error(`${sheet} is not a pinned sheet`);
  const cacheDir = dir || join(ROOT, 'tools', '.cache', DATASET.commit);
  const path = join(cacheDir, `${sheet}.csv`);
  let bytes;
  if (existsSync(path)) bytes = readFileSync(path);
  else if (dir) throw new Error(`${path} not found`);
  else {
    const res = await fetch(sourceUrl(sheet));
    if (!res.ok) throw new Error(`${sourceUrl(sheet)}: HTTP ${res.status}`);
    bytes = Buffer.from(await res.arrayBuffer());
  }
  const got = createHash('sha256').update(bytes).digest('hex');
  if (got !== want) throw new Error(`${sheet}.csv SHA-256 ${got} does not match the pinned ${want}`);
  if (!dir && !existsSync(path)) { mkdirSync(cacheDir, { recursive: true }); writeFileSync(path, bytes); }
  return parseCsv(bytes.toString('utf8'));
}

export async function loadTables(dir, sheets = Object.keys(DATASET.sha256)) {
  const out = {};
  for (const sheet of sheets) out[sheet] = await loadSheet(sheet, dir);
  return out;
}

// A WeatherRate row as ordered [weatherId, percent] pairs. Order matters: the game walks the
// list accumulating percentages, so two entries for one weather must stay where they are. Zero
// entries are dropped; a 0% slot can never be chosen.
export function ratePairs(row) {
  const pairs = [];
  for (let i = 0; i < 8; i++) {
    const weather = Number(row[`Weather[${i}]`]), rate = Number(row[`Rate[${i}]`]);
    if (rate > 0) pairs.push([weather, rate]);
  }
  return pairs;
}
