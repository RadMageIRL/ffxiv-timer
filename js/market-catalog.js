// The market board item list and its search. Pure, so the page and the Node tests share it. Loaded
// with js/market-items.js the first time Market & Crafting opens, never with the timers.
//
// js/market-items.js (made by tools/build-market.mjs from the game's own tables) holds every item on
// the market board: id, name, board category, item level and whether it can be high quality, and
// nothing that changes. parse() checks it as a whole and refuses a list that is not exactly what the
// tool writes, so a damaged download is never searched.
//
// Search is forgiving the way people type: case, accents, apostrophes and punctuation do not matter,
// and every word typed has to appear in the name ("pop popc" finds Caramel Popcorn). Matches are
// ranked: the item's id, the whole name, names that start with what was typed, names where every
// word typed starts a word, then the rest; within a rank by name.
//
// Scopes are where prices are looked up: a region, a data center or one world, as Universalis names
// them (the price function accepts exactly these spellings).
(function (root) {
  'use strict';

  const FORMAT = 1;
  const MAX_QUERY = 60;
  /** Typed text shorter than this searches only together with a type: one letter matches most of the list. */
  const MIN_QUERY = 2;
  const MARKS = new RegExp('[\\u0300-\\u036f]', 'g');
  const APOSTROPHES = new RegExp("['`" + String.fromCharCode(0x2018, 0x2019) + ']', 'g');
  const OTHER = new RegExp('[^\\p{L}\\p{N}]+', 'gu');

  /** Lower case, accents and apostrophes dropped, anything that is not a letter or a digit turned into a space. */
  function fold(text) {
    return String(text === null || text === undefined ? '' : text).slice(0, 200).normalize('NFD').replace(MARKS, '')
      .toLowerCase().replace(APOSTROPHES, '').replace(OTHER, ' ').trim();
  }

  const fail = (why) => ({ ok: false, error: why });
  const nameKey = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

  /**
   * The list from FFXIV_MARKET_ITEMS:
   *   { ok: true, catalog }   ids, names, cat (category id), level, hq (1 if it can be HQ), folded, pos, order,
   *                           byId, categories (by id), groups, scopes (see scopeList), worlds (by id), source
   *   { ok: false, error }    anything else: wrong format, a count that does not match, ids out of order, a bad row
   */
  function parse(d) {
    if (!isObj(d) || d.format !== FORMAT) return fail('not a list of this format');
    if (!Array.isArray(d.groups) || !Array.isArray(d.categories) || !Array.isArray(d.regions) || !Array.isArray(d.dataCenters)) return fail('tables');
    if (!Number.isSafeInteger(d.count) || d.count < 1 || typeof d.items !== 'string') return fail('count');
    const categories = new Map();
    for (const c of d.categories) {
      if (!isObj(c) || !Number.isSafeInteger(c.id) || typeof c.name !== 'string' || !c.name || !Number.isSafeInteger(c.group)) return fail('category');
      categories.set(c.id, { id: c.id, name: c.name, group: c.group, order: c.order, count: 0 });
    }
    const lines = d.items.split('\n');
    if (lines.length !== d.count) return fail(`count ${d.count} but ${lines.length} rows`);
    const n = lines.length;
    const ids = new Array(n), names = new Array(n), cat = new Uint16Array(n), level = new Uint16Array(n), hq = new Uint8Array(n), folded = new Array(n);
    let prev = 0;
    for (let i = 0; i < n; i++) {
      const f = lines[i].split('\t');
      if (f.length !== 5 || !/^[1-9]\d*$/.test(f[0]) || !/^\d+$/.test(f[1]) || !/^\d{1,4}$/.test(f[2]) || (f[3] !== '0' && f[3] !== '1')) return fail(`row ${i + 1}`);
      const id = prev + Number(f[0]);
      const c = categories.get(Number(f[1]));
      if (!Number.isSafeInteger(id) || !c || !f[4] || f[4] !== f[4].trim()) return fail(`row ${i + 1}`);
      ids[i] = id; names[i] = f[4]; cat[i] = c.id; level[i] = Number(f[2]); hq[i] = f[3] === '1' ? 1 : 0; folded[i] = fold(f[4]);
      c.count++;
      prev = id;
    }
    // Name order: folded name, then the name as written, then id. Code-unit order, so it is the same everywhere.
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => nameKey(folded[a], folded[b]) || nameKey(names[a], names[b]) || ids[a] - ids[b]);
    const pos = new Int32Array(n);
    order.forEach((i, k) => { pos[i] = k; });
    const byId = new Map(ids.map((id, i) => [id, i]));
    const worlds = new Map();
    for (const dc of d.dataCenters) for (const w of dc.worlds) worlds.set(w.id, { id: w.id, name: w.name, dc: dc.key });
    const scopes = scopeList(d);
    if (!scopes.length) return fail('scopes');
    return { ok: true, catalog: { count: n, ids, names, cat, level, hq, folded, pos, order, byId, categories, groups: d.groups.slice(), worlds, scopes, scopeById: new Map(scopes.map((s) => [s.id, s])), source: d.source } };
  }

  /**
   * Every place prices can be asked for, in the order the picker lists them: each region, then each data
   * center followed by its worlds. { id, kind, name, scope, region, dc, worldIds }; scope is the name the
   * price function accepts, id what is saved ("region:north-america", "dc:aether", "world:63").
   */
  function scopeList(d) {
    const out = [];
    const regionName = new Map(d.regions.map((r) => [r.key, r.name]));
    for (const r of d.regions) {
      const dcs = d.dataCenters.filter((dc) => dc.region === r.key);
      out.push({ id: `region:${r.key}`, kind: 'region', name: r.name, scope: r.scope, region: r.key, dc: null, worldIds: dcs.flatMap((dc) => dc.worlds.map((w) => w.id)) });
    }
    for (const dc of d.dataCenters) {
      out.push({ id: `dc:${dc.key}`, kind: 'dc', name: dc.name, scope: dc.name, region: dc.region, regionName: regionName.get(dc.region), dc: dc.key, worldIds: dc.worlds.map((w) => w.id) });
      for (const w of dc.worlds) out.push({ id: `world:${w.id}`, kind: 'world', name: w.name, scope: w.name, region: dc.region, dc: dc.key, dcName: dc.name, worldIds: [w.id] });
    }
    return out;
  }

  /**
   * The items a search finds, as indexes into the list, best first:
   *   { status: 'idle' }     nothing typed and no type or favorites filter: the page shows its home
   *   { status: 'short' }    one letter and no type
   *   { status: 'ok', query, indexes }   (indexes may be empty)
   * opts: query; category (a category id, or -1 for any); hq (true: only items that can be HQ); minLevel and
   * maxLevel (item level, or null); only (a Set of item ids, or null); sort: 'relevance' or 'name'.
   * The HQ and level filters narrow results; on their own they do not leave the home.
   */
  function search(cat, opts) {
    const o = opts || {};
    const q = fold(String(o.query || '').slice(0, MAX_QUERY));
    const category = Number.isInteger(o.category) && cat.categories.has(o.category) ? o.category : -1;
    const only = o.only instanceof Set ? o.only : null;
    const minLv = Number.isInteger(o.minLevel) ? o.minLevel : 0, maxLv = Number.isInteger(o.maxLevel) ? o.maxLevel : Infinity;
    const opened = category >= 0 || only !== null;
    if (!q && !opened) return { status: 'idle', query: '', indexes: [] };
    if (q && q.length < MIN_QUERY && !opened) return { status: 'short', query: q, indexes: [] };
    const words = q ? q.split(' ') : [];
    const idQuery = /^\d+$/.test(q) ? Number(q) : -1;
    const hits = [], rank = [];
    for (let i = 0; i < cat.count; i++) {
      if (category >= 0 && cat.cat[i] !== category) continue;
      if (only && !only.has(cat.ids[i])) continue;
      if (o.hq && !cat.hq[i]) continue;
      if (cat.level[i] < minLv || cat.level[i] > maxLv) continue;
      if (!words.length) { hits.push(i); rank.push(0); continue; }
      if (cat.ids[i] === idQuery) { hits.push(i); rank.push(-1); continue; }
      const name = cat.folded[i];
      let all = true;
      for (const w of words) if (name.indexOf(w) === -1) { all = false; break; }
      if (!all) continue;
      let r = 3;
      if (name === q) r = 0;
      else if (name.startsWith(q)) r = 1;
      else {
        const spaced = ' ' + name;
        if (words.every((w) => spaced.indexOf(' ' + w) !== -1)) r = 2;
      }
      hits.push(i); rank.push(r);
    }
    const byName = o.sort === 'name' || !words.length;
    const idx = hits.map((_, k) => k);
    idx.sort(byName ? (a, b) => cat.pos[hits[a]] - cat.pos[hits[b]] : (a, b) => rank[a] - rank[b] || cat.pos[hits[a]] - cat.pos[hits[b]]);
    return { status: 'ok', query: q, indexes: idx.map((k) => hits[k]) };
  }

  /**
   * A sort of the indexes a search found by a value. valueOf(index) gives a number when the item has one, null
   * when its prices are loaded but it has no such value (no HQ listing, say), and undefined when its prices are
   * not loaded. Returns { order, ranked, noValue, unpriced }: first the items with a value (dir 'asc' or 'desc'),
   * ties by name; then the ones without; then the ones not loaded, both by name. A missing value is never
   * sorted as 0.
   */
  function valueSort(cat, indexes, valueOf, dir) {
    const ranked = [], noValue = [], unpriced = [];
    const v = new Map();
    for (const i of indexes) {
      const x = valueOf(i);
      if (x === undefined) unpriced.push(i);
      else if (x === null || !Number.isFinite(x)) noValue.push(i);
      else { v.set(i, x); ranked.push(i); }
    }
    const sign = dir === 'asc' ? 1 : -1;
    ranked.sort((a, b) => sign * (v.get(a) - v.get(b)) || cat.pos[a] - cat.pos[b]);
    const byName = (a, b) => cat.pos[a] - cat.pos[b];
    noValue.sort(byName); unpriced.sort(byName);
    return { order: ranked.concat(noValue, unpriced), ranked: ranked.length, noValue: noValue.length, unpriced: unpriced.length };
  }

  /** The categories of each board group, in the board's order: [{ id, name, categories: [{ id, name, count }] }]. */
  function browseGroups(cat) {
    return cat.groups.map((g) => ({
      id: g.id, name: g.name,
      categories: [...cat.categories.values()].filter((c) => c.group === g.id && c.count > 0).sort((a, b) => a.order - b.order),
    })).filter((g) => g.categories.length);
  }

  const Catalog = { FORMAT, MAX_QUERY, MIN_QUERY, fold, parse, scopeList, search, valueSort, browseGroups };
  if (typeof module === 'object' && module.exports) module.exports = Catalog;
  else root.XivCatalog = Catalog;
})(typeof globalThis !== 'undefined' ? globalThis : this);
