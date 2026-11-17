// Compares market items from a second extraction of the game data (XIVAPI v2) with the generated
// list. Returns one line per disagreement; empty means they agree.
export function compareMarketXivapi(capture, items) {
  const byId = new Map(items.map((i) => [i.id, i]));
  const problems = [];
  for (const x of capture.items) {
    const ours = byId.get(x.id);
    if (!ours) { problems.push(`${x.id} ${x.name}: in XIVAPI with search category ${x.category}, not in the list`); continue; }
    // The game text of four 7.58 names ends in a space; the list trims it.
    if (ours.name !== x.name.trim()) problems.push(`${x.id}: name "${ours.name}" vs XIVAPI "${x.name}"`);
    if (ours.category !== x.category) problems.push(`${x.id} ${ours.name}: category ${ours.category} vs XIVAPI ${x.category}`);
    if (ours.level !== x.level) problems.push(`${x.id} ${ours.name}: item level ${ours.level} vs XIVAPI ${x.level}`);
    if (ours.hq !== x.hq) problems.push(`${x.id} ${ours.name}: HQ ${ours.hq} vs XIVAPI ${x.hq}`);
    if (x.untradable) problems.push(`${x.id} ${ours.name}: XIVAPI says untradable`);
  }
  return problems;
}
