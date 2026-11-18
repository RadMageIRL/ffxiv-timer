// Browser tests for Market & Crafting. Run with `node tests/smoke-market.mjs`; needs Chrome (or set
// CHROME_PATH). `--shots DIR` also saves the review screenshots (desktop and phone, both themes).
//
// The deployed build is served as radmagelabs.com serves it (the page under /ffxiv/ and the price paths
// next to it, answered by tests/lib/fake-universalis.mjs from captured Universalis answers) and as
// GitHub Pages serves it (/ffxiv-timer/, no prices). The page clock starts at 2026-11-17 06:30 UTC, just
// after the captured answers, so their ages read the same on every run.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from '../tools/build.mjs';
import { findChrome, launchChrome } from './lib/cdp.mjs';
import { serve } from '../tools/lib/static-server.mjs';
import { fakeUniversalis } from './lib/fake-universalis.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const shotsArg = process.argv.indexOf('--shots');
const shots = shotsArg > 0 ? resolve(process.argv[shotsArg + 1]) : null;
if (shots) mkdirSync(shots, { recursive: true });
if (!findChrome()) { console.error('SKIPPED: Chrome not found; set CHROME_PATH to run the browser tests'); process.exit(2); }

let passed = 0, failed = 0;
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
// Every tab a test opens is closed when it ends: an open tab of the same site follows the saved place
// and favorites of another (as it should), which would add its requests to the next test's.
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
const MARKET_FILES = /\/(router|market-items|market-catalog|prices|market)\.js|\/market\.css/;
const WATCH_PRICED = "document.querySelectorAll('#mk-watch-list .mk-row .mk-gil').length >= 8";

const tmp = mkdtempSync(join(tmpdir(), 'ffxiv-market-smoke-'));
const pages = build('pages', { outRoot: tmp });
const prices = fakeUniversalis();
const newsRoutes = Object.fromEntries(['topics', 'news'].map((f) => [`/ffxiv/news/${f}.xml`, { file: join(ROOT, 'tests', 'fixtures', `lodestone-${f}.xml`) }]));
const servers = {
  labs: await serve({ mounts: [{ prefix: '/ffxiv/', dir: pages.appDir, notFound: '404.html' }], routes: newsRoutes, handlers: [{ prefix: '/ffxiv/prices/', handle: prices.handle }] }),
  github: await serve({ mounts: [{ prefix: '/ffxiv-timer/', dir: pages.appDir, notFound: '404.html' }] }),
};
const LABS = `${servers.labs.origin}/ffxiv/`;
const chrome = await launchChrome();

// A fresh tab at radmagelabs.com with the given saved settings (key -> value) and the clock set.
async function fresh(hash = '', saved = {}, { width = 1440, height = 1000, mobile = false, clock = NOW } = {}) {
  const page = await newPage();
  await page.viewport(width, height, mobile);
  await page.startClockAt(clock);
  // The settings go in on a plain timer visit; the address is then set without a hashchange and the page
  // loaded again, so it starts from them (a navigation to the same page with a new hash would not reload it).
  await page.goto(LABS);
  await page.waitFor("document.readyState === 'complete' && /^#zone=/.test(location.hash)");
  await page.eval(`localStorage.clear(); ${Object.entries(saved).map(([k, v]) => `localStorage.setItem(${JSON.stringify(PREFIX + k)}, ${JSON.stringify(JSON.stringify(v))});`).join(' ')} history.replaceState(null, '', location.pathname + ${JSON.stringify(hash)});`);
  await page.reload();
  return page;
}
const find = (page, text) => page.eval(`(() => { const f = document.getElementById('mk-find'); f.value = ${JSON.stringify(text)}; f.dispatchEvent(new Event('input')); })()`);
const select = (page, id, value) => page.eval(`(() => { const s = document.getElementById(${JSON.stringify(id)}); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
const click = (page, sel) => page.eval(`document.querySelector(${JSON.stringify(sel)}).click()`);
const text = (page, sel) => page.eval(`(document.querySelector(${JSON.stringify(sel)}) || {}).textContent`);
const saved = (page) => page.eval(`JSON.parse(localStorage.getItem(${JSON.stringify(`${PREFIX}market`)}))`);
const priceCalls = (from = 0) => prices.calls.slice(from).map((c) => `${c.kind} ${c.scope || ''} ${c.ids.length}`.replace('  ', ' '));
const labsRequests = (from = 0) => servers.labs.requests.slice(from);

try {
  await test('pills: Timers & Weather opens as before; Market & Crafting loads its files once, on first open, from this site; one history entry per switch; Back and Forward; the timers keep running', async () => {
    prices.reset();
    const page = await fresh('#zone=eureka-pagos&fz=eureka-anemos&to=gales&bells=8');
    await page.waitFor(READY);
    assert.equal(await page.eval('location.hash'), '#zone=eureka-pagos&fz=eureka-anemos&to=gales&bells=8');
    assert.deepEqual(await page.eval("[...document.querySelectorAll('[data-mode]')].map(b => [b.textContent, b.getAttribute('aria-pressed')])"), [['Timers & Weather', 'true'], ['Market & Crafting', 'false']]);
    assert.deepEqual(page.requests.filter((u) => MARKET_FILES.test(u) || u.includes('/prices/')), [], 'nothing of the market on a timer visit');
    const len = await page.eval('history.length');
    const before = labsRequests().length;
    await click(page, '[data-mode="market"]');
    await page.waitFor(MARKET_READY);
    assert.equal(await page.eval('location.hash'), '#market');
    assert.equal(await page.eval('history.length'), len + 1, 'one history entry');
    assert.deepEqual(await page.eval("[document.getElementById('timers-view').hidden, document.getElementById('market-view').hidden, document.getElementById('timers-jump').hidden, document.getElementById('market-jump').hidden]"), [true, false, true, false]);
    const files = labsRequests(before).filter((r) => MARKET_FILES.test(r.path));
    assert.deepEqual(files.map((r) => r.path.replace(/^\/ffxiv\//, '')).sort(), ['css/market.css', 'js/market-catalog.js', 'js/market-items.js', 'js/market.js', 'js/prices.js', 'js/router.js']);
    assert.ok(files.every((r) => r.status === 200));
    const stamped = await page.eval("[...document.scripts].map(s => s.src).concat([...document.querySelectorAll('link[rel=stylesheet]')].map(l => l.href)).filter(u => /router|market|prices/.test(u))");
    assert.equal(stamped.length, 6);
    assert.ok(stamped.every((s) => /\?v=[0-9a-f]{10}$/.test(s)), 'with the build\'s version stamps');
    assert.deepEqual(priceCalls(), [], 'no place chosen yet: no price asked for');
    // The timers run on underneath: the local clock in the hidden view still ticks.
    const t1 = await text(page, '#local-time');
    await sleep(1200);
    assert.notEqual(await text(page, '#local-time'), t1);
    // Back to Timers & Weather: its own address, rebuilt from what it shows.
    await click(page, '[data-mode="timers"]');
    await page.waitFor(`!document.getElementById('timers-view').hidden && ${READY}`);
    assert.equal(await page.eval('location.hash'), '#zone=eureka-pagos&fz=eureka-anemos&to=gales&bells=8');
    assert.equal(await page.eval('history.length'), len + 2);
    await page.eval('history.back()');
    await page.waitFor("!document.getElementById('market-view').hidden && location.hash === '#market'");
    await page.eval('history.back()');
    await page.waitFor("!document.getElementById('timers-view').hidden && location.hash.startsWith('#zone=eureka-pagos&fz=eureka-anemos')");
    assert.equal(await page.eval("document.getElementById('finder-zone').value"), 'eureka-anemos', 'the transition search as it was');
    await page.eval('history.forward()');
    await page.waitFor("!document.getElementById('market-view').hidden");
    assert.equal(labsRequests(before).filter((r) => MARKET_FILES.test(r.path)).length, 6, 'loaded once');
    assert.deepEqual(servers.labs.outside(), []);
    assert.deepEqual(page.problems, []);
  });

  await test('first visit: asks for a data center, prefilled from Resets but not saved until chosen; Market Watch then comes in one request', async () => {
    prices.reset();
    const page = await fresh('#market', { resets: { dataCenter: 'crystal', starred: [], remindLead: null } });
    await page.waitFor(`${MARKET_READY} && !document.getElementById('mk-ask').hidden`);
    assert.equal(await page.eval("document.getElementById('mk-ask-dc').value"), 'dc:crystal');
    assert.equal(await page.eval("document.getElementById('mk-ask-from').hidden"), false);
    assert.equal(await saved(page), null, 'nothing saved yet');
    assert.match(await text(page, '#mk-watch-list .mk-row'), /choose a place/);
    await sleep(500);
    assert.deepEqual(priceCalls(), []);
    await click(page, '#mk-ask-go');
    await page.waitFor(WATCH_PRICED);
    assert.deepEqual(priceCalls(), ['aggregated Crystal 75'], 'Market Watch and favorites in one request');
    assert.equal((await saved(page)).scope, 'dc:crystal');
    assert.equal(await page.eval("document.getElementById('mk-ask').hidden"), true);
    assert.equal(await page.eval('document.activeElement.id'), 'mk-find', 'on to the search');
    // A group of Market Watch shows from what is already loaded: no request.
    await click(page, '[data-mk-watch="1"]');
    await page.waitFor("document.querySelector('#mk-watch-list .mk-name').textContent.includes('Materia')");
    assert.equal(prices.calls.length, 1);
    await page.reload();
    await page.waitFor(`${MARKET_READY} && document.getElementById('mk-ask').hidden && ${WATCH_PRICED}`);
    assert.equal(await page.eval("document.getElementById('mk-scope').value"), 'dc:crystal', 'remembered');
    assert.deepEqual(page.problems, []);
  });

  await test('search and details: results in budget, NQ and HQ apart, listings apart from completed sales, the data\'s age first; Back closes, Forward reopens, focus returns', async () => {
    prices.reset();
    const page = await fresh('#market', { market: { scope: 'dc:aether' } });
    await page.waitFor(`${MARKET_READY} && ${WATCH_PRICED}`);
    const c0 = prices.calls.length;
    await find(page, 'ingot');
    await page.waitFor("document.querySelectorAll('#mk-results .mk-row').length === 50 && document.querySelectorAll('#mk-results .mk-gil').length > 0");
    await sleep(400);
    // One request for the 50 shown, less any Market Watch already loaded (Double Duraluminum Ingot, say).
    const shownIds = await page.eval("[...document.querySelectorAll('#mk-results .mk-row')].map(r => Number(r.dataset.id))");
    const asked0 = prices.calls.slice(c0);
    assert.equal(asked0.length, 1, JSON.stringify(priceCalls(c0)));
    assert.ok(asked0[0].ids.length >= 40 && asked0[0].ids.every((id) => shownIds.includes(id)));
    assert.match(await text(page, '#mk-count'), /^\d+ items match "ingot"\.$/);
    await click(page, '#mk-more');
    await page.waitFor("document.querySelectorAll('#mk-results .mk-row').length > 50");
    await page.waitFor("[...document.querySelectorAll('#mk-results .mk-row')].every(r => !/loading/.test(r.textContent))");
    const more = prices.calls.slice(c0 + 1);
    assert.equal(more.length, 1, 'one more request');
    assert.ok(more[0].ids.every((id) => !shownIds.includes(id)), 'only for the newly shown ones');
    // Typing fast asks for nothing until it stops; Enter applies at once.
    const c1 = prices.calls.length;
    for (const q of ['i', 'ir', 'iro', 'iron', 'iron ', 'iron i', 'iron in']) { await find(page, q); await sleep(30); }
    await page.eval("document.getElementById('mk-find').value = 'iron ingot'; document.getElementById('mk-find').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))");
    await page.waitFor("document.querySelector('#mk-results .mk-name') && document.querySelector('#mk-results .mk-name').textContent === 'Iron Ingot'");
    await sleep(600);
    assert.ok(prices.calls.length - c1 <= 2, `typing asked ${prices.calls.length - c1} times`);
    // Listing age is the upload time Universalis gives for the world with the lowest listing (Cactuar,
    // 04:23:59 UTC in the captured answer), not when this page fetched the price (a moment ago).
    await page.waitFor("document.querySelector('#mk-results [data-id=\"5057\"] .mk-age')");
    assert.equal(await text(page, '#mk-results [data-id="5057"] .mk-age'), '2 hours ago');
    assert.equal(await page.eval("document.querySelector('#mk-results-wrap .mk-head-row span:last-child').textContent"), 'Listing age');
    assert.equal(await text(page, '#mk-results [data-id="5057"] .mk-upd .visually-hidden'), 'Listing age: ');
    await page.waitFor("/^Prices in Aether\\./.test(document.getElementById('mk-prices-text').textContent)");
    assert.equal(await text(page, '#mk-prices-text'), 'Prices in Aether. Listing age is how long ago Universalis last received the market board of the world with the lowest listing shown, not the newest upload anywhere in Aether.');
    assert.equal(await page.eval("document.querySelector('#mk-results [data-id=\"5057\"] .mk-age').dataset.at"), String(Date.parse('2026-11-17T04:23:59.351Z')));
    // Details.
    const len = await page.eval('history.length');
    await page.eval("document.querySelector('#mk-results .mk-name').focus(); document.querySelector('#mk-results .mk-name').click()");
    await page.waitFor("document.getElementById('mk-item').open && document.querySelectorAll('#mk-item .mk-book table').length === 2");
    assert.equal(await page.eval('location.hash'), '#market/item/5057');
    assert.equal(await page.eval('history.length'), len + 1);
    assert.equal(await text(page, '#mk-item-title'), 'Iron Ingot');
    assert.match(await text(page, '#mk-item .mk-age-line strong'), /^Market data for Aether: updated \d+ hours? ago \(/);
    assert.deepEqual(await page.eval("[...document.querySelectorAll('#mk-item .mk-side h3')].map(h => h.textContent)"), ['NQ (normal quality)', 'HQ (high quality)']);
    assert.deepEqual(await page.eval("[...document.querySelectorAll('#mk-item .mk-book h3')].map(h => h.textContent.replace(/\\(.*\\)/, '()'))"), ['For sale now: listings ()', 'Sold recently: completed sales']);
    // Each table is named by its heading, for screen readers that list tables.
    assert.deepEqual(await page.eval("[...document.querySelectorAll('#mk-item .mk-book table')].map(t => (document.getElementById(t.getAttribute('aria-labelledby')) || {}).textContent.split(':')[0])"), ['For sale now', 'Sold recently']);
    assert.match(await text(page, '#mk-item .mk-stat-min .mk-stat-v'), /^50 gil$/);
    assert.ok(prices.calls.some((c) => c.kind === 'item' && c.scope === 'Aether' && c.ids[0] === 5057));
    assert.ok(!prices.calls.some((c) => c.kind === 'tax'), 'no tax request at data center scope');
    const listingText = await text(page, '#mk-item .mk-book:first-of-type tbody');
    assert.doesNotMatch(listingText, /retainer|buyer|crafter/i);
    // Escape closes it: back to #market, focus on the name that opened it.
    await page.key('Escape');
    await page.waitFor("!document.getElementById('mk-item').open && location.hash === '#market'");
    assert.equal(await page.eval("document.activeElement.getAttribute('data-mkkey')"), 'name:5057');
    await page.eval('history.forward()');
    await page.waitFor("document.getElementById('mk-item').open && location.hash === '#market/item/5057'");
    await page.eval('history.back()');
    await page.waitFor("!document.getElementById('mk-item').open && location.hash === '#market'");
    assert.deepEqual(page.problems, []);
  });

  await test('places: a world adds its tax rates and a world level; a region; the place can change from the details; the saved place follows', async () => {
    prices.reset();
    const page = await fresh('#market/item/5057', { market: { scope: 'dc:aether' } });
    await page.waitFor("document.getElementById('mk-item') && document.getElementById('mk-item').open && document.querySelectorAll('#mk-item .mk-book table').length === 2");
    await page.eval("(() => { const s = document.querySelector('#mk-item [data-mk-scope]'); s.value = 'world:63'; s.dispatchEvent(new Event('change', { bubbles: true })); })()");
    await page.waitFor("document.querySelectorAll('#mk-item .mk-tax li').length === 8");
    assert.ok(prices.calls.some((c) => c.kind === 'item' && c.scope === 'Gilgamesh'));
    assert.ok(prices.calls.some((c) => c.kind === 'tax' && c.ids[0] === 63));
    assert.deepEqual(await page.eval("[...document.querySelectorAll('#mk-item .mk-table tbody th')].map(t => t.textContent)"), ['Gilgamesh', 'Aether (data center)', 'North America (region)']);
    assert.match(await text(page, '#mk-item .mk-tax'), /Limsa Lominsa5%/);
    assert.equal((await saved(page)).scope, 'world:63');
    assert.equal(await page.eval("document.getElementById('mk-scope').value"), 'world:63', 'the page follows');
    // One world: the listing age is that world's.
    await page.waitFor("/^Prices in Gilgamesh\\./.test(document.getElementById('mk-watch-text').textContent)");
    assert.equal(await text(page, '#mk-watch-text'), "Prices in Gilgamesh. Listing age is how long ago Universalis last received Gilgamesh's market board.");
    await page.key('Escape');
    await page.waitFor("!document.getElementById('mk-item').open");
    assert.equal(await page.eval('location.hash'), '#market', 'opened by a link: closing goes to #market');
    await select(page, 'mk-scope', 'region:north-america');
    await page.waitFor(WATCH_PRICED);
    assert.ok(prices.calls.some((c) => c.kind === 'aggregated' && c.scope === 'North-America'));
    assert.match(await text(page, '#mk-scope-note'), /^Every data center in North America/);
    assert.deepEqual(page.problems, []);
  });

  // Found in WebKit (Phase 3): Safari does not focus what is clicked, so closing the details lost the
  // place. A script click does not focus either, so it stands in for Safari here.
  await test('details opened by a click that leaves focus where it was (Safari): Escape returns focus to the item clicked', async () => {
    prices.reset();
    const page = await fresh('#market', { market: { scope: 'dc:aether' } });
    await page.waitFor(`${MARKET_READY} && ${WATCH_PRICED}`);
    const key = await page.eval("document.querySelectorAll('#mk-watch-list .mk-name')[2].getAttribute('data-mkkey')");
    // As in WebKit: focus stays on the main area, and the link clicked does not take it.
    await page.eval("document.getElementById('main').focus(); document.querySelectorAll('#mk-watch-list .mk-name')[2].click()");
    await page.waitFor("document.getElementById('mk-item').open");
    await page.key('Escape');
    await page.waitFor("!document.getElementById('mk-item').open");
    // As in the keyboard test: the focus comes back in the dialog's close event, a task after open turns false (in
    // v0.12.0's CI run on main the check came in between): wait up to 3 s for it, then require it.
    await page.waitFor(`document.activeElement && document.activeElement.getAttribute('data-mkkey') === ${JSON.stringify(key)}`, 3000).catch(() => {});
    assert.equal(await page.eval("document.activeElement.getAttribute('data-mkkey')"), key);
    assert.deepEqual(page.problems, []);
  });

  // Found against real data (Phase 3): while a new place's prices were on their way, the age line said
  // "No market data time", as if Universalis had none.
  await test('details: while a new place loads, the age line says it is loading, then gives the age', async () => {
    prices.reset();
    const page = await fresh('#market/item/5057', { market: { scope: 'dc:aether' } });
    await page.waitFor("document.getElementById('mk-item') && document.getElementById('mk-item').open && document.querySelectorAll('#mk-item .mk-book table').length === 2");
    prices.hold();
    await page.eval("(() => { const s = document.querySelector('#mk-item [data-mk-scope]'); s.value = 'region:north-america'; s.dispatchEvent(new Event('change', { bubbles: true })); })()");
    await page.waitFor("/North America/.test(document.querySelector('#mk-item .mk-age-line strong').textContent)");
    assert.equal(await text(page, '#mk-item .mk-age-line strong'), 'Loading market data for North America...');
    prices.release();
    await page.waitFor("/^Market data for North America: updated /.test(document.querySelector('#mk-item .mk-age-line strong').textContent)");
    assert.deepEqual(page.problems, []);
  });

  await test('favorites: from a row and from the details, on the home newest first, Show all, saved, and in step across tabs', async () => {
    prices.reset();
    const page = await fresh('#market', { market: { scope: 'dc:aether' } });
    await page.waitFor(WATCH_PRICED);
    assert.equal(await page.eval("document.getElementById('mk-favhome-empty').hidden"), false);
    await page.eval("(() => { const b = document.querySelector('#mk-watch-list [data-mk-fav=\"10\"]'); b.focus(); b.click(); })()");
    await page.waitFor("document.querySelectorAll('#mk-favhome-list .mk-row').length === 1");
    assert.equal(await page.eval("document.activeElement.getAttribute('data-mkkey')"), 'watch:fav:10', 'focus stays on the star');
    await page.eval("location.hash = '#market/item/5057'");
    await page.waitFor("document.getElementById('mk-item').open");
    await click(page, '#mk-item [data-mk-fav]');
    await page.waitFor("document.querySelector('#mk-item [data-mk-fav]').getAttribute('aria-pressed') === 'true'");
    await page.key('Escape');
    await page.waitFor("!document.getElementById('mk-item').open");
    assert.deepEqual(await page.eval("[...document.querySelectorAll('#mk-favhome-list .mk-name')].map(a => a.textContent)"), ['Iron Ingot', 'Wind Crystal'], 'newest first');
    assert.deepEqual((await saved(page)).favorites, [10, 5057]);
    assert.equal(await text(page, '#mk-favs'), 'Favorites (2)');
    // Another open tab follows.
    const other = await newPage();
    await other.startClockAt(NOW);
    await other.goto(`${LABS}#market`);
    await other.waitFor(`${MARKET_READY} && document.querySelectorAll('#mk-favhome-list .mk-row').length === 2`);
    await click(page, '#mk-favhome-list [data-mk-fav="10"]');
    await other.waitFor("document.querySelectorAll('#mk-favhome-list .mk-row').length === 1");
    // Favorites as results.
    await click(page, '#mk-favs');
    await page.waitFor("!document.getElementById('mk-results-wrap').hidden && document.querySelectorAll('#mk-results .mk-row').length === 1");
    assert.equal(await text(page, '#mk-crumb'), 'Favorites');
    assert.deepEqual([page.problems, other.problems], [[], []]);
  });

  await test('sorts and filters say what they cover; Listed now hides only what is known to have no listing; the choices are saved', async () => {
    prices.reset();
    const page = await fresh('#market', { market: { scope: 'dc:aether' } });
    await page.waitFor(WATCH_PRICED);
    await click(page, '[data-mk-cat="58"]');
    await page.waitFor("document.querySelectorAll('#mk-results .mk-row').length === 18");
    assert.equal(await text(page, '#mk-crumb'), 'Crystals');
    assert.equal(await page.eval('document.activeElement.id'), 'mk-crumb');
    await select(page, 'mk-sort', 'nq-asc');
    await page.waitFor("/^Ranked by lowest NQ listing in Aether, low to high, among all 18 matching items\\./.test(document.getElementById('mk-scope-text').textContent)");
    assert.equal((await saved(page)).sort, 'nq-asc');
    // A bigger search: every match up to 1,000 is loaded, 100 to a request.
    const c0 = prices.calls.length;
    await select(page, 'mk-type', '-1');
    await find(page, 'materia');
    await page.waitFor("/among all \\d+ matching items/.test(document.getElementById('mk-scope-text').textContent)", 15000);
    const n = Number((await text(page, '#mk-scope-text')).match(/among all (\d+)/)[1]);
    const asked = prices.calls.slice(c0).filter((c) => c.kind === 'aggregated');
    assert.ok(asked.every((c) => c.ids.length <= 100));
    assert.ok(asked.length <= Math.ceil(n / 100) + 1, `${asked.length} requests for ${n} matches`);
    // Listed now: two Crystals with no data are hidden, and the line says so.
    prices.empty([2, 3]);
    await select(page, 'mk-sort', 'relevance');
    await find(page, '');
    await click(page, '[data-mk-cat="58"]');
    await click(page, '#mk-refresh');
    await page.waitFor("document.querySelectorAll('#mk-results .mk-row').length === 18 && !document.querySelector('#mk-results').getAttribute('aria-busy').includes('true')");
    await click(page, '#mk-listed');
    await page.waitFor("document.querySelectorAll('#mk-results .mk-row').length === 16");
    assert.match(await text(page, '#mk-scope-text'), /Listed now: 2 items with no listing in Aether are hidden\./);
    assert.equal((await saved(page)).listed, true);
    await click(page, '#mk-listed');
    // Can be HQ and item level narrow the results.
    await select(page, 'mk-type', '-1');
    await find(page, 'ingot');
    await click(page, '#mk-hq');
    await page.eval("(() => { const i = document.getElementById('mk-min'); i.value = '700'; i.dispatchEvent(new Event('change')); })()");
    await page.waitFor("document.querySelectorAll('#mk-results .mk-row').length > 0 && [...document.querySelectorAll('#mk-results .mk-meta')].every(m => /can be HQ/.test(m.textContent) && Number(m.textContent.match(/item level (\\d+)/)[1]) >= 700)");
    assert.deepEqual([(await saved(page)).hq, (await saved(page)).minLevel], [true, 700]);
    assert.deepEqual(page.problems, []);
  });

  await test('the race GW2 Timer found: a search that cancels its requests and asks again at once never leaves rows waiting', async () => {
    prices.reset();
    const page = await fresh('#market', { market: { scope: 'dc:aether' } });
    await page.waitFor(WATCH_PRICED);
    prices.hold();
    await find(page, 'ingot');
    // The search's own request (40 to 50 ids; Market Watch's had 75) is on its way and held.
    await until(() => prices.calls.some((c) => c.kind === 'aggregated' && c.ids.length >= 40 && c.ids.length <= 50));
    // A new sort cancels the request on its way and asks again for the same items at once.
    await select(page, 'mk-sort', 'name');
    await sleep(300);
    prices.release();
    await page.waitFor("document.querySelectorAll('#mk-results .mk-row').length === 50 && document.querySelectorAll('#mk-results .mk-gil').length >= 50", 10000);
    assert.equal(await page.eval("[...document.querySelectorAll('#mk-results .mk-row')].filter(r => /loading|not asked/.test(r.textContent)).length"), 0);
  });

  await test('failures: 503, 429 with Retry-After, a broken answer, offline: the last good prices stay with their ages, nothing is estimated, the timers carry on', async () => {
    prices.reset();
    const page = await fresh('#market', { market: { scope: 'dc:aether' } });
    await page.waitFor(WATCH_PRICED);
    const shown = await page.eval("[...document.querySelectorAll('#mk-watch-list .mk-gil')].map(n => n.textContent)");
    // 503 on every try: the prices shown stay, the line says why and offers Try again.
    prices.failNext({ status: 503, retryAfter: 1 }, 3);
    await click(page, '#mk-watch-refresh');
    await page.waitFor("/not answering right now, so some prices could not be refreshed and show their last known values\\. Nothing is estimated in its place\\./.test(document.getElementById('mk-watch-text').textContent)", 30000);
    assert.deepEqual(await page.eval("[...document.querySelectorAll('#mk-watch-list .mk-gil')].map(n => n.textContent)"), shown, 'the last good prices stay');
    assert.match(await text(page, '#mk-watch-list .mk-note'), /A newer price could not be loaded/);
    // 429: the page waits as told and says so, then asks again by itself.
    prices.failNext({ status: 429, retryAfter: 3 });
    await click(page, '#mk-watch-refresh');
    // The live region says it once and keeps still; the seconds count down beside it, hidden from screen readers.
    await page.waitFor("/^Busy: the price service asked this page to wait\\. Prices already shown stay as they are\\.$/.test(document.getElementById('mk-watch-text').textContent) && /^ Asking again in [1-9]\\d* s\\.$/.test(document.getElementById('mk-watch-wait').textContent)");
    await page.eval("window.__live = []; new MutationObserver(() => window.__live.push(document.getElementById('mk-watch-text').textContent)).observe(document.getElementById('mk-watch-text'), { childList: true, characterData: true, subtree: true })");
    assert.equal(await page.eval("document.getElementById('mk-watch-wait').getAttribute('aria-hidden')"), 'true');
    await page.waitFor("!/Busy|could not/.test(document.getElementById('mk-watch-text').textContent) && /^Prices in Aether/.test(document.getElementById('mk-watch-text').textContent)", 20000);
    const live = await page.eval('window.__live');
    assert.ok(!live.some((x) => /Busy/.test(x)), `the live region changed during the wait: ${JSON.stringify(live)}`);
    assert.equal(await text(page, '#mk-watch-wait'), '', 'the countdown goes when the wait ends');
    // A broken answer: bad data, not "no data", and not asked again by itself (it would break the same way).
    prices.failNext({ mangle: true });
    await find(page, 'cloth');
    await page.waitFor("/sent something this page cannot read/.test(document.getElementById('mk-prices-text').textContent)", 30000);
    assert.match(await text(page, '#mk-results .mk-row'), /not loaded/);
    assert.equal(await text(page, '#mk-refresh'), 'Try again');
    // Offline.
    await page.offline(true);
    await find(page, 'leather');
    await page.waitFor("/could not be reached/.test(document.getElementById('mk-prices-text').textContent)", 30000);
    await page.offline(false);
    await click(page, '#mk-refresh');
    try { await page.waitFor("document.getElementById('mk-prices-text').textContent.startsWith('Prices in Aether')", 15000); } catch (e) { throw new Error(`${e.message}
  line: ${await text(page, '#mk-prices')}`); }
    // The timers were never touched.
    await click(page, '[data-mode="timers"]');
    await page.waitFor(READY);
    // Only the failures this test caused, as Chrome reports them (the answers, and its console's own line for each).
    const expected = (p) => /^HTTP (503|429) .*\/ffxiv\/prices\//.test(p) || /^failed: net::ERR_INTERNET_DISCONNECTED/.test(p)
      || /^log: Failed to load resource: (the server responded with a status of (503|429) |net::ERR_INTERNET_DISCONNECTED$)/.test(p);
    assert.deepEqual(page.problems.filter((p) => !expected(p)), []);
    assert.ok(page.problems.some((p) => /HTTP 429/.test(p)) && page.problems.some((p) => /HTTP 503/.test(p)), 'the failures did happen');
  });

  await test('stale data: a week after the uploads every age reads old, the rows are marked, and the details give the date', async () => {
    prices.reset();
    const later = Date.parse('2026-11-24T06:30:00Z');
    const page = await fresh('#market', { market: { scope: 'dc:aether' } }, { clock: later });
    await page.waitFor(WATCH_PRICED);
    const ages = await page.eval("[...document.querySelectorAll('#mk-watch-list .mk-age')].map(n => [n.textContent, n.className])");
    assert.ok(ages.length >= 8);
    for (const [t, cls] of ages) { assert.match(t, /^[78] days ago$/); assert.equal(cls, 'mk-age is-old'); }
    assert.ok(await page.eval("[...document.querySelectorAll('#mk-watch-list .mk-row')].every(r => r.classList.contains('is-old'))"), 'old rows are marked');
    await page.eval("location.hash = '#market/item/5057'");
    await page.waitFor("document.getElementById('mk-item').open && document.querySelectorAll('#mk-item .mk-book table').length === 2");
    assert.equal(await page.eval("document.querySelector('#mk-item .mk-age-line').className"), 'mk-age-line is-old');
    assert.match(await text(page, '#mk-item .mk-age-line strong'), /^Market data for Aether: updated 7 days ago \(.*2026\)\.$/, 'the date, with its year');
    // Their prices are still shown: old data is shown as old, never hidden or replaced.
    assert.match(await text(page, '#mk-item .mk-stat-min .mk-stat-v'), /^50 gil$/);
    assert.deepEqual(page.problems, []);
  });

  await test('addresses: #market/item/<id> opens the item; an unknown item or path shows a notice and changes nothing saved; Timers & Weather links still open the timers', async () => {
    prices.reset();
    const page = await fresh('#market/item/999999', { market: { scope: 'dc:aether', favorites: [5057] } });
    await page.waitFor(`${MARKET_READY} && !document.getElementById('mk-link-notice').hidden`);
    assert.match(await text(page, '#mk-link-notice-text'), /^That link names an item that is not on the market board/);
    await page.eval("location.hash = '#market/nonsense'");
    await page.waitFor("/could not be read/.test(document.getElementById('mk-link-notice-text').textContent)");
    assert.deepEqual(await saved(page), { scope: 'dc:aether', favorites: [5057] }, 'nothing saved changed');
    await click(page, '#mk-link-dismiss');
    assert.equal(await page.eval('location.hash'), '#market');
    for (const hash of ['#zone=kozamauka', '#zone=eureka-pagos&fz=eureka-pagos&prev=fog&to=heat-waves', '#main', '#resets', '#marketplace', '#Market']) {
      await page.eval(`location.hash = ${JSON.stringify(hash)}`);
      await page.waitFor("!document.getElementById('timers-view').hidden && document.getElementById('market-view').hidden");
    }
    assert.equal(await page.eval("document.getElementById('forecast-zone').value"), 'eureka-pagos');
    const direct = await fresh('#market/item/5057', { market: { scope: 'world:63' } });
    await direct.waitFor("document.getElementById('mk-item') && document.getElementById('mk-item').open && document.querySelectorAll('#mk-item .mk-tax li').length === 8");
    assert.equal(await text(direct, '#mk-item-title'), 'Iron Ingot');
    assert.deepEqual([page.problems, direct.problems], [[], []]);
  });

  await test('GitHub Pages: Market & Crafting is a notice with the same view at radmagelabs.com/ffxiv/, and nothing of the market is asked for', async () => {
    const page = await newPage();
    await page.viewport(1440, 1000);
    const before = servers.github.requests.length;
    await page.goto(`${servers.github.origin}/ffxiv-timer/#market/item/5057`);
    await page.waitFor("!document.getElementById('market-boot').hidden");
    assert.equal(await page.eval("document.querySelector('#market-boot a').href"), 'https://radmagelabs.com/ffxiv/#market/item/5057');
    assert.match(await text(page, '#market-boot'), /^Prices load at radmagelabs\.com\/ffxiv\/\. Open this view there: .*\. This copy of FFXIV Timer asks for no prices; the timers work the same in both places\.$/);
    await click(page, '[data-mode="timers"]');
    await page.waitFor(READY);
    await click(page, '[data-mode="market"]');
    await page.waitFor("location.hash === '#market' && document.querySelector('#market-boot a').href === 'https://radmagelabs.com/ffxiv/#market'");
    assert.equal(await page.eval("document.getElementById('market-jump').hidden"), true, 'no market section links where there is no market');
    assert.deepEqual(servers.github.requests.slice(before).filter((r) => MARKET_FILES.test(r.path) || r.path.includes('/prices/')), []);
    if (shots) await page.screenshot(join(shots, 'github-notice.png'));
    assert.deepEqual(page.problems, []);
    // A file opened from disk: the same notice.
    const file = await newPage();
    await file.goto(`${pathToFileURL(join(pages.appDir, 'index.html')).href}#market`);
    await file.waitFor("!document.getElementById('market-boot').hidden");
    assert.equal(await file.eval("document.querySelector('#market-boot a').href"), 'https://radmagelabs.com/ffxiv/#market');
    assert.deepEqual(file.requests.filter((u) => MARKET_FILES.test(u)), []);
  });

  await test('keyboard: Tab reaches the pills, the search, a result and its star; Enter opens an item; Escape closes it and focus returns, with a visible ring', async () => {
    prices.reset();
    const page = await fresh('#zone=eureka-pagos', { market: { scope: 'dc:aether' } });
    await page.waitFor(READY);
    for (let i = 0; i < 20 && (await page.eval("document.activeElement.dataset.mode || ''")) !== 'market'; i++) await page.key('Tab');
    assert.equal(await page.eval('document.activeElement.dataset.mode'), 'market', 'the pill is reachable');
    assert.ok(await page.eval("document.activeElement.matches(':focus-visible')"));
    await page.key('Enter');
    await page.waitFor(`${MARKET_READY} && ${WATCH_PRICED}`);
    assert.equal(await page.eval("document.activeElement.dataset.mode"), 'market', 'focus stays on the pill');
    for (let i = 0; i < 40 && (await page.eval('document.activeElement.id')) !== 'mk-find'; i++) await page.key('Tab');
    assert.equal(await page.eval('document.activeElement.id'), 'mk-find');
    await page.eval("document.getElementById('mk-find').value = 'iron ingot'");
    await page.key('Enter');
    await page.waitFor("document.querySelector('#mk-results .mk-name') && document.querySelector('#mk-results .mk-name').textContent === 'Iron Ingot'");
    for (let i = 0; i < 40 && (await page.eval("document.activeElement.getAttribute('data-mkkey') || ''")) !== 'name:5057'; i++) await page.key('Tab');
    assert.equal(await page.eval("document.activeElement.getAttribute('data-mkkey')"), 'name:5057', 'the result is reachable');
    assert.ok(await page.eval("document.activeElement.matches(':focus-visible')"));
    await page.key('Enter');
    await page.waitFor("document.getElementById('mk-item').open");
    assert.equal(await page.eval('document.activeElement.id'), 'mk-item-title', 'focus moves into the details');
    await page.key('Escape');
    await page.waitFor("!document.getElementById('mk-item').open");
    // The page puts the focus back in the dialog's close event, which the browser fires a task after open turns
    // false (in v0.12.0's first CI run the check came in between): wait up to 3 s for it, then require it.
    await page.waitFor("document.activeElement && document.activeElement.getAttribute('data-mkkey') === 'name:5057'", 3000).catch(() => {});
    assert.equal(await page.eval("document.activeElement.getAttribute('data-mkkey')"), 'name:5057', 'and back to the result');
    await page.eval("document.querySelector('#mk-results [data-mk-fav=\"5057\"]').focus()");
    await page.key(' ');
    await page.waitFor("document.activeElement.getAttribute('aria-pressed') === 'true'");
    assert.deepEqual(page.problems, []);
  });

  // Found in Phase 3: with the modes in the one-row header, 1201 to about 1320 px hid Transitions (the
  // links' scrollbar is hidden, so nothing showed it was there). The links now take their own row up to 1360.
  // The system font differs by platform (Segoe UI here, often DejaVu Sans on Linux, SF Pro on a Mac), and the
  // one-row header has about 5 % to spare at 1361 px. So the strict check uses Arial, which Windows has and
  // whose metric twin Liberation Sans Linux has; with the system font, links may overflow only with the fade.
  await test('header: from 1361 px every section link is in view on one row, in both modes; from 641 to 1360 px they have a row of their own', async () => {
    const page = await fresh('#market', { market: { scope: 'dc:aether' } }, { width: 1361 });
    await page.waitFor(`${MARKET_READY} && ${WATCH_PRICED}`);
    await page.eval("document.head.append(Object.assign(document.createElement('style'), { id: 'arial', textContent: 'body { font-family: Arial, \"Liberation Sans\", sans-serif; }' }))");
    const measure = () => page.eval("(() => { const j = [...document.querySelectorAll('.topbar .jump')].find((n) => n.getClientRects().length); return { h: Math.round(document.querySelector('.topbar').getBoundingClientRect().height), hidden: j.scrollWidth - j.clientWidth, fade: j.hasAttribute('data-r'), linksTop: Math.round(j.getBoundingClientRect().top), modesTop: Math.round(document.querySelector('.modes').getBoundingClientRect().top) }; })()");
    for (const mode of ['market', 'timers']) {
      if (mode === 'timers') { await click(page, '[data-mode="timers"]'); await page.waitFor(READY); }
      for (const w of [1361, 1440, 1920]) {
        await page.viewport(w, 900);
        await sleep(100);
        const m = await measure();
        assert.equal(m.hidden, 0, `${mode} at ${w}: ${m.hidden} px of section links hidden`);
        assert.equal(m.linksTop, m.modesTop, `${mode} at ${w}: one row`);
      }
      for (const w of [641, 751, 1201, 1360]) {
        await page.viewport(w, 900);
        await sleep(100);
        const m = await measure();
        assert.ok(m.linksTop > m.modesTop, `${mode} at ${w}: the links have a row of their own`);
        assert.equal(m.hidden, 0, `${mode} at ${w}: ${m.hidden} px of section links hidden`);
      }
    }
    // This platform's own font: anything that does not fit shows the fade.
    await page.eval("document.getElementById('arial').remove()");
    for (const w of [641, 1360, 1361, 1440]) {
      await page.viewport(w, 900);
      await sleep(100);
      const m = await measure();
      assert.ok(m.hidden === 0 || m.fade, `system font at ${w}: ${m.hidden} px hidden and no fade`);
    }
    assert.deepEqual(page.problems, []);
  });

  // Asked for in the RC review: on phones the timers' section links scroll sideways with no scrollbar, so
  // the edge with more links beyond it fades; a key moving focus there clears the fade.
  await test('header on a phone: section links that do not fit fade at the edge they are beyond, follow the scroll, and clear for the keyboard', async () => {
    const page = await fresh('', {}, { width: 390, height: 844, mobile: true });
    await page.waitFor(READY);
    await page.waitFor("document.getElementById('timers-jump').hasAttribute('data-r')");
    const state = () => page.eval("(() => { const j = document.getElementById('timers-jump'), cs = getComputedStyle(j); return { l: j.hasAttribute('data-l'), r: j.hasAttribute('data-r'), mask: cs.maskImage || cs.webkitMaskImage || 'none', max: j.scrollWidth - j.clientWidth }; })()");
    let s = await state();
    assert.ok(s.max > 0, 'the links overflow at 390 px');
    assert.deepEqual([s.l, s.r, /gradient/.test(s.mask)], [false, true, true], JSON.stringify(s));
    await page.eval("document.getElementById('timers-jump').scrollLeft = 10000");
    await page.waitFor("document.getElementById('timers-jump').hasAttribute('data-l') && !document.getElementById('timers-jump').hasAttribute('data-r')");
    await page.eval("document.getElementById('timers-jump').scrollLeft = 0");
    await page.waitFor("!document.getElementById('timers-jump').hasAttribute('data-l') && document.getElementById('timers-jump').hasAttribute('data-r')");
    // Keyboard: Tab through the links to the last; each comes into view and the fade is gone while one has focus.
    await page.eval("document.querySelector('#timers-jump button').focus()");
    for (let i = 0; i < 5; i++) await page.key('Tab');
    assert.equal(await page.eval('document.activeElement.textContent'), 'Transitions');
    s = await state();
    assert.equal(s.mask, 'none', 'no fade while a key has focus there');
    assert.ok(await page.eval("(() => { const b = document.activeElement.getBoundingClientRect(), j = document.getElementById('timers-jump').getBoundingClientRect(); return b.left >= j.left - 1 && b.right <= j.right + 1; })()"), 'the focused link is in view');
    // Still plain buttons, all six in the tab order.
    assert.deepEqual(await page.eval("[...document.querySelectorAll('#timers-jump button')].map((b) => b.tabIndex)"), [0, 0, 0, 0, 0, 0]);
    // Wide screens: everything fits, so no fade.
    await page.viewport(1440, 900);
    await page.waitFor("!document.getElementById('timers-jump').hasAttribute('data-r') && !document.getElementById('timers-jump').hasAttribute('data-l')");
    assert.deepEqual(page.problems, []);
  });

  await test('phone widths (320, 390 px) in both themes: no sideways scrolling on the home, the results or the details', async () => {
    prices.reset();
    for (const theme of ['dark', 'light']) {
      for (const width of [320, 390]) {
        const page = await fresh('#market', { market: { scope: 'dc:aether' }, theme }, { width, height: 844, mobile: true });
        await page.waitFor(WATCH_PRICED);
        const where = `${theme} ${width}`;
        const wide = () => page.eval("[...document.querySelectorAll('body *')].filter(n => n.getClientRects().length && n.getBoundingClientRect().right > innerWidth + 1 && !(n.closest('.table-wrap, .jump'))).map(n => n.tagName + '.' + n.className).slice(0, 5)");
        assert.ok(await page.eval('document.documentElement.scrollWidth <= innerWidth'), `${where}: home scrolls sideways`);
        assert.deepEqual(await wide(), [], `${where}: home`);
        if (shots && width === 390) await page.screenshot(join(shots, `phone-${theme}-home.png`), true);
        await find(page, 'ingot');
        await page.waitFor("document.querySelectorAll('#mk-results .mk-gil').length > 0");
        assert.ok(await page.eval('document.documentElement.scrollWidth <= innerWidth'), `${where}: results scroll sideways`);
        assert.deepEqual(await wide(), [], `${where}: results`);
        if (shots && width === 390) await page.screenshot(join(shots, `phone-${theme}-results.png`), true);
        await page.eval("location.hash = '#market/item/5057'");
        await page.waitFor("document.getElementById('mk-item').open && document.querySelectorAll('#mk-item .mk-book table').length === 2");
        assert.ok(await page.eval("document.getElementById('mk-item').getBoundingClientRect().right <= innerWidth"), `${where}: details fit`);
        if (shots && width === 390) await page.screenshot(join(shots, `phone-${theme}-item.png`));
        assert.deepEqual(page.problems, [], where);
      }
    }
  });

  await test('performance: searching all 16,845 items stays under 16 ms a keystroke with the CPU slowed 4 times', async () => {
    const page = await fresh('#market', { market: { scope: 'dc:aether' } });
    await page.waitFor(MARKET_READY);
    await page.cpuThrottle(4);
    const ms = await page.eval(`(() => { const C = XivCatalog.parse(FFXIV_MARKET_ITEMS).catalog, t = [];
      for (const q of ['ir', 'iro', 'iron', 'iron i', 'iron in', 'materia', 'grade 4', 'dye', 'crystal', 'stone', 'leather', 'cloth', 'popoto', 'ingot', 'wind']) { const s = performance.now(); XivCatalog.search(C, { query: q }); t.push(performance.now() - s); }
      t.sort((a, b) => a - b); return t; })()`);
    await page.cpuThrottle(1);
    console.log(`     search, CPU / 4: median ${ms[7].toFixed(1)} ms, slowest ${ms[ms.length - 1].toFixed(1)} ms`);
    assert.ok(ms[7] < 16, `median ${ms[7].toFixed(1)} ms`);
  });

  if (shots) {
    await test('review screenshots: desktop home, results and details in both themes', async () => {
      prices.reset();
      for (const theme of ['dark', 'light']) {
        const page = await fresh('#market', { market: { scope: 'dc:aether', favorites: [5057, 13115, 49240] }, theme });
        await page.waitFor(`${WATCH_PRICED} && document.querySelectorAll('#mk-favhome-list .mk-gil').length >= 3`);
        await sleep(300);
        await page.screenshot(join(shots, `desktop-${theme}-home.png`), true);
        await find(page, 'ingot');
        await page.waitFor("document.querySelectorAll('#mk-results .mk-gil').length >= 40");
        await sleep(300);
        await page.screenshot(join(shots, `desktop-${theme}-results.png`), { height: 1400 });
        await page.eval("location.hash = '#market/item/5057'");
        await page.waitFor("document.getElementById('mk-item').open && document.querySelectorAll('#mk-item .mk-book table').length === 2");
        await page.eval("document.activeElement.blur()");
        await page.screenshot(join(shots, `desktop-${theme}-item.png`));
        const ask = await fresh('#market', { theme });
        await ask.waitFor(`${MARKET_READY} && !document.getElementById('mk-ask').hidden`);
        await ask.screenshot(join(shots, `desktop-${theme}-first-visit.png`));
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
