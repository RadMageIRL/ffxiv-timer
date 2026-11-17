// Writes representative calendar files with js/ics.js, for checking with independent iCalendar readers and,
// with the owner's approval only, by importing into throwaway calendars in Google Calendar, Outlook and Apple
// Calendar.
//
//   node tools/calendar-samples.mjs [outDir]     default: local/calendar-samples (kept out of Git)
//
// Next to the files it writes manifest.json: for each file, the entries a reader should find in it (UID,
// start, end, title, location, description, link, status, alarm). Every time comes from the engines the page
// uses; the reset file uses a stand-in with the resets engine's shape (nextStart, upcoming), because that
// engine arrives with the Resets panel in v0.10.0. Nothing here is fetched; the same checkout always writes
// the same bytes.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const Ics = require('../js/ics.js');
const W = require('../js/weather.js');
const G = require('../js/gathering.js');
const D = require('../js/weather-data.js');
const GD = require('../js/gathering-data.js');

const MIN = 60000, HOUR = 3600000, DAY = 86400000;
const at = (iso) => Date.parse(iso);
const zone = (key) => D.zones.find((z) => z.key === key);
const node = (id) => GD.nodes.find((n) => n.id === id);
const wid = (name) => Number(Object.keys(D.weathers).find((id) => D.weathers[id] === name));
const base = { data: { weather: D, gathering: GD }, engines: { weather: W, gathering: G } };
const STARRED = ['middle-la-noscea', 'urqopacha', 'eureka-pagos'].map(zone);
const NODES = [346, 400, 463, 1022, GD.nodes.find((n) => n.job === 'Botanist' && n.kind === 'unspoiled').id].map(node);
const UNVERIFIED = 'Unverified: this time comes from community sources and has not yet been checked in game.';

// The resets stand-in: fixed UTC starts every `every` ms from `first` (daily 15:00, weekly Tuesday 08:00 and the
// Aether Jumbo Cactpot drawing Sunday 02:00 UTC, as the roadmap lists them; the first two are community-sourced).
const RESETS = [
  { id: 'daily', name: 'Daily reset', about: 'Daily duties and allowances reset.', source: 'community sources', certainty: 'unverified', first: at('2026-01-01T15:00:00Z'), every: DAY },
  { id: 'weekly', name: 'Weekly reset', about: 'Weekly duties and allowances reset.', source: 'community sources', certainty: 'unverified', first: at('2026-01-06T08:00:00Z'), every: 7 * DAY },
  { id: 'jumbo-cactpot-aether', name: 'Jumbo Cactpot drawing (Aether)', about: 'The Jumbo Cactpot drawing for the Aether data center.', source: 'the official Gold Saucer guide', certainty: 'official', first: at('2026-01-04T02:00:00Z'), every: 7 * DAY },
];
const resetEngine = {
  nextStart: (r, now) => r.first + Math.max(0, Math.floor((now - r.first) / r.every) + 1) * r.every,
  upcoming: (rs, now, span) => rs.flatMap((r) => { const out = []; for (let t = resetEngine.nextStart(r, now); t <= now + span; t += r.every) out.push({ reset: r, start: t }); return out; }),
};

/** What Upcoming would list at `now`: weather changes in the zones and spawns of the nodes within 2 hours, at most 16. */
function upcomingItems(now, zones, nodes) {
  const items = [];
  for (const z of zones) for (let c = W.nextChange(z, now); c && c.at <= now + 2 * HOUR; c = W.nextChange(z, c.at)) items.push({ at: c.at, zone: z, change: c });
  for (const s of G.starredEvents(nodes, new Set(nodes.map((n) => n.id)), now, 2 * HOUR).spawns) items.push({ at: s.at, node: s.node, window: { start: s.at, end: s.end } });
  return items.sort((a, b) => a.at - b.at).slice(0, 16);
}

const odd = Object.assign({}, zone('middle-la-noscea'), { key: 'odd-zone', name: 'Odd, zone; with \\ backslash, café ★ \u{1F600}\nand a line break', region: 'Region, with; marks' });
const nov = at('2026-11-17T01:00:00Z');
const eln = zone('eastern-la-noscea'), dstSearch = { prev: [wid('Fog')], to: [wid('Showers')], bells: [16] }, dstFrom = at('2027-03-13T12:00:00Z');
const galesSearch = { prev: [], to: [wid('Gales')], bells: [8] };
// Enough nodes for 6 hours to pass the warning but not the limit.
const warnNodes = (() => { for (let k = 1; k <= GD.nodes.length; k++) { const p = Ics.plan({ ...base, source: 'node', range: '6h', now: nov, nodes: GD.nodes.slice(0, k) }); if (p.ok && p.warn) return GD.nodes.slice(0, k); } return null; })();

const SAMPLES = [
  ['1-transition-next-gales-at-08-et.ics', 'Weather transitions: the next "any weather, then Gales, at 08:00 ET" in Eureka Anemos; 10-minute alarm',
    { source: 'transition', range: 'next', now: nov, zone: zone('eureka-anemos'), search: galesSearch, matches: W.findTransitions(zone('eureka-anemos'), { from: nov, ...galesSearch, limit: 10, horizon: 30 * DAY }).matches, alarmMin: 10 }],
  ['2-transitions-10-matches-across-us-and-eu-dst.ics', 'Weather transitions: the 10 matches the finder lists for "Fog, then Showers, at 16:00 ET" in Eastern La Noscea from 2027-03-13 12:00 UTC, across the US (2027-03-14) and EU (2027-03-28) daylight-saving changes; 5-minute alarm',
    { source: 'transition', range: 'shown', now: dstFrom, zone: eln, search: dstSearch, matches: W.findTransitions(eln, { from: dstFrom, ...dstSearch, limit: 10, horizon: 30 * DAY }).matches, alarmMin: 5 }],
  ['3-node-next-legendary-folklore.ics', 'Timed gathering: the next window of a legendary node with a folklore tome, stars and a collectable (Mare Lamentorum); 5-minute alarm',
    { source: 'node', range: 'next', now: nov, nodes: [node(346)], alarmMin: 5 }],
  ['4-five-nodes-next-6-hours.ics', 'Timed gathering: five nodes (miner and botanist, legendary and unspoiled) for the next 6 hours; 15-minute alarm',
    { source: 'node', range: '6h', now: nov, nodes: NODES, alarmMin: 15 }],
  ['5-weather-default-starred-zones-next-6-hours.ics', 'Weather: every change in the three default starred zones for the next 6 hours; no alarm',
    { source: 'weather', range: '6h', now: nov, zones: STARRED }],
  ['6-upcoming-2-hours.ics', 'Upcoming: what it lists over 2 hours (weather changes in the default starred zones and spawns of four nodes, at most 16); 10-minute alarm',
    { source: 'upcoming', range: 'listed', now: nov, items: upcomingItems(nov, STARRED, NODES.slice(0, 4)), alarmMin: 10 }],
  ['7-resets-30-days-across-us-and-eu-dst.ics', 'Resets (stand-in engine): daily and weekly (community-sourced, marked unverified and tentative) and the Aether Jumbo Cactpot (official) for 30 days from 2027-03-10, across both daylight-saving changes; 10-minute alarm',
    { source: 'reset', range: '30d', now: at('2027-03-10T00:00:00Z'), resets: RESETS, engines: { resets: resetEngine }, alarmMin: 10 }],
  ['8-over-the-warning-200-entries.ics', `Timed gathering: the first ${warnNodes ? warnNodes.length : '?'} nodes for 6 hours, enough to pass the 200-entry warning but stay under the 500 limit; no alarm`,
    { source: 'node', range: '6h', now: nov, nodes: warnNodes }],
  ['9-odd-characters.ics', 'Weather: the next change in a renamed copy of Middle La Noscea whose name has commas, a semicolon, a backslash, an accent, a star, an emoji and a line break; 10-minute alarm',
    { source: 'weather', range: 'next', now: nov, zones: [odd], alarmMin: 10 }],
];

/** The entry as a reader should see it after unfolding and unescaping. */
function expected(e, alarmMin) {
  const n = Ics.note(e);
  return {
    uid: `${e.uid}@${Ics.UID_HOST}`,
    start: new Date(e.start).toISOString(), end: new Date(e.end).toISOString(),
    summary: `FFXIV: ${e.summary}${n ? ` (${n})` : ''}`,
    location: e.location ? `${e.location} (FINAL FANTASY XIV)` : null,
    description: [...e.about, ...(e.certainty === 'unverified' ? [UNVERIFIED] : []), ...(e.url ? [`Details: ${e.url}`] : [])].join('\n'),
    url: e.url || null,
    status: n ? 'TENTATIVE' : null,
    alarm: alarmMin ? { minutes: alarmMin, description: `FFXIV: ${e.alarm} in ${alarmMin} minutes` } : null,
  };
}

const out = resolve(process.argv[2] || join(ROOT, 'local', 'calendar-samples'));
mkdirSync(out, { recursive: true });
const manifest = { made: 'node tools/calendar-samples.mjs', module: 'js/ics.js', prodid: Ics.PRODID, files: [] };
for (const [file, what, opts] of SAMPLES) {
  const r = Ics.build({ ...base, ...opts });
  if (!r.ok) throw new Error(`${file}: ${r.reason}`);
  writeFileSync(join(out, file), r.text);
  manifest.files.push({ file, what, now: new Date(opts.now).toISOString(), count: r.count, warn: r.warn, bytes: Buffer.byteLength(r.text), entries: r.entries.map((e) => expected(e, opts.alarmMin || 0)) });
  console.log(`${file}: ${r.count} entr${r.count === 1 ? 'y' : 'ies'}${r.warn ? ' (over the warning)' : ''}, ${Buffer.byteLength(r.text)} bytes`);
}
// The refusal the dialog must show: every node for 6 hours.
const refused = Ics.plan({ ...base, source: 'node', range: '6h', now: nov, nodes: GD.nodes });
manifest.refused = { what: `All ${GD.nodes.length} nodes for 6 hours`, reason: refused.reason, count: refused.count };
console.log(`refused: all ${GD.nodes.length} nodes for 6 hours, ${refused.reason} (${refused.count} entries)`);
writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`-> ${out}`);
