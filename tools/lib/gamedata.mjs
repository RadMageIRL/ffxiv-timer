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
  commit: '52a72b38aa2f967cab36867f34cd9bee9debb88b',
  patch: '7.58',
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
    Item: 'bea47a186c8d9533808d2436610c866a4dc22590455eca11973a289ffe470dd2',
    Map: '758afc0be55bcf020376fdbd8f135db435583b1840d477c3b3eb5651c34e396a',
    GatheringItemLevelConvertTable: '0636fe4df504c574f66757c5d74c9295471860f8e2a44e3f4f654332fc0cdc27',
    ItemSearchCategory: 'def808328c89646afe2d1e590db53d86e07505415739df27e04513992a7d0efb',
    World: 'dcead0228b57e8c8d2be679e7baeba32f4d1fbc0f209b00d83a402ebaef1248f',
    WorldDCGroupType: '3081697e7c1650572d3f9691c3b84002f1d142df26174b21ae2a0b6683fcb6ef',
    Recipe: 'ca25e38e1fed24ae4b1d1befeb50998715dc72c7d70d62026f549aa401661c27',
    RecipeLevelTable: '6c74e0a19b80376f4879d744c2c4cdfbcac9dc4bf7812050cac4c6fb93460612',
    SecretRecipeBook: '0c9ba5869daab9d12f07ae04f382d284fba776ea79169dca7c552f7ba8b4110e',
    ClassJob: 'da65a1a26fe11951fff4654a2fec1a0702375294a07ae270bbbcaf35cf22d691',
    GilShop: '70172a418d22999f99de7663c3ccaa000ba1efc960160be8ea77d60923d8c253',
    GilShopItem: '0bc345d71797f0c0dabdd375ca2915f2582672c1ed921c47b695e40cbb7d54b6',
    ENpcBase: 'bbad4bf44cf5b2382d806aeb153f9149cb36506c7a846d7ea77af352cb5e2cc9',
    TopicSelect: 'a089822c5436ce7755313ab35ab6a9b8a88121804830f23bc737c3c85e9ae69a',
    PreHandler: '4213709357c90439ffab689a041bbf080e45d1a0f1b2b7da1bc2c611b6a4ebcf',
    CustomTalk: '6248ddaa763bab3321280c8834648b450b26c7d73b9963f4d67f8bec7d6adbfc',
    CustomTalkNestHandlers: '324becb5c1e8fad2a5943d8d4d9646ca158b5e58913a141a01b144067cfd2151',
  },
};

export const WEATHER_SHEETS = ['TerritoryType', 'WeatherRate', 'Weather', 'PlaceName', 'ExVersion'];
export const GATHERING_SHEETS = ['TerritoryType', 'PlaceName', 'ExVersion', 'GatheringPoint', 'GatheringPointBase',
  'GatheringItem', 'GatheringPointTransient', 'GatheringRarePopTimeTable', 'GatheringType', 'GatheringSubCategory',
  'ExportedGatheringPoint', 'Item', 'Map', 'GatheringItemLevelConvertTable'];
export const MARKET_SHEETS = ['Item', 'ItemSearchCategory', 'World', 'WorldDCGroupType'];
// The recipe catalog (tools/build-recipes.mjs): recipes and their levels, master books and job names; the gil
// shops and the NPC menus and scripts that open them (which items a vendor really sells); the gathering
// points (which ingredients the supported timed nodes give).
export const SHOP_SHEETS = ['GilShop', 'GilShopItem', 'ENpcBase', 'TopicSelect', 'PreHandler', 'CustomTalk', 'CustomTalkNestHandlers'];
export const RECIPE_SHEETS = ['Item', 'Recipe', 'RecipeLevelTable', 'SecretRecipeBook', 'ClassJob', ...SHOP_SHEETS,
  'GatheringItem', 'GatheringPointBase'];

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

// Game text marks italics with asterisks ("The *Ragnarok*"); shown as plain text here, the way
// XIVAPI returns it.
export const plainText = (s) => (s || '').replace(/\*([^*]+)\*/g, '$1');

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
