// Reads the node tables of the FFXIV wiki's "Unspoiled Nodes" and "Folklore Nodes" pages
// (MediaWiki source) into one row per item per node, for comparison with the game data.
//
// Each page has a section per expansion (===Dawntrail===, ... ===A Realm Reborn===) under a
// ==Botanist== and a ==Miner== heading. Columns are read by their header names, because the
// A Realm Reborn tables have no Level column. A row can describe one item at several nodes, with
// the tome, time, place and coordinates separated by <br>; that becomes one row per node.

const BR = /<br\s*\/?>/i;

// "12:00 AM/PM" -> [0, 720]; "8AM/PM" -> [480, 1200]; "1:00 AM" -> [60]; "3 PM" -> [900].
export function parseTimes(text) {
  const m = String(text).match(/(\d{1,2})(?::(\d\d))?\s*(AM\/PM|AM|PM)/i);
  if (!m) return null;
  const base = (Number(m[1]) % 12) * 60 + Number(m[2] || 0), ap = m[3].toUpperCase();
  return ap === 'AM/PM' ? [base, base + 720] : [ap === 'PM' ? base + 720 : base];
}

const linkTarget = (s) => ((s || '').match(/\[\[([^\]|]+)/) || [])[1]?.trim() || null;
const coordsOf = (s) => {
  const m = (s || '').match(/\{\{coords\|\s*([\d.]+)\s*,\s*([\d.]+)/);
  return m ? [Number(m[1]), Number(m[2])] : null;
};

export function parseWikiTables(page, raw, expansions) {
  const kind = page === 'Folklore Nodes' ? 'legendary' : 'unspoiled';
  const rows = [];
  const parts = raw.split(/^(={2,3})\s*(.+?)\s*\1\s*$/m); // [text, level, name, text, level, name, ...]
  let job = null; // the ==Botanist== or ==Miner== part; ==Fisher== tables are fish, not nodes
  for (let i = 1; i < parts.length; i += 3) {
    if (parts[i] === '==') { job = parts[i + 1]; continue; }
    const expansion = parts[i + 1];
    if (!['Botanist', 'Miner'].includes(job) || !expansions.includes(expansion)) continue;
    const body = parts[i + 2];
    const tableStart = body.indexOf('{|');
    if (tableStart < 0) continue; // a stub section
    const table = body.slice(tableStart).split(/^\|\}/m)[0];
    const header = [], lines = table.split('\n');
    for (const line of lines) if (line.startsWith('!')) header.push(line.slice(1).trim().toLowerCase());
    const col = (...names) => header.findIndex((h) => names.includes(h));
    const c = {
      tome: col('folklore tome'), time: col('time'), item: col('item'), location: col('location'),
      coords: col('coordinate', 'coordinates'), level: col('level'), star: col('star'),
    };
    for (const line of lines) {
      if (!line.startsWith('|') || line.startsWith('|-') || line.startsWith('|}') || !line.includes('{{item icon|')) continue;
      const cells = line.slice(1).split('||').map((s) => s.trim());
      const item = (cells[c.item].match(/\{\{item icon\|([^}|]+)\}\}/) || [])[1]?.trim();
      if (!item) continue;
      // Some cells end with a stray <br>; empty pieces are not entries.
      const split = (k) => (c[k] >= 0 && cells[c[k]] != null ? cells[c[k]].split(BR).map((s) => s.trim()).filter(Boolean) : []);
      const times = split('time'), places = split('location'), coords = split('coords'), tomes = split('tome');
      const n = Math.max(1, times.length, places.length, coords.length, tomes.length);
      const pick = (list, j) => (list.length > 1 ? list[j] : list[0]);
      for (let j = 0; j < n; j++) {
        const row = { page, expansion, kind, item, zone: linkTarget(pick(places, j)), starts: parseTimes(pick(times, j)), coords: coordsOf(pick(coords, j)) };
        if (c.tome >= 0) row.tome = linkTarget(pick(tomes, j));
        if (c.level >= 0) row.level = Number(cells[c.level]) || null;
        if (c.star >= 0) row.stars = ((cells[c.star] || '').match(/★/g) || []).length;
        rows.push(row);
      }
    }
  }
  return rows;
}
