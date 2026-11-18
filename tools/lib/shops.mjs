// Which items an NPC sells for gil, from the game's own shop tables (the sheets in SHOP_SHEETS, gamedata.mjs).
//
// A gil shop counts only when an NPC opens it: one of the NPC's ENpcBase.ENpcData values is the shop itself, or
// a menu or script that leads to it: TopicSelect (a "what would you like to buy?" menu, Shop[0..9]), PreHandler
// (a gate in front of a handler, Target, which may need UnlockQuest done first), CustomTalk (a scripted talk whose
// ScriptArg values name handlers) and CustomTalkNestHandlers (handlers nested under a CustomTalk). Each kind of
// row has its own id range in the game, so a value is followed only when it is the id of such a row.
//
// Item.PriceMid alone says nothing: the game sets it for every item, sold by a vendor or not. GilShopItem has no
// price of its own; what a gil shop charges is taken to be Item.PriceMid, which these tables cannot confirm, so
// the catalog keeps prices apart from availability and marks them unverified.
//
// A row can still be out of reach for a while or for some players: the shop's own Quest, a seasonal event
// (GilShop.FestivalId), the row's QuestRequired or AchievementRequired, or a PreHandler's UnlockQuest on the way.
// Those are kept as "gated": sold, but not to everyone at every moment. GilShopItem.StateRequired is not used:
// both this export and XIVAPI read 100 there for rows anyone can buy (Copper Ore at the Material Supplier), so its
// meaning is not known.
const num = (v) => Number(v) || 0;
const idOf = (r) => num(String(r['#']).split('.')[0]);

/**
 * The gil shops an NPC opens. Returns Map(shop id -> { npcs, open }), where npcs lists the ENpcBase ids that reach
 * it and open is true when at least one path to it passes no PreHandler unlock quest.
 */
export function reachableGilShops(t) {
  const gil = new Set(t.GilShop.map(idOf));
  const topic = new Map(t.TopicSelect.map((r) => [idOf(r), r]));
  const pre = new Map(t.PreHandler.map((r) => [idOf(r), r]));
  const talk = new Map(t.CustomTalk.map((r) => [idOf(r), r]));
  const nest = new Map();
  for (const r of t.CustomTalkNestHandlers) {
    const parent = idOf(r), h = num(r.NestHandler);
    if (h > 0) { if (!nest.has(parent)) nest.set(parent, []); nest.get(parent).push(h); }
  }
  const handler = (v) => gil.has(v) || topic.has(v) || pre.has(v) || talk.has(v);
  // Where a handler leads: [next id, whether that step needs a quest first].
  function next(v) {
    const out = [];
    if (topic.has(v)) for (let i = 0; i < 10; i++) { const s = num(topic.get(v)[`Shop[${i}]`]); if (handler(s)) out.push([s, false]); }
    if (pre.has(v)) { const r = pre.get(v), s = num(r.Target); if (handler(s)) out.push([s, num(r.UnlockQuest) > 0]); }
    if (talk.has(v)) {
      const r = talk.get(v);
      for (const k of Object.keys(r)) if (k.endsWith('ScriptArg')) { const s = num(r[k]); if (handler(s)) out.push([s, false]); }
      for (const s of nest.get(v) || []) if (handler(s)) out.push([s, false]);
    }
    return out;
  }
  const shops = new Map();
  const columns = Object.keys(t.ENpcBase[0] || {}).filter((k) => /^ENpcData\[\d+\]$/.test(k));
  for (const npc of t.ENpcBase) {
    // Breadth first from this NPC; a handler seen open is not walked again, one seen only gated may be walked
    // again when an open path reaches it.
    const seen = new Map();
    const queue = [];
    for (const k of columns) { const v = num(npc[k]); if (handler(v)) queue.push([v, true]); }
    while (queue.length) {
      const [v, open] = queue.shift();
      const was = seen.get(v);
      if (was === true || (was === false && !open)) continue;
      seen.set(v, open);
      for (const [s, gated] of next(v)) queue.push([s, open && !gated]);
    }
    for (const [v, open] of seen) {
      if (!gil.has(v)) continue;
      const s = shops.get(v) || { npcs: [], open: false };
      s.npcs.push(idOf(npc)); s.open = s.open || open;
      shops.set(v, s);
    }
  }
  return shops;
}

/**
 * Items sold for gil in a shop an NPC opens. Returns Map(item id -> { shops: [shop ids], gated, hq }) where gated
 * is true when every row selling it waits behind a quest, an achievement or a seasonal event, and hq is true when
 * a row sells the high-quality item.
 */
export function gilVendorItems(t, shops = reachableGilShops(t)) {
  const shop = new Map(t.GilShop.map((r) => [idOf(r), r]));
  const items = new Map();
  for (const r of t.GilShopItem) {
    const id = num(r.Item), sid = idOf(r);
    if (id <= 0 || !shops.has(sid)) continue;
    const s = shop.get(sid), reach = shops.get(sid);
    const gated = !reach.open || num(s.Quest) > 0 || num(s.FestivalId) > 0 || num(r['QuestRequired[0]']) > 0
      || num(r['QuestRequired[1]']) > 0 || num(r.AchievementRequired) > 0;
    const e = items.get(id) || { shops: [], gated: true, hq: false };
    if (!e.shops.includes(sid)) e.shops.push(sid);
    e.gated = e.gated && gated;
    e.hq = e.hq || r.IsHQ === 'True';
    items.set(id, e);
  }
  for (const e of items.values()) e.shops.sort((a, b) => a - b);
  return items;
}

/** Every item some GilShopItem row lists, reachable or not (for the investigation report). */
export function listedInAnyGilShop(t) {
  return new Set(t.GilShopItem.map((r) => num(r.Item)).filter((id) => id > 0));
}
