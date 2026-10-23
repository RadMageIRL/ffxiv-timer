// Page logic. The math lives in eorzea.js and weather.js; this file only renders it. View state
// that someone might share (forecast zone, transition search) lives in the URL hash, so a reload
// or bookmark restores it on any host and under any base path. Favorites and preferences live in
// namespaced localStorage (store.js).
(function () {
  'use strict';
  const E = window.Eorzea, W = window.XivWeather, DATA = window.FFXIV_WEATHER_DATA;
  const G = window.XivGathering, NODES = window.FFXIV_GATHERING_DATA.nodes;
  const Store = window.FfxivStore, Icons = window.FfxivIcons, Format = window.FfxivFormat;

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
  };
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

  // ---- time formatting (the only place the viewer's time zone is used) ----
  let formats = null;
  function fmt(kind) {
    if (!formats) {
      const h = state.hour12 == null ? {} : { hour12: state.hour12 };
      formats = {
        time: new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', ...h }),
        seconds: new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', ...h }),
        day: new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }),
      };
    }
    return formats[kind];
  }
  function localWhen(t, now) {
    const time = fmt('time').format(t);
    return new Date(t).toDateString() === new Date(now).toDateString() ? time : `${fmt('day').format(t)}, ${time}`;
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
  function renderTimeline(now) {
    const until = now + TIMELINE_SPAN, events = [];
    for (const key of state.favorites) {
      const z = BY_KEY.get(key);
      for (const p of W.periods(z, now, Math.ceil(TIMELINE_SPAN / W.PERIOD) + 1)) {
        if (p.start > now && p.start <= until && p.weather !== p.previous) events.push({ at: p.start, zone: z, p });
      }
    }
    for (const bell of [6, 18]) {
      for (let t = E.nextEtTime(now, bell); t <= until; t += E.SUN) events.push({ at: t, bell });
    }
    const starred = G.starredEvents(NODES, state.nodeFavorites, now, TIMELINE_SPAN);
    for (const s of starred.spawns) events.push({ at: s.at, node: s.node });
    events.sort((a, b) => a.at - b.at || (a.bell != null ? -1 : 1));
    // Redraw when the next event happens or a starred node that is up now goes down.
    timelineNext = Math.min(events.length ? events[0].at : Infinity, ...starred.up.map((u) => u.end));
    // Starred nodes already up come first, labeled as such, ending soonest first.
    const upNow = starred.up.map((u) => el('li', { class: 'tl-item tl-node tl-up', 'data-node': String(u.node.id) },
      el('div', { class: 'tl-when' }, el('span', null, el('span', { class: 'badge now' }, 'Up now')), el('span', { class: 'muted' }, `until ${etLabel(u.end)}`)),
      el('div', { class: 'tl-what' }, el('span', { class: 'tl-zone' }, nodeTitle(u.node)),
        el('span', { class: 'muted' }, `${KIND_LABEL[u.node.kind]} ${u.node.job.toLowerCase()} node · ${u.node.zone} ${fmtCoords(u.node.coords)}`)),
      el('div', { class: 'tl-cd' }, el('span', { class: 'muted small' }, 'ends in '), countdown(u.end))));
    const items = upNow.concat(events.slice(0, TIMELINE_MAX).map((ev) => el('li', { class: `tl-item${ev.bell != null ? ' tl-sun' : ''}${ev.node ? ' tl-node' : ''}` },
      el('div', { class: 'tl-when' }, el('span', null, localWhen(ev.at, now)), el('span', { class: 'muted' }, etLabel(ev.at))),
      ev.bell != null
        ? el('div', { class: 'tl-what' }, el('span', { class: 'tl-zone' }, ev.bell === 6 ? 'Sunrise' : 'Sunset'), el('span', { class: 'muted' }, ev.bell === 6 ? 'Day begins' : 'Night begins'))
        : ev.node
          ? el('div', { class: 'tl-what' }, el('span', { class: 'tl-zone' }, nodeTitle(ev.node)),
            el('span', { class: 'muted' }, `${KIND_LABEL[ev.node.kind]} ${ev.node.job.toLowerCase()} node appears · ${ev.node.zone}`))
          : el('div', { class: 'tl-what' }, el('span', { class: 'tl-zone' }, ev.zone.name),
          el('span', { class: 'tl-change' }, chip(ev.p.previous, true), el('span', { class: 'arrow', 'aria-label': 'to' }, '→'), chip(ev.p.weather, true))),
      el('div', { class: 'tl-cd' }, countdown(ev.at)))));
    if (!state.favorites.size && !state.nodeFavorites.size) items.unshift(el('li', { class: 'tl-item tl-note muted' }, 'Star zones in Weather now or nodes in Timed gathering to see them here.'));
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
        el('span', { class: 'node-times' }, `${times} ET`, el('span', { class: 'muted' }, ` for ${hours} bell${hours === 1 ? '' : 's'}`)),
        s.up
          ? el('span', { class: 'node-status' }, el('span', { class: 'badge now' }, 'Up'), ' ends in ', countdown(s.end))
          : el('span', { class: 'node-status' }, `${localWhen(s.start, now)} · in `, countdown(s.start))));
  }

  // Reminders for starred nodes while the page is open: a toast, and a system notification when
  // the browser allows one. Each window is announced once.
  const reminded = new Set();
  function checkReminders(now) {
    if (state.remindLead == null) return;
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
    setText($('notify-state'), {
      granted: 'Notifications are allowed.',
      denied: 'Notifications are blocked for this site in your browser settings.',
      unsupported: 'This browser does not offer notifications.',
      default: '',
    }[permission] || '');
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
      el('div', { class: 'tl-cd' }, m.start <= now ? el('span', { class: 'badge now' }, 'Now') : countdown(m.start)))));
  }

  // ---- about ----
  function renderAbout() {
    const src = DATA.source;
    const zonesByExpansion = EXPANSIONS.map((x) => `${x}: ${ZONES.filter((z) => z.expansion === x).map((z) => z.name).join(', ')}`);
    $('about-body').replaceChildren(
      el('p', null, 'Eorzea Time, weather forecasts and weather transitions for FINAL FANTASY XIV. Free, no account, nothing to install, and nothing leaves your browser.'),
      el('h3', null, 'How the forecast works'),
      el('p', null, 'Weather in FFXIV is not random per player. Every eight bells (00:00, 08:00 and 16:00 ET, which is every 23 minutes 20 seconds) the game turns the current time into a number from 0 to 99 and looks it up in the zone\'s weather table. FFXIV Timer runs the same calculation on the same tables, so a forecast is the weather the game will choose, not an estimate.'),
      el('p', null, 'One bell (Eorzean hour) is 2 minutes 55 seconds and one sun (day) is 70 minutes. The game shows only the time; the date shown here counts suns and moons from the same starting point the weather uses.'),
      el('p', null, "Story scenes and quest versions of a zone can have weather of their own (the game has Everlasting Light tables for the Shadowbringers story versions of Lakeland, Kholusia, Amh Araeng and Eulmore, for example). Forecasts here are each open zone's normal weather."),
      el('h3', null, `Zones with forecasts (${ZONES.length})`),
      el('ul', { class: 'about-list' }, zonesByExpansion.map((t) => el('li', null, t))),
      el('p', null, `${DATA.unsupported.length} other cities, field zones and areas have weather in the game but no forecast here yet. More are added only after their tables are verified.`),
      el('h3', null, `Timed gathering (${NODES.length} nodes)`),
      el('p', null, `Unspoiled and legendary nodes from ${[...new Set(NODES.map((n) => n.expansion))].join(', ')}. Times, items, levels, places and folklore tomes come from the game data; more expansions are added the same way.`),
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
      el('h3', null, 'Credits'),
      el('p', null, 'FINAL FANTASY XIV © SQUARE ENIX. Zone and weather names are game text, used under the FINAL FANTASY XIV Materials Usage Policy. FFXIV Timer is a free fan tool and is not affiliated with or endorsed by Square Enix. Icons are original.'),
      el('p', null, 'Code is MIT licensed: ', el('a', { href: 'https://github.com/RadMageIRL/ffxiv-timer', rel: 'noopener' }, 'github.com/RadMageIRL/ffxiv-timer'), '.'));
  }

  // ---- render loop ----
  function renderWeather(now) {
    renderZones(now);
    renderTimeline(now);
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

    $('node-search').addEventListener('input', (e) => { state.nodeSearch = e.target.value; renderGathering(Date.now()); updateCountdowns(Date.now()); });
    wireGatheringFilters();
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
      lastPeriod = -1; tick();
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
