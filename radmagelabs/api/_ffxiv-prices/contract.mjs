// The price paths the page requests next to itself (under prices/), what each one asks Universalis,
// and the fields that may come back. radmagelabs.com answers these paths with the function in
// ../ffxiv-prices.mjs (handler.mjs); the fixture capture (tools/capture-universalis.mjs) and the fake
// Universalis in the tests (tests/lib/fake-universalis.mjs) read the same description, so the three
// cannot drift apart. Plain JavaScript with no imports, because it is deployed with the function.
//
// Page path                         Upstream (https://universalis.app/api/v2/...)
//   prices/aggregated/<scope>/<ids>   aggregated/<scope>/<ids>            ids: 1 to 100, ascending, comma-separated
//   prices/item/<scope>/<id>          <scope>/<id>?listings=20&entries=20&fields=<ITEM_FIELDS>
//   prices/tax/<world id>             tax-rates?world=<world id>
//
// <scope> is a region, data center or world name exactly as allow.mjs lists it. Universalis answers
// 101 ids with 100 results and no error (measured 2026-11-17), so a request never carries more than
// MAX_IDS, and ids are sorted so the same set of items is always the same path (one cache entry).
export const UPSTREAM = 'https://universalis.app/api/v2';
export const MAX_IDS = 100;
export const LISTINGS = 20;
export const ENTRIES = 20;

// Everything the item details show, and nothing that names or identifies a player: no retainer,
// crafter or buyer names, no seller, retainer, crafter or listing ids. Universalis returns only
// the fields named here (checked against the unfiltered answer, which has all of those), and the
// function keeps only these fields again, whatever Universalis sends.
export const ITEM_FIELDS = [
  'itemID', 'worldID', 'worldName', 'dcName', 'regionName', 'lastUploadTime', 'hasData',
  'listingsCount', 'recentHistoryCount', 'unitsForSale', 'unitsSold',
  'regularSaleVelocity', 'nqSaleVelocity', 'hqSaleVelocity',
  'minPriceNQ', 'minPriceHQ', 'averagePriceNQ', 'averagePriceHQ', 'currentAveragePriceNQ', 'currentAveragePriceHQ',
  'worldUploadTimes',
  'listings.pricePerUnit', 'listings.quantity', 'listings.total', 'listings.tax', 'listings.hq', 'listings.isCrafted',
  'listings.onMannequin', 'listings.worldID', 'listings.worldName', 'listings.lastReviewTime', 'listings.retainerCity',
  'recentHistory.pricePerUnit', 'recentHistory.quantity', 'recentHistory.total', 'recentHistory.hq',
  'recentHistory.onMannequin', 'recentHistory.timestamp', 'recentHistory.worldID', 'recentHistory.worldName',
];
// The same fields with the type each must have to be kept (num: a finite number, int: a safe
// integer, bool, str: a string of at most 64 characters, times: world id -> milliseconds). A field
// of the wrong type is dropped; a field not named here never reaches the page.
export const ITEM_TYPES = {
  itemID: 'int', worldID: 'int', worldName: 'str', dcName: 'str', regionName: 'str', lastUploadTime: 'num', hasData: 'bool',
  listingsCount: 'int', recentHistoryCount: 'int', unitsForSale: 'int', unitsSold: 'int',
  regularSaleVelocity: 'num', nqSaleVelocity: 'num', hqSaleVelocity: 'num',
  minPriceNQ: 'num', minPriceHQ: 'num', averagePriceNQ: 'num', averagePriceHQ: 'num', currentAveragePriceNQ: 'num', currentAveragePriceHQ: 'num',
  worldUploadTimes: 'times',
  listings: {
    pricePerUnit: 'num', quantity: 'int', total: 'num', tax: 'num', hq: 'bool', isCrafted: 'bool',
    onMannequin: 'bool', worldID: 'int', worldName: 'str', lastReviewTime: 'num', retainerCity: 'int',
  },
  recentHistory: {
    pricePerUnit: 'num', quantity: 'int', total: 'num', hq: 'bool', onMannequin: 'bool', timestamp: 'num', worldID: 'int', worldName: 'str',
  },
};
// Aggregated answers: per item, nq and hq each hold these four measures, each at world (world scope
// only), dc and region level, plus the upload time of every world that has data.
export const AGGREGATED_PLACES = ['world', 'dc', 'region'];
export const AGGREGATED_SIDE = {
  minListing: { price: 'num', worldId: 'int' },
  recentPurchase: { price: 'num', timestamp: 'num', worldId: 'int' },
  averageSalePrice: { price: 'num' },
  dailySaleVelocity: { quantity: 'num' },
};
export const UPLOAD_TIME = { worldId: 'int', timestamp: 'num' };
// Tax answers: the market tax in percent for each city, by the city's name.
export const TAX_CITY = /^[A-Za-z' ]{1,24}$/;

// Keys that must never reach the page, at any depth.
export const FORBIDDEN_KEYS = ['retainerName', 'creatorName', 'buyerName', 'sellerID', 'retainerID', 'creatorID', 'listingID'];

// How long Vercel's CDN keeps a good answer, in seconds, and how much longer after that it may hand
// out the old answer while it asks the function again in the background.
export const TTL = { aggregated: 300, item: 120, tax: 3600 };
export const STALE = { aggregated: 600, item: 240, tax: 86400 };
// And how long after that the CDN may still hand out the last good answer when the function fails
// (Universalis down or limiting, or this function's own error). Measured on the prototype
// (2026-11-17): Vercel honors stale-if-error for function answers, and without it a failed
// background refresh drops the old answer, so visitors get the error instead.
export const STALE_IF_ERROR = { aggregated: 43200, item: 43200, tax: 604800 };
// So an answer may be served long after it was fetched, and a fetch may return data uploaded long
// before. The age of a price is always the Universalis time that comes with it (worldUploadTimes,
// lastUploadTime, a sale's or purchase's timestamp, a listing's lastReviewTime), which the function
// and the CDN pass on unchanged; never when the answer was fetched or served. X-Prices-Fetched only
// says when the function last asked Universalis, and a missing time means an unknown age.

const SCOPE = '[A-Za-z0-9-]{1,32}';
export const PATTERNS = {
  aggregated: new RegExp(`^aggregated/(${SCOPE})/([0-9]{1,9}(?:,[0-9]{1,9}){0,${MAX_IDS - 1}})$`),
  item: new RegExp(`^item/(${SCOPE})/([0-9]{1,9})$`),
  tax: /^tax\/([0-9]{1,5})$/,
};

// The upstream URL for a page path under prices/ (no leading slash, no query), or null when the
// path is not one the page may ask for. Such a path is refused and never reaches the upstream.
// base is the upstream's address (the tests and the prototype point it elsewhere).
export function upstreamFor(path, base = UPSTREAM) {
  let m;
  if ((m = PATTERNS.aggregated.exec(path))) return { kind: 'aggregated', scope: m[1], ids: m[2].split(',').map(Number), url: `${base}/aggregated/${m[1]}/${m[2]}` };
  if ((m = PATTERNS.item.exec(path))) {
    return { kind: 'item', scope: m[1], id: Number(m[2]), url: `${base}/${m[1]}/${m[2]}?listings=${LISTINGS}&entries=${ENTRIES}&fields=${ITEM_FIELDS.join(',')}` };
  }
  if ((m = PATTERNS.tax.exec(path))) return { kind: 'tax', world: Number(m[1]), url: `${base}/tax-rates?world=${m[1]}` };
  return null;
}

// Sorted, de-duplicated ids cut into requests of at most MAX_IDS, so the same view always asks
// for the same paths (one CDN entry each) and nothing is dropped by the upstream.
export function chunkIds(ids) {
  const sorted = [...new Set(ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < sorted.length; i += MAX_IDS) out.push(sorted.slice(i, i + MAX_IDS));
  return out;
}

// Every key name anywhere in a parsed JSON value.
export function keysDeep(value, out = new Set()) {
  if (Array.isArray(value)) for (const v of value) keysDeep(v, out);
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { out.add(k); keysDeep(v, out); }
  return out;
}
