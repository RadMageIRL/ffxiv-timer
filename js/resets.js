// Daily and weekly resets, the Cactpot and the housing lottery: fixed schedules in UTC. Pure: every
// function takes real Unix milliseconds and none reads the local time zone, so the page and the Node
// tests share this file; the page shows each answer in the viewer's own time zone.
//
// Each reset says where its time comes from and how sure it is, in the terms js/ics.js uses:
// 'official' when a Square Enix page states the time, 'unverified' when only community sources do (the
// page and calendar entries then say "time unverified"). Sources, read on 2026-11-16:
//   Lodestone Cactpot guide (na.finalfantasyxiv.com/lodestone/playguide/contentsguide/goldsaucer/cactpot/):
//     the Mini Cactpot "resets daily at 7:00 a.m. (PST) / 8:00 a.m. (PDT)", which is 15:00 UTC, and
//     each data center's Jumbo Cactpot drawing, "Every Saturday at ... (PST) / ... (PDT)" (JUMBO below).
//   Patch 7.5 notes (Lodestone, May 2026): reward eligibility "is reset every Tuesday at 1:00 a.m. PDT
//     (8:00 GMT / 18:00 AEST)".
//   Lodestone housing guide: "a 5-day entry period and a 4-day results period", the same on every
//     World; a 2022 Lodestone notice ends a results period at 7:59 a.m. (PDT), so periods turn at
//     15:00 UTC. Which day a cycle starts (an entry period from 2022-05-26 15:00 UTC, every 9 days)
//     rests on community sources and a check of PaissaDB on 2026-11-17, whose results period ran
//     until 2026-11-19 15:00 UTC, as this schedule says.
//   FFXIV wiki, Daily and Weekly Checklist (community): the daily reset at 15:00 GMT, Grand Company
//     missions at 20:00 GMT, and three leve allowances at 00:00 and 12:00 GMT.
(function (root) {
  'use strict';

  const MIN = 60000, HOUR = 3600000, DAY = 86400000, WEEK = 7 * DAY;
  // 1970-01-04, three days after the Unix epoch, was a Sunday.
  const FIRST_SUNDAY = 3 * DAY;
  const floorDiv = (a, n) => Math.floor(a / n);

  /**
   * The first start of a rule strictly after now. Rules:
   *   { type: 'daily', minutesUtc: [900] }               every day at each of these UTC minutes
   *   { type: 'weekly', weekday: 2, minuteUtc: 480 }     weekday 0 is Sunday
   *   { type: 'cycle', anchor, periodDays, offsetDays }  every periodDays from anchor + offsetDays
   */
  function nextOf(rule, now) {
    if (rule.type === 'daily') {
      let best = Infinity;
      for (const m of rule.minutesUtc) {
        const at = m * MIN, t = at + (floorDiv(now - at, DAY) + 1) * DAY;
        if (t < best) best = t;
      }
      return best;
    }
    if (rule.type === 'weekly') {
      const at = FIRST_SUNDAY + rule.weekday * DAY + rule.minuteUtc * MIN;
      return at + (floorDiv(now - at, WEEK) + 1) * WEEK;
    }
    if (rule.type === 'cycle') {
      const at = rule.anchor + rule.offsetDays * DAY, period = rule.periodDays * DAY;
      return at + (floorDiv(now - at, period) + 1) * period;
    }
    return NaN;
  }
  /** The next start of a reset strictly after now (the shape js/ics.js asks a resets engine for). */
  const nextStart = (reset, now) => nextOf(reset.rule, now);
  /** Every start of these resets after now and no later than now + span: [{ reset, start }], in time order (ties by id). */
  function upcoming(resets, now, span) {
    const out = [];
    for (const reset of resets) for (let t = nextStart(reset, now); t <= now + span; t = nextStart(reset, t)) out.push({ reset, start: t });
    return out.sort((a, b) => a.start - b.start || (a.reset.id < b.reset.id ? -1 : a.reset.id > b.reset.id ? 1 : 0));
  }

  // ---- The schedules ----

  const COMMUNITY = 'community sources (the FFXIV wiki\'s Daily and Weekly Checklist)';
  const CACTPOT_GUIDE = 'the official Cactpot guide on the Lodestone';
  const LOTTERY = { anchor: Date.UTC(2022, 4, 26, 15, 0, 0), periodDays: 9, entryDays: 5 };

  /** Data centers, in the order the Lodestone's World Status page lists them. */
  const DATA_CENTERS = [
    ['aether', 'Aether', 'North America'], ['crystal', 'Crystal', 'North America'], ['dynamis', 'Dynamis', 'North America'], ['primal', 'Primal', 'North America'],
    ['chaos', 'Chaos', 'Europe'], ['light', 'Light', 'Europe'],
    ['materia', 'Materia', 'Oceania'],
    ['elemental', 'Elemental', 'Japan'], ['gaia', 'Gaia', 'Japan'], ['mana', 'Mana', 'Japan'], ['meteor', 'Meteor', 'Japan'],
  ].map(([key, name, region]) => ({ key, name, region }));

  /** Jumbo Cactpot drawings as the Cactpot guide lists them, with the same moment in UTC. */
  const JUMBO = [
    { dataCenters: ['elemental', 'gaia', 'mana', 'meteor'], lodestone: 'Every Saturday at 4:00 a.m. (PST) / 5:00 a.m. (PDT)', weekday: 6, minuteUtc: 12 * 60 },
    { dataCenters: ['aether', 'crystal', 'dynamis', 'primal'], lodestone: 'Every Saturday at 6:00 p.m. (PST) / 7:00 p.m. (PDT)', weekday: 0, minuteUtc: 2 * 60 },
    { dataCenters: ['chaos', 'light'], lodestone: 'Every Saturday at 11:00 a.m. (PST) / 12:00 p.m. (PDT)', weekday: 6, minuteUtc: 19 * 60 },
    { dataCenters: ['materia'], lodestone: 'Every Saturday at 1:00 a.m. (PST) / 2:00 a.m. (PDT)', weekday: 6, minuteUtc: 9 * 60 },
  ];

  const RESETS = [
    {
      id: 'daily', name: 'Daily reset', group: 'daily', rule: { type: 'daily', minutesUtc: [15 * 60] }, certainty: 'unverified', source: COMMUNITY,
      about: 'Daily duty roulette bonuses, allied society quests and other daily tasks reset.',
    },
    {
      id: 'mini-cactpot', name: 'Mini Cactpot', group: 'daily', rule: { type: 'daily', minutesUtc: [15 * 60] }, certainty: 'official',
      source: `${CACTPOT_GUIDE}: "resets daily at 7:00 a.m. (PST) / 8:00 a.m. (PDT)"`,
      about: 'Three Mini Cactpot tickets can be bought again at the Gold Saucer.',
    },
    {
      id: 'grand-company', name: 'Grand Company missions', group: 'daily', rule: { type: 'daily', minutesUtc: [20 * 60] }, certainty: 'unverified', source: COMMUNITY,
      about: 'Grand Company supply and provisioning missions change.',
    },
    {
      id: 'leves', name: 'Leve allowances', group: 'daily', rule: { type: 'daily', minutesUtc: [0, 12 * 60] }, certainty: 'unverified', source: COMMUNITY,
      about: 'Three levequest allowances are added, up to 100.',
    },
    {
      id: 'weekly', name: 'Weekly reset', group: 'weekly', rule: { type: 'weekly', weekday: 2, minuteUtc: 8 * 60 }, certainty: 'official',
      source: 'the official patch 7.5 notes on the Lodestone: reward eligibility "is reset every Tuesday at 1:00 a.m. PDT (8:00 GMT / 18:00 AEST)"',
      about: 'Weekly duty rewards and other weekly tasks reset.',
    },
    ...DATA_CENTERS.map((dc) => {
      const j = JUMBO.find((x) => x.dataCenters.includes(dc.key));
      return {
        id: `jumbo-cactpot-${dc.key}`, name: `Jumbo Cactpot drawing (${dc.name})`, group: 'weekly', dataCenter: dc.key,
        rule: { type: 'weekly', weekday: j.weekday, minuteUtc: j.minuteUtc }, certainty: 'official', source: `${CACTPOT_GUIDE}: "${j.lodestone}"`,
        about: `The Jumbo Cactpot drawing for the ${dc.name} data center at the Gold Saucer. Prizes can be claimed for one week after it; each ticket shown to the cashier within an hour of the drawing earns the Early Bird Bonus.`,
        short: 'Prizes can be claimed for a week. Within an hour of the drawing, each ticket earns the Early Bird Bonus.',
      };
    }),
    {
      id: 'housing-entry', name: 'Housing lottery entry period begins', group: 'housing',
      rule: { type: 'cycle', anchor: LOTTERY.anchor, periodDays: LOTTERY.periodDays, offsetDays: 0 }, certainty: 'unverified',
      source: 'the official housing guide (a 5-day entry period, then a 4-day results period, on every World); the dates of the current cycle come from community sources',
      about: 'The 5-day entry period of the housing lottery begins, the same on every World.',
    },
    {
      id: 'housing-results', name: 'Housing lottery results period begins', group: 'housing',
      rule: { type: 'cycle', anchor: LOTTERY.anchor, periodDays: LOTTERY.periodDays, offsetDays: LOTTERY.entryDays }, certainty: 'unverified',
      source: 'the official housing guide (a 5-day entry period, then a 4-day results period, on every World); the dates of the current cycle come from community sources',
      about: 'The 4-day results period of the housing lottery begins: winners can finalize their purchase.',
    },
  ];
  const BY_ID = new Map(RESETS.map((r) => [r.id, r]));
  const byId = (id) => BY_ID.get(id) || null;
  const dataCenter = (key) => DATA_CENTERS.find((d) => d.key === key) || null;

  /** The resets the Resets panel lists, in its order; the Jumbo Cactpot only for a known data center. */
  function listed(dataCenterKey) {
    const dc = dataCenter(dataCenterKey);
    return RESETS.filter((r) => (r.dataCenter ? dc && r.dataCenter === dc.key : true));
  }

  /** The housing lottery at now: { phase: 'entry' | 'results', start, end }, end being when the next phase begins. */
  function lotteryPhase(now) {
    const entry = byId('housing-entry'), results = byId('housing-results');
    const nextEntry = nextStart(entry, now), nextResults = nextStart(results, now);
    return nextResults < nextEntry
      ? { phase: 'entry', start: nextResults - LOTTERY.entryDays * DAY, end: nextResults }
      : { phase: 'results', start: nextEntry - (LOTTERY.periodDays - LOTTERY.entryDays) * DAY, end: nextEntry };
  }

  const Resets = { MIN, HOUR, DAY, WEEK, DATA_CENTERS, JUMBO, RESETS, LOTTERY, byId, dataCenter, listed, nextStart, upcoming, lotteryPhase };
  if (typeof module === 'object' && module.exports) module.exports = Resets;
  else root.XivResets = Resets;
})(typeof globalThis !== 'undefined' ? globalThis : this);
