// Browser tests for Crafting (Market & Crafting, v0.12.0). Run with `node tests/smoke-crafting.mjs`; needs Chrome (or
// set CHROME_PATH). `--shots DIR` also saves review screenshots; `--only <text>` runs the tests whose name has it.
//
// Served as in tests/smoke-market.mjs: the deployed build under /ffxiv/ with the price paths next to it answered by
// tests/lib/fake-universalis.mjs, and the GitHub Pages copy. Prices for the recipes checked here are set exactly
// (fake.set), so every total can be worked out by hand. The page clock starts at 2026-11-17 06:30 UTC.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from '../tools/build.mjs';
import { findChrome, launchChrome } from './lib/cdp.mjs';
import { serve } from '../tools/lib/static-server.mjs';
import { fakeUniversalis } from './lib/fake-universalis.mjs';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const Calc = require('../js/craft-calc.js');
const CATALOG = Calc.createCatalog(require('../js/recipes.js'));
const shotsArg = process.argv.indexOf('--shots');
const shots = shotsArg > 0 ? resolve(process.argv[shotsArg + 1]) : null;
if (shots) mkdirSync(shots, { recursive: true });
if (!findChrome()) { console.error('SKIPPED: Chrome not found; set CHROME_PATH to run the browser tests'); process.exit(2); }

let passed = 0, failed = 0;
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const open = [];
async function test(name, fn) {
  if (only && !name.includes(only)) return;
  try { await fn(); passed++; console.log(`ok   ${name}`); } catch (e) { failed++; console.error(`FAIL ${name}\n  ${String(e.message).split('\n').join('\n  ')}`); }
  for (const p of open.splice(0)) await p.close();
}
const newPage = async () => { const p = await chrome.newPage(); open.push(p); return p; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const NOW = Date.parse('2026-11-17T06:30:00Z');
const PREFIX = 'ffxiv-timer:v1:';
const READY = "/^\\d\\d:\\d\\d$/.test(document.getElementById('et-time').textContent) && document.querySelectorAll('#zone-list .zone-row').length > 0";
const MARKET_READY = "typeof XivMarket === 'object' && !!document.getElementById('mk-find')";
const CRAFT_READY = "typeof XivCrafting === 'object' && !!XivCrafting.current && !document.getElementById('mk-craft-view').hidden";
const ITEM_READY = `${CRAFT_READY} && !!document.getElementById('cr-title') && !document.querySelector('.cr-prices[data-state="loading"]')`;
const CRAFT_FILES = /\/(recipes|craft-calc|crafting)\.js|\/crafting\.css/;
const AETHER = { market: { scope: 'dc:aether' } };
const RIVETS = 5091, BRONZE = 5056, COPPER = 5106, TIN = 5107, FIRE = 2, ICE = 3;
const JUICE = 4748, PINEAPPLE = 4816, NODE = 214;

const tmp = mkdtempSync(join(tmpdir(), 'ffxiv-craft-smoke-'));
const pages = build('pages', { outRoot: tmp });
const prices = fakeUniversalis();
const servers = {
  labs: await serve({ mounts: [{ prefix: '/ffxiv/', dir: pages.appDir, notFound: '404.html' }], handlers: [{ prefix: '/ffxiv/prices/', handle: prices.handle }] }),
  github: await serve({ mounts: [{ prefix: '/ffxiv-timer/', dir: pages.appDir, notFound: '404.html' }] }),
};
const LABS = `${servers.labs.origin}/ffxiv/`;
const chrome = await launchChrome();

async function fresh(hash = '', saved = {}, { width = 1440, height = 1000, mobile = false, clock = NOW, base = LABS } = {}) {
  const page = await newPage();
  await page.viewport(width, height, mobile);
  await page.startClockAt(clock);
  await page.goto(base);
  await page.waitFor("document.readyState === 'complete' && /^#zone=/.test(location.hash)");
  await page.eval(`localStorage.clear(); ${Object.entries(saved).map(([k, v]) => `localStorage.setItem(${JSON.stringify(PREFIX + k)}, ${JSON.stringify(JSON.stringify(v))});`).join(' ')} history.replaceState(null, '', location.pathname + ${JSON.stringify(hash)});`);
  await page.reload();
  return page;
}
const click = (page, sel) => page.eval(`document.querySelector(${JSON.stringify(sel)}).click()`);
const text = (page, sel) => page.eval(`(document.querySelector(${JSON.stringify(sel)}) || {}).textContent`);
const change = (page, sel, value) => page.eval(`(() => { const n = document.querySelector(${JSON.stringify(sel)}); n.value = ${JSON.stringify(value)}; n.dispatchEvent(new Event('change', { bubbles: true })); })()`);
const debug = (page) => page.eval('XivCrafting.current.debug()');
const calls = (from = 0) => prices.calls.slice(from).map((c) => `${c.kind} ${c.scope} ${c.ids.join(',')}`);
const saved = (page, key) => page.eval(`JSON.parse(localStorage.getItem(${JSON.stringify(PREFIX + key)}))`);
const noOverflow = (page) => page.eval('document.documentElement.scrollWidth <= window.innerWidth');

// An aggregated result: each side [lowest listing, 4-day average sale, sold a day] (0 or null leaves it out), the
// board seen `ageMin` minutes before the page clock, on Cactuar (79).
function agg(nq, hq = null, ageMin = 30) {
  const at = NOW - ageMin * 60000;
  const both = (v) => ({ dc: v, region: v });
  const side = (s) => (s ? {
    minListing: s[0] ? both({ price: s[0], worldId: 79 }) : {}, recentPurchase: s[1] ? both({ price: s[1], timestamp: at, worldId: 79 }) : {},
    averageSalePrice: s[1] ? both({ price: s[1] }) : {}, dailySaleVelocity: s[2] !== null && s[2] !== undefined ? both({ quantity: s[2] }) : {},
  } : { minListing: {}, recentPurchase: {}, averageSalePrice: {}, dailySaleVelocity: {} });
  return { nq: side(nq), hq: side(hq), worldUploadTimes: [{ worldId: 79, timestamp: at }] };
}
// Bronze Rivets and everything under it, priced so the cheapest plan crafts the ingot: 2 Copper Ore (10) + 1 Tin Ore
// (15) + 1 Fire Shard (3) = 38, against 120 bought; with the rivets' own Fire Shard, 41 for one.
function priceRivets() {
  prices.set(RIVETS, agg([300, 280, 5], [600, 550, 2]));
  prices.set(BRONZE, agg([120, 110, 50], [200, 190, 3]));
  prices.set(COPPER, agg([10, 9, 900], [14, 13, 40]));
  prices.set(TIN, agg([15, 14, 600], [30, 25, 9]));
  prices.set(FIRE, agg([3, 3, 99999]));
  prices.set(ICE, agg([4, 4, 99999]));
}

try {
  await test('files and requests: nothing of Crafting on a timer or Prices visit; the tab loads its four files once; one history entry per tab; Back and Forward', async () => {
    prices.reset();
    const timers = await fresh('');
    await timers.waitFor(READY);
    await sleep(300);
    assert.deepEqual(timers.requests.filter((u) => CRAFT_FILES.test(u) || u.includes('/prices/')), [], 'a timer visit loads nothing of the market');
    const page = await fresh('#market', AETHER);
    await page.waitFor(`${MARKET_READY} && document.querySelectorAll('#mk-watch-list .mk-gil').length >= 8`);
    await sleep(300);
    assert.deepEqual(page.requests.filter((u) => CRAFT_FILES.test(u)), [], 'Prices loads nothing of Crafting');
    assert.equal(prices.calls.length, 1, 'only Market Watch');
    assert.deepEqual(await page.eval("[...document.querySelectorAll('.mk-tab')].map(a => [a.textContent, a.getAttribute('aria-current')])"), [['Prices', 'page'], ['Crafting', null]]);
    const len = await page.eval('history.length');
    const before = servers.labs.requests.length;
    await click(page, '[data-mk-tab="craft"]');
    await page.waitFor(`${CRAFT_READY} && !!document.querySelector('#cr-watch-body .mk-row')`);
    assert.equal(await page.eval('location.hash'), '#market/craft');
    assert.equal(await page.eval('history.length'), len + 1, 'one history entry');
    const files = servers.labs.requests.slice(before).filter((r) => CRAFT_FILES.test(r.path));
    assert.deepEqual(files.map((r) => r.path.replace(/^\/ffxiv\//, '')).sort(), ['css/crafting.css', 'js/craft-calc.js', 'js/crafting.js', 'js/recipes.js']);
    assert.ok(files.every((r) => r.status === 200));
    const stamped = await page.eval("[...document.querySelectorAll('[data-from]')].map(n => n.src || n.href).filter(u => /recipes|craft-calc|crafting/.test(u))");
    assert.ok(stamped.length === 4 && stamped.every((s) => /\?v=[0-9a-f]{10}$/.test(s)), 'with the build\'s version stamps');
    assert.equal(prices.calls.length, 4);
    assert.deepEqual(prices.calls.slice(1).map((c) => c.ids.length).sort((a, b) => b - a), [100, 100, 51], 'Crafting Watch: three fixed batches');
    assert.deepEqual(await page.eval("[document.getElementById('mk-prices-view').hidden, document.getElementById('mk-craft-view').hidden]"), [true, false]);
    assert.deepEqual(await page.eval("[...document.querySelectorAll('#market-jump button')].filter(b => !b.hidden).map(b => b.textContent)"), ['Find a recipe', 'Crafting Watch']);
    await click(page, '[data-mk-tab="prices"]');
    await page.waitFor("!document.getElementById('mk-prices-view').hidden && location.hash === '#market'");
    assert.deepEqual(await page.eval("[...document.querySelectorAll('#market-jump button')].filter(b => !b.hidden).map(b => b.textContent)"), ['Market Watch', 'Favorites', 'Browse']);
    assert.equal(prices.calls.length, 4, 'back on Prices: everything is still current, nothing asked');
    await page.eval('history.back()');
    await page.waitFor(`${CRAFT_READY} && location.hash === '#market/craft'`);
    await page.eval('history.back()');
    await page.waitFor("!document.getElementById('mk-prices-view').hidden && location.hash === '#market'");
    await page.eval('history.forward()');
    await page.waitFor(`${CRAFT_READY}`);
    assert.equal(servers.labs.requests.slice(before).filter((r) => CRAFT_FILES.test(r.path)).length, 4, 'loaded once');
    assert.deepEqual(servers.labs.outside(), []);
    assert.deepEqual(page.problems, []);
  });

  await test('a recipe by its address: one request for its whole tree, sorted; quantity, recipe and buy-or-craft change nothing asked; totals worked out by hand', async () => {
    prices.reset(); priceRivets();
    const page = await fresh(`#market/craft/${RIVETS}`, AETHER);
    await page.waitFor(ITEM_READY);
    assert.deepEqual(calls(), [`aggregated Aether ${[FIRE, ICE, BRONZE, RIVETS, COPPER, TIN].sort((a, b) => a - b).join(',')}`]);
    assert.equal(await text(page, '#cr-title'), 'Bronze Rivets');
    assert.equal(await page.eval('document.activeElement.id'), 'cr-title', 'focus on the recipe');
    let d = (await debug(page)).item;
    assert.deepEqual([d.recipe, d.quantity, d.quality, d.buy, d.cash, d.value, d.perUnit], [5, 1, 'hq', [], { total: 41, missing: 0 }, { total: 41, missing: 0 }, 41]);
    assert.deepEqual(d.materials, [[FIRE, 2, 3, null], [COPPER, 2, 10, null], [TIN, 1, 15, null]], 'in the order first met: the rivets\' own Fire Shard first');
    assert.deepEqual(d.strategies, [['finished', 600, 600, 0], ['direct', 123, 123, 0], ['all', 41, 41, 0], ['cheapest', 41, 41, 0]]);
    assert.deepEqual([d.profit.basis, d.profit.headline.ref, d.profit.headline.profit], ['lower', 550, 509]);
    assert.match(await text(page, '#cr-plan'), /Cheapest plan found/);
    // Ten: one craft each, every material times ten; nothing new asked.
    await change(page, '#cr-qty', '10');
    await page.waitFor("XivCrafting.current.debug().item.quantity === 10");
    d = (await debug(page)).item;
    assert.deepEqual([d.value.total, d.materials.map((m) => m[1])], [410, [20, 20, 10]]);
    // Armorer's recipe: Ice Shards instead, on the ingot too (the same job wherever it can).
    await page.eval("document.querySelector('[data-crecipe=\"171\"]').click()");
    await page.waitFor("XivCrafting.current.debug().item.recipe === 171");
    d = (await debug(page)).item;
    assert.deepEqual([d.value.total, d.materials.map((m) => m[0])], [430, [ICE, COPPER, TIN]]);
    // Buy the ingot after all: your plan, apart from the cheapest; back again.
    await click(page, `[data-cact="${BRONZE}:buy"]`);
    await page.waitFor("XivCrafting.current.debug().item.force.length === 1");
    d = (await debug(page)).item;
    assert.deepEqual([d.buy, d.value.total, d.best], [[BRONZE], 1240, []]);
    assert.deepEqual(d.strategies.map((s) => s[0]), ['finished', 'direct', 'all', 'cheapest', 'yours']);
    assert.match(await text(page, '.cr-tree'), /your choice/);
    await click(page, '[data-creset]');
    await page.waitFor("XivCrafting.current.debug().item.force.length === 0");
    assert.equal(prices.calls.length, 1, 'none of that asked for anything');
    // The ingot's own recipe is under the rivets': already loaded, nothing asked; Refresh asks for its whole set.
    await page.eval(`XivMarket && history.pushState(null, '', '#market/craft/${BRONZE}'); dispatchEvent(new HashChangeEvent('hashchange'))`);
    await page.waitFor(`${ITEM_READY} && document.getElementById('cr-title').textContent === 'Bronze Ingot'`);
    assert.equal(prices.calls.length, 1);
    await click(page, '[data-crefresh]');
    await until(() => prices.calls.length === 2);
    assert.deepEqual(calls(1), [`aggregated Aether ${[FIRE, ICE, BRONZE, COPPER, TIN].sort((a, b) => a - b).join(',')}`]);
    assert.deepEqual(page.problems, []);
  });

  await test('cash and economic cost: owned materials leave You pay only; purchase tax is an assumption, saved; HQ or NQ and HQ materials, saved; nothing saved before a choice', async () => {
    prices.reset(); priceRivets();
    const page = await fresh(`#market/craft/${RIVETS}`, AETHER);
    await page.waitFor(ITEM_READY);
    assert.equal(await saved(page, 'crafting'), null, 'nothing saved yet');
    await page.eval(`document.querySelector('[data-cown="${COPPER}"]').click()`);
    await page.waitFor(`XivCrafting.current.debug().owned.includes(${COPPER})`);
    let d = (await debug(page)).item;
    assert.deepEqual([d.cash.total, d.value.total], [21, 41], 'copper owned: 20 gil less to pay, still worth 20');
    assert.equal(await saved(page, 'crafting'), null, 'owned marks are not saved');
    await change(page, '#cr-tax', '5');
    await page.waitFor('XivCrafting.current.debug().prefs.tax === 5');
    d = (await debug(page)).item;
    assert.ok(Math.abs(d.cash.total - 22.05) < 1e-9 && Math.abs(d.value.total - 42.05) < 1e-9, JSON.stringify([d.cash, d.value]));
    assert.deepEqual(await saved(page, 'crafting'), { tax: 5, quality: 'hq', materials: 'any' });
    assert.match(await text(page, '#cr-tax-note'), /assumption/);
    await click(page, '[data-cquality="nq"]');
    await page.waitFor("XivCrafting.current.debug().item.quality === 'nq'");
    d = (await debug(page)).item;
    assert.deepEqual([d.profit.basis, d.profit.headline.ref], ['lower', 280], 'NQ: its own listing and average');
    await change(page, '#cr-materials', 'hq');
    await page.waitFor("XivCrafting.current.debug().prefs.materials === 'hq'");
    d = (await debug(page)).item;
    assert.deepEqual(d.materials.map((m) => m[2]), [3, 10, 15], 'shards and these ores cannot be HQ in 7.58: still their NQ price');
    assert.ok(Math.abs(d.strategies.find((s) => s[0] === 'direct')[2] - 203 * 1.05) < 1e-9, 'the ingot, which can be HQ, bought HQ (200), with the 5 % set above');
    assert.deepEqual(await saved(page, 'crafting'), { tax: 5, quality: 'nq', materials: 'hq' });
    assert.deepEqual(await saved(page, 'market'), { scope: 'dc:aether' }, 'Prices\' saved settings untouched');
    await page.reload();
    await page.waitFor(ITEM_READY);
    assert.deepEqual((await debug(page)).prefs, { tax: 5, quality: 'nq', materials: 'hq' });
    assert.deepEqual((await debug(page)).owned, [], 'owned marks last only while the page is open');
    assert.deepEqual(page.problems, []);
  });

  await test('shared intermediates and leftovers: added up before rounding, shown in the tree and the list; collapse and expand; copy the list', async () => {
    // Heavy Crowsbeak Hammer: Clove Oil (makes 3) in two branches. Everything craftable is dear to buy and raw
    // materials cheap, so the cheapest plan crafts every step and the oil's third bottle is left over.
    prices.reset();
    for (const id of Calc.priceIds(CATALOG, 2347, () => true)) prices.set(id, agg([CATALOG.craftable(id) ? 5000 : 1, 1, 1]));
    const page = await fresh('#market/craft/2347', AETHER);
    await page.waitFor(ITEM_READY);
    const d = (await debug(page)).item;
    const tree = await text(page, '.cr-tree');
    assert.match(tree, /Clove Oil/);
    assert.match(await text(page, '#cr-list'), /Left over from whole crafts: .*Clove Oil/);
    const opens = await page.eval("[...document.querySelectorAll('.cr-open')].map(b => b.getAttribute('aria-expanded'))");
    assert.ok(opens.length >= 2 && opens.every((v) => v === 'true'));
    const path = await page.eval("document.querySelector('.cr-open').dataset.copen");
    await click(page, '.cr-open');
    await page.waitFor(`document.querySelector('[data-copen="${path}"]').getAttribute('aria-expanded') === 'false' && !document.getElementById('cr-sub-${path}')`);
    await click(page, `[data-copen="${path}"]`);
    await page.waitFor(`!!document.getElementById('cr-sub-${path}')`);
    assert.ok(d.materials.length > 0);
    await page.eval("window.__copied = []; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (t) => { __copied.push(t); return Promise.resolve(); } } });");
    await click(page, '[data-ccopy]');
    await page.waitFor('window.__copied.length === 1');
    const copied = await page.eval('window.__copied[0]');
    assert.match(copied, /^Shopping list for 1 Heavy Crowsbeak Hammer \(FFXIV Timer, Aether\)/);
    assert.match(copied, /Left over: 1 Clove Oil/);
    assert.match(copied, /https:\/\/radmagelabs\.com\/ffxiv\/#market\/craft\/2347$/);
    assert.equal(await text(page, '#cr-copy-status'), 'Copied the shopping list.');
    assert.deepEqual(page.problems, []);
  });

  await test('missing and failed prices: never zero; totals say how many are missing; no profit without a cost; a failed refresh keeps the last good prices', async () => {
    // Fire Shard has no data: every plan needs it, so every total lacks it. (A missing Tin Ore would not do: the
    // cheapest plan would buy the ingot instead, a complete plan.)
    prices.reset(); priceRivets(); prices.empty([FIRE]);
    const page = await fresh(`#market/craft/${RIVETS}`, AETHER);
    await page.waitFor(ITEM_READY);
    let d = (await debug(page)).item;
    assert.deepEqual([d.value, d.perUnit, d.profit.headline], [{ total: 35, missing: 1 }, null, null]);
    assert.deepEqual(d.materials.find((m) => m[0] === FIRE), [FIRE, 2, null, 'empty']);
    assert.match(await text(page, '#cr-list tfoot'), /at least 35 gil 1 price missing/);
    assert.match(await text(page, '.cr-tree'), /no market data/);
    assert.match(await text(page, '.cr-warn'), /not complete/);
    // A refresh that fails: the last good prices stay, the line says what happened.
    prices.reset(); priceRivets();
    // 503 three times (the first try and both retries, 5 and 15 s apart, as the shared price client does).
    prices.failNext({ status: 503, retryAfter: 1 }, 3);
    await click(page, '[data-crefresh]');
    await page.waitFor("document.querySelector('.cr-prices').dataset.state !== 'loading'", 45000);
    d = (await debug(page)).item;
    assert.equal(d.value.total, 35, 'the last good prices stay');
    assert.match(await text(page, '.cr-prices'), /not answering|could not/);
    assert.ok(page.problems.every((p) => /\b503\b/.test(p)), JSON.stringify(page.problems));
    assert.equal(new Set(prices.calls.map((c) => c.ids.join())).size, 1, 'every try the same address: the whole tree');
  });

  await test('not on the board and vendors: Haddock is never asked for and says why; a vendor price is unverified and outside every total; a quest vendor is conditional', async () => {
    prices.reset();
    const page = await fresh('#market/craft/10332', AETHER); // Battered Fish: Haddock is not on the board
    await page.waitFor(ITEM_READY);
    assert.ok(prices.calls.every((c) => !c.ids.includes(12990)), 'Haddock never asked for');
    const tree = await text(page, '.cr-tree');
    assert.match(tree, /Not sold on the market board/);
    assert.match(tree, /The game data lists 4 gilunverified, not used in these totals/);
    assert.equal((await debug(page)).item.value.missing, 1);
    await page.eval("history.pushState(null, '', '#market/craft/5099'); dispatchEvent(new HashChangeEvent('hashchange'))"); // Mythril Rivets: the ingot's vendor needs a quest
    await page.waitFor(`${ITEM_READY} && document.getElementById('cr-title').textContent === 'Mythril Rivets'`);
    await click(page, '[data-cact="5065:buy"]');
    await page.waitFor("/after a quest/.test(document.querySelector('.cr-tree').textContent)");
    assert.match(await text(page, '.cr-tree'), /An NPC sells it after a quest, so whether you can buy it depends on your progress/);
    assert.deepEqual(page.problems, []);
  });

  await test('Crafting Watch: three fixed batches, the same addresses whatever is cached; ranked and thinner data apart; a world shows its data center', async () => {
    prices.reset(); priceRivets();
    const page = await fresh(`#market/craft/${RIVETS}`, AETHER);
    await page.waitFor(ITEM_READY);
    await page.eval("history.pushState(null, '', '#market/craft'); dispatchEvent(new HashChangeEvent('hashchange'))");
    await page.waitFor("!!document.querySelector('#cr-watch-body .mk-row') && !document.querySelector('#cr-watch-prices[data-state=\"loading\"]')");
    const after = calls(1);
    prices.reset();
    const freshPage = await fresh('#market/craft', AETHER);
    await freshPage.waitFor("!!document.querySelector('#cr-watch-body .mk-row') && !document.querySelector('#cr-watch-prices[data-state=\"loading\"]')");
    assert.deepEqual(after.sort(), calls().sort(), 'the same three addresses, whatever this tab held');
    assert.equal(after.length, 3);
    const dbg = await debug(freshPage);
    assert.deepEqual([dbg.watch.outputs, dbg.watch.chunks, dbg.watch.place], [132, [100, 100, 51], 'dc:aether']);
    assert.equal(dbg.watch.groups.reduce((a, b) => a + b, 0), 132);
    assert.match(await text(freshPage, '#cr-watch-text'), /among only the \d+ of 132 items/);
    // A world: its data center's batches, said so.
    prices.reset();
    const world = await fresh('#market/craft', { market: { scope: 'world:79' } });
    await world.waitFor("!!document.querySelector('#cr-watch-body .mk-row') && !document.querySelector('#cr-watch-prices[data-state=\"loading\"]')");
    assert.ok(prices.calls.every((c) => c.scope === 'Aether') && prices.calls.length === 3);
    assert.match(await text(world, '#cr-watch-hint'), /for Cactuar it shows Aether, its data center/);
    assert.deepEqual(world.problems, []);
  });

  await test('timed nodes: the next window from the gathering engine; Show in Timed gathering fills its search and switches with one history entry, saving nothing; a node not listed is explained and nothing changes', async () => {
    prices.reset();
    const page = await fresh(`#market/craft/${JUICE}`, { ...AETHER, gathering: { view: 'hour' } });
    await page.waitFor(ITEM_READY);
    assert.match(await text(page, '.mk-badges'), /Needs at least 318 control/, 'only the minimums that apply');
    assert.doesNotMatch(await text(page, '.mk-badges'), /0 craftsmanship/);
    const tree = await text(page, '.cr-tree');
    assert.match(tree, /Timed node up now: Eastern La Noscea \(\d+\.\d, \d+\.\d\), ends in \d:\d\d/);
    const gatheringBefore = await saved(page, 'gathering');
    const len = await page.eval('history.length');
    await click(page, `[data-cnode="${NODE}:${PINEAPPLE}"]`);
    await page.waitFor("!document.getElementById('timers-view').hidden");
    assert.equal(await page.eval("document.getElementById('node-search').value"), 'Prickly Pineapple');
    assert.equal(await page.eval('history.length'), len + 1);
    assert.equal(await page.eval(`document.activeElement.dataset.nodeStar`), String(NODE));
    assert.deepEqual(await saved(page, 'gathering'), gatheringBefore, 'saved filters untouched');
    await page.eval('history.back()');
    await page.waitFor(`${ITEM_READY} && location.hash === '#market/craft/${JUICE}'`);
    // Six minutes later the node is next up in just over an hour: the 1 hour list leaves it out.
    const later = await fresh(`#market/craft/${JUICE}`, AETHER, { clock: NOW + 6 * 60000 });
    await later.waitFor(ITEM_READY);
    assert.match(await text(later, '.cr-tree'), /Timed node next up .* \(in 1h 0\dm\)/);
    const l2 = await later.eval('history.length');
    await click(later, `[data-cnode="${NODE}:${PINEAPPLE}"]`);
    await later.waitFor("!document.getElementById('cr-notice').hidden");
    assert.match(await text(later, '#cr-notice'), /does not list that node right now/);
    assert.deepEqual([await later.eval("document.getElementById('timers-view').hidden"), await later.eval('history.length'), await later.eval("document.getElementById('node-search').value")], [true, l2, '']);
    assert.deepEqual(page.problems, []);
    assert.deepEqual(later.problems, []);
  });

  await test('notices and links: an unreadable Crafting address, an item no recipe makes, an id not on the board; Prices\' details link to Crafting; Share keeps the address', async () => {
    prices.reset();
    const page = await fresh('#market/craft/x', AETHER);
    await page.waitFor(`${CRAFT_READY} && !document.getElementById('cr-notice').hidden`);
    assert.match(await text(page, '#cr-notice'), /could not be read/);
    await page.eval(`history.pushState(null, '', '#market/craft/${COPPER}'); dispatchEvent(new HashChangeEvent('hashchange'))`);
    await page.waitFor("/No recipe makes Copper Ore/.test(document.getElementById('cr-item').textContent)");
    await page.eval("history.pushState(null, '', '#market/craft/1'); dispatchEvent(new HashChangeEvent('hashchange'))");
    await page.waitFor("/not on the market board/.test(document.getElementById('cr-item').textContent)");
    // From Prices: an item's details, Crafting cost, then Back to the details.
    await page.eval(`history.pushState({ ffxivItem: ${RIVETS} }, '', '#market/item/${RIVETS}'); dispatchEvent(new HashChangeEvent('hashchange'))`);
    await page.waitFor("document.getElementById('mk-item').open");
    await click(page, '.mk-craft-link');
    await page.waitFor(`${ITEM_READY} && location.hash === '#market/craft/${RIVETS}' && !document.getElementById('mk-item').open`);
    await page.eval("window.__shared = []; navigator.share = (d) => { __shared.push(d); return Promise.resolve(); }; navigator.canShare = () => true;");
    await page.eval("document.querySelector('[data-share]').click()");
    await page.waitFor('window.__shared.length === 1');
    assert.equal(await page.eval('window.__shared[0].url'), `https://radmagelabs.com/ffxiv/#market/craft/${RIVETS}`);
    await page.eval('history.back()');
    await page.waitFor("document.getElementById('mk-item').open");
    assert.deepEqual(page.problems, []);
  });

  await test('GitHub Pages: Crafting links to radmagelabs.com and loads nothing', async () => {
    prices.reset();
    const page = await fresh(`#market/craft/${RIVETS}`, {}, { base: `${servers.github.origin}/ffxiv-timer/` });
    await page.waitFor("!document.getElementById('market-boot').hidden");
    assert.match(await text(page, '#market-boot'), new RegExp(`radmagelabs\\.com/ffxiv/#market/craft/${RIVETS}`));
    await sleep(300);
    assert.deepEqual(page.requests.filter((u) => CRAFT_FILES.test(u) || u.includes('/prices/')), []);
    assert.equal(prices.calls.length, 0);
  });

  await test('keyboard: Buy and Craft, the disclosure buttons and the recipe choice work from the keyboard and keep the focus', async () => {
    prices.reset(); priceRivets();
    const page = await fresh(`#market/craft/${RIVETS}`, AETHER);
    await page.waitFor(ITEM_READY);
    await page.eval(`document.querySelector('[data-cact="${BRONZE}:buy"]').focus()`);
    await page.key('Enter');
    await page.waitFor("XivCrafting.current.debug().item.force.length === 1");
    assert.equal(await page.eval('document.activeElement.dataset.cact'), `${BRONZE}:buy`, 'focus stays on the button just used');
    assert.equal(await page.eval(`document.querySelector('[data-cact="${BRONZE}:buy"]').getAttribute('aria-pressed')`), 'true');
    await page.key('Tab');
    await page.eval(`document.querySelector('[data-cact="${BRONZE}:craft"]').focus()`);
    await page.key(' ');
    await page.waitFor(`document.querySelector('[data-cact="${BRONZE}:craft"]').getAttribute('aria-pressed') === 'true'`);
    assert.equal(await page.eval('document.activeElement.dataset.cact'), `${BRONZE}:craft`);
    await page.eval("document.querySelector('[data-crecipe=\"171\"]').focus()");
    await page.key(' ');
    await page.waitFor('XivCrafting.current.debug().item.recipe === 171');
    assert.equal(await page.eval('document.activeElement.dataset.crecipe'), '171');
    const names = await page.eval("[...document.querySelectorAll('#cr-item button, #cr-item a, #cr-item input, #cr-item select')].filter(n => !(n.textContent.trim() || n.getAttribute('aria-label') || (n.labels && n.labels.length) || n.closest('label'))).length");
    assert.equal(names, 0, 'every control has a name');
    assert.deepEqual(page.problems, []);
  });

  for (const theme of ['dark', 'light']) {
    await test(`phones in the ${theme} theme: 320, 360 and 390 px, Crafting home and a recipe, no sideways scroll`, async () => {
      prices.reset(); priceRivets();
      for (const width of [320, 360, 390]) {
        for (const hash of ['#market/craft', `#market/craft/${RIVETS}`]) {
          const page = await fresh(hash, { ...AETHER, theme }, { width, height: 800, mobile: true });
          await page.waitFor(hash === '#market/craft' ? `${CRAFT_READY} && !!document.querySelector('#cr-watch-body .mk-row')` : ITEM_READY);
          assert.ok(await noOverflow(page), `${width} px ${hash}`);
          if (shots && width === 390) await page.screenshot(join(shots, `phone-${theme}-${hash === '#market/craft' ? 'home' : 'recipe'}.png`), true);
          await page.close(); open.splice(open.indexOf(page), 1);
        }
      }
    });
  }

  if (shots) {
    await test('review screenshots (desktop, both themes)', async () => {
      prices.reset(); priceRivets();
      for (const theme of ['dark', 'light']) {
        for (const [name, hash] of [['home', '#market/craft'], ['recipe', `#market/craft/${RIVETS}`], ['shared', '#market/craft/2347'], ['timed', `#market/craft/${JUICE}`]]) {
          const page = await fresh(hash, { ...AETHER, theme });
          await page.waitFor(name === 'home' ? `${CRAFT_READY} && !!document.querySelector('#cr-watch-body .mk-row')` : ITEM_READY);
          await sleep(200);
          await page.screenshot(join(shots, `desktop-${theme}-${name}.png`), true);
          await page.close(); open.splice(open.indexOf(page), 1);
        }
      }
    });
  }
} finally {
  await chrome.close();
  await Promise.all(Object.values(servers).map((s) => s.close()));
  rmSync(tmp, { recursive: true, force: true });
}

async function until(fn, timeout = 8000) {
  const end = Date.now() + timeout;
  while (!fn()) { if (Date.now() > end) throw new Error(`timed out waiting for ${fn}`); await sleep(50); }
}
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
