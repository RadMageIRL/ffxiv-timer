// Browser smoke and base-path tests. Run with `node tests/smoke.mjs`; needs Chrome (or set
// CHROME_PATH). `--shots DIR` also saves desktop and phone screenshots.
//
// The deployed build is served the ways it is reached in public, each imitated by a local server
// that refuses anything outside its base path:
//   GitHub Pages        /ffxiv-timer/  (301 adds the trailing slash, missing files get 404.html)
//   radmagelabs.com     /ffxiv/        the same files through the Labs proxy, which also passes the
//                                      Lodestone news feeds through (here: saved copies)
//   proxy, no redirect  /ffxiv/        a host that serves the bare /ffxiv; the page must fix it
//   standalone labs     /ffxiv/        the labs build, for a host that serves the files itself
//   development         /dev/deep/path/ and file://   the source tree, unbuilt
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from '../tools/build.mjs';
import { findChrome, launchChrome } from './lib/cdp.mjs';
import { serve } from '../tools/lib/static-server.mjs';
import { fakeUniversalis } from './lib/fake-universalis.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const shotsArg = process.argv.indexOf('--shots');
const shots = shotsArg > 0 ? resolve(process.argv[shotsArg + 1]) : null;
if (!findChrome()) { console.error('SKIPPED: Chrome not found; set CHROME_PATH to run the browser tests'); process.exit(2); }

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`ok   ${name}`); } catch (e) { failed++; console.error(`FAIL ${name}\n  ${String(e.message).split('\n').join('\n  ')}`); }
}

const READY = "/^\\d\\d:\\d\\d$/.test(document.getElementById('et-time').textContent) && document.querySelectorAll('#zone-list .zone-row').length > 0 && document.querySelectorAll('#forecast-body tbody tr').length >= 12";
const PREFIX = 'ffxiv-timer:v1:';
// The calendar dialog is open and ready: js/ics.js has loaded (on first use) and the summary is worked out.
const CAL_READY = "document.getElementById('calendar').open && typeof XivIcs === 'object' && document.getElementById('calendar-summary').textContent !== 'Loading the calendar tool.'";

const tmp = mkdtempSync(join(tmpdir(), 'ffxiv-timer-smoke-'));
const pages = build('pages', { outRoot: tmp }), labs = build('labs', { outRoot: tmp });
const newsRoutes = (base, fail) => Object.fromEntries(['topics', 'news'].map((f) => [`${base}news/${f}.xml`, { file: join(ROOT, 'tests', 'fixtures', `lodestone-${f}.xml`), fail }]));
// The flaky server answers the next `blips` news requests with 503, then the saved feeds, and the next
// `icsBlips` requests for js/ics.js (the calendar tool, loaded on first use) the same way.
let blips = 0, icsBlips = 0;
const blip = () => (blips > 0 ? (blips--, true) : false);
const icsBlip = () => (icsBlips > 0 ? (icsBlips--, true) : false);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, timeout = 8000) {
  const end = Date.now() + timeout;
  while (!fn()) { if (Date.now() > end) throw new Error(`timed out waiting for ${fn}`); await sleep(50); }
}
// The radmagelabs.com imitation also answers the price paths, as the Labs rules will (see
// tests/lib/fake-universalis.mjs); GitHub Pages has no such paths.
const prices = fakeUniversalis();
const servers = {
  github: await serve({ mounts: [{ prefix: '/ffxiv-timer/', dir: pages.appDir, notFound: '404.html' }] }),
  proxy: await serve({ mounts: [{ prefix: '/ffxiv/', dir: pages.appDir, notFound: '404.html' }], routes: newsRoutes('/ffxiv/'), handlers: [{ prefix: '/ffxiv/prices/', handle: prices.handle }] }),
  bare: await serve({ mounts: [{ prefix: '/ffxiv/', dir: pages.appDir, notFound: '404.html' }], slash: 'none' }),
  labs: await serve({ mounts: [{ prefix: '/ffxiv/', dir: labs.appDir, notFound: '404.html' }] }),
  flaky: await serve({ mounts: [{ prefix: '/ffxiv/', dir: pages.appDir, notFound: '404.html' }], routes: { ...newsRoutes('/ffxiv/', blip), '/ffxiv/js/ics.js': { file: join(pages.appDir, 'js', 'ics.js'), fail: icsBlip } } }),
  dev: await serve({ mounts: [{ prefix: '/dev/deep/path/', dir: ROOT }] }),
};
const sites = [
  { name: 'GitHub Pages', server: servers.github, base: '/ffxiv-timer/', has404: true },
  { name: 'radmagelabs.com proxy', server: servers.proxy, base: '/ffxiv/', has404: true },
  { name: 'standalone labs build', server: servers.labs, base: '/ffxiv/', has404: true },
  { name: 'source tree (dev)', server: servers.dev, base: '/dev/deep/path/', has404: false },
];

const chrome = await launchChrome();
try {
  for (const site of sites) {
    const page = await chrome.newPage();
    const url = (rest = '') => `${site.server.origin}${site.base}${rest}`;
    const clean = () => {
      const outside = site.server.outside();
      assert.deepEqual(outside, [], `requests outside ${site.base}: ${JSON.stringify(outside)}`);
      assert.deepEqual(page.problems, [], 'browser problems');
    };

    await test(`${site.name}: loads at ${site.base} with every request inside the base path`, async () => {
      await page.goto(url());
      await page.waitFor(READY);
      clean();
      const assets = site.server.requests.filter((r) => /\.(js|css|svg)$/.test(r.path));
      assert.ok(assets.length >= 8, `assets requested: ${assets.length}`);
      assert.match(await page.eval("document.getElementById('et-date').textContent"), /^\d+(st|nd|rd|th) Sun of the \d(st|nd|rd|th) (Astral|Umbral) Moon$/);
      assert.equal(await page.eval("document.getElementById('data-patch').textContent"), '7.58');
      assert.deepEqual(site.server.requests.filter((r) => r.path.endsWith('/ics.js')), [], 'the calendar tool is not part of the first load');
    });

    await test(`${site.name}: the calendar tool loads from inside the base path the first time a calendar is asked for, once`, async () => {
      const icsAsked = () => site.server.requests.filter((r) => r.path === `${site.base}js/ics.js`);
      const before = icsAsked().length;
      for (let i = 0; i < 2; i++) {
        await page.eval("document.querySelector('[data-cal=\"resets\"]').click()");
        await page.waitFor("document.getElementById('calendar').open && !document.getElementById('calendar-download').disabled");
        assert.match(await page.eval("document.getElementById('calendar-summary').textContent"), /^\d+ entries, from /);
        await page.eval("document.getElementById('calendar').close()");
      }
      assert.deepEqual(icsAsked().slice(before).map((r) => r.status), [200], 'one request for js/ics.js, from this site');
      if (site.server !== servers.dev) assert.match(await page.eval("[...document.scripts].map(s => s.src).find(s => s.includes('/js/ics.js'))"), /\/js\/ics\.js\?v=[0-9a-f]{10}$/, 'with the build\'s version stamp');
      clean();
    });

    await test(`${site.name}: a shared link restores the forecast and transition search, also after reload`, async () => {
      await page.goto(url('#zone=eureka-pagos&fz=eureka-anemos&to=gales&bells=8'));
      const state = "document.getElementById('forecast-zone').value === 'eureka-pagos' && document.getElementById('finder-zone').value === 'eureka-anemos' && document.querySelectorAll('#finder-results .result').length > 0";
      await page.waitFor(state);
      const etTimes = await page.eval("[...document.querySelectorAll('#finder-results .tl-when .muted')].map(n => n.textContent)");
      assert.ok(etTimes.every((t) => t === '08:00 ET'), JSON.stringify(etTimes));
      await page.reload();
      await page.waitFor(state);
      assert.match(await page.eval('location.hash'), /fz=eureka-anemos/);
      clean();
    });

    await test(`${site.name}: starring a zone survives a reload, in namespaced storage`, async () => {
      await page.goto(url('#zone=middle-la-noscea'));
      await page.waitFor(READY);
      await page.eval("document.querySelector('[data-star=\"kozamauka\"]').click()");
      await page.reload();
      await page.waitFor(READY);
      assert.equal(await page.eval("document.querySelector('[data-star=\"kozamauka\"]').getAttribute('aria-pressed')"), 'true');
      const keys = await page.eval('Object.keys(localStorage)');
      assert.ok(keys.length > 0 && keys.every((k) => k.startsWith(PREFIX)), JSON.stringify(keys));
      const timeline = await page.eval("document.getElementById('timeline-list').textContent");
      assert.match(timeline, /Sunrise|Sunset/);
      clean();
    });

    await test(`${site.name}: an unsupported zone is named as unsupported, never forecast`, async () => {
      await page.goto(url('#zone=zadnor'));
      await page.waitFor("document.getElementById('forecast-body').textContent.includes('Zadnor has weather in the game')");
      assert.equal(await page.eval("document.querySelectorAll('#forecast-body tbody tr').length"), 0);
      await page.eval("const s = document.getElementById('zone-search'); s.value = 'zadnor'; s.dispatchEvent(new Event('input'))");
      await page.waitFor("document.querySelectorAll('#zone-list .unsupported').length === 1");
      clean();
    });

    if (site.has404) {
      await test(`${site.name}: a mistyped address inside the base path returns to the app`, async () => {
        page.problems.length = 0;
        await page.goto(url('no/such/page#zone=eureka-pyros'));
        await page.waitFor(`location.pathname === ${JSON.stringify(site.base)} && document.getElementById('forecast-zone').value === 'eureka-pyros'`);
        assert.ok(page.problems.every((p) => /HTTP 404 .*no\/such\/page/.test(p)), JSON.stringify(page.problems));
        page.problems.length = 0;
        assert.deepEqual(site.server.outside(), []);
      });
    }

    await test(`${site.name}: the address without its trailing slash still works`, async () => {
      await page.goto(`${site.server.origin}${site.base.slice(0, -1)}#zone=urqopacha`);
      await page.waitFor(`location.pathname === ${JSON.stringify(site.base)} && document.getElementById('forecast-zone').value === 'urqopacha'`);
      await page.waitFor(READY);
      clean();
    });
  }

  await test('proxy that serves the bare /ffxiv: the page adds the slash itself, keeping the hash', async () => {
    const page = await chrome.newPage();
    await page.goto(`${servers.bare.origin}/ffxiv#zone=eureka-hydatos`);
    await page.waitFor("location.pathname === '/ffxiv/' && document.getElementById('forecast-zone').value === 'eureka-hydatos'");
    await page.waitFor(READY);
    assert.deepEqual(servers.bare.outside().filter((r) => r.status === 200), [], 'no asset was fetched from outside /ffxiv/');
  });

  await test('development: index.html opened straight from disk (file://) works', async () => {
    const page = await chrome.newPage();
    await page.goto(pathToFileURL(join(ROOT, 'index.html')).href + '#zone=yak-tel');
    await page.waitFor(READY);
    assert.equal(await page.eval("document.getElementById('forecast-zone').value"), 'yak-tel');
    // The calendar tool loads from disk too.
    await page.eval("document.querySelector('[data-cal=\"resets\"]').click()");
    await page.waitFor("document.getElementById('calendar').open && !document.getElementById('calendar-download').disabled");
    assert.equal(await page.eval('typeof XivIcs'), 'object');
    assert.deepEqual(page.problems, []);
  });

  await test('Add to calendar: if the calendar tool cannot load, the dialog says so, offers no file, and the next try loads it', async () => {
    const page = await chrome.newPage();
    await page.goto(`${servers.flaky.origin}/ffxiv/`);
    await page.waitFor(READY);
    icsBlips = 1;
    await page.eval("document.querySelector('[data-cal=\"resets\"]').click()");
    await page.waitFor("document.getElementById('calendar-summary').textContent.startsWith('The calendar tool could not load.')");
    assert.equal(await page.eval("document.getElementById('calendar-download').disabled"), true);
    await page.eval("document.getElementById('calendar').close()");
    await page.eval("document.querySelector('[data-cal=\"resets\"]').click()");
    await page.waitFor("!document.getElementById('calendar-download').disabled");
    assert.match(await page.eval("document.getElementById('calendar-summary').textContent"), /^\d+ entries, from /);
    assert.deepEqual(servers.flaky.requests.filter((r) => r.path === '/ffxiv/js/ics.js').map((r) => r.status), [503, 200]);
    assert.ok(page.problems.every((p) => /503/.test(p)), JSON.stringify(page.problems));
    await page.eval("document.getElementById('calendar').close()");
  });

  await test('phone width (390 px): no sideways scrolling', async () => {
    const page = await chrome.newPage();
    await page.viewport(390, 844, true);
    await page.goto(`${servers.github.origin}/ffxiv-timer/#zone=eureka-pagos&fz=eureka-pagos&prev=fog&to=heat-waves`);
    await page.waitFor(READY);
    assert.equal(await page.eval('innerWidth'), 390);
    // Only the section nav and the forecast table may hold content past the edge (they scroll
    // inside themselves); the strips themselves must fit, and nothing else may overflow.
    const wide = await page.eval("[...document.querySelectorAll('body *')].filter(n => n.getBoundingClientRect().right > innerWidth + 1 && !(n.parentElement && n.parentElement.closest('.table-wrap, .jump'))).map(n => n.tagName + '.' + n.className).slice(0, 5)");
    assert.deepEqual(wide, [], 'elements past the right edge');
    assert.ok(await page.eval('document.documentElement.scrollWidth <= innerWidth'), 'page scrolls sideways');
    if (shots) {
      mkdirSync(shots, { recursive: true });
      await page.screenshot(join(shots, 'phone.png'), true);
    }
    // The calendar dialog fits too, with its longest choice and range labels.
    for (const key of ['upcoming', 'resets', 'reset:housing', 'finder']) {
      await page.eval(`document.querySelector('[data-cal="${key}"]').click()`);
      await page.waitFor(CAL_READY);
      const past = await page.eval("[...document.querySelectorAll('#calendar *')].filter(n => n.getBoundingClientRect().right > innerWidth + 1).map(n => n.tagName + '.' + n.className).slice(0, 5)");
      assert.deepEqual(past, [], `dialog from ${key}: elements past the right edge`);
      if (shots && key === 'resets') await page.screenshot(join(shots, 'phone-calendar.png'));
      await page.eval("document.getElementById('calendar').close()");
    }
    assert.deepEqual(page.problems, []);
  });

  await test('expansion groups start closed and remember being opened', async () => {
    const page = await chrome.newPage();
    await page.goto(`${servers.github.origin}/ffxiv-timer/`);
    await page.waitFor(READY);
    const groups = await page.eval("[...document.querySelectorAll('#zone-list details[data-group]')].map(d => [d.dataset.group, d.open])");
    assert.ok(groups.length >= 5 && groups.every(([, open]) => !open), JSON.stringify(groups));
    await page.eval("document.querySelector('#zone-list details[data-group=\"Stormblood\"] summary').click()");
    await page.waitFor("document.querySelector('#zone-list details[data-group=\"Stormblood\"]').open");
    await page.reload();
    await page.waitFor(READY);
    assert.equal(await page.eval("document.querySelector('#zone-list details[data-group=\"Stormblood\"]').open"), true);
    assert.equal(await page.eval("document.querySelector('#zone-list details[data-group=\"Heavensward\"]').open"), false);
    await page.eval("const s = document.getElementById('region-filter'); s.value = 'r:Othard'; s.dispatchEvent(new Event('change'))");
    const names = await page.eval("[...document.querySelectorAll('#zone-list .zone-row .zone-title')].map(n => n.textContent)");
    assert.deepEqual(names.sort(), ['The Azim Steppe', 'The Doman Enclave', 'The Ruby Sea', 'Yanxia']);
    assert.deepEqual(page.problems, []);
  });

  await test('timed gathering: filters, a starred node in Upcoming, and a reminder toast', async () => {
    const require = createRequire(import.meta.url);
    const G = require('../js/gathering.js'), nodes = require('../js/gathering-data.js').nodes;
    const alumen = nodes.find((n) => n.items.some((i) => i.name === 'Turali Alumen'));
    const spawn = G.upcoming(alumen, Date.UTC(2026, 9, 24), 1)[0].start;
    const page = await chrome.newPage();
    await page.viewport(1440, 1000);
    await page.startClockAt(spawn - 50000); // 50 s before Turali Alumen appears
    await page.goto(`${servers.github.origin}/ffxiv-timer/`);
    // Default view: Next hour, up now first (ending soonest), then spawns within the hour (soonest).
    await page.waitFor(READY);
    assert.equal(await page.eval("document.querySelector('[data-node-view=\"hour\"]').getAttribute('aria-pressed')"), 'true');
    const rows = await page.eval("[...document.querySelectorAll('#node-list .node-row')].map(r => [r.dataset.up === 'true', +r.dataset.start, +r.dataset.end])");
    const now = await page.eval('Date.now()');
    const firstLater = rows.findIndex(([up]) => !up);
    assert.ok(firstLater > 0 && rows.slice(firstLater).every(([up]) => !up), 'all up rows come first');
    for (let i = 1; i < firstLater; i++) assert.ok(rows[i - 1][2] <= rows[i][2], 'up rows by time left');
    for (let i = firstLater + 1; i < rows.length; i++) assert.ok(rows[i - 1][1] <= rows[i][1], 'later rows by spawn time');
    assert.ok(rows.slice(firstLater).every(([, start]) => start - now <= 3600000 + 5000), 'later rows spawn within the hour');
    const headings = await page.eval("[...document.querySelectorAll('#node-list .node-heading')].map(h => h.textContent)");
    assert.match(headings.join('|'), /^Up now \d+\|Next hour \d+$/);
    await page.eval("document.querySelector('[data-node-view=\"all\"]').click()");
    assert.equal(await page.eval("document.querySelectorAll('#node-list .node-row').length"), nodes.length, 'All nodes lists all 189');
    // 15 min: the same up-now rows, and only spawns within 15 minutes.
    await page.eval("document.querySelector('[data-node-view=\"15\"]').click()");
    const quarter = await page.eval("[...document.querySelectorAll('#node-list .node-row')].map(r => [r.dataset.up === 'true', +r.dataset.start])");
    const now15 = await page.eval('Date.now()');
    assert.equal(quarter.filter(([up]) => up).length, firstLater, 'same up-now rows');
    assert.ok(quarter.filter(([up]) => !up).every(([, start]) => start - now15 <= 15 * 60000 + 5000) && quarter.length < rows.length);
    assert.match(await page.eval("[...document.querySelectorAll('#node-list .node-heading')].map(h => h.textContent).join('|')"), /Next 15 minutes/);
    await page.eval("document.querySelector('[data-node-view=\"hour\"]').click()");
    await page.eval("document.querySelector('[data-node-filter=\"Miner\"]').click()");
    const metas = await page.eval("[...document.querySelectorAll('#node-list .node-meta:not(.muted)')].map(n => n.textContent)");
    assert.ok(metas.length > 0 && metas.length < nodes.length && metas.every((m) => m.includes('Miner')), JSON.stringify(metas));
    await page.eval("document.querySelector('[data-node-filter=\"Miner\"]').click()");
    await page.eval("{ const s = document.getElementById('node-search'); s.value = 'turali alumen'; s.dispatchEvent(new Event('input')); }");
    await page.waitFor("document.querySelectorAll('#node-list .node-row').length === 1");
    assert.match(await page.eval("document.querySelector('#node-list .node-row').textContent"), /Turali Alumen.*Urqopacha.*\(37\.\d, 29\.\d\).*Tome of Geological Folklore - Yok Tural.*08:00 and 20:00 ET/s);
    await page.eval(`document.querySelector('[data-node-star="${alumen.id}"]').click()`);
    await page.waitFor("document.getElementById('timeline-list').textContent.includes('Turali Alumen')");
    await page.eval("{ const r = document.getElementById('remind-lead'); r.value = '1'; r.dispatchEvent(new Event('change')); }");
    await page.waitFor("document.getElementById('toasts').textContent.includes('Turali Alumen')", 5000);
    const upNow = await page.eval("XivGathering && FFXIV_GATHERING_DATA.nodes.filter(n => XivGathering.status(n, Date.now()).up).length");
    await page.eval("{ const s = document.getElementById('node-search'); s.value = ''; s.dispatchEvent(new Event('input')); document.querySelector('[data-node-filter=\"up\"]').click(); }");
    assert.equal(await page.eval("document.querySelectorAll('#node-list .node-row').length"), upNow);
    await page.eval("document.querySelector('[data-node-filter=\"up\"]').click()");
    assert.deepEqual(page.problems, []);
  });

  await test('gathering: expansion and level filters, Hide higher per job, settings kept, Up now in Upcoming', async () => {
    const page = await chrome.newPage();
    await page.viewport(1440, 1000);
    await page.goto(`${servers.github.origin}/ffxiv-timer/#zone=middle-la-noscea`);
    await page.waitFor(READY);
    const rowsOf = () => page.eval("[...document.querySelectorAll('#node-list .node-row')].map(r => ({ id: +r.dataset.id, exp: r.dataset.expansion, job: r.dataset.job, level: +r.dataset.level, up: r.dataset.up === 'true' }))");
    await page.eval("document.querySelector('[data-node-view=\"all\"]').click(); document.querySelector('[data-node-exp=\"Dawntrail\"]').click()");
    let rows = await rowsOf();
    assert.ok(rows.length === 26 && rows.every((r) => r.exp === 'Dawntrail'), JSON.stringify(rows.length));
    assert.match(await page.eval("document.getElementById('node-summary').textContent"), /26 of 189 nodes match/);
    await page.eval("document.querySelector('[data-node-exp=\"Dawntrail\"]').click(); { const s = document.getElementById('node-min-level'); s.value = '90'; s.dispatchEvent(new Event('change')); }");
    rows = await rowsOf();
    assert.ok(rows.length > 0 && rows.every((r) => r.level >= 90));
    await page.eval("{ const s = document.getElementById('node-min-level'); s.value = ''; s.dispatchEvent(new Event('change')); const m = document.getElementById('my-level-miner'); m.value = '60'; m.dispatchEvent(new Event('change')); document.getElementById('hide-above').click(); }");
    rows = await rowsOf();
    assert.ok(rows.every((r) => r.job !== 'Miner' || r.level <= 60), 'no Miner node above 60');
    assert.ok(rows.some((r) => r.job === 'Botanist' && r.level > 60), 'Botanist nodes are not held to the Miner level');
    // Everything is remembered across a reload.
    await page.reload();
    await page.waitFor(READY);
    assert.deepEqual(await page.eval("[document.querySelector('[data-node-view=\"all\"]').getAttribute('aria-pressed'), document.getElementById('my-level-miner').value, document.getElementById('hide-above').getAttribute('aria-pressed')]"), ['true', '60', 'true']);
    assert.ok((await rowsOf()).every((r) => r.job !== 'Miner' || r.level <= 60));
    // Star a node that is up right now: Upcoming lists it first, labeled Up now.
    const up = (await rowsOf()).find((r) => r.up);
    assert.ok(up, 'some node is up');
    await page.eval(`document.querySelector('[data-node-star="${up.id}"]').click()`);
    await page.waitFor(`document.querySelector('#timeline-list .tl-up[data-node="${up.id}"]')`);
    assert.match(await page.eval(`document.querySelector('#timeline-list .tl-up[data-node="${up.id}"]').textContent`), /^Up now.*ends in/s);
    assert.equal(await page.eval("document.querySelector('#timeline-list li').classList.contains('tl-up')"), true, 'Up now entries come first');
    assert.deepEqual(page.problems, []);
  });

  // ---- Resets and Add to calendar (v0.10.0) ----
  const T0 = Date.UTC(2026, 9 + 1, 17, 14, 20); // Tuesday 2026-11-17 14:20 UTC: 08:20 CST, 23:20 JST
  const resetText = (page, id) => page.eval(`(() => { const r = document.querySelector('#resets-list [data-reset="${id}"]'); return r && [r.querySelector('.reset-local') && r.querySelector('.reset-local').textContent, r.querySelector('.reset-utc') && r.querySelector('.reset-utc').textContent, Boolean(r.querySelector('.badge.unverified'))]; })()`);
  const storage = (page) => page.eval('JSON.stringify(Object.keys(localStorage).sort().map(k => [k, localStorage.getItem(k)]))');

  await test('Resets: local times with the zone named, UTC beside each, community-only times marked; the same in four time zones', async () => {
    const cases = [
      ['America/Chicago', T0, 'America/Chicago (CST)', ['Today 09:00 AM CST', 'every day, 15:00 UTC', true], ['Tue, Nov 24 02:00 AM CST', 'every Tuesday, 08:00 UTC', false]],
      ['Asia/Tokyo', T0, 'Asia/Tokyo (GMT+9)', ['Tomorrow 12:00 AM GMT+9', 'every day, 15:00 UTC', true], ['Tue, Nov 24 05:00 PM GMT+9', 'every Tuesday, 08:00 UTC', false]],
      ['Europe/London', T0, 'Europe/London (GMT)', ['Today 03:00 PM GMT', 'every day, 15:00 UTC', true], ['Tue, Nov 24 08:00 AM GMT', 'every Tuesday, 08:00 UTC', false]],
      // The day before the US change to daylight time: the next weekly reset is already in CDT.
      ['America/Chicago', Date.UTC(2027, 2, 13, 12), 'America/Chicago (CST)', ['Today 09:00 AM CST', 'every day, 15:00 UTC', true], ['Tue 03:00 AM CDT', 'every Tuesday, 08:00 UTC', false]],
    ];
    for (const [tz, at, zone, daily, weekly] of cases) {
      const page = await chrome.newPage();
      await page.emulate({ timezone: tz, locale: 'en-US' });
      await page.startClockAt(at);
      await page.goto(`${servers.github.origin}/ffxiv-timer/`);
      await page.waitFor(READY);
      assert.ok((await page.eval("document.getElementById('resets-zone').textContent")).startsWith(`Times are in your time zone, ${zone}, with UTC beside each one`), tz);
      assert.deepEqual(await resetText(page, 'daily'), daily, `${tz} daily`);
      assert.deepEqual(await resetText(page, 'weekly'), weekly, `${tz} weekly`);
      assert.deepEqual(page.problems, []);
    }
  });

  await test('Resets: the data center is saved under its own key only once chosen, and its Jumbo Cactpot drawing shows in local time and UTC', async () => {
    const page = await chrome.newPage();
    await page.emulate({ timezone: 'America/Chicago', locale: 'en-US' });
    await page.startClockAt(T0);
    await page.goto(`${servers.github.origin}/ffxiv-timer/`);
    await page.waitFor(READY);
    await page.eval('localStorage.clear()');
    await page.reload();
    await page.waitFor(READY);
    // A first visit writes exactly what v0.9.1 wrote; Resets adds nothing until a data center is chosen.
    assert.deepEqual(JSON.parse(await storage(page)).map(([k]) => k), [`${PREFIX}finder`, `${PREFIX}forecastZone`]);
    assert.match(await page.eval("document.querySelector('#resets-list [data-reset=\"jumbo-cactpot\"]').textContent"), /Choose yours above/);
    await page.eval("{ const s = document.getElementById('resets-dc'); s.value = 'aether'; s.dispatchEvent(new Event('change')); }");
    assert.deepEqual(await resetText(page, 'jumbo-cactpot-aether'), ['Sat 08:00 PM CST', 'every Sunday, 02:00 UTC', false]);
    assert.equal(await page.eval(`localStorage.getItem('${PREFIX}resets')`), '{"dataCenter":"aether","starred":[],"remindLead":null}');
    await page.reload();
    await page.waitFor(READY);
    assert.equal(await page.eval("document.getElementById('resets-dc').value"), 'aether');
    await page.eval("{ const s = document.getElementById('resets-dc'); s.value = 'materia'; s.dispatchEvent(new Event('change')); }");
    assert.deepEqual(await resetText(page, 'jumbo-cactpot-materia'), ['Sat 03:00 AM CST', 'every Saturday, 09:00 UTC', false]);
    // A saved value this version does not know is ignored, not shown.
    await page.eval(`localStorage.setItem('${PREFIX}resets', '{"dataCenter":"atlantis"}')`);
    await page.reload();
    await page.waitFor(READY);
    assert.equal(await page.eval("document.getElementById('resets-dc').value"), '');
    assert.equal(await page.eval("document.querySelectorAll('#resets-list [data-reset^=\"jumbo-cactpot-\"]').length"), 0);
    // The housing lottery: the results period until Thursday 2026-11-19 15:00 UTC.
    assert.match(await page.eval("document.querySelector('#resets-list [data-reset=\"housing\"]').textContent"), /Results period now.*until Thu 09:00 AM CST.*every 9 days, 15:00 UTC/s);
    assert.deepEqual(page.problems, []);
  });

  await test('Add to calendar: every panel opens the dialog; the files hold what it says; no request, saved setting or address changes', async () => {
    const dl = mkdtempSync(join(tmpdir(), 'ffxiv-timer-downloads-'));
    try {
      await chrome.downloadsTo(dl);
      const page = await chrome.newPage();
      await page.viewport(1440, 1000);
      await page.emulate({ timezone: 'America/Chicago', locale: 'en-US' });
      // The clock stands still in this test, so a summary and the file made a moment later describe the same
      // instant: a range such as the next 2 hours gains entries whenever a window crosses its far edge, and
      // several nodes can cross at one bell.
      await page.beforeLoad(`(() => { Date.now = () => ${T0}; })();`);
      await page.goto(`${servers.github.origin}/ffxiv-timer/#zone=middle-la-noscea&fz=eureka-anemos&to=gales&bells=8`);
      await page.waitFor(READY);
      await page.waitFor("document.querySelectorAll('#finder-results .result').length > 0");
      const href = await page.eval('location.href'), asked = (site) => site.requests.length;
      let saved = await storage(page);
      const before = asked(servers.github);
      // The first opening also loads the calendar tool; the dialog is ready once its summary is worked out.
      const open = async (sel) => { await page.eval(`document.querySelector(${JSON.stringify(sel)}).click()`); await page.waitFor(CAL_READY); };
      const set = (id, value) => page.eval(`{ const s = document.getElementById('${id}'); s.value = '${value}'; s.dispatchEvent(new Event('change', { bubbles: true })); }`);
      const pick = (value) => page.eval(`{ const r = document.querySelector('[name="calendar-choice"][value="${value}"]'); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); }`);
      const view = () => page.eval("({ choices: [...document.querySelectorAll('#calendar-choices label')].map(l => l.textContent), ranges: [...document.querySelectorAll('#calendar-range option')].map(o => o.value), summary: document.getElementById('calendar-summary').textContent, warn: document.getElementById('calendar-warn').hidden ? '' : document.getElementById('calendar-warn').textContent, unsure: document.getElementById('calendar-uncertain').hidden ? '' : document.getElementById('calendar-uncertain').textContent, disabled: document.getElementById('calendar-download').disabled })");
      const close = async () => { await page.eval("document.querySelector('#calendar .dialog-close button').click()"); await page.waitFor("!document.getElementById('calendar').open"); };
      async function download(name) {
        await page.eval("document.getElementById('calendar-download').click()");
        await until(() => readdirSync(dl).includes(name) && !readdirSync(dl).some((f) => f.endsWith('.crdownload')), 20000);
        const text = readFileSync(join(dl, name), 'utf8');
        rmSync(join(dl, name));
        const done = new RegExp(`^Downloading ${name.replace(/\./g, '\\.')} \\((\\d+) entr`).exec(await page.eval("document.getElementById('calendar-done').textContent"));
        assert.ok(done, 'the dialog says what it downloaded');
        assert.ok(text.startsWith('BEGIN:VCALENDAR\r\n') && text.endsWith('END:VCALENDAR\r\n') && !/(?<!\r)\n/.test(text), `${name} is a CRLF calendar file`);
        // Long lines are folded at 75 octets; the checks below read the unfolded lines.
        const lines = text.replace(/\r\n /g, '');
        const events = lines.split('BEGIN:VEVENT').length - 1;
        assert.equal(events, Number(done[1]), 'the file holds what the dialog says it downloaded');
        return { text: lines, events };
      }
      const entries = (s) => Number((/^(\d+) entr/.exec(s) || [])[1]);

      // Upcoming: what it lists, then the weather in the starred zones.
      await open('[data-cal="upcoming"]');
      let v = await view();
      assert.match(v.choices[0], /^Everything Upcoming lists \(\d+; not sunrise and sunset\)$/);
      assert.equal(v.choices[1], 'Weather changes in starred zones (3)');
      assert.deepEqual(v.ranges, ['listed']);
      let f = await download('ffxiv-timer-upcoming.ics');
      assert.equal(f.events, entries(v.summary), v.summary);
      assert.ok(!f.text.includes('Sunrise') && !f.text.includes('Sunset'));
      await pick('starred-weather');
      assert.deepEqual((await view()).ranges, ['next', '2h', '6h']);
      await set('calendar-range', '6h');
      await set('calendar-alarm', '10');
      v = await view();
      f = await download('ffxiv-timer-starred-weather-zones-next-6-hours.ics');
      assert.equal(f.events, entries(v.summary));
      assert.equal(f.text.split('TRIGGER:-PT10M').length - 1, f.events, 'every entry has the 10-minute alarm');
      await close();
      // The page puts focus back in the dialog's close event, which runs as a task after the dialog has
      // closed, so the test waits for it (up to 5 s) instead of reading the focus at once.
      await page.waitFor("document.activeElement === document.querySelector('[data-cal=\"upcoming\"]')", 5000).catch(async () => {
        assert.fail(`focus did not return to the Upcoming Calendar button within 5 s of the dialog closing; it is on ${await page.eval('document.activeElement.outerHTML.slice(0, 120)')}`);
      });

      // Timed gathering: with no stars, the filtered nodes come first; the warning above 200 and the refusal above 500.
      await open('[data-cal="nodes"]');
      v = await view();
      assert.deepEqual(v.choices, ['Nodes the gathering filters match (189 of 189)', 'Starred nodes (0)']);
      assert.ok(v.summary.startsWith('189 entries, from ') && !v.warn && !v.disabled, v.summary);
      await set('calendar-range', '6h');
      v = await view();
      assert.match(v.summary, /^That would be \d+ entries, more than the 500 one file can hold\./);
      assert.equal(v.disabled, true);
      await pick('starred-nodes');
      v = await view();
      assert.deepEqual([v.summary, v.disabled], ['No nodes are starred yet. Star one in Timed gathering, or choose another option here.', true]);
      await close();
      // The Miner filter is saved by the gathering panel itself (as in v0.9.1), so storage is compared around it.
      assert.equal(await storage(page), saved, 'the dialog saved nothing');
      await page.eval("document.querySelector('[data-node-filter=\"Miner\"]').click()");
      await open('[data-cal="nodes"]');
      await set('calendar-range', '2h');
      v = await view();
      assert.ok(entries(v.summary) > 200 && entries(v.summary) <= 500, v.summary);
      assert.match(v.warn, /^That is more than 200 entries\./);
      assert.equal(v.disabled, false, 'over the warning a file can still be made');
      const miners = await page.eval("FFXIV_GATHERING_DATA.nodes.filter(n => n.job === 'Miner').length");
      f = await download(`ffxiv-timer-${miners}-nodes-next-2-hours.ics`);
      assert.equal(f.events, entries(v.summary));
      await close();
      await page.eval("document.querySelector('[data-node-filter=\"Miner\"]').click()");
      saved = await storage(page);

      // One node from its row: its next spawn, named for the node. (The dialog keeps the last range chosen
      // for nodes while the page is open, so it is set here.)
      const id = await page.eval("document.querySelector('#node-list .node-row').dataset.id");
      await open(`[data-cal="node:${id}"]`);
      assert.equal((await view()).ranges.length, 3);
      assert.equal(await page.eval("document.getElementById('calendar-range').value"), '2h', 'the range chosen last for nodes');
      await set('calendar-range', 'next');
      v = await view();
      assert.ok(v.choices[0].startsWith('This node: ') && v.summary.startsWith('1 entry: '), JSON.stringify(v));
      f = await download(`ffxiv-timer-node-${id}-next.ics`);
      assert.equal(f.events, 1);
      await close();

      // Weather transitions: the next match, the matches shown, and one match from its row.
      await open('[data-cal="finder"]');
      v = await view();
      assert.deepEqual(v.ranges, ['next', 'shown']);
      assert.ok(v.choices[0].startsWith('Matches of this search in Eureka Anemos ('));
      await set('calendar-range', 'shown');
      f = await download('ffxiv-timer-transitions-eureka-anemos-matches.ics');
      const shown = await page.eval("document.querySelectorAll('#finder-results .result').length");
      assert.equal(f.events, shown, 'the matches the finder lists');
      assert.ok(f.text.includes('URL:https://radmagelabs.com/ffxiv/#zone=eureka-anemos&fz=eureka-anemos&to=gales&bells=8\r\n'), 'each links to its search');
      await close();
      const second = await page.eval("document.querySelectorAll('#finder-results [data-cal]')[1].dataset.cal");
      await open(`[data-cal="${second}"]`);
      v = await view();
      assert.ok(v.choices[0].startsWith('This match: ') && v.summary.startsWith('1 entry: '), JSON.stringify(v));
      await close();

      // Resets: one row, then every reset listed, with the community-only ones named.
      await open('[data-cal="reset:daily"]');
      v = await view();
      assert.deepEqual(v.choices, ['This reset: Daily reset', 'All resets listed (7)']);
      await set('calendar-range', '7d');
      v = await view();
      assert.ok(v.summary.startsWith('7 entries, from today at 09:00 AM to '), v.summary);
      assert.equal(v.unsure, 'Marked "time unverified" in their titles (community sources only): Daily reset.');
      f = await download('ffxiv-timer-reset-daily-next-7-days.ics');
      assert.equal(f.text.split('SUMMARY:FFXIV: Daily reset (time unverified)').length - 1, 7);
      assert.equal(f.text.split('STATUS:TENTATIVE').length - 1, 7);
      await pick('resets');
      await set('calendar-range', '30d');
      f = await download('ffxiv-timer-resets-next-30-days.ics');
      assert.equal(f.events, entries((await view()).summary));
      assert.ok(!f.text.includes('SUMMARY:FFXIV: Weekly reset (') && f.text.includes('SUMMARY:FFXIV: Weekly reset\r\n'), 'the weekly reset has an official source and no mark');
      await close();

      // The only request was the calendar tool itself, once; nothing was saved or put in the address.
      assert.deepEqual(servers.github.requests.slice(before).map((r) => r.path), ['/ffxiv-timer/js/ics.js'], 'one request: js/ics.js');
      assert.equal(await storage(page), saved, 'no saved setting changed');
      assert.equal(await page.eval('location.href'), href, 'the address is unchanged');
      assert.deepEqual(page.problems, []);
    } finally {
      await chrome.downloadsTo(tmpdir()).catch(() => {});
      rmSync(dl, { recursive: true, force: true });
    }
  });

  await test('Resets in Upcoming: nothing changes until one is starred; a starred reset joins in time order without moving the rest, and reminds', async () => {
    const page = await chrome.newPage();
    await page.viewport(1440, 1000);
    await page.emulate({ timezone: 'America/Chicago', locale: 'en-US' });
    const AT15 = Date.UTC(2026, 10, 17, 15);
    await page.startClockAt(AT15 - 5 * 60000 - 10000); // 14:54:50 UTC, the daily reset in 5 min 10 s
    await page.goto(`${servers.github.origin}/ffxiv-timer/`);
    await page.eval('localStorage.clear()');
    await page.reload();
    await page.waitFor(READY);
    const rows = () => page.eval("[...document.querySelectorAll('#timeline-list li')].map(li => [li.className, li.dataset.at || '', (li.querySelector('.tl-when') || li).textContent + '|' + ((li.querySelector('.tl-what') || {}).textContent || '')])");
    const before = await rows();
    assert.ok(before.length > 3 && before.every(([c]) => !c.includes('tl-reset')), 'no reset in Upcoming until one is starred');
    await page.eval("document.querySelector('[data-reset-star=\"daily\"]').click()");
    const after = await rows();
    const reset = after.filter(([c]) => c.includes('tl-reset'));
    assert.deepEqual(reset.map(([, at, text]) => [Number(at), text]), [[AT15, '09:00 AM15:00 UTC|Daily resettime unverifiedStarred in Resets']]);
    assert.deepEqual(after.filter(([c]) => !c.includes('tl-reset')), before, 'every other row is as it was, in the same order');
    const ats = after.map(([, at]) => Number(at)).filter(Boolean);
    assert.deepEqual(ats, [...ats].sort((a, b) => a - b), 'in time order');
    assert.equal(await page.eval("document.querySelector('[data-reset-star=\"daily\"]').getAttribute('aria-pressed')"), 'true');
    assert.equal(await page.eval(`localStorage.getItem('${PREFIX}resets')`), '{"dataCenter":null,"starred":["daily"],"remindLead":null}', 'the star is saved at once');
    // Reminders for starred resets: 5 minutes before, as a toast.
    await page.eval("{ const s = document.getElementById('reset-remind'); s.value = '5'; s.dispatchEvent(new Event('change')); }");
    assert.equal(await page.eval("document.getElementById('reset-reminder-note').hidden"), false);
    await page.waitFor("document.getElementById('toasts').textContent.includes('Daily reset')", 20000);
    assert.match(await page.eval("document.getElementById('toasts').textContent"), /Daily resetIn (5:00|4:\d\d), at Today 09:00 AM CST \(15:00 UTC\)\. Time unverified: from community sources only\./);
    assert.equal(await page.eval(`localStorage.getItem('${PREFIX}resets')`), '{"dataCenter":null,"starred":["daily"],"remindLead":5}');
    // Its Upcoming row adds just that entry to a calendar.
    await page.eval("document.querySelector('#timeline-list .tl-reset [data-cal]').click()");
    await page.waitFor(CAL_READY);
    assert.deepEqual(await page.eval("[document.querySelector('#calendar-choices label').textContent, document.getElementById('calendar-summary').textContent]"),
      ['This entry: Daily reset', '1 entry: Daily reset, today at 09:00 AM, your time (America/Chicago).']);
    await page.eval("document.getElementById('calendar').close()");
    // Saved across a reload, and unstarring brings Upcoming back as it was.
    await page.reload();
    await page.waitFor(READY);
    assert.equal(await page.eval("document.querySelectorAll('#timeline-list .tl-reset').length"), 1);
    assert.equal(await page.eval("document.getElementById('reset-remind').value"), '5');
    await page.eval("document.querySelector('[data-reset-star=\"daily\"]').click()");
    assert.deepEqual((await rows()).map(([c, at]) => [c, at]), before.map(([c, at]) => [c, at]));
    await page.eval('localStorage.clear()');
    assert.deepEqual(page.problems, []);
  });

  await test('Resets in Upcoming: a reset at the same moment as a weather change comes after it; one past a full list waits its turn', async () => {
    const require = createRequire(import.meta.url);
    const E = require('../js/eorzea.js'), W = require('../js/weather.js'), D = require('../js/weather-data.js');
    const starredZones = ['middle-la-noscea', 'urqopacha', 'eureka-pagos'].map((k) => D.zones.find((z) => z.key === k));
    // What Upcoming lists for the default starred zones (no nodes starred), worked out here from the engines.
    const listed = (now) => {
      const ev = [];
      for (const z of starredZones) for (const p of W.periods(z, now, 7)) if (p.start > now && p.start <= now + 2 * 3600000 && p.weather !== p.previous) ev.push(p.start);
      for (const b of [6, 18]) for (let t = E.nextEtTime(now, b); t <= now + 2 * 3600000; t += E.SUN) ev.push(t);
      return ev.sort((a, b) => a - b);
    };
    const open = async (at) => {
      const page = await chrome.newPage();
      await page.viewport(1440, 1000);
      await page.startClockAt(at);
      await page.goto(`${servers.github.origin}/ffxiv-timer/`);
      await page.eval(`localStorage.clear(); localStorage.setItem('${PREFIX}resets', '{"starred":["daily"]}')`);
      await page.reload();
      await page.waitFor(READY);
      return page;
    };
    const order = (page) => page.eval("[...document.querySelectorAll('#timeline-list li')].map(li => [li.classList.contains('tl-reset') ? 'reset' : li.classList.contains('tl-sun') ? 'sun' : 'other', Number(li.dataset.at || 0)])");
    // 2026-10-24 15:00 UTC is also the start of a weather period: three changes and the daily reset share it.
    const tie = Date.UTC(2026, 9, 24, 15);
    let page = await open(tie - 40 * 60000);
    let rows = await order(page);
    const at = rows.findIndex(([kind]) => kind === 'reset');
    assert.ok(at >= 3 && rows[at][1] === tie && rows.slice(at - 3, at).every(([kind, t]) => kind === 'other' && t === tie), JSON.stringify(rows));
    assert.ok(rows.slice(at + 1).every(([, t]) => t > tie), 'and before anything later');
    // A moment when Upcoming is full (16 events) and its last one comes before the next daily reset, within the two hours.
    let full = null;
    for (let t = Date.UTC(2026, 10, 18, 13, 0); t < Date.UTC(2026, 10, 25) && !full; t += 60000) {
      const reset = Math.ceil((t - 15 * 3600000) / 86400000) * 86400000 + 15 * 3600000;
      const ok = (u) => { const ev = listed(u); return ev.length > 16 && ev[15] < reset && reset <= u + 2 * 3600000; };
      if (reset > t && ok(t) && ok(t + 90000)) full = t;
    }
    assert.ok(full, 'such a moment exists');
    page = await open(full);
    rows = await order(page);
    assert.equal(rows.length, 16, 'the list is full');
    assert.ok(!rows.some(([kind]) => kind === 'reset'), 'the reset is not shown past the last event, leaving a gap before it');
    await page.eval('localStorage.clear()');
    assert.deepEqual(page.problems, []);
  });

  await test('Add to calendar: a starred node that is up now starts at the moment the file is made', async () => {
    const page = await chrome.newPage();
    await page.viewport(1440, 1000);
    await page.startClockAt(T0);
    await page.goto(`${servers.github.origin}/ffxiv-timer/`);
    await page.waitFor(READY);
    const id = await page.eval("document.querySelector('#node-list .node-row[data-up=\"true\"]').dataset.id");
    await page.eval(`document.querySelector('[data-node-star="${id}"]').click()`);
    await page.waitFor(`document.querySelector('#timeline-list .tl-up[data-node="${id}"] [data-cal]')`);
    await page.eval(`document.querySelector('#timeline-list .tl-up[data-node="${id}"] [data-cal]').click()`);
    await page.waitFor(CAL_READY);
    const text = await page.eval("document.getElementById('calendar-summary').textContent");
    assert.match(text, /^1 entry: .*, now, your time \(.+\)\. One is already under way, so it starts now and covers the rest\.$/);
    // Left open, the summary is worked out again as time passes (every 15 s), but the controls are not
    // redrawn under someone choosing: the same option elements stay.
    await page.eval("document.querySelector('#calendar-range option').dataset.mark = 'kept'; document.querySelector('[name=\"calendar-choice\"]').dataset.mark = 'kept'; document.getElementById('calendar-summary').textContent = 'stale'");
    await sleep(16000);
    assert.equal(await page.eval("document.querySelector('#calendar-range option').dataset.mark + document.querySelector('[name=\"calendar-choice\"]').dataset.mark"), 'keptkept');
    assert.match(await page.eval("document.getElementById('calendar-summary').textContent"), /^1 entry: /, 'the summary was worked out again');
    // What the page would write, read back here: no start before now, the real start kept in the UID.
    const file = await page.eval("(() => { const n = FFXIV_GATHERING_DATA.nodes.find(x => x.id === " + id + "), now = Date.now(); const s = XivGathering.status(n, now); return { now, start: s.start, text: XivIcs.build({ data: { weather: FFXIV_WEATHER_DATA, gathering: FFXIV_GATHERING_DATA }, engines: { weather: XivWeather, gathering: XivGathering }, source: 'upcoming', range: 'listed', now, alarmMin: 10, items: [{ node: n, window: { start: s.start, end: s.end } }] }).text }; })()");
    const start = /DTSTART:(\d{8}T\d{6}Z)/.exec(file.text)[1], uid = /UID:node-\d+-(\d{8}T\d{6}Z)@/.exec(file.text)[1];
    const ms = (s) => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(9, 11), +s.slice(11, 13), +s.slice(13, 15));
    assert.ok(ms(start) >= file.now && ms(start) - file.now < 1000, 'starts now');
    assert.equal(ms(uid), file.start, 'the UID keeps the window\'s own start');
    assert.ok(file.text.includes('DESCRIPTION:Already under way when this file was made') && !file.text.includes('VALARM'), 'says so, with no alarm');
    await page.eval(`document.querySelector('[data-node-star="${id}"]').click()`);
    assert.deepEqual(page.problems, []);
  });

  await test('the About dialog opens and lists sources', async () => {
    const page = await chrome.newPage();
    await page.viewport(1440, 1000);
    await page.goto(`${servers.github.origin}/ffxiv-timer/`);
    await page.waitFor(READY);
    if (shots) await page.screenshot(join(shots, 'desktop.png'), true);
    await page.eval("document.getElementById('about-open').click()");
    await page.waitFor("document.getElementById('about').open");
    const text = await page.eval("document.getElementById('about-body').textContent");
    assert.match(text, /SQUARE ENIX/);
    assert.match(text, /xivapi\/ffxiv-datamining/);
    const count = JSON.parse(readFileSync(join(ROOT, 'data', 'supported-zones.json'), 'utf8')).zones.length;
    assert.ok(text.includes(`Zones with forecasts (${count})`), `About lists ${count} zones`);
    if (shots) await page.screenshot(join(shots, 'about.png'));
  });

  await test('Latest news: closed and silent until opened, then Lodestone headlines, remembered open or closed', async () => {
    const page = await chrome.newPage();
    await page.viewport(1440, 1000);
    const fetched = () => servers.proxy.requests.filter((r) => r.path.includes('/news/')).length;
    const items = "document.querySelectorAll('#news .news-list li').length";
    await page.goto(`${servers.proxy.origin}/ffxiv/`);
    await page.waitFor(READY);
    assert.equal(await page.eval("document.getElementById('news').open"), false);
    assert.equal(fetched(), 0, 'nothing is requested while the bar is closed');
    await page.eval("document.querySelector('#news summary').click()");
    await page.waitFor(`${items} === 10`);
    assert.equal(fetched(), 2);
    assert.deepEqual(await page.eval("[...document.querySelectorAll('#news .news-col h3')].map(h => h.textContent)"), ['Topics', 'Notices and maintenance']);
    assert.match(await page.eval("document.querySelector('#news [data-feed=\"topics\"] li').textContent"), /^Announcing the Fan Festival Group Pose Screenshot Campaign!/);
    assert.match(await page.eval("document.querySelector('#news [data-feed=\"news\"] li').textContent"), /^Companion App Emergency Maintenance \(Oct\. 21\): Follow-up 2Maintenance/);
    const links = await page.eval("[...document.querySelectorAll('#news a')].map(a => [a.href, a.target, a.rel])");
    assert.ok(links.length === 11 && links.every(([href, target, rel]) => href.startsWith('https://na.finalfantasyxiv.com/lodestone/') && target === '_blank' && rel.includes('noopener')), JSON.stringify(links));
    assert.match(await page.eval("document.getElementById('news-note').textContent"), /^Headlines from the official Lodestone, checked /);
    if (shots) await page.screenshot(join(shots, 'news.png'));
    // Left open, it opens again on reload with the cached headlines, without asking again.
    await page.reload();
    await page.waitFor(READY);
    await page.waitFor(`document.getElementById('news').open && ${items} === 10`);
    assert.equal(fetched(), 2, 'the cached headlines are reused');
    await page.viewport(390, 844, true);
    await page.waitFor('innerWidth === 390');
    assert.deepEqual(await page.eval("[...document.querySelectorAll('#news *')].filter(n => n.getBoundingClientRect().right > innerWidth + 1).map(n => n.tagName)"), [], 'news fits a phone');
    if (shots) await page.screenshot(join(shots, 'news-phone.png'));
    await page.eval("document.querySelector('#news summary').click()");
    await page.waitFor(`localStorage.getItem('${PREFIX}newsOpen') === 'false'`);
    await page.reload();
    await page.waitFor(READY);
    assert.equal(await page.eval("document.getElementById('news').open"), false);
    assert.deepEqual(page.problems, []);
  });

  await test('Latest news on GitHub Pages: no feeds there, so it points to radmagelabs.com/ffxiv/ and the Lodestone', async () => {
    const page = await chrome.newPage();
    await page.goto(`${servers.github.origin}/ffxiv-timer/`);
    await page.waitFor(READY);
    await page.eval("document.querySelector('#news summary').click()");
    await page.waitFor("document.getElementById('news-note').textContent.includes('radmagelabs.com/ffxiv/')");
    assert.equal(await page.eval("document.querySelectorAll('#news .news-list li').length"), 0);
    assert.deepEqual(await page.eval("[...document.querySelectorAll('#news a')].map(a => a.href)"), ['https://radmagelabs.com/ffxiv/', 'https://na.finalfantasyxiv.com/lodestone/']);
    assert.ok(page.problems.length === 2 && page.problems.every((p) => /^HTTP 404 .*\/ffxiv-timer\/news\/(topics|news)\.xml$/.test(p)), JSON.stringify(page.problems));
    assert.deepEqual(servers.github.outside(), []);
    await page.eval("document.querySelector('#news summary').click()");
    await page.waitFor(`localStorage.getItem('${PREFIX}newsOpen') === 'false'`);
  });

  await test('Latest news: a failed fetch is invisible; the last good headlines stay and it tries again soon', async () => {
    const page = await chrome.newPage();
    await page.viewport(1440, 1000);
    const hits = () => servers.flaky.requests.filter((r) => r.path.includes('/news/'));
    const items = "document.querySelectorAll('#news .news-list li').length";
    const note = "document.getElementById('news-note').textContent";
    const firstTopic = "document.querySelector('#news [data-feed=\"topics\"] li a').textContent";
    // Nothing saved and the first round fails: it says it is loading, and the retry 5 s later fills it in.
    blips = 2;
    await page.goto(`${servers.flaky.origin}/ffxiv/`);
    await page.waitFor(READY);
    await page.eval("document.querySelector('#news summary').click()");
    await until(() => hits().length === 2);
    await sleep(300);
    assert.equal(await page.eval(items), 0);
    assert.match(await page.eval(note), /^Loading the newest headlines/, 'no error after one failed round');
    await page.waitFor(`${items} === 10`, 10000);
    assert.deepEqual(hits().map((r) => r.status), [503, 503, 200, 200]);
    assert.match(await page.eval(note), /^Headlines from the official Lodestone, checked /);
    // Saved headlines older than 15 minutes and the refresh fails: they stay, with no error, until the retry replaces them.
    await page.eval(`{ const k = '${PREFIX}news', c = JSON.parse(localStorage.getItem(k)); c.fetchedAt -= 20 * 60000; c.feeds.topics[0].title = 'Saved headline'; localStorage.setItem(k, JSON.stringify(c)); }`);
    blips = 2;
    await page.reload();
    await page.waitFor(`document.getElementById('news').open && ${items} === 10`);
    await until(() => hits().length === 6);
    await sleep(300);
    assert.equal(await page.eval(items), 10);
    assert.equal(await page.eval(firstTopic), 'Saved headline', 'the saved headlines stay up');
    assert.match(await page.eval(note), /^Headlines from the official Lodestone, checked /, 'and no error is shown');
    await page.waitFor(`${firstTopic} === 'Announcing the Fan Festival Group Pose Screenshot Campaign!'`, 10000);
    assert.equal(hits().length, 8);
    // Nothing saved and it keeps failing: after two failed rounds it says so, and keeps trying.
    await page.eval('localStorage.clear()');
    blips = 100;
    await page.reload();
    await page.waitFor(READY);
    await page.eval("document.querySelector('#news summary').click()");
    await page.waitFor(`${note}.startsWith('News could not load just now and will try again shortly.')`, 10000);
    assert.equal(hits().length, 12, 'two failed rounds');
    assert.equal(await page.eval(items), 0);
    blips = 0;
    // The only problems are the eight 503s and Chrome's console line for each.
    const http = page.problems.filter((p) => p.startsWith('HTTP '));
    assert.ok(http.length === 8 && http.every((p) => /^HTTP 503 .*\/ffxiv\/news\/(topics|news)\.xml$/.test(p)), JSON.stringify(http));
    assert.ok(page.problems.filter((p) => !p.startsWith('HTTP ')).every((p) => /^log: Failed to load resource: .*status of 503/.test(p)), JSON.stringify(page.problems));
    await page.eval("document.querySelector('#news summary').click()");
  });
  await test('Latest news: a recent maintenance headline is flagged on the bar, open or closed, without asking for anything more', async () => {
    const page = await chrome.newPage();
    await page.viewport(1440, 1000);
    const fetched = () => servers.proxy.requests.filter((r) => r.path.includes('/news/')).length;
    const flag = "document.getElementById('news-flag')";
    await page.startClockAt(Date.UTC(2026, 9, 24)); // the day after the saved feeds' maintenance notices
    await page.goto(`${servers.proxy.origin}/ffxiv/`);
    await page.eval('localStorage.clear()');
    await page.reload();
    await page.waitFor(READY);
    assert.equal(await page.eval(`${flag}.hidden`), true, 'nothing saved, nothing flagged');
    const start = fetched();
    await page.eval("document.querySelector('#news summary').click()");
    await page.waitFor("document.querySelectorAll('#news .news-list li').length === 10");
    assert.equal(await page.eval(`${flag}.hidden`), false);
    assert.equal(await page.eval(`${flag}.textContent`), 'MaintenanceCompanion App Emergency Maintenance (Oct. 21): Follow-up 2and 2 more');
    assert.equal(await page.eval("document.querySelectorAll('#news [data-feed=\"news\"] .badge.tag.maint').length"), 3);
    if (shots) await page.screenshot(join(shots, 'news-maintenance.png'));
    // Closed, after a reload: the flag stays, from the headlines saved here, and nothing more is asked for.
    await page.eval("document.querySelector('#news summary').click()");
    await page.reload();
    await page.waitFor(READY);
    assert.equal(await page.eval("document.getElementById('news').open"), false);
    assert.match(await page.eval(`${flag}.textContent`), /^MaintenanceCompanion App Emergency Maintenance/);
    assert.equal(fetched(), start + 2, 'only the two feeds, once, when the bar was opened');
    // Saved headlines more than a day old are not trusted for the flag.
    await page.eval(`{ const k = '${PREFIX}news', c = JSON.parse(localStorage.getItem(k)); c.fetchedAt -= 25 * 3600000; localStorage.setItem(k, JSON.stringify(c)); }`);
    await page.reload();
    await page.waitFor(READY);
    assert.equal(await page.eval(`${flag}.hidden`), true);
    assert.equal(fetched(), start + 2);
    // A week after they were posted, the same headlines are listed with their category but no flag or mark.
    const later = await chrome.newPage();
    await later.viewport(1440, 1000);
    await later.startClockAt(Date.UTC(2026, 9, 31));
    await later.goto(`${servers.proxy.origin}/ffxiv/`);
    await later.waitFor(READY);
    await later.eval("document.querySelector('#news summary').click()");
    await later.waitFor("document.querySelectorAll('#news .news-list li').length === 10");
    assert.equal(await later.eval(`${flag}.hidden`), true);
    assert.equal(await later.eval("document.querySelectorAll('#news .badge.tag.maint').length"), 0, 'no mark on old maintenance headlines');
    assert.equal(await later.eval("[...document.querySelectorAll('#news .badge.tag')].filter(b => b.textContent === 'Maintenance').length"), 3, 'their category is still shown');
    await later.eval("document.querySelector('#news summary').click()");
    assert.deepEqual(later.problems, []);
    await page.viewport(390, 844, true);
    assert.deepEqual(await page.eval("[...document.querySelectorAll('#news *')].filter(n => n.getBoundingClientRect().right > innerWidth + 1).map(n => n.tagName)"), []);
    await page.eval('localStorage.clear()');
    assert.deepEqual(page.problems, []);
  });

  // ---- Market & Crafting groundwork (v0.11.0 Phase 0): nothing visible yet ----
  await test('everything above, on every host: no price request and no market file was ever asked for', async () => {
    const all = Object.values(servers).flatMap((s) => s.requests);
    assert.ok(all.length > 100, `requests seen: ${all.length}`);
    assert.deepEqual(all.filter((r) => /\/prices\/|market-items\.js|router\.js/.test(r.path)), []);
    assert.equal(prices.calls.length, 0);
  });

  await test('fake Universalis at radmagelabs.com/ffxiv/prices/: answers next to the page in Chrome, fails on request; GitHub Pages has no prices', async () => {
    const page = await chrome.newPage();
    await page.goto(`${servers.proxy.origin}/ffxiv/`);
    await page.waitFor(READY);
    const ask = (path) => page.eval(`fetch(${JSON.stringify(path)}).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }), (e) => ({ status: 0, error: e.name }))`);
    let r = await ask('prices/aggregated/Aether/2,5057,30000');
    assert.equal(r.status, 200);
    assert.deepEqual([r.json.results.map((x) => x.itemId), r.json.failedItems], [[2, 5057], [30000]]);
    r = await ask('prices/item/Gilgamesh/5057');
    assert.deepEqual([r.status, r.json.itemID, r.json.worldName], [200, 5057, 'Gilgamesh']);
    assert.equal((await ask('prices/aggregated/Aether/2/../../worlds')).status, 404);
    prices.failNext({ status: 503 });
    assert.equal((await ask('prices/aggregated/Aether/2')).status, 503);
    assert.deepEqual(prices.calls.map((c) => c.kind), ['aggregated', 'item', 'aggregated'], 'the refused path never reached upstream');
    // Chrome quietly retries a request on another kept-alive connection when one drops before any answer
    // (seen here: 3 attempts for one fetch), so a dropped connection reaches the page only when every
    // retry drops too. The page sees it as a network error, like being offline.
    prices.failNext({ offline: true }, 10);
    assert.equal((await ask('prices/aggregated/Aether/2')).error, 'TypeError');
    prices.reset();
    await page.offline(true);
    assert.equal((await ask('prices/aggregated/Aether/2')).error, 'TypeError', 'offline');
    assert.equal(prices.calls.length, 0, 'nothing left the browser');
    await page.offline(false);
    assert.equal((await ask('prices/aggregated/Aether/2')).status, 200, 'fine again after');
    assert.deepEqual(servers.proxy.outside(), []);
    const pagesSite = await chrome.newPage();
    await pagesSite.goto(`${servers.github.origin}/ffxiv-timer/`);
    await pagesSite.waitFor(READY);
    assert.equal(await pagesSite.eval("fetch('prices/aggregated/Aether/2').then((r) => r.status)"), 404);
    prices.reset();
  });

} finally {
  await chrome.close();
  await Promise.all(Object.values(servers).map((s) => s.close()));
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
