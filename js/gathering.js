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

  // ---- filtering and ordering for the page ----

  const searchText = (n) => [n.items.map((i) => i.name).join(' '), n.zone, n.area, n.folklore || '',
    n.gathering, n.expansion, n.job, n.kind].join(' ').toLowerCase();

  // Whether a node passes the filters. Every field is optional; an empty list means any.
  //   jobs ['Miner'], kinds ['legendary'], expansions ['Dawntrail'], minLevel 90, maxLevel 100,
  //   hideAbove true with myLevels { Miner: 80, Botanist: null } (a job with no level set hides
  //   nothing), starred (a Set of node ids to keep), query (text, any case).
  function matches(node, f = {}) {
    if (f.jobs && f.jobs.length && !f.jobs.includes(node.job)) return false;
    if (f.kinds && f.kinds.length && !f.kinds.includes(node.kind)) return false;
    if (f.expansions && f.expansions.length && !f.expansions.includes(node.expansion)) return false;
    if (f.minLevel != null && node.level < f.minLevel) return false;
    if (f.maxLevel != null && node.level > f.maxLevel) return false;
    if (f.hideAbove && f.myLevels) {
      const mine = f.myLevels[node.job];
      if (mine != null && node.level > mine) return false;
    }
    if (f.starred && !f.starred.has(node.id)) return false;
    const q = (f.query || '').trim().toLowerCase();
    return !q || searchText(node).includes(q);
  }

  // Nodes up at t, ordered by time left, then nodes not up whose next window starts within
  // `within` ms of t (inclusive), ordered by spawn time. Ties go to the lower node id, so the order
  // is stable. `within` Infinity lists every node.
  function schedule(nodes, t, within = Infinity) {
    const active = [], upcoming = [];
    for (const node of nodes) {
      const s = status(node, t);
      if (s.up) active.push({ node, start: s.start, end: s.end });
      else if (s.start - t <= within) upcoming.push({ node, start: s.start, end: s.end });
    }
    active.sort((a, b) => a.end - b.end || a.node.id - b.node.id);
    upcoming.sort((a, b) => a.start - b.start || a.node.id - b.node.id);
    return { active, upcoming };
  }

  // The next moment after t at which schedule(nodes, ·, within) can change: a node appears or
  // disappears, or a spawn moves inside the window.
  function scheduleChangesAt(nodes, t, within = Infinity) {
    let next = Infinity;
    for (const node of nodes) {
      const s = status(node, t);
      const edge = s.up ? s.end : (s.start - t <= within ? s.start : s.start - within);
      if (edge > t && edge < next) next = edge;
    }
    return next;
  }

  // For the Upcoming panel: starred nodes up at t (ordered by time left) and the windows of starred
  // nodes that start after t and no later than t + span (in time order).
  function starredEvents(nodes, starred, t, span) {
    const up = [], spawns = [];
    for (const node of nodes) {
      if (!starred.has(node.id)) continue;
      const s = status(node, t);
      if (s.up) up.push({ node, start: s.start, end: s.end });
      for (const w of windows(node, t, t + span + 1)) if (w.start > t && w.start <= t + span) spawns.push({ node, at: w.start, end: w.end });
    }
    up.sort((a, b) => a.end - b.end || a.node.id - b.node.id);
    spawns.sort((a, b) => a.at - b.at || a.node.id - b.node.id);
    return { up, spawns };
  }

  const Gathering = { windows, status, upcoming, matches, schedule, scheduleChangesAt, starredEvents };
  if (typeof module === 'object' && module.exports) module.exports = Gathering;
  else root.XivGathering = Gathering;
})(typeof globalThis !== 'undefined' ? globalThis : this);
