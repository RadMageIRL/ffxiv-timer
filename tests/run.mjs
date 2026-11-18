// Unit tests. Run with `node tests/run.mjs`; no dependencies, no network.
// Expected values come from outside this code wherever one exists: the game's own constants
// (175 s bells, changes at 00:00/08:00/16:00 ET), the wiki's real-time conversion table, two
// independent weather implementations (tests/fixtures/weather-vectors.json) and a second
// extraction of the game tables from XIVAPI (tests/fixtures/xivapi-weather.json).
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
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
  assert.equal(DATA.source.patch, '7.58');
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
// ---- gathering filters and the Next hour view ----
const HOUR_MS = 60 * MIN;
const once = { id: 9001, job: 'Miner', kind: 'legendary', expansion: 'Dawntrail', level: 100, zone: 'Z', area: 'A', gathering: 'Mining', folklore: null, items: [{ name: 'Test Ore' }], times: [[480, 120]] };
test('filters: job, kind, expansion and level range each narrow the list, and combine', () => {
  const N = GDATA.nodes, pick = (f) => N.filter((n) => G.matches(n, f));
  assert.equal(pick({}).length, N.length);
  assert.ok(pick({ jobs: ['Miner'] }).every((n) => n.job === 'Miner') && pick({ jobs: ['Miner'] }).length < N.length);
  assert.equal(pick({ jobs: ['Miner', 'Botanist'] }).length, N.length);
  assert.ok(pick({ kinds: ['legendary'] }).every((n) => n.kind === 'legendary'));
  assert.equal(pick({ expansions: ['Dawntrail'] }).length, 26);
  assert.equal(pick({ expansions: ['Dawntrail', 'Endwalker'] }).length, 54);
  const mid = pick({ minLevel: 80, maxLevel: 90 });
  assert.ok(mid.length > 0 && mid.every((n) => n.level >= 80 && n.level <= 90));
  assert.ok(N.some((n) => n.level === 80) && mid.some((n) => n.level === 80) && mid.some((n) => n.level === 90), 'both ends inclusive');
  const both = pick({ jobs: ['Botanist'], kinds: ['legendary'], expansions: ['Stormblood'], minLevel: 70 });
  assert.deepEqual(both.map((n) => n.id), N.filter((n) => n.job === 'Botanist' && n.kind === 'legendary' && n.expansion === 'Stormblood' && n.level >= 70).map((n) => n.id));
});
test('hide higher: each job is held to its own level, and a job with no level hides nothing', () => {
  const N = GDATA.nodes, pick = (f) => N.filter((n) => G.matches(n, f));
  const f = { hideAbove: true, myLevels: { Miner: 60, Botanist: null } };
  assert.ok(pick(f).filter((n) => n.job === 'Miner').every((n) => n.level <= 60));
  assert.ok(pick(f).some((n) => n.job === 'Miner' && n.level === 60), 'a node at exactly your level stays');
  assert.equal(pick(f).filter((n) => n.job === 'Botanist').length, N.filter((n) => n.job === 'Botanist').length);
  assert.equal(pick({ hideAbove: false, myLevels: { Miner: 50, Botanist: 50 } }).length, N.length, 'the levels do nothing until Hide higher is on');
  assert.equal(pick({ hideAbove: true, myLevels: { Miner: 100, Botanist: 100 } }).length, N.length);
});
test('search and starred: any case, any field, only the starred ids', () => {
  const N = GDATA.nodes, pick = (f) => N.filter((n) => G.matches(n, f));
  assert.deepEqual(pick({ query: '  TURALI alumen ' }).map((n) => n.items[0].name), ['Turali Alumen']);
  assert.ok(pick({ query: 'heavensward' }).every((n) => n.expansion === 'Heavensward') && pick({ query: 'heavensward' }).length === 31);
  assert.ok(pick({ query: 'yok tural' }).every((n) => /Yok Tural/.test(n.folklore || '')));
  const ids = new Set([N[0].id, N[5].id]);
  assert.deepEqual(pick({ starred: ids }).map((n) => n.id).sort(), [...ids].sort());
  assert.equal(pick({ starred: new Set() }).length, 0);
});
test('Next hour: up now ordered by time left, then upcoming by spawn time, nothing else (brute force)', () => {
  for (let i = 0; i < 300; i++) {
    const t = randomTime(), { active, upcoming } = G.schedule(GDATA.nodes, t, HOUR_MS);
    for (let k = 1; k < active.length; k++) assert.ok(active[k - 1].end <= active[k].end);
    for (let k = 1; k < upcoming.length; k++) assert.ok(upcoming[k - 1].start <= upcoming[k].start);
    const inActive = new Set(active.map((e) => e.node.id)), inUpcoming = new Set(upcoming.map((e) => e.node.id));
    for (const n of GDATA.nodes) {
      const s = G.status(n, t);
      assert.equal(inActive.has(n.id), s.up, `${n.id} active`);
      assert.equal(inUpcoming.has(n.id), !s.up && s.start - t <= HOUR_MS, `${n.id} upcoming`);
    }
  }
});
test('Next hour boundary: a spawn exactly 60 minutes away is in, one millisecond later is out', () => {
  const w = G.windows(once, NOW, NOW + 4 * E.SUN).find((x) => x.start > NOW + 2 * HOUR_MS);
  const at = (t) => { const s = G.schedule([once], t, HOUR_MS); return s.active.length ? 'up' : s.upcoming.length ? 'soon' : 'out'; };
  assert.deepEqual([at(w.start - HOUR_MS - 1), at(w.start - HOUR_MS), at(w.start - 1)], ['out', 'soon', 'soon']);
  assert.deepEqual([at(w.start), at(w.end - 1), at(w.end)], ['up', 'up', 'out'], 'up from its first millisecond; gone at its end (next spawn is 64 min away)');
  assert.equal(G.schedule([once], w.start - HOUR_MS, Infinity).upcoming.length, 1);
  assert.equal(G.schedule([once], w.end, Infinity).upcoming.length, 1, 'All nodes has no time limit');
});
test('shorter windows: 15 and 30 minutes hold the same up-now nodes and a subset of the hour', () => {
  for (let i = 0; i < 100; i++) {
    const t = randomTime(), s = (m) => G.schedule(GDATA.nodes, t, m * MIN);
    const [q, h, hr] = [s(15), s(30), s(60)];
    const ids = (x) => x.upcoming.map((e) => e.node.id);
    assert.deepEqual(q.active, hr.active);
    assert.ok(ids(q).every((id) => ids(h).includes(id)) && ids(h).every((id) => ids(hr).includes(id)));
    assert.ok(q.upcoming.every((e) => e.start - t <= 15 * MIN) && h.upcoming.every((e) => e.start - t <= 30 * MIN));
    assert.deepEqual(ids(q), ids(hr).filter((id) => hr.upcoming.find((e) => e.node.id === id).start - t <= 15 * MIN), '15 min is the hour cut at 15 min, same order');
  }
});
test('the schedule cannot change before scheduleChangesAt says it can', () => {
  const key = (t) => { const s = G.schedule(GDATA.nodes, t, HOUR_MS); return JSON.stringify([s.active.map((e) => e.node.id), s.upcoming.map((e) => e.node.id)]); };
  for (let i = 0; i < 40; i++) {
    const t = randomTime(), c = G.scheduleChangesAt(GDATA.nodes, t, HOUR_MS);
    assert.ok(c > t && c - t < HOUR_MS, 'with 189 nodes something changes within the hour');
    const before = key(t);
    for (let k = 1; k <= 8; k++) assert.equal(key(t + Math.floor(((c - 1 - t) * k) / 8)), before);
  }
  const w = G.windows(once, NOW, NOW + 4 * E.SUN).find((x) => x.start > NOW + 2 * HOUR_MS);
  // 64 minutes before w the previous day's window (70 minutes before w, 5 min 50 s long) is over,
  // so the next change is w entering the hour.
  assert.equal(G.scheduleChangesAt([once], w.start - 64 * MIN, HOUR_MS), w.start - HOUR_MS, 'next change is when it enters the hour');
  assert.equal(G.scheduleChangesAt([once], w.start - 2 * HOUR_MS, HOUR_MS), w.start - 70 * MIN, 'earlier, the previous day’s window comes first');
  assert.equal(G.scheduleChangesAt([once], w.start + 1, HOUR_MS), w.end);
});
test('Upcoming: starred nodes that are up now are included, with their end; others are not', () => {
  const w = G.windows(once, NOW, NOW + 2 * E.SUN)[0], other = { ...once, id: 9002 };
  const ev = G.starredEvents([once, other], new Set([once.id]), w.start + 1000, 2 * HOUR_MS);
  assert.deepEqual(ev.up.map((u) => [u.node.id, u.start, u.end]), [[once.id, w.start, w.end]]);
  assert.ok(ev.spawns.every((s) => s.node.id === once.id && s.at > w.start + 1000 && s.at <= w.start + 1000 + 2 * HOUR_MS));
  assert.equal(G.starredEvents([once], new Set([once.id]), w.end, 2 * HOUR_MS).up.length, 0, 'not up at its end');
  const atStart = G.starredEvents([once], new Set([once.id]), w.start, 2 * HOUR_MS);
  assert.ok(atStart.up.length === 1 && !atStart.spawns.some((s) => s.at === w.start), 'a window starting now is up, not upcoming');
  const exact = G.starredEvents([once], new Set([once.id]), w.start - HOUR_MS, HOUR_MS);
  assert.deepEqual(exact.spawns.map((s) => s.at), [w.start], 'a spawn exactly at the end of the span is in');
});
test('every supported node is generated, timed and placed', () => {
  const listed = JSON.parse(readFileSync(join(ROOT, 'data', 'supported-nodes.json'), 'utf8')).nodes.map((n) => n.base);
  assert.deepEqual(GDATA.nodes.map((n) => n.id), listed);
  for (const n of GDATA.nodes) {
    assert.ok(['unspoiled', 'legendary'].includes(n.kind), n.id);
    assert.equal(n.job, ['Mining', 'Quarrying'].includes(n.gathering) ? 'Miner' : 'Botanist', n.id);
    assert.ok(n.times.length >= 1 && n.times.every(([s, d]) => s >= 0 && s < 1440 && d > 0), n.id);
    assert.ok(n.items.length >= 1 && n.coords.every((c) => c >= 1 && c <= 42), n.id);
    assert.ok(n.zone && n.expansion, `${n.id} has a zone`);
    // The wiki: nodes from Heavensward on last 2 bells, A Realm Reborn nodes 3.
    assert.ok(n.times.every(([, d]) => d === (n.expansion === 'A Realm Reborn' ? 180 : 120)), `${n.id} (${n.expansion}) duration`);
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
test('wiki coordinates may be off by 1.5 plus the node\'s spawn radius, and no more', () => {
  const node = { id: 8, zone: 'Elpis', times: [[0, 120]], coords: [20, 20], radius: 100, kind: 'unspoiled', folklore: null, items: [{ name: 'Log', level: 90, stars: 0 }] };
  const allowed = 1.5 + 100 * 41 / 2048; // 3.5
  const at = (dx) => compareGatheringWiki({ rows: [{ item: 'Log', zone: 'Elpis', starts: [0], coords: [20 + dx, 20] }] }, { nodes: [node] }).length;
  assert.deepEqual([at(allowed - 0.05), at(allowed + 0.05), at(-(allowed + 0.05))], [0, 1, 1]);
  assert.equal(at(1.6), 0, 'a radius-100 node allows more than the bare 1.5');
});
test('wiki rows listing one window each must, together, cover every window of the node', () => {
  const node = { id: 7, zone: 'Mor Dhona', times: [[60, 180], [300, 180], [540, 180]], coords: [32, 13], radius: 0, kind: 'unspoiled', folklore: null, items: [{ name: 'Fire Cluster', level: 50, stars: 0 }] };
  const row = (s) => ({ item: 'Fire Cluster', zone: 'Mor Dhona', starts: [s], coords: [32, 13] });
  assert.deepEqual(compareGatheringWiki({ rows: [row(60), row(300), row(540)] }, { nodes: [node] }), []);
  assert.equal(compareGatheringWiki({ rows: [row(60), row(300)] }, { nodes: [node] }).length, 1, 'a missing window is reported');
  assert.equal(compareGatheringWiki({ rows: [row(60), row(300), row(600)] }, { nodes: [node] }).length, 2, 'a wrong window, and the uncovered one');
});
test('js/gathering-data.js is exactly what the generator builds from the cached game tables', () => {
  const cache = join(ROOT, 'tools', '.cache', GDATA.source.commit);
  if (!existsSync(join(cache, 'GatheringPoint.csv'))) { console.log('  (skipped: run node tools/build-gathering.mjs once to cache the game tables)'); return; }
  execFileSync(process.execPath, [join(ROOT, 'tools', 'build-gathering.mjs'), '--check', '--csv', cache], { stdio: 'pipe' });
});

// ---- latest news ----
const N = require('../js/news.js');
const feedFixture = (name) => readFileSync(join(ROOT, 'tests', 'fixtures', name), 'utf8');
const entry = (inner) => `<feed xmlns="http://www.w3.org/2005/Atom"><entry>${inner}</entry></feed>`;
const LINK = 'https://na.finalfantasyxiv.com/lodestone/topics/detail/abc';
test('news: the Lodestone topics and news feeds parse to titles, links, dates and categories', () => {
  const topics = N.parseFeed(feedFixture('lodestone-topics.xml'));
  assert.equal(topics.length, 5);
  assert.deepEqual(topics[0], {
    title: 'Announcing the Fan Festival Group Pose Screenshot Campaign!',
    link: 'https://na.finalfantasyxiv.com/lodestone/topics/detail/378ff35cd6769fc2d8bb0c3dd1003f7b90c9811a',
    dateMs: Date.UTC(2026, 9, 23, 17, 0, 0), category: '',
  });
  assert.equal(topics[1].title, 'Fan Festival 2026 Commemorative Items Round 3 & Sale!', 'entities are decoded');
  const news = N.parseFeed(feedFixture('lodestone-news.xml'));
  assert.deepEqual(news.map((i) => i.category), ['Maintenance', 'Notices', 'Notices', 'Maintenance', 'Maintenance']);
  for (const list of [topics, news]) {
    for (let i = 1; i < list.length; i++) assert.ok(list[i - 1].dateMs >= list[i].dateMs, 'newest first');
    assert.ok(list.every((i) => i.link.startsWith(N.LODESTONE) && !i.link.includes('lds-img')), 'the article link, never the image');
  }
  assert.equal(N.parseFeed(feedFixture('lodestone-news.xml'), 2).length, 2);
  assert.equal(N.parseFeed(feedFixture('lodestone-news.xml')).length, N.PER_FEED);
});
test('news: only https links to the Lodestone are kept, without query or fragment', () => {
  assert.equal(N.cleanLink(`${LINK}?utm_source=x#top`), LINK);
  assert.equal(N.cleanLink(`${LINK}?a=1&amp;b=2`), LINK, 'entities in the feed are decoded');
  for (const bad of ['javascript:alert(1)', 'http://na.finalfantasyxiv.com/lodestone/x', 'https://eu.finalfantasyxiv.com/lodestone/x',
    'https://na.finalfantasyxiv.com.example.com/lodestone/x', 'https://user@na.finalfantasyxiv.com/lodestone/x',
    'https://na.finalfantasyxiv.com:8443/lodestone/x', 'https://na.finalfantasyxiv.com/other/x', 'data:text/html,hi', '', 'not a url']) {
    assert.equal(N.cleanLink(bad), null, bad);
  }
  const items = N.parseFeed(entry(`<title>Bad</title><link rel="alternate" href="javascript:alert(1)"/><published>2026-10-23T00:00:00Z</published>`)
    + entry(`<title>Good</title><link href="${LINK}"/><published>2026-10-22T00:00:00Z</published>`));
  assert.deepEqual(items.map((i) => i.title), ['Good'], 'an entry with a bad link is dropped; a link with no rel is the alternate');
});
test('news: titles are plain text, with plain hyphens and no markup or control characters', () => {
  const [i] = N.parseFeed(entry(`<title>&lt;b&gt;Patch&lt;/b&gt; 7.6 &#8212; Notes &#x2013; Part&#7; 1 \u2014 <![CDATA[<i>Now</i>]]> &amp;amp;</title><link href="${LINK}"/>`));
  assert.equal(i.title, 'Patch 7.6 - Notes - Part 1 - Now &');
  assert.equal(i.dateMs, null, 'a missing date is null, not NaN');
  const long = N.parseFeed(entry(`<title>${'x'.repeat(500)}</title><link href="${LINK}"/>`))[0];
  assert.equal(long.title.length, 200);
  assert.deepEqual(N.parseFeed(entry(`<title>  </title><link href="${LINK}"/>`)), [], 'an empty title is dropped');
  assert.deepEqual(N.parseFeed('<html>not found</html>'), []);
});
test('news: a cached copy is fresh for 15 minutes and is checked again when read back', () => {
  const items = N.parseFeed(feedFixture('lodestone-topics.xml'));
  const cache = { fetchedAt: NOW, feeds: { topics: items, news: [] } };
  assert.deepEqual(N.sanitizeCache(cache), cache);
  assert.equal(N.isFresh(cache, NOW + 15 * MIN - 1), true);
  assert.equal(N.isFresh(cache, NOW + 15 * MIN), false);
  assert.equal(N.isFresh(cache, NOW - 1), false, 'a cache from the future is not trusted');
  const tampered = { fetchedAt: NOW, feeds: { topics: [{ title: 'x', link: 'https://evil.example/' }, { title: 'y', link: LINK, dateMs: 'soon', category: 5 }, null], news: 'no' } };
  assert.deepEqual(N.sanitizeCache(tampered), { fetchedAt: NOW, feeds: { topics: [{ title: 'y', link: LINK, dateMs: null, category: '' }], news: [] } });
  for (const bad of [null, 'x', {}, { fetchedAt: 'now', feeds: {} }, { fetchedAt: NOW, feeds: { topics: [], news: [] } }]) assert.equal(N.sanitizeCache(bad), null);
});

test('news: after a failed round it tries again in 5 s, 15 s, 1 minute, then every 5 minutes', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 9].map(N.retryDelay), [5 * SEC, 15 * SEC, MIN, 5 * MIN, 5 * MIN, 5 * MIN]);
  assert.equal(N.retryDelay(0), 5 * SEC);
  assert.ok(N.RETRY_MS.every((ms) => ms < N.REFRESH_MS), 'every retry comes sooner than the normal refresh');
  assert.equal(N.QUIET_FAILURES, 2);
});
test('news: a round is ok, partial, unavailable (no feeds at this address) or failed', () => {
  const got = { items: [{ title: 'x', link: LINK }] }, missing = { missing: true }, broke = {}, empty = { items: [] };
  for (const passes of [true, false]) {
    assert.equal(N.roundOutcome([got, got], passes), 'ok');
    assert.equal(N.roundOutcome([got, broke], passes), 'partial');
    assert.equal(N.roundOutcome([missing, got], passes), 'partial');
    assert.equal(N.roundOutcome([broke, broke], passes), 'failed');
    assert.equal(N.roundOutcome([missing, broke], passes), 'failed');
    assert.equal(N.roundOutcome([empty, empty], passes), 'failed', 'a page with no entries (a maintenance page) is a failure');
  }
  assert.equal(N.roundOutcome([missing, missing], false), 'unavailable', 'GitHub Pages: no feeds there');
  assert.equal(N.roundOutcome([missing, missing], true), 'failed', 'radmagelabs.com passes them through, so a 404 there is a blip');
});
test('news: maintenance headlines are flagged for 7 days after the Lodestone posts them, newest first, each once', () => {
  const feeds = { topics: N.parseFeed(feedFixture('lodestone-topics.xml')), news: N.parseFeed(feedFixture('lodestone-news.xml')) };
  const newest = Date.UTC(2026, 9, 23, 10, 12, 33), oldest = Date.UTC(2026, 9, 22, 13, 30, 21);
  const titles = (t) => N.maintenance(feeds, t).map((i) => i.title);
  // The saved Notices and maintenance feed has three headlines in the Maintenance category (Oct. 22 and 23).
  assert.deepEqual(titles(Date.UTC(2026, 9, 24)), ['Companion App Emergency Maintenance (Oct. 21): Follow-up 2', 'Forums Emergency Maintenance (Oct. 21): Follow-up',
    'Config Data Sharing Function Emergency Maintenance (Oct. 21-22): Completed']);
  assert.equal(N.MAINTENANCE_MS, 7 * DAY);
  assert.equal(titles(oldest + 7 * DAY - 1).length, 3);
  assert.equal(titles(oldest + 7 * DAY).length, 2, 'seven days after it is posted, a headline is no longer flagged');
  assert.deepEqual(titles(newest + 7 * DAY), []);
  assert.deepEqual(titles(newest - 2 * 3600000).length, 2, 'a headline dated more than an hour ahead of the clock is not flagged yet');
  // Only the Lodestone's own Maintenance category counts, in any case; a title that mentions maintenance is not enough.
  const at = Date.UTC(2026, 9, 24), item = (title, category) => ({ title, link: `${LINK}${title.length}`, dateMs: at - DAY, category });
  assert.deepEqual(N.maintenance({ news: [item('Maintenance Mode Explained', 'Notices'), item('All Worlds Maintenance', 'MAINTENANCE'), item('x', '')] }, at).map((i) => i.title), ['All Worlds Maintenance']);
  const dup = item('Same', 'Maintenance');
  assert.equal(N.maintenance({ topics: [dup], news: [dup] }, at).length, 1, 'the same link in both feeds counts once');
  for (const bad of [null, undefined, {}, { news: null }]) assert.deepEqual(N.maintenance(bad, at), []);
  assert.equal(N.FLAG_FRESH_MS, DAY);
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
  // app.js reads XivResets as it loads. js/ics.js is not loaded with the page: it waits, inert, in the
  // lazy-scripts template (so the build versions it like the rest) until a calendar is first asked for; it
  // reads Eorzea and FfxivFormat, which the page has loaded by then.
  assert.ok(order.indexOf('js/resets.js') >= 0 && order.indexOf('js/resets.js') < order.indexOf('js/app.js'));
  const lazy = /<template id="lazy-scripts">([\s\S]*?)<\/template>/.exec(html);
  assert.ok(lazy && /<script src="js\/ics\.js" data-lazy="ics"><\/script>/.test(lazy[1]), 'js/ics.js waits in the lazy-scripts template');
  const loaded = [...html.replace(lazy[0], '').matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(!loaded.includes('js/ics.js') && loaded.includes('js/eorzea.js') && loaded.includes('js/format.js'), JSON.stringify(loaded));
});
test('the page description counts the zones and nodes the site has', () => {
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const description = html.match(/<meta name="description" content="([^"]*)">/)[1];
  assert.match(description, new RegExp(`\\b${DATA.zones.length} zones\\b`));
  assert.match(description, new RegExp(`\\ball ${GDATA.nodes.length} unspoiled and legendary\\b`));
});
// The newest version heading in the changelog is the version everywhere else.
test('the title, tagline, About and README all say the newest version in the changelog', () => {
  const version = /^## v(\d+\.\d+(?:\.\d+)?) \(\d{4}-\d{2}-\d{2}\)$/m.exec(readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8'))[1];
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  assert.ok(html.includes(`<title>FFXIV Timer v${version} - `), 'title');
  assert.ok(html.includes(`<span class="tagline">v${version} · `), 'tagline');
  assert.ok(html.includes(`<h2 id="about-title">FFXIV Timer v${version}</h2>`), 'About');
  assert.ok(readFileSync(join(ROOT, 'README.md'), 'utf8').startsWith(`# FFXIV Timer v${version}\n`), 'README');
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
      const app = JSON.parse(html.match(/<script type="application\/ld\+json">([^<]*)<\/script>/)[1]);
      assert.equal(app.url, TARGETS.canonical);
      assert.equal(app.description, html.match(/<meta property="og:description" content="([^"]*)">/)[1]);
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

// ---- resets (js/resets.js) ----
// Expected values come from the sources each reset names, checked through the time zone database rather
// than through the engine's own UTC arithmetic: a Lodestone "6:00 p.m. (PST) / 7:00 p.m. (PDT)" must be
// what the start reads in America/Los_Angeles, in standard and in daylight time.
const R = require('../js/resets.js');
const partsIn = (tz, t) => Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', minute: '2-digit', hourCycle: 'h12', timeZoneName: 'short' })
  .formatToParts(t).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
const clockIn = (tz, t) => { const p = partsIn(tz, t); return `${p.weekday} ${p.hour}:${p.minute} ${p.dayPeriod}`; };
/** "6:00 p.m. (PST) / 7:00 p.m. (PDT)" -> { PST: '6:00 PM', PDT: '7:00 PM' }, read from the source text the reset carries. */
function pacificTimes(text) {
  const out = {};
  for (const m of text.matchAll(/(\d{1,2}):(\d\d) (a\.m\.|p\.m\.) \(?(PST|PDT)\)?/g)) out[m[4]] = `${m[1]}:${m[2]} ${m[3] === 'a.m.' ? 'AM' : 'PM'}`;
  return out;
}
/** Every start of a reset from `from` to `to`, by asking for the next one again and again. */
const startsOf = (r, from, to) => { const out = []; for (let t = R.nextStart(r, from); t <= to; t = R.nextStart(r, t)) out.push(t); return out; };
const Y2026 = Date.UTC(2026, 0, 1), Y2029 = Date.UTC(2029, 0, 1);

test('resets: every reset has a safe id, a name, a rule, a certainty and a source; official ones quote a Square Enix page', () => {
  const ids = new Set();
  for (const r of R.RESETS) {
    assert.match(r.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, r.id);
    assert.ok(!ids.has(r.id), `${r.id} twice`); ids.add(r.id);
    assert.ok(r.name && r.about && r.source && ['daily', 'weekly', 'housing'].includes(r.group), r.id);
    assert.ok(['official', 'unverified'].includes(r.certainty), r.id);
    if (r.certainty === 'official') assert.match(r.source, /^the official .*(Lodestone|guide)/, r.id);
    else assert.match(r.source, /community sources/, r.id);
  }
  // The daily reset, Grand Company missions, leves and the housing lottery's dates rest on community sources.
  assert.deepEqual(R.RESETS.filter((r) => r.certainty === 'unverified').map((r) => r.id), ['daily', 'grand-company', 'leves', 'housing-entry', 'housing-results']);
});

test('resets: the 11 data centers the Lodestone lists, each in exactly one Jumbo Cactpot group, and the panel lists one drawing at most', () => {
  assert.deepEqual(R.DATA_CENTERS.map((d) => d.name), ['Aether', 'Crystal', 'Dynamis', 'Primal', 'Chaos', 'Light', 'Materia', 'Elemental', 'Gaia', 'Mana', 'Meteor']);
  for (const dc of R.DATA_CENTERS) assert.equal(R.JUMBO.filter((j) => j.dataCenters.includes(dc.key)).length, 1, dc.key);
  assert.equal(R.JUMBO.flatMap((j) => j.dataCenters).length, 11);
  for (const dc of R.DATA_CENTERS) assert.deepEqual(R.listed(dc.key).filter((r) => r.dataCenter).map((r) => r.id), [`jumbo-cactpot-${dc.key}`]);
  for (const bad of [null, undefined, '', 'Aether', 'toString', 'atlantis']) assert.equal(R.listed(bad).filter((r) => r.dataCenter).length, 0, String(bad));
  assert.deepEqual(R.listed(null).map((r) => r.id), ['daily', 'mini-cactpot', 'grand-company', 'leves', 'weekly', 'housing-entry', 'housing-results']);
});

test('resets: each Jumbo Cactpot drawing reads in Pacific time exactly as the Lodestone states it, before and after every daylight-saving change (2026 to 2028)', () => {
  for (const j of R.JUMBO) {
    const want = pacificTimes(j.lodestone);
    assert.deepEqual(Object.keys(want).sort(), ['PDT', 'PST'], j.lodestone);
    for (const key of j.dataCenters) {
      const r = R.byId(`jumbo-cactpot-${key}`), seen = new Set();
      assert.ok(r.source.includes(j.lodestone), 'the entry quotes the guide');
      const starts = startsOf(r, Y2026, Y2029);
      assert.ok(starts.length >= 156 && starts.length <= 157, `${key}: ${starts.length} weeks`);
      for (const t of starts) {
        const p = partsIn('America/Los_Angeles', t);
        seen.add(p.timeZoneName);
        assert.equal(`${p.weekday} ${p.hour}:${p.minute} ${p.dayPeriod}`, `Sat ${want[p.timeZoneName]}`, `${key} ${new Date(t).toISOString()}`);
      }
      assert.deepEqual([...seen].sort(), ['PDT', 'PST'], 'both standard and daylight time were checked');
    }
  }
});

test('resets: the Mini Cactpot resets every day at the Lodestone\'s 7:00 a.m. (PST) / 8:00 a.m. (PDT)', () => {
  const r = R.byId('mini-cactpot'), want = pacificTimes(r.source);
  assert.deepEqual(want, { PST: '7:00 AM', PDT: '8:00 AM' });
  const starts = startsOf(r, Y2026, Y2029);
  assert.equal(starts.length, 1096);
  for (const t of starts) { const p = partsIn('America/Los_Angeles', t); assert.equal(`${p.hour}:${p.minute} ${p.dayPeriod}`, want[p.timeZoneName], new Date(t).toISOString()); }
});

test('resets: the weekly reset is the patch 7.5 notes\' Tuesday 1:00 a.m. PDT, 8:00 GMT and 18:00 AEST', () => {
  const r = R.byId('weekly'), starts = startsOf(r, Y2026, Y2029);
  assert.ok(r.source.includes('"is reset every Tuesday at 1:00 a.m. PDT (8:00 GMT / 18:00 AEST)"'));
  assert.ok(starts.length >= 156);
  let pdt = 0, gmt = 0;
  for (const t of starts) {
    const la = partsIn('America/Los_Angeles', t), uk = partsIn('Europe/London', t);
    if (la.timeZoneName === 'PDT') { pdt++; assert.equal(clockIn('America/Los_Angeles', t), 'Tue 1:00 AM'); }
    else assert.equal(clockIn('America/Los_Angeles', t), 'Tue 12:00 AM', 'midnight in standard time');
    if (uk.timeZoneName === 'GMT') { gmt++; assert.equal(clockIn('Europe/London', t), 'Tue 8:00 AM'); }
    assert.equal(clockIn('Australia/Brisbane', t), 'Tue 6:00 PM', 'AEST, which has no daylight time');
  }
  assert.ok(pdt > 50 && gmt > 50);
});

test('resets: the community times match the FFXIV wiki\'s table in Japan time (no daylight time): daily 12 a.m., Grand Company 5 a.m., leves 9 a.m. and 9 p.m.', () => {
  const tokyo = (id) => [...new Set(startsOf(R.byId(id), Y2026, Date.UTC(2026, 1, 1)).map((t) => clockIn('Asia/Tokyo', t).replace(/^\w+ /, '')))].sort();
  assert.deepEqual(tokyo('daily'), ['12:00 AM']);
  assert.deepEqual(tokyo('grand-company'), ['5:00 AM']);
  assert.deepEqual(tokyo('leves'), ['9:00 AM', '9:00 PM']);
  assert.equal(startsOf(R.byId('leves'), Y2026, Y2026 + 10 * DAY).length, 20, 'twice a day');
});

test('resets: the housing lottery runs 5 days of entry then 4 of results, turning at 15:00 UTC, on the dates checked', () => {
  const entry = R.byId('housing-entry'), results = R.byId('housing-results');
  // A Lodestone notice ("Issue with the Housing Lottery System (Apr. 16): Follow-up") had set a results period to end on
  // Wednesday, April 20, 2022 at 7:59 a.m. (PDT); news reports (Siliconera) put the next entry period at 8 a.m. PT on May 26.
  assert.equal(R.nextStart(entry, Date.UTC(2022, 3, 20, 14, 59)), Date.UTC(2022, 3, 20, 15, 0));
  assert.equal(clockIn('America/Los_Angeles', Date.UTC(2022, 3, 20, 15, 0)), 'Wed 8:00 AM');
  assert.ok(startsOf(entry, Date.UTC(2022, 4, 1), Date.UTC(2022, 5, 1)).includes(Date.UTC(2022, 4, 26, 15, 0)));
  // PaissaDB, read on 2026-11-17 at 02:03 UTC: the results period lasts until 2026-11-19 15:00 UTC.
  assert.deepEqual(R.lotteryPhase(Date.UTC(2026, 10, 17, 2, 3)), { phase: 'results', start: Date.UTC(2026, 10, 15, 15), end: Date.UTC(2026, 10, 19, 15) });
  // At random moments: the phase holds now, lasts 5 or 4 days, and the next phase starts where it ends.
  for (let i = 0; i < 2000; i++) {
    const t = Math.floor(Date.UTC(2023, 0, 1) + rand() * (Date.UTC(2030, 0, 1) - Date.UTC(2023, 0, 1)));
    const p = R.lotteryPhase(t), q = R.lotteryPhase(p.end);
    assert.ok(p.start <= t && t < p.end);
    assert.equal(p.end - p.start, (p.phase === 'entry' ? 5 : 4) * DAY);
    assert.deepEqual([q.phase, q.start], [p.phase === 'entry' ? 'results' : 'entry', p.end]);
    assert.equal(new Date(p.end).getUTCHours(), 15);
    assert.equal(p.end, R.nextStart(p.phase === 'entry' ? results : entry, t));
  }
});

test('resets: nextStart is the first start strictly after now, against an independent calendar walk (random times and every edge)', () => {
  // Independently of the engine: walk UTC calendar days with Date.UTC and pick the first matching start after t.
  function walk(rule, t) {
    const d = new Date(t), y = d.getUTCFullYear(), m = d.getUTCMonth(), day = d.getUTCDate();
    const found = [];
    for (let k = -1; k <= 8; k++) {
      const midnight = Date.UTC(y, m, day + k);
      if (rule.type === 'daily') for (const mm of rule.minutesUtc) found.push(midnight + mm * MIN);
      if (rule.type === 'weekly' && new Date(midnight).getUTCDay() === rule.weekday) found.push(midnight + rule.minuteUtc * MIN);
    }
    if (rule.type === 'cycle') { let c = rule.anchor + rule.offsetDays * DAY; while (c <= t) c += rule.periodDays * DAY; while (c - rule.periodDays * DAY > t) c -= rule.periodDays * DAY; found.push(c); }
    return Math.min(...found.filter((x) => x > t));
  }
  const times = Array.from({ length: 1500 }, () => Math.floor(Date.UTC(2023, 0, 1) + rand() * (Date.UTC(2032, 0, 1) - Date.UTC(2023, 0, 1))));
  for (const r of R.RESETS) {
    const edges = startsOf(r, Date.UTC(2027, 2, 1), Date.UTC(2027, 3, 1)).flatMap((s) => [s - 1, s, s + 1]);
    for (const t of times.concat(edges)) {
      const next = R.nextStart(r, t);
      assert.ok(next > t, `${r.id} at ${t}`);
      assert.equal(next, walk(r.rule, t), `${r.id} at ${new Date(t).toISOString()}`);
    }
  }
});

test('resets: upcoming holds every start after now up to and including now + span, in time order, ties by id', () => {
  const at15 = Date.UTC(2026, 10, 17, 15), daily = R.byId('daily'), mini = R.byId('mini-cactpot');
  assert.deepEqual(R.upcoming([daily], at15, DAY).map((x) => x.start), [at15 + DAY], 'a start at now is out, one at now + span is in');
  assert.deepEqual(R.upcoming([daily], at15 - 1, DAY).map((x) => x.start), [at15]);
  assert.equal(R.upcoming([daily], at15, 30 * DAY).length, 30);
  assert.deepEqual(R.upcoming([mini, daily], at15 - 1, DAY).map((x) => x.reset.id), ['daily', 'mini-cactpot'], 'the same moment goes by id');
  const all = R.upcoming(R.listed('chaos'), Date.UTC(2027, 2, 10), 30 * DAY);
  for (let i = 1; i < all.length; i++) assert.ok(all[i - 1].start < all[i].start || (all[i - 1].start === all[i].start && all[i - 1].reset.id < all[i].reset.id));
  assert.deepEqual(R.upcoming([], Date.UTC(2027, 2, 10), DAY), []);
});

test('resets: the answers are the same in every time zone, and the engine reads no local time', () => {
  const script = "const R=require('./js/resets.js');const ts=[0,1e12,1761220800000,1795100400000,1999999999999];" +
    "console.log(JSON.stringify(ts.map(t=>[R.RESETS.map(r=>R.nextStart(r,t)),R.lotteryPhase(t),R.upcoming(R.listed('aether'),t,7*864e5).length])))";
  const run = (tz) => execFileSync(process.execPath, ['-e', script], { cwd: ROOT, env: { ...process.env, TZ: tz } }).toString();
  const base = run('UTC');
  for (const tz of ['America/Los_Angeles', 'Asia/Tokyo', 'Australia/Lord_Howe', 'Pacific/Chatham', 'Europe/London']) assert.equal(run(tz), base, tz);
  const src = readFileSync(join(ROOT, 'js', 'resets.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(src, /get(Hours|Minutes|Date|Day|Month|FullYear|TimezoneOffset)\(|toLocale|Intl\.|new Date\(|Date\.now/);
});

// ---- calendar files (js/ics.js) ----
// Its own test file, which also runs alone, run here once per time zone: a file is written in UTC only, so
// every zone must give the same bytes (tests/ics.mjs compares a golden file).
for (const tz of ['America/Chicago', 'Europe/London', 'Asia/Kolkata', 'Australia/Lord_Howe', 'UTC']) {
  test(`js/ics.js: tests/ics.mjs passes in ${tz}`, () => {
    const r = spawnSync(process.execPath, [join(ROOT, 'tests', 'ics.mjs')], { env: { ...process.env, TZ: tz }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const m = /(\d+) passed, 0 failed/.exec(r.stdout);
    assert.ok(m && Number(m[1]) > 0, r.stdout);
  });
}

// ---- Market & Crafting groundwork ----
// Its own test file (its header says what it covers), which also runs alone.
test('market groundwork: tests/market.mjs passes', () => {
  const r = spawnSync(process.execPath, [join(ROOT, 'tests', 'market.mjs')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const m = /(\d+) passed, 0 failed/.exec(r.stdout);
  assert.ok(m && Number(m[1]) > 0, r.stdout);
});

// ---- Market & Crafting's page code ----
// Its own test file too (search and the price client on a fake clock), which also runs alone.
test('market page code: tests/market-app.mjs passes', () => {
  const r = spawnSync(process.execPath, [join(ROOT, 'tests', 'market-app.mjs')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const m = /(\d+) passed, 0 failed/.exec(r.stdout);
  assert.ok(m && Number(m[1]) > 0, r.stdout);
});

// ---- the radmagelabs.com price function ----
// Its own test file too (privacy, cache headers, failures, rate limits), which also runs alone.
test('price function: tests/prices-function.mjs passes', () => {
  const r = spawnSync(process.execPath, [join(ROOT, 'tests', 'prices-function.mjs')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const m = /(\d+) passed, 0 failed/.exec(r.stdout);
  assert.ok(m && Number(m[1]) > 0, r.stdout);
});

// ---- saved settings ----
// Every key the page may keep in localStorage, under ffxiv-timer:v1:. Existing keys are never renamed or
// reshaped (an older page must still read what a newer one saved); a new key is added here on purpose.
const STORAGE_KEYS = ['favorites', 'finder', 'forecastZone', 'gathering', 'hour12', 'news', 'newsOpen', 'nodeFavorites', 'openGroups', 'remindLead', 'resets', 'theme'];
const STORAGE_RESERVED = ['market']; // v0.11.0: market scope, favorites, sort and filters
test('storage: the page keeps only the pinned keys, every one through store.js with a literal name', () => {
  const used = new Set();
  for (const f of readdirSync(join(ROOT, 'js'))) {
    const src = readFileSync(join(ROOT, 'js', f), 'utf8');
    for (const m of src.matchAll(/Store\.(?:read|write)\(\s*'([^']+)'/g)) used.add(m[1]);
    assert.doesNotMatch(src, /Store\.(?:read|write)\(\s*[^'\s]/, `${f}: a key that is not a literal cannot be checked`);
    const code = src.replace(/^\s*\/\/.*$/gm, '');
    if (f !== 'store.js') assert.doesNotMatch(code, /localStorage|sessionStorage|indexedDB|document\.cookie/, `${f} goes around store.js`);
  }
  for (const k of STORAGE_KEYS) assert.ok(used.has(k), `${k} is no longer used: keep reading it, or say why here`);
  for (const k of used) assert.ok(STORAGE_KEYS.includes(k) || STORAGE_RESERVED.includes(k), `${k} is not an allowed key`);
  assert.match(readFileSync(join(ROOT, 'js', 'store.js'), 'utf8'), /const PREFIX = 'ffxiv-timer:v1:';/);
  // The one exception: the theme boot script in index.html reads the theme key before store.js has
  // loaded. It reads that key only and writes nothing.
  const inline = [...readFileSync(join(ROOT, 'index.html'), 'utf8').matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const reads = inline.flatMap((s) => [...s.matchAll(/localStorage\.(\w+)\(([^)]*)\)/g)].map((m) => `${m[1]}(${m[2]})`));
  assert.deepEqual(reads, ["getItem('ffxiv-timer:v1:theme')"]);
  for (const s of inline) assert.doesNotMatch(s.replace(/localStorage\.getItem\('ffxiv-timer:v1:theme'\)/, ''), /localStorage|sessionStorage|indexedDB|document\.cookie/);
});

// ---- light and dark (v0.11.0) ----
// The theme tokens, read from the stylesheet: dark in :root, light overriding them under
// :root[data-theme="light"].
function themeTokens() {
  const css = readFileSync(join(ROOT, 'css', 'style.css'), 'utf8');
  const block = (sel) => {
    const at = css.indexOf(`${sel} {`);
    assert.ok(at >= 0, `no ${sel} block`);
    return Object.fromEntries([...css.slice(at, css.indexOf('}', at)).matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  };
  const dark = block(':root'), lightOnly = block(':root[data-theme="light"]');
  return { css, dark, lightOnly, light: { ...dark, ...lightOnly } };
}
const isColor = (v) => /^(#[0-9a-f]{6}|rgba\([^)]*\))$/i.test(v);

test('theme: every color in the stylesheet is a token; the light theme gives each color token a value of its own and adds no other', () => {
  const { css, dark, lightOnly } = themeTokens();
  const outside = css.split('\n').filter((l) => /#[0-9a-f]{3,8}\b|rgba?\(/i.test(l) && !/^\s*--[\w-]+:/.test(l));
  // ::backdrop sits outside the page's tree, and older browsers give it no custom properties: its two
  // colors are written out (the dark one as the fallback of var(--backdrop)).
  assert.deepEqual(outside.map((l) => l.trim()), [
    'dialog::backdrop { background: var(--backdrop, rgba(4, 7, 14, .7)); }',
    ':root[data-theme="light"] dialog::backdrop { background: rgba(20, 28, 45, .45); }',
  ]);
  assert.equal(dark['--backdrop'], 'rgba(4, 7, 14, .7)');
  assert.equal(lightOnly['--backdrop'], 'rgba(20, 28, 45, .45)');
  for (const k of Object.keys(lightOnly)) assert.ok(k in dark, `${k} is not a dark token`);
  const colors = Object.keys(dark).filter((k) => isColor(dark[k]));
  assert.ok(colors.length >= 50, `${colors.length} color tokens`);
  for (const k of colors) assert.ok(k in lightOnly && lightOnly[k] !== dark[k], `${k} has no light value`);
});

test('theme: the dark colors are exactly v0.10.0\'s, but for the search placeholder (the default look must not change)', () => {
  // The 27 color tokens v0.10.0 had, and the 25 colors it wrote out in rules, now tokens with the same values.
  // The page itself was compared pixel by pixel with v0.10.0 (local/release-checks/theme-shots.mjs).
  // The one change on purpose: the search placeholder, 5 lighter in each channel (v0.10.0 #6f7b94, 4.23:1
  // on its field), so it reaches 4.5:1 with the same hue.
  const CHANGED = { '--placeholder': '#748099' };
  const V0100 = {
    '--bg': '#0b101d', '--bg-2': '#0f1628', '--panel': '#131b2e', '--panel-2': '#18223a', '--line': '#24304b', '--line-2': '#2f3d5e',
    '--text': '#e9edf6', '--muted': '#95a1ba', '--accent': '#e6c46e', '--accent-2': '#f3dc9b', '--focus': '#8fb6ff', '--warn': '#f0c88a',
    '--warn-line': '#6d5531', '--night': '#1b2440', '--day': '#3a3418', '--wx-clear': '#f5c451', '--wx-fair': '#f1d58f', '--wx-clouds': '#a9b5c7',
    '--wx-fog': '#c0c8d3', '--wx-wind': '#7fd6ca', '--wx-rain': '#78b0ff', '--wx-thunder': '#b896ff', '--wx-snow': '#d4ebff', '--wx-dust': '#dcab73',
    '--wx-heat': '#ff9068', '--wx-umbral': '#d08cff', '--wx-other': '#c3c9d6',
    '--glow-gold': 'rgba(230, 196, 110, .07)', '--glow-blue': 'rgba(120, 150, 255, .07)', '--topbar-bg': 'rgba(11, 16, 29, .86)', '--placeholder': '#6f7b94',
    '--gold-wash': 'rgba(230, 196, 110, .06)', '--gold-tint': 'rgba(230, 196, 110, .1)', '--pressed-wash': 'rgba(230, 196, 110, .14)',
    '--pressed-wash-hover': 'rgba(230, 196, 110, .24)', '--now-ring': 'rgba(230, 196, 110, .25)', '--teal-wash': 'rgba(127, 214, 202, .07)',
    '--teal-wash-2': 'rgba(127, 214, 202, .08)', '--warn-wash': 'rgba(240, 200, 138, .1)', '--day-mid': '#4a4220', '--day-text': '#ffe39a',
    '--day-line': '#6c5a24', '--day-wash': 'rgba(230, 196, 110, .12)', '--night-text': '#b9c8ff', '--night-line': '#34437a',
    '--night-wash': 'rgba(120, 150, 255, .12)', '--legendary-text': '#f3dc9b', '--legendary-line': '#6c5a24', '--unspoiled-text': '#9fe3d9',
    '--unspoiled-line': '#2c5e57', '--shadow': 'rgba(0, 0, 0, .45)', '--backdrop': 'rgba(4, 7, 14, .7)',
  };
  const { dark } = themeTokens();
  assert.deepEqual(Object.fromEntries(Object.keys(dark).filter((k) => isColor(dark[k])).map((k) => [k, dark[k]])), { ...V0100, ...CHANGED });
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  assert.match(html, /<meta name="color-scheme" content="dark">/);
  assert.ok(html.includes(`<meta name="theme-color" content="${dark['--bg']}">`), 'theme-color is the dark page color');
});

test('theme: contrast in both themes: text 4.5:1 on every surface it sits on, icons, weather colors and focus 3:1', () => {
  const parse = (c) => {
    let m = /^#([0-9a-f]{6})$/i.exec(c);
    if (m) { const n = parseInt(m[1], 16); return [n >> 16, (n >> 8) & 255, n & 255, 1]; }
    m = /^rgba\(([\d.]+),\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)\)$/.exec(c);
    assert.ok(m, `not a color: ${c}`);
    return [+m[1], +m[2], +m[3], +m[4]];
  };
  const over = (fg, bg) => [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3])).concat(1);
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const { dark, light } = themeTokens();
  const below = {};
  for (const [name, t] of [['dark', dark], ['light', light]]) {
    const c = (k) => parse(t[k]);
    const panel = c('--panel'), bg2 = c('--bg-2');
    const pairs = [];
    for (const s of ['--bg', '--bg-2', '--panel', '--panel-2']) {
      for (const f of ['--text', '--muted', '--accent-2']) pairs.push([`${f} on ${s}`, c(f), c(s), 4.5]);
      pairs.push([`--focus on ${s}`, c('--focus'), c(s), 3]);
    }
    pairs.push(
      ['--accent on --panel (ET label, starred)', c('--accent'), panel, 4.5],
      ['--warn on --panel (time unverified)', c('--warn'), panel, 4.5],
      ['--warn on --warn-wash (maintenance)', c('--warn'), over(c('--warn-wash'), panel), 4.5],
      ['--placeholder on --bg-2', c('--placeholder'), bg2, 4.5],
      ['--bg on --accent (Up now badge)', c('--bg'), c('--accent'), 4.5],
      ['--day-text on --day-wash', c('--day-text'), over(c('--day-wash'), panel), 4.5],
      ['--night-text on --night-wash', c('--night-text'), over(c('--night-wash'), panel), 4.5],
      ['--legendary-text on --gold-tint', c('--legendary-text'), over(c('--gold-tint'), panel), 4.5],
      ['--unspoiled-text on --teal-wash-2', c('--unspoiled-text'), over(c('--teal-wash-2'), panel), 4.5],
      ['--unspoiled-text on --panel (Upcoming)', c('--unspoiled-text'), panel, 4.5],
      ['--accent-2 on --pressed-wash (pressed, on --bg-2)', c('--accent-2'), over(c('--pressed-wash'), bg2), 4.5],
      ['--accent-2 on --pressed-wash (Download, on --panel)', c('--accent-2'), over(c('--pressed-wash'), panel), 4.5],
      ['--text on --gold-wash (starred rows)', c('--text'), over(c('--gold-wash'), panel), 4.5],
      ['--muted on --gold-wash', c('--muted'), over(c('--gold-wash'), panel), 4.5],
      ['--muted on --teal-wash (nodes up now)', c('--muted'), over(c('--teal-wash'), panel), 4.5],
    );
    // Weather chips: the icon in its color on the panel and on the chip (its color at 14 %), the name in --text on the chip.
    for (const k of Object.keys(t).filter((x) => x.startsWith('--wx-'))) {
      const chip = over([...c(k).slice(0, 3), 0.14], panel);
      pairs.push([`${k} icon on --panel`, c(k), panel, 3], [`${k} icon on its chip`, c(k), chip, 3], [`--text on the ${k} chip`, c('--text'), chip, 4.5]);
    }
    assert.ok(pairs.length >= 60, `${name}: ${pairs.length} pairs`);
    for (const [label, fg, bg, min] of pairs) { const r = ratio(fg, bg); if (r < min) below[`${name}: ${label}`] = Math.round(r * 100) / 100; }
  }
  // Nothing below its minimum, in either theme (v0.11.0 lifted the dark search placeholder from 4.23:1).
  assert.deepEqual(below, {});
});

test('theme boot (index.html): a saved "light" applies before the stylesheet; anything else, or blocked storage, stays dark', () => {
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const head = html.slice(0, html.indexOf('</head>'));
  const boot = [...head.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).find((s) => s.includes('data-theme'));
  assert.ok(boot, 'a theme boot script in the head');
  assert.ok(head.indexOf(boot) < head.indexOf('<link rel="stylesheet"'), 'before the stylesheet');
  assert.ok(head.indexOf('<meta name="theme-color"') < head.indexOf(boot), 'after the metas it changes');
  const run = (stored, blocked = false) => {
    const attrs = {}, metas = { 'color-scheme': 'dark', 'theme-color': '#0b101d' }, asked = [];
    vm.runInNewContext(boot, {
      localStorage: { getItem: (k) => { asked.push(k); if (blocked) throw new Error('blocked'); return stored; } },
      document: {
        documentElement: { setAttribute: (k, v) => { attrs[k] = v; } },
        querySelector: (sel) => ({ setAttribute: (k, v) => { assert.equal(k, 'content'); metas[/name="([^"]+)"/.exec(sel)[1]] = v; } }),
      },
    });
    return { attrs, metas, asked };
  };
  const light = run('"light"');
  assert.deepEqual(light.attrs, { 'data-theme': 'light' });
  assert.deepEqual(light.metas, { 'color-scheme': 'light', 'theme-color': themeTokens().light['--bg'] });
  assert.deepEqual(light.asked, ['ffxiv-timer:v1:theme']);
  for (const stored of [null, '"dark"', 'light', '"LIGHT"', '" light"', '1', 'true', '{"theme":"light"}', '["light"]', '', '{']) {
    const r = run(stored);
    assert.deepEqual([r.attrs, r.metas], [{}, { 'color-scheme': 'dark', 'theme-color': '#0b101d' }], `stored ${stored}`);
  }
  assert.deepEqual(run('"light"', true).attrs, {}, 'storage blocked: dark, and no error');
});

// ---- share (v0.11.0) ----
test('share: the canonical address the build declares, plus the current hash exactly, and nothing else', () => {
  assert.equal(F.CANONICAL, TARGETS.canonical);
  assert.equal(F.shareUrl(''), 'https://radmagelabs.com/ffxiv/');
  assert.equal(F.shareUrl('#'), 'https://radmagelabs.com/ffxiv/');
  assert.equal(F.shareUrl(undefined), 'https://radmagelabs.com/ffxiv/');
  for (const hash of ['#zone=eureka-pagos&fz=eureka-anemos&to=gales&bells=8', '#zone=middle-la-noscea&fz=eureka-pagos&prev=fog&to=heat-waves',
    '#zone=kozamauka', '#main', '#market/item/5057', '#zone=the%20black%20shroud']) {
    assert.equal(F.shareUrl(hash), `https://radmagelabs.com/ffxiv/${hash}`, hash);
  }
  assert.equal(F.shareUrl('zone=x'), 'https://radmagelabs.com/ffxiv/', 'only a hash, never a path or query');
  assert.equal(F.shareUrl('?x=1#zone=a'), 'https://radmagelabs.com/ffxiv/');
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
