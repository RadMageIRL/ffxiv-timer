// Market & Crafting: Prices. Search the market board's item list, see each item's lowest listings (NQ
// and HQ), recent sales and sales per day from Universalis, sort and filter, keep favorites, open an
// item's details. Loaded by app.js the first time Market & Crafting opens, after js/market-items.js,
// js/market-catalog.js and js/prices.js; never with the timers.
//
// What it promises, and the code keeps:
// - Prices come only from Universalis, through this site's own prices/ paths. When no price comes back,
//   none is shown and nothing is estimated; an older price stays, with its age.
// - Every price shows its age, and the age is Universalis's time for it (when a player's game last
//   uploaded that world's market board for the item, when a sale happened, when a listing was last
//   seen), never when this page fetched it. Universalis is crowdsourced, so ages run from minutes to
//   months: current under 6 hours, recent under 3 days, older shown as old with its date.
// - Listings (offers to sell, not yet bought) and completed sales are always shown apart and named so.
//   The lowest listing and recent sales are shown, never an average of current listings (one absurd
//   listing would move it).
// - A price sort or the Listed now filter says what it covers: every match, or only the matches whose
//   prices are loaded.
// - Saved (ffxiv-timer:v1:market): the place prices are for, favorites, the sort and the filters, and only
//   once one is chosen. The first visit asks for a data center (prefilled from Resets, not saved until
//   chosen). Searches and prices are never saved.
(function (root) {
  'use strict';

  const PAGE = 50;
  /** A price sort or Listed now loads the prices of every match up to this many (10 requests); past it the reader narrows the search. */
  const SORT_CAP = 1000;
  /** A price fetched longer ago than this is asked for again when it is shown (radmagelabs.com keeps answers about as long). */
  const REFETCH_MS = 5 * 60000;
  /** Market data is current under 6 hours old, recent under 3 days, then old (plan section 5, from the measured spread). */
  const CURRENT_MS = 6 * 3600000;
  const RECENT_MS = 3 * 86400000;
  const FAV_MAX = 500;
  const FAV_HOME = 8;
  const LEVEL_MAX = 999;
  /** Price requests wait this long after the last change to a search, so typing asks for nothing until it stops. */
  const SETTLE_MS = 300;

  /**
   * Market Watch on the home: familiar materials, materia, crystals, consumables and dyes, in groups. A
   * PROVISIONAL list (the D8 draft of 2026-11-17, ranked by gil traded a day in North America): it is not
   * final until it is reviewed, and the page never presents it as a ranking. All 80 are asked for in one
   * request per place.
   */
  const WATCH = [
    { name: 'Crystals', ids: [10, 5, 8, 13, 2, 9, 11, 3] },
    { name: 'Materia', ids: [41767, 41780, 41766, 41778, 41762, 41758, 41763, 41771, 41776, 41764, 41772, 41765] },
    { name: 'Catalysts', ids: [21800, 10335, 7621, 33916] },
    { name: 'Medicine', ids: [49234, 49238, 49235, 49237, 47701, 45995, 44162, 45999] },
    { name: 'Meals', ids: [49240, 49244, 46253, 49239, 49243, 46254, 49245, 44842] },
    { name: 'Dyes', ids: [13115, 13114, 52256, 13708, 52255, 52254, 13116, 13117] },
    { name: 'Metal', ids: [50972, 49214, 45975, 49783] },
    { name: 'Lumber', ids: [45974, 45968, 49213, 44137] },
    { name: 'Cloth', ids: [49217, 45978, 45988, 44150] },
    { name: 'Leather', ids: [49226, 50971, 49216, 45987] },
    { name: 'Stone', ids: [49208, 49215, 45969, 49209] },
    { name: 'Reagents', ids: [49228, 46246, 46252, 49227, 49224, 50973, 45985, 49225] },
    { name: 'Ingredients', ids: [49229, 49231, 44171, 45990] },
  ];
  const watchIds = (cat) => WATCH.flatMap((g) => g.ids).filter((id) => cat.byId.has(id));
  const favHome = (favs) => favs.slice(-FAV_HOME).reverse();

  const SORTS = {
    relevance: { label: 'Best match' },
    name: { label: 'Name, A to Z' },
    'nq-asc': { label: 'Lowest NQ listing, low to high', value: 'nq', dir: 'asc', what: 'lowest NQ listing', how: 'low to high', none: 'no NQ listing' },
    'nq-desc': { label: 'Lowest NQ listing, high to low', value: 'nq', dir: 'desc', what: 'lowest NQ listing', how: 'high to low', none: 'no NQ listing' },
    'hq-asc': { label: 'Lowest HQ listing, low to high', value: 'hq', dir: 'asc', what: 'lowest HQ listing', how: 'low to high', none: 'no HQ listing' },
    'hq-desc': { label: 'Lowest HQ listing, high to low', value: 'hq', dir: 'desc', what: 'lowest HQ listing', how: 'high to low', none: 'no HQ listing' },
    'sales-desc': { label: 'Sold a day, most first', value: 'sales', dir: 'desc', what: 'units sold a day', how: 'most first', none: 'no sales on record' },
    'fresh-desc': { label: 'Updated, newest first', value: 'fresh', dir: 'desc', what: 'newest upload', how: 'newest first', none: 'no upload time' },
    'level-desc': { label: 'Item level, highest first', level: true, dir: 'desc' },
    'level-asc': { label: 'Item level, lowest first', level: true, dir: 'asc' },
  };
  const priceSort = (s) => Boolean(SORTS[s] && SORTS[s].value);

  const SAYS = {
    'rate-limited': 'The price service asked this page to slow down (HTTP 429)',
    unavailable: 'Universalis, where the prices come from, is not answering right now',
    network: 'The price service could not be reached',
    timeout: 'The price service did not answer in time',
    'bad-data': 'The price service sent something this page cannot read',
    http: 'The price service refused the request',
  };
  const says = (why) => SAYS[why] || SAYS.network;

  /** 'current', 'recent', 'old', or 'none' (no time) for market data from `at` (ms), seen at `now`. */
  const freshness = (at, t) => (!Number.isFinite(at) ? 'none' : t - at < CURRENT_MS ? 'current' : t - at < RECENT_MS ? 'recent' : 'old');
  /** "just now", "12 minutes ago", "5 hours ago", "3 days ago", "4 months ago". */
  function ago(ms) {
    const m = Math.max(0, Math.floor(ms / 60000));
    if (m < 1) return 'just now';
    if (m < 60) return m === 1 ? '1 minute ago' : `${m} minutes ago`;
    const h = Math.floor(m / 60);
    if (h < 48) return h === 1 ? '1 hour ago' : `${h} hours ago`;
    const d = Math.floor(h / 24);
    if (d < 60) return `${d} days ago`;
    const mo = Math.floor(d / 30);
    return mo < 24 ? `${mo} months ago` : `${Math.floor(d / 365)} years ago`;
  }
  const count = (n) => Math.round(n).toLocaleString('en-US');
  const gil = (n) => `${Math.round(n).toLocaleString('en-US')} gil`;
  const plural = (n, one, many) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
  /** Units sold a day, in words: "665 a day", "under 1 a day", "none lately". */
  const perDay = (q) => (q === null || q === undefined ? null : q <= 0 ? 'none lately' : q < 1 ? 'under 1 a day' : `${count(q)} a day`);
  /** The level of an aggregated answer that belongs to a scope. */
  const levelOf = (scope) => (scope.kind === 'world' ? 'world' : scope.kind === 'dc' ? 'dc' : 'region');

  /** What is saved, made safe: anything unexpected falls back to its default. */
  function sanitizeSaved(raw, cat) {
    const s = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const favorites = [];
    if (Array.isArray(s.favorites)) {
      for (const x of s.favorites) {
        if (favorites.length >= FAV_MAX) break;
        if (Number.isSafeInteger(x) && x > 0 && cat.byId.has(x) && !favorites.includes(x)) favorites.push(x);
      }
    }
    const level = (v) => (Number.isInteger(v) && v >= 1 && v <= LEVEL_MAX ? v : null);
    return {
      present: raw !== null && raw !== undefined,
      scope: typeof s.scope === 'string' && cat.scopeById.has(s.scope) ? s.scope : null,
      favorites,
      lost: Array.isArray(s.favorites) ? [...new Set(s.favorites.filter((x) => Number.isSafeInteger(x) && x > 0 && !cat.byId.has(x)))].length : 0,
      sort: typeof s.sort === 'string' && Object.prototype.hasOwnProperty.call(SORTS, s.sort) ? s.sort : 'relevance',
      hq: s.hq === true, listed: s.listed === true,
      minLevel: level(s.minLevel), maxLevel: level(s.maxLevel),
    };
  }

  /**
   * What a sort or the Listed now filter covers, in words. s: { sort, matches, ranked, noValue, unpriced,
   * loading, failed, listed, hiddenUnlisted, scopeName }. Only items whose prices are loaded can be ranked
   * by a price, or known to be listed, and the text says how many those are.
   */
  function scopeText(s) {
    const sort = SORTS[s.sort];
    const parts = [];
    if (sort && sort.value) {
      const head = `Ranked by ${sort.what} in ${s.scopeName}, ${sort.how}`;
      const have = s.ranked + s.noValue;
      if (s.unpriced === 0) parts.push(`${head}, among all ${plural(s.matches, 'matching item', 'matching items')}.`);
      else parts.push(`${head}, among only the ${have.toLocaleString('en-US')} of ${plural(s.matches, 'matching item', 'matching items')} whose prices are loaded.`);
      if (s.noValue) parts.push(`${plural(s.noValue, 'item', 'items')} with ${sort.none} come after the ranked ones.`);
    } else if (sort && sort.level) parts.push(`Sorted by item level, ${sort.dir === 'desc' ? 'highest' : 'lowest'} first.`);
    else parts.push(s.sort === 'name' ? 'Sorted by name.' : 'Best matches first, then by name.');
    if (s.listed) {
      parts.push(`Listed now: ${s.hiddenUnlisted ? `${plural(s.hiddenUnlisted, 'item', 'items')} with no listing in ${s.scopeName} ${s.hiddenUnlisted === 1 ? 'is' : 'are'} hidden` : `every item shown has a listing in ${s.scopeName}`}${s.unpriced ? `; ${plural(s.unpriced, 'item is', 'items are')} not loaded yet, so not checked` : ''}.`);
    }
    if (s.unpriced && (sort && sort.value || s.listed)) {
      if (s.loading) parts.push('Loading the other prices...');
      else if (s.matches > SORT_CAP) parts.push(`To rank or check every match, narrow the search to ${SORT_CAP.toLocaleString('en-US')} items or fewer.`);
      else if (s.failed) parts.push('The other prices could not be loaded.');
    }
    return parts.join(' ');
  }

  function mount(ctx) {
    const Catalog = root.XivCatalog, Prices = root.XivPrices;
    const { el, Store, now, copyText, canonical } = ctx;
    const $ = (id) => document.getElementById(id);
    const view = ctx.view;
    const longDate = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

    const parsed = Catalog.parse(root.FFXIV_MARKET_ITEMS);
    if (!parsed.ok) {
      $('market-boot').textContent = 'The market item list that arrived could not be read, so nothing is searched. Try again later. The timers are not affected.';
      $('market-boot').hidden = false;
      return { route() {}, shown() {}, debug: () => ({ listState: 'failed', error: parsed.error }) };
    }
    const cat = parsed.catalog;
    const client = Prices.createClient({ fetch: (u, i) => window.fetch(u, i), onRetry: () => drawSoon() });

    const saved = sanitizeSaved(Store.read('market', null), cat);
    let scope = saved.scope ? cat.scopeById.get(saved.scope) : null;
    let favs = saved.favorites, favLost = saved.lost;
    const st = { query: '', category: -1, favOnly: false, hq: saved.hq, listed: saved.listed, minLevel: saved.minLevel, maxLevel: saved.maxLevel, sort: saved.sort, shown: PAGE, watch: 0 };
    const save = () => Store.write('market', { scope: scope ? scope.id : null, favorites: favs, sort: st.sort, hq: st.hq, listed: st.listed, minLevel: st.minLevel, maxLevel: st.maxLevel });

    // Prices, this tab only, per place: `${scope}|${id}` -> { at, row } or { at, missing: true } (not on the
    // board there). pending: key -> the signal of the request that holds it (an id is on its way only while
    // that request is not cancelled, so a search that cancels and asks again at once is not left waiting: the
    // fix GW2 Timer needed in 360e424). failed: key -> the error of its last request, kept beside an older price.
    const cache = new Map(), pending = new Map(), failed = new Map();
    const key = (id, s) => `${(s || scope).scope}|${id}`;
    const live = (m, k) => { const s = m.get(k); return Boolean(s) && !s.aborted; };
    const hold = (m, ks, signal) => { const own = signal || { aborted: false }; for (const k of ks) m.set(k, own); return own; };
    const release = (m, ks, own) => { for (const k of ks) if (m.get(k) === own) m.delete(k); };
    let matches = [], order = [], counts = null, searchStatus = 'idle', hiddenUnlisted = 0;
    let viewCtl = null, sortCtl = null, homeCtl = null, settleTimer = 0, lastError = null;
    let detail = null, opener = null, closingByHash = false, pendingRoute = '';

    // ---- The page ----

    const opt = (value, label, selected) => el('option', { value, selected: selected || null }, label);
    function scopeOptions(withPlaceholder) {
      const kids = [];
      if (withPlaceholder) kids.push(opt('', 'Choose where to look', true));
      kids.push(el('optgroup', { label: 'Regions (every data center in it)' }, cat.scopes.filter((s) => s.kind === 'region').map((s) => opt(s.id, s.name))));
      for (const dc of cat.scopes.filter((s) => s.kind === 'dc')) {
        kids.push(el('optgroup', { label: `${dc.name} (${dc.regionName})` }, opt(dc.id, `${dc.name}, the whole data center`),
          cat.scopes.filter((s) => s.kind === 'world' && s.dc === dc.dc).map((s) => opt(s.id, s.name))));
      }
      return kids;
    }
    const dcOptions = () => {
      const regions = cat.scopes.filter((s) => s.kind === 'region');
      return [opt('', 'Choose a data center'), ...regions.map((r) => el('optgroup', { label: r.name }, cat.scopes.filter((s) => s.kind === 'dc' && s.region === r.region).map((s) => opt(s.id, s.name))))];
    };
    const typeOptions = () => [opt('-1', 'Any type'), ...Catalog.browseGroups(cat).map((g) => el('optgroup', { label: g.name }, g.categories.map((c) => opt(String(c.id), c.name))))];
    const levelInput = (id, label, ph) => el('label', { class: 'mk-level' }, el('span', null, label),
      el('input', { id, type: 'number', min: '1', max: String(LEVEL_MAX), inputmode: 'numeric', placeholder: ph, 'aria-label': `${label} item level` }));

    // The column names over a list of rows, on screens wide enough for columns (a phone labels each figure instead).
    const headRow = (id) => el('div', { class: 'mk-row mk-head-row', id, 'aria-hidden': 'true' }, el('span'), el('span', null, 'Item'), el('span', null, 'Lowest NQ listing'), el('span', null, 'Lowest HQ listing'), el('span', null, 'Sold a day'), el('span', null, 'Updated'));

    $('market-app').replaceChildren(
      el('div', { class: 'panel mk-controls' },
        el('div', { class: 'mk-head' },
          el('p', { class: 'mk-lede' }, 'Market board prices from Universalis: lowest listings, recent sales and sales per day, with the age of every price.'),
          el('label', { class: 'mk-scope' }, el('span', null, 'Prices for'), el('select', { id: 'mk-scope', 'aria-describedby': 'mk-scope-note' }))),
        el('p', { class: 'hint', id: 'mk-scope-note' }),
        el('div', { class: 'mk-ask', id: 'mk-ask', hidden: true },
          el('h2', { id: 'mk-ask-title' }, 'Where do you play?'),
          el('p', null, 'Choose your data center to see its prices. You can switch to one world or a whole region at any time, from Prices for. Nothing is saved until you choose.'),
          el('p', { class: 'mk-ask-row' },
            el('label', { class: 'inline-select' }, el('span', null, 'Data center'), el('select', { id: 'mk-ask-dc', 'aria-labelledby': 'mk-ask-title' })),
            el('button', { type: 'button', class: 'cal-download mk-ask-go', id: 'mk-ask-go' }, 'Show prices')),
          el('p', { class: 'hint', id: 'mk-ask-from', hidden: true }, 'Prefilled with the data center you chose in Resets.')),
        el('div', { class: 'mk-find', id: 'mk-search' },
          el('label', { class: 'search' }, el('span', { class: 'visually-hidden' }, 'Search items'),
            el('input', { id: 'mk-find', type: 'search', maxlength: '60', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', enterkeyhint: 'search', placeholder: 'Search the market board by item name or id', 'aria-describedby': 'mk-count' })),
          el('button', { type: 'button', class: 'ghost small', id: 'mk-find-clear', hidden: true }, 'Clear')),
        el('div', { class: 'mk-filters' },
          el('label', { class: 'inline-select' }, el('span', null, 'Type'), el('select', { id: 'mk-type' })),
          el('label', { class: 'inline-select' }, el('span', null, 'Sort'), el('select', { id: 'mk-sort', 'aria-describedby': 'mk-scope-text' }, Object.entries(SORTS).map(([k, s]) => opt(k, s.label)))),
          el('span', { class: 'mk-toggles', role: 'group', 'aria-label': 'Filters' },
            el('button', { type: 'button', class: 'toggle', id: 'mk-hq', 'aria-pressed': 'false', title: 'Only items that can be high quality' }, 'Can be HQ'),
            el('button', { type: 'button', class: 'toggle', id: 'mk-listed', 'aria-pressed': 'false', title: 'Only items with a listing now, where the prices are loaded' }, 'Listed now'),
            el('button', { type: 'button', class: 'toggle', id: 'mk-favs', 'aria-pressed': 'false' }, 'Favorites')),
          el('span', { class: 'mk-levels', role: 'group', 'aria-label': 'Item level' }, levelInput('mk-min', 'From', '1'), levelInput('mk-max', 'to', String(LEVEL_MAX))))),
      el('div', { class: 'mk-status' },
        el('p', { class: 'mk-crumbs', id: 'mk-crumbs', hidden: true },
          el('button', { type: 'button', class: 'ghost small', id: 'mk-home-btn' }, 'Market home'), ' ',
          el('span', { class: 'mk-crumb', id: 'mk-crumb', tabindex: '-1' })),
        el('p', { class: 'mk-count', id: 'mk-count', role: 'status' }),
        el('p', { class: 'mk-scope-text', id: 'mk-scope-text' }),
        el('p', { class: 'mk-prices', id: 'mk-prices' }, el('span', { id: 'mk-prices-text', role: 'status' }), ' ', el('button', { type: 'button', class: 'link-btn', id: 'mk-refresh', hidden: true }, 'Refresh prices'))),
      el('div', { class: 'notice mk-notice', id: 'mk-link-notice', role: 'status', hidden: true }, el('span', { id: 'mk-link-notice-text' }), ' ', el('button', { type: 'button', class: 'link-btn', id: 'mk-link-dismiss' }, 'Dismiss')),
      el('div', { class: 'mk-home', id: 'mk-home' },
        el('section', { class: 'panel mk-watch', id: 'mk-watch', 'aria-labelledby': 'mk-watch-title' },
          el('div', { class: 'panel-head' }, el('h2', { id: 'mk-watch-title' }, 'Market Watch'),
            el('p', { class: 'hint' }, 'Familiar crystals, materia, consumables, dyes and crafting materials, in groups. A fixed list, not a ranking.')),
          el('div', { class: 'mk-chips', role: 'group', 'aria-label': 'Market Watch group', id: 'mk-watch-groups' }),
          el('p', { class: 'mk-prices', id: 'mk-watch-prices' }, el('span', { id: 'mk-watch-text', role: 'status' }), ' ', el('button', { type: 'button', class: 'link-btn', id: 'mk-watch-refresh', hidden: true }, 'Refresh prices')),
          headRow('mk-watch-head'),
          el('ol', { class: 'mk-list', id: 'mk-watch-list', 'aria-label': 'Market Watch items' })),
        el('section', { class: 'panel mk-favhome', id: 'mk-favs-home', 'aria-labelledby': 'mk-favhome-title' },
          el('div', { class: 'panel-head' }, el('h2', { id: 'mk-favhome-title' }, 'Your favorites'), el('p', { class: 'hint', id: 'mk-favhome-hint' })),
          headRow('mk-favhome-head'),
          el('ol', { class: 'mk-list', id: 'mk-favhome-list', 'aria-label': 'Your favorite items', hidden: true }),
          el('p', { class: 'empty', id: 'mk-favhome-empty' }, 'No favorites yet. Star an item in the results or in its details to keep it here, with its prices.'),
          el('p', null, el('button', { type: 'button', class: 'ghost small', id: 'mk-favhome-all', hidden: true }, 'Show all favorites'))),
        el('section', { class: 'panel mk-browse', id: 'mk-browse', 'aria-labelledby': 'mk-browse-title' },
          el('div', { class: 'panel-head' }, el('h2', { id: 'mk-browse-title' }, 'Browse by type'), el('p', { class: 'hint' }, `The market board's own categories, ${plural(cat.count, 'item', 'items')} in all.`)),
          el('div', { class: 'mk-groups', id: 'mk-groups' }))),
      el('div', { class: 'panel mk-results-wrap', id: 'mk-results-wrap', hidden: true },
        headRow('mk-head'),
        el('ol', { class: 'mk-list', id: 'mk-results', 'aria-label': 'Matching items', 'aria-describedby': 'mk-scope-text' }),
        el('p', { class: 'empty', id: 'mk-empty', hidden: true }),
        el('p', { class: 'mk-more-line' }, el('button', { type: 'button', class: 'ghost small', id: 'mk-more', hidden: true }, 'Show more'))),
      el('section', { class: 'panel mk-about', 'aria-labelledby': 'mk-about-title' },
        el('h2', { id: 'mk-about-title' }, 'About these prices'),
        el('ul', { class: 'about-list' },
          el('li', null, 'Prices come from Universalis (universalis.app), which collects market board listings and sales as players open the market board. It has a world\'s prices for an item only after someone has looked at them there, so some are minutes old and some are months old. Every price here says how old it is: current under 6 hours, recent under 3 days, otherwise old, with its date.'),
          el('li', null, 'A listing is an item offered for sale now; the buyer pays the market tax on top of its price. A sale is a purchase that happened. Sold a day is how many units changed hands a day lately.'),
          el('li', null, 'This page asks radmagelabs.com for prices, and radmagelabs.com asks Universalis. Your browser does not contact Universalis, and nothing about you is sent there. Prices are not saved; they last while this page is open.'),
          el('li', null, `Item names and categories come from the game's own tables for patch ${cat.source.patch}. FFXIV Timer is not affiliated with Universalis.`))));

    const dialog = el('dialog', { id: 'mk-item', class: 'mk-dialog', 'aria-labelledby': 'mk-item-title' },
      el('form', { method: 'dialog', class: 'dialog-close' }, el('button', { class: 'ghost', 'aria-label': 'Close' }, '×')),
      el('h2', { id: 'mk-item-title', tabindex: '-1' }),
      el('div', { id: 'mk-item-body' }),
      el('p', { class: 'mk-item-status', id: 'mk-item-status', role: 'status' }));
    document.body.append(dialog);

    $('mk-scope').replaceChildren(...scopeOptions(!scope));
    $('mk-ask-dc').replaceChildren(...dcOptions());
    $('mk-type').replaceChildren(...typeOptions());
    $('mk-watch-groups').replaceChildren(...WATCH.map((g, k) => el('button', { type: 'button', class: 'toggle', 'data-mk-watch': String(k), 'data-mkkey': `watch-group:${k}`, 'aria-pressed': String(k === st.watch) }, g.name)));
    $('mk-groups').replaceChildren(...Catalog.browseGroups(cat).map((g) => el('section', { class: 'mk-group' },
      el('h3', null, g.name),
      el('ul', { class: 'mk-cats' }, g.categories.map((c) => el('li', null, el('button', { type: 'button', class: 'mk-cat', 'data-mk-cat': String(c.id), 'data-mkkey': `cat:${c.id}` },
        el('span', { class: 'mk-cat-name' }, c.name), el('span', { class: 'mk-cat-count' }, count(c.count)))))))));

    // ---- Search, filters and sort ----

    const level = () => (scope ? levelOf(scope) : 'dc');
    const entry = (id) => (scope ? cache.get(key(id)) : undefined);
    /** The lowest listing of one side at the scope's level, with the world that has it. */
    function lowest(row, sideName) {
      const m = row[sideName].min[level()];
      if (!m) return null;
      return { price: m.price, worldId: scope.kind === 'world' ? scope.worldIds[0] : m.worldId };
    }
    function newestUpload(row) {
      let best = null;
      const inScope = new Set(scope.worldIds);
      for (const [w, t] of row.uploads) if (inScope.has(w) && (best === null || t > best)) best = t;
      return best;
    }
    function sold(row) {
      const lv = level(), a = row.nq.velocity[lv], b = row.hq.velocity[lv];
      return a === undefined && b === undefined ? null : (a || 0) + (b || 0);
    }
    /** A price value for sorting: a number, null (loaded, no such value), undefined (not loaded). */
    function valueOf(i, what) {
      const e = entry(cat.ids[i]);
      if (!e) return undefined;
      if (e.missing || e.row.empty) return null;
      if (what === 'nq') { const m = lowest(e.row, 'nq'); return m ? m.price : null; }
      if (what === 'hq') { if (!cat.hq[i]) return null; const m = lowest(e.row, 'hq'); return m ? m.price : null; }
      if (what === 'sales') return sold(e.row);
      if (what === 'fresh') return newestUpload(e.row);
      return null;
    }
    const listedNow = (i) => { const e = entry(cat.ids[i]); if (!e) return undefined; if (e.missing || e.row.empty) return false; return Boolean(lowest(e.row, 'nq') || (cat.hq[i] && lowest(e.row, 'hq'))); };
    const isHome = () => searchStatus === 'idle';

    /** Recomputes what matches and its order, and draws; with `fetch`, asks for the prices that are needed once typing settles. */
    function apply(fetch) {
      const r = Catalog.search(cat, { query: st.query, category: st.category, hq: st.hq, minLevel: st.minLevel, maxLevel: st.maxLevel, only: st.favOnly ? new Set(favs) : null, sort: st.sort === 'name' ? 'name' : 'relevance' });
      searchStatus = r.status;
      matches = r.indexes;
      resort();
      draw();
      if (fetch) { clearTimeout(settleTimer); settleTimer = setTimeout(() => fetchNeeded(true), fetch === 'now' ? 0 : SETTLE_MS); }
    }
    function resort() {
      const s = SORTS[st.sort];
      let list = matches;
      hiddenUnlisted = 0;
      if (st.listed && scope) {
        const kept = [];
        for (const i of list) { if (listedNow(i) === false) hiddenUnlisted++; else kept.push(i); }
        list = kept;
      }
      if (s && s.value && scope) { const p = Catalog.valueSort(cat, list, (i) => valueOf(i, s.value), s.dir); order = p.order; counts = p; }
      else if (s && s.level) { const p = Catalog.valueSort(cat, list, (i) => cat.level[i], s.dir); order = p.order; counts = null; }
      else { order = list; counts = null; }
    }
    const visibleIds = () => order.slice(0, st.shown).map((i) => cat.ids[i]);

    /** Prices for what is shown, and for a price sort or Listed now every match up to SORT_CAP. `force` asks again even for current ones (Refresh). */
    function fetchNeeded(restart, force) {
      if (!scope) return;
      if (restart && viewCtl) viewCtl.abort();
      if (restart || !viewCtl || viewCtl.signal.aborted) viewCtl = new AbortController();
      const after = () => { resort(); draw(); };
      if (!isHome()) loadPrices(visibleIds(), viewCtl.signal, force).then(after);
      if (restart && sortCtl) { sortCtl.abort(); sortCtl = null; }
      if (!isHome() && (priceSort(st.sort) || st.listed) && matches.length <= SORT_CAP) {
        const all = matches.map((i) => cat.ids[i]);
        if (all.some((id) => !cache.has(key(id)) && !failed.has(key(id)))) {
          if (!sortCtl) sortCtl = new AbortController();
          const sig = sortCtl.signal;
          loadPrices(all, sig).then(() => { if (!sig.aborted) after(); });
        }
      }
      if (isHome()) loadHome(force);
    }
    const homeIds = () => [...new Set([...watchIds(cat), ...favHome(favs)])];
    /** The home's prices, while it is on screen: Market Watch's and the favorites shown there, together (one request for up to 100). */
    function loadHome(force) {
      if (!scope || !isHome() || view.hidden) return;
      if (!homeCtl || homeCtl.signal.aborted) homeCtl = new AbortController();
      loadPrices(homeIds(), homeCtl.signal, force).then((r) => { if (r) draw(); });
    }
    // A price keeps its Universalis times until a new answer replaces it; a failed refresh never touches it.
    async function loadPrices(ids, signal, force) {
      if (!scope) return null;
      const s = scope, t = now();
      const need = ids.filter((id) => { const c = cache.get(key(id, s)); return (force || !c || t - c.at >= REFETCH_MS) && !live(pending, key(id, s)); });
      if (!need.length) return null;
      const ks = need.map((id) => key(id, s));
      const own = hold(pending, ks, signal);
      drawSoon();
      const r = await client.aggregated(s.scope, need, { signal });
      release(pending, ks, own);
      for (const [id, row] of r.rows) { cache.set(key(id, s), { at: r.at, row }); failed.delete(key(id, s)); }
      for (const id of r.missing) { cache.set(key(id, s), { at: r.at, missing: true }); failed.delete(key(id, s)); }
      if (r.error && r.error !== 'aborted') {
        lastError = { error: r.error, at: now() };
        for (const id of r.failed) { const why = r.errors.get(id) || r.error; if (why !== 'aborted') failed.set(key(id, s), why); }
      }
      if (![...failed.keys()].some((k) => k.startsWith(`${s.scope}|`))) lastError = null;
      return r;
    }

    // ---- Drawing ----

    let drawTimer = 0, pauseTimer = 0;
    function drawSoon() { if (!drawTimer) drawTimer = setTimeout(() => { drawTimer = 0; draw(); }, 0); }
    const worldName = (id) => { const w = cat.worlds.get(id); return w ? w.name : null; };
    const ageCell = (at, t) => el('span', { class: `mk-age is-${freshness(at, t)}`, 'data-at': Number.isFinite(at) ? String(at) : null }, Number.isFinite(at) ? ago(t - at) : 'no time');

    /** One price cell's contents: the value, or why there is none. */
    function cell(cls, label, short, kids) {
      return el('span', { class: `mk-cell ${cls}` }, el('span', { class: 'visually-hidden' }, `${label}: `), el('span', { class: 'mk-k', 'aria-hidden': 'true' }, short), ...kids);
    }
    const none = (text) => el('span', { class: 'mk-none' }, text);
    /** A row's state for the current place: loaded (row), no data, not on the board there, on its way, failed, or not asked yet. */
    function stateOf(id) {
      if (!scope) return { s: 'no-scope' };
      const e = cache.get(key(id)), why = failed.get(key(id));
      if (e && e.missing) return { s: 'missing', e };
      if (e && e.row.empty) return { s: 'empty', e, why };
      if (e) return { s: 'loaded', e, why };
      if (live(pending, key(id))) return { s: 'pending' };
      if (why) return { s: 'failed', why };
      return { s: 'idle' };
    }
    const WAITING = { 'no-scope': 'choose a place', missing: 'not on the board there', empty: 'no data', pending: 'loading...', failed: 'not loaded', idle: 'not asked yet' };
    function priceKids(x, i, sideName) {
      if (sideName === 'hq' && !cat.hq[i]) return [none('no HQ version')];
      if (x.s !== 'loaded') return [none(x.s === 'pending' && client.pausedUntil() ? 'waiting' : WAITING[x.s])];
      const m = lowest(x.e.row, sideName);
      if (!m) return [none('no listing')];
      const w = worldName(m.worldId);
      return [el('span', { class: 'mk-gil' }, gil(m.price)), w && scope.kind !== 'world' ? el('span', { class: 'mk-where' }, w) : null];
    }
    function rowNote(x) {
      if (x.s === 'loaded' && x.why) return `A newer price could not be loaded: ${says(x.why)}.`;
      if (x.s === 'failed') return `No price: ${says(x.why)}.`;
      if (x.s === 'empty') return `Universalis has no market data for it in ${scope.name}.`;
      if (x.s === 'missing') return `Universalis does not list it on the ${scope.name} market board.`;
      return '';
    }
    function row(i, t, keyPrefix) {
      const id = cat.ids[i], name = cat.names[i], on = favs.includes(id), x = stateOf(id), c = cat.categories.get(cat.cat[i]);
      const at = x.s === 'loaded' ? newestUpload(x.e.row) : null, fresh = x.s === 'loaded' ? freshness(at, t) : '';
      const note = rowNote(x);
      return el('li', { class: `mk-row${fresh ? ` is-${fresh}` : ''}`, 'data-id': String(id) },
        el('button', { type: 'button', class: 'star', 'data-mk-fav': String(id), 'data-mkkey': `${keyPrefix}fav:${id}`, 'aria-pressed': String(on), 'aria-label': `Favorite: ${name}`, html: '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-star"/></svg>' }),
        el('span', { class: 'mk-item' },
          el('a', { class: 'mk-name', href: `#market/item/${id}`, 'aria-haspopup': 'dialog', 'data-mkkey': `${keyPrefix}name:${id}` }, name),
          el('span', { class: 'mk-meta' }, `${c ? c.name : 'Item'} · item level ${cat.level[i]}`, cat.hq[i] ? el('span', { class: 'badge tag' }, 'can be HQ') : null),
          el('span', { class: 'mk-note', hidden: !note }, note)),
        cell('mk-nq', 'Lowest NQ listing', 'NQ', priceKids(x, i, 'nq')),
        cell('mk-hq', 'Lowest HQ listing', 'HQ', priceKids(x, i, 'hq')),
        cell('mk-sold', 'Sold a day', 'Sold', x.s === 'loaded' ? [perDay(sold(x.e.row)) ? el('span', null, perDay(sold(x.e.row))) : none('no sales on record')] : []),
        cell('mk-upd', 'Updated', 'Updated', x.s === 'loaded' ? [ageCell(at, t)] : []));
    }

    function draw() {
      const t = now();
      const focusKey = (view.contains(document.activeElement) || dialog.contains(document.activeElement)) && document.activeElement.getAttribute('data-mkkey');
      // The place.
      $('mk-scope').value = scope ? scope.id : '';
      $('mk-ask').hidden = Boolean(scope);
      setText($('mk-scope-note'), scope ? scopeNote(scope) : 'Choose a data center, a world or a region to see prices.');
      // Home or results.
      const home = isHome();
      $('mk-home').hidden = !home;
      $('mk-results-wrap').hidden = home;
      $('mk-crumbs').hidden = home;
      if (!home) setText($('mk-crumb'), crumbText());
      if (home) drawHome(t);
      else drawResults(t);
      drawCount();
      setText($('mk-scope-text'), home || searchStatus !== 'ok' || !matches.length ? '' : scopeText({
        sort: st.sort, matches: matches.length, ranked: counts ? counts.ranked : 0, noValue: counts ? counts.noValue : 0,
        unpriced: scope ? matches.filter((i) => !cache.has(key(cat.ids[i]))).length : matches.length,
        loading: matches.some((i) => scope && live(pending, key(cat.ids[i]))), failed: matches.some((i) => scope && failed.has(key(cat.ids[i]))),
        listed: st.listed && Boolean(scope), hiddenUnlisted, scopeName: scope ? scope.name : '',
      }));
      if (!home) priceLine(visibleIds(), t, 'mk-prices', 'mk-prices-text', 'mk-refresh');
      $('mk-prices').hidden = home;
      // Controls.
      $('mk-favs').textContent = `Favorites (${favs.length})`;
      $('mk-favs').setAttribute('aria-pressed', String(st.favOnly));
      $('mk-hq').setAttribute('aria-pressed', String(st.hq));
      $('mk-listed').setAttribute('aria-pressed', String(st.listed));
      if (focusKey) { const n = (dialog.open ? dialog : view).querySelector(`[data-mkkey="${CSS.escape(focusKey)}"]`); if (n && n !== document.activeElement) n.focus(); }
      if (dialog.open && detail) drawDetail();
      // While a 429 or 503 holds the queue, the waiting text counts down.
      clearTimeout(pauseTimer);
      if (client.pausedUntil()) pauseTimer = setTimeout(drawSoon, 1000);
    }
    const setText = (n, text) => { if (n.textContent !== text) n.textContent = text; };
    function scopeNote(s) {
      if (s.kind === 'world') return `One world: ${s.name} (${s.dcName}). Lowest listings are on ${s.name}.`;
      if (s.kind === 'dc') return `Every world of ${s.name}: the lowest listing shows which world has it. Buying from another world means traveling there.`;
      return `Every data center in ${s.name}: the lowest listing shows which world has it. Lightly traded items often have more data at this scope.`;
    }
    function crumbText() {
      const parts = [];
      if (st.category >= 0) parts.push(cat.categories.get(st.category).name);
      if (st.favOnly) parts.push('Favorites');
      const q = st.query.trim();
      if (q) parts.push(`"${q}"`);
      return parts.length ? parts.join(' · ') : 'Every item';
    }
    let countTimer = 0, countText = '';
    function drawCount() {
      const q = st.query.trim();
      const t = searchStatus === 'short' ? 'Type at least 2 letters, or choose a type.' : searchStatus !== 'ok' ? '' : `${plural(order.length, 'item', 'items')}${q ? ` ${order.length === 1 ? 'matches' : 'match'} "${q}"` : ''}${st.category >= 0 || st.favOnly || st.hq || st.minLevel || st.maxLevel || st.listed ? ' with these filters' : ''}.`;
      if (t === countText) return;
      countText = t;
      clearTimeout(countTimer);
      countTimer = setTimeout(() => { setText($('mk-count'), countText); }, 400);
    }
    function drawResults(t) {
      const list = order.slice(0, st.shown);
      $('mk-results').replaceChildren(...list.map((i) => row(i, t, '')));
      $('mk-results').setAttribute('aria-busy', String(list.some((i) => scope && live(pending, key(cat.ids[i])))));
      $('mk-head').hidden = !list.length;
      const empty = $('mk-empty');
      empty.hidden = searchStatus === 'ok' && order.length > 0;
      empty.textContent = searchStatus === 'short' ? 'Type at least 2 letters, or choose a type.'
        : st.favOnly && !favs.length ? 'No favorites yet. Use the star by an item to add it.'
          : st.listed && hiddenUnlisted && !order.length ? `None of the matching items has a listing in ${scope.name} now.`
            : 'No item on the market board matches.';
      const more = $('mk-more'), left = order.length - list.length;
      more.hidden = left <= 0;
      more.textContent = `Show ${Math.min(PAGE, left)} more (${list.length.toLocaleString('en-US')} of ${order.length.toLocaleString('en-US')} shown)`;
    }
    function drawHome(t) {
      const g = WATCH[st.watch], ids = g.ids.filter((id) => cat.byId.has(id));
      for (const b of view.querySelectorAll('[data-mk-watch]')) b.setAttribute('aria-pressed', String(Number(b.dataset.mkWatch) === st.watch));
      $('mk-watch-list').replaceChildren(...ids.map((id) => row(cat.byId.get(id), t, 'watch:')));
      $('mk-watch-list').setAttribute('aria-busy', String(ids.some((id) => scope && live(pending, key(id)))));
      priceLine(ids, t, 'mk-watch-prices', 'mk-watch-text', 'mk-watch-refresh');
      const fids = favHome(favs);
      $('mk-favhome-list').replaceChildren(...fids.map((id) => row(cat.byId.get(id), t, 'favhome:')));
      $('mk-favhome-list').hidden = !fids.length;
      $('mk-favhome-head').hidden = !fids.length;
      $('mk-favhome-empty').hidden = fids.length > 0;
      const all = $('mk-favhome-all');
      all.hidden = favs.length <= fids.length;
      all.textContent = `Show all ${favs.length} favorites`;
      setText($('mk-favhome-hint'), `Saved in this browser, newest first.${favLost ? ` ${plural(favLost, 'saved favorite is', 'saved favorites are')} no longer on the market board, so not shown.` : ''}`);
    }
    /** A price line: loading, waiting, errors (with what is kept), and what the ages mean. */
    function priceLine(ids, t, lineId, textId, btnId) {
      const line = $(lineId), btn = $(btnId), parts = [];
      if (!scope) { setText($(textId), 'Choose where to look, above, to see prices.'); btn.hidden = true; return; }
      const loading = ids.filter((id) => live(pending, key(id))).length;
      const missing = ids.filter((id) => failed.has(key(id)) && !cache.has(key(id))).length;
      const loaded = ids.filter((id) => cache.has(key(id))).length;
      const until = client.pausedUntil();
      if (until && loading) parts.push(`Busy: the price service asked this page to wait, so it asks again in ${Math.max(1, Math.ceil((until - t) / 1000))} s. Prices already shown stay as they are.`);
      else if (loading) parts.push(`Loading prices for ${plural(loading, 'item', 'items')} in ${scope.name}...`);
      const whys = ids.map((id) => failed.get(key(id))).filter(Boolean);
      if (whys.length) {
        const why = whys.reduce((a, b) => (Prices.ERRORS.indexOf(a) <= Prices.ERRORS.indexOf(b) ? a : b));
        parts.push(`${says(why)}, so ${missing ? `${plural(missing, 'item has', 'items have')} no price here` : 'some prices could not be refreshed and show their last known values'}. Nothing is estimated in its place.`);
      }
      if (loaded && !loading) parts.push(`Prices in ${scope.name}. Updated is when a player's game last sent Universalis this item's market board there.`);
      setText($(textId), parts.join(' '));
      line.setAttribute('data-state', missing ? 'failed' : loading ? 'loading' : 'ok');
      btn.hidden = !ids.length || loading > 0;
      btn.textContent = missing ? 'Try again' : 'Refresh prices';
    }

    // ---- Favorites ----

    function toggleFav(id) {
      favs = favs.includes(id) ? favs.filter((x) => x !== id) : favs.concat(id).slice(-FAV_MAX);
      save();
      if (st.favOnly) apply(true); else { draw(); if (isHome()) loadHome(false); }
    }
    window.addEventListener('storage', (ev) => {
      if (ev.key !== `${Store.PREFIX}market`) return;
      const s = sanitizeSaved(Store.read('market', null), cat);
      favs = s.favorites; favLost = s.lost;
      const next = s.scope ? cat.scopeById.get(s.scope) : null;
      if (next && (!scope || next.id !== scope.id)) setScope(next, false);
      else if (st.favOnly) apply(true); else draw();
    });

    // ---- The place ----

    function setScope(s, write) {
      scope = s;
      if (write) save();
      $('mk-scope').replaceChildren(...scopeOptions(!scope));
      $('mk-scope').value = scope ? scope.id : '';
      apply('now');
      if (detail) loadDetail(detail.id, false);
    }

    // ---- One item's details: "#market/item/<id>" ----

    const detailFresh = (at, t) => (Number.isFinite(at) ? `${ago(t - at)} (${freshness(at, t) === 'old' ? longDate.format(at) : ctx.when(at)})` : 'at an unknown time');
    function stat(cls, label, value, sub) {
      return el('div', { class: `mk-stat ${cls}` }, el('span', { class: 'mk-stat-k' }, label), el('span', { class: 'mk-stat-v' }, value), sub ? el('span', { class: 'mk-stat-sub' }, sub) : null);
    }
    function detailBody(id) {
      const i = cat.byId.get(id), t = now(), c = cat.categories.get(cat.cat[i]), on = favs.includes(id), canHq = Boolean(cat.hq[i]);
      const out = [
        el('p', { class: 'mk-badges' }, el('span', { class: 'badge' }, c ? c.name : 'Item'), ' ', el('span', { class: 'badge' }, `Item level ${cat.level[i]}`), ' ',
          el('span', { class: 'badge' }, canHq ? 'Can be HQ' : 'No HQ version'), ' ', el('span', { class: 'badge tag' }, `id ${id}`)),
        el('p', { class: 'mk-actions' },
          el('button', { type: 'button', class: 'ghost small', 'data-mk-fav': String(id), 'data-mkkey': 'dlg:fav', 'aria-pressed': String(on) }, on ? 'Favorite (saved)' : 'Favorite'),
          el('button', { type: 'button', class: 'ghost small', 'data-mk-refresh-one': String(id), 'data-mkkey': 'dlg:refresh' }, 'Refresh'),
          el('button', { type: 'button', class: 'ghost small', 'data-mk-link': String(id), 'data-mkkey': 'dlg:link' }, 'Copy link')),
        // The same place as the page's Prices for, so a world and its data center can be compared from here.
        el('label', { class: 'inline-select mk-item-scope' }, el('span', null, 'Prices for'),
          el('select', { 'data-mk-scope': '', 'data-mkkey': 'dlg:scope' }, scopeOptions(!scope).map((n) => n))),
      ];
      if (!scope) { out.push(el('p', { class: 'notice' }, 'Choose where to look, just above, to see this item\'s prices.')); return out; }
      const d = detail && detail.id === id && detail.scope === scope.id ? detail : null, it = d && d.item;
      const x = stateOf(id), row = x.s === 'loaded' ? x.e.row : null;
      // The age first and large: everything below is only as current as this.
      const newest = it && it.state === 'ok' ? Math.max(...[...it.data.uploads].filter(([w]) => scope.worldIds.includes(w)).map(([, v]) => v), it.data.lastUpload || 0) : row ? newestUpload(row) : null;
      const age = newest && newest > 0 ? newest : null;
      out.push(el('p', { class: `mk-age-line is-${freshness(age, t)}` },
        el('strong', null, age ? `Market data for ${scope.name}: updated ${detailFresh(age, t)}.` : `No market data time for ${scope.name}.`), ' ',
        'Universalis has prices only from players\' market board visits, so a world can be far behind another.'));
      // The figures, NQ and HQ apart.
      const lv = level();
      const sideStats = (sideName, label) => {
        if (sideName === 'hq' && !canHq) return null;
        if (!row) return stat(`mk-stat-${sideName}`, `${label} lowest listing`, none(x.s === 'pending' ? 'loading...' : WAITING[x.s] || 'no data'));
        const m = lowest(row, sideName), r = row[sideName].recent[lv], avg = row[sideName].avg[lv], v = row[sideName].velocity[lv];
        const at = m ? row.uploads.get(m.worldId) : null;
        return el('div', { class: 'mk-side' },
          el('h3', null, label),
          el('div', { class: 'mk-stats' },
            stat('mk-stat-min', 'Lowest listing', m ? gil(m.price) : none('no listing now'), m ? `${scope.kind === 'world' ? scope.name : worldName(m.worldId) || 'a world'}, seen ${Number.isFinite(at) ? ago(t - at) : 'at an unknown time'}` : ''),
            stat('mk-stat-sale', 'Last sale', r ? gil(r.price) : none('no sale on record'), r ? `${worldName(r.worldId) || (scope.kind === 'world' ? scope.name : 'a world')}, ${Number.isFinite(r.at) ? ago(t - r.at) : 'at an unknown time'}` : ''),
            stat('mk-stat-avg', 'Average sale price', avg ? gil(avg) : none('none'), avg ? 'of recent completed sales' : ''),
            stat('mk-stat-vel', 'Sold a day', v !== undefined ? perDay(v) : none('none'), v !== undefined ? 'units, lately' : '')));
      };
      out.push(el('div', { class: 'mk-sides' }, sideStats('nq', 'NQ (normal quality)'), sideStats('hq', 'HQ (high quality)')));
      if (row) out.push(placesTable(row, canHq));
      // Listings and sales from the item request.
      if (!it || it.state === 'loading') out.push(el('p', { class: 'mk-none' }, client.pausedUntil() ? 'Waiting: the price service asked this page to wait before asking again.' : 'Loading listings and sales...'));
      else if (it.state === 'failed') out.push(el('p', { class: 'notice' }, `${says(it.error)}. Listings and sales are not shown; nothing is estimated in their place.`));
      else if (it.state === 'none') out.push(el('p', { class: 'notice' }, `Universalis has no listings or sales for this item in ${scope.name}.`));
      else out.push(listingsTable(it.data, t, canHq), salesTable(it.data, t, canHq));
      if (scope.kind === 'world') out.push(taxTable(d && d.tax));
      out.push(el('p', { class: 'hint mk-credit' }, 'Prices from Universalis (universalis.app), through radmagelabs.com: your browser does not contact Universalis.'));
      return out;
    }
    function placesTable(row, canHq) {
      const places = (scope.kind === 'world' ? ['world', 'dc', 'region'] : scope.kind === 'dc' ? ['dc', 'region'] : ['region']);
      const label = { world: scope.kind === 'world' ? scope.name : 'World', dc: scope.kind === 'region' ? 'Data center' : (scope.dcName || scope.name), region: (cat.scopes.find((s) => s.kind === 'region' && s.region === scope.region) || {}).name || 'Region' };
      const cellOf = (sideName, p) => {
        const m = row[sideName].min[p];
        if (!m) return el('td', null, none('none'));
        const w = p === 'world' ? null : worldName(m.worldId);
        return el('td', null, gil(m.price), w ? el('span', { class: 'mk-where' }, ` ${w}`) : null);
      };
      return el('div', { class: 'table-wrap' }, el('table', { class: 'mk-table' },
        el('caption', null, 'Lowest listing by place'),
        el('thead', null, el('tr', null, el('th', { scope: 'col' }, 'Where'), el('th', { scope: 'col' }, 'NQ'), canHq ? el('th', { scope: 'col' }, 'HQ') : null)),
        el('tbody', null, places.map((p) => el('tr', null, el('th', { scope: 'row' }, `${label[p]}${p === 'dc' ? ' (data center)' : p === 'region' ? ' (region)' : ''}`), cellOf('nq', p), canHq ? cellOf('hq', p) : null)))));
    }
    function listingsTable(data, t, canHq) {
      const rows = data.listings.slice(0, 20);
      return el('section', { class: 'mk-book' },
        el('h3', null, `For sale now: listings (${data.listingsCount !== null ? plural(data.listingsCount, 'listing', 'listings') : plural(rows.length, 'listing', 'listings')}${data.unitsForSale !== null ? `, ${plural(data.unitsForSale, 'unit', 'units')}` : ''})`),
        el('p', { class: 'hint' }, `Offers to sell in ${scope.name}, cheapest first (up to 20). Not sales: nobody has bought these yet. The buyer pays the market tax on top, included in the last column.`),
        rows.length ? el('div', { class: 'table-wrap' }, el('table', { class: 'mk-table' },
          el('thead', null, el('tr', null, el('th', { scope: 'col', class: 'num' }, 'Price each'), el('th', { scope: 'col', class: 'num' }, 'Qty'), canHq ? el('th', { scope: 'col' }, 'Quality') : null, scope.kind === 'world' ? null : el('th', { scope: 'col' }, 'World'), el('th', { scope: 'col' }, 'Seen'), el('th', { scope: 'col', class: 'num' }, 'Total with tax'))),
          el('tbody', null, rows.map((l) => el('tr', null,
            el('td', { class: 'num' }, gil(l.price)), el('td', { class: 'num' }, count(l.qty)), canHq ? el('td', null, l.hq ? 'HQ' : 'NQ') : null,
            scope.kind === 'world' ? null : el('td', null, l.worldName || worldName(l.worldId) || ''),
            el('td', null, ageCell(l.reviewed, t)),
            el('td', { class: 'num' }, l.total !== null && l.tax !== null ? gil(l.total + l.tax) : none('unknown'))))))) : el('p', { class: 'mk-none' }, 'No listings now.'));
    }
    function salesTable(data, t, canHq) {
      const rows = data.sales.slice(0, 20);
      return el('section', { class: 'mk-book' },
        el('h3', null, 'Sold recently: completed sales'),
        el('p', { class: 'hint' }, `Purchases that happened in ${scope.name}, newest first (up to 20), at the price paid before tax.`),
        rows.length ? el('div', { class: 'table-wrap' }, el('table', { class: 'mk-table' },
          el('thead', null, el('tr', null, el('th', { scope: 'col', class: 'num' }, 'Price each'), el('th', { scope: 'col', class: 'num' }, 'Qty'), canHq ? el('th', { scope: 'col' }, 'Quality') : null, scope.kind === 'world' ? null : el('th', { scope: 'col' }, 'World'), el('th', { scope: 'col' }, 'When'))),
          el('tbody', null, rows.map((s) => el('tr', null,
            el('td', { class: 'num' }, gil(s.price)), el('td', { class: 'num' }, count(s.qty)), canHq ? el('td', null, s.hq ? 'HQ' : 'NQ') : null,
            scope.kind === 'world' ? null : el('td', null, s.worldName || worldName(s.worldId) || ''),
            el('td', null, ageCell(s.at, t))))))) : el('p', { class: 'mk-none' }, 'No sales on record.'));
    }
    function taxTable(tax) {
      const head = el('h3', null, `Market tax on ${scope.name}`);
      if (!tax || tax.state === 'loading') return el('section', { class: 'mk-book' }, head, el('p', { class: 'mk-none' }, 'Loading...'));
      if (tax.state === 'failed') return el('section', { class: 'mk-book' }, head, el('p', { class: 'mk-none' }, `${says(tax.error)}. The rates are not shown.`));
      return el('section', { class: 'mk-book' }, head,
        el('p', { class: 'hint' }, 'The tax a buyer pays on top of a listing, set by the city the seller\'s retainer is in.'),
        el('ul', { class: 'mk-tax' }, tax.rates.map((r) => el('li', null, el('span', null, r.city), el('span', null, `${r.pct}%`)))));
    }
    function drawDetail() {
      if (!detail) return;
      const focusKey = dialog.contains(document.activeElement) && document.activeElement.getAttribute('data-mkkey');
      setText($('mk-item-title'), cat.names[cat.byId.get(detail.id)]);
      $('mk-item-body').replaceChildren(...detailBody(detail.id));
      const pickScope = dialog.querySelector('[data-mk-scope]');
      if (pickScope) pickScope.value = scope ? scope.id : '';
      if (focusKey) { const n = dialog.querySelector(`[data-mkkey="${CSS.escape(focusKey)}"]`); if (n) n.focus(); }
    }
    let detailCtl = null;
    async function loadDetail(id, force) {
      if (!scope) { drawDetail(); return; }
      if (detailCtl) detailCtl.abort();
      detailCtl = new AbortController();
      const sig = detailCtl.signal, s = scope;
      const fresh = detail && detail.id === id && detail.scope === s.id && detail.item && detail.item.state === 'ok' && now() - detail.item.at < REFETCH_MS && !force;
      if (!fresh) detail = { id, scope: s.id, item: { state: 'loading' }, tax: detail && detail.id === id && detail.scope === s.id ? detail.tax : null };
      drawDetail();
      const jobs = [loadPrices([id], sig, force).then(() => { draw(); })];
      if (!fresh) jobs.push(client.item(s.scope, id, { signal: sig }).then((r) => {
        if (!detail || detail.id !== id || detail.scope !== s.id || r.error === 'aborted') return;
        detail.item = r.ok ? (r.notFound ? { state: 'none' } : { state: 'ok', data: r.item, at: r.at }) : { state: 'failed', error: r.error };
        drawDetail();
      }));
      if (s.kind === 'world' && (!detail.tax || detail.tax.state === 'failed')) {
        detail.tax = { state: 'loading' };
        jobs.push(client.tax(s.worldIds[0], { signal: sig }).then((r) => {
          if (!detail || detail.id !== id || detail.scope !== s.id || r.error === 'aborted') return;
          detail.tax = r.ok ? { state: 'ok', rates: r.rates } : { state: 'failed', error: r.error };
          drawDetail();
        }));
      }
      await Promise.all(jobs);
    }
    function openItem(id) {
      if (!dialog.open) {
        const a = document.activeElement;
        opener = { el: a, key: a && a.getAttribute ? a.getAttribute('data-mkkey') : null };
      }
      setText($('mk-item-status'), '');
      if (!detail || detail.id !== id) detail = { id, scope: scope ? scope.id : null, item: { state: 'loading' }, tax: null };
      drawDetail();
      if (!dialog.open) dialog.showModal();
      $('mk-item-title').focus();
      loadDetail(id, false);
    }
    const shownEl = (n) => (n && n.isConnected && n.getClientRects().length ? n : null);
    dialog.addEventListener('click', (ev) => { if (ev.target === dialog) dialog.close(); });
    dialog.addEventListener('change', (ev) => {
      if (!ev.target.matches('[data-mk-scope]')) return;
      const s = cat.scopeById.get(ev.target.value);
      if (s) setScope(s, true);
    });
    dialog.addEventListener('close', () => {
      const id = detail ? detail.id : null;
      detail = null;
      if (detailCtl) { detailCtl.abort(); detailCtl = null; }
      if (!closingByHash && /^#market\/item\//.test(location.hash)) {
        if (history.state && history.state.ffxivItem === id) history.back();
        else { try { history.replaceState(null, '', '#market'); } catch (e) { /* the address keeps it */ } }
      }
      closingByHash = false;
      const o = opener; opener = null;
      const back = o && (shownEl(o.el) || (o.key && shownEl(view.querySelector(`[data-mkkey="${CSS.escape(o.key)}"]`))) || shownEl(view.querySelector(`[data-mkkey$="name:${id}"]`)) || $('market-title'));
      if (back && o.el !== document.body) back.focus();
    });

    /** What "#market..." asks for (js/router.js): the home and results, or one item's details. Called by app.js on every change of the address. */
    function route(hash) {
      const r = root.XivRouter.modeOf(hash);
      if (r.view !== 'item') {
        if (dialog.open) { closingByHash = true; dialog.close(); }
        if (r.view === 'notice') say('That link to a market item could not be read. Nothing of yours was changed.');
        return;
      }
      const id = r.id;
      if (!cat.byId.has(id)) {
        if (dialog.open) { closingByHash = true; dialog.close(); }
        say(`That link names an item that is not on the market board (item list from patch ${cat.source.patch}). Nothing of yours was changed.`);
        return;
      }
      say('');
      openItem(id);
    }
    function say(text) { $('mk-link-notice').hidden = !text; setText($('mk-link-notice-text'), text || ''); }

    // ---- Controls ----

    function syncControls() {
      $('mk-find').value = st.query;
      $('mk-find-clear').hidden = !st.query;
      $('mk-type').value = String(st.category);
      $('mk-sort').value = st.sort;
      $('mk-min').value = st.minLevel === null ? '' : String(st.minLevel);
      $('mk-max').value = st.maxLevel === null ? '' : String(st.maxLevel);
    }
    let typing = 0;
    $('mk-find').addEventListener('input', (ev) => {
      $('mk-find-clear').hidden = !ev.target.value;
      clearTimeout(typing);
      typing = setTimeout(() => { st.query = ev.target.value; st.shown = PAGE; apply(true); }, 100);
    });
    $('mk-find').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { clearTimeout(typing); st.query = ev.target.value; st.shown = PAGE; apply('now'); } });
    $('mk-type').addEventListener('change', (ev) => { st.category = Number(ev.target.value); st.shown = PAGE; apply(true); });
    $('mk-sort').addEventListener('change', (ev) => { if (!SORTS[ev.target.value]) return; st.sort = ev.target.value; st.shown = PAGE; save(); apply('now'); });
    for (const [id, k] of [['mk-min', 'minLevel'], ['mk-max', 'maxLevel']]) {
      $(id).addEventListener('change', (ev) => {
        const v = Number(ev.target.value);
        st[k] = ev.target.value !== '' && Number.isInteger(v) && v >= 1 && v <= LEVEL_MAX ? v : null;
        ev.target.value = st[k] === null ? '' : String(st[k]);
        st.shown = PAGE; save(); apply(true);
      });
    }
    $('mk-scope').addEventListener('change', (ev) => { const s = cat.scopeById.get(ev.target.value); if (s) setScope(s, true); });
    $('mk-ask-go').addEventListener('click', () => {
      const s = cat.scopeById.get($('mk-ask-dc').value);
      if (!s) { $('mk-ask-dc').focus(); return; }
      setScope(s, true);
      $('mk-find').focus();
    });
    // A category on the home opens its results at once, as the Type list would; focus goes to the line that names them.
    function pick(changes) {
      clearTimeout(typing);
      Object.assign(st, { query: '', category: -1, favOnly: false, shown: PAGE }, changes);
      syncControls();
      apply('now');
      $('mk-crumb').focus();
    }
    function goHome() {
      clearTimeout(typing);
      Object.assign(st, { query: '', category: -1, favOnly: false, shown: PAGE });
      syncControls();
      apply('now');
      $('market-title').focus();
    }

    view.addEventListener('click', (ev) => {
      const a = ev.target.closest ? ev.target.closest('a[href^="#market/item/"]') : null;
      if (a && !ev.defaultPrevented && ev.button === 0 && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey && !ev.altKey) {
        const id = Number(a.getAttribute('href').slice('#market/item/'.length));
        if (cat.byId.has(id)) {
          ev.preventDefault();
          try { history.pushState({ ffxivItem: id }, '', `#market/item/${id}`); } catch (e) { /* the details still open */ }
          openItem(id);
        }
      }
    });
    document.addEventListener('click', async (ev) => {
      const b = ev.target.closest ? ev.target.closest('button') : null;
      if (!b || !(view.contains(b) || dialog.contains(b) || b.hasAttribute('data-market-jump'))) return;
      const a = (n) => b.getAttribute(n);
      if (a('data-mk-fav')) { toggleFav(Number(a('data-mk-fav'))); }
      else if (b.id === 'mk-find-clear') { st.query = ''; st.shown = PAGE; syncControls(); apply(true); $('mk-find').focus(); }
      else if (b.id === 'mk-favs') { st.favOnly = !st.favOnly; st.shown = PAGE; apply('now'); }
      else if (b.id === 'mk-hq') { st.hq = !st.hq; st.shown = PAGE; save(); apply(true); }
      else if (b.id === 'mk-listed') { st.listed = !st.listed; st.shown = PAGE; save(); apply('now'); }
      else if (b.id === 'mk-more') { st.shown += PAGE; draw(); fetchNeeded(false); }
      else if (b.id === 'mk-refresh') { for (const id of visibleIds()) failed.delete(key(id)); fetchNeeded(true, true); }
      else if (b.id === 'mk-watch-refresh') { for (const id of homeIds()) failed.delete(key(id)); loadHome(true); }
      else if (a('data-mk-watch')) { st.watch = Number(a('data-mk-watch')); draw(); }
      else if (a('data-mk-cat')) pick({ category: Number(a('data-mk-cat')) });
      else if (b.id === 'mk-favhome-all') pick({ favOnly: true });
      else if (b.id === 'mk-home-btn') goHome();
      else if (b.id === 'mk-link-dismiss') { say(''); try { history.replaceState(null, '', '#market'); } catch (e) { /* kept */ } }
      else if (a('data-mk-refresh-one')) { const id = Number(a('data-mk-refresh-one')); failed.delete(key(id)); loadDetail(id, true); }
      else if (a('data-mk-link')) {
        const url = `${canonical}#market/item/${a('data-mk-link')}`;
        const ok = await copyText(url);
        setText($('mk-item-status'), ok ? `Copied the link to this item: ${url}` : `Copying did not work here. The link is ${url}`);
      } else if (a('data-market-jump')) {
        const target = a('data-market-jump');
        if (target !== 'mk-search' && !isHome()) goHome();
        const n = $(target);
        if (n) { n.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }); if (target === 'mk-search') $('mk-find').focus({ preventScroll: true }); }
      }
    });

    // Back on screen: prices no longer current are asked for again; the first time, the prefilled data center.
    function shown() {
      if (view.hidden) return;
      if (!scope) {
        const dc = ctx.resetsDc && ctx.resetsDc();
        const s = dc ? cat.scopeById.get(`dc:${dc}`) : null;
        if (s && !$('mk-ask-dc').value) { $('mk-ask-dc').value = s.id; $('mk-ask-from').hidden = false; }
      }
      fetchNeeded(false);
      draw();
    }
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && !view.hidden) shown(); });
    // Ages follow the clock while Market & Crafting is on screen, updated in place so focus and the reading position stay put.
    function tickAges() {
      const t = now();
      for (const n of document.querySelectorAll('#market-app [data-at], #mk-item [data-at]')) {
        const at = Number(n.getAttribute('data-at')), cls = `mk-age is-${freshness(at, t)}`;
        setText(n, ago(t - at));
        if (n.className !== cls) n.className = cls;
      }
    }
    setInterval(() => { if (!view.hidden && document.visibilityState === 'visible') tickAges(); }, 30000);

    syncControls();
    apply(false);
    if (pendingRoute) { const p = pendingRoute; pendingRoute = ''; route(p); }
    return {
      route, shown,
      /** For the browser checks: what this tab holds, never the visitor's data beyond what is saved. */
      debug: () => ({ listState: 'ready', home: isHome(), scope: scope ? scope.id : null, query: st.query, category: st.category, sort: st.sort, favOnly: st.favOnly, shown: st.shown, matches: matches.length, order: order.length, cached: cache.size, favorites: favs.slice(), detail: detail ? { id: detail.id, item: detail.item && detail.item.state } : null, stats: client.stats() }),
    };
  }

  const Market = { PAGE, SORT_CAP, REFETCH_MS, CURRENT_MS, RECENT_MS, FAV_MAX, FAV_HOME, LEVEL_MAX, SETTLE_MS, WATCH, SORTS, SAYS, watchIds, favHome, freshness, ago, perDay, gil, levelOf, sanitizeSaved, scopeText, mount };
  if (typeof module === 'object' && module.exports) module.exports = Market;
  else root.XivMarket = Market;
})(typeof globalThis !== 'undefined' ? globalThis : this);
