// A stand-in for the radmagelabs.com price rules and Universalis behind them, for the browser
// tests. It answers the paths in radmagelabs/api/_ffxiv-prices/contract.mjs exactly as the real rules will:
// anything else is 404 without reaching "upstream", the visitor's query string is ignored (the
// rules delete it), and the answers have the shapes captured in tests/fixtures/universalis/.
//
//   const fake = fakeUniversalis();
//   serve({ ..., handlers: [{ prefix: '/ffxiv/prices/', handle: fake.handle }] });
//   fake.failNext({ status: 503 }, 2)    the next 2 price requests answer 503 (problem+json)
//   fake.failNext({ status: 429 })       one rate-limited answer
//   fake.failNext({ offline: true })     the connection drops with no answer
//   fake.failNext({ mangle: true })      200 with a body cut short (not JSON)
//   fake.failNext({ delay: 2000 })       the right answer, 2 s late
//   fake.hold() / fake.release()         answers wait until released (aborts show as status 0)
//   fake.empty(ids)                      these items have no data (empty objects)
//   fake.calls                           every request that reached "upstream": { kind, scope, ids, at }
//   fake.reset()
//
// Values come from the fixtures: one data center (Aether), one region (North-America) and one world
// (Gilgamesh). Any other scope of the same kind reuses them, with its own name filled in, because
// the tests check shapes and paths, not prices. An id that is not on the market board (per
// js/market-items.js) lands in failedItems, as Universalis does.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { upstreamFor } from '../../radmagelabs/api/_ffxiv-prices/contract.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixture = (name) => JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'universalis', `${name}.json`), 'utf8'));
const MARKET = createRequire(import.meta.url)('../../js/market-items.js');
const EMPTY_SIDE = { minListing: {}, recentPurchase: {}, averageSalePrice: {}, dailySaleVelocity: {} };

// Scope names from the catalog, so "is this a world, a data center or a region" is decided the
// way the game lists them.
function scopeKind(scope) {
  const s = scope.toLowerCase();
  if (MARKET.regions.some((r) => r.scope.toLowerCase() === s)) return 'region';
  if (MARKET.dataCenters.some((d) => d.key === s)) return 'dc';
  if (MARKET.dataCenters.some((d) => d.worlds.some((w) => w.name.toLowerCase() === s || String(w.id) === s))) return 'world';
  return null;
}

// Every id on the board, and those that can be high quality.
function boardIds() {
  const all = new Set(), hq = new Set();
  let id = 0;
  for (const line of MARKET.items.split('\n')) {
    const p = line.split('\t');
    id += Number(p[0]);
    all.add(id);
    if (p[3] === '1') hq.add(id);
  }
  return { all, hq };
}

export function fakeUniversalis() {
  const { all: onBoard, hq: canBeHq } = boardIds();
  const agg = { dc: fixture('aggregated-dc'), region: fixture('aggregated-region'), world: fixture('aggregated-world') };
  const byId = (kind) => new Map(agg[kind].results.map((r) => [r.itemId, r]));
  const aggById = { dc: byId('dc'), region: byId('region'), world: byId('world') };
  // A stand-in entry for a marketable item the fixtures do not hold: Fire Shard's shape with its id.
  const template = (kind) => aggById[kind].get(2);
  const items = { hq: fixture('item-dc-hq'), nq: fixture('item-dc-nq'), world: fixture('item-world'), empty: fixture('item-empty') };
  const tax = fixture('tax-gilgamesh');
  const notFound = fixture('error-unknown-scope');

  let failures = [], holding = false, held = [], emptyIds = new Set();
  const calls = [];
  const json = (send, status, body, type = 'application/json; charset=utf-8') => send(status, typeof body === 'string' ? body : JSON.stringify(body), type);

  function answer(up) {
    const kind = scopeKind(up.kind === 'tax' ? String(up.world) : up.scope);
    if (!kind || (up.kind === 'tax' && kind !== 'world')) return { status: 404, body: notFound, type: 'application/problem+json; charset=utf-8' };
    if (up.kind === 'aggregated') {
      const results = [], failedItems = [];
      for (const id of up.ids) {
        if (!onBoard.has(id)) { failedItems.push(id); continue; }
        if (emptyIds.has(id)) { results.push({ itemId: id, nq: { ...EMPTY_SIDE }, hq: { ...EMPTY_SIDE } }); continue; }
        const r = aggById[kind].get(id) || { ...template(kind), itemId: id };
        results.push(r);
      }
      return { status: 200, body: { results, failedItems } };
    }
    if (up.kind === 'item') {
      const base = emptyIds.has(up.id) ? items.empty : kind === 'world' ? items.world : canBeHq.has(up.id) ? items.hq : items.nq;
      const body = { ...base, itemID: up.id };
      if (kind === 'world') body.worldName = up.scope; else if (kind === 'dc') body.dcName = up.scope; else body.regionName = up.scope;
      return { status: 200, body };
    }
    return { status: 200, body: tax };
  }

  async function handle({ rest, send, res }) {
    const up = upstreamFor(rest);
    if (!up) return send(404, 'not a price path', 'text/plain');
    calls.push({ kind: up.kind, scope: up.scope || null, ids: up.ids || (up.id ? [up.id] : [up.world]), at: Date.now() });
    if (holding) await new Promise((release) => held.push(release));
    const f = failures.length ? failures.shift() : null;
    if (f && f.offline) { res.socket.destroy(); return undefined; }
    if (f && f.delay) await new Promise((ok) => setTimeout(ok, f.delay));
    if (f && f.status) return json(send, f.status, { type: 'about:blank', title: 'Fake failure', status: f.status }, 'application/problem+json; charset=utf-8');
    const a = answer(up);
    if (f && f.mangle) return json(send, 200, JSON.stringify(a.body).slice(0, 40));
    return json(send, a.status, a.body, a.type);
  }

  return {
    handle,
    calls,
    failNext(failure, times = 1) { for (let i = 0; i < times; i++) failures.push(failure); },
    hold() { holding = true; },
    release() { holding = false; const h = held; held = []; for (const r of h) r(); },
    empty(ids) { for (const id of ids) emptyIds.add(Number(id)); },
    reset() { failures = []; holding = false; this.release(); emptyIds = new Set(); calls.length = 0; },
  };
}
