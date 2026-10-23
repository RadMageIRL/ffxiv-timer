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
  },
};

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

export async function loadTables(dir) {
  const out = {};
  for (const sheet of Object.keys(DATASET.sha256)) out[sheet] = await loadSheet(sheet, dir);
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
