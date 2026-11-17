// Tests for js/ics.js. Run alone with `node tests/ics.mjs`, or through tests/run.mjs, which runs it once per
// time zone: a calendar file is written in UTC only, so every zone must produce the same bytes.
//
// Ported from GW2 Timer's tests/ics.mjs and extended for FFXIV's engines. The files are read back here by a
// strict reader of its own, not by the module: it checks the line endings, the folding, the structure and the
// value formats, then expands the entries so their times can be compared with what the engines give when
// asked directly (XivWeather.periods walked period by period, XivGathering.windows, the finder's matches).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const Ics = require('../js/ics.js');
const E = require('../js/eorzea.js');
const W = require('../js/weather.js');
const G = require('../js/gathering.js');
const F = require('../js/format.js');
const D = require('../js/weather-data.js');
const GD = require('../js/gathering-data.js');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIN = 60000, HOUR = 3600000, DAY = 86400000;
const utc = (iso) => Date.parse(iso);
const zone = (key) => { const z = D.zones.find((x) => x.key === key); assert.ok(z, key); return z; };
const node = (id) => { const n = GD.nodes.find((x) => x.id === id); assert.ok(n, String(id)); return n; };
const wid = (name) => { const k = Object.keys(D.weathers).find((id) => D.weathers[id] === name); assert.ok(k, name); return Number(k); };
const base = { data: { weather: D, gathering: GD }, engines: { weather: W, gathering: G } };
const build = (o) => Ics.build({ ...base, alarmMin: 0, ...o });

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { failed++; console.error(`FAIL ${name}\n  ${String(e.message).split('\n').join('\n  ')}`); }
}

// ---- A strict reader of the files this module writes ----

const STAMP = /^\d{8}T\d{6}Z$/;
const parseStamp = (s) => { assert.match(s, STAMP, s); return Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(9, 11), +s.slice(11, 13), +s.slice(13, 15)); };
const unescapeText = (v) => v.replace(/\\([\\;,nN])/g, (m, c) => (c === 'n' || c === 'N' ? '\n' : c));
/** Every TEXT value: no bare comma or semicolon, and a backslash only as the start of an escape. */
function checkEscaped(v, what) {
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (c === '\\') { assert.ok('\\;,nN'.includes(v[i + 1] || 'x'), `${what}: stray backslash: ${v}`); i++; }
    else assert.ok(c !== ',' && c !== ';', `${what}: unescaped ${c}: ${v}`);
  }
}
const TEXT_PROPS = ['SUMMARY', 'LOCATION', 'DESCRIPTION', 'X-WR-CALNAME'];
const DASHES = new RegExp(`[${String.fromCharCode(0x2013)}-${String.fromCharCode(0x2015)}]`); // en dash to horizontal bar, built from codes

function read(file) {
  assert.ok(file.endsWith('\r\n'), 'ends with CRLF');
  assert.ok(!/\r(?!\n)|(?<!\r)\n/.test(file), 'every line break is CRLF');
  assert.ok(!DASHES.test(file), 'no en or em dashes');
  const physical = file.slice(0, -2).split('\r\n');
  for (const l of physical) assert.ok(Buffer.byteLength(l, 'utf8') <= 75, `a physical line over 75 octets: ${l}`);
  for (const [i, l] of physical.entries()) {
    if (i + 1 < physical.length && physical[i + 1].startsWith(' ')) assert.ok(/(^|[^\\])(\\\\)*$/.test(l), `a fold splits an escape after: ${l}`);
  }
  const lines = file.slice(0, -2).replace(/\r\n[ \t]/g, '').split('\r\n');
  const stack = [], cal = { props: {}, events: [] };
  let ev = null, alarm = null;
  for (const l of lines) {
    const m = /^([A-Z][A-Z0-9-]*):(.*)$/.exec(l);
    assert.ok(m, `not a NAME:value line: ${l}`);
    const [, name, value] = m;
    if (name === 'BEGIN') {
      stack.push(value);
      if (value === 'VEVENT') { assert.equal(stack.join('/'), 'VCALENDAR/VEVENT'); ev = { props: {}, alarms: [] }; }
      else if (value === 'VALARM') { assert.equal(stack.join('/'), 'VCALENDAR/VEVENT/VALARM'); alarm = {}; }
      else assert.equal(stack.join('/'), 'VCALENDAR', `unexpected component ${value}`);
      continue;
    }
    if (name === 'END') {
      assert.equal(stack.pop(), value, `END:${value} closes what it should`);
      if (value === 'VEVENT') { cal.events.push(ev); ev = null; }
      if (value === 'VALARM') { ev.alarms.push(alarm); alarm = null; }
      continue;
    }
    const into = alarm || (ev && ev.props) || cal.props;
    assert.ok(!(name in into), `${name} given twice in one component`);
    if (TEXT_PROPS.includes(name) || (alarm && name === 'DESCRIPTION')) { checkEscaped(value, name); into[name] = unescapeText(value); } else into[name] = value;
  }
  assert.equal(stack.length, 0, 'every component is closed');
  assert.equal(lines[0], 'BEGIN:VCALENDAR');
  assert.deepEqual([cal.props.VERSION, cal.props.PRODID, cal.props.CALSCALE, cal.props.METHOD, cal.props['X-WR-CALNAME']], ['2.0', Ics.PRODID, 'GREGORIAN', 'PUBLISH', 'FFXIV Timer']);
  const uids = new Set();
  for (const e of cal.events) {
    for (const k of ['UID', 'DTSTAMP', 'DTSTART', 'DTEND', 'SUMMARY', 'DESCRIPTION', 'TRANSP']) assert.ok(k in e.props, `VEVENT without ${k}`);
    assert.ok(!uids.has(e.props.UID), `UID given twice: ${e.props.UID}`);
    uids.add(e.props.UID);
    assert.match(e.props.UID, /^[a-z0-9]+(?:-[a-z0-9]+)*-\d{8}T\d{6}Z@ffxiv-timer\.radmagelabs\.com$/);
    assert.ok(e.props.SUMMARY.startsWith('FFXIV: '), e.props.SUMMARY);
    if ('URL' in e.props) assert.match(e.props.URL, /^https:\/\/radmagelabs\.com\/ffxiv\/(#[\x21-\x7e]*)?$/);
    e.start = parseStamp(e.props.DTSTART); e.end = parseStamp(e.props.DTEND); e.stamp = parseStamp(e.props.DTSTAMP);
    assert.ok(e.end > e.start, 'ends after it starts');
    assert.equal(e.props.UID.replace(/@.*$/, '').slice(-16), Ics.utc(e.start), 'the UID carries the start');
    assert.ok(!('RRULE' in e.props) && !('RDATE' in e.props) && !('EXDATE' in e.props) && !('TZID' in e.props), 'explicit occurrences only');
    for (const a of e.alarms) {
      assert.deepEqual(Object.keys(a).sort(), ['ACTION', 'DESCRIPTION', 'TRIGGER']);
      assert.equal(a.ACTION, 'DISPLAY');
      assert.match(a.TRIGGER, /^-PT(5|10|15)M$/);
    }
  }
  return cal;
}
const keyOf = (ev) => ev.props.UID.replace(/-\d{8}T\d{6}Z@.*$/, '');

// ---- What the engines say when asked directly ----

/** Weather changes after now, walking XivWeather.periods (not nextChange): each period whose weather differs from the one before. */
function weatherTruth(z, now, range) {
  const until = range === 'next' ? now + 1000 * W.PERIOD : now + Ics.RANGES.weather[range];
  const out = [];
  for (const p of W.periods(z, now, Math.ceil((until - now) / W.PERIOD) + 2)) {
    if (p.start > now && p.start <= until && p.weather !== p.previous) out.push({ start: p.start, from: p.previous, to: p.weather });
    if (range === 'next' && out.length) break;
  }
  for (const c of out) c.end = W.periods(z, c.start, 1000).find((p) => p.weather !== c.to)?.start ?? c.start + W.PERIOD;
  return out;
}
/** A node's windows after now, from XivGathering.windows: the next one, or those starting within the range. */
function nodeTruth(n, now, range) {
  if (range === 'next') return G.upcoming(n, now, 1);
  const span = Ics.RANGES.node[range];
  return G.windows(n, now, now + span + 1).filter((w) => w.start > now && w.start <= now + span);
}

// Instants with a reason each: exact boundaries, and the days before every daylight-saving change.
const INSTANTS = [
  ['an ordinary night', '2026-11-17T01:00:00Z'],
  ['the exact start of a weather period', new Date(E.periodStart(utc('2026-11-17T01:00:00Z')) + W.PERIOD).toISOString()],
  ['a millisecond before a weather period', new Date(E.periodStart(utc('2026-11-17T01:00:00Z')) + W.PERIOD - 1).toISOString()],
  ['before the US change to daylight time (2027-03-14)', '2027-03-12T18:20:00Z'],
  ['before the EU change to summer time (2027-03-28)', '2027-03-26T09:41:30Z'],
  ['before the US change back (2026-11-01)', '2026-10-31T16:07:00Z'],
  ['before the EU change back (2026-10-25)', '2026-10-23T22:00:00Z'],
  ['before Lord Howe moves 30 minutes (2026-10-04)', '2026-10-02T13:15:00Z'],
  ['across a year end', '2026-12-31T21:00:00Z'],
];

// ---- The module ----

test('the module needs nothing from a page: it loads with no window, document or location, and sets one global', () => {
  const src = readFileSync(join(ROOT, 'js', 'ics.js'), 'utf8');
  const bare = {};
  vm.runInNewContext(src, bare);
  assert.deepEqual(Object.keys(bare), ['XivIcs']);
  // With the two page modules it reads (as the page loads them), it still adds only its own.
  const ctx = {};
  vm.runInNewContext(readFileSync(join(ROOT, 'js', 'eorzea.js'), 'utf8'), ctx);
  vm.runInNewContext(readFileSync(join(ROOT, 'js', 'format.js'), 'utf8'), ctx);
  const before = Object.keys(ctx);
  vm.runInNewContext(src, ctx);
  assert.deepEqual(Object.keys(ctx).filter((k) => !before.includes(k)), ['XivIcs']);
  assert.equal(ctx.XivIcs.utc(0), '19700101T000000Z');
});

test('the output depends on nothing but its inputs: no clock, randomness, locale, local time, network or storage in the module', () => {
  const src = readFileSync(join(ROOT, 'js', 'ics.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  for (const bad of ['Date.now', 'new Date()', 'Math.random', 'performance.', 'localeCompare', 'toLocale', 'Intl.', 'fetch(', 'XMLHttpRequest', 'localStorage', 'sessionStorage', 'document.', 'window.', 'navigator.']) {
    assert.ok(!src.includes(bad), bad);
  }
  assert.doesNotMatch(src, /\.get(Hours|Minutes|Seconds|Date|Day|Month|FullYear|TimezoneOffset)\(/, 'only UTC fields of a date are read');
  assert.ok(!/RRULE|RDATE|TZID|VTIMEZONE/.test(src), 'no recurrence rules or time zones are written');
});

test('the ranges, alarms and limits are the ones the roadmap set (Phase 0, 2026-11-16)', () => {
  assert.deepEqual(Object.fromEntries(Object.entries(Ics.RANGES).map(([k, v]) => [k, Object.keys(v)])), {
    transition: ['next', 'shown'], node: ['next', '2h', '6h'], weather: ['next', '2h', '6h'], upcoming: ['listed'], reset: ['next', '1d', '3d', '7d', '30d'],
  });
  assert.deepEqual([Ics.RANGES.node['2h'], Ics.RANGES.node['6h'], Ics.RANGES.weather['6h']], [2 * HOUR, 6 * HOUR, 6 * HOUR]);
  assert.deepEqual(Object.values(Ics.RANGES.reset), [0, DAY, 3 * DAY, 7 * DAY, 30 * DAY]);
  assert.deepEqual(Ics.ALARMS, [0, 5, 10, 15]);
  assert.deepEqual([Ics.WARN_ENTRIES, Ics.MAX_ENTRIES], [200, 500]);
  assert.equal(Ics.HOME, 'https://radmagelabs.com/ffxiv/');
  assert.equal(JSON.parse(readFileSync(join(ROOT, 'deploy', 'targets.json'), 'utf8')).canonical, Ics.HOME, 'links point at the canonical address');
});

// ---- Format ----

test('UTC date-times are written with a Z, to the second, whatever the zone', () => {
  assert.equal(Ics.utc(utc('2026-10-26T00:00:00Z')), '20261026T000000Z');
  assert.equal(Ics.utc(utc('2027-03-14T08:05:09.999Z')), '20270314T080509Z');
  assert.equal(Ics.utc(utc('1999-12-31T23:59:59Z')), '19991231T235959Z');
});

test('text values escape backslash, semicolon and comma, turn line breaks into \\n and drop control characters', () => {
  assert.equal(Ics.text('a,b;c\\d'), 'a\\,b\\;c\\\\d');
  assert.equal(Ics.text('one\ntwo\r\nthree\rfour'), 'one\\ntwo\\nthree\\nfour');
  assert.equal(Ics.text('bell\u0007tab\tok'), 'belltab\tok');
  assert.equal(Ics.text("Kozama'uka: Rarefied Raw Dark Amber"), "Kozama'uka: Rarefied Raw Dark Amber");
});

test('long lines fold at 75 octets, never inside a character, and unfold to the same line', () => {
  for (const line of ['DESCRIPTION:' + 'x'.repeat(300), 'SUMMARY:' + 'é'.repeat(100), 'SUMMARY:' + '☆★'.repeat(60), 'SUMMARY:' + '\u{1F600}'.repeat(40) + 'a', 'SHORT:ok', 'X:' + 'a'.repeat(73)]) {
    const f = Ics.fold(line);
    const parts = f.split('\r\n');
    for (const [i, p] of parts.entries()) {
      assert.ok(Buffer.byteLength(p, 'utf8') <= 75, `${i}: ${Buffer.byteLength(p, 'utf8')} octets`);
      if (i) assert.equal(p[0], ' ');
      assert.ok(!p.includes('�'), 'no character split');
    }
    assert.equal(f.replace(/\r\n /g, ''), line);
  }
  assert.equal(Ics.fold('X:' + 'a'.repeat(73)), 'X:' + 'a'.repeat(73), 'exactly 75 octets is not folded');
  // An escape that would straddle the 75th octet moves to the next line whole.
  assert.equal(Ics.fold('X:' + 'a'.repeat(72) + '\\,b'), 'X:' + 'a'.repeat(72) + '\r\n \\,b');
  for (let k = 60; k < 80; k++) {
    const line = 'D:' + 'a'.repeat(k) + Ics.text(',;\\\n'.repeat(20));
    for (const part of Ics.fold(line).split('\r\n')) assert.ok(/(^|[^\\])(\\\\)*$/.test(part), `${k}: ${part}`);
  }
});

test('odd characters in a name still read back: commas, semicolons, a backslash, a line break, an emoji and a long name', () => {
  const odd = Object.assign({}, zone('middle-la-noscea'), { key: 'odd-zone', name: 'A, B; C\\D\nE \u{1F600} ' + 'Long '.repeat(30), region: 'Region, with; marks' });
  const r = build({ source: 'weather', range: 'next', now: utc('2026-11-17T01:00:00Z'), zones: [odd] });
  assert.ok(r.ok, r.reason);
  const ev = read(r.text).events[0];
  assert.ok(ev.props.SUMMARY.startsWith(`FFXIV: ${odd.name}, `), ev.props.SUMMARY);
  assert.equal(ev.props.LOCATION, `${odd.name}, Region, with; marks (FINAL FANTASY XIV)`);
});

// ---- Weather changes: the engine's changes, each lasting until the next ----

test('weather, for every supported zone, every range and nine instants: exactly the changes the periods show, each ending at the next change', () => {
  for (const [what, iso] of INSTANTS) {
    const now = utc(iso);
    for (const range of Object.keys(Ics.RANGES.weather)) {
      for (const z of D.zones) {
        const want = weatherTruth(z, now, range), r = build({ source: 'weather', range, now, zones: [z] });
        if (!want.length) { assert.deepEqual([r.ok, r.reason], [false, 'none'], `${what} ${range} ${z.key}`); continue; }
        assert.ok(r.ok, `${what} ${range} ${z.key}: ${r.reason}`);
        const evs = read(r.text).events;
        assert.deepEqual(evs.map((x) => [x.start, x.end]), want.map((c) => [c.start, c.end]), `${what} ${range} ${z.key}`);
        for (const [i, x] of evs.entries()) {
          assert.equal(x.props.SUMMARY, `FFXIV: ${z.name}, ${D.weathers[want[i].from]} to ${D.weathers[want[i].to]}`);
          assert.equal(x.props.URL, `https://radmagelabs.com/ffxiv/#zone=${z.key}`);
          assert.equal(keyOf(x), `weather-${z.key}`);
        }
      }
    }
  }
});

test('a zone whose weather never changes (Solution Nine) has no next change, and makes no empty file', () => {
  const r = build({ source: 'weather', range: 'next', now: utc('2026-11-17T01:00:00Z'), zones: [zone('solution-nine')] });
  assert.deepEqual([r.ok, r.reason, r.text], [false, 'none', '']);
});

// ---- Transition finder: the finder's own matches ----

// Searches over a spread of zones: the zone's most common weather after its second, with and without an ET slot.
const SEARCHES = D.zones.filter((z, i) => i % 5 === 0 && new Set(z.rates.map((r) => r[0])).size > 1).flatMap((z) => {
  const ws = [...W.odds(z).entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([w]) => w);
  return [{ z, s: { prev: [], to: [ws[0]], bells: [] } }, { z, s: { prev: [ws[1]], to: [ws[0]], bells: [8] } }, { z, s: { prev: [ws[1], ws[0]], to: [ws[ws.length - 1]], bells: [0, 16] } }];
});
const find = (z, s, now) => W.findTransitions(z, { from: now, ...s, limit: 10, horizon: 30 * DAY }).matches;

test('transitions, for many searches and nine instants: "shown" holds the finder\'s matches after now, "next" the first, each one weather period', () => {
  for (const [what, iso] of INSTANTS) {
    const now = utc(iso);
    for (const { z, s } of SEARCHES) {
      const matches = find(z, s, now), after = matches.filter((m) => m.start > now);
      for (const range of ['shown', 'next']) {
        const want = range === 'next' ? after.slice(0, 1) : after;
        const r = build({ source: 'transition', range, now, zone: z, search: s, matches });
        if (!matches.length) { assert.equal(r.reason, 'empty'); continue; }
        if (!want.length) { assert.equal(r.reason, 'none'); continue; }
        const evs = read(r.text).events;
        assert.deepEqual(evs.map((x) => [x.start, x.end]), want.map((m) => [m.start, m.end]), `${what} ${range} ${z.key}`);
        assert.ok(evs.length <= 10 && evs.every((x) => x.start < now + 30 * DAY + W.PERIOD), 'within the finder\'s 10 matches and 30 days');
        for (const [i, x] of evs.entries()) {
          const m = want[i];
          assert.equal(x.end - x.start, W.PERIOD);
          assert.equal(x.props.SUMMARY, `FFXIV: ${z.name}, ${D.weathers[m.previous]} then ${D.weathers[m.weather]}${s.bells.length ? ` at ${String(m.bell).padStart(2, '0')}:00 ET` : ''}`);
          if (s.bells.length) assert.ok(s.bells.includes(m.bell));
        }
      }
    }
  }
});

test('a transition entry links to its own search in the form the page writes, and reading that link gives the search back', () => {
  const s = { prev: [], to: [wid('Gales')], bells: [8] }, z = zone('eureka-anemos');
  // The same form tests/smoke.mjs opens: #zone=eureka-pagos&fz=eureka-anemos&to=gales&bells=8.
  assert.equal(Ics.finderLink(z, s, D), 'https://radmagelabs.com/ffxiv/#zone=eureka-anemos&fz=eureka-anemos&to=gales&bells=8');
  const bySlug = new Map(Object.entries(D.weathers).map(([id, name]) => [F.slug(name), Number(id)]));
  for (const { z: zz, s: ss } of SEARCHES) {
    const p = new URLSearchParams(Ics.finderLink(zz, ss, D).split('#')[1]);
    const list = (k) => (p.get(k) || '').split(',').filter(Boolean);
    assert.deepEqual([p.get('zone'), p.get('fz')], [zz.key, zz.key]);
    assert.deepEqual(list('prev').map((x) => bySlug.get(x)), ss.prev);
    assert.deepEqual(list('to').map((x) => bySlug.get(x)), ss.to);
    assert.deepEqual(list('bells').map(Number), ss.bells);
  }
});

test('transition UIDs belong to the search: the same search (in any order) keeps them, another search matching the same period does not', () => {
  const z = zone('eureka-anemos'), now = utc('2026-11-17T01:00:00Z'), gales = wid('Gales');
  const a = { prev: [], to: [gales], bells: [8] }, b = { prev: [], to: [gales], bells: [] };
  const ua = read(build({ source: 'transition', range: 'shown', now, zone: z, search: a, matches: find(z, a, now) }).text).events;
  const ub = read(build({ source: 'transition', range: 'shown', now, zone: z, search: b, matches: find(z, b, now) }).text).events;
  const shared = ua.filter((x) => ub.some((y) => y.start === x.start));
  assert.ok(shared.length > 0, 'the two searches share a period');
  for (const x of shared) assert.notEqual(x.props.UID, ub.find((y) => y.start === x.start).props.UID);
  const ws = [...W.odds(z).keys()];
  assert.equal(Ics.searchTag({ prev: [ws[0], ws[1]], to: [gales], bells: [16, 0] }), Ics.searchTag({ prev: [ws[1], ws[0]], to: [gales], bells: [0, 16] }));
  assert.match(Ics.searchTag(a), /^[a-z0-9]+$/);
});

// ---- Timed gathering: the engine's windows ----

test('nodes, for every node, every range and nine instants: exactly the windows the engine gives, with their real ET times', () => {
  const fmt = (m) => `${E.formatEt(Math.floor(m / 60) % 24, m % 60)} ET`;
  for (const [what, iso] of INSTANTS) {
    const now = utc(iso);
    for (const range of Object.keys(Ics.RANGES.node)) {
      for (const n of GD.nodes) {
        const want = nodeTruth(n, now, range), r = build({ source: 'node', range, now, nodes: [n] });
        if (!want.length) { assert.equal(r.reason, 'none', `${what} ${range} ${n.id}`); continue; }
        assert.ok(r.ok, `${what} ${range} ${n.id}: ${r.reason}`);
        const evs = read(r.text).events;
        assert.deepEqual(evs.map((x) => [x.start, x.end]), want.map((w) => [w.start, w.end]), `${what} ${range} ${n.id}`);
        for (const x of evs) {
          assert.equal(keyOf(x), `node-${n.id}`);
          // The ET times written are one of the node's own [start, duration] pairs, read independently of the module.
          const startMin = E.clock(x.start).bell * 60 + E.clock(x.start).minute;
          const pair = n.times.find(([s]) => s === startMin);
          assert.ok(pair, `${n.id}: ${startMin} is one of its times`);
          assert.ok(x.props.DESCRIPTION.includes(`up from ${fmt(pair[0])} to ${fmt(pair[0] + pair[1])}`), x.props.DESCRIPTION);
        }
      }
    }
  }
});

test('several nodes in one file: the union of their windows in time order, ties by UID, each window once, the same node twice counted once', () => {
  const now = utc('2026-11-17T01:00:00Z'), four = [346, 400, 463, 1022].map(node);
  for (const range of ['next', '2h', '6h']) {
    const r = build({ source: 'node', range, now, nodes: four.concat(four[0]) }), evs = read(r.text).events;
    const want = four.flatMap((n) => nodeTruth(n, now, range).map((w) => ({ id: n.id, start: w.start })))
      .sort((a, b) => a.start - b.start || (`node-${a.id}` < `node-${b.id}` ? -1 : 1));
    assert.deepEqual(evs.map((x) => [keyOf(x), x.start]), want.map((w) => [`node-${w.id}`, w.start]), range);
    assert.equal(r.count, want.length);
  }
});

test('a node entry names its items, kind, level, job, place, folklore tome and the data it came from', () => {
  const n = node(346), ev = read(build({ source: 'node', range: 'next', now: utc('2026-11-17T01:00:00Z'), nodes: [n] }).text).events[0];
  assert.equal(ev.props.SUMMARY, 'FFXIV: Ilmenite, Prime Achondrite (Legendary, Lv 90 Miner), Mare Lamentorum');
  assert.equal(ev.props.LOCATION, `Mare Lamentorum, ${n.area} (${n.coords[0].toFixed(1)}, ${n.coords[1].toFixed(1)}) (FINAL FANTASY XIV)`);
  const d = ev.props.DESCRIPTION;
  assert.ok(d.includes('Items: Ilmenite (Lv 90 ★★); Prime Achondrite (Lv 90 ★★★, collectable).'), d);
  assert.ok(d.includes('Needs the Tome of Geological Folklore - The Sea of Stars.'), d);
  assert.ok(d.includes('5 minutes 50 seconds of real time'), 'two Eorzean hours');
  assert.ok(d.includes(`Calculated by FFXIV Timer from the game's gathering tables (patch 7.58), and checked against XIVAPI and the node tables on the FFXIV wiki. Not yet compared with the game itself.`), d);
  assert.equal(GD.source.patch, '7.58', 'the patch named is the data\'s own');
  assert.ok(d.endsWith('Details: https://radmagelabs.com/ffxiv/'));
});

// ---- Upcoming: what it lists ----

test('Upcoming entries are the same entries their own sources make, in time order', () => {
  const now = utc('2026-11-17T01:00:00Z'), z = zone('middle-la-noscea'), n = node(346);
  const change = W.nextChange(z, now), win = G.upcoming(n, now, 1)[0];
  const r = build({ source: 'upcoming', range: 'listed', now, items: [{ node: n, window: win }, { zone: z, change }] });
  const evs = read(r.text).events;
  const alone = [build({ source: 'weather', range: 'next', now, zones: [z] }), build({ source: 'node', range: 'next', now, nodes: [n] })].map((x) => read(x.text).events[0]);
  const want = alone.sort((a, b) => a.start - b.start);
  assert.deepEqual(evs.map((x) => x.props), want.map((x) => x.props));
});

// ---- Resets: the resets engine's starts (the Resets panel brings the engine; a stand-in is used here) ----

const RESETS = [
  { id: 'daily', name: 'Daily reset', about: 'Daily duties and allowances reset.', source: 'community sources', certainty: 'unverified' },
  { id: 'weekly', name: 'Weekly reset', about: 'Weekly duties and allowances reset.', source: 'community sources', certainty: 'unverified' },
  { id: 'jumbo-cactpot-aether', name: 'Jumbo Cactpot drawing (Aether)', about: 'The Jumbo Cactpot drawing for the Aether data center.', source: 'the official Gold Saucer guide', certainty: 'official' },
];
/** A stand-in with the engine's shape: fixed UTC starts every `every` ms from `first`. */
const standIn = (plans) => ({
  nextStart: (r, now) => { const p = plans[r.id]; return p.first + Math.max(0, Math.floor((now - p.first) / p.every) + 1) * p.every; },
  upcoming: (rs, now, span) => rs.flatMap((r) => { const out = []; for (let t = standIn(plans).nextStart(r, now); t <= now + span; t += plans[r.id].every) out.push({ reset: r, start: t }); return out; }),
});
const PLANS = { daily: { first: utc('2026-01-01T15:00:00Z'), every: DAY }, weekly: { first: utc('2026-01-06T08:00:00Z'), every: 7 * DAY }, 'jumbo-cactpot-aether': { first: utc('2026-01-04T02:00:00Z'), every: 7 * DAY } };
const resetBuild = (o) => build({ source: 'reset', engines: { resets: standIn(PLANS) }, resets: RESETS, ...o });

test('resets: each range holds the engine\'s starts; community-only times say "time unverified" and are tentative, official ones are not', () => {
  const now = utc('2027-03-10T00:00:00Z');
  const counts = { next: 3, '1d': 1, '3d': 3, '7d': 9, '30d': 38 };
  for (const range of Object.keys(Ics.RANGES.reset)) {
    const r = resetBuild({ now, range }), cal = read(r.text);
    assert.equal(cal.events.length, counts[range], range);
    for (const x of cal.events) {
      const id = keyOf(x).replace(/^reset-/, ''), rs = RESETS.find((y) => y.id === id);
      assert.equal(x.end - x.start, 15 * MIN, 'an instant is a 15-minute block');
      if (rs.certainty === 'unverified') {
        assert.equal(x.props.SUMMARY, `FFXIV: ${rs.name} (time unverified)`);
        assert.equal(x.props.STATUS, 'TENTATIVE');
        assert.ok(x.props.DESCRIPTION.includes('Unverified: this time comes from community sources and has not yet been checked in game.'));
      } else {
        assert.equal(x.props.SUMMARY, `FFXIV: ${rs.name}`);
        assert.ok(!('STATUS' in x.props));
        assert.ok(x.props.DESCRIPTION.includes('Source: the official Gold Saucer guide.'));
      }
    }
    assert.deepEqual(r.uncertain.map((u) => u.key), ['reset-daily', 'reset-weekly'].filter((k) => cal.events.some((x) => keyOf(x) === k)), `${range}: each marked reset named once`);
  }
  // 30 days from 2027-03-10 cross both daylight-saving changes; every daily start stays at 15:00 UTC.
  const daily = read(resetBuild({ now, range: '30d', resets: [RESETS[0]] }).text).events;
  assert.ok(daily.every((x) => new Date(x.start).getUTCHours() === 15 && new Date(x.start).getUTCMinutes() === 0));
  assert.ok(daily[0].start < utc('2027-03-14T00:00:00Z') && daily[daily.length - 1].start > utc('2027-03-28T12:00:00Z'));
});

test('calculated weather and node times carry a note in the description and no mark in the title', () => {
  const now = utc('2026-11-17T01:00:00Z');
  for (const r of [build({ source: 'weather', range: '6h', now, zones: [zone('urqopacha')] }), build({ source: 'node', range: '6h', now, nodes: GD.nodes.slice(0, 20) })]) {
    assert.deepEqual(r.uncertain, []);
    for (const x of read(r.text).events) {
      assert.ok(!/unverified/i.test(x.props.SUMMARY) && !('STATUS' in x.props), x.props.SUMMARY);
      assert.ok(x.props.DESCRIPTION.includes('Not yet compared with the game itself.'));
    }
  }
});

// ---- Limits ----

test('the limits are exact: 200 entries make a file without a warning, 201 with one, 500 still make a file, 501 do not', () => {
  const now = utc('2026-11-17T00:00:00Z'), one = [RESETS[2]];
  const many = (n) => ({ nextStart: () => NaN, upcoming: (rs) => Array.from({ length: n }, (_, i) => ({ reset: rs[0], start: now + (i + 1) * MIN })) });
  const at = (n) => build({ source: 'reset', range: '30d', now, resets: one, engines: { resets: many(n) } });
  assert.deepEqual([at(200).ok, at(200).warn, at(200).count], [true, false, 200]);
  assert.deepEqual([at(201).ok, at(201).warn], [true, true]);
  assert.deepEqual([at(500).ok, at(500).warn, read(at(500).text).events.length], [true, true, 500]);
  assert.deepEqual([at(501).ok, at(501).reason, at(501).count, at(501).text], [false, 'too-many', 501, '']);
});

test('every node for 6 hours is refused as too many, with the count; the default starred zones for 6 hours fit', () => {
  const now = utc('2026-11-17T01:00:00Z');
  const want = GD.nodes.reduce((s, n) => s + nodeTruth(n, now, '6h').length, 0);
  const r = build({ source: 'node', range: '6h', now, nodes: GD.nodes });
  assert.deepEqual([r.ok, r.reason, r.count], [false, 'too-many', want]);
  const zs = build({ source: 'weather', range: '6h', now, zones: ['middle-la-noscea', 'urqopacha', 'eureka-pagos'].map(zone) });
  assert.ok(zs.ok && !zs.warn && zs.count > 20 && zs.count < 60, String(zs.count));
});

test('a window the engine gives twice is written once', () => {
  const now = utc('2026-11-17T00:00:00Z'), s = now + HOUR;
  const twice = { nextStart: () => s, upcoming: (rs) => [{ reset: rs[0], start: s }, { reset: rs[0], start: s }, { reset: rs[0], start: s + DAY }] };
  const r = build({ source: 'reset', range: '3d', now, resets: [RESETS[2]], engines: { resets: twice } });
  assert.deepEqual(read(r.text).events.map((x) => x.start), [s, s + DAY]);
});

test('an unknown source or range, a bad alarm, an empty choice, a bad clock, a bad entry or a failing engine makes no file', () => {
  const now = utc('2026-11-17T00:00:00Z'), z = [zone('urqopacha')];
  const no = (r, reason) => assert.deepEqual([r.ok, r.reason, r.text, r.count], [false, reason, '', 0], reason);
  no(build({ source: 'mounts', range: 'next', now, zones: z }), 'source');
  no(build({ source: 'toString', range: 'next', now, zones: z }), 'source');
  no(build({ source: 'weather', range: '30d', now, zones: z }), 'range');
  no(build({ source: 'weather', range: 'toString', now, zones: z }), 'range');
  for (const alarmMin of [7, -5, '10', 60, null, NaN]) no(build({ source: 'weather', range: 'next', now, zones: z, alarmMin }), 'alarm');
  no(build({ source: 'weather', range: 'next', now, zones: [] }), 'empty');
  no(build({ source: 'node', range: 'next', now, nodes: [] }), 'empty');
  no(build({ source: 'transition', range: 'shown', now, zone: z[0], search: { prev: [], to: [], bells: [] }, matches: [] }), 'empty');
  no(build({ source: 'weather', range: 'next', now, zones: null }), 'entry');
  no(build({ source: 'weather', range: 'next', now: NaN, zones: z }), 'entry');
  no(build({ source: 'weather', range: 'next', now, zones: z, engines: {} }), 'entry');
  const evil = { nextStart: () => now + HOUR, upcoming: () => [] };
  for (const bad of [{ ...RESETS[0], id: 'Bad Id' }, { ...RESETS[0], id: 'x\r\nATTACH:evil' }, { ...RESETS[0], name: ' ' }, { ...RESETS[0], certainty: 'maybe' }]) {
    no(build({ source: 'reset', range: 'next', now, resets: [bad], engines: { resets: evil } }), 'entry');
  }
  no(build({ source: 'reset', range: '1d', now, resets: [RESETS[0]], engines: { resets: { upcoming: () => [], nextStart: () => NaN } } }), 'none');
  no(build({ source: 'reset', range: 'next', now, resets: [RESETS[0]], engines: { resets: { upcoming: () => [], nextStart: () => NaN } } }), 'none');
});

// ---- Alarms, ids, bytes ----

test('alarms: none by default; 5, 10 or 15 minutes before each start, saying what happens', () => {
  const now = utc('2026-11-17T01:00:00Z'), n = node(346);
  assert.ok(!build({ source: 'node', range: '6h', now, nodes: [n] }).text.includes('VALARM'), 'no alarm when none is asked for');
  for (const m of [5, 10, 15]) {
    for (const x of read(build({ source: 'node', range: '6h', now, nodes: [n], alarmMin: m }).text).events) {
      assert.deepEqual(x.alarms, [{ ACTION: 'DISPLAY', DESCRIPTION: `FFXIV: Ilmenite, Prime Achondrite appears in Mare Lamentorum in ${m} minutes`, TRIGGER: `-PT${m}M` }]);
    }
    const w = read(build({ source: 'weather', range: 'next', now, zones: [zone('urqopacha')], alarmMin: m }).text).events[0];
    assert.match(w.alarms[0].DESCRIPTION, new RegExp(`^FFXIV: Urqopacha turns to [A-Za-z ]+ in ${m} minutes$`));
  }
});

test('ids are stable: the same start has the same UID in any later file, a different start never does', () => {
  const zs = [zone('urqopacha'), zone('eureka-pagos')];
  const a = read(build({ source: 'weather', range: '6h', now: utc('2026-11-17T01:00:00Z'), zones: zs }).text).events;
  const b = read(build({ source: 'weather', range: '6h', now: utc('2026-11-17T03:00:00Z'), zones: zs }).text).events;
  const byKey = new Map(a.map((x) => [`${keyOf(x)} ${x.start}`, x.props.UID]));
  const shared = b.filter((x) => byKey.has(`${keyOf(x)} ${x.start}`));
  assert.ok(shared.length >= 4);
  for (const x of shared) assert.equal(x.props.UID, byKey.get(`${keyOf(x)} ${x.start}`));
  assert.equal(new Set(a.concat(b).map((x) => x.props.UID)).size, new Set(a.concat(b).map((x) => `${keyOf(x)} ${x.start}`)).size);
  assert.ok(b.every((x) => x.stamp === utc('2026-11-17T03:00:00Z')), 'DTSTAMP is the moment the file was made');
});

test('deterministic: the same choices at the same instant give the same bytes; DTSTAMP drops milliseconds', () => {
  const o = { source: 'node', range: '6h', now: utc('2026-11-17T01:00:00.789Z'), nodes: [346, 400, 463].map(node), alarmMin: 10 };
  const a = build(o).text, b = build(o).text;
  assert.equal(a, b);
  assert.ok(a.includes('DTSTAMP:20261117T010000Z\r\n'));
});

test('the golden file: an Upcoming file with a weather change and a legendary node, 10-minute alarm, byte for byte (in every zone)', () => {
  const now = utc('2026-11-17T01:00:00Z'), z = zone('middle-la-noscea'), n = node(346);
  const r = build({ source: 'upcoming', range: 'listed', now, alarmMin: 10, items: [{ zone: z, change: W.nextChange(z, now) }, { node: n, window: G.upcoming(n, now, 1)[0] }] });
  // .gitattributes stores text files with LF; the CRLF of the output itself is checked by read().
  const golden = readFileSync(join(ROOT, 'tests', 'fixtures', 'calendar-golden.ics'), 'utf8').replace(/\r?\n/g, '\r\n');
  assert.equal(r.text, golden);
  read(r.text);
});

// ---- File names ----

test('file names are lowercase letters, digits and hyphens, and say what is in the file', () => {
  const f = Ics.filename;
  assert.equal(f({ source: 'transition', range: 'shown', key: 'eureka-anemos' }), 'ffxiv-timer-transitions-eureka-anemos-matches.ics');
  assert.equal(f({ source: 'transition', range: 'next', key: 'eureka-anemos' }), 'ffxiv-timer-transitions-eureka-anemos-next.ics');
  assert.equal(f({ source: 'node', range: 'next', scope: 'one', key: '346' }), 'ffxiv-timer-node-346-next.ics');
  assert.equal(f({ source: 'node', range: '6h', scope: 'starred' }), 'ffxiv-timer-starred-nodes-next-6-hours.ics');
  assert.equal(f({ source: 'node', range: '2h', scope: 'choose', count: 3 }), 'ffxiv-timer-3-nodes-next-2-hours.ics');
  assert.equal(f({ source: 'weather', range: '6h', scope: 'starred' }), 'ffxiv-timer-starred-weather-zones-next-6-hours.ics');
  assert.equal(f({ source: 'weather', range: '2h', scope: 'choose', count: 3 }), 'ffxiv-timer-weather-3-zones-next-2-hours.ics');
  assert.equal(f({ source: 'weather', range: 'next', scope: 'one', key: 'urqopacha' }), 'ffxiv-timer-weather-urqopacha-next.ics');
  assert.equal(f({ source: 'upcoming', range: 'listed' }), 'ffxiv-timer-upcoming.ics');
  assert.equal(f({ source: 'reset', range: '7d', scope: 'choose', count: 3 }), 'ffxiv-timer-3-resets-next-7-days.ics');
  assert.equal(f({ source: 'reset', range: '30d', scope: 'one', key: 'weekly' }), 'ffxiv-timer-reset-weekly-next-30-days.ics');
  for (const source of Object.keys(Ics.RANGES)) for (const range of [...Object.keys(Ics.RANGES[source]), 'x']) for (const scope of ['one', 'starred', 'choose', undefined]) {
    for (const key of ['eureka-anemos', '346', 'Bad Key', 'x\r\ny', undefined]) for (const count of [1, 3, 0, -1, 2.5, undefined]) {
      assert.match(f({ source, range, scope, key, count }), /^ffxiv-timer-[a-z0-9]+(?:-[a-z0-9]+)*\.ics$/);
    }
  }
  assert.equal(f(), 'ffxiv-timer-calendar.ics');
});

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
