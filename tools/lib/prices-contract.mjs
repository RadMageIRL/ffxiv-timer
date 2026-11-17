// The price paths the page will request (next to itself, under prices/), and what each one is
// answered with upstream. One description shared by the fixture capture (tools/capture-universalis.mjs),
// the fake Universalis in the tests (tests/lib/fake-universalis.mjs) and, later, the radmagelabs.com
// rules, so the three cannot drift apart.
//
// Page path                         Upstream (https://universalis.app/api/v2/...)
//   prices/aggregated/<scope>/<ids>   aggregated/<scope>/<ids>            ids: 1 to 100, comma-separated
//   prices/item/<scope>/<id>          <scope>/<id>?listings=20&entries=20&fields=<ITEM_FIELDS>
//   prices/tax/<world id>             tax-rates?world=<world id>
//
// Measured on the Phase 0 prototype (2026-11-17): the upstream's own query parameters win over any
// the visitor adds, so the pinned fields cannot be widened from the page; and Universalis answers
// 101 ids with 100 results and no error, so a request never carries more than MAX_IDS.
export const UPSTREAM = 'https://universalis.app/api/v2';
export const MAX_IDS = 100;
export const LISTINGS = 20;
export const ENTRIES = 20;

// Everything the item details show, and nothing that names or identifies a player: no retainer,
// crafter or buyer names, no seller, retainer, crafter or listing ids. Universalis returns only
// the fields named here (checked against the unfiltered answer, which has all of those).
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
// Keys that must never reach the page, at any depth.
export const FORBIDDEN_KEYS = ['retainerName', 'creatorName', 'buyerName', 'sellerID', 'retainerID', 'creatorID', 'listingID'];

// CDN lifetimes proposed for the radmagelabs.com rules, in seconds.
export const TTL = { aggregated: 300, item: 120, tax: 3600 };

const SCOPE = '[A-Za-z0-9-]{1,32}';
export const PATTERNS = {
  aggregated: new RegExp(`^aggregated/(${SCOPE})/([0-9]{1,9}(?:,[0-9]{1,9}){0,${MAX_IDS - 1}})$`),
  item: new RegExp(`^item/(${SCOPE})/([0-9]{1,9})$`),
  tax: /^tax\/([0-9]{1,5})$/,
};

// The upstream URL for a page path under prices/ (no leading slash, no query), or null when the
// path is not one the page may ask for. The rules answer such a path with 404 and never reach
// the upstream.
export function upstreamFor(path) {
  let m;
  if ((m = PATTERNS.aggregated.exec(path))) return { kind: 'aggregated', scope: m[1], ids: m[2].split(',').map(Number), url: `${UPSTREAM}/aggregated/${m[1]}/${m[2]}` };
  if ((m = PATTERNS.item.exec(path))) {
    return { kind: 'item', scope: m[1], id: Number(m[2]), url: `${UPSTREAM}/${m[1]}/${m[2]}?listings=${LISTINGS}&entries=${ENTRIES}&fields=${ITEM_FIELDS.join(',')}` };
  }
  if ((m = PATTERNS.tax.exec(path))) return { kind: 'tax', world: Number(m[1]), url: `${UPSTREAM}/tax-rates?world=${m[1]}` };
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
