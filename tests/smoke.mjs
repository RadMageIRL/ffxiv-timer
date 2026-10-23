// Browser smoke and base-path tests. Run with `node tests/smoke.mjs`; needs Chrome (or set
// CHROME_PATH). `--shots DIR` also saves desktop and phone screenshots.
//
// The deployed build is served the ways it is reached in public, each imitated by a local server
// that refuses anything outside its base path:
//   GitHub Pages        /ffxiv-timer/  (301 adds the trailing slash, missing files get 404.html)
//   radmagelabs.com     /ffxiv/        the same files through the Labs proxy
//   proxy, no redirect  /ffxiv/        a host that serves the bare /ffxiv; the page must fix it
//   standalone labs     /ffxiv/        the labs build, for a host that serves the files itself
//   development         /dev/deep/path/ and file://   the source tree, unbuilt
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from '../tools/build.mjs';
import { findChrome, launchChrome } from './lib/cdp.mjs';
import { serve } from '../tools/lib/static-server.mjs';

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

const tmp = mkdtempSync(join(tmpdir(), 'ffxiv-timer-smoke-'));
const pages = build('pages', { outRoot: tmp }), labs = build('labs', { outRoot: tmp });
const servers = {
  github: await serve({ mounts: [{ prefix: '/ffxiv-timer/', dir: pages.appDir, notFound: '404.html' }] }),
  proxy: await serve({ mounts: [{ prefix: '/ffxiv/', dir: pages.appDir, notFound: '404.html' }] }),
  bare: await serve({ mounts: [{ prefix: '/ffxiv/', dir: pages.appDir, notFound: '404.html' }], slash: 'none' }),
  labs: await serve({ mounts: [{ prefix: '/ffxiv/', dir: labs.appDir, notFound: '404.html' }] }),
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
      assert.equal(await page.eval("document.getElementById('data-patch').textContent"), '7.57h1');
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
    assert.deepEqual(page.problems, []);
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
} finally {
  await chrome.close();
  await Promise.all(Object.values(servers).map((s) => s.close()));
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
