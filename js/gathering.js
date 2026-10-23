// Timed gathering windows. A node's times are [start, duration] pairs in Eorzean minutes from ET
// midnight; this turns them into real Unix millisecond windows. Pure functions, shared with tests.
(function (root) {
  'use strict';

  const E = typeof module === 'object' && module.exports ? require('./eorzea.js') : root.Eorzea;

  // Every window of `node` that overlaps [from, to), earliest first: { start, end } in real ms,
  // end exclusive. Starts one ET day early so a window running past midnight is not missed.
  function windows(node, from, to) {
    const out = [];
    for (let sun = Math.floor(E.toEorzea(from) / E.ET_SUN) - 1; ; sun++) {
      const dayStart = sun * E.ET_SUN;
      if (E.fromEorzea(dayStart) >= to) break;
      for (const [start, duration] of node.times) {
        const s = E.fromEorzea(dayStart + start * E.ET_MINUTE);
        const e = E.fromEorzea(dayStart + (start + duration) * E.ET_MINUTE);
        if (e > from && s < to) out.push({ start: s, end: e });
      }
    }
    return out.sort((a, b) => a.start - b.start);
  }

  // Whether the node is up at t, with the window it is in or the next one it will be in.
  // Every node appears at least once per ET day, so two suns ahead always holds an answer.
  function status(node, t) {
    const ws = windows(node, t, t + 2 * E.SUN);
    const now = ws.find((w) => w.start <= t && t < w.end);
    if (now) return { up: true, start: now.start, end: now.end };
    const next = ws.find((w) => w.start > t);
    return { up: false, start: next.start, end: next.end };
  }

  // The next `count` windows that start after t.
  function upcoming(node, t, count) {
    const out = [];
    for (let from = t; out.length < count; from += E.SUN) {
      for (const w of windows(node, from, from + E.SUN)) if (w.start > t && !out.some((o) => o.start === w.start)) out.push(w);
    }
    return out.sort((a, b) => a.start - b.start).slice(0, count);
  }

  const Gathering = { windows, status, upcoming };
  if (typeof module === 'object' && module.exports) module.exports = Gathering;
  else root.XivGathering = Gathering;
})(typeof globalThis !== 'undefined' ? globalThis : this);
