// Market & Crafting: Crafting. What a recipe takes and what it may earn: search the items a recipe makes, choose a
// recipe and a quantity, see every material down the tree, buy or craft each step, copy a shopping list, and see
// what the finished item sells for, from the same Universalis prices as Prices (one cache, one place). Crafting
// Watch ranks the current crafting tier. Loaded by js/market.js the first time Crafting opens, after js/recipes.js
// and js/craft-calc.js; never with the timers or Prices.
//
// What it promises, and the code keeps (js/craft-calc.js has the arithmetic):
// - Costs come only from market listings. A price that is not there is never zero and never guessed: a total
//   without it says how many it lacks. Vendor prices from the game data are shown as unverified and never enter a
//   total or a choice; a vendor behind a quest is shown as conditional.
// - Two costs, apart: what you pay (leaving out what you mark as owned or gathered) and what the materials are
//   worth (counting those at their market price). Gathered materials are never free.
// - A profit is an estimate against the lowest listing and the 4-day average sale, named by which, never a
//   promise. Whether a craft comes out HQ depends on the crafter.
// - Requests: a recipe asks for its whole tree's sorted ids in one request; Crafting Watch asks for fixed batches
//   of 100. Both are the same address for every visitor, and nothing off the market board is asked for.
// - Saved (ffxiv-timer:v1:crafting), once you change one: the purchase tax assumption, HQ or NQ, how materials are
//   priced. Quantities, recipe and buy-or-craft choices and owned marks last while the page is open.
(function (root) {
  'use strict';

  const TAX_MAX = 10;
  const PAGE = 50;
  const WATCH_PAGE = 20;
  const MIN_QUERY = 2;
  const STALE_MS = 3 * 86400000;
  const WATCH_SORTS = {
    profit: { label: 'Estimated profit, highest first', what: 'estimated profit per item' },
    margin: { label: 'Margin, highest first', what: 'estimated margin' },
    sales: { label: 'Sold a day, most first', what: 'units sold a day' },
    fresh: { label: 'Listing age, newest first', what: 'listing age' },
  };
  const BASIS = { lower: 'the lower of the lowest listing and the 4-day average sale', 'listing only': 'the lowest listing alone (there is no 4-day average sale)', 'sales only': 'the 4-day average sale alone (there is no listing now)' };
  const WHY = {
    'off-board': 'not sold on the market board', 'no-scope': 'choose a place', idle: 'not asked yet', pending: 'loading...',
    failed: 'not loaded', missing: 'not on the board there', empty: 'no market data', 'no-listing': 'no listing now', 'no-hq-listing': 'no HQ listing now',
  };

  /** What is saved, made safe: anything unexpected falls back to its default. */
  function sanitizePrefs(raw) {
    const s = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    return {
      tax: Number.isInteger(s.tax) && s.tax >= 0 && s.tax <= TAX_MAX ? s.tax : 0,
      quality: s.quality === 'nq' ? 'nq' : 'hq',
      materials: s.materials === 'hq' ? 'hq' : 'any',
    };
  }
  /** "12 %", "-3 %". */
  const pct = (f) => `${Math.round(f * 100)}%`;
  const signedGil = (gil, n) => (n < 0 ? `-${gil(-n)}` : gil(n));

  function mount(api) {
    const Calc = root.XivCraft, Catalog = root.XivCatalog, G = root.XivGathering, Format = root.FfxivFormat;
    const { el, Store, now, cat, gil, plural, setText } = api;
    const view = api.view;
    const $ = (id) => document.getElementById(id);

    const catalog = Calc.createCatalog(root.FFXIV_RECIPES, { items: Array.from({ length: cat.count }, (_, i) => ({ id: cat.ids[i], name: cat.names[i], hq: Boolean(cat.hq[i]) })) });
    const onBoard = (id) => cat.byId.has(id);
    const canBeHq = (id) => { const x = catalog.item(id); return Boolean(x && x.hq); };
    const nameOf = (id) => { const x = catalog.item(id); return x ? x.name : `Item ${id}`; };
    const craftable = new Set(catalog.outputs());
    const watch = Calc.watchList(catalog, onBoard);
    const nodesById = new Map(((root.FFXIV_GATHERING_DATA && root.FFXIV_GATHERING_DATA.nodes) || []).map((n) => [n.id, n]));
    const jobAbbr = (j) => catalog.jobs[j].abbr, jobName = (j) => catalog.jobs[j].name;

    let prefs = sanitizePrefs(Store.read('crafting', null));
    const savePrefs = () => Store.write('crafting', prefs);
    const st = { view: 'home', id: null, query: '', shown: PAGE, sort: 'profit', watchShown: WATCH_PAGE, notice: '', status: '' };
    const per = new Map(); // item id -> { recipe, quantity, force: Map(item -> 'buy' | 'craft'), closed: Set(path) }
    const owned = new Set(); // materials marked as owned or gathered, this page only
    let itemCtl = null, watchCtl = null;

    // ---- The place and the prices it has ----

    const place = () => api.scope();
    /** Crafting Watch ranks a data center or a region; for a world, its data center. */
    const watchPlace = () => { const s = place(); return s && s.kind === 'world' ? cat.scopeById.get(`dc:${s.dc}`) : s; };
    /** A quote (js/craft-calc.js) for one item at one place, from the market's cache. */
    function quoteOf(id, s) {
      if (!onBoard(id)) return { state: 'off-board' };
      if (!s) return { state: 'no-scope' };
      const e = api.entry(id, s);
      if (!e) return { state: api.pending(id, s) ? 'pending' : api.failure(id, s) ? 'failed' : 'idle' };
      if (e.missing) return { state: 'missing' };
      if (e.row.empty) return { state: 'empty' };
      const lv = api.levelOf(s), row = e.row, hq = canBeHq(id);
      const side = (q) => {
        const m = row[q].min[lv];
        if (!m) return null;
        const w = s.kind === 'world' ? s.worldIds[0] : m.worldId, at = row.uploads.get(w);
        return { price: m.price, worldId: w, at: Number.isFinite(at) ? at : null };
      };
      const last = (q) => { const r = row[q].recent[lv]; return r ? { price: r.price, at: r.at, worldId: r.worldId } : null; };
      const val = (v) => (v === undefined ? null : v);
      return {
        state: 'loaded', nq: side('nq'), hq: hq ? side('hq') : null,
        avg: { nq: val(row.nq.avg[lv]), hq: hq ? val(row.hq.avg[lv]) : null },
        velocity: { nq: val(row.nq.velocity[lv]), hq: hq ? val(row.hq.velocity[lv]) : null },
        recent: { nq: last('nq'), hq: hq ? last('hq') : null }, refreshFailed: api.failure(id, s) || null,
      };
    }
    const opts = (s, more) => ({ quote: (x) => quoteOf(x, s), canBeHq, materials: prefs.materials, tax: prefs.tax / 100, owned, ...more });
    // A short key for what a set of prices holds right now, so a calculation is redone only when they change.
    const stamp = (ids, s) => (s ? ids.map((id) => { const e = api.entry(id, s); return e ? e.at : api.pending(id, s) ? 'p' : api.failure(id, s) ? 'f' : '-'; }).join(',') : '');
    const memo = new Map();
    function remember(key, fn) { if (memo.has(key)) return memo.get(key); if (memo.size > 40) memo.clear(); const v = fn(); memo.set(key, v); return v; }

    // ---- The page ----

    const opt = (value, label, selected) => el('option', { value, selected: selected || null }, label);
    const btn = (key, label, attrs = {}) => el('button', { type: 'button', class: 'ghost small', 'data-ckey': key, ...attrs }, label);
    view.replaceChildren(
      el('div', { class: 'panel mk-controls cr-bar' },
        el('div', { class: 'mk-head' },
          el('p', { class: 'mk-lede' }, 'What a recipe takes and what it may earn, from the same market prices as Prices, with the age of every price.'),
          el('label', { class: 'mk-scope' }, el('span', null, 'Prices for'), el('select', { id: 'cr-scope', 'data-ckey': 'scope', 'aria-describedby': 'cr-scope-note' }))),
        el('p', { class: 'hint', id: 'cr-scope-note' }),
        el('div', { class: 'mk-filters cr-assume', role: 'group', 'aria-label': 'Assumptions' },
          el('span', { class: 'inline-select' }, el('span', { id: 'cr-q-label' }, 'Sell as'),
            el('span', { class: 'segmented', role: 'group', 'aria-labelledby': 'cr-q-label' },
              el('button', { type: 'button', class: 'toggle', 'data-cquality': 'hq', 'data-ckey': 'quality:hq', 'aria-pressed': 'false' }, 'HQ'),
              el('button', { type: 'button', class: 'toggle', 'data-cquality': 'nq', 'data-ckey': 'quality:nq', 'aria-pressed': 'false' }, 'NQ'))),
          el('label', { class: 'inline-select' }, el('span', null, 'Materials'),
            el('select', { id: 'cr-materials', 'data-ckey': 'materials' }, opt('any', 'Cheapest of NQ and HQ'), opt('hq', 'HQ where there is one'))),
          el('label', { class: 'inline-select' }, el('span', null, 'Purchase tax'),
            el('select', { id: 'cr-tax', 'data-ckey': 'tax', 'aria-describedby': 'cr-tax-note' }, Array.from({ length: TAX_MAX + 1 }, (_, k) => opt(String(k), `${k}%`))))),
        el('p', { class: 'hint', id: 'cr-tax-note' }, 'Purchase tax is an assumption you set (0% unless you change it): the market tax a buyer pays depends on the seller\'s retainer city and is not known for the cheapest listings. It is added to what you buy, not to what you own.')),
      el('div', { class: 'notice mk-notice', id: 'cr-notice', role: 'status', hidden: true }),
      el('div', { class: 'cr-home', id: 'cr-home' },
        el('section', { class: 'panel', id: 'cr-find', 'aria-labelledby': 'cr-find-title' },
          el('div', { class: 'panel-head' }, el('h2', { id: 'cr-find-title', tabindex: '-1' }, 'Find a recipe'),
            el('p', { class: 'hint' }, `${plural(craftable.size, 'item', 'items')} sold on the market board have a recipe in patch ${catalog.source.patch}.`)),
          el('div', { class: 'mk-find' },
            el('label', { class: 'search' }, el('span', { class: 'visually-hidden' }, 'Search the items a recipe makes'),
              el('input', { id: 'cr-q', type: 'search', maxlength: '60', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', enterkeyhint: 'search', placeholder: 'Search the items a recipe makes, by name or id', 'aria-describedby': 'cr-count' })),
            el('button', { type: 'button', class: 'ghost small', id: 'cr-q-clear', hidden: true }, 'Clear')),
          el('p', { class: 'mk-count', id: 'cr-count', role: 'status' }),
          el('ol', { class: 'mk-list cr-results', id: 'cr-results', 'aria-label': 'Items with a recipe' }),
          el('p', null, el('button', { type: 'button', class: 'ghost small', id: 'cr-more', hidden: true }, 'Show more'))),
        el('section', { class: 'panel cr-watch', id: 'cr-watch', 'aria-labelledby': 'cr-watch-title' },
          el('div', { class: 'panel-head' }, el('h2', { id: 'cr-watch-title' }, 'Crafting Watch'),
            el('p', { class: 'hint', id: 'cr-watch-hint' })),
          el('div', { class: 'mk-filters' },
            el('label', { class: 'inline-select' }, el('span', null, 'Sort'), el('select', { id: 'cr-sort', 'data-ckey': 'sort', 'aria-describedby': 'cr-watch-text' }, Object.entries(WATCH_SORTS).map(([k, s]) => opt(k, s.label))))),
          el('p', { class: 'mk-prices', id: 'cr-watch-prices' }, el('span', { id: 'cr-watch-status', role: 'status' }), el('span', { id: 'cr-watch-wait', 'aria-hidden': 'true' }), ' ',
            el('button', { type: 'button', class: 'link-btn', id: 'cr-watch-refresh', hidden: true }, 'Refresh prices')),
          el('p', { class: 'mk-scope-text', id: 'cr-watch-text' }),
          el('div', { id: 'cr-watch-body' }))),
      el('div', { class: 'cr-item', id: 'cr-item', hidden: true }),
      el('section', { class: 'panel mk-about', 'aria-labelledby': 'cr-about-title' },
        el('h2', { id: 'cr-about-title' }, 'About these estimates'),
        el('ul', { class: 'about-list' },
          el('li', null, 'Materials are priced at their lowest listing in the place you chose: the cheaper of NQ and HQ, since an HQ material can stand in for an NQ one, or only HQ when you choose HQ materials. A listing is an offer, and buying many may take more than the cheapest listing holds.'),
          el('li', null, 'You pay is what you buy, with the purchase tax you assume. Materials worth also counts what you mark as owned or gathered, at its market price: using it means not selling it. Neither is ever free, and a price that is missing is said, never taken as zero.'),
          el('li', null, 'The cheapest plan tries every buy-or-craft choice for the steps you have not decided, with the demand of every branch added up before rounding to whole crafts; what a craft makes beyond the need is listed as left over and counts for nothing.'),
          el('li', null, 'Vendor prices come from the game\'s data and are not verified, so they are shown but never used in a total or a choice. A vendor that sells only after a quest is shown as conditional.'),
          el('li', null, 'Estimated profit compares the material cost of one item with its lowest listing and with its 4-day average sale price, on the same quality. No seller fee is taken off: Universalis describes the market tax as paid by the buyer, which has not been checked in the game. An estimate is not a promise: a listing may not sell, and prices move.'),
          el('li', null, 'Whether a craft comes out HQ depends on your stats, gear and crafting actions, which this page cannot know; an HQ estimate assumes you reach HQ.'),
          el('li', null, `Recipes come from the game's own tables for patch ${catalog.source.patch}: every recipe that makes an item sold on the market board, on every job that has it. Timed nodes are the ones Timed gathering supports.`))));

    const jumps = [['cr-find', 'Find a recipe', 'home'], ['cr-watch', 'Crafting Watch', 'home'], ['cr-plan', 'Plan', 'item'], ['cr-list', 'Materials', 'item']];
    const nav = $('market-jump');
    if (nav) for (const [target, label, on] of jumps) nav.append(el('button', { type: 'button', 'data-craft-jump': target, 'data-craft-on': on, hidden: true }, label));

    // ---- Drawing ----

    let scopeShown = null;
    function draw() {
      if (view.hidden) return;
      const active = document.activeElement, focusKey = view.contains(active) && active.getAttribute('data-ckey');
      const s = place(), t = now();
      // The place's options are rebuilt only when the place changes, so a list being used stays as it is.
      if ((s ? s.id : '') !== scopeShown) { scopeShown = s ? s.id : ''; $('cr-scope').replaceChildren(...api.scopeOptions(!s)); }
      $('cr-scope').value = scopeShown;
      setText($('cr-scope-note'), s ? (s.kind === 'world' ? `One world: ${s.name}. A recipe's materials are priced on ${s.name} alone${st.view === 'home' ? `; Crafting Watch below uses ${s.dcName}'s data-center prices` : ''}.` : `Every world of ${s.name}: each material is priced at its cheapest world there, which may mean traveling.`) : 'Choose a data center, a world or a region to price recipes. The same choice as in Prices.');
      for (const b of view.querySelectorAll('[data-cquality]')) b.setAttribute('aria-pressed', String(b.dataset.cquality === prefs.quality));
      $('cr-materials').value = prefs.materials;
      $('cr-tax').value = String(prefs.tax);
      $('cr-notice').hidden = !st.notice;
      setText($('cr-notice'), st.notice);
      $('cr-home').hidden = st.view !== 'home';
      $('cr-item').hidden = st.view !== 'item';
      for (const b of document.querySelectorAll('[data-craft-jump]')) b.hidden = b.dataset.craftOn !== st.view;
      if (st.view === 'home') { drawResults(); drawWatch(s, t); } else drawItem(s, t);
      if (focusKey && document.activeElement !== active) { const n = view.querySelector(`[data-ckey="${CSS.escape(focusKey)}"]`); if (n) n.focus(); }
    }

    // ---- Search ----

    let matches = [];
    function search() {
      const q = Catalog.fold(st.query);
      matches = q.length >= MIN_QUERY ? Catalog.search(cat, { query: st.query, only: craftable }).indexes : [];
    }
    function drawResults() {
      const q = Catalog.fold(st.query);
      const list = matches.slice(0, st.shown);
      $('cr-results').replaceChildren(...list.map((i) => {
        const id = cat.ids[i], rs = catalog.recipesFor(id), c = cat.categories.get(cat.cat[i]);
        const levels = [...new Set(rs.map((r) => r.level))], stars = Math.max(...rs.map((r) => r.stars));
        return el('li', { class: 'mk-row cr-result', 'data-id': String(id) },
          el('span', { class: 'mk-item' },
            el('a', { class: 'mk-name', href: `#market/craft/${id}`, 'data-ckey': `result:${id}` }, cat.names[i]),
            el('span', { class: 'mk-meta' }, `${c ? c.name : 'Item'} · ${[...new Set(rs.map((r) => jobAbbr(r.job)))].join(', ')} · level ${levels.join(', ')}${stars ? ` ${'★'.repeat(stars)}` : ''}`,
              rs.some((r) => r.expert) ? el('span', { class: 'badge tag' }, 'expert') : null, cat.hq[i] ? el('span', { class: 'badge tag' }, 'can be HQ') : null)));
      }));
      const more = $('cr-more'), left = matches.length - list.length;
      more.hidden = left <= 0;
      more.textContent = `Show ${Math.min(PAGE, left)} more (${list.length} of ${matches.length} shown)`;
      $('cr-q-clear').hidden = !st.query;
      setText($('cr-count'), !q ? '' : q.length < MIN_QUERY ? 'Type at least 2 letters.' : `${plural(matches.length, 'item with a recipe matches', 'items with a recipe match')} "${st.query.trim()}".`);
    }

    // ---- Crafting Watch ----

    function watchState(wp) {
      // Owned marks are in the key: with a purchase tax they change what a plan's materials are worth.
      return remember(`watch|${wp.id}|${prefs.tax}|${prefs.quality}|${prefs.materials}|${[...owned].join()}|${stamp(watch.chunks.flat(), wp)}`, () => {
        const rows = Calc.watchRows(catalog, watch.outputs, opts(wp, { quality: prefs.quality, now: now(), staleMs: STALE_MS }));
        return { rows, at: now() };
      });
    }
    const sortValue = (r, k) => (k === 'profit' ? r.profit.headline.profit : k === 'margin' ? r.profit.headline.margin : k === 'sales' ? r.profit.velocity : r.profit.listing && r.profit.listing.at);
    function drawWatch(s, t) {
      const body = $('cr-watch-body');
      if (!s) {
        setText($('cr-watch-hint'), 'The current crafting tier, ranked by what crafting it may earn.');
        setText($('cr-watch-status'), 'Choose a place above to see Crafting Watch.');
        setText($('cr-watch-text'), ''); $('cr-watch-refresh').hidden = true;
        body.replaceChildren();
        return;
      }
      const wp = watchPlace();
      setText($('cr-watch-hint'), `${s.kind === 'world' ? `Data-center prices: Crafting Watch compares data centers and regions, so for ${s.name} it shows ${wp.name}, its data center, not ${s.name} alone. ` : ''}The current crafting tier: ${plural(watch.outputs.length, 'item', 'items')} made by level 100 recipes of 4 stars and by expert recipes, priced for one craft at the cheapest plan. A fixed list; the ranking is an estimate, not advice.`);
      $('cr-sort').value = st.sort;
      const ids = watch.chunks.flat();
      const loading = ids.some((id) => api.pending(id, wp)), failedN = ids.filter((id) => api.failure(id, wp) && !api.entry(id, wp)).length;
      const until = api.pausedUntil();
      const status = [];
      if (until && loading) status.push('Busy: the price service asked this page to wait. Prices already shown stay as they are.');
      else if (loading) status.push(`Loading Crafting Watch prices for ${wp.name}...`);
      const why = ids.map((id) => api.failure(id, wp)).find(Boolean);
      if (why) status.push(`${api.says(why)}, so ${failedN ? `${plural(failedN, 'item has', 'items have')} no price` : 'some prices could not be refreshed and show their last known values'}; nothing is estimated in their place.`);
      setText($('cr-watch-status'), status.join(' '));
      setText($('cr-watch-wait'), until && loading ? ` Asking again in ${Math.max(1, Math.ceil((until - t) / 1000))} s.` : '');
      $('cr-watch-prices').setAttribute('data-state', failedN ? 'failed' : loading ? 'loading' : 'ok');
      $('cr-watch-refresh').hidden = loading;
      $('cr-watch-refresh').textContent = failedN ? 'Try again' : 'Refresh prices';
      const { rows } = watchState(wp);
      const by = (k) => (a, b) => { const x = sortValue(a, k), y = sortValue(b, k); return (y === null || y === undefined ? -Infinity : y) - (x === null || x === undefined ? -Infinity : x) || a.item - b.item; };
      const ranked = rows.filter((r) => r.group === 'ranked').sort(by(st.sort)), thin = rows.filter((r) => r.group === 'thin').sort(by(st.sort));
      const unpriced = rows.filter((r) => r.group === 'unpriced').length;
      setText($('cr-watch-text'), ranked.length || thin.length
        ? `Ranked by ${WATCH_SORTS[st.sort].what} in ${wp.name}${s.kind === 'world' ? ' (data-center prices)' : ''}, among only the ${ranked.length} of ${watch.outputs.length} items with every price loaded, both a listing and a 4-day average sale, at least 1 sold a day, and listings and sales under 3 days old. ${thin.length ? `${plural(thin.length, 'item', 'items')} with thinner data ${thin.length === 1 ? 'follows' : 'follow'}, apart. ` : ''}${unpriced ? `${plural(unpriced, 'item is', 'items are')} not ranked: a price is missing.` : ''}`
        : loading ? '' : `Nothing can be ranked in ${wp.name} yet: ${plural(unpriced, 'item lacks', 'items lack')} a price.`);
      const head = el('div', { class: 'mk-row mk-head-row cr-wrow', 'aria-hidden': 'true' }, el('span', null, 'Item'), el('span', null, 'Estimated profit each'), el('span', null, 'Margin'), el('span', null, 'Sold a day'), el('span', null, 'Listing age'));
      const rowOf = (r) => {
        const p = r.profit, h = p.headline, at = p.listing && p.listing.at;
        const flags = [r.lowVolume ? 'few sales' : null, r.stale ? 'old data' : null, p.basis !== 'lower' ? p.basis : null].filter(Boolean);
        return el('li', { class: `mk-row cr-wrow${r.group === 'thin' ? ' is-thin' : ''}`, 'data-id': String(r.item) },
          el('span', { class: 'mk-item' },
            el('a', { class: 'mk-name', href: `#market/craft/${r.item}`, 'data-ckey': `watch:${r.item}`, 'data-cpick': r.recipe ? String(r.recipe) : null }, nameOf(r.item)),
            el('span', { class: 'mk-meta' }, `${jobAbbr(r.job)} · sold as ${r.quality.toUpperCase()} · materials ${gil(r.cost)} each`, ...flags.map((f) => el('span', { class: 'badge tag cr-flag' }, f)))),
          cell('Estimated profit each', 'Profit', el('span', { class: `mk-gil${h.profit < 0 ? ' cr-loss' : ''}` }, signedGil(gil, h.profit)), el('span', { class: 'mk-where' }, `vs ${gil(h.ref)}`)),
          cell('Margin', 'Margin', pct(h.margin)),
          cell('Sold a day', 'Sold', api.perDay(p.velocity) || api.none('no sales on record')),
          cell('Listing age', 'Listing age', Number.isFinite(at) ? api.ageCell(at, t) : api.none('no time')));
      };
      // Each figure named for a screen reader, as in Prices; the short label shows only on a phone, so it is hidden.
      const cell = (label, short, ...kids) => el('span', { class: 'mk-cell' }, el('span', { class: 'visually-hidden' }, `${label}: `), el('span', { class: 'mk-k', 'aria-hidden': 'true' }, short), ...kids);
      const shownRanked = ranked.slice(0, st.watchShown);
      // While its first prices load, the list keeps the room its first rows will take (css/crafting.css), so the
      // page below does not jump when they come.
      body.toggleAttribute('data-loading', loading && !ranked.length && !thin.length);
      body.replaceChildren(
        ranked.length ? head : el('span'),
        ranked.length ? el('ol', { class: 'mk-list', 'aria-label': 'Crafting Watch, ranked' }, shownRanked.map(rowOf)) : el('span'),
        ranked.length > shownRanked.length ? el('p', null, btn('watch-more', `Show ${Math.min(WATCH_PAGE, ranked.length - shownRanked.length)} more`, { 'data-cwatch-more': '' })) : el('span'),
        thin.length ? el('h3', { class: 'cr-sub' }, 'Thinner data: few sales, old prices, or one reference only') : el('span'),
        thin.length ? el('ol', { class: 'mk-list', 'aria-label': 'Crafting Watch, thinner data' }, thin.map(rowOf)) : el('span'));
    }

    // ---- One item: "#market/craft/<id>" ----

    function stateOf(id) {
      if (!per.has(id)) {
        const rs = catalog.recipesFor(id);
        per.set(id, { recipe: rs.length ? rs[0].id : null, quantity: 1, force: new Map(), closed: new Set() });
      }
      return per.get(id);
    }
    const qualityOf = (id) => (prefs.quality === 'hq' && canBeHq(id) ? 'hq' : 'nq');
    function compute(id, s) {
      const v = stateOf(id), r = catalog.recipe(v.recipe), q = v.quantity;
      const ids = Calc.priceIds(catalog, id, onBoard);
      const key = `item|${id}|${r.id}|${q}|${[...v.force].join()}|${[...owned].join()}|${prefs.tax}|${prefs.materials}|${prefs.quality}|${s ? s.id : ''}|${stamp(ids, s)}`;
      return remember(key, () => {
        const base = opts(s, { recipes: { [id]: r.id }, jobs: [r.job] });
        const best = Calc.cheapest(catalog, id, q, base);
        const mine = v.force.size ? Calc.cheapest(catalog, id, q, { ...base, force: v.force }) : best;
        const plan = Calc.costPlan(catalog, id, q, { ...base, buy: mine.buy });
        const quality = qualityOf(id), root = quoteOf(id, s);
        const finished = root.state === 'loaded' && root[quality] ? root[quality].price * q * (1 + prefs.tax / 100) : null;
        const strategies = [
          { key: 'finished', label: `Buy ${q === 1 ? 'it' : 'them'} finished (${quality.toUpperCase()})`, cash: finished, value: finished, missing: finished === null ? 1 : 0 },
          { key: 'direct', label: 'Craft, buying every direct material', ...summary(Calc.costPlan(catalog, id, q, { ...base, buy: 'all' })) },
          { key: 'all', label: 'Craft every step you can', ...summary(Calc.costPlan(catalog, id, q, { ...base, buy: [] })) },
          { key: 'cheapest', label: 'Cheapest plan found', ...summary(v.force.size ? Calc.costPlan(catalog, id, q, { ...base, buy: best.buy }) : plan) },
        ];
        if (v.force.size) strategies.push({ key: 'yours', label: 'Your plan', ...summary(plan) });
        const alternatives = catalog.recipesFor(id).map((x) => {
          const o = opts(s, { recipes: { [id]: x.id }, jobs: [x.job] });
          const c = Calc.cheapest(catalog, id, x.yield, o);
          const p = Calc.costPlan(catalog, id, x.yield, { ...o, buy: c.buy });
          return { recipe: x, perUnit: p.perUnit, missing: p.value.missing };
        });
        return { r, q, ids, best, mine, plan, quality, root, strategies, alternatives, profit: Calc.profitOf(root, quality, plan.perUnit) };
      });
    }
    function summary(p) { return { cash: p.cash.missing ? null : p.cash.total, value: p.value.missing ? null : p.value.total, cashKnown: p.cash.total, valueKnown: p.value.total, missing: p.value.missing }; }

    function drawItem(s, t) {
      const box = $('cr-item'), id = st.id;
      const header = (title) => el('div', { class: 'cr-crumbs' }, el('a', { class: 'ghost small', href: '#market/craft', 'data-ckey': 'home' }, 'Crafting home'), ' ', el('h2', { class: 'cr-title', id: 'cr-title', tabindex: '-1', 'data-ckey': 'title' }, title));
      if (!onBoard(id)) {
        box.replaceChildren(header('Not on the market board'), el('p', { class: 'notice' }, `That link names an item that is not on the market board (item list from patch ${cat.source.patch}). Crafting covers items sold there. Nothing of yours was changed.`));
        return;
      }
      if (!craftable.has(id)) {
        box.replaceChildren(header(nameOf(id)), el('p', { class: 'notice' }, `No recipe makes ${nameOf(id)}: it is bought, gathered or obtained another way. `, el('a', { href: `#market/item/${id}`, 'aria-haspopup': 'dialog' }, 'See its prices'), '.'));
        return;
      }
      const v = stateOf(id), x = compute(id, s), r = x.r;
      const steps = new Map(x.plan.plan.steps.map((p) => [p.item, p])), lines = new Map(x.plan.lines.map((l) => [l.item, l]));
      const hqCan = canBeHq(id);
      const facts = [
        `${jobName(r.job)} (${jobAbbr(r.job)}), level ${r.level}${r.stars ? ` ${'★'.repeat(r.stars)}` : ''}`, `recipe level ${r.rlvl}`,
        r.yield > 1 ? `makes ${r.yield} a craft` : 'makes 1 a craft',
      ];
      const badges = [r.expert ? 'Expert recipe' : null, r.specialist ? 'Specialists only' : null, r.book ? `Needs ${catalog.bookName(r.book) || 'a master recipe book'}` : null,
        r.craftsmanship || r.control ? `Needs at least ${[r.craftsmanship ? `${r.craftsmanship} craftsmanship` : null, r.control ? `${r.control} control` : null].filter(Boolean).join(' and ')}` : null, r.quickSynth ? 'Quick synthesis' : null, hqCan ? (r.canHq ? 'Can be HQ' : 'No HQ from this recipe') : 'No HQ version'].filter(Boolean);
      const kids = [
        header(nameOf(id)),
        el('p', { class: 'mk-badges' }, ...badges.map((b) => el('span', { class: 'badge' }, b)), ' ', el('a', { class: 'ghost small', href: `#market/item/${id}`, 'aria-haspopup': 'dialog', 'data-ckey': 'prices' }, 'Prices and listings')),
        el('p', { class: 'cr-facts' }, facts.join(' · ')),
      ];
      // Recipe choice, when there is more than one, with what each costs for one craft's worth.
      if (x.alternatives.length > 1) {
        kids.push(el('fieldset', { class: 'cr-recipes' }, el('legend', null, `Recipe (${x.alternatives.length})`),
          ...x.alternatives.map((a) => el('label', { class: 'cr-recipe' },
            el('input', { type: 'radio', name: 'cr-recipe', value: String(a.recipe.id), checked: a.recipe.id === r.id ? true : null, 'data-crecipe': String(a.recipe.id), 'data-ckey': `recipe:${a.recipe.id}` }),
            el('span', null, `${jobName(a.recipe.job)}, level ${a.recipe.level}${a.recipe.stars ? ` ${'★'.repeat(a.recipe.stars)}` : ''}: `,
              a.recipe.ingredients.map((g) => `${g.amount} ${nameOf(g.item)}`).join(', '),
              el('span', { class: 'mk-where' }, a.missing ? ` · ${plural(a.missing, 'price', 'prices')} missing` : Number.isFinite(a.perUnit) ? ` · materials ${gil(a.perUnit)} each` : ''))))));
      }
      kids.push(el('p', { class: 'cr-qty' },
        el('label', { class: 'inline-select' }, el('span', null, 'How many'),
          el('input', { type: 'number', id: 'cr-qty', min: '1', max: String(Calc.MAX_QUANTITY), step: '1', inputmode: 'numeric', value: String(v.quantity), 'data-ckey': 'qty' })),
        ' ', el('span', { class: 'hint' }, r.yield > 1 ? `${plural(Math.ceil(v.quantity / r.yield), 'craft', 'crafts')} of ${r.yield}` : plural(v.quantity, 'craft', 'crafts')),
        v.force.size ? el('button', { type: 'button', class: 'link-btn cr-reset', 'data-creset': '', 'data-ckey': 'reset' }, 'Back to the cheapest plan') : null));
      kids.push(priceLine(x.ids, s, t));
      if (!s) kids.push(el('p', { class: 'notice' }, 'Choose a place above to price this recipe. The materials below are what it takes, whatever they cost.'));
      // The plans side by side.
      kids.push(el('section', { class: 'panel', id: 'cr-plan', 'aria-labelledby': 'cr-plan-title' },
        el('div', { class: 'panel-head' }, el('h3', { id: 'cr-plan-title' }, `${v.quantity} ${nameOf(id)}: buy or craft`),
          el('p', { class: 'hint' }, 'You pay leaves out what you mark as owned or gathered; materials worth counts it at its market price.')),
        el('div', { class: 'table-wrap' }, el('table', { class: 'mk-table cr-plans' },
          el('thead', null, el('tr', null, el('th', { scope: 'col' }, 'Plan'), el('th', { scope: 'col', class: 'num' }, 'You pay'), el('th', { scope: 'col', class: 'num' }, 'Materials worth'), el('th', { scope: 'col', class: 'num' }, 'Each'))),
          el('tbody', null, x.strategies.map((p) => el('tr', { class: p.key === (v.force.size ? 'yours' : 'cheapest') ? 'is-current' : null, 'data-plan': p.key },
            el('th', { scope: 'row' }, p.label, p.key === (v.force.size ? 'yours' : 'cheapest') ? el('span', { class: 'badge tag' }, 'shown below') : null),
            el('td', { class: 'num' }, money(p.cash, p.cashKnown, p.missing)),
            el('td', { class: 'num' }, money(p.value, p.valueKnown, p.missing)),
            el('td', { class: 'num' }, p.value === null ? api.none('unknown') : gil(p.value / v.quantity)))))))));
      kids.push(profitBlock(id, x, s, t));
      kids.push(el('section', { class: 'panel', 'aria-labelledby': 'cr-tree-title' },
        el('div', { class: 'panel-head' }, el('h3', { id: 'cr-tree-title' }, 'What it takes'),
          el('p', { class: 'hint' }, 'Each line: how many per craft of the line above, and what the whole plan needs. Choose Buy or Craft for any step; unchosen steps follow the cheapest plan.')),
        el('ul', { class: 'cr-tree' }, treeNode(x.plan.plan.tree, '0', 0, { steps, lines, v, x, s, t }))));
      kids.push(shoppingList(id, x, s, t));
      box.replaceChildren(...kids);
    }
    function money(full, known, missing) {
      if (full !== null) return gil(full);
      if (!missing) return api.none('unknown');
      return el('span', null, known ? `at least ${gil(known)}` : api.none('unknown'), el('span', { class: 'mk-where' }, ` ${plural(missing, 'price', 'prices')} missing`));
    }
    function priceLine(ids, s, t) {
      if (!s) return el('span');
      const loading = ids.filter((id) => api.pending(id, s)).length, failedN = ids.filter((id) => api.failure(id, s) && !api.entry(id, s)).length, until = api.pausedUntil();
      const parts = [];
      if (until && loading) parts.push('Busy: the price service asked this page to wait. Prices already shown stay as they are.');
      else if (loading) parts.push(`Loading prices for ${plural(loading, 'item', 'items')} in ${s.name}...`);
      const why = ids.map((id) => api.failure(id, s)).find(Boolean);
      if (why) parts.push(`${api.says(why)}, so ${failedN ? `${plural(failedN, 'item has', 'items have')} no price here` : 'some prices could not be refreshed and show their last known values'}. Nothing is estimated in its place.`);
      if (!loading && !why) parts.push(`Prices in ${s.name}: each material at its lowest listing, with how long ago Universalis last received that world's board.`);
      return el('p', { class: 'mk-prices cr-prices', 'data-state': failedN ? 'failed' : loading ? 'loading' : 'ok' },
        el('span', { role: 'status' }, parts.join(' ')), el('span', { 'aria-hidden': 'true' }, until && loading ? ` Asking again in ${Math.max(1, Math.ceil((until - t) / 1000))} s.` : ''), ' ',
        loading ? null : el('button', { type: 'button', class: 'link-btn', 'data-crefresh': '', 'data-ckey': 'refresh' }, failedN ? 'Try again' : 'Refresh prices'));
    }
    function profitBlock(id, x, s, t) {
      const p = x.profit, Q = x.quality.toUpperCase(), cost = x.plan.perUnit;
      const where = (w) => (s && s.kind === 'world' ? s.name : api.worldName(w) || 'a world');
      const tiles = el('div', { class: 'mk-stats cr-stats' },
        api.stat('cr-stat-min', `Lowest ${Q} listing`, p.listing ? gil(p.listing.price) : api.none('no listing now'), p.listing ? `${where(p.listing.worldId)}, seen ${Number.isFinite(p.listing.at) ? api.ago(t - p.listing.at) : 'at an unknown time'}` : ''),
        api.stat('cr-stat-avg', `4-day average ${Q} sale`, p.average ? gil(p.average) : api.none('none'), p.average ? 'of completed sales' : ''),
        api.stat('cr-stat-vel', `${Q} sold a day`, p.velocity !== null ? api.perDay(p.velocity) : api.none('none'), p.recent ? `last sale ${gil(p.recent.price)}, ${Number.isFinite(p.recent.at) ? api.ago(t - p.recent.at) : 'at an unknown time'}` : 'no sale on record'),
        api.stat('cr-stat-cost', 'Materials, each', Number.isFinite(cost) ? gil(cost) : api.none(x.plan.value.missing ? `${plural(x.plan.value.missing, 'price', 'prices')} missing` : 'unknown'), Number.isFinite(cost) ? `you pay ${x.plan.cash.missing ? 'unknown' : gil(x.plan.cash.total / x.q)} each` : ''));
      const est = (label, e) => el('li', null, `${label}: `, e ? el('strong', { class: e.profit < 0 ? 'cr-loss' : null }, `${signedGil(gil, e.profit)} each (${pct(e.margin)} of ${gil(e.ref)})`) : api.none('not known'));
      const warn = [];
      if (!s) warn.push('Choose a place to see what it sells for.');
      else {
        if (!Number.isFinite(cost)) warn.push(`The material cost is not complete (${plural(x.plan.value.missing, 'price', 'prices')} missing), so no profit is estimated.`);
        if (p.basis && p.basis !== 'lower') warn.push(`The estimate rests on ${BASIS[p.basis]}.`);
        if (p.velocity !== null && p.velocity < 1) warn.push(`Few ${Q} sales: under 1 a day lately. A listing may wait a long time.`);
        else if (p.velocity === null && x.root.state === 'loaded') warn.push(`No ${Q} sales in the last 4 days that Universalis knows of. A listing may wait a long time.`);
        if (p.listing && Number.isFinite(p.listing.at) && t - p.listing.at > STALE_MS) warn.push('The lowest listing is old data: it may be gone.');
        if (x.plan.oldest !== null && t - x.plan.oldest > STALE_MS) warn.push('Some material prices are old data.');
      }
      if (x.quality === 'hq') warn.push('Sold as HQ: reaching HQ depends on your stats, gear and crafting actions, which this page cannot know.');
      else if (canBeHq(id)) warn.push('Sold as NQ. Switch Sell as to HQ for HQ prices.');
      return el('section', { class: 'panel', 'aria-labelledby': 'cr-profit-title' },
        el('div', { class: 'panel-head' }, el('h3', { id: 'cr-profit-title' }, `What one sells for (${Q}), and what it may earn`),
          el('p', { class: 'hint' }, 'Listings are offers, not sales; the 4-day average is of sales that happened. An estimate, never a promise.')),
        tiles,
        el('ul', { class: 'about-list cr-est' },
          el('li', null, 'Estimated profit, ', p.basis ? `on ${BASIS[p.basis]}` : 'not known', ': ', p.headline ? el('strong', { class: p.headline.profit < 0 ? 'cr-loss' : null }, `${signedGil(gil, p.headline.profit)} each, margin ${pct(p.headline.margin)}`) : api.none('needs a material cost and a sale reference')),
          est('Against the lowest listing', p.estimates.listing),
          est('Against the 4-day average sale', p.estimates.average)),
        warn.length ? el('ul', { class: 'about-list cr-warn' }, warn.map((w) => el('li', null, w))) : null);
    }
    function treeNode(n, path, depth, c) {
      const id = n.item, step = c.steps.get(id), line = c.lines.get(id), canChoose = depth > 0 && catalog.craftable(id);
      const chosen = c.v.force.get(id), crafted = n.action === 'craft', open = !c.v.closed.has(path);
      const head = [];
      if (crafted && n.children && n.children.length && depth > 0) {
        head.push(el('button', { type: 'button', class: 'cr-open', 'aria-expanded': String(open), 'aria-controls': `cr-sub-${path}`, 'aria-label': `${open ? 'Hide' : 'Show'} what ${nameOf(id)} takes`, 'data-copen': path, 'data-ckey': `open:${path}` }, open ? '▾' : '▸'));
      } else head.push(el('span', { class: 'cr-open-gap', 'aria-hidden': 'true' }));
      head.push(el('span', { class: 'cr-amt' }, depth ? `${n.amount} ×` : `${n.amount}`), ' ',
        onBoard(id) ? el('a', { class: 'mk-name', href: `#market/item/${id}`, 'aria-haspopup': 'dialog', 'data-ckey': `name:${path}` }, nameOf(id)) : el('span', { class: 'mk-name' }, nameOf(id)));
      const info = [];
      if (crafted) {
        const rr = catalog.recipe(n.recipe);
        info.push(`craft: ${jobAbbr(rr.job)} level ${rr.level}, ${plural(step.crafts, 'craft', 'crafts')}${rr.yield > 1 ? ` of ${rr.yield}` : ''} for ${step.need}${step.surplus ? `, ${step.surplus} left over` : ''}`);
      } else if (line) info.push(...materialInfo(line, c.s, c.t));
      const choose = canChoose ? el('span', { class: 'segmented cr-choose', role: 'group', 'aria-label': `Buy or craft ${nameOf(id)}` },
        ...['craft', 'buy'].map((a) => el('button', { type: 'button', class: 'toggle', 'aria-pressed': String(a === 'craft' ? crafted : !crafted), 'data-cact': `${id}:${a}`, 'data-ckey': `act:${path}:${a}` }, a === 'craft' ? 'Craft' : 'Buy')),
        chosen ? el('span', { class: 'hint cr-chosen' }, 'your choice') : null) : null;
      return el('li', { class: `cr-node${crafted ? ' is-craft' : ''}` },
        el('div', { class: 'cr-line' }, el('span', { class: 'cr-head' }, ...head), choose, el('span', { class: 'cr-info' }, ...info)),
        crafted && n.children && n.children.length && (open || depth === 0)
          ? el('ul', { class: 'cr-tree', id: `cr-sub-${path}` }, n.children.map((k, i) => treeNode(k, `${path}.${i}`, depth + 1, c))) : null);
    }
    /** What a material line says: its price or why there is none, then vendor and timed-node notes. */
    function materialInfo(line, s, t) {
      const out = [];
      const u = line.unit;
      if (u) {
        out.push(el('span', null, `${line.quantity} needed, ${gil(u.price)} each`, canBeHq(line.item) ? ` (${u.quality.toUpperCase()})` : '', s && s.kind !== 'world' && api.worldName(u.worldId) ? ` at ${api.worldName(u.worldId)}` : '', ', '), Number.isFinite(u.at) ? api.ageCell(u.at, t) : api.none('no time'));
      } else out.push(el('span', null, `${line.quantity} needed, `, api.none(WHY[line.why] || 'no price')));
      if (line.owned) out.push(el('span', { class: 'badge tag' }, 'owned or gathered'));
      for (const n of notes(line.item, t)) out.push(n);
      return out;
    }
    function notes(id, t) {
      const out = [];
      const x = catalog.item(id);
      if (x && !x.onBoard) out.push(el('span', { class: 'cr-note' }, x.untradable ? 'Cannot be bought or traded: you have to obtain it yourself.' : 'Not sold on the market board.'));
      const vend = catalog.vendor(id);
      if (vend) out.push(el('span', { class: 'cr-note' }, vend.gated ? 'An NPC sells it after a quest, so whether you can buy it depends on your progress. ' : 'An NPC vendor sells it. ',
        `The game data lists ${gil(vend.priceUnverified)}`, el('span', { class: 'badge unverified' }, 'unverified'), ', not used in these totals.'));
      const node = timedNode(id, t);
      if (node) {
        out.push(el('span', { class: 'cr-note cr-timed', 'data-ctimed': String(id) }, timedText(node, t), ' ',
          el('button', { type: 'button', class: 'link-btn', 'data-cnode': `${node.node.id}:${id}`, 'data-ckey': `node:${id}` }, 'Show in Timed gathering')));
      }
      return out;
    }
    /** Of the supported timed nodes that give an item, the one up now or next up soonest. */
    function timedNode(id, t) {
      let best = null;
      for (const nid of catalog.timedNodes(id)) {
        const n = nodesById.get(nid);
        if (!n || !G) continue;
        const s = G.status(n, t);
        if (!best || (s.up && !best.s.up) || (s.up === best.s.up && (s.up ? s.end > best.s.end : s.start < best.s.start))) best = { node: n, s };
      }
      return best;
    }
    function timedText(b, t) {
      const n = b.node, where = `${n.zone} (${n.coords.map((c) => c.toFixed(1)).join(', ')})`;
      return b.s.up ? `Timed node up now: ${where}, ends in ${Format.countdown(b.s.end - t)}.` : `Timed node next up ${api.when(b.s.start)} (in ${Format.countdown(b.s.start - t)}): ${where}.`;
    }
    function shoppingList(id, x, s, t) {
      const rows = x.plan.lines;
      const where = (u) => (!u ? '' : s && s.kind === 'world' ? s.name : api.worldName(u.worldId) || '');
      const surplus = x.plan.plan.surplus;
      return el('section', { class: 'panel', id: 'cr-list', 'aria-labelledby': 'cr-list-title' },
        el('div', { class: 'panel-head' }, el('h3', { id: 'cr-list-title' }, 'Shopping list'),
          el('p', { class: 'hint' }, 'What the plan above has you buy or gather, added up across every branch. Tick what you already have or will gather yourself: it leaves You pay, not Materials worth.')),
        el('div', { class: 'table-wrap' }, el('table', { class: 'mk-table cr-shop', 'aria-labelledby': 'cr-list-title' },
          el('thead', null, el('tr', null, el('th', { scope: 'col' }, 'Have'), el('th', { scope: 'col' }, 'Material'), el('th', { scope: 'col', class: 'num' }, 'Qty'),
            el('th', { scope: 'col', class: 'num' }, 'Each'), el('th', { scope: 'col' }, 'Where'), el('th', { scope: 'col', class: 'num' }, 'You pay'))),
          el('tbody', null, rows.map((l) => el('tr', { 'data-id': String(l.item) },
            el('td', null, el('input', { type: 'checkbox', checked: l.owned ? true : null, 'data-cown': String(l.item), 'data-ckey': `own:${l.item}`, 'aria-label': `I have or will gather ${nameOf(l.item)}` })),
            el('th', { scope: 'row' }, nameOf(l.item), l.craftable ? el('span', { class: 'badge tag' }, 'could be crafted') : null),
            el('td', { class: 'num' }, l.quantity.toLocaleString('en-US')),
            el('td', { class: 'num' }, l.unit ? `${gil(l.unit.price)}${canBeHq(l.item) ? ` ${l.unit.quality.toUpperCase()}` : ''}` : api.none(WHY[l.why] || 'no price')),
            el('td', null, where(l.unit)),
            el('td', { class: 'num' }, l.owned ? api.none('owned') : l.cash === null ? api.none('unknown') : gil(l.cash))))),
          el('tfoot', null,
            el('tr', null, el('th', { scope: 'row', colspan: '5' }, 'You pay'), el('td', { class: 'num' }, money(x.plan.cash.missing ? null : x.plan.cash.total, x.plan.cash.total, x.plan.cash.missing))),
            el('tr', null, el('th', { scope: 'row', colspan: '5' }, 'Materials worth'), el('td', { class: 'num' }, money(x.plan.value.missing ? null : x.plan.value.total, x.plan.value.total, x.plan.value.missing)))))),
        surplus.length ? el('p', { class: 'hint' }, `Left over from whole crafts: ${surplus.map((p) => `${p.quantity} ${nameOf(p.item)}`).join(', ')}.`) : null,
        el('p', { class: 'mk-actions' }, el('button', { type: 'button', class: 'ghost small', 'data-ccopy': '', 'data-ckey': 'copy' }, 'Copy the list'), ' ',
          el('span', { class: 'hint', id: 'cr-copy-status', role: 'status' }, st.status)));
    }
    /** The shopping list as plain text, for the clipboard. */
    function listText(id) {
      const s = place(), x = compute(id, s), t = now(), q = stateOf(id).quantity;
      const where = (u) => (!u ? '' : s && s.kind === 'world' ? '' : api.worldName(u.worldId) ? ` at ${api.worldName(u.worldId)}` : '');
      const out = [`Shopping list for ${q} ${nameOf(id)} (FFXIV Timer, ${s ? s.name : 'no place chosen'})`];
      for (const l of x.plan.lines) {
        const price = l.unit ? `${gil(l.unit.price)} each${canBeHq(l.item) ? ` ${l.unit.quality.toUpperCase()}` : ''}${where(l.unit)}, listing seen ${Number.isFinite(l.unit.at) ? api.ago(t - l.unit.at) : 'at an unknown time'}` : (WHY[l.why] || 'no price');
        out.push(`- ${l.quantity} ${nameOf(l.item)}: ${l.owned ? 'have it' : price}`);
      }
      const total = x.plan.cash.missing ? `at least ${gil(x.plan.cash.total)} (${plural(x.plan.cash.missing, 'price', 'prices')} missing)` : gil(x.plan.cash.total);
      out.push(`You pay: ${total}${prefs.tax ? `, with ${prefs.tax}% purchase tax assumed` : ''}.`);
      if (x.plan.plan.surplus.length) out.push(`Left over: ${x.plan.plan.surplus.map((p) => `${p.quantity} ${nameOf(p.item)}`).join(', ')}.`);
      out.push('Estimate from Universalis listings via radmagelabs.com; prices change.');
      out.push(`${api.canonical}#market/craft/${id}`);
      return out.join('\n');
    }

    // ---- Prices for what is on screen ----

    function load(force) {
      const s = place();
      if (!s || view.hidden) return;
      if (st.view === 'item' && onBoard(st.id) && craftable.has(st.id)) {
        if (itemCtl) itemCtl.abort();
        itemCtl = new AbortController();
        const sig = itemCtl.signal;
        api.loadSet(Calc.priceIds(catalog, st.id, onBoard), sig, force, s).then(() => { if (!sig.aborted) draw(); });
      }
      if (st.view === 'home') {
        const wp = watchPlace();
        if (!watchCtl || watchCtl.signal.aborted) watchCtl = new AbortController();
        const sig = watchCtl.signal;
        for (const chunk of watch.chunks) api.loadSet(chunk, sig, force, wp).then(() => { if (!sig.aborted) draw(); });
      }
      draw();
    }

    // ---- Controls ----

    function route(r) {
      if (r.view === 'craft-item') { st.view = 'item'; st.id = r.id; st.notice = ''; st.status = ''; }
      else { st.view = 'home'; st.notice = r.view === 'craft-notice' ? 'That link to Crafting could not be read. Nothing of yours was changed.' : ''; }
      if (st.view !== 'item' && itemCtl) { itemCtl.abort(); itemCtl = null; }
      if (st.view !== 'home' && watchCtl) { watchCtl.abort(); watchCtl = null; }
      load(false);
      const h = st.view === 'item' ? $('cr-title') : $('cr-find-title');
      if (h) h.focus();
    }
    let typing = 0;
    $('cr-q').addEventListener('input', (ev) => {
      $('cr-q-clear').hidden = !ev.target.value;
      clearTimeout(typing);
      typing = setTimeout(() => { st.query = ev.target.value; st.shown = PAGE; search(); draw(); }, 100);
    });
    $('cr-q').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { clearTimeout(typing); st.query = ev.target.value; st.shown = PAGE; search(); draw(); } });
    view.addEventListener('click', async (ev) => {
      const a = ev.target.closest ? ev.target.closest('a[href^="#market/craft"]') : null;
      if (a && !ev.defaultPrevented && ev.button === 0 && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey && !ev.altKey) {
        ev.preventDefault();
        // From Crafting Watch: open the recipe its row was priced with (an item with several recipes).
        const pick = Number(a.dataset.cpick), item = Number(a.getAttribute('href').split('/')[2]);
        if (pick && craftable.has(item) && catalog.recipesFor(item).some((r) => r.id === pick)) {
          const v = stateOf(item);
          if (v.recipe !== pick) { v.recipe = pick; v.force.clear(); v.closed.clear(); }
        }
        api.go(a.getAttribute('href'));
        return;
      }
      const b = ev.target.closest ? ev.target.closest('button') : null;
      if (!b) return;
      const d = b.dataset, v = st.id !== null ? stateOf(st.id) : null;
      // "Copied" is about the list as it was: any other change clears it, so a redraw does not say it again.
      if (d.ccopy === undefined) st.status = '';
      if (d.cquality) { prefs = { ...prefs, quality: d.cquality }; savePrefs(); draw(); }
      else if (b.id === 'cr-q-clear') { st.query = ''; $('cr-q').value = ''; search(); draw(); $('cr-q').focus(); }
      else if (b.id === 'cr-more') { st.shown += PAGE; draw(); }
      else if (d.cwatchMore !== undefined) { st.watchShown += WATCH_PAGE; draw(); }
      else if (b.id === 'cr-watch-refresh' || d.crefresh !== undefined) load(true);
      else if (d.cact && v) { const [item, act] = d.cact.split(':'); v.force.set(Number(item), act); draw(); }
      else if (d.creset !== undefined && v) { v.force.clear(); draw(); }
      else if (d.copen && v) { if (v.closed.has(d.copen)) v.closed.delete(d.copen); else v.closed.add(d.copen); draw(); }
      else if (d.cnode) { const [node, item] = d.cnode.split(':').map(Number); showNode(node, item); }
      else if (d.ccopy !== undefined && st.view === 'item') {
        const ok = await api.copyText(listText(st.id));
        st.status = ok ? 'Copied the shopping list.' : 'Copying did not work here.';
        setText($('cr-copy-status'), st.status);
      }
    });
    view.addEventListener('change', (ev) => {
      const n = ev.target, v = st.id !== null ? stateOf(st.id) : null;
      st.status = '';
      if (n.id === 'cr-scope') { const s = cat.scopeById.get(n.value); if (s) api.setScope(s); }
      else if (n.id === 'cr-materials') { prefs = { ...prefs, materials: n.value === 'hq' ? 'hq' : 'any' }; savePrefs(); draw(); }
      else if (n.id === 'cr-tax') { const k = Number(n.value); if (Number.isInteger(k) && k >= 0 && k <= TAX_MAX) { prefs = { ...prefs, tax: k }; savePrefs(); } draw(); }
      else if (n.id === 'cr-sort') { if (WATCH_SORTS[n.value]) { st.sort = n.value; st.watchShown = WATCH_PAGE; } draw(); }
      else if (n.dataset.crecipe && v) { v.recipe = Number(n.dataset.crecipe); v.force.clear(); v.closed.clear(); draw(); }
      else if (n.id === 'cr-qty' && v) {
        const k = Number(n.value);
        v.quantity = Number.isInteger(k) && k >= 1 && k <= Calc.MAX_QUANTITY ? k : Math.min(Calc.MAX_QUANTITY, Math.max(1, Math.round(k) || 1));
        draw();
      } else if (n.dataset.cown) { const id = Number(n.dataset.cown); if (n.checked) owned.add(id); else owned.delete(id); draw(); }
    });
    // A section link in the header: scroll there; Find a recipe also takes the focus to the search.
    document.addEventListener('click', (ev) => {
      const b = ev.target.closest ? ev.target.closest('[data-craft-jump]') : null;
      if (!b) return;
      const n = $(b.dataset.craftJump);
      if (!n || n.closest('[hidden]')) return;
      n.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
      if (b.dataset.craftJump === 'cr-find') $('cr-q').focus({ preventScroll: true });
    });
    window.addEventListener('storage', (ev) => { if (ev.key === `${Store.PREFIX}crafting`) { prefs = sanitizePrefs(Store.read('crafting', null)); draw(); } });

    /**
     * Timed gathering's own list, from here: its search is filled with the item (the search is never saved) and,
     * when that lists the node, the view switches with one history entry, as the pill does, and the node gets the
     * focus. When its filters or time range hide the node, nothing changes and this says why.
     */
    function showNode(nodeId, item) {
      const box = $('node-search'), list = $('node-list'), pill = document.querySelector('[data-mode="timers"]');
      const n = nodesById.get(nodeId);
      if (!box || !list || !pill || !n) return;
      const before = box.value;
      box.value = nameOf(item);
      box.dispatchEvent(new Event('input', { bubbles: true }));
      if (!list.querySelector(`.node-row[data-id="${nodeId}"]`)) {
        box.value = before;
        box.dispatchEvent(new Event('input', { bubbles: true }));
        st.status = '';
        st.notice = `Timed gathering does not list that node right now: it shows nodes by its time range (1 hour unless you chose another) and your filters there. ${timedText({ node: n, s: G.status(n, now()) }, now())}`;
        draw();
        return;
      }
      st.notice = '';
      pill.click();
      const row = list.querySelector(`.node-row[data-id="${nodeId}"]`);
      if (row) { row.scrollIntoView({ block: 'center' }); const f = row.querySelector('[data-node-star]'); if (f) f.focus({ preventScroll: true }); }
    }
    // Timed nodes' countdowns follow the clock while Crafting is on screen.
    setInterval(() => {
      if (view.hidden || document.visibilityState !== 'visible') return;
      const t = now();
      for (const n of view.querySelectorAll('[data-ctimed]')) {
        const b = timedNode(Number(n.dataset.ctimed), t), txt = n.firstChild;
        if (b && txt && txt.nodeType === 3) txt.textContent = timedText(b, t);
      }
    }, 1000);

    const handle = {
      route,
      draw,
      shown() { load(false); },
      placeChanged() { if (itemCtl) itemCtl.abort(); if (watchCtl) watchCtl.abort(); itemCtl = watchCtl = null; load(false); },
      /** For the browser checks: what Crafting shows and has worked out, never anything beyond what is saved. */
      debug() {
        const s = place(), out = { view: st.view, id: st.id, prefs: { ...prefs }, owned: [...owned], watch: { outputs: watch.outputs.length, chunks: watch.chunks.map((c) => c.length) } };
        if (st.view === 'item' && st.id !== null && craftable.has(st.id)) {
          const x = compute(st.id, s), v = stateOf(st.id);
          out.item = { recipe: x.r.id, quantity: v.quantity, quality: x.quality, force: [...v.force], buy: x.mine.buy, best: x.best.buy, evaluated: x.best.evaluated,
            cash: x.plan.cash, value: x.plan.value, perUnit: x.plan.perUnit, profit: { basis: x.profit.basis, headline: x.profit.headline, listing: x.profit.estimates.listing, average: x.profit.estimates.average },
            materials: x.plan.lines.map((l) => [l.item, l.quantity, l.unit ? l.unit.price : null, l.why]), strategies: x.strategies.map((p) => [p.key, p.cash, p.value, p.missing]), priceIds: x.ids.length };
        }
        if (s && st.view === 'home') { const w = watchState(watchPlace()); out.watch.groups = ['ranked', 'thin', 'unpriced'].map((g) => w.rows.filter((r) => r.group === g).length); out.watch.place = watchPlace().id; }
        return out;
      },
    };
    // The browser checks read debug() here; the page itself goes through js/market.js.
    Crafting.current = handle;
    return handle;
  }

  const Crafting = { TAX_MAX, PAGE, WATCH_PAGE, MIN_QUERY, STALE_MS, WATCH_SORTS, BASIS, sanitizePrefs, mount };
  if (typeof module === 'object' && module.exports) module.exports = Crafting;
  else root.XivCrafting = Crafting;
})(typeof globalThis !== 'undefined' ? globalThis : this);
