// Page logic. The math lives in eorzea.js and weather.js; this file only renders it. View state
// that someone might share (forecast zone, transition search) lives in the URL hash, so a reload
// or bookmark restores it on any host and under any base path. Favorites and preferences live in
// namespaced localStorage (store.js).
(function () {
  'use strict';
  const E = window.Eorzea, W = window.XivWeather, DATA = window.FFXIV_WEATHER_DATA;
  const G = window.XivGathering, NODES = window.FFXIV_GATHERING_DATA.nodes;
  const Store = window.FfxivStore, Icons = window.FfxivIcons, Format = window.FfxivFormat, News = window.FfxivNews;
  const R = window.XivResets;
  let Ics = window.XivIcs || null; // js/ics.js, loaded the first time a calendar is asked for (loadIcs)

  const ZONES = DATA.zones;
  const BY_KEY = new Map(ZONES.map((z) => [z.key, z]));
  const UNSUPPORTED = new Map(DATA.unsupported.map((z) => [z.key, z]));
  const EXPANSIONS = DATA.expansions.filter((x) => ZONES.some((z) => z.expansion === x));
  const regionsOf = (x) => [...new Set(ZONES.filter((z) => z.expansion === x).map((z) => z.region))];
  const slug = Format.slug, fmtCountdown = Format.countdown;
  const WEATHER_BY_SLUG = new Map(Object.entries(DATA.weathers).map(([id, name]) => [slug(name), Number(id)]));
  const wxName = (id) => DATA.weathers[id];

  const DEFAULT_FAVORITES = ['middle-la-noscea', 'urqopacha', 'eureka-pagos'];
  const PERIOD_BELLS = [0, 8, 16];
  const TIMELINE_SPAN = 2 * 3600000, TIMELINE_MAX = 16;
  const FINDER_HORIZON = 30 * 86400000, FINDER_LIMIT = 10;

  const knownZone = (k) => BY_KEY.has(k);
  const state = {
    favorites: new Set((Store.read('favorites', DEFAULT_FAVORITES) || []).filter(knownZone)),
    hour12: Store.read('hour12', null),
    search: '', area: '', favOnly: false,
    openGroups: new Set((Store.read('openGroups', []) || []).filter((x) => EXPANSIONS.includes(x))),
    forecastZone: Store.read('forecastZone', 'middle-la-noscea'),
    forecastCount: 12,
    finder: Object.assign({ zone: 'eureka-pagos', prev: [], to: [15], bells: [] }, Store.read('finder', {})),
    nodeFavorites: new Set((Store.read('nodeFavorites', []) || []).filter((id) => NODES.some((n) => n.id === id))),
    nodeSearch: '',
    gather: loadGather(),
    remindLead: Store.read('remindLead', null),
    newsOpen: Store.read('newsOpen', false) === true,
  };
  // Resets settings, one key saved only once something is chosen: the data center whose Jumbo Cactpot
  // drawing shows, the starred rows (in Upcoming and reminders) and the reminder lead in minutes.
  const RESET_STAR_IDS = ['daily', 'mini-cactpot', 'grand-company', 'leves', 'weekly', 'jumbo-cactpot', 'housing'];
  const RESET_LEADS = [0, 5, 15, 30];
  {
    const s = Store.read('resets', null) || {};
    state.resetsDc = R.dataCenter(s.dataCenter) ? s.dataCenter : null;
    state.resetStars = new Set((Array.isArray(s.starred) ? s.starred : []).filter((id) => RESET_STAR_IDS.includes(id)));
    state.resetRemindLead = RESET_LEADS.includes(s.remindLead) ? s.remindLead : null;
  }
  const saveResets = () => Store.write('resets', { dataCenter: state.resetsDc, starred: [...state.resetStars], remindLead: state.resetRemindLead });
  const NODE_BY_ID = new Map(NODES.map((n) => [n.id, n]));

  // Gathering view and filters, saved between visits. Anything unexpected falls back to the default.
  function loadGather() {
    const s = Store.read('gathering', {}) || {};
    const list = (v, allowed) => (Array.isArray(v) ? v.filter((x) => allowed.includes(x)) : []);
    const level = (v) => (Number.isInteger(v) && v >= 1 && v <= 100 ? v : null);
    const mine = s.myLevels || {};
    return {
      view: ['15', '30', 'hour', 'all'].includes(s.view) ? s.view : 'hour',
      jobs: list(s.jobs, ['Miner', 'Botanist']),
      kinds: list(s.kinds, ['legendary', 'unspoiled']),
      expansions: list(s.expansions, DATA.expansions),
      minLevel: level(s.minLevel), maxLevel: level(s.maxLevel),
      myLevels: { Miner: level(mine.Miner), Botanist: level(mine.Botanist) },
      hideAbove: s.hideAbove === true, up: s.up === true, starred: s.starred === true,
    };
  }

  // ---- small DOM helpers ----
  const $ = (id) => document.getElementById(id);
  function el(tag, props, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'html') n.innerHTML = v; // only ever our own icon markup
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid.nodeType ? kid : String(kid));
    return n;
  }
  const setText = (node, text) => { if (node.textContent !== text) node.textContent = text; };

  function chip(id, small) {
    const name = wxName(id);
    return el('span', { class: `wx wx-${Icons.weatherGroup(name)}${small ? ' wx-small' : ''}` },
      el('span', { class: 'wx-i', html: Icons.weatherIcon(name) }), el('span', { class: 'wx-n' }, name));
  }
  const countdown = (until) => el('span', { class: 'cd', 'data-until': String(until) });
  const etLabel = (t) => { const c = E.clock(t); return `${E.formatEt(c.bell, c.minute)} ET`; };
  // A row's Add to calendar button; `key` says what it adds (see calendarFor).
  const calButton = (key, label) => el('button', {
    type: 'button', class: 'cal-add', 'data-cal': key, 'aria-haspopup': 'dialog', 'aria-label': `Add to calendar: ${label}`, title: 'Add to calendar',
    html: '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-cal"/></svg>',
  });

  // ---- time formatting (the only place the viewer's time zone is used) ----
  let formats = null;
  function fmt(kind) {
    if (!formats) {
      const h = state.hour12 == null ? {} : { hour12: state.hour12 };
      formats = {
        time: new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', ...h }),
        seconds: new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', ...h }),
        day: new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }),
        weekday: new Intl.DateTimeFormat(undefined, { weekday: 'short' }),
        zone: new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' }),
      };
    }
    return formats[kind];
  }
  function localWhen(t, now) {
    const time = fmt('time').format(t);
    return new Date(t).toDateString() === new Date(now).toDateString() ? time : `${fmt('day').format(t)}, ${time}`;
  }
  // The viewer's time zone: its short name at t ("CST", "CDT", "GMT+5:30") and its full name ("America/Chicago").
  const zoneAbbr = (t) => { try { return fmt('zone').formatToParts(t).find((p) => p.type === 'timeZoneName').value; } catch (e) { return ''; } };
  const zoneName = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { return ''; } };
  const zoneLabel = (t) => { const name = zoneName(), abbr = zoneAbbr(t); return name ? `${name}${abbr ? ` (${abbr})` : ''}` : abbr || 'your device\'s time zone'; };
  // "Today", "Tomorrow", a weekday within the week, else the date: in local calendar days (a day can be 23 or 25 hours).
  function dayWord(t, now) {
    const a = new Date(t), b = new Date(now);
    const days = Math.round((new Date(a.getFullYear(), a.getMonth(), a.getDate()) - new Date(b.getFullYear(), b.getMonth(), b.getDate())) / 86400000);
    return days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : days > 1 && days < 7 ? fmt('weekday').format(t) : fmt('day').format(t);
  }
  const usesHour12 = () => (state.hour12 == null ? !!new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hour12 : state.hour12);

  // ---- URL hash and saved state ----
  const listParam = (p, name) => (p.get(name) || '').split(',').filter(Boolean);
  function readHash() {
    const p = new URLSearchParams(location.hash.replace(/^#/, ''));
    if (p.has('zone')) state.forecastZone = p.get('zone');
    if (p.has('fz')) {
      state.finder = {
        zone: p.get('fz'),
        prev: listParam(p, 'prev').map((s) => WEATHER_BY_SLUG.get(s)).filter((x) => x != null),
        to: listParam(p, 'to').map((s) => WEATHER_BY_SLUG.get(s)).filter((x) => x != null),
        bells: listParam(p, 'bells').map(Number).filter((b) => PERIOD_BELLS.includes(b)),
      };
    }
  }
  function writeHash() {
    const f = state.finder, parts = [`zone=${encodeURIComponent(state.forecastZone)}`, `fz=${encodeURIComponent(f.zone)}`];
    if (f.prev.length) parts.push(`prev=${f.prev.map((id) => slug(wxName(id))).join(',')}`);
    if (f.to.length) parts.push(`to=${f.to.map((id) => slug(wxName(id))).join(',')}`);
    if (f.bells.length) parts.push(`bells=${f.bells.join(',')}`);
    const hash = `#${parts.join('&')}`;
    if (location.hash !== hash) history.replaceState(null, '', hash);
    Store.write('forecastZone', state.forecastZone);
    Store.write('finder', f);
  }

  // ---- clock ----
  const clockEls = {};
  function renderClock(now) {
    for (const id of ['et-time', 'et-date', 'local-time', 'daynight', 'daybar-now', 'cd-bell', 'cd-weather', 'cd-sun', 'cd-sun-label']) clockEls[id] = clockEls[id] || $(id);
    const c = E.clock(now), day = E.isDaytime(c.bell);
    setText(clockEls['et-time'], E.formatEt(c.bell, c.minute));
    setText(clockEls['et-date'], E.dateName(c));
    setText(clockEls['local-time'], fmt('seconds').format(now));
    setText(clockEls.daynight, day ? 'Day' : 'Night');
    clockEls.daynight.className = `badge ${day ? 'day' : 'night'}`;
    clockEls['daybar-now'].style.left = `${((c.bell * 60 + c.minute) / 1440) * 100}%`;
    setText(clockEls['cd-bell'], fmtCountdown(E.nextBell(now) - now));
    const next = E.nextPeriod(now);
    setText(clockEls['cd-weather'], `${fmtCountdown(next - now)} (${etLabel(next)})`);
    setText(clockEls['cd-sun-label'], day ? 'Sunset 18:00 ET' : 'Sunrise 06:00 ET');
    setText(clockEls['cd-sun'], fmtCountdown(E.nextEtTime(now, day ? 18 : 6) - now));
  }

  // ---- weather now ----
  function zoneMatches(z, q, now) {
    if (!q) return true;
    if (`${z.name} ${z.region} ${z.expansion}`.toLowerCase().includes(q)) return true;
    return wxName(W.weatherAt(z, now)).toLowerCase().includes(q);
  }
  // The area filter is "x:<expansion>" or "r:<region>".
  const inArea = (z) => !state.area || (state.area.startsWith('x:') ? z.expansion === state.area.slice(2) : z.region === state.area.slice(2));
  // Unfiltered, starred zones come first and every other zone sits in a collapsible group per
  // expansion (open groups are remembered). Searching or filtering shows a flat list instead.
  function renderZones(now) {
    const list = $('zone-list'), q = state.search.trim().toLowerCase();
    const filtering = Boolean(q || state.area || state.favOnly);
    const shown = ZONES.filter((z) => inArea(z) && (!state.favOnly || state.favorites.has(z.key)) && zoneMatches(z, q, now));
    const starred = shown.filter((z) => state.favorites.has(z.key)), rest = shown.filter((z) => !state.favorites.has(z.key));
    const items = [];
    if (filtering) {
      items.push(...starred.concat(rest).map((z) => zoneRow(z, now)));
    } else {
      if (starred.length) items.push(el('li', { class: 'zone-heading' }, 'Starred'), ...starred.map((z) => zoneRow(z, now)));
      for (const x of EXPANSIONS) {
        const zones = rest.filter((z) => z.expansion === x);
        if (!zones.length) continue;
        items.push(el('li', { class: 'zone-group' },
          el('details', { open: state.openGroups.has(x), 'data-group': x },
            el('summary', null, el('span', null, x), el('span', { class: 'muted' }, `${zones.length} zone${zones.length === 1 ? '' : 's'}`)),
            el('ul', { class: 'zone-list' }, zones.map((z) => zoneRow(z, now))))));
      }
    }
    const missing = q && !state.area && !state.favOnly
      ? DATA.unsupported.filter((u) => u.name.toLowerCase().includes(q)) : [];
    for (const u of missing) {
      items.push(el('li', { class: 'zone-row unsupported' },
        el('span', { class: 'zone-title' }, u.name),
        el('span', { class: 'muted' }, 'No forecast yet: this zone has not been verified for FFXIV Timer.')));
    }
    list.replaceChildren(...items);
    const empty = $('zone-empty');
    empty.hidden = items.length > 0;
    if (!items.length) empty.textContent = state.favOnly ? 'No starred zones match. Star a zone to pin it here.' : 'No zone matches that search.';
  }
  function zoneRow(z, now) {
    const fav = state.favorites.has(z.key);
    const spans = W.spans(z, now, 12), current = spans[0];
    const single = W.odds(z).size === 1;
    const next = spans.slice(1, 4).map((s) => el('li', null, el('span', { class: 'at' }, etLabel(s.start).replace(' ET', '')), chip(s.weather, true)));
    return el('li', { class: `zone-row${fav ? ' fav' : ''}` },
      el('button', { class: 'star', type: 'button', 'data-star': z.key, 'aria-pressed': String(fav), 'aria-label': `Star ${z.name}`, html: '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-star"/></svg>' }),
      el('div', { class: 'zone-name' },
        el('button', { class: 'link zone-title', type: 'button', 'data-open': z.key }, z.name),
        el('span', { class: 'muted' }, z.region)),
      el('div', { class: 'zone-now' }, chip(current.weather),
        single ? el('span', { class: 'until muted' }, 'Always')
          : el('span', { class: 'until' }, `until ${etLabel(current.end)}`, el('span', { class: 'muted' }, ' in '), countdown(current.end))),
      next.length ? el('ol', { class: 'zone-next', 'aria-label': 'Next' }, next) : null);
  }

  // ---- upcoming timeline ----
  let timelineNext = Infinity;
  // What Upcoming lists at now: starred nodes up now (ending soonest first), then the first TIMELINE_MAX
  // events within TIMELINE_SPAN: weather changes in starred zones, sunrise and sunset, starred nodes appearing.
  // Each event that a calendar can hold has a key: "w:<zone>:<at>" or "n:<node id>:<start>".
  function timelineEvents(now) {
    const until = now + TIMELINE_SPAN, events = [];
    for (const key of state.favorites) {
      const z = BY_KEY.get(key);
      for (const p of W.periods(z, now, Math.ceil(TIMELINE_SPAN / W.PERIOD) + 1)) {
        if (p.start > now && p.start <= until && p.weather !== p.previous) events.push({ at: p.start, zone: z, p, key: `w:${z.key}:${p.start}` });
      }
    }
    for (const bell of [6, 18]) {
      for (let t = E.nextEtTime(now, bell); t <= until; t += E.SUN) events.push({ at: t, bell });
    }
    const starred = G.starredEvents(NODES, state.nodeFavorites, now, TIMELINE_SPAN);
    for (const s of starred.spawns) events.push({ at: s.at, end: s.end, node: s.node, key: `n:${s.node.id}:${s.at}` });
    events.sort((a, b) => a.at - b.at || (a.bell != null ? -1 : 1));
    const shown = events.slice(0, TIMELINE_MAX);
    // Starred resets ("r:<reset id>:<at>") join without moving anything above: after whatever else happens at
    // the same moment, and only as far as the list reaches (the two hours, or its last event when it is full).
    const reach = events.length > TIMELINE_MAX ? shown[shown.length - 1].at : until;
    const resets = R.upcoming(starredResets(), now, TIMELINE_SPAN).filter((x) => x.start <= reach)
      .map((x) => ({ at: x.start, reset: x.reset, key: `r:${x.reset.id}:${x.start}` }));
    const merged = [];
    let i = 0;
    for (const ev of shown) { while (i < resets.length && resets[i].at < ev.at) merged.push(resets[i++]); merged.push(ev); }
    merged.push(...resets.slice(i));
    return {
      up: starred.up.map((u) => Object.assign({ key: `n:${u.node.id}:${u.start}` }, u)), events: merged,
      first: Math.min(events.length ? events[0].at : Infinity, resets.length ? resets[0].at : Infinity),
    };
  }
  // The same, as calendar entries can take them (sunrise and sunset are not exported).
  function upcomingItems(now) {
    const t = timelineEvents(now);
    return t.up.map((u) => ({ key: u.key, node: u.node, window: { start: u.start, end: u.end } }))
      .concat(t.events.filter((ev) => ev.bell == null).map((ev) => (ev.node
        ? { key: ev.key, node: ev.node, window: { start: ev.at, end: ev.end } }
        : ev.reset ? { key: ev.key, reset: ev.reset, start: ev.at }
          : { key: ev.key, zone: ev.zone, change: { at: ev.at, from: ev.p.previous, to: ev.p.weather } })));
  }
  function renderTimeline(now) {
    const t = timelineEvents(now);
    // Redraw when the next event happens or a starred node that is up now goes down.
    timelineNext = Math.min(t.first, ...t.up.map((u) => u.end));
    // Starred nodes already up come first, labeled as such, ending soonest first.
    const upNow = t.up.map((u) => el('li', { class: 'tl-item tl-node tl-up', 'data-node': String(u.node.id) },
      el('div', { class: 'tl-when' }, el('span', null, el('span', { class: 'badge now' }, 'Up now')), el('span', { class: 'muted' }, `until ${etLabel(u.end)}`)),
      el('div', { class: 'tl-what' }, el('span', { class: 'tl-zone' }, nodeTitle(u.node)),
        el('span', { class: 'muted' }, `${KIND_LABEL[u.node.kind]} ${u.node.job.toLowerCase()} node · ${u.node.zone} ${fmtCoords(u.node.coords)}`)),
      el('div', { class: 'tl-cd' }, el('span', { class: 'muted small' }, 'ends in '), countdown(u.end), calButton(`up:${u.key}`, nodeTitle(u.node)))));
    const items = upNow.concat(t.events.map((ev) => (ev.reset ? timelineReset(ev, now) : el('li', { class: `tl-item${ev.bell != null ? ' tl-sun' : ''}${ev.node ? ' tl-node' : ''}`, 'data-at': String(ev.at) },
      el('div', { class: 'tl-when' }, el('span', null, localWhen(ev.at, now)), el('span', { class: 'muted' }, etLabel(ev.at))),
      ev.bell != null
        ? el('div', { class: 'tl-what' }, el('span', { class: 'tl-zone' }, ev.bell === 6 ? 'Sunrise' : 'Sunset'), el('span', { class: 'muted' }, ev.bell === 6 ? 'Day begins' : 'Night begins'))
        : ev.node
          ? el('div', { class: 'tl-what' }, el('span', { class: 'tl-zone' }, nodeTitle(ev.node)),
            el('span', { class: 'muted' }, `${KIND_LABEL[ev.node.kind]} ${ev.node.job.toLowerCase()} node appears · ${ev.node.zone}`))
          : el('div', { class: 'tl-what' }, el('span', { class: 'tl-zone' }, ev.zone.name),
          el('span', { class: 'tl-change' }, chip(ev.p.previous, true), el('span', { class: 'arrow', 'aria-label': 'to' }, '→'), chip(ev.p.weather, true))),
      el('div', { class: 'tl-cd' }, countdown(ev.at), ev.bell != null ? null
        : calButton(`up:${ev.key}`, ev.node ? nodeTitle(ev.node) : `${ev.zone.name}, ${wxName(ev.p.previous)} to ${wxName(ev.p.weather)}`))))));
    if (!state.favorites.size && !state.nodeFavorites.size && !state.resetStars.size) items.unshift(el('li', { class: 'tl-item tl-note muted' }, 'Star zones in Weather now, nodes in Timed gathering or resets in Resets to see them here.'));
    $('timeline-list').replaceChildren(...items);
  }

  // ---- timed gathering ----
  const KIND_LABEL = { unspoiled: 'Unspoiled', legendary: 'Legendary' };
  const nodeTitle = (n) => n.items.map((i) => i.name).join(', ');
  const fmtCoords = (c) => `(${c[0].toFixed(1)}, ${c[1].toFixed(1)})`;
  // The time windows the list can show: nodes up now plus those appearing within the window.
  const VIEWS = {
    15: { within: 15 * 60000, heading: 'Next 15 minutes', more: 'more within 15 minutes' },
    30: { within: 30 * 60000, heading: 'Next 30 minutes', more: 'more within 30 minutes' },
    hour: { within: 60 * 60000, heading: 'Next hour', more: 'more within the next hour' },
    all: { within: Infinity, heading: 'Later', more: 'later' },
  };
  const EXPANSION_SHORT = { 'A Realm Reborn': 'ARR', Heavensward: 'HW', Stormblood: 'SB', Shadowbringers: 'ShB', Endwalker: 'EW', Dawntrail: 'DT' };
  const NODE_EXPANSIONS = DATA.expansions.filter((x) => NODES.some((n) => n.expansion === x));
  const NODE_LEVELS = [...new Set(NODES.map((n) => n.level))].sort((a, b) => a - b);
  let gatheringNext = Infinity;

  function gatherFilters() {
    const g = state.gather;
    return {
      jobs: g.jobs, kinds: g.kinds, expansions: g.expansions, minLevel: g.minLevel, maxLevel: g.maxLevel,
      hideAbove: g.hideAbove, myLevels: g.myLevels, starred: g.starred ? state.nodeFavorites : null, query: state.nodeSearch,
    };
  }
  // Nodes up now (ending soonest first), then nodes appearing within the chosen window of real
  // time (soonest first). "All" is the same order with no time limit.
  function renderGathering(now) {
    const g = state.gather, view = VIEWS[g.view], within = view.within;
    const nodes = NODES.filter((n) => G.matches(n, gatherFilters()));
    const { active, upcoming } = G.schedule(nodes, now, within);
    const later = g.up ? [] : upcoming;
    gatheringNext = G.scheduleChangesAt(nodes, now, within);
    const heading = (label, count) => el('li', { class: 'node-heading' }, label, el('span', { class: 'muted' }, ` ${count}`));
    const items = [];
    if (active.length) items.push(heading('Up now', active.length), ...active.map((e) => nodeRow(e.node, { up: true, start: e.start, end: e.end }, now)));
    if (later.length) items.push(heading(view.heading, later.length), ...later.map((e) => nodeRow(e.node, { up: false, start: e.start, end: e.end }, now)));
    $('node-list').replaceChildren(...items);
    const filtered = nodes.length < NODES.length ? ` · ${nodes.length} of ${NODES.length} nodes match the filters` : '';
    setText($('node-summary'), `${active.length} up now${g.up ? '' : `, ${later.length} ${view.more}`}${filtered}`);
    const empty = $('node-empty');
    empty.hidden = items.length > 0;
    if (!items.length) empty.textContent = g.starred && !state.nodeFavorites.size ? 'Star a node to pin it here.' : 'No node matches these filters.';
  }
  function nodeRow(n, s, now) {
    const fav = state.nodeFavorites.has(n.id);
    const items = n.items.map((i) => el('li', null,
      el('span', { class: 'node-item' }, i.name),
      i.stars ? el('span', { class: 'stars', 'aria-label': `${i.stars} star${i.stars > 1 ? 's' : ''}` }, '★'.repeat(i.stars)) : null,
      el('span', { class: 'muted small' }, ` Lv ${i.level}`),
      i.collectable ? el('span', { class: 'badge tag' }, 'Collectable') : null,
      i.hidden ? el('span', { class: 'badge tag' }, 'Hidden') : null));
    const times = n.times.map(([start]) => E.formatEt(Math.floor(start / 60), start % 60)).join(' and ');
    const hours = n.times[0][1] / 60;
    return el('li', {
      class: `node-row${s.up ? ' up' : ''}${fav ? ' fav' : ''}`, 'data-id': String(n.id), 'data-up': String(s.up),
      'data-start': String(s.start), 'data-end': String(s.end), 'data-level': String(n.level), 'data-job': n.job,
      'data-kind': n.kind, 'data-expansion': n.expansion,
    },
      el('button', { class: 'star', type: 'button', 'data-node-star': String(n.id), 'aria-pressed': String(fav), 'aria-label': `Star ${nodeTitle(n)}`, html: '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-star"/></svg>' }),
      el('div', { class: 'node-main' },
        el('ul', { class: 'node-items' }, items),
        el('p', { class: 'node-meta' },
          el('span', { class: `badge kind ${n.kind}` }, KIND_LABEL[n.kind]),
          ` ${n.job} · ${n.gathering} Lv ${n.level} · `,
          n.zoneKey ? el('button', { class: 'link', type: 'button', 'data-open': n.zoneKey }, n.zone) : n.zone,
          `, ${n.area} ${fmtCoords(n.coords)}`),
        n.folklore ? el('p', { class: 'node-meta muted' }, `Needs ${n.folklore}`) : null),
      el('div', { class: 'node-when' },
        el('span', { class: 'node-times' }, `${times} ET`, el('span', { class: 'muted' }, ` for ${hours} bell${hours === 1 ? '' : 's'}`), calButton(`node:${n.id}`, nodeTitle(n))),
        s.up
          ? el('span', { class: 'node-status' }, el('span', { class: 'badge now' }, 'Up'), ' ends in ', countdown(s.end))
          : el('span', { class: 'node-status' }, `${localWhen(s.start, now)} · in `, countdown(s.start))));
  }

  // Reminders for starred nodes and starred resets while the page is open: a toast, and a system
  // notification when the browser allows one. Each window or reset is announced once.
  const reminded = new Set();
  function checkReminders(now) {
    if (state.remindLead != null) {
      const lead = state.remindLead * 60000;
      for (const id of state.nodeFavorites) {
        const n = NODE_BY_ID.get(id), s = G.status(n, now);
        const start = s.start, key = `${id}:${start}`;
        if (reminded.has(key)) continue;
        const due = start - lead;
        if (now >= due && now < Math.max(start, due + 15000)) {
          reminded.add(key);
          const when = start > now ? `in ${fmtCountdown(start - now)} (${etLabel(start)})` : `now (${etLabel(start)})`;
          notify(`${nodeTitle(n)}`, `${KIND_LABEL[n.kind]} ${n.job.toLowerCase()} node in ${n.zone}, ${n.area} ${fmtCoords(n.coords)}: up ${when}.`);
        }
      }
    }
    if (state.resetRemindLead != null) {
      const lead = state.resetRemindLead * 60000;
      for (const r of starredResets()) {
        // The next start, or one that came in the last 15 s (a reminder "when it happens" may be a tick late).
        const start = R.nextStart(r, now - 15000), key = `r:${r.id}:${start}`;
        if (reminded.has(key)) continue;
        const due = start - lead;
        if (now >= due && now < Math.max(start, due + 15000)) {
          reminded.add(key);
          const when = start > now ? `In ${fmtCountdown(start - now)}, at ${resetLocal(start, now)} (${utcClock(start)})` : `Now, ${resetLocal(start, now)} (${utcClock(start)})`;
          notify(r.name, `${when}.${r.certainty === 'unverified' ? ' Time unverified: from community sources only.' : ''}`);
        }
      }
    }
  }
  function notify(title, body) {
    const toast = el('div', { class: 'toast', role: 'status' }, el('strong', null, title), el('span', null, body),
      el('button', { type: 'button', class: 'ghost small', 'aria-label': 'Dismiss', onclick: (e) => e.currentTarget.parentElement.remove() }, '×'));
    $('toasts').append(toast);
    setTimeout(() => toast.remove(), 20000);
    try {
      if ('Notification' in window && Notification.permission === 'granted') new Notification(title, { body, tag: title });
    } catch (e) { /* the toast is enough */ }
  }
  function syncNotifyButton() {
    const supported = 'Notification' in window, permission = supported ? Notification.permission : 'unsupported';
    $('notify-enable').hidden = state.remindLead == null || permission !== 'default';
    $('reset-notify-enable').hidden = state.resetRemindLead == null || permission !== 'default';
    $('reset-reminder-note').hidden = state.resetRemindLead == null;
    const said = {
      granted: 'Notifications are allowed.',
      denied: 'Notifications are blocked for this site in your browser settings.',
      unsupported: 'This browser does not offer notifications.',
      default: '',
    }[permission] || '';
    setText($('notify-state'), said);
    setText($('reset-notify-state'), said);
  }

  // ---- forecast ----
  function zoneOptions(select, selected) {
    const groups = EXPANSIONS.map((x) => el('optgroup', { label: x }, ZONES.filter((z) => z.expansion === x).map((z) => el('option', { value: z.key }, z.name))));
    select.replaceChildren(el('option', { value: '', disabled: true }, 'Choose a zone'), ...groups);
    select.value = BY_KEY.has(selected) ? selected : '';
  }
  function notSupported(key) {
    const u = UNSUPPORTED.get(key);
    return el('p', { class: 'notice' }, u
      ? `${u.name} has weather in the game, but FFXIV Timer does not forecast it yet: its weather table has not been verified. No guess is shown.`
      : 'Choose a zone to see its forecast.');
  }
  function renderForecast(now) {
    const body = $('forecast-body'), z = BY_KEY.get(state.forecastZone);
    if (!z) { body.replaceChildren(notSupported(state.forecastZone)); return; }
    const odds = [...W.odds(z)].sort((a, b) => b[1] - a[1]);
    const oddsList = el('ul', { class: 'odds', 'aria-label': 'Chance of each weather' }, odds.map(([id, pct]) => el('li', null,
      chip(id, true), el('span', { class: 'bar' }, el('span', { style: `width:${pct}%` })), el('span', { class: 'pct' }, `${pct}%`))));
    const rows = W.periods(z, now, state.forecastCount).map((p, i) => el('tr', { class: i === 0 ? 'current' : null },
      el('td', null, localWhen(p.start, now)),
      el('td', null, `${E.formatEt(p.bell, 0)}`),
      el('td', null, chip(p.weather, true)),
      el('td', { class: 'hide-narrow' }, chip(p.previous, true)),
      el('td', { class: 'num' }, i === 0 ? el('span', { class: 'badge now' }, 'Now') : countdown(p.start))));
    const table = el('table', { class: 'periods' },
      el('caption', { class: 'visually-hidden' }, `Weather in ${z.name} by eight-bell period`),
      el('thead', null, el('tr', null, el('th', { scope: 'col' }, 'Local'), el('th', { scope: 'col' }, 'ET'), el('th', { scope: 'col' }, 'Weather'),
        el('th', { scope: 'col', class: 'hide-narrow' }, 'Before'), el('th', { scope: 'col', class: 'num' }, 'Starts in'))),
      el('tbody', null, rows));
    const more = state.forecastCount < 72
      ? el('button', { type: 'button', class: 'ghost small', id: 'forecast-more' }, 'Show 12 more') : null;
    body.replaceChildren(
      el('p', { class: 'muted zone-meta' }, `${z.region} · ${z.expansion}`),
      oddsList, el('div', { class: 'table-wrap' }, table), more);
  }

  // ---- transition finder ----
  function weathersOf(z) { return [...W.odds(z).keys()]; }
  function toggleChips(container, values, selected, label, onToggle) {
    container.replaceChildren(...values.map((v) => el('button', {
      type: 'button', class: 'chip-toggle', 'aria-pressed': String(selected.includes(v)),
      onclick: () => onToggle(v),
    }, label(v))));
  }
  function renderFinder(now) {
    const f = state.finder, z = BY_KEY.get(f.zone), results = $('finder-results'), summary = $('finder-summary');
    const forms = [$('finder-prev'), $('finder-to'), $('finder-bells')];
    if (!z) {
      forms.forEach((n) => n.replaceChildren());
      results.replaceChildren();
      summary.replaceChildren(notSupported(f.zone));
      return;
    }
    const flip = (list, v) => (list.includes(v) ? list.filter((x) => x !== v) : list.concat(v));
    const update = (patch) => {
      Object.assign(state.finder, patch);
      writeHash();
      const t = Date.now();
      renderFinder(t); updateCountdowns(t);
    };
    toggleChips(forms[0], weathersOf(z), f.prev, (id) => chip(id, true), (id) => update({ prev: flip(f.prev, id) }));
    toggleChips(forms[1], weathersOf(z), f.to, (id) => chip(id, true), (id) => update({ to: flip(f.to, id) }));
    toggleChips(forms[2], PERIOD_BELLS, f.bells, (b) => `${E.formatEt(b, 0)}`, (b) => update({ bells: flip(f.bells, b) }));
    if (!f.prev.length && !f.to.length) {
      results.replaceChildren();
      summary.textContent = 'Pick a weather, a weather before it, or both.';
      return;
    }
    const found = W.findTransitions(z, { from: now, previous: f.prev, to: f.to, bells: f.bells, limit: FINDER_LIMIT, horizon: FINDER_HORIZON });
    if (!found.possible) {
      const never = f.prev.concat(f.to).filter((id) => !W.odds(z).has(id)).map(wxName);
      summary.textContent = `${never.join(' and ')} never happens in ${z.name}.`;
      results.replaceChildren();
      return;
    }
    summary.textContent = found.matches.length
      ? `${found.matches.length === FINDER_LIMIT ? 'Next' : 'All'} ${found.matches.length} in the next 30 days, ${z.name}.`
      : `No match in ${z.name} in the next 30 days.`;
    results.replaceChildren(...found.matches.map((m) => el('li', { class: 'result' },
      el('div', { class: 'tl-when' }, el('span', null, localWhen(m.start, now)), el('span', { class: 'muted' }, `${E.formatEt(m.bell, 0)} ET`)),
      el('span', { class: 'tl-change' }, chip(m.previous, true), el('span', { class: 'arrow', 'aria-label': 'then' }, '→'), chip(m.weather, true)),
      el('div', { class: 'tl-cd' }, m.start <= now ? el('span', { class: 'badge now' }, 'Now') : countdown(m.start),
        calButton(`match:${m.start}`, `${wxName(m.previous)} then ${wxName(m.weather)}, ${localWhen(m.start, now)}`)))));
  }

  // ---- resets ----
  // Every time in the viewer's own time zone, named, with UTC beside it: guides give reset times in UTC
  // (GMT) and the Lodestone in Pacific time, so the UTC line lets a time read elsewhere be matched. The
  // engine (js/resets.js) works in UTC only.
  const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const RESET_GROUPS = [['daily', 'Daily'], ['weekly', 'Weekly'], ['housing', 'Housing lottery']];
  const hhmm = (minute) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
  /** A rule in UTC, as guides write it: "every day, 15:00 UTC", "every Tuesday, 08:00 UTC". */
  function utcRule(rule) {
    if (rule.type === 'daily') return `every day, ${rule.minutesUtc.map(hhmm).join(' and ')} UTC`;
    if (rule.type === 'weekly') return `every ${WEEKDAY[rule.weekday]}, ${hhmm(rule.minuteUtc)} UTC`;
    return `every ${rule.periodDays} days, ${hhmm(Math.round((rule.anchor % 86400000) / 60000))} UTC`;
  }
  /** A start in local time with its zone: "Today 9:00 AM CST", "Sat 8:00 PM CST". */
  const resetLocal = (t, now) => `${dayWord(t, now)} ${fmt('time').format(t)}${zoneAbbr(t) ? ` ${zoneAbbr(t)}` : ''}`;
  const unverifiedBadge = (r) => (r.certainty === 'unverified' ? el('span', { class: 'badge unverified', title: 'From community sources only; not yet checked in the game.' }, 'time unverified') : null);
  /** An instant in UTC as guides write it: "15:00 UTC". */
  const utcClock = (t) => { const d = new Date(t); return `${hhmm(d.getUTCHours() * 60 + d.getUTCMinutes())} UTC`; };
  // The resets a panel row stands for: one reset, the chosen data center's Jumbo Cactpot ("jumbo-cactpot"),
  // or the housing lottery's two phases ("housing").
  function rowResets(rowId) {
    if (rowId === 'housing') return [R.byId('housing-entry'), R.byId('housing-results')];
    if (rowId === 'jumbo-cactpot') return state.resetsDc ? [R.byId(`jumbo-cactpot-${state.resetsDc}`)] : [];
    const r = R.byId(rowId);
    return r && (!r.dataCenter || r.dataCenter === state.resetsDc) ? [r] : [];
  }
  /** The resets of the starred rows, each once. */
  const starredResets = () => [...new Set([...state.resetStars].flatMap(rowResets))];
  const starKey = (r) => (r.dataCenter ? 'jumbo-cactpot' : r.id);
  const resetStar = (key, name) => el('button', {
    class: 'star', type: 'button', 'data-reset-star': key, 'aria-pressed': String(state.resetStars.has(key)), 'aria-label': `Star ${name}`,
    html: '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-star"/></svg>',
  });
  let resetsNext = Infinity, resetsDay = '';
  function resetRow(r, now) {
    const t = R.nextStart(r, now);
    return el('li', { class: `reset-row${state.resetStars.has(starKey(r)) ? ' fav' : ''}`, 'data-reset': r.id, 'data-at': String(t) },
      resetStar(starKey(r), r.name),
      el('div', { class: 'reset-what' }, el('span', { class: 'reset-name' }, r.name, unverifiedBadge(r)), el('span', { class: 'muted small' }, r.short || r.about)),
      el('div', { class: 'reset-when' }, el('span', { class: 'reset-local' }, resetLocal(t, now)), el('span', { class: 'muted small reset-utc' }, utcRule(r.rule))),
      el('div', { class: 'tl-cd' }, countdown(t), calButton(`reset:${r.id}`, r.name)));
  }
  /** A starred reset in Upcoming: its local time, its UTC time where the others show ET, and a countdown. */
  function timelineReset(ev, now) {
    return el('li', { class: 'tl-item tl-reset', 'data-reset': ev.reset.id, 'data-at': String(ev.at) },
      el('div', { class: 'tl-when' }, el('span', null, localWhen(ev.at, now)), el('span', { class: 'muted' }, utcClock(ev.at))),
      el('div', { class: 'tl-what' }, el('span', { class: 'tl-zone' }, ev.reset.name, unverifiedBadge(ev.reset)), el('span', { class: 'muted' }, 'Starred in Resets')),
      el('div', { class: 'tl-cd' }, countdown(ev.at), calButton(`up:${ev.key}`, ev.reset.name)));
  }
  function renderResets(now) {
    const listed = R.listed(state.resetsDc);
    resetsNext = Math.min(...listed.map((r) => R.nextStart(r, now)));
    resetsDay = new Date(now).toDateString();
    setText($('resets-zone'), `Times are in your time zone, ${zoneLabel(now)}, with UTC beside each one: guides usually give reset times in UTC (GMT), and the Lodestone in Pacific time.`);
    const items = [];
    for (const [group, title] of RESET_GROUPS) {
      items.push(el('li', { class: 'reset-heading' }, title));
      if (group === 'housing') {
        const p = R.lotteryPhase(now), entry = p.phase === 'entry', r = R.byId('housing-entry');
        items.push(el('li', { class: `reset-row${state.resetStars.has('housing') ? ' fav' : ''}`, 'data-reset': 'housing', 'data-phase': p.phase, 'data-at': String(p.end) },
          resetStar('housing', 'the housing lottery periods'),
          el('div', { class: 'reset-what' }, el('span', { class: 'reset-name' }, entry ? 'Entry period now' : 'Results period now', unverifiedBadge(r)),
            el('span', { class: 'muted small' }, entry ? 'Entries are open on every World. The 4-day results period follows.' : 'Winners can finalize their purchase. The next 5-day entry period follows.')),
          el('div', { class: 'reset-when' }, el('span', { class: 'reset-local' }, `until ${resetLocal(p.end, now)}`), el('span', { class: 'muted small reset-utc' }, utcRule(r.rule))),
          el('div', { class: 'tl-cd' }, countdown(p.end), calButton('reset:housing', 'Housing lottery'))));
        continue;
      }
      for (const r of listed.filter((x) => x.group === group)) items.push(resetRow(r, now));
      if (group === 'weekly' && !state.resetsDc) {
        items.push(el('li', { class: 'reset-row', 'data-reset': 'jumbo-cactpot' },
          el('span', { class: 'star-space', 'aria-hidden': 'true' }),
          el('div', { class: 'reset-what' }, el('span', { class: 'reset-name' }, 'Jumbo Cactpot drawing'),
            el('span', { class: 'muted small' }, 'Each data center draws at its own time. Choose yours above to see it.'))));
      }
    }
    $('resets-list').replaceChildren(...items);
  }

  // ---- add to calendar ----
  // One dialog for every panel: a calendar file (.ics) written in this browser by js/ics.js. Each button
  // offers choices (this node, starred nodes, ...); a choice names its source, its ranges, and how to gather
  // what it covers at the moment the file is made, so a file is never stale. Nothing here is saved or sent:
  // the choices last while the page is open, and the file leaves the page only as a download.
  const ICS_BASE = { data: { weather: DATA, gathering: window.FFXIV_GATHERING_DATA }, engines: { weather: W, gathering: G, resets: R } };
  const RANGE_TEXT = { '2h': 'Next 2 hours', '6h': 'Next 6 hours', '1d': 'Next 24 hours', '3d': 'Next 3 days', '7d': 'Next 7 days', '30d': 'Next 30 days' };
  const NEXT_TEXT = { transition: 'Next match', node: 'Next spawn', weather: 'Next change', reset: 'Next one of each' };
  const cal = { choices: [], choice: null, range: {}, alarm: 0, opener: null, refreshAt: Infinity, loadFailed: false };
  const calDialog = () => $('calendar');

  // The finder's search and its matches from now, as the finder lists them, or null when nothing is asked.
  function finderNow(now) {
    const f = state.finder, z = BY_KEY.get(f.zone);
    if (!z || (!f.prev.length && !f.to.length)) return null;
    const found = W.findTransitions(z, { from: now, previous: f.prev, to: f.to, bells: f.bells, limit: FINDER_LIMIT, horizon: FINDER_HORIZON });
    return { zone: z, search: { prev: [...f.prev], to: [...f.to], bells: [...f.bells] }, matches: found.possible ? found.matches : [] };
  }
  const starredNodes = () => NODES.filter((n) => state.nodeFavorites.has(n.id));
  const filteredNodes = () => NODES.filter((n) => G.matches(n, gatherFilters()));
  const starredZones = () => [...state.favorites].map((k) => BY_KEY.get(k)).filter(Boolean);

  // Choices. gather(now) gives what plan() needs besides source, range and now; file(g) the file name's parts.
  const CHOICE = {
    transitions: () => {
      const f = finderNow(Date.now());
      return {
        id: 'transitions', source: 'transition', ranges: ['next', 'shown'],
        label: f ? `Matches of this search in ${f.zone.name} (${f.matches.length})` : 'Matches of the Weather transitions search',
        rangeText: { shown: 'The matches shown (up to 10, within 30 days)' },
        gather: (now) => finderNow(now) || { matches: [] },
        file: () => ({ key: state.finder.zone }),
        empty: 'Choose a weather, a weather before it, or both, in Weather transitions, to have matches to add.',
      };
    },
    match: (start) => ({
      id: 'match', source: 'transition', ranges: ['shown'], label: `This match: ${localWhen(start, Date.now())}`, rangeText: { shown: 'This match' },
      gather: (now) => { const f = finderNow(now); return f ? Object.assign(f, { matches: f.matches.filter((m) => m.start === start) }) : { matches: [] }; },
      file: () => ({ key: state.finder.zone }),
      empty: 'That match has passed.',
    }),
    node: (n) => ({
      id: 'node', source: 'node', ranges: ['next', '2h', '6h'], label: `This node: ${nodeTitle(n)} (${n.zone})`,
      gather: () => ({ nodes: [n] }), file: () => ({ scope: 'one', key: String(n.id) }), empty: '',
    }),
    starredNodes: () => ({
      id: 'starred-nodes', source: 'node', ranges: ['next', '2h', '6h'], label: `Starred nodes (${state.nodeFavorites.size})`,
      gather: () => ({ nodes: starredNodes() }), file: () => ({ scope: 'starred' }),
      empty: 'No nodes are starred yet. Star one in Timed gathering, or choose another option here.',
    }),
    filteredNodes: () => ({
      id: 'filtered-nodes', source: 'node', ranges: ['next', '2h', '6h'], label: `Nodes the gathering filters match (${filteredNodes().length} of ${NODES.length})`,
      gather: () => ({ nodes: filteredNodes() }), file: (g) => ({ scope: 'choose', count: g.nodes.length }),
      empty: 'No node matches the gathering filters.',
    }),
    starredWeather: () => ({
      id: 'starred-weather', source: 'weather', ranges: ['next', '2h', '6h'], label: `Weather changes in starred zones (${state.favorites.size})`,
      gather: () => ({ zones: starredZones() }), file: () => ({ scope: 'starred' }),
      empty: 'No zones are starred yet. Star a zone in Weather now.',
    }),
    upcoming: () => ({
      id: 'upcoming', source: 'upcoming', ranges: ['listed'], label: `Everything Upcoming lists (${upcomingItems(Date.now()).length}; not sunrise and sunset)`,
      rangeText: { listed: 'As Upcoming lists them: the next 2 hours, at most 16' },
      gather: (now) => ({ items: upcomingItems(now) }), file: () => ({}),
      empty: 'Upcoming lists nothing to add. Star zones in Weather now or nodes in Timed gathering.',
    }),
    upcomingOne: (key, label) => ({
      id: 'upcoming-one', source: 'upcoming', ranges: ['listed'], label: `This entry: ${label}`, rangeText: { listed: 'This entry' },
      gather: (now) => ({ items: upcomingItems(now).filter((it) => it.key === key) }), file: () => ({}),
      empty: 'That entry has passed.',
    }),
    reset: (rowId, name) => ({
      id: 'reset', source: 'reset', ranges: ['next', '1d', '3d', '7d', '30d'], label: `This reset: ${name}`,
      rangeText: rowId === 'housing' ? {} : { next: 'Next one' },
      gather: () => ({ resets: rowResets(rowId) }), file: () => ({ scope: 'one', key: rowId }), empty: '',
    }),
    resets: () => ({
      id: 'resets', source: 'reset', ranges: ['next', '1d', '3d', '7d', '30d'], label: `All resets listed (${R.listed(state.resetsDc).length})`,
      gather: () => ({ resets: R.listed(state.resetsDc) }), file: () => ({}), empty: '',
    }),
  };

  /** The choices a button offers, first the one it stands for. */
  function calendarFor(key) {
    const [kind, ...rest] = key.split(':'), arg = rest.join(':');
    if (kind === 'upcoming') return [CHOICE.upcoming(), CHOICE.starredWeather()];
    if (kind === 'up') {
      const it = upcomingItems(Date.now()).find((x) => x.key === arg);
      const label = !it ? 'this entry' : it.node ? nodeTitle(it.node) : it.reset ? it.reset.name : `${it.zone.name}, ${wxName(it.change.from)} to ${wxName(it.change.to)}`;
      return [CHOICE.upcomingOne(arg, label), CHOICE.upcoming(), CHOICE.starredWeather()];
    }
    if (kind === 'nodes') return state.nodeFavorites.size ? [CHOICE.starredNodes(), CHOICE.filteredNodes()] : [CHOICE.filteredNodes(), CHOICE.starredNodes()];
    if (kind === 'node' && NODE_BY_ID.has(Number(arg))) return [CHOICE.node(NODE_BY_ID.get(Number(arg))), CHOICE.starredNodes(), CHOICE.filteredNodes()];
    if (kind === 'finder') return [CHOICE.transitions()];
    if (kind === 'match' && Number.isFinite(Number(arg))) return [CHOICE.match(Number(arg)), CHOICE.transitions()];
    if (kind === 'resets') return [CHOICE.resets()];
    if (kind === 'reset') {
      const rs = rowResets(arg);
      return rs.length ? [CHOICE.reset(arg, arg === 'housing' ? 'Housing lottery entry and results periods' : rs[0].name), CHOICE.resets()] : [CHOICE.resets()];
    }
    return [];
  }

  const rangeOf = (c) => (c.ranges.includes(cal.range[c.source]) ? cal.range[c.source] : c.ranges[0]);
  const rangeLabel = (c, r) => (c.rangeText && c.rangeText[r]) || (r === 'next' ? NEXT_TEXT[c.source] : RANGE_TEXT[r]) || r;
  /** "today at 9:00 AM", "tomorrow at ...", "Sat at ...", "Tue, Nov 24 at ...": in the viewer's time. */
  function calWhen(t, now) { const w = dayWord(t, now); return `${w === 'Today' || w === 'Tomorrow' ? w.toLowerCase() : w} at ${fmt('time').format(t)}`; }

  function calSummary(p, c, now) {
    if (!p.ok) {
      if (p.reason === 'empty') return c.empty || 'There is nothing to add.';
      if (p.reason === 'none') return 'Nothing starts in that time. Choose a longer one.';
      if (p.reason === 'too-many') return `That would be ${p.count} entries, more than the ${Ics.MAX_ENTRIES} one file can hold. Choose fewer, or a shorter time.`;
      return 'No file can be made from these choices.';
    }
    const first = p.entries[0], last = p.entries[p.entries.length - 1], under = p.entries.filter((e) => e.opened !== undefined).length;
    const when = (e) => (e.opened !== undefined ? 'now' : calWhen(e.start, now));
    const tail = !under ? '' : under === 1 ? ' One is already under way, so it starts now and covers the rest.' : ` ${under} are already under way, so they start now and cover the rest.`;
    if (p.count === 1) return `1 entry: ${first.summary}, ${when(first)}, your time (${zoneName() || zoneAbbr(now) || 'local'}).${tail}`;
    return `${p.count} entries, from ${when(first)} to ${when(last)}, your time (${zoneName() || zoneAbbr(now) || 'local'}).${tail}`;
  }

  /** The dialog's controls for the current choice: drawn when it opens and when the choice changes, never by the clock. */
  function syncControls() {
    const c = cal.choice, select = $('calendar-range');
    for (const b of document.querySelectorAll('[name="calendar-choice"]')) b.checked = b.value === c.id;
    select.replaceChildren(...c.ranges.map((r) => el('option', { value: r }, rangeLabel(c, r))));
    select.value = rangeOf(c);
    select.disabled = c.ranges.length < 2;
    $('calendar-alarm').value = String(cal.alarm);
  }
  /**
   * js/ics.js, loaded once, the first time a calendar is asked for: a script from this same site, whose
   * address (with the build's version stamp) waits in index.html's lazy-scripts template. The file is
   * still made entirely in this browser. A failed load is tried again on the next request.
   */
  let icsLoad = null;
  function loadIcs() {
    if (Ics) return Promise.resolve(Ics);
    if (!icsLoad) {
      icsLoad = new Promise((ok, fail) => {
        const src = $('lazy-scripts').content.querySelector('[data-lazy="ics"]').getAttribute('src');
        const s = el('script', { src, onload: () => (window.XivIcs ? ok(window.XivIcs) : fail(new Error('js/ics.js did not load'))), onerror: () => fail(new Error('js/ics.js did not load')) });
        document.head.append(s);
      }).then((m) => { Ics = m; return m; }, (e) => { icsLoad = null; throw e; });
    }
    return icsLoad;
  }

  /** The summary for the current choices, worked out at this moment; redone as time passes while the dialog is open. */
  function syncCalendar() {
    if (!Ics) {
      // Until js/ics.js is here, the dialog says so and offers no file.
      setText($('calendar-summary'), cal.loadFailed ? 'The calendar tool could not load. Check your connection, then close this and try again.' : 'Loading the calendar tool.');
      for (const id of ['calendar-warn', 'calendar-uncertain']) $(id).hidden = true;
      $('calendar-download').disabled = true;
      cal.refreshAt = Infinity;
      return;
    }
    const c = cal.choice, now = Date.now(), range = rangeOf(c);
    const p = Ics.plan(Object.assign({}, ICS_BASE, c.gather(now), { source: c.source, range, now }));
    setText($('calendar-summary'), calSummary(p, c, now));
    const warn = $('calendar-warn');
    warn.hidden = !p.warn;
    setText(warn, p.warn ? `That is more than ${Ics.WARN_ENTRIES} entries. Check that you want this many in your calendar before you download.` : '');
    const marked = p.ok ? [...new Map(p.entries.filter((e) => Ics.note(e)).map((e) => [e.uid.replace(/-\d{8}T\d{6}Z$/, ''), e.summary])).values()] : [];
    const unsure = $('calendar-uncertain');
    unsure.hidden = !marked.length;
    setText(unsure, marked.length ? `Marked "time unverified" in their titles (community sources only): ${marked.join(', ')}.` : '');
    $('calendar-download').disabled = !p.ok;
    // Redone when the first entry starts (it then drops out or is under way) and every 15 s, as ranges move with now.
    const firstStart = p.ok ? Math.min(...p.entries.filter((e) => e.opened === undefined).map((e) => e.start), ...p.entries.map((e) => e.end)) : Infinity;
    cal.refreshAt = Math.min(now + 15000, firstStart);
  }

  function openCalendar(key, opener) {
    const choices = calendarFor(key);
    if (!choices.length) return;
    cal.choices = choices;
    cal.choice = choices[0];
    cal.opener = { key, el: opener };
    $('calendar-choices').replaceChildren(...choices.map((c) => el('label', { class: 'cal-option' },
      el('input', { type: 'radio', name: 'calendar-choice', value: c.id }), el('span', null, c.label))));
    setText($('calendar-done'), '');
    cal.loadFailed = false;
    syncControls();
    syncCalendar();
    calDialog().showModal();
    if (!Ics) {
      loadIcs().then(() => { if (calDialog().open) syncCalendar(); }, () => { cal.loadFailed = true; if (calDialog().open) syncCalendar(); });
    }
  }

  function downloadCalendar() {
    if (!Ics) return;
    const c = cal.choice, now = Date.now(), range = rangeOf(c), g = c.gather(now);
    const r = Ics.build(Object.assign({}, ICS_BASE, g, { source: c.source, range, now, alarmMin: cal.alarm }));
    if (!r.ok) { syncCalendar(); return; }
    const name = Ics.filename(Object.assign({ source: c.source, range }, c.file(g)));
    try {
      const url = URL.createObjectURL(new Blob([r.text], { type: 'text/calendar;charset=utf-8' }));
      const a = el('a', { href: url, download: name, hidden: true });
      calDialog().append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      setText($('calendar-done'), `Downloading ${name} (${r.count} ${r.count === 1 ? 'entry' : 'entries'}). Open it with your calendar app, or import it on your calendar's website.`);
    } catch (e) {
      setText($('calendar-done'), 'This browser could not save the file.');
    }
  }

  function wireCalendar() {
    const dialog = calDialog();
    // Every Add to calendar button, including the ones inside lists that are redrawn, carries data-cal.
    document.addEventListener('click', (e) => {
      const b = e.target.closest && e.target.closest('[data-cal]');
      if (b && !dialog.contains(b)) openCalendar(b.dataset.cal, b);
    });
    dialog.addEventListener('change', (e) => {
      const t = e.target;
      if (t.name === 'calendar-choice' && t.checked) { cal.choice = cal.choices.find((c) => c.id === t.value) || cal.choice; syncControls(); }
      else if (t.id === 'calendar-range' && cal.choice.ranges.includes(t.value)) cal.range[cal.choice.source] = t.value;
      else if (t.id === 'calendar-alarm' && [...t.options].some((o) => o.value === t.value)) cal.alarm = Number(t.value);
      else return;
      setText($('calendar-done'), '');
      syncCalendar();
    });
    $('calendar-download').addEventListener('click', downloadCalendar);
    dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
    // Focus goes back to the button that opened the dialog, or to the same button drawn again since.
    dialog.addEventListener('close', () => {
      const from = cal.opener;
      cal.opener = null; cal.refreshAt = Infinity;
      const back = from && (from.el && from.el.isConnected ? from.el : document.querySelector(`[data-cal="${CSS.escape(from.key)}"]`));
      if (back) back.focus();
    });
  }

  // ---- latest news ----
  // The panel starts closed and asks for nothing until it is opened. Headlines are kept in this
  // browser and refreshed every 15 minutes while the panel is open. A failed refresh leaves the
  // last good headlines on screen and tries again soon (News.RETRY_MS), so a blip never shows an
  // error. Nothing here can stop the timers.
  const news = { feeds: null, fetchedAt: null, nextAt: -Infinity, failures: 0, unavailable: false, loading: false };
  const lodestoneLink = (label) => el('a', { href: News.LODESTONE, target: '_blank', rel: 'noopener noreferrer' }, label);
  function renderNews() {
    try {
      const now = Date.now(), when = news.fetchedAt ? localWhen(news.fetchedAt, now) : '';
      const failing = news.failures >= News.QUIET_FAILURES;
      const view = news.feeds ? 'ok' : news.unavailable ? 'unavailable' : failing ? 'failed' : news.loading || news.failures ? 'loading' : 'idle';
      const note = {
        idle: ['Opening this loads the newest headlines from the Lodestone.'],
        loading: ['Loading the newest headlines from the Lodestone.'],
        ok: [`Headlines from the official Lodestone, checked ${when}. `, lodestoneLink('Open the Lodestone'), '.'],
        failed: ['News could not load just now and will try again shortly. The timers are not affected. ', lodestoneLink('Read the news on the Lodestone'), '.'],
        unavailable: ['Headlines load at ', el('a', { href: News.HOME }, 'radmagelabs.com/ffxiv/'), '. Here, ', lodestoneLink('read the news on the Lodestone'), '.'],
      }[view];
      $('news-note').replaceChildren(...note);
      const cols = !news.feeds ? [] : News.FEEDS.map((f) => {
        const items = news.feeds[f.key];
        return el('section', { class: 'news-col', 'data-feed': f.key },
          el('h3', null, f.title),
          !items ? el('p', { class: 'muted small' }, failing ? 'This list could not load just now; trying again shortly.' : 'Loading.')
            : !items.length ? el('p', { class: 'muted small' }, 'No headlines.')
              : el('ul', { class: 'news-list' }, items.map((i) => el('li', null,
                el('a', { href: i.link, target: '_blank', rel: 'noopener noreferrer' }, i.title),
                el('span', { class: 'news-meta' },
                  i.category ? el('span', { class: 'badge tag' }, i.category) : null,
                  i.dateMs ? el('time', { datetime: new Date(i.dateMs).toISOString() }, fmt('day').format(i.dateMs)) : null)))));
      });
      $('news-cols').replaceChildren(...cols);
    } catch (e) { /* the news panel never breaks the page */ }
  }
  // One feed: { items }, { missing: true } for a 404, or {} for any other failure.
  async function fetchFeed(feed) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), News.TIMEOUT_MS);
    try {
      const res = await fetch(feed.path, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: ctl.signal });
      if (res.status === 404) return { missing: true };
      return res.ok ? { items: News.parseFeed(await res.text()) } : {};
    } catch (e) {
      return {};
    } finally {
      clearTimeout(timer);
    }
  }
  async function loadNews() {
    if (news.loading) return;
    // The saved headlines, unless this tab already has newer ones.
    const cache = News.sanitizeCache(Store.read('news', null));
    if (cache && (news.fetchedAt == null || cache.fetchedAt > news.fetchedAt)) Object.assign(news, { feeds: cache.feeds, fetchedAt: cache.fetchedAt });
    const complete = cache && News.FEEDS.every((f) => cache.feeds[f.key].length);
    if (complete && !news.failures && News.isFresh(cache, Date.now())) {
      news.nextAt = cache.fetchedAt + News.REFRESH_MS;
      renderNews();
      return;
    }
    if (location.protocol === 'file:') { Object.assign(news, { unavailable: true, nextAt: Infinity }); renderNews(); return; }
    news.loading = true;
    renderNews();
    const results = await Promise.all(News.FEEDS.map(fetchFeed));
    news.loading = false;
    const outcome = News.roundOutcome(results, location.href.startsWith(News.HOME));
    if (outcome === 'ok' || outcome === 'partial') {
      // A list that failed this time keeps its last good headlines.
      const feeds = {};
      News.FEEDS.forEach((f, i) => { const r = results[i]; feeds[f.key] = r.items && r.items.length ? r.items : (news.feeds && news.feeds[f.key]) || null; });
      Object.assign(news, { feeds, fetchedAt: Date.now() });
      Store.write('news', { fetchedAt: news.fetchedAt, feeds });
    }
    if (outcome === 'ok') Object.assign(news, { failures: 0, nextAt: Date.now() + News.REFRESH_MS });
    else if (outcome === 'unavailable' && !news.feeds) Object.assign(news, { unavailable: true, nextAt: Infinity });
    else { news.failures += 1; news.nextAt = Date.now() + News.retryDelay(news.failures); }
    renderNews();
  }

  // ---- about ----
  function renderAbout() {
    const src = DATA.source;
    const zonesByExpansion = EXPANSIONS.map((x) => `${x}: ${ZONES.filter((z) => z.expansion === x).map((z) => z.name).join(', ')}`);
    $('about-body').replaceChildren(
      el('p', null, 'Eorzea Time, weather forecasts and weather transitions for FINAL FANTASY XIV. Free, no account and nothing to install. Your stars and settings stay in this browser; the only request beyond the page itself is Latest news, and only once you open it.'),
      el('h3', null, 'How the forecast works'),
      el('p', null, 'Weather in FFXIV is not random per player. Every eight bells (00:00, 08:00 and 16:00 ET, which is every 23 minutes 20 seconds) the game turns the current time into a number from 0 to 99 and looks it up in the zone\'s weather table. FFXIV Timer runs the same calculation on the same tables, so a forecast is the weather the game will choose, not an estimate.'),
      el('p', null, 'One bell (Eorzean hour) is 2 minutes 55 seconds and one sun (day) is 70 minutes. The game shows only the time; the date shown here counts suns and moons from the same starting point the weather uses.'),
      el('p', null, "Story scenes and quest versions of a zone can have weather of their own (the game has Everlasting Light tables for the Shadowbringers story versions of Lakeland, Kholusia, Amh Araeng and Eulmore, for example). Forecasts here are each open zone's normal weather."),
      el('h3', null, `Zones with forecasts (${ZONES.length})`),
      el('ul', { class: 'about-list' }, zonesByExpansion.map((t) => el('li', null, t))),
      el('p', null, `${DATA.unsupported.length} other cities, field zones and areas have weather in the game but no forecast here yet. More are added only after their tables are verified.`),
      el('h3', null, `Timed gathering (${NODES.length} nodes)`),
      el('p', null, `Unspoiled and legendary nodes from ${[...new Set(NODES.map((n) => n.expansion))].join(', ')}. Times, items, levels, places and folklore tomes come from the game data; more expansions are added the same way.`),
      el('h3', null, 'Resets'),
      el('p', null, 'Daily and weekly resets, the Mini and Jumbo Cactpot and the housing lottery, shown in your time zone with UTC beside each. The weekly reset, the Mini Cactpot and every data center\'s Jumbo Cactpot drawing are times Square Enix states on the Lodestone (its Cactpot guide and the patch 7.5 notes). The daily reset, Grand Company missions and leve allowances come from community sources only and are marked "time unverified" until they are checked in the game. The housing lottery\'s 9-day cycle (5 days of entry, 4 of results, turning at 15:00 UTC) is from the Lodestone; the dates of the current cycle come from community sources, so it is marked as well. Star a reset to follow it in Upcoming and, if you choose, to be reminded of it while this page is open.'),
      el('h3', null, 'Add to calendar'),
      el('p', null, 'The calendar buttons in Upcoming, Resets, Timed gathering and Weather transitions make a calendar file (.ics) of the times you choose, with an alarm if you want one. The calendar tool loads from this site the first time you use it; the file itself is made in your browser, nothing is sent anywhere and nothing about it is saved. Each entry is written in UTC, so your calendar shows it in your own time zone. The file does not update itself: download a new one after a patch.'),
      el('h3', null, 'Where the data comes from'),
      el('p', null, `Weather tables and gathering nodes come from the game's own data tables for patch ${src.patch}, as exported by the ${src.dataset} project (commit ${src.commit.slice(0, 10)}). Calculations are deterministic: the same moment always gives the same answer.`),
      el('h3', null, 'Checked against reference data'),
      el('ul', { class: 'about-list' },
        el('li', null, 'Every weather table and every gathering node matches a second, independent extraction of the game data from XIVAPI.'),
        el('li', null, 'The weather calculation gives the same result as two independent implementations at tens of thousands of moments.'),
        el('li', null, 'Every gathering node matches the node tables players keep on the FFXIV wiki: zone, spawn times, coordinates, item level and stars, and folklore tome.')),
      el('h3', null, 'Not yet checked in the game'),
      el('p', null, 'Forecasts and node times have not yet been compared with what the game itself shows (a Skywatcher, the weather on the minimap, a node appearing). They are computed from the game’s data, not observed. If you see a difference, ',
        el('a', { href: 'https://github.com/RadMageIRL/ffxiv-timer/issues', rel: 'noopener' }, 'please report it'), '.'),
      el('h3', null, 'Latest news'),
      el('p', null, 'The news bar starts closed and loads nothing until you open it. Opening it asks this site for the newest headlines from the official Lodestone (na.finalfantasyxiv.com); radmagelabs.com fetches them from the Lodestone, so your browser does not contact Square Enix. Only titles, dates and links are shown, and every link goes to the Lodestone. Headlines are refreshed every 15 minutes while the bar is open; if a refresh fails, the last ones stay up and it tries again shortly. At radmageirl.github.io the bar links to the Lodestone instead.'),
      el('h3', null, 'Credits'),
      el('p', null, 'FINAL FANTASY XIV © SQUARE ENIX. Zone and weather names are game text, used under the FINAL FANTASY XIV Materials Usage Policy. FFXIV Timer is a free fan tool and is not affiliated with or endorsed by Square Enix. Icons are original.'),
      el('p', null, 'Code is MIT licensed: ', el('a', { href: 'https://github.com/RadMageIRL/ffxiv-timer', rel: 'noopener' }, 'github.com/RadMageIRL/ffxiv-timer'), '.'));
  }

  // ---- render loop ----
  function renderWeather(now) {
    renderZones(now);
    renderTimeline(now);
    renderResets(now);
    renderForecast(now);
    renderFinder(now);
    renderGathering(now);
    updateCountdowns(now);
  }
  function updateCountdowns(now) {
    for (const node of document.querySelectorAll('[data-until]')) setText(node, fmtCountdown(Number(node.dataset.until) - now));
  }
  let lastPeriod = -1;
  function tick() {
    const now = Date.now();
    renderClock(now);
    const period = E.periodStart(now);
    if (period !== lastPeriod) { lastPeriod = period; renderWeather(now); return; }
    if (now >= gatheringNext) renderGathering(now);
    if (now >= timelineNext) renderTimeline(now);
    if (now >= resetsNext || new Date(now).toDateString() !== resetsDay) renderResets(now);
    if (now >= cal.refreshAt && calDialog().open) syncCalendar();
    if (state.newsOpen && !news.loading && now >= news.nextAt) loadNews();
    checkReminders(now);
    updateCountdowns(now);
  }

  // ---- wiring ----
  function init() {
    readHash();
    const region = $('region-filter');
    region.append(...EXPANSIONS.map((x) => el('optgroup', { label: x },
      el('option', { value: `x:${x}` }, `All of ${x}`),
      regionsOf(x).map((r) => el('option', { value: `r:${r}` }, r)))));
    zoneOptions($('forecast-zone'), state.forecastZone);
    zoneOptions($('finder-zone'), state.finder.zone);
    setText($('data-patch'), DATA.source.patch);
    setText($('hour-cycle'), usesHour12() ? '12h' : '24h');
    renderAbout();
    writeHash();

    // Setting open fires toggle, which loads the headlines when the bar was left open last time.
    const newsPanel = $('news');
    newsPanel.addEventListener('toggle', () => {
      state.newsOpen = newsPanel.open;
      Store.write('newsOpen', state.newsOpen);
      if (state.newsOpen) loadNews();
    });
    newsPanel.open = state.newsOpen;
    renderNews();

    $('node-search').addEventListener('input', (e) => { state.nodeSearch = e.target.value; renderGathering(Date.now()); updateCountdowns(Date.now()); });
    wireGatheringFilters();
    wireCalendar();
    // The data center for the Jumbo Cactpot, grouped by region; saved once one is chosen.
    const dc = $('resets-dc'), regions = [...new Set(R.DATA_CENTERS.map((d) => d.region))];
    dc.replaceChildren(el('option', { value: '' }, 'Choose'), ...regions.map((g) => el('optgroup', { label: g },
      R.DATA_CENTERS.filter((d) => d.region === g).map((d) => el('option', { value: d.key }, d.name)))));
    dc.value = state.resetsDc || '';
    dc.addEventListener('change', () => {
      state.resetsDc = R.dataCenter(dc.value) ? dc.value : null;
      saveResets();
      const t = Date.now();
      renderResets(t); renderTimeline(t); updateCountdowns(t);
    });
    // A starred reset shows in Upcoming and gets reminders, as starred zones and nodes do.
    $('resets-list').addEventListener('click', (e) => {
      const star = e.target.closest('[data-reset-star]');
      if (!star) return;
      const key = star.dataset.resetStar;
      if (state.resetStars.has(key)) state.resetStars.delete(key); else state.resetStars.add(key);
      saveResets();
      const t = Date.now();
      renderResets(t); renderTimeline(t); updateCountdowns(t);
      const again = document.querySelector(`[data-reset-star="${key}"]`);
      if (again) again.focus();
    });
    const resetLead = $('reset-remind');
    resetLead.value = state.resetRemindLead == null ? '' : String(state.resetRemindLead);
    resetLead.addEventListener('change', () => {
      const v = Number(resetLead.value);
      state.resetRemindLead = resetLead.value !== '' && RESET_LEADS.includes(v) ? v : null;
      saveResets();
      syncNotifyButton();
    });
    $('reset-notify-enable').addEventListener('click', async () => {
      try { await Notification.requestPermission(); } catch (err) { /* unsupported */ }
      syncNotifyButton();
    });
    $('node-list').addEventListener('click', (e) => {
      const star = e.target.closest('[data-node-star]'), open = e.target.closest('[data-open]');
      if (star) {
        const id = Number(star.dataset.nodeStar);
        if (state.nodeFavorites.has(id)) state.nodeFavorites.delete(id); else state.nodeFavorites.add(id);
        Store.write('nodeFavorites', [...state.nodeFavorites]);
        const now = Date.now();
        renderGathering(now); renderTimeline(now); updateCountdowns(now);
        const again = document.querySelector(`[data-node-star="${id}"]`);
        if (again) again.focus();
      } else if (open) openForecast(open.dataset.open);
    });
    const lead = $('remind-lead');
    lead.value = state.remindLead == null ? '' : String(state.remindLead);
    lead.addEventListener('change', () => {
      state.remindLead = lead.value === '' ? null : Number(lead.value);
      Store.write('remindLead', state.remindLead);
      syncNotifyButton();
    });
    $('notify-enable').addEventListener('click', async () => {
      try { await Notification.requestPermission(); } catch (e) { /* unsupported */ }
      syncNotifyButton();
    });
    syncNotifyButton();
    $('zone-search').addEventListener('input', (e) => { state.search = e.target.value; renderZones(Date.now()); updateCountdowns(Date.now()); });
    region.addEventListener('change', (e) => { state.area = e.target.value; renderZones(Date.now()); updateCountdowns(Date.now()); });
    // toggle does not bubble, so listen in the capture phase.
    $('zone-list').addEventListener('toggle', (e) => {
      const group = e.target.dataset && e.target.dataset.group;
      if (!group) return;
      if (e.target.open) state.openGroups.add(group); else state.openGroups.delete(group);
      Store.write('openGroups', [...state.openGroups]);
    }, true);
    $('fav-only').addEventListener('click', (e) => {
      state.favOnly = !state.favOnly;
      e.currentTarget.setAttribute('aria-pressed', String(state.favOnly));
      renderZones(Date.now()); updateCountdowns(Date.now());
    });
    $('zone-list').addEventListener('click', (e) => {
      const star = e.target.closest('[data-star]'), open = e.target.closest('[data-open]');
      if (star) {
        const key = star.dataset.star;
        if (state.favorites.has(key)) state.favorites.delete(key); else state.favorites.add(key);
        Store.write('favorites', [...state.favorites]);
        const now = Date.now();
        renderZones(now); renderTimeline(now); updateCountdowns(now);
        const again = document.querySelector(`[data-star="${key}"]`);
        if (again) again.focus();
      } else if (open) openForecast(open.dataset.open);
    });
    $('forecast-zone').addEventListener('change', (e) => {
      state.forecastZone = e.target.value; state.forecastCount = 12;
      writeHash(); renderForecast(Date.now()); updateCountdowns(Date.now());
    });
    $('forecast-body').addEventListener('click', (e) => {
      if (e.target.id !== 'forecast-more') return;
      state.forecastCount = Math.min(72, state.forecastCount + 12);
      renderForecast(Date.now()); updateCountdowns(Date.now());
    });
    $('finder-zone').addEventListener('change', (e) => {
      const z = BY_KEY.get(e.target.value), keep = (ids) => ids.filter((id) => W.odds(z).has(id));
      state.finder = { zone: e.target.value, prev: keep(state.finder.prev), to: keep(state.finder.to), bells: state.finder.bells };
      writeHash(); renderFinder(Date.now()); updateCountdowns(Date.now());
    });
    $('finder-copy').addEventListener('click', async (e) => {
      const button = e.currentTarget;
      try { await navigator.clipboard.writeText(location.href); button.textContent = 'Copied'; } catch (err) { button.textContent = 'Copy failed'; }
      setTimeout(() => { button.textContent = 'Copy link'; }, 1600);
    });
    $('hour-cycle').addEventListener('click', (e) => {
      state.hour12 = !usesHour12();
      Store.write('hour12', state.hour12);
      formats = null;
      e.currentTarget.textContent = state.hour12 ? '12h' : '24h';
      lastPeriod = -1; tick(); renderNews();
    });
    for (const b of document.querySelectorAll('[data-jump]')) b.addEventListener('click', () => jump(b.dataset.jump));
    const about = $('about');
    $('about-open').addEventListener('click', () => about.showModal());
    about.addEventListener('click', (e) => { if (e.target === about) about.close(); });
    window.addEventListener('hashchange', () => {
      readHash();
      $('forecast-zone').value = BY_KEY.has(state.forecastZone) ? state.forecastZone : '';
      $('finder-zone').value = BY_KEY.has(state.finder.zone) ? state.finder.zone : '';
      lastPeriod = -1; tick();
    });

    tick();
    setInterval(tick, 250);
  }
  // Gathering controls: every change is saved and redraws the list.
  function wireGatheringFilters() {
    const g = state.gather;
    const changed = () => { Store.write('gathering', g); const t = Date.now(); renderGathering(t); updateCountdowns(t); };
    const flip = (list, v) => (list.includes(v) ? list.filter((x) => x !== v) : list.concat(v));

    for (const b of document.querySelectorAll('[data-node-view]')) {
      b.setAttribute('aria-pressed', String(g.view === b.dataset.nodeView));
      b.addEventListener('click', () => {
        g.view = b.dataset.nodeView;
        for (const o of document.querySelectorAll('[data-node-view]')) o.setAttribute('aria-pressed', String(o === b));
        changed();
      });
    }
    // Job, kind and status chips.
    const chip = { Miner: ['jobs', 'Miner'], Botanist: ['jobs', 'Botanist'], legendary: ['kinds', 'legendary'], unspoiled: ['kinds', 'unspoiled'], up: ['up'], starred: ['starred'] };
    for (const b of document.querySelectorAll('[data-node-filter]')) {
      const [key, value] = chip[b.dataset.nodeFilter];
      const pressed = () => (value ? g[key].includes(value) : g[key]);
      b.setAttribute('aria-pressed', String(pressed()));
      b.addEventListener('click', () => {
        if (value) g[key] = flip(g[key], value); else g[key] = !g[key];
        b.setAttribute('aria-pressed', String(pressed()));
        changed();
      });
    }
    // Expansions, in the game's release order.
    $('node-expansions').replaceChildren(...NODE_EXPANSIONS.map((x) => {
      const b = el('button', { type: 'button', class: 'toggle', 'data-node-exp': x, title: x, 'aria-label': x, 'aria-pressed': String(g.expansions.includes(x)) }, EXPANSION_SHORT[x] || x);
      b.addEventListener('click', () => { g.expansions = flip(g.expansions, x); b.setAttribute('aria-pressed', String(g.expansions.includes(x))); changed(); });
      return b;
    }));
    // Level range, from the node levels that exist.
    for (const [id, key, any] of [['node-min-level', 'minLevel', 'Any'], ['node-max-level', 'maxLevel', 'Any']]) {
      const select = $(id);
      select.replaceChildren(el('option', { value: '' }, any), ...NODE_LEVELS.map((lv) => el('option', { value: String(lv) }, String(lv))));
      select.value = g[key] == null ? '' : String(g[key]);
      select.addEventListener('change', () => { g[key] = select.value === '' ? null : Number(select.value); changed(); });
    }
    // The player's own levels, and hiding nodes above them.
    for (const [id, job] of [['my-level-miner', 'Miner'], ['my-level-botanist', 'Botanist']]) {
      const input = $(id);
      input.value = g.myLevels[job] == null ? '' : String(g.myLevels[job]);
      input.addEventListener('change', () => {
        const v = Number(input.value);
        g.myLevels[job] = Number.isInteger(v) && v >= 1 && v <= 100 ? v : null;
        input.value = g.myLevels[job] == null ? '' : String(g.myLevels[job]);
        changed();
      });
    }
    const hide = $('hide-above');
    hide.setAttribute('aria-pressed', String(g.hideAbove));
    hide.addEventListener('click', () => { g.hideAbove = !g.hideAbove; hide.setAttribute('aria-pressed', String(g.hideAbove)); changed(); });
  }
  function openForecast(key) {
    state.forecastZone = key;
    state.forecastCount = 12;
    $('forecast-zone').value = key;
    writeHash(); renderForecast(Date.now()); updateCountdowns(Date.now());
    jump('forecast');
  }
  function jump(id) {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    $(id).scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  }

  init();
})();
