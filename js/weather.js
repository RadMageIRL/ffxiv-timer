// The game's weather forecast. Each zone has a table of [weather, percent] pairs; every eight
// bells the game hashes the time into a number 0..99 and walks the table, accumulating
// percentages, until the running total passes that number. Same inputs everywhere, so the
// forecast is deterministic for every player and every date. Pure functions of real Unix ms.
(function (root) {
  'use strict';

  const E = typeof module === 'object' && module.exports ? require('./eorzea.js') : root.Eorzea;
  const PERIOD = E.WEATHER_PERIOD;

  // The 0..99 roll for the weather period containing real time t. The arithmetic is the game's:
  // unsigned 32-bit throughout. `increment` is the ET hour of the next period boundary, so the
  // period starting 00:00 uses 8, 08:00 uses 16 and 16:00 uses 0 (all with the current sun).
  function forecastTarget(t) {
    if (!(t >= 0)) throw new RangeError('weather is defined from the Unix epoch on');
    const unix = Math.floor(t / 1000);
    const bell = Math.floor(unix / 175);
    const increment = (bell + 8 - (bell % 8)) % 24;
    const totalDays = Math.floor(unix / 4200) >>> 0;
    const base = (Math.imul(totalDays, 100) + increment) >>> 0;
    const step1 = ((base << 11) ^ base) >>> 0;
    const step2 = ((step1 >>> 8) ^ step1) >>> 0;
    return step2 % 100;
  }

  // The weather a zone's table gives for a roll. Tables are checked to sum to 100 when built.
  function pick(zone, target) {
    let total = 0;
    for (const [weather, rate] of zone.rates) {
      total += rate;
      if (target < total) return weather;
    }
    throw new Error(`${zone.name}: weather rates sum to ${total}`);
  }

  function weatherAt(zone, t) { return pick(zone, forecastTarget(t)); }

  // `count` consecutive periods starting with the one containing `from`. Each knows the weather
  // before it, which is what transition conditions ("Rain after Clouds") test.
  function periods(zone, from, count) {
    const out = [];
    let start = E.periodStart(from), previous = weatherAt(zone, start - PERIOD);
    for (let i = 0; i < count; i++, start += PERIOD) {
      const weather = weatherAt(zone, start);
      out.push({ start, end: start + PERIOD, bell: E.clock(start).bell, weather, previous });
      previous = weather;
    }
    return out;
  }

  // The same periods with runs of one weather merged: what a player sees as "Rain until 16:00".
  function spans(zone, from, count) {
    const out = [];
    for (const p of periods(zone, from, count)) {
      const last = out[out.length - 1];
      if (last && last.weather === p.weather) last.end = p.end;
      else out.push({ start: p.start, end: p.end, weather: p.weather });
    }
    return out;
  }

  // The next time after t that the zone's weather actually changes, or null within `limit` periods.
  function nextChange(zone, t, limit = 1000) {
    const now = weatherAt(zone, t);
    let start = E.nextPeriod(t);
    for (let i = 0; i < limit; i++, start += PERIOD) {
      const weather = weatherAt(zone, start);
      if (weather !== now) return { at: start, from: now, to: weather };
    }
    return null;
  }

  // Each weather's total percent in the zone (a weather can appear in the table more than once).
  function odds(zone) {
    const out = new Map();
    for (const [weather, rate] of zone.rates) out.set(weather, (out.get(weather) || 0) + rate);
    return out;
  }

  // Periods from `from` on whose weather is in `to` and whose previous weather is in `previous`
  // (empty or missing means any) and that start at one of `bells` (0, 8, 16; empty means any).
  // Stops after `limit` matches or `horizon` real ms. `possible` is false when a requested
  // weather never occurs in the zone, so "no match" can be told apart from "cannot happen".
  function findTransitions(zone, { from, previous = [], to = [], bells = [], limit = 10, horizon = 30 * 86400000 }) {
    const inZone = odds(zone);
    const possible = previous.concat(to).every((w) => inZone.has(w));
    const matches = [];
    if (!possible) return { matches, possible, searchedUntil: from };
    const prevSet = new Set(previous), toSet = new Set(to), bellSet = new Set(bells);
    const end = from + horizon;
    let start = E.periodStart(from), before = weatherAt(zone, start - PERIOD);
    for (; start < end && matches.length < limit; start += PERIOD) {
      const weather = weatherAt(zone, start);
      const bell = E.clock(start).bell;
      if ((!prevSet.size || prevSet.has(before)) && (!toSet.size || toSet.has(weather)) && (!bellSet.size || bellSet.has(bell))) {
        matches.push({ start, end: start + PERIOD, bell, weather, previous: before });
      }
      before = weather;
    }
    return { matches, possible, searchedUntil: Math.min(start, end) };
  }

  const XivWeather = { PERIOD, forecastTarget, pick, weatherAt, periods, spans, nextChange, odds, findTransitions };
  if (typeof module === 'object' && module.exports) module.exports = XivWeather;
  else root.XivWeather = XivWeather;
})(typeof globalThis !== 'undefined' ? globalThis : this);
