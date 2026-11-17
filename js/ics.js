// Calendar files (iCalendar, RFC 5545) for the times FFXIV Timer shows. Pure: a file is a function of
// the choices, the engines and data passed in and a clock passed in, so the page and the Node tests
// share this file unchanged and the same choices at the same instant give the same bytes.
//
// Adapted from GW2 Timer's js/ics.js: the same writer, folding, escaping, limits, alarm choices and
// marks for uncertain times. What differs is where the times come from. GW2's events run on a UTC
// timetable; FFXIV's run on Eorzea's cycles, so, as on FFXI Timer, the game engines find the windows
// and this module only turns them into entries and writes them. Transition matches come from
// XivWeather.findTransitions (the finder's own search), weather changes from XivWeather.nextChange,
// node windows from XivGathering.upcoming and starredEvents, and resets from the resets engine the
// Resets panel will bring (the same nextStart/upcoming shape as GW2's schedule engine). The only time
// arithmetic here is the edge of a range: now plus its length.
//
// Every entry is one start, written in UTC with a "Z". There are no recurrence rules and no time
// zones: a calendar shows each start in its own local time, a daylight-saving change cannot move one,
// and a 70-minute Eorzean day or a 23-minute weather period is not something calendar rules repeat
// reliably. A file is bounded instead: above WARN_ENTRIES the page warns, above MAX_ENTRIES it refuses.
(function (root) {
  'use strict';

  const E = typeof module === 'object' && module.exports ? require('./eorzea.js') : root.Eorzea;
  const F = typeof module === 'object' && module.exports ? require('./format.js') : root.FfxivFormat;

  const MIN = 60000, HOUR = 3600000, DAY = 86400000;
  /**
   * What each kind of entry can cover. 'next' is the next one only; times are spans after now.
   * A transition file holds the matches the finder lists ('shown': up to its 10 within 30 days), and an
   * Upcoming file holds the entries Upcoming lists ('listed').
   */
  const RANGES = {
    transition: { next: 0, shown: Infinity },
    node: { next: 0, '2h': 2 * HOUR, '6h': 6 * HOUR },
    weather: { next: 0, '2h': 2 * HOUR, '6h': 6 * HOUR },
    upcoming: { listed: Infinity },
    reset: { next: 0, '1d': DAY, '3d': 3 * DAY, '7d': 7 * DAY, '30d': 30 * DAY },
  };
  const RANGE_SLUG = { next: 'next', shown: 'matches', listed: 'listed', '2h': 'next-2-hours', '6h': 'next-6-hours', '1d': 'next-24-hours', '3d': 'next-3-days', '7d': 'next-7-days', '30d': 'next-30-days' };
  /** Minutes before a start for the calendar's own alarm; 0 is none. */
  const ALARMS = [0, 5, 10, 15];
  /** Above WARN_ENTRIES the page asks the reader to check the count; above MAX_ENTRIES no file is made. */
  const WARN_ENTRIES = 200, MAX_ENTRIES = 500;
  const PRODID = '-//RadMage Labs//FFXIV Timer//EN';
  const UID_HOST = 'ffxiv-timer.radmagelabs.com';
  const HOME = 'https://radmagelabs.com/ffxiv/';
  const GAME = 'FINAL FANTASY XIV';
  /** How sure a time is: worked out from the game's data, from an official source, or from community sources only. */
  const CERTAINTY = ['computed', 'official', 'unverified'];
  const KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  const UID = /^[a-z0-9]+(?:-[a-z0-9]+)*-\d{8}T\d{6}Z$/;
  const URL_OK = /^https:\/\/[\x21-\x7e]+$/;
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  const pad = (n) => String(n).padStart(2, '0');
  /** An instant as an iCalendar UTC date-time: 20261026T000000Z. */
  function utc(ms) {
    const d = new Date(ms);
    return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
  }

  // TEXT values: control characters are dropped, then backslash, semicolon, comma and line breaks escaped.
  const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
  const text = (s) => String(s).replace(CONTROL, '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n');

  /**
   * One content line folded at 75 octets of UTF-8; continuation lines start with a space. A fold never splits
   * a character, nor an escape such as "\," (the standard allows that, but some readers do not take it well).
   * Every backslash in a line here starts an escape: text() escapes the backslashes of the text itself.
   */
  function fold(line) {
    const chars = Array.from(line);
    let out = '', len = 0;
    for (let i = 0; i < chars.length; i++) {
      let unit = chars[i];
      if (unit === '\\' && i + 1 < chars.length) unit += chars[++i];
      let n = 0;
      for (const ch of unit) { const cp = ch.codePointAt(0); n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4; }
      if (len + n > 75) { out += '\r\n '; len = 1; }
      out += unit; len += n;
    }
    return out;
  }

  /** What an entry's title adds after its name: how sure the time is, as the page says it. */
  const note = (e) => (e && e.certainty === 'unverified' ? 'time unverified' : '');
  const STATUS_LINE = { unverified: 'Unverified: this time comes from community sources and has not yet been checked in game.' };

  // ---- Wording shared by the entries ----

  const etTime = (t) => { const c = E.clock(t); return `${E.formatEt(c.bell, c.minute)} ET`; };
  /** A real-time length in words, to the second: "5 minutes 50 seconds", "23 minutes 20 seconds". */
  function realSpan(ms) {
    const s = Math.round(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const part = (n, w) => (n ? [`${n} ${w}${n === 1 ? '' : 's'}`] : []);
    return [...part(h, 'hour'), ...part(m, 'minute'), ...part(sec, 'second')].join(' ') || '0 seconds';
  }
  const patchLabel = (p) => String(p).replace(/^(\d+\.\d+)h(\d+)$/, '$1 hotfix $2');
  const orList = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} or ${xs[xs.length - 1]}`);
  const WEATHER_SOURCE = (patch) => `Calculated by FFXIV Timer from the game's weather tables (patch ${patchLabel(patch)}), the same way the game picks the weather, and checked against XIVAPI and two independent weather calculators. Not yet compared with the game itself.`;
  const NODE_SOURCE = (patch) => `Calculated by FFXIV Timer from the game's gathering tables (patch ${patchLabel(patch)}), and checked against XIVAPI and the node tables on the FFXIV wiki. Not yet compared with the game itself.`;
  const KIND = { unspoiled: 'Unspoiled', legendary: 'Legendary' };
  const coordsText = (c) => `(${c[0].toFixed(1)}, ${c[1].toFixed(1)})`;
  const itemText = (i) => `${i.name} (Lv ${i.level}${i.stars ? ` ${'\u2605'.repeat(i.stars)}` : ''}${i.collectable ? ', collectable' : ''}${i.hidden ? ', hidden' : ''})`;

  /** A short stable tag for a transition search, so the same search exported again gives the same UIDs. */
  function searchTag(search) {
    const ids = (xs) => [...xs].sort((a, b) => a - b).join(',');
    const key = `prev=${ids(search.prev)};to=${ids(search.to)};bells=${ids(search.bells)}`;
    let h = 5381;
    for (let i = 0; i < key.length; i++) h = (Math.imul(h, 33) ^ key.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }

  /** The finder's own link for a search, in the form the page writes to its address (js/app.js writeHash). */
  function finderLink(zone, search, data) {
    const slugs = (ids) => ids.map((id) => F.slug(data.weathers[id])).join(',');
    const parts = [`zone=${encodeURIComponent(zone.key)}`, `fz=${encodeURIComponent(zone.key)}`];
    if (search.prev.length) parts.push(`prev=${slugs(search.prev)}`);
    if (search.to.length) parts.push(`to=${slugs(search.to)}`);
    if (search.bells.length) parts.push(`bells=${search.bells.join(',')}`);
    return `${HOME}#${parts.join('&')}`;
  }

  // ---- Entries from the engines ----
  // Each entry: { uid, start, end, summary, location?, about: [lines], url?, alarm, certainty }. The uid is
  // a key for the thing plus its UTC start; build() adds the host.

  function transitionEntry(o, m) {
    const d = o.data.weather, zone = o.zone, s = o.search, wx = (id) => d.weathers[id];
    const asked = `${s.prev.length ? orList(s.prev.map(wx)) : 'any weather'}, then ${s.to.length ? orList(s.to.map(wx)) : 'any weather'}${s.bells.length ? `, at ${orList(s.bells.map((b) => `${pad(b)}:00`))} ET` : ''}`;
    return {
      uid: `transition-${zone.key}-${searchTag(s)}-${utc(m.start)}`,
      start: m.start, end: m.end,
      summary: `${zone.name}, ${wx(m.previous)} then ${wx(m.weather)}${s.bells.length ? ` at ${pad(m.bell)}:00 ET` : ''}`,
      location: `${zone.name}, ${zone.region}`,
      about: [
        `In ${zone.name}, ${wx(m.weather)} follows ${wx(m.previous)} at ${pad(m.bell)}:00 ET. This entry covers that weather period, ${realSpan(m.end - m.start)} of real time; the weather can last longer.`,
        `Found by the Weather transitions search: ${asked}.`,
        WEATHER_SOURCE(d.source.patch),
      ],
      url: finderLink(zone, s, d),
      alarm: `${zone.name}: ${wx(m.weather)} after ${wx(m.previous)}`,
      certainty: 'computed',
    };
  }

  function weatherEntry(o, zone, c) {
    const W = o.engines.weather, d = o.data.weather, wx = (id) => d.weathers[id];
    const after = W.nextChange(zone, c.at), end = after ? after.at : c.at + W.PERIOD;
    return {
      uid: `weather-${zone.key}-${utc(c.at)}`,
      start: c.at, end,
      summary: `${zone.name}, ${wx(c.from)} to ${wx(c.to)}`,
      location: `${zone.name}, ${zone.region}`,
      about: [
        `The weather in ${zone.name} changes from ${wx(c.from)} to ${wx(c.to)} at ${etTime(c.at)}${after ? ` and stays ${wx(c.to)} until ${etTime(after.at)}, ${realSpan(end - c.at)} of real time` : ''}.`,
        WEATHER_SOURCE(d.source.patch),
      ],
      url: `${HOME}#zone=${encodeURIComponent(zone.key)}`,
      alarm: `${zone.name} turns to ${wx(c.to)}`,
      certainty: 'computed',
    };
  }

  function nodeEntry(o, n, w) {
    const items = n.items.map((i) => i.name).join(', '), where = `${n.zone}, ${n.area} ${coordsText(n.coords)}`;
    return {
      uid: `node-${n.id}-${utc(w.start)}`,
      start: w.start, end: w.end,
      summary: `${items} (${KIND[n.kind]}, Lv ${n.level} ${n.job}), ${n.zone}`,
      location: where,
      about: [
        `${KIND[n.kind]} ${n.job.toLowerCase()} node in ${where}, up from ${etTime(w.start)} to ${etTime(w.end)}, ${realSpan(w.end - w.start)} of real time.`,
        `Items: ${n.items.map(itemText).join('; ')}.`,
        ...(n.folklore ? [`Needs the ${n.folklore}.`] : []),
        NODE_SOURCE(o.data.gathering.source.patch),
      ],
      url: HOME,
      alarm: `${items} appears in ${n.zone}`,
      certainty: 'computed',
    };
  }

  function resetEntry(r, start) {
    return {
      uid: `reset-${r.id}-${utc(start)}`,
      // A reset is an instant: the entry is a short block, as D4 Tracker marks a spawn of unknown length.
      start, end: start + (r.lengthMin || 15) * MIN,
      summary: r.name,
      about: [r.about, r.source ? `Source: ${r.source}.` : null].filter(Boolean),
      url: HOME,
      alarm: r.name,
      certainty: r.certainty,
    };
  }

  /** For each kind of entry: what was chosen (for 'empty'), and the entries the engines give for a range. */
  const SOURCES = {
    // The finder's own matches (XivWeather.findTransitions), as listed; 'next' is the first one after now.
    transition: {
      chosen: (o) => o.matches,
      entries: (o) => (o.range === 'next' ? o.matches.filter((m) => m.start > o.now).slice(0, 1) : o.matches).map((m) => transitionEntry(o, m)),
    },
    // Each change from XivWeather.nextChange, one after another, while it falls within the range.
    weather: {
      chosen: (o) => o.zones,
      entries: (o) => o.zones.flatMap((z) => {
        const W = o.engines.weather, edge = o.now + RANGES.weather[o.range], out = [];
        for (let c = W.nextChange(z, o.now); c && (o.range === 'next' ? !out.length : c.at <= edge); c = W.nextChange(z, c.at)) out.push(weatherEntry(o, z, c));
        return out;
      }),
    },
    // XivGathering.upcoming for the next spawn; otherwise the spawns Upcoming itself uses (starredEvents).
    node: {
      chosen: (o) => o.nodes,
      entries(o) {
        const G = o.engines.gathering;
        if (o.range === 'next') return o.nodes.flatMap((n) => G.upcoming(n, o.now, 1).map((w) => nodeEntry(o, n, w)));
        return G.starredEvents(o.nodes, new Set(o.nodes.map((n) => n.id)), o.now, RANGES.node[o.range]).spawns.map((s) => nodeEntry(o, s.node, { start: s.at, end: s.end }));
      },
    },
    // What Upcoming lists: weather changes ({ zone, change: { at, from, to } }) and node spawns ({ node, window: { start, end } }).
    upcoming: {
      chosen: (o) => o.items,
      entries: (o) => o.items.map((it) => (it.node ? nodeEntry(o, it.node, it.window) : weatherEntry(o, it.zone, it.change))),
    },
    // The resets engine: nextStart(reset, now) and upcoming(resets, now, spanMs) -> [{ reset, start }].
    reset: {
      chosen: (o) => o.resets,
      entries(o) {
        const R = o.engines.resets;
        const found = o.range === 'next' ? o.resets.map((r) => ({ reset: r, start: R.nextStart(r, o.now) })) : R.upcoming(o.resets, o.now, RANGES.reset[o.range]);
        return found.filter((f) => Number.isFinite(f.start)).map((f) => resetEntry(f.reset, f.start));
      },
    },
  };

  // An entry the file can hold: a safe uid, a real window, a title, an alarm line, a known certainty, and a safe link.
  const usable = (e) => Boolean(e) && typeof e.uid === 'string' && UID.test(e.uid) && Number.isFinite(e.start) && Number.isFinite(e.end) && e.end > e.start
    && typeof e.summary === 'string' && e.summary.trim() !== '' && typeof e.alarm === 'string' && e.alarm.trim() !== ''
    && CERTAINTY.includes(e.certainty) && Array.isArray(e.about) && e.about.every((l) => typeof l === 'string')
    && (e.location === undefined || typeof e.location === 'string') && (e.url === undefined || (typeof e.url === 'string' && URL_OK.test(e.url)));

  /**
   * The entries a file would hold: { ok, reason, count, warn, entries }, in time order (ties by uid). The same
   * entry given twice counts once; entries that start at or before now are left out. reason: 'source' or
   * 'range' (unknown), 'entry' (bad input, or an entry without a safe uid, window, title or certainty), 'empty'
   * (nothing chosen), 'none' (nothing after now in the range), 'too-many' (over MAX_ENTRIES; count says how
   * many it would be). warn is true above WARN_ENTRIES.
   */
  function plan(o) {
    const fail = (reason, count = 0) => ({ ok: false, reason, count, warn: false, entries: [] });
    if (!o || !own(SOURCES, o.source)) return fail('source');
    if (!own(RANGES[o.source], o.range)) return fail('range');
    if (!Number.isFinite(o.now)) return fail('entry');
    const src = SOURCES[o.source];
    let found;
    try {
      const chosen = src.chosen(o);
      if (!Array.isArray(chosen)) return fail('entry');
      if (!chosen.length) return fail('empty');
      found = src.entries(o);
    } catch (e) {
      return fail('entry');
    }
    const seen = new Set(), entries = [];
    for (const e of found) {
      if (!usable(e)) return fail('entry');
      if (e.start <= o.now || seen.has(e.uid)) continue;
      seen.add(e.uid);
      entries.push(e);
    }
    entries.sort((a, b) => a.start - b.start || (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0));
    if (!entries.length) return fail('none');
    if (entries.length > MAX_ENTRIES) return fail('too-many', entries.length);
    return { ok: true, reason: null, count: entries.length, warn: entries.length > WARN_ENTRIES, entries };
  }

  function vevent(e, stamp, alarmMin) {
    const n = note(e), name = `FFXIV: ${e.summary}${n ? ` (${n})` : ''}`;
    const about = e.about.concat(STATUS_LINE[e.certainty] || [], e.url ? [`Details: ${e.url}`] : []).join('\n');
    return [
      'BEGIN:VEVENT',
      `UID:${e.uid}@${UID_HOST}`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${utc(e.start)}`,
      `DTEND:${utc(e.end)}`,
      `SUMMARY:${text(name)}`,
      ...(e.location ? [`LOCATION:${text(`${e.location} (${GAME})`)}`] : []),
      `DESCRIPTION:${text(about)}`,
      ...(e.url ? [`URL:${e.url}`] : []),
      ...(n ? ['STATUS:TENTATIVE'] : []),
      'TRANSP:TRANSPARENT',
      ...(alarmMin ? ['BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${text(`FFXIV: ${e.alarm} in ${alarmMin} minutes`)}`, `TRIGGER:-PT${alarmMin}M`, 'END:VALARM'] : []),
      'END:VEVENT',
    ];
  }

  /**
   * The calendar file for plan()'s options plus alarmMin: plan()'s answer plus `text` (CRLF lines, folded,
   * ending in CRLF) and `uncertain` (each marked thing once: { key, summary }). `now` is also the file's
   * DTSTAMP (to the second). An alarm that is not one of ALARMS is refused (reason 'alarm'); nothing is guessed.
   */
  function build(o) {
    const alarmMin = !o || o.alarmMin === undefined ? 0 : o.alarmMin;
    if (!ALARMS.includes(alarmMin)) return { ok: false, reason: 'alarm', count: 0, warn: false, entries: [], text: '', uncertain: [] };
    const p = plan(o);
    if (!p.ok) return Object.assign(p, { text: '', uncertain: [] });
    const stamp = utc(Math.floor(o.now / 1000) * 1000);
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:${PRODID}`, 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:FFXIV Timer',
      ...p.entries.flatMap((e) => vevent(e, stamp, alarmMin)), 'END:VCALENDAR'];
    const uncertain = [], keys = new Set();
    for (const e of p.entries) {
      const key = e.uid.replace(/-\d{8}T\d{6}Z$/, '');
      if (note(e) && !keys.has(key)) { keys.add(key); uncertain.push({ key, summary: e.summary }); }
    }
    return Object.assign(p, { text: lines.map(fold).join('\r\n') + '\r\n', uncertain });
  }

  /**
   * A file name of lowercase letters, digits and hyphens that says what is in it: ffxiv-timer-transitions-
   * eureka-anemos-matches.ics, ffxiv-timer-node-1022-next.ics, ffxiv-timer-starred-nodes-next-6-hours.ics,
   * ffxiv-timer-weather-3-zones-next-2-hours.ics, ffxiv-timer-upcoming.ics, ffxiv-timer-resets-next-7-days.ics.
   * scope: 'one' (key names it), 'starred' or 'choose' (count says how many).
   */
  function filename({ source, range, scope, key, count } = {}) {
    const r = RANGE_SLUG[range] || 'events', k = KEY.test(String(key)) ? String(key) : null, n = Number.isInteger(count) && count > 0 ? count : 0;
    const noun = { node: ['node', 'nodes'], weather: ['weather', 'weather-zones'], reset: ['reset', 'resets'] }[source];
    let name = 'calendar';
    if (source === 'upcoming') name = 'upcoming';
    else if (source === 'transition') name = k ? `transitions-${k}-${r}` : `transitions-${r}`;
    else if (noun && scope === 'one' && k) name = `${noun[0]}-${k}-${r}`;
    else if (noun && scope === 'starred') name = `starred-${source === 'weather' ? 'weather-zones' : noun[1]}-${r}`;
    else if (noun && n) name = source === 'weather' ? `weather-${n}-zone${n === 1 ? '' : 's'}-${r}` : `${n}-${noun[n === 1 ? 0 : 1]}-${r}`;
    else if (noun) name = `${noun[1]}-${r}`;
    return `ffxiv-timer-${name}.ics`;
  }

  const Ics = { RANGES, ALARMS, WARN_ENTRIES, MAX_ENTRIES, PRODID, UID_HOST, HOME, utc, text, fold, note, realSpan, searchTag, finderLink, plan, build, filename };
  if (typeof module === 'object' && module.exports) module.exports = Ics;
  else root.XivIcs = Ics;
})(typeof globalThis !== 'undefined' ? globalThis : this);
