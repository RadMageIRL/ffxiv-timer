// Eorzea Time math. Every function takes real (Earth) Unix milliseconds and none reads the local
// timezone, so results are the same everywhere and the page and the Node tests share this file.
(function (root) {
  'use strict';

  // One bell (Eorzean hour) is 175 real seconds, so one sun (day) of 24 bells is 70 real minutes
  // and Eorzea runs 3600 / 175 = 144 / 7 times faster than real time. ET 00:00 of sun 1, moon 1
  // falls on the Unix epoch: the game's weather code counts bells as unix / 175 and suns as
  // unix / 4200, which only works if the two clocks share that zero.
  const BELL = 175000, SUN = 24 * BELL, MOON = 32 * SUN, YEAR = 12 * MOON;
  const WEATHER_PERIOD = 8 * BELL; // weather can change at 00:00, 08:00 and 16:00 ET
  const ET_MINUTE = 60000, ET_BELL = 60 * ET_MINUTE, ET_SUN = 24 * ET_BELL;
  const SPEED_NUM = 144, SPEED_DEN = 7;

  const mod = (a, n) => ((a % n) + n) % n;

  // Eorzean milliseconds since the epoch. Exact: t * 144 stays far below 2^53 for any date the
  // game can reach, and a true quotient is either an integer or at least 1/7 away from one.
  function toEorzea(t) { return Math.floor((t * SPEED_NUM) / SPEED_DEN); }

  // The first real millisecond at which the Eorzean clock has reached `e`.
  function fromEorzea(e) { return Math.ceil((e * SPEED_DEN) / SPEED_NUM); }

  // The calendar position at real time t. sun is 1..32, moon 1..12; year counts from 0 at the
  // Unix epoch and is a convention, not something the game shows.
  function clock(t) {
    const e = toEorzea(t);
    const totalSuns = Math.floor(e / ET_SUN);
    return {
      bell: mod(Math.floor(e / ET_BELL), 24),
      minute: mod(Math.floor(e / ET_MINUTE), 60),
      second: mod(Math.floor(e / 1000), 60),
      sun: mod(totalSuns, 32) + 1,
      moon: mod(Math.floor(totalSuns / 32), 12) + 1,
      year: Math.floor(totalSuns / 384),
      totalSuns,
    };
  }

  const ordinal = (n) => {
    const tens = n % 100;
    if (tens >= 11 && tens <= 13) return `${n}th`;
    return `${n}${['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;
  };

  // Moons alternate Astral and Umbral: 1st Astral, 1st Umbral, 2nd Astral ... 6th Umbral.
  function moonName(moon) {
    return `${ordinal(Math.ceil(moon / 2))} ${moon % 2 ? 'Astral' : 'Umbral'} Moon`;
  }

  function dateName(c) { return `${ordinal(c.sun)} Sun of the ${moonName(c.moon)}`; }

  const pad2 = (n) => String(n).padStart(2, '0');
  function formatEt(bell, minute) { return `${pad2(bell)}:${pad2(minute)}`; }

  // Day is 06:00 up to 18:00 ET.
  function isDaytime(bell) { return bell >= 6 && bell < 18; }

  // Real start of the bell, sun or weather period containing t, and the next one after it.
  const floorTo = (t, unit) => Math.floor(t / unit) * unit;
  function bellStart(t) { return floorTo(t, BELL); }
  function sunStart(t) { return floorTo(t, SUN); }
  function periodStart(t) { return floorTo(t, WEATHER_PERIOD); }
  function nextBell(t) { return bellStart(t) + BELL; }
  function nextPeriod(t) { return periodStart(t) + WEATHER_PERIOD; }

  // Real time of the next moment at or after t when the clock reads bell:minute:00.
  function nextEtTime(t, bell, minute = 0) {
    if (!(bell >= 0 && bell < 24 && minute >= 0 && minute < 60)) throw new RangeError(`bad ET time ${bell}:${minute}`);
    const offset = Math.ceil(((bell * ET_BELL + minute * ET_MINUTE) * SPEED_DEN) / SPEED_NUM);
    const at = sunStart(t) + offset;
    return at >= t ? at : at + SUN;
  }

  const Eorzea = {
    BELL, SUN, MOON, YEAR, WEATHER_PERIOD, ET_MINUTE, ET_BELL, ET_SUN,
    toEorzea, fromEorzea, clock, moonName, dateName, ordinal, formatEt, isDaytime,
    bellStart, sunStart, periodStart, nextBell, nextPeriod, nextEtTime,
  };
  if (typeof module === 'object' && module.exports) module.exports = Eorzea;
  else root.Eorzea = Eorzea;
})(typeof globalThis !== 'undefined' ? globalThis : this);
