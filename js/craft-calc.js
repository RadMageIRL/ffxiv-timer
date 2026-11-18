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

  // ---- Costs: prices in, gil out (still pure) ----
  //
  // A quote is what the page knows of one item's market at one place, built by the page from Universalis answers:
  //   { state: 'loaded', nq, hq, avg: { nq, hq }, velocity: { nq, hq }, recent: { nq, hq } }
  // nq and hq: the lowest listing { price, worldId, at } (at: when Universalis last received that world's board) or
  // null; avg: the 4-day average sale price or null; velocity: units sold a day over 4 days or null; recent: the last
  // sale { price, at } or null. Any other state means no price: 'off-board' (not on the market board, so never asked
  // for), 'no-scope', 'idle', 'pending', 'failed', 'missing' (not on the board at that place), 'empty' (no data).
  //
  // The rules:
  // - A material is bought at its lowest listing: the cheaper of NQ and HQ (an HQ item can always stand in for NQ),
  //   or with materials 'hq' only the HQ listing of a material that can be HQ. Listings only: vendor prices from the
  //   game data are unverified and never enter a total or a choice.
  // - Cash outlay is what has to be bought: every material not marked as owned (gathered or already in hand), at
  //   its listing plus the assumed purchase tax. Economic cost is the market value of every material the plan uses:
  //   the cash outlay plus what the owned ones would cost at their listings. Nothing is free.
  // - A missing price is never zero: a total that lacks one says how many it lacks.
  // - The cheapest plan is the one with the fewest missing prices, then the lowest economic cost, found by trying
  //   every buy-or-craft combination of the free steps (at most CHEAPEST_EXHAUSTIVE of them; 7.58 has at most 14).

  const CHEAPEST_EXHAUSTIVE = 16;
  const QUALITIES = ['nq', 'hq'];

  /** The listing a material would be bought at, or null: { price, quality, worldId, at }. */
  function buyAt(quote, materials, canHq) {
    if (!quote || quote.state !== 'loaded') return null;
    const pick = (q) => (quote[q] && Number.isFinite(quote[q].price) && quote[q].price > 0 ? { ...quote[q], quality: q } : null);
    if (materials === 'hq' && canHq) return pick('hq');
    const nq = pick('nq'), hq = canHq ? pick('hq') : null;
    return nq && hq ? (hq.price < nq.price ? hq : nq) : nq || hq;
  }
  /** Why a material has no price, in one word (see the quote states), or null when it has one. */
  function noPriceWhy(quote, materials, canHq) {
    if (!quote) return 'idle';
    if (quote.state !== 'loaded') return quote.state;
    return materials === 'hq' && canHq ? 'no-hq-listing' : 'no-listing';
  }
  const taxRate = (o) => (Number.isFinite(o.tax) && o.tax > 0 ? o.tax : 0);

  /**
   * What a plan costs. options: expand's options plus { quote: (id) => quote, canBeHq: (id) => boolean,
   * materials: 'any' | 'hq', tax: a fraction (0.05 for 5 %), owned: Set of item ids }. Answers expand's errors, or
   *   { ok: true, plan, lines, cash: { total, missing }, value: { total, missing }, oldest, perUnit }
   * lines: one per material to acquire { item, quantity, craftable, owned, unit, cash, value, why }, where unit is
   * the listing used (null with why when there is none), cash what buying it takes (0 when owned) and value its
   * market value in the plan; either is null when unknown. totals add up the known ones; missing counts the rest.
   * oldest: the oldest listing time used. perUnit: value per item made, or null when anything is missing.
   */
  function costPlan(catalog, item, quantity, options = {}) {
    const plan = expand(catalog, item, quantity, options);
    if (!plan.ok) return plan;
    const tax = taxRate(options), owned = options.owned || new Set();
    const quote = options.quote || (() => null), canBeHq = options.canBeHq || (() => false);
    const cash = { total: 0, missing: 0 }, value = { total: 0, missing: 0 };
    let oldest = null;
    const lines = plan.materials.map((m) => {
      const q = quote(m.item), hq = canBeHq(m.item), unit = buyAt(q, options.materials, hq), own = owned.has(m.item);
      const v = unit ? m.quantity * unit.price * (own ? 1 : 1 + tax) : null;
      const c = own ? 0 : v;
      if (c === null) cash.missing++; else cash.total += c;
      if (v === null) value.missing++; else value.total += v;
      if (unit && Number.isFinite(unit.at) && (oldest === null || unit.at < oldest)) oldest = unit.at;
      return { item: m.item, quantity: m.quantity, craftable: m.craftable, owned: own, unit, cash: c, value: v, why: unit ? null : noPriceWhy(q, options.materials, hq) };
    });
    return { ok: true, plan, lines, cash, value, oldest, perUnit: value.missing ? null : value.total / quantity };
  }

  /**
   * The cheapest buy-or-craft plan. options as costPlan, plus force: Map(item id -> 'buy' | 'craft') for steps the
   * player has decided. Answers expand's errors, or { ok: true, buy: [item ids], value, missing, evaluated, exhaustive }
   * where value is the plan's economic cost over the prices known and missing how many prices it lacks.
   */
  function cheapest(catalog, item, quantity, options = {}) {
    const full = expand(catalog, item, quantity, { recipes: options.recipes, jobs: options.jobs });
    if (!full.ok) return full;
    const tax = taxRate(options), owned = options.owned || new Set();
    const quote = options.quote || (() => null), canBeHq = options.canBeHq || (() => false);
    const force = options.force || new Map();
    const steps = full.steps, leaves = full.materials.map((m) => m.item);
    const N = steps.length, L = leaves.length;
    const at = new Map(steps.map((s, k) => [s.item, k]));
    leaves.forEach((id, k) => at.set(id, N + k));
    // The unit economic price of buying each item (NaN when there is none), and each step's recipe as flat arrays.
    const price = new Float64Array(N + L);
    const ids = steps.map((s) => s.item).concat(leaves);
    ids.forEach((id, k) => { const u = buyAt(quote(id), options.materials, canBeHq(id)); price[k] = u ? u.price * (owned.has(id) ? 1 : 1 + tax) : NaN; });
    const yields = steps.map((s) => catalog.recipe(s.recipe).yield);
    const kids = steps.map((s) => catalog.recipe(s.recipe).ingredients.map((g) => [at.get(g.item), g.amount]));
    const free = [], fixedBuy = new Set();
    for (let k = 1; k < N; k++) { const f = force.get(steps[k].item); if (f === 'buy') fixedBuy.add(k); else if (f !== 'craft') free.push(k); }
    const need = new Float64Array(N + L), bought = new Uint8Array(N);
    function evaluate() {
      need.fill(0); need[0] = quantity;
      let total = 0, missing = 0;
      for (let k = 0; k < N; k++) {
        const q = need[k];
        if (!q) continue;
        if (bought[k]) { if (Number.isNaN(price[k])) missing++; else total += q * price[k]; continue; }
        const c = Math.ceil(q / yields[k]);
        for (const [j, a] of kids[k]) need[j] += c * a;
      }
      for (let j = N; j < N + L; j++) if (need[j]) { if (Number.isNaN(price[j])) missing++; else total += need[j] * price[j]; }
      return [missing, total];
    }
    const better = (a, b) => !b || a[0] < b[0] || (a[0] === b[0] && a[1] < b[1] - 1e-9);
    const set = (mask) => { bought.fill(0); for (const k of fixedBuy) bought[k] = 1; free.forEach((k, b) => { if (mask[b]) bought[k] = 1; }); };
    let best = null, bestMask = null, evaluated = 0;
    const exhaustive = free.length <= CHEAPEST_EXHAUSTIVE;
    if (exhaustive) {
      for (let m = 0; m < 2 ** free.length; m++) {
        const mask = free.map((_, b) => (m >> b) & 1);
        set(mask); const r = evaluate(); evaluated++;
        if (better(r, best)) { best = r; bestMask = mask; }
      }
    } else {
      // Past the limit (never in 7.58): start from each step's cheaper way per unit, worked out from the bottom up
      // (rounding and shared steps aside), then flip one step at a time, in passes, while that helps.
      const unit = new Float64Array(N + L).fill(Infinity), buyIt = new Uint8Array(N);
      for (let j = N; j < N + L; j++) if (!Number.isNaN(price[j])) unit[j] = price[j];
      for (let k = N - 1; k >= 0; k--) {
        let made = 0;
        for (const [j, a] of kids[k]) made += a * unit[j];
        made /= yields[k];
        const bought = Number.isNaN(price[k]) ? Infinity : price[k];
        if (k > 0 && bought < made) { unit[k] = bought; buyIt[k] = 1; } else unit[k] = made;
      }
      let mask = free.map((k) => buyIt[k]);
      set(mask); best = evaluate(); bestMask = mask; evaluated++;
      for (let improved = true; improved;) {
        improved = false;
        for (let b = 0; b < free.length; b++) {
          const m = bestMask.slice(); m[b] ^= 1;
          set(m); const r = evaluate(); evaluated++;
          if (better(r, best)) { best = r; bestMask = m; improved = true; }
        }
      }
    }
    set(bestMask);
    const buy = []; for (let k = 1; k < N; k++) if (bought[k]) buy.push(steps[k].item);
    return { ok: true, buy, value: best[1], missing: best[0], evaluated, exhaustive };
  }

  /**
   * What a finished item sells for and what crafting it may earn, per unit, on one quality side. quote: the item's;
   * cost: the material cost of one (economic, from costPlan's perUnit) or null. Answers
   *   { listing, average, velocity, recent, estimates: { listing, average }, headline, basis }
   * listing: the lowest listing { price, worldId, at } or null; average: the 4-day average sale price or null.
   * estimates.listing and .average: { ref, profit, margin } against each, or null. headline: the lower of the two
   * when both are there (basis 'lower'), else the one there is (basis 'listing only' or 'sales only'), else null
   * (basis null). An estimate is never a promise: listings are offers, not sales.
   */
  function profitOf(quote, quality, cost) {
    const q = QUALITIES.includes(quality) ? quality : 'nq';
    const loaded = quote && quote.state === 'loaded';
    const listing = loaded && quote[q] && quote[q].price > 0 ? quote[q] : null;
    const average = loaded && Number.isFinite(quote.avg[q]) && quote.avg[q] > 0 ? quote.avg[q] : null;
    const velocity = loaded && Number.isFinite(quote.velocity[q]) ? quote.velocity[q] : null;
    const recent = loaded ? quote.recent[q] || null : null;
    const est = (ref) => (ref && Number.isFinite(cost) ? { ref, profit: ref - cost, margin: (ref - cost) / ref } : null);
    const estimates = { listing: est(listing && listing.price), average: est(average) };
    let headline = null, basis = null;
    if (estimates.listing && estimates.average) { headline = estimates.listing.ref <= estimates.average.ref ? estimates.listing : estimates.average; basis = 'lower'; }
    else if (estimates.listing) { headline = estimates.listing; basis = 'listing only'; }
    else if (estimates.average) { headline = estimates.average; basis = 'sales only'; }
    return { listing, average, velocity, recent, estimates, headline, basis };
  }

  /**
   * The market ids a recipe view prices, sorted: the item and every market item under it, with every recipe for
   * every step counted, so changing a job, a recipe or buy-or-craft never needs another request. onBoard: (id) =>
   * boolean; anything not on the market board is never asked for.
   */
  function priceIds(catalog, item, onBoard) {
    const seen = new Set([item]), stack = [item];
    while (stack.length) for (const r of catalog.recipesFor(stack.pop())) for (const g of r.ingredients) if (!seen.has(g.item)) { seen.add(g.item); stack.push(g.item); }
    return [...seen].filter(onBoard).sort((a, b) => a - b);
  }

  /**
   * Crafting Watch's shortlist: the current crafting tier, every market item made by a level 100 recipe of 4 stars or
   * an expert recipe, and the fixed requests that price it: the sorted market ids of all their trees, 100 to a
   * request. The same for every visitor, so each request is one shared cache entry per place.
   */
  function watchList(catalog, onBoard) {
    const outputs = catalog.outputs().filter((id) => onBoard(id) && catalog.recipesFor(id).some((r) => r.level === 100 && (r.stars >= 4 || r.expert)));
    const all = new Set();
    for (const id of outputs) for (const x of priceIds(catalog, id, onBoard)) all.add(x);
    const sorted = [...all].sort((a, b) => a - b), chunks = [];
    for (let i = 0; i < sorted.length; i += 100) chunks.push(sorted.slice(i, i + 100));
    return { outputs, chunks };
  }

  /**
   * One Crafting Watch row per output: the cheapest of its recipes (at the cheapest plan, for one craft), what it
   * may earn, and how much to trust that. options as costPlan, plus quality: 'hq' | 'nq' (an item that cannot be HQ
   * is always NQ), now, staleMs (default 3 days), minDaily (default 1). group: 'ranked' (every price there, both
   * references, sells at least minDaily a day, listing and last sale newer than staleMs), 'thin' (priced, but some
   * of that is not so), or 'unpriced' (a material or both references missing): never ranked.
   */
  function watchRows(catalog, outputs, options = {}) {
    const staleMs = options.staleMs || 3 * 86400000, minDaily = options.minDaily === undefined ? 1 : options.minDaily;
    const canBeHq = options.canBeHq || (() => false), quote = options.quote || (() => null), t = options.now;
    return outputs.map((item) => {
      const quality = options.quality === 'hq' && canBeHq(item) ? 'hq' : 'nq';
      let best = null;
      for (const r of catalog.recipesFor(item)) {
        const o = { ...options, recipes: { [item]: r.id }, jobs: [r.job], force: undefined };
        const c = cheapest(catalog, item, r.yield, o);
        if (!c.ok) continue;
        const p = costPlan(catalog, item, r.yield, { ...o, buy: c.buy });
        if (!best || (p.value.missing < best.cost.value.missing) || (p.value.missing === best.cost.value.missing && p.value.total < best.cost.value.total)) best = { recipe: r, cost: p };
      }
      const perUnit = best && best.cost.perUnit;
      const profit = profitOf(quote(item), quality, perUnit);
      const stale = !profit.listing || !Number.isFinite(profit.listing.at) || t - profit.listing.at > staleMs
        || !profit.recent || !Number.isFinite(profit.recent.at) || t - profit.recent.at > staleMs
        || (best && best.cost.oldest !== null && t - best.cost.oldest > staleMs);
      const lowVolume = profit.velocity === null || profit.velocity < minDaily;
      const group = !best || perUnit === null || !profit.headline ? 'unpriced' : profit.basis === 'lower' && !stale && !lowVolume ? 'ranked' : 'thin';
      return { item, quality, recipe: best ? best.recipe.id : null, job: best ? best.recipe.job : null, cost: perUnit, buy: best ? best.cost.plan.materials.filter((m) => m.craftable).map((m) => m.item) : [], profit, stale, lowVolume, group };
    });
  }

  const CraftCalc = { FORMAT, MAX_QUANTITY, MAX_DEPTH, ERRORS, CHEAPEST_EXHAUSTIVE, createCatalog, selectRecipe, expand, decisionPoints, buyAt, costPlan, cheapest, profitOf, priceIds, watchList, watchRows };
  if (typeof module === 'object' && module.exports) module.exports = CraftCalc;
  else root.XivCraft = CraftCalc;
})(typeof globalThis !== 'undefined' ? globalThis : this);
