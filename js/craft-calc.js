// Crafting quantities for Market & Crafting: which recipes make an item, what one craft takes all the way down,
// how many crafts each step needs once the demand from every branch is added up, what has to be bought or
// gathered, and what is left over. No prices, no page, no network: the same catalog and choices always give the
// same plan, and nothing here changes the catalog (its recipes are frozen). Reads js/recipes.js (FFXIV_RECIPES).
//
// The rules, in order:
// - One recipe per crafted item: the one asked for, else the first on a preferred job, else the first in job order
//   (CRP to CUL) and then recipe id. An item crafted in two branches is crafted with the same recipe in both.
// - Buy or craft is decided per item, not per branch. The item asked for is always crafted; every other craftable
//   item is crafted unless it is in `buy` (or `buy` is 'all'). An item that cannot be crafted is a material.
// - Demand is added up over every branch before rounding: crafts = ceil(need / yield) for each crafted item, in an
//   order where every item comes after everything that uses it. Each craft takes its ingredients in full, so
//   made = crafts x yield and the surplus (made - need) is listed, never subtracted from anything.
// - Nothing is free and nothing is skipped: gathered, vendor and crystal materials are listed like any other.
//
// Answers are { ok: true, ... } or { ok: false, error, item } with error one of ERRORS; nothing here throws for a
// bad request. createCatalog throws only for data that is not a recipe catalog this code reads.
(function (root) {
  'use strict';

  const FORMAT = 1;
  const MAX_QUANTITY = 9999;
  /** A guard, far above 7.58's longest chain of 5 crafts. */
  const MAX_DEPTH = 32;
  const ERRORS = ['bad-quantity', 'not-craftable', 'bad-recipe', 'bad-buy', 'cycle', 'too-deep'];

  const posInt = (v) => Number.isSafeInteger(v) && v > 0;
  const freezeList = (a) => Object.freeze(a);

  /**
   * A catalog over FFXIV_RECIPES. options.items: the market list's items ([{ id, name, hq }], js/market-items.js
   * decoded) to answer names and whether an item can be high quality; without it only the catalog's own extra items
   * have names.
   */
  function createCatalog(data, options = {}) {
    if (!data || data.format !== FORMAT || typeof data.recipes !== 'string' || !data.sep) throw new Error('not a recipe catalog of format ' + FORMAT);
    const SEP = data.sep, F = data.flags, MQF = data.mqfDefault, text = data.recipes;
    // The index: for record k (in the file's recipe id order) where it starts in the text, its recipe id and its
    // result; and the records again in result order. Typed arrays and binary search, so the index is about 160 KB
    // and a recipe is parsed only when it is asked for.
    const n = data.count;
    if (!posInt(n)) throw new Error('catalog has no count');
    const start = new Int32Array(n + 1), ridOf = new Int32Array(n), resOf = new Int32Array(n);
    let rid = 0, res = 0, at = 0, k = 0;
    while (at < text.length) {
      if (k >= n) throw new Error(`catalog says ${n} recipes, has more`);
      const a = text.indexOf(SEP.field, at), b = text.indexOf(SEP.field, a + 1);
      let end = text.indexOf(SEP.record, b);
      if (end < 0) end = text.length;
      rid += Number(text.slice(at, a)); res += Number(text.slice(a + 1, b));
      if (k && rid <= ridOf[k - 1]) throw new Error(`recipe ${rid} out of order`);
      start[k] = at; ridOf[k] = rid; resOf[k] = res;
      k++; at = end + 1;
    }
    if (k !== n) throw new Error(`catalog says ${n} recipes, has ${k}`);
    start[n] = text.length + 1;
    const byRes = Int32Array.from(ridOf.keys()).sort((x, y) => resOf[x] - resOf[y] || x - y);
    const lowest = (arr, key, value) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (key(arr[m]) < value) lo = m + 1; else hi = m; } return lo; };
    const recordOf = (id) => { const i = lowest(ridOf, (x) => x, id); return i < n && ridOf[i] === id ? i : -1; };
    const recordsFor = (item) => { const out = []; for (let i = lowest(byRes, (x) => resOf[x], item); i < n && resOf[byRes[i]] === item; i++) out.push(byRes[i]); return out; };
    const levels = new Map(data.levels.map(([rl, level, stars]) => [rl, Object.freeze({ rlvl: rl, level, stars })]));
    const books = new Map(data.books);
    const extra = new Map(data.extra.map(([id, name, hq, untradable]) => [id, Object.freeze({ id, name, hq: hq === 1, untradable: untradable === 1, onBoard: false })]));
    const timed = new Map(data.timed.map(([id, bases]) => [id, freezeList(bases.slice())]));
    const vendors = new Map();
    {
      const prices = data.vendorPricesUnverified ? data.vendorPricesUnverified.split(',').map(Number) : [];
      let id = 0;
      (data.vendors ? data.vendors.split(SEP.record) : []).forEach((v, k) => {
        const [step, flags] = v.split(SEP.field).map(Number);
        id += step;
        vendors.set(id, Object.freeze({ gated: (flags & 1) === 1, hq: (flags & 2) === 2, priceUnverified: prices[k] }));
      });
    }
    const market = new Map();
    for (const it of options.items || []) market.set(it.id, Object.freeze({ id: it.id, name: it.name, hq: it.hq === true, untradable: false, onBoard: true }));

    const parsed = new Map();
    function recipe(id) {
      if (parsed.has(id)) return parsed.get(id);
      const i = posInt(id) ? recordOf(id) : -1;
      if (i < 0) return null;
      const f = text.slice(start[i], start[i + 1] - 1).split(SEP.field);
      const flags = Number(f[5]), lv = levels.get(Number(f[4]));
      if (!lv) throw new Error(`recipe ${id}: unknown recipe level ${f[4]}`);
      const r = Object.freeze({
        id, item: resOf[i], job: Number(f[2]), yield: f[3] ? Number(f[3]) : 1,
        rlvl: lv.rlvl, level: lv.level, stars: lv.stars,
        canHq: (flags & F.canHq) !== 0, quickSynth: (flags & F.quickSynth) !== 0,
        expert: (flags & F.expert) !== 0, specialist: (flags & F.specialist) !== 0,
        book: f[6] ? Number(f[6]) : 0, hqMaterialFactor: f[7] ? Number(f[7]) : MQF,
        craftsmanship: f[8] ? Number(f[8]) : 0, control: f[9] ? Number(f[9]) : 0,
        ingredients: freezeList(f[10].split(',').map((x) => { const [i, n] = x.split('*'); return Object.freeze({ item: Number(i), amount: n ? Number(n) : 1 }); })),
      });
      parsed.set(id, r);
      return r;
    }
    const lists = new Map();
    /** Every recipe for an item, in job order and then by recipe id; an empty list when it cannot be crafted. */
    function recipesFor(item) {
      if (lists.has(item)) return lists.get(item);
      const list = freezeList(recordsFor(item).map((i) => recipe(ridOf[i])).sort((a, b) => a.job - b.job || a.id - b.id));
      if (list.length) lists.set(item, list);
      return list;
    }
    const craftable = (item) => { const i = lowest(byRes, (x) => resOf[x], item); return i < n && resOf[byRes[i]] === item; };
    let outputs = null, recipeIds = null;

    return Object.freeze({
      source: data.source,
      count: n,
      jobs: freezeList(data.jobs.map((j) => Object.freeze({ ...j }))),
      /** Every craftable item id, ascending. */
      outputs: () => outputs || (outputs = freezeList([...new Set(Array.from(byRes, (i) => resOf[i]))])),
      /** Every recipe id, ascending. */
      recipeIds: () => recipeIds || (recipeIds = freezeList(Array.from(ridOf))),
      recipe,
      recipesFor,
      craftable,
      level: (rlvl) => levels.get(rlvl) || null,
      bookName: (id) => books.get(id) || null,
      /** { gated, hq, priceUnverified } when an NPC sells the ingredient for gil, else null. */
      vendor: (item) => vendors.get(item) || null,
      /** The supported timed nodes (GatheringPointBase ids, as js/gathering-data.js numbers them) that give it. */
      timedNodes: (item) => timed.get(item) || freezeList([]),
      /** { id, name, hq, untradable, onBoard } for a market item (with options.items) or a catalog extra, else null. */
      item: (id) => market.get(id) || extra.get(id) || null,
      vendorItems: () => [...vendors.keys()],
      timedItems: () => [...timed.keys()],
    });
  }

  /** The recipe used for an item under these options, or null when it cannot be crafted or the choice is wrong. */
  function selectRecipe(catalog, item, options = {}) {
    const list = catalog.recipesFor(item);
    if (!list.length) return null;
    const asked = choiceFor(options.recipes, item);
    if (asked !== undefined) return list.find((r) => r.id === asked) || null;
    for (const job of options.jobs || []) { const r = list.find((x) => x.job === job); if (r) return r; }
    return list[0];
  }
  function choiceFor(recipes, item) {
    if (!recipes) return undefined;
    const v = recipes instanceof Map ? recipes.get(item) : Object.prototype.hasOwnProperty.call(recipes, item) ? recipes[item] : undefined;
    return v === undefined ? undefined : Number(v);
  }

  /**
   * What crafting `quantity` of `item` takes. options: { recipes: { item: recipe id } or Map, jobs: [job index, ...]
   * in order of preference, buy: [item ids] or 'all' }. Answers:
   *   { ok: true, item, quantity, recipe, crafts, steps, materials, surplus, tree }
   *   steps: every crafted item, the one asked for first and each after everything that uses it:
   *          { item, recipe, job, need, crafts, made, surplus, uses: [{ item, quantity }] }
   *   materials: what to buy or gather, in the order first met: { item, quantity, craftable, uses }
   *   surplus: [{ item, quantity }] for every step that makes more than it needs
   *   tree: { item, amount, action: 'craft' | 'buy' | 'material', recipe?, children? }, amount per craft of the
   *         parent (the quantity asked for at the top); an item used twice appears twice, with the same recipe
   * crafts counts every craft in the plan.
   */
  function expand(catalog, item, quantity, options = {}) {
    if (!posInt(quantity) || quantity > MAX_QUANTITY) return { ok: false, error: 'bad-quantity', item };
    if (!catalog.craftable(item)) return { ok: false, error: 'not-craftable', item };
    const buyAll = options.buy === 'all';
    const buy = new Set();
    if (!buyAll) {
      for (const b of options.buy || []) {
        if (!posInt(b)) return { ok: false, error: 'bad-buy', item: b };
        buy.add(b);
      }
      if (buy.has(item)) return { ok: false, error: 'bad-buy', item };
    }
    const crafted = (id) => id === item || (!buyAll && !buy.has(id) && catalog.craftable(id));

    // Depth first from the item: choose each crafted item's recipe, note the order items are first met, and stop
    // at a cycle or past MAX_DEPTH.
    const chosen = new Map(), state = new Map(), met = [], path = [];
    let problem = null;
    (function visit(id) {
      if (problem || state.get(id) === 2) return;
      if (state.get(id) === 1) { problem = { ok: false, error: 'cycle', item: id, path: path.concat(id) }; return; }
      if (path.length >= MAX_DEPTH) { problem = { ok: false, error: 'too-deep', item: id }; return; }
      const r = selectRecipe(catalog, id, options);
      if (!r) { problem = { ok: false, error: 'bad-recipe', item: id }; return; }
      state.set(id, 1); path.push(id);
      chosen.set(id, r); met.push(id);
      for (const ing of r.ingredients) if (crafted(ing.item)) visit(ing.item);
      path.pop(); state.set(id, 2);
    })(item);
    if (problem) return problem;

    // Each crafted item after everything that uses it; among those ready, the one met first (so siblings keep
    // their slot order).
    const rank = new Map(met.map((id, k) => [id, k]));
    const waiting = new Map(met.map((id) => [id, 0]));
    for (const id of met) for (const ing of chosen.get(id).ingredients) if (crafted(ing.item)) waiting.set(ing.item, waiting.get(ing.item) + 1);
    const order = [], ready = [item];
    while (ready.length) {
      ready.sort((a, b) => rank.get(a) - rank.get(b));
      const id = ready.shift();
      order.push(id);
      for (const ing of chosen.get(id).ingredients) {
        if (!crafted(ing.item)) continue;
        const left = waiting.get(ing.item) - 1;
        waiting.set(ing.item, left);
        if (left === 0) ready.push(ing.item);
      }
    }
    const need = new Map([[item, quantity]]), uses = new Map();
    const steps = [];
    let crafts = 0;
    for (const id of order) {
      const r = chosen.get(id), n = need.get(id);
      const c = Math.ceil(n / r.yield), made = c * r.yield;
      crafts += c;
      // uses is this call's own list (made here, referenced once in the answer), so it is handed out as is.
      steps.push({ item: id, recipe: r.id, job: r.job, need: n, crafts: c, made, surplus: made - n, uses: uses.get(id) || [] });
      for (const ing of r.ingredients) {
        const q = c * ing.amount;
        need.set(ing.item, (need.get(ing.item) || 0) + q);
        if (!uses.has(ing.item)) uses.set(ing.item, []);
        uses.get(ing.item).push({ item: id, quantity: q });
      }
    }
    const materials = [], listed = new Set();
    for (const id of order) for (const ing of chosen.get(id).ingredients) {
      if (crafted(ing.item) || listed.has(ing.item)) continue;
      listed.add(ing.item);
      materials.push({ item: ing.item, quantity: need.get(ing.item), craftable: catalog.craftable(ing.item), uses: uses.get(ing.item) });
    }
    const surplus = steps.filter((s) => s.surplus > 0).map((s) => ({ item: s.item, quantity: s.surplus }));
    const node = (id, amount) => {
      if (!crafted(id)) return { item: id, amount, action: catalog.craftable(id) ? 'buy' : 'material' };
      const r = chosen.get(id);
      return { item: id, amount, action: 'craft', recipe: r.id, children: r.ingredients.map((ing) => node(ing.item, ing.amount)) };
    };
    return { ok: true, item, quantity, recipe: chosen.get(item).id, crafts, steps, materials, surplus, tree: node(item, quantity) };
  }

  /** The craftable items under an item (it excluded), each a buy-or-craft choice, in the order of expand's steps. */
  function decisionPoints(catalog, item, options = {}) {
    const p = expand(catalog, item, 1, { recipes: options.recipes, jobs: options.jobs });
    return p.ok ? p.steps.slice(1).map((s) => s.item) : [];
  }

  const CraftCalc = { FORMAT, MAX_QUANTITY, MAX_DEPTH, ERRORS, createCatalog, selectRecipe, expand, decisionPoints };
  if (typeof module === 'object' && module.exports) module.exports = CraftCalc;
  else root.XivCraft = CraftCalc;
})(typeof globalThis !== 'undefined' ? globalThis : this);
