// Compares js/gathering-data.js with two independent records of the same nodes (see
// tools/verify-gathering.mjs): an XIVAPI capture of the game tables and the wiki's node tables,
// which players keep from what they see in game. Each returns a list of disagreements.

// Reviewed disagreements where the wiki is the one that is wrong. Each names the item, the field
// and why; anything else that disagrees still fails.
export const WIKI_EXCEPTIONS = [
  { item: 'Rarefied White Gold Ore', field: 'coords', reason: 'The wiki gives the two items of this one node different coordinates (34, 8 and 38, 8). The game has one node (GatheringPointBase 1024) with one position, 34.6, 8.3.' },
  { item: 'Rarefied Palm Log', field: 'level', reason: 'The wiki lists level 85, the level of Rarefied Coconut on the same node. Both game-data extractions say 81, and so does the official Lodestone Eorzea Database (Gathering Log: Logging 81, patch 7.57, item a3a3ab08eb5).' },
  { item: 'Rarefied Kelp', field: 'level', reason: 'The wiki lists level 80, the level of Rarefied Coral on the same node. Both game-data extractions and the official Lodestone database (Logging 79, patch 7.57, item 9141a2abb56) say 79; a player comment there places it at Tempest x:37 y:11, 4:00 to 6:00 am/pm, as the game data does.' },
  { item: 'Rarefied Kelp', field: 'stars', reason: 'The wiki gives a star, as for Rarefied Coral on the same node. Both game-data extractions say none. Worth an in-game look.' },
  { item: 'Wattle Petribark', field: 'coords', reason: 'The game puts this node (761) in The Hour of Certain Durance at 5.2, 26.6; the wiki’s own page for that area gives 7.4, 22.3. The node table’s 16, 10 is in another part of Lakeland. Worth an in-game look.' },
  { item: 'Rarefied Raw Petalite', field: 'coords', reason: 'The game puts this node (330) in The Belt at 31.3, 24.2; the wiki’s page for The Belt gives 28.2, 25.4, and the node table says 36, 24. Worth an in-game look.' },
  { item: 'Rarefied Titancopper Ore', field: 'coords', reason: 'Same node (330) as Rarefied Raw Petalite, same disagreement.' },
  { item: 'Beech Branch', field: 'row', reason: 'The wiki lists an unspoiled Beech Branch node in The Fringes. In the patch 7.57 game data Beech Branch is only on regular, untimed nodes in East End (GatheringPointBase 506); no timed node has it. The wiki row may predate a change. Worth an in-game look.' },
  { item: 'Othardian Plum', field: 'coords', reason: 'Game data: 27.2, 16.3. A player comment on the official Lodestone database (item 8f0ce7d700a) says 2:00 AM and PM at about X:27.3, Y:16.0 in The Azim Steppe. The wiki says 23, 16.' },
  { item: 'Gyr Abanian Ore', field: 'coords', reason: 'Game data: 27.4, 30.2. A player comment on the Lodestone database (item 170dc01c270) says x27.7, y30.3, 12 to 2. The wiki says 31, 27.' },
  { item: "Hawk's Eye (Material)", field: 'coords', reason: 'Game data: 10.9, 22.6. A player comment on the Lodestone database (item cb2fa7480eb) says X10.8 Y22.1, 6 to 8 AM and PM. The wiki gives 23, 36, the same numbers as its Chromite Ore row.' },
  { item: 'Chromite Ore', field: 'coords', reason: 'Game data (both extractions): 15.9, 33.9, in Wightrock. The wiki gives 23, 36, which it also gives for Hawk’s Eye. No third report found. Worth an in-game look.' },
  { item: 'Raw Triphane', field: 'stars', reason: 'Game data: two stars. The official Lodestone database (item 7eb9aab7d78) shows Mining 60 with two stars; the wiki shows none.' },
];

const sameSet = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

export function compareGatheringXivapi(capture, data) {
  const problems = [];
  const byId = new Map(capture.nodes.map((n) => [n.id, n]));
  for (const n of data.nodes) {
    const x = byId.get(n.id);
    const where = `node ${n.id} (${n.items.map((i) => i.name).join(', ')})`;
    if (!x) { problems.push(`${where}: not in the XIVAPI capture`); continue; }
    if (x.points < 1) problems.push(`${where}: XIVAPI has no spawn point`);
    if (x.kind !== n.kind) problems.push(`${where}: kind ${n.kind} vs ${x.kind}`);
    if (x.zone !== n.zone || x.area !== n.area) problems.push(`${where}: place ${n.zone}/${n.area} vs ${x.zone}/${x.area}`);
    if (x.gathering !== n.gathering || x.level !== n.level) problems.push(`${where}: ${n.gathering} ${n.level} vs ${x.gathering} ${x.level}`);
    if ((x.folklore || null) !== n.folklore) problems.push(`${where}: folklore ${n.folklore} vs ${x.folklore}`);
    if (JSON.stringify(x.times) !== JSON.stringify(n.times)) problems.push(`${where}: times ${JSON.stringify(n.times)} vs ${JSON.stringify(x.times)}`);
    const mine = n.items.map((i) => [i.name, i.level, i.stars, i.hidden, i.collectable]);
    const theirs = x.items.map((i) => [i.name, i.level, i.stars, i.hidden, i.collectable]);
    if (JSON.stringify(mine) !== JSON.stringify(theirs)) problems.push(`${where}: items ${JSON.stringify(mine)} vs ${JSON.stringify(theirs)}`);
  }
  return problems;
}

// Wiki rows name one item at one node. Every row must land on a supported node with the same zone
// and start times (and, where the wiki gives them, item level, stars and folklore tome), and every
// supported node must be named by at least one row. Coordinates are rounded on the wiki and
// sometimes given per item, so they only have to be within `tolerance`. An item found at several
// nodes (crystal clusters, some folklore items) is matched by zone, then by start times.
// Wiki page titles drop a leading "The" ("Azim Steppe") and disambiguate items that share a name
// with something else ("Hawk's Eye (Material)"); neither is a disagreement about the game.
const sameZone = (a, b) => String(a).replace(/^The /i, '').toLowerCase() === String(b).replace(/^The /i, '').toLowerCase();
const itemNamed = (n, name) => n.items.some((i) => i.name === name);

export function compareGatheringWiki(capture, data, { tolerance = 1.5, exceptions = [] } = {}) {
  const problems = [], named = new Set();
  const excused = (item, field) => exceptions.some((e) => e.item === item && e.field === field);
  const starts = (n) => n.times.map(([s]) => s);
  for (const row of capture.rows) {
    let item = row.item;
    if (!data.nodes.some((n) => itemNamed(n, item))) item = item.replace(/\s+\([^)]*\)$/, '');
    let nodes = data.nodes.filter((n) => itemNamed(n, item));
    if (nodes.length > 1) nodes = nodes.filter((n) => sameZone(n.zone, row.zone));
    if (nodes.length > 1) nodes = nodes.filter((n) => sameSet(row.starts || [], starts(n)));
    if (!nodes.length && excused(row.item, 'row')) continue;
    if (nodes.length !== 1) { problems.push(`wiki ${row.item} (${row.zone} ${row.starts}): ${nodes.length} supported nodes match`); continue; }
    const n = nodes[0], it = n.items.find((i) => i.name === item);
    named.add(n.id);
    if (!sameZone(row.zone, n.zone)) problems.push(`wiki ${row.item}: zone ${row.zone} vs ${n.zone}`);
    if (!sameSet(row.starts, n.times.map(([s]) => s))) problems.push(`wiki ${row.item}: starts ${row.starts} vs ${n.times.map(([s]) => s)}`);
    if (row.coords && !excused(row.item, 'coords')) {
      // A node appears anywhere within its spawn radius; one layout unit is 41/2048 of a map unit.
      const allowed = tolerance + (n.radius || 0) * 41 / 2048;
      const off = Math.max(Math.abs(row.coords[0] - n.coords[0]), Math.abs(row.coords[1] - n.coords[1]));
      if (off > allowed) problems.push(`wiki ${row.item}: coords ${row.coords} vs ${n.coords} (off by ${off.toFixed(1)}, allowed ${allowed.toFixed(1)})`);
    }
    if (row.level != null && row.level !== it.level && !excused(row.item, 'level')) problems.push(`wiki ${row.item}: level ${row.level} vs ${it.level}`);
    if (row.stars != null && row.stars !== it.stars && !excused(row.item, 'stars')) problems.push(`wiki ${row.item}: stars ${row.stars} vs ${it.stars}`);
    if (row.kind && row.kind !== n.kind) problems.push(`wiki ${row.item}: listed as ${row.kind}, data says ${n.kind}`);
    if (row.tome && row.tome !== n.folklore) problems.push(`wiki ${row.item}: tome ${row.tome} vs ${n.folklore}`);
  }
  for (const n of data.nodes) if (!named.has(n.id)) problems.push(`node ${n.id} (${n.items.map((i) => i.name).join(', ')}): no wiki row`);
  return problems;
}
