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
    const wide = await page.eval("[...document.querySelectorAll('body *')].filter(n => n.getBoundingClientRect().right > innerWidth + 1 && !n.closest('.table-wrap, .jump')).map(n => n.tagName + '.' + n.className).slice(0, 5)");
    assert.deepEqual(wide, [], 'elements past the right edge');
    assert.ok(await page.eval('document.documentElement.scrollWidth <= innerWidth'), 'page scrolls sideways');
    if (shots) {
      mkdirSync(shots, { recursive: true });
      await page.screenshot(join(shots, 'phone.png'), true);
    }
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
