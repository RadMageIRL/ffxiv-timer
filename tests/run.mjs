// Unit tests. Run with `node tests/run.mjs`; no dependencies, no network.
// Expected values come from outside this code wherever one exists: the game's own constants
// (175 s bells, changes at 00:00/08:00/16:00 ET), the wiki's real-time conversion table, two
// independent weather implementations (tests/fixtures/weather-vectors.json) and a second
// extraction of the game tables from XIVAPI (tests/fixtures/xivapi-weather.json).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareWeather } from '../tools/lib/compare-weather.mjs';
import { build, localRefs, TARGETS } from '../tools/build.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const E = require('../js/eorzea.js');
const W = require('../js/weather.js');
const F = require('../js/format.js');
const DATA = require('../js/weather-data.js');
const fixture = (name) => JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', name), 'utf8'));

let passed = 0, failed = 0;
const pending = [];
const fail = (name, e) => { failed++; console.error(`FAIL ${name}\n  ${String(e.message).split('\n').join('\n  ')}`); };
// Async tests are awaited before the summary, so a rejected promise counts as a failure.
function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') pending.push(result.then(() => { passed++; }, (e) => fail(name, e)));
    else passed++;
  } catch (e) { fail(name, e); }
}

const zone = (key) => { const z = DATA.zones.find((x) => x.key === key); assert.ok(z, `no zone ${key}`); return z; };
const name = (id) => DATA.weathers[id];
const SEC = 1000, MIN = 60 * SEC, HOUR = 60 * MIN, DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 23, 12, 0, 0); // a fixed "today" for the searches below
let seed = 0x9e3779b9;
const rand = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
const randomTime = () => Math.floor(Date.UTC(2013, 7, 27) + rand() * (Date.UTC(2040, 0, 1) - Date.UTC(2013, 7, 27)));

// ---- Eorzea clock ----
test('the Unix epoch is ET 00:00:00 on the 1st Sun of the 1st Astral Moon', () => {
  const c = E.clock(0);
  assert.deepEqual([c.bell, c.minute, c.second, c.sun, c.moon, c.year], [0, 0, 0, 1, 1, 0]);
  assert.equal(E.dateName(c), '1st Sun of the 1st Astral Moon');
});
test('one bell is 175 real seconds', () => {
  assert.equal(E.BELL, 175 * SEC);
  assert.deepEqual([E.clock(175 * SEC - 1).bell, E.clock(175 * SEC - 1).minute], [0, 59]);
  assert.deepEqual([E.clock(175 * SEC).bell, E.clock(175 * SEC).minute], [1, 0]);
});
test('one sun is 70 real minutes and wraps the bell to 00', () => {
  assert.equal(E.SUN, 70 * MIN);
  const before = E.clock(70 * MIN - 1), after = E.clock(70 * MIN);
  assert.deepEqual([before.sun, before.bell, before.minute], [1, 23, 59]);
  assert.deepEqual([after.sun, after.bell, after.minute], [2, 0, 0]);
});
test('an ET minute is 2 11/12 real seconds (2916.67 ms)', () => {
  assert.equal(E.clock(2916).minute, 0);
  assert.equal(E.clock(2917).minute, 1);
  assert.equal(E.clock(12 * 2917).minute, 12); // 12 minutes = exactly 35 s
  assert.equal(E.clock(35 * SEC - 1).minute, 11);
});
test('the wiki conversion table: moon 37 h 20 min, year 18 days 16 h', () => {
  assert.equal(E.MOON, 37 * HOUR + 20 * MIN);
  assert.equal(E.YEAR, 18 * DAY + 16 * HOUR);
  const m = E.clock(E.MOON), y = E.clock(E.YEAR);
  assert.deepEqual([m.moon, m.sun, m.year], [2, 1, 0]);
  assert.deepEqual([y.moon, y.sun, y.year], [1, 1, 1]);
  assert.deepEqual([E.clock(E.MOON - 1).moon, E.clock(E.MOON - 1).sun], [1, 32]);
  assert.deepEqual([E.clock(E.YEAR - E.SUN).year, E.clock(E.YEAR - E.SUN).moon, E.clock(E.YEAR - E.SUN).sun], [0, 12, 32]);
});
test('Eorzea runs exactly 144/7 times real time over long spans', () => {
  assert.equal(E.toEorzea(7 * DAY), 144 * DAY);
  assert.equal(E.toEorzea(NOW) - E.toEorzea(NOW - 7 * DAY), 144 * DAY);
  for (let i = 0; i < 2000; i++) {
    const t = randomTime();
    assert.equal(E.toEorzea(t), Math.floor((t * 144) / 7), String(t));
  }
});
test('fromEorzea gives the first real millisecond of an ET instant', () => {
  for (let i = 0; i < 2000; i++) {
    const e = Math.floor(E.toEorzea(randomTime()) / E.ET_MINUTE) * E.ET_MINUTE;
    const t = E.fromEorzea(e);
    assert.ok(E.toEorzea(t) >= e && E.toEorzea(t - 1) < e, String(e));
  }
});
test('moons alternate Astral and Umbral, 1st Astral through 6th Umbral', () => {
  const names = Array.from({ length: 12 }, (_, i) => E.moonName(i + 1));
  assert.deepEqual(names, ['1st Astral Moon', '1st Umbral Moon', '2nd Astral Moon', '2nd Umbral Moon', '3rd Astral Moon',
    '3rd Umbral Moon', '4th Astral Moon', '4th Umbral Moon', '5th Astral Moon', '5th Umbral Moon', '6th Astral Moon', '6th Umbral Moon']);
});
test('sun ordinals read 1st, 2nd, 3rd, 11th, 12th, 13th, 21st, 22nd, 23rd, 31st, 32nd', () => {
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 31, 32].map(E.ordinal),
    ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '31st', '32nd']);
});
test('daytime is 06:00 up to 18:00 ET', () => {
  assert.deepEqual([0, 5, 6, 12, 17, 18, 23].map(E.isDaytime), [false, false, true, true, true, false, false]);
});
test('clock results do not depend on the machine time zone', () => {
  const script = "const E=require('./js/eorzea.js'),W=require('./js/weather.js'),D=require('./js/weather-data.js');" +
    "const ts=[0,1e12,1761220800000,1999999999999];" +
    "console.log(JSON.stringify(ts.map(t=>[E.clock(t),E.nextEtTime(t,6),W.weatherAt(D.zones[0],t)])))";
  const run = (tz) => execFileSync(process.execPath, ['-e', script], { cwd: ROOT, env: { ...process.env, TZ: tz } }).toString();
  const base = run('UTC');
  for (const tz of ['America/Los_Angeles', 'Asia/Tokyo', 'Pacific/Chatham', 'Asia/Kolkata', 'Europe/London']) assert.equal(run(tz), base, tz);
});
test('the engines never read local-time Date fields', () => {
  for (const file of ['eorzea.js', 'weather.js', 'format.js']) {
    const src = readFileSync(join(ROOT, 'js', file), 'utf8');
    assert.doesNotMatch(src, /get(Hours|Minutes|Date|Day|Month|FullYear|TimezoneOffset)\(|toLocale|new Date\(/, file);
  }
});

// ---- countdown targets ----
test('nextBell and nextPeriod land on the following boundary, never on t itself', () => {
  for (let i = 0; i < 1000; i++) {
    const t = randomTime(), b = E.nextBell(t), p = E.nextPeriod(t);
    assert.ok(b > t && b - t <= E.BELL && b % E.BELL === 0);
    assert.ok(p > t && p - t <= E.WEATHER_PERIOD && p % E.WEATHER_PERIOD === 0);
  }
  assert.equal(E.nextBell(E.BELL * 1000), E.BELL * 1001);
});
test('weather periods start at 00:00, 08:00 and 16:00 ET and last 23 min 20 s', () => {
  assert.equal(E.WEATHER_PERIOD, 23 * MIN + 20 * SEC);
  const starts = [0, 1, 2, 3].map((k) => E.clock(E.periodStart(NOW) + k * E.WEATHER_PERIOD));
  for (const c of starts) assert.ok([0, 8, 16].includes(c.bell) && c.minute === 0, `${c.bell}:${c.minute}`);
  assert.equal(new Set(starts.slice(0, 3).map((c) => c.bell)).size, 3);
});
test('nextEtTime finds the first real ms showing that ET time, at or after t', () => {
  for (let i = 0; i < 1000; i++) {
    const t = randomTime(), bell = Math.floor(rand() * 24), minute = Math.floor(rand() * 60);
    const at = E.nextEtTime(t, bell, minute), c = E.clock(at), c1 = E.clock(at - 1);
    assert.ok(at >= t && at - t < E.SUN, 'within one sun');
    assert.deepEqual([c.bell, c.minute, c.second], [bell, minute, 0]);
    assert.notDeepEqual([c1.bell, c1.minute], [bell, minute]);
  }
  const sunrise = E.nextEtTime(NOW, 6);
  assert.equal(E.nextEtTime(sunrise, 6), sunrise, 'at the moment itself, it is now');
  assert.equal(E.nextEtTime(sunrise + 1, 6), sunrise + E.SUN);
  assert.throws(() => E.nextEtTime(NOW, 24));
});
test('countdowns round up to the second and switch units at an hour and a day', () => {
  const cases = [[0, '0:00'], [1, '0:01'], [999, '0:01'], [1000, '0:01'], [1001, '0:02'], [59 * SEC, '0:59'],
    [10 * MIN + 5 * SEC, '10:05'], [HOUR - 1001, '59:59'], [HOUR - 1, '1h 00m'], [HOUR, '1h 00m'], [2 * HOUR + 7 * MIN, '2h 07m'],
    [DAY, '1d 0h'], [3 * DAY + 4 * HOUR + 59 * MIN, '3d 4h'], [-5000, '0:00']];
  for (const [ms, text] of cases) assert.equal(F.countdown(ms), text, String(ms));
});

// ---- weather roll ----
const vectors = fixture('weather-vectors.json');
test('the weather roll matches two independent implementations', () => {
  assert.ok(vectors.targets.length >= 30);
  for (const [t, target] of vectors.targets) assert.equal(W.forecastTarget(t), target, String(t));
});
test('zone weather matches two independent implementations, incl. their published Anemos case', () => {
  assert.ok(vectors.weathers.length >= 30);
  for (const [key, t, id, theirName] of vectors.weathers) assert.equal(W.weatherAt(zone(key), t), id, `${key} @ ${t} (${theirName})`);
  assert.equal(name(W.weatherAt(zone('eureka-anemos'), 1522399121529)), 'Showers');
});
// Same algorithm, written with BigInt so no 32-bit JavaScript operator is involved.
function referenceRoll(t) {
  const unix = BigInt(Math.floor(t / 1000)), mask = 0xffffffffn;
  const etHour = (unix / 175n) % 24n;
  const increment = { 0: 8n, 1: 16n, 2: 0n }[Number(etHour / 8n)];
  const base = ((unix / 4200n) * 100n + increment) & mask;
  const step1 = ((base << 11n) ^ base) & mask;
  return Number((((step1 >> 8n) ^ step1) & mask) % 100n);
}
test('the roll agrees with a BigInt reference, including past the 32-bit wrap', () => {
  for (let i = 0; i < 20000; i++) { const t = randomTime(); assert.equal(W.forecastTarget(t), referenceRoll(t), String(t)); }
  // base = days * 100 passes 2^32 after day 42,949,672 (year 7686); the game's uint math wraps.
  for (const t of [Date.UTC(7700, 0, 1), Date.UTC(9000, 5, 1, 7), Date.UTC(200000, 0, 1)]) assert.equal(W.forecastTarget(t), referenceRoll(t), String(t));
});
test('the roll is constant inside a period and the period starting 16:00 uses increment 0', () => {
  for (let i = 0; i < 500; i++) {
    const p = E.periodStart(randomTime());
    assert.equal(W.forecastTarget(p), W.forecastTarget(p + E.WEATHER_PERIOD - 1));
  }
  const day = 500000; // any sun number
  const at16 = day * E.SUN + 16 * E.BELL;
  const base = (day * 100 + 0) >>> 0, s1 = ((base << 11) ^ base) >>> 0;
  assert.equal(W.forecastTarget(at16), (((s1 >>> 8) ^ s1) >>> 0) % 100);
});
test('weather is undefined before the Unix epoch', () => {
  assert.throws(() => W.forecastTarget(-1), RangeError);
});

// ---- weather tables ----
test('picking walks the table in order and keeps repeated weathers separate', () => {
  const z = { name: 'test', rates: [[1, 20], [2, 30], [1, 10], [3, 40]] };
  assert.deepEqual([0, 19, 20, 49, 50, 59, 60, 99].map((x) => W.pick(z, x)), [1, 1, 2, 2, 1, 1, 3, 3]);
  assert.deepEqual([...W.odds(z)], [[1, 30], [2, 30], [3, 40]]);
  assert.throws(() => W.pick({ name: 'short', rates: [[1, 50]] }, 50));
});
test('every zone in data/supported-zones.json is generated, with a table that sums to 100', () => {
  const listed = JSON.parse(readFileSync(join(ROOT, 'data', 'supported-zones.json'), 'utf8')).zones;
  assert.deepEqual(DATA.zones.map((z) => z.territory), listed.map((z) => z.territory));
  for (const z of DATA.zones) {
    assert.equal(z.rates.reduce((s, [, r]) => s + r, 0), 100, z.name);
    for (const [w, r] of z.rates) { assert.ok(name(w), `${z.name} weather ${w}`); assert.ok(r > 0); }
  }
  assert.equal(new Set(DATA.zones.map((z) => z.key)).size, DATA.zones.length);
  assert.equal(DATA.zones.every((z) => z.key === F.slug(z.name)), true);
});
test('the tables match a second extraction of the game data (XIVAPI)', () => {
  const x = fixture('xivapi-weather.json');
  assert.equal(x.zones.length, DATA.zones.length);
  assert.deepEqual(compareWeather(x, DATA), []);
});
test('the XIVAPI comparison notices a changed table (the check can fail)', () => {
  const x = fixture('xivapi-weather.json');
  const bad = JSON.parse(JSON.stringify(DATA));
  bad.zones[3].rates[0][1] += 1; bad.zones[3].rates[1][1] -= 1;
  assert.equal(compareWeather(x, bad).length, 1);
});
test('known tables: Middle La Noscea, Eureka Pagos and Solution Nine', () => {
  const pct = (key) => Object.fromEntries([...W.odds(zone(key))].map(([w, p]) => [name(w), p]));
  assert.deepEqual(pct('middle-la-noscea'), { Clouds: 20, 'Clear Skies': 30, 'Fair Skies': 20, Wind: 10, Fog: 10, Rain: 10 });
  assert.deepEqual(pct('eureka-pagos'), { 'Fair Skies': 10, Fog: 18, 'Heat Waves': 18, Snow: 18, Thunder: 18, Blizzards: 18 });
  assert.deepEqual(pct('solution-nine'), { 'Fair Skies': 100 });
});
test('unsupported places are named, carry no tables, and never overlap supported ones', () => {
  const supported = new Set(DATA.zones.map((z) => z.name));
  assert.ok(DATA.unsupported.length > 0);
  for (const u of DATA.unsupported) {
    assert.deepEqual(Object.keys(u).sort(), ['key', 'name']);
    assert.ok(!supported.has(u.name), u.name);
  }
  for (const n of ['Mist', 'The Lavender Beds', 'Bozjan Southern Front', 'Zadnor', 'South Horn']) assert.ok(DATA.unsupported.some((u) => u.name === n), n);
});
test('weather-data.js names its source commit and patch', () => {
  assert.equal(DATA.source.dataset, 'xivapi/ffxiv-datamining');
  assert.match(DATA.source.commit, /^[0-9a-f]{40}$/);
  assert.equal(DATA.source.patch, '7.57h1');
});

// ---- forecasts and transitions ----
test('periods are contiguous and each knows the weather before it', () => {
  const z = zone('eastern-la-noscea');
  const ps = W.periods(z, NOW, 200);
  assert.equal(ps[0].start, E.periodStart(NOW));
  assert.equal(ps[0].previous, W.weatherAt(z, ps[0].start - 1));
  for (let i = 1; i < ps.length; i++) {
    assert.equal(ps[i].start, ps[i - 1].end);
    assert.equal(ps[i].previous, ps[i - 1].weather);
    assert.equal(ps[i].weather, W.weatherAt(z, ps[i].start + 1234));
    assert.equal(ps[i].bell, [0, 8, 16][(ps[i - 1].bell / 8 + 1) % 3]);
  }
});
test('spans merge runs of one weather without gaps', () => {
  const z = zone('middle-la-noscea'), ps = W.periods(z, NOW, 300), ss = W.spans(z, NOW, 300);
  assert.equal(ss[0].start, ps[0].start);
  assert.equal(ss[ss.length - 1].end, ps[ps.length - 1].end);
  assert.ok(ss.length < ps.length, 'some runs merged');
  for (let i = 1; i < ss.length; i++) { assert.equal(ss[i].start, ss[i - 1].end); assert.notEqual(ss[i].weather, ss[i - 1].weather); }
  assert.equal(W.spans(zone('solution-nine'), NOW, 50).length, 1);
});
test('nextChange is the first period whose weather differs', () => {
  for (const z of DATA.zones.filter((x) => x.rates.length > 1)) {
    const t = NOW + 7 * MIN, ch = W.nextChange(z, t);
    assert.ok(ch && ch.at > t && ch.to !== ch.from && ch.from === W.weatherAt(z, t), z.name);
    for (let p = E.nextPeriod(t); p < ch.at; p += E.WEATHER_PERIOD) assert.equal(W.weatherAt(z, p), ch.from);
  }
  assert.equal(W.nextChange(zone('solution-nine'), NOW, 500), null);
});
function bruteForce(z, from, { previous = [], to = [], bells = [] }, horizon) {
  return W.periods(z, from, Math.ceil(horizon / E.WEATHER_PERIOD) + 1)
    .filter((p) => p.start < from + horizon)
    .filter((p) => (!previous.length || previous.includes(p.previous)) && (!to.length || to.includes(p.weather)) && (!bells.length || bells.includes(p.bell)));
}
test('the transition finder returns exactly the matching periods, in order', () => {
  const pagos = zone('eureka-pagos'), [fog, heat, blizz] = [4, 14, 16];
  const queries = [{ to: [blizz] }, { previous: [fog], to: [heat] }, { previous: [blizz], to: [blizz], bells: [8] }, { previous: [fog, heat], bells: [0, 16] }];
  for (const q of queries) {
    const want = bruteForce(pagos, NOW, q, 10 * DAY);
    const got = W.findTransitions(pagos, { from: NOW, ...q, limit: 1000, horizon: 10 * DAY });
    assert.ok(got.possible && want.length > 0, JSON.stringify(q));
    assert.deepEqual(got.matches.map((m) => [m.start, m.previous, m.weather]), want.map((p) => [p.start, p.previous, p.weather]), JSON.stringify(q));
  }
});
test('the finder includes the period in progress and respects limit and horizon', () => {
  const z = zone('middle-la-noscea'), mid = E.periodStart(NOW) + 5 * MIN;
  const current = W.weatherAt(z, mid);
  const r = W.findTransitions(z, { from: mid, to: [current], limit: 3 });
  assert.equal(r.matches[0].start, E.periodStart(mid));
  assert.equal(r.matches.length, 3);
  const short = W.findTransitions(z, { from: NOW, to: [current], limit: 1000, horizon: 2 * HOUR });
  assert.ok(short.matches.every((m) => m.start < NOW + 2 * HOUR));
});
test('a weather a zone never has is reported impossible, not just unmatched', () => {
  const r = W.findTransitions(zone('middle-la-noscea'), { from: NOW, to: [16] }); // Blizzards
  assert.deepEqual([r.possible, r.matches.length], [false, 0]);
  const mixed = W.findTransitions(zone('middle-la-noscea'), { from: NOW, previous: [4], to: [16] }); // Fog, then Blizzards
  assert.deepEqual([mixed.possible, mixed.matches.length], [false, 0]);
  const solution = W.findTransitions(zone('solution-nine'), { from: NOW, previous: [2], to: [2], limit: 5 });
  assert.equal(solution.matches.length, 5, 'always Fair Skies after Fair Skies');
});

// ---- timed gathering ----
const G = require('../js/gathering.js');
const GDATA = require('../js/gathering-data.js');
const { hhmmToMinutes, mapCoordinate } = await import('../tools/build-gathering.mjs');
const { WIKI_EXCEPTIONS, compareGatheringXivapi, compareGatheringWiki } = await import('../tools/lib/compare-gathering.mjs');
const etMinuteOfDay = (t) => { const c = E.clock(t); return c.bell * 60 + c.minute; };

test('spawn durations are HHMM: 160 is the 2 bells and 300 the 3 bells the wiki states', () => {
  assert.deepEqual([0, 800, 2200, 160, 300, 130].map(hhmmToMinutes), [0, 480, 1320, 120, 180, 90]);
});
test('map coordinates: a raw position at -offset is the map center', () => {
  assert.equal(mapCoordinate(0, 100, 0), 21.5);
  assert.equal(mapCoordinate(-150, 100, 150), 21.5);
  assert.equal(mapCoordinate(0, 200, 0), 11.25);
  assert.ok(mapCoordinate(1024, 100, 0) > 41 && mapCoordinate(-1024, 100, 0) === 1);
});
test('a window starts on the exact ET minute and lasts its duration of Eorzean time', () => {
  const node = { times: [[480, 120], [1200, 120]] };
  const ws = G.windows(node, NOW, NOW + E.SUN * 3);
  assert.ok(ws.length >= 5);
  for (const w of ws) {
    assert.ok([480, 1200].includes(etMinuteOfDay(w.start)) && E.clock(w.start).second === 0);
    assert.notEqual(etMinuteOfDay(w.start - 1), etMinuteOfDay(w.start));
    assert.equal(w.end - w.start, 120 * 175000 / 60, '2 bells = 5 min 50 s');
    assert.equal(etMinuteOfDay(w.end), etMinuteOfDay(w.start) + 120);
  }
});
test('node status agrees with the ET clock at random times (brute force)', () => {
  for (const node of [GDATA.nodes[0], GDATA.nodes[10], { times: [[1380, 180]] }]) {
    for (let i = 0; i < 2000; i++) {
      const t = randomTime(), m = etMinuteOfDay(t);
      const inside = node.times.some(([s, d]) => (m - s + 1440) % 1440 < d);
      const st = G.status(node, t);
      assert.equal(st.up, inside, `${JSON.stringify(node.times)} at ${t}`);
      assert.ok(st.up ? st.start <= t && t < st.end : st.start > t);
    }
  }
});
test('window edges: up from the first millisecond, down at the end, not counted once over', () => {
  const node = { times: [[480, 120]] };
  const w = G.windows(node, NOW, NOW + E.SUN * 2)[0];
  assert.deepEqual([w.start - 1, w.start, w.end - 1, w.end].map((t) => G.status(node, t).up), [false, true, true, false]);
  assert.equal(G.status(node, w.start).start, w.start);
  assert.ok(!G.windows(node, w.end, w.end + E.BELL).some((x) => x.start === w.start), 'a window ending at `from` does not overlap');
  assert.ok(G.windows(node, w.end - 1, w.end).some((x) => x.start === w.start));
  assert.ok(G.upcoming(node, w.start, 1)[0].start > w.start, 'upcoming means after t');
});
test('a window that runs past ET midnight is found from either side of midnight', () => {
  const node = { times: [[1380, 180]] }; // 23:00 for 3 bells
  const midnight = E.sunStart(NOW) + E.SUN, oneAm = midnight + E.BELL;
  const st = G.status(node, oneAm);
  assert.ok(st.up);
  assert.equal(st.start, midnight - E.BELL);
  assert.equal(st.end, midnight + 2 * E.BELL);
  assert.equal(G.status(node, midnight + 2 * E.BELL).up, false);
});
test('upcoming returns the next windows in order, all in the future', () => {
  const node = GDATA.nodes.find((n) => n.items.some((i) => i.name === 'Turali Alumen'));
  const up = G.upcoming(node, NOW, 5);
  assert.equal(up.length, 5);
  for (let i = 0; i < 5; i++) {
    assert.ok(up[i].start > NOW && (i === 0 || up[i].start > up[i - 1].start));
    assert.ok([480, 1200].includes(etMinuteOfDay(up[i].start)));
  }
});
test('every supported node is generated, timed and placed', () => {
  const listed = JSON.parse(readFileSync(join(ROOT, 'data', 'supported-nodes.json'), 'utf8')).nodes.map((n) => n.base);
  assert.deepEqual(GDATA.nodes.map((n) => n.id), listed);
  for (const n of GDATA.nodes) {
    assert.ok(['unspoiled', 'legendary'].includes(n.kind), n.id);
    assert.equal(n.job, ['Mining', 'Quarrying'].includes(n.gathering) ? 'Miner' : 'Botanist', n.id);
    assert.ok(n.times.length >= 1 && n.times.every(([s, d]) => s >= 0 && s < 1440 && d > 0), n.id);
    assert.ok(n.items.length >= 1 && n.coords.every((c) => c >= 1 && c <= 42), n.id);
    if (n.expansion !== 'A Realm Reborn') assert.ok(n.times.every(([, d]) => d === 120), `${n.id} lasts 2 bells`);
    if (n.zoneKey) assert.ok(DATA.zones.some((z) => z.key === n.zoneKey), n.zoneKey);
  }
});
test('nodes match a second extraction of the game data (XIVAPI)', () => {
  const x = fixture('xivapi-gathering.json');
  assert.equal(x.nodes.length, GDATA.nodes.length);
  assert.deepEqual(compareGatheringXivapi(x, GDATA), []);
});
test('nodes match the wiki\'s node tables (times, places, levels, stars, tomes)', () => {
  const w = fixture('wiki-gathering.json');
  assert.ok(w.rows.length >= GDATA.nodes.length);
  assert.deepEqual(compareGatheringWiki(w, GDATA, { exceptions: WIKI_EXCEPTIONS }), []);
  // Exceptions only ever excuse the wiki's coordinates, level, stars or a row with no timed node, each with a stated reason.
  assert.ok(WIKI_EXCEPTIONS.every((e) => ['coords', 'level', 'stars', 'row'].includes(e.field) && e.reason.length > 40 && w.rows.some((r) => r.item === e.item)));
});
test('both gathering comparisons notice a changed node (the checks can fail)', () => {
  const x = fixture('xivapi-gathering.json'), w = fixture('wiki-gathering.json');
  const changes = [
    (n) => { n.times[0][0] += 60; },
    (n) => { n.zone = 'Yanxia'; },
    (n) => { n.items[0].stars += 1; },
    (n) => { n.coords[0] += 3; },
  ];
  changes.forEach((change, i) => {
    const bad = JSON.parse(JSON.stringify(GDATA));
    change(bad.nodes.find((n) => n.items.some((it) => it.name === 'Rarefied Ash Soil')));
    const found = compareGatheringXivapi(x, bad).length + compareGatheringWiki(w, bad, { exceptions: WIKI_EXCEPTIONS }).length;
    assert.ok(found > 0, `change ${i} went unnoticed`);
  });
});
test('the wiki comparison on its own notices wrong stars, level, tome and start time', () => {
  const w = fixture('wiki-gathering.json');
  const changes = [
    (n) => { n.items[0].stars += 1; }, (n) => { n.items[0].level -= 2; },
    (n) => { n.folklore = 'Tome of Geological Folklore - Xak Tural'; }, (n) => { n.times[1][0] += 120; },
  ];
  for (const [i, change] of changes.entries()) {
    const bad = JSON.parse(JSON.stringify(GDATA));
    const key = i === 2 ? 'Turali Alumen' : 'Rarefied Ash Soil';
    change(bad.nodes.find((n) => n.items.some((it) => it.name === key)));
    assert.ok(compareGatheringWiki(w, bad, { exceptions: WIKI_EXCEPTIONS }).length > 0, `change ${i} went unnoticed`);
  }
});
test('the wiki parser reads columns by name, splits multi-node rows and ignores stray breaks', async () => {
  const { parseWikiTables, parseTimes } = await import('../tools/lib/wiki-gathering.mjs');
  assert.deepEqual(['12:00 AM/PM', '8AM/PM', '1:00 AM', '3 PM', 'ANY'].map(parseTimes), [[0, 720], [480, 1200], [60], [900], null]);
  const folklore = [
    '==Botanist==', '===Endwalker===', '{| {{STDT}}', '|-', '! Folklore Tome', '! Time', '! Item', '! Slot', '! Location', '! Coordinates', '! Used to make', '|-',
    '| [[Tome A|A]]<br>[[Tome B|B]] || 6AM/PM<br>8AM/PM || {{item icon|Potent Spice}} || 1 || [[Elpis]]<br>[[Thavnair]] || {{coords|33.1, 14.7}}<br>{{coords|25.4, 21.8}} || {{item icon|X}}',
    '|-', '| [[Tome C|C]] || 10AM/PM || {{item icon|Log}} || 6 || [[Ultima Thule]] || {{coords|28, 13}}<br> || {{item icon|Y}}', '|}',
    '===Shadowbringers===', '{|', '! Time', '! Item', '|-', '| 1AM || {{item icon|Skipped}}', '|}',
    '==Fisher==', '===Endwalker===', '{|', '! Folklore Tome', '! Time', '! Item', '! Location', '|-', '| [[T|T]] || ANY || {{item icon|A Fish}} || [[Elpis]]', '|}',
  ].join('\n');
  const rows = parseWikiTables('Folklore Nodes', folklore, ['Endwalker']);
  assert.deepEqual(rows.map((r) => [r.item, r.tome, r.zone, r.starts, r.coords]), [
    ['Potent Spice', 'Tome A', 'Elpis', [360, 1080], [33.1, 14.7]],
    ['Potent Spice', 'Tome B', 'Thavnair', [480, 1200], [25.4, 21.8]],
    ['Log', 'Tome C', 'Ultima Thule', [600, 1320], [28, 13]],
  ]);
  const arr = ['==Botanist==', '===A Realm Reborn===', '{|', '! Time', '! Item', '! Slot #', '! Location', '! Coordinate', '! Extra', '!Star', '|-',
    '|1:00 AM || {{item icon|Silkworm Cocoon}} || 4 || [[East Shroud]] || {{coords|22, 26}}|| ||★', '|}'].join('\n');
  const [r] = parseWikiTables('Unspoiled Nodes', arr, ['A Realm Reborn']);
  assert.deepEqual([r.kind, r.item, r.zone, r.starts, r.coords, r.stars, 'level' in r], ['unspoiled', 'Silkworm Cocoon', 'East Shroud', [60], [22, 26], 1, false]);
});
test('wiki naming differences are forgiven, real zone differences are not', () => {
  const data = { nodes: [{ id: 1, zone: 'The Azim Steppe', times: [[120, 120]], coords: [20, 20], radius: 0, kind: 'legendary', folklore: null, items: [{ name: "Hawk's Eye", level: 70, stars: 0 }] }] };
  const row = (zone, item) => ({ capture: { rows: [{ item, zone, starts: [120], coords: [20, 20], kind: 'legendary' }] } });
  assert.deepEqual(compareGatheringWiki(row('Azim Steppe', "Hawk's Eye (Material)").capture, data), []);
  assert.equal(compareGatheringWiki(row('The Ruby Sea', "Hawk's Eye").capture, data).length, 1);
  assert.equal(compareGatheringWiki(row('Azim Steppe', "Hawk's Feather").capture, data).length, 2, 'unknown item, and the node goes unnamed');
});
test('js/gathering-data.js is exactly what the generator builds from the cached game tables', () => {
  const cache = join(ROOT, 'tools', '.cache', GDATA.source.commit);
  if (!existsSync(join(cache, 'GatheringPoint.csv'))) { console.log('  (skipped: run node tools/build-gathering.mjs once to cache the game tables)'); return; }
  execFileSync(process.execPath, [join(ROOT, 'tools', 'build-gathering.mjs'), '--check', '--csv', cache], { stdio: 'pipe' });
});

// ---- base path and build ----
test('every page script parses (app.js is only exercised by the browser tests)', () => {
  for (const f of readdirSync(join(ROOT, 'js'))) execFileSync(process.execPath, ['--check', join(ROOT, 'js', f)], { stdio: 'pipe' });
});
test('the site uses no root-relative URLs (it must work under any base path)', () => {
  const files = ['index.html', 'css/style.css', ...readdirSync(join(ROOT, 'js')).map((f) => `js/${f}`)];
  for (const f of files) {
    const src = readFileSync(join(ROOT, f), 'utf8');
    assert.doesNotMatch(src, /(?:src|href|action)\s*=\s*["']\/(?!\/)|url\(\s*["']?\/(?!\/)|fetch\(\s*["'`]\/(?!\/)|location\.(?:href|pathname)\s*=\s*["'`]\//, f);
  }
});
test('index.html loads files that exist, engines before the page script', () => {
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const refs = localRefs(html);
  for (const r of refs) assert.ok(existsSync(join(ROOT, r)), r);
  const order = refs.filter((r) => r.endsWith('.js'));
  assert.ok(order.indexOf('js/eorzea.js') < order.indexOf('js/weather.js') && order.indexOf('js/weather.js') < order.indexOf('js/app.js'));
  assert.equal(order[order.length - 1], 'js/app.js');
});
test('builds for GitHub Pages and RadMage Labs put the app at their base paths', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ffxiv-timer-build-'));
  try {
    const pages = build('pages', { outRoot: tmp }), labs = build('labs', { outRoot: tmp });
    assert.deepEqual(pages.bases, ['/ffxiv-timer/', '/ffxiv/']);
    assert.deepEqual(labs.bases, ['/ffxiv/']);
    assert.ok(existsSync(join(pages.outDir, 'index.html')) && existsSync(join(pages.outDir, '.nojekyll')));
    assert.ok(existsSync(join(labs.outDir, 'ffxiv', 'index.html')) && existsSync(join(labs.outDir, '404.html')));
    for (const b of [pages, labs]) {
      const html = readFileSync(join(b.appDir, 'index.html'), 'utf8');
      assert.match(html, new RegExp(`<link rel="canonical" href="${TARGETS.canonical.replace(/[./]/g, '\\$&')}">`));
      assert.doesNotMatch(html, /deploy:meta/);
      for (const r of localRefs(html)) assert.ok(existsSync(join(b.appDir, r)), `${b.name}: ${r}`);
      assert.match(html, /src="js\/app\.js\?v=[0-9a-f]{10}"/);
      const notFound = readFileSync(join(b.appDir, '404.html'), 'utf8');
      for (const base of b.bases) assert.ok(notFound.includes(JSON.stringify(base)), `${b.name} 404 knows ${base}`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
test('target settings are validated', async () => {
  const { checkTarget } = await import('../tools/build.mjs');
  assert.throws(() => checkTarget('x', { urls: [] }));
  assert.throws(() => checkTarget('x', { urls: ['https://a.b/ffxiv'] }), /slash/);
  assert.throws(() => checkTarget('x', { urls: ['http://a.b/ffxiv/'] }));
  assert.throws(() => checkTarget('x', { urls: ['https://a.b/ffxiv/'], mount: 'other' }), /mount/);
  assert.doesNotThrow(() => checkTarget('x', { urls: ['https://a.b/ffxiv/', 'https://c.d/x/ffxiv/'], mount: 'ffxiv' }));
});

// ---- generated data is current ----
test('js/weather-data.js is exactly what the generator builds from the cached game tables', () => {
  const cache = join(ROOT, 'tools', '.cache', DATA.source.commit);
  if (!existsSync(cache)) { console.log('  (skipped: run node tools/build-weather.mjs once to cache the game tables)'); return; }
  execFileSync(process.execPath, [join(ROOT, 'tools', 'build-weather.mjs'), '--check', '--csv', cache], { stdio: 'pipe' });
});

await Promise.all(pending);
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
