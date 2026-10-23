// Checks the deployed site at every public address of the "pages" target (deploy/targets.json)
// in headless Chrome, against this checkout's own engines and data:
//
//   node tools/verify-live.mjs
//
// For each address: assets load from inside the base path with version stamps and the canonical
// link; navigation, shared links, reload, a missing trailing slash and a mistyped path all land
// on the app; storage is namespaced and survives a reload; the ET clock, current weather and
// gathering status on screen equal what js/eorzea.js, js/weather.js and js/gathering.js compute
// for the page's own clock; and a reminder for a starred node shows a toast and creates a system
// notification once the browser grants permission. Then the radmagelabs.com homepage's FFXIV
// link is followed to make sure it opens the timer.
//
// This checks the deployed copy against the reference engines in this repo. It says nothing
// about whether the game agrees; that is in-game validation, which is separate.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { launchChrome } from '../tests/lib/cdp.mjs';
import { ROOT, TARGETS } from './build.mjs';

const require = createRequire(import.meta.url);
const E = require('../js/eorzea.js'), W = require('../js/weather.js'), G = require('../js/gathering.js');
const WD = require('../js/weather-data.js'), NODES = require('../js/gathering-data.js').nodes;
const URLS = TARGETS.targets.pages.urls;
const LABS_HOME = 'https://radmagelabs.com/';
// The deployed page carries this checkout's title.
const TITLE = readFileSync(join(ROOT, 'index.html'), 'utf8').match(/<title>([^<]*)<\/title>/)[1].replace(/&amp;/g, '&');
const READY = "/^\\d\\d:\\d\\d$/.test(document.getElementById('et-time').textContent) && document.querySelectorAll('#zone-list .zone-row').length > 0 && document.querySelectorAll('#node-list .node-row').length > 0";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`ok   ${name}`); } catch (e) { failed++; console.error(`FAIL ${name}\n  ${String(e.message).split('\n').join('\n  ')}`); }
}

// Waits until the page is not within `margin` ms of a weather or node boundary, so the page and
// the engine are asked about the same window.
async function steadyNow(page, margin = 4000) {
  for (;;) {
    const now = await page.eval('Date.now()');
    const edges = [E.nextPeriod(now), E.nextBell(now), ...NODES.map((n) => { const s = G.status(n, now); return s.up ? s.end : s.start; })];
    if (edges.every((t) => t - now > margin)) return now;
    await sleep(margin);
  }
}

const chrome = await launchChrome();
try {
  for (const url of URLS) {
    const { origin, pathname: base } = new URL(url);
    const page = await chrome.newPage();
    await page.viewport(1440, 1000);
    const inBase = () => {
      const stray = page.requests.filter((r) => r.startsWith(origin) && !new URL(r).pathname.startsWith(base));
      assert.deepEqual(stray, [], 'requests outside the base path');
    };

    await check(`${url}: loads, every asset from inside ${base}, versioned, canonical set`, async () => {
      await page.goto(url);
      await page.waitFor(READY, 20000);
      inBase();
      assert.deepEqual(page.problems, [], 'failed requests or errors');
      assert.equal(await page.eval("document.querySelector('link[rel=canonical]').href"), TARGETS.canonical);
      const scripts = await page.eval("[...document.scripts].filter(s => s.src).map(s => s.src)");
      assert.ok(scripts.length >= 9 && scripts.every((s) => /\?v=[0-9a-f]{10}$/.test(s) && new URL(s).pathname.startsWith(base)), JSON.stringify(scripts));
      assert.equal(await page.eval('document.title'), TITLE);
      // The deployed copy is this checkout's: same zones and nodes (All nodes lists every one).
      await page.eval("document.querySelector('[data-node-view=\"all\"]')?.click()");
      assert.equal(await page.eval("document.querySelectorAll('#node-list .node-row').length"), NODES.length, 'deployed node count');
      assert.equal(await page.eval("document.querySelectorAll('#forecast-zone option[value]:not([value=\"\"])').length"), WD.zones.length, 'deployed zone count');
    });

    await check(`${url}: ET clock, current weather and gathering status match the engines`, async () => {
      const now = await steadyNow(page);
      const c = E.clock(now), shown = await page.eval("document.getElementById('et-time').textContent");
      const [h, m] = shown.split(':').map(Number);
      assert.ok(Math.abs((h * 60 + m) - (c.bell * 60 + c.minute)) <= 1, `ET ${shown} vs ${E.formatEt(c.bell, c.minute)}`);
      for (const key of ['middle-la-noscea', 'urqopacha', 'eureka-pagos', 'kugane', 'garlemald']) {
        const zone = WD.zones.find((z) => z.key === key);
        const onPage = await page.eval(`document.querySelector('[data-open="${key}"]').closest('.zone-row').querySelector('.zone-now .wx-n').textContent`);
        assert.equal(onPage, WD.weathers[W.weatherAt(zone, now)], key);
      }
      for (const n of NODES.slice(0, 8)) {
        const row = await page.eval(`document.querySelector('[data-node-star="${n.id}"]').closest('.node-row').className`);
        assert.equal(/\bup\b/.test(row), G.status(n, now).up, `node ${n.id}`);
      }
    });

    await check(`${url}: navigation, a shared link and reload`, async () => {
      for (const id of ['gathering', 'forecast', 'finder', 'now']) {
        await page.eval(`document.querySelector('[data-jump="${id}"]').click()`);
        await page.waitFor(`Math.abs(document.getElementById('${id}').getBoundingClientRect().top) < 120`, 5000);
      }
      await page.goto(`${url}#zone=eureka-pagos&fz=eureka-anemos&to=gales`);
      const state = "document.getElementById('forecast-zone').value === 'eureka-pagos' && document.querySelectorAll('#finder-results .result').length > 0";
      await page.waitFor(state);
      await page.reload();
      await page.waitFor(state);
      inBase();
    });

    await check(`${url}: storage is namespaced and survives a reload`, async () => {
      await page.eval("document.querySelector('[data-star=\"kozamauka\"]').click()");
      await page.reload();
      await page.waitFor(READY);
      assert.equal(await page.eval("document.querySelector('[data-star=\"kozamauka\"]').getAttribute('aria-pressed')"), 'true');
      const keys = await page.eval('Object.keys(localStorage)');
      assert.ok(keys.length && keys.every((k) => k.startsWith('ffxiv-timer:v1:')), JSON.stringify(keys));
      await page.eval("localStorage.clear()");
    });

    await check(`${url}: without the trailing slash, and a mistyped path, both land on the app`, async () => {
      await page.goto(`${origin}${base.slice(0, -1)}#zone=urqopacha`);
      await page.waitFor(`location.pathname === ${JSON.stringify(base)} && document.getElementById('forecast-zone').value === 'urqopacha'`, 15000);
      page.problems.length = 0;
      await page.goto(`${url}no/such/page#zone=eureka-pyros`);
      await page.waitFor(`location.pathname === ${JSON.stringify(base)} && document.getElementById('forecast-zone').value === 'eureka-pyros'`, 15000);
      assert.ok(page.problems.every((p) => /404/.test(p)), JSON.stringify(page.problems));
    });

    await check(`${url}: a reminder shows a toast and a system notification`, async () => {
      const alumen = NODES.find((n) => n.items.some((i) => i.name === 'Turali Alumen'));
      const spawn = G.upcoming(alumen, Date.now() + 3600000, 1)[0].start;
      await chrome.grantNotifications(origin);
      const p2 = await chrome.newPage();
      await p2.startClockAt(spawn - 50000);
      // Record notifications the page creates, then let the real one through.
      await p2.beforeLoad("(() => { const Real = window.Notification; window.__shown = []; if (!Real) return; window.Notification = class extends Real { constructor(t, o) { super(t, o); window.__shown.push([t, o && o.body]); } }; })();");
      await p2.goto(url);
      await p2.waitFor(READY, 20000);
      assert.equal(await p2.eval('Notification.permission'), 'granted');
      await p2.eval(`document.querySelector('[data-node-star="${alumen.id}"]').click()`);
      await p2.eval("{ const r = document.getElementById('remind-lead'); r.value = '1'; r.dispatchEvent(new Event('change')); }");
      await p2.waitFor("document.getElementById('toasts').textContent.includes('Turali Alumen')", 8000);
      const shown = await p2.eval('window.__shown');
      assert.ok(shown.some(([t, body]) => t === 'Turali Alumen' && /Urqopacha/.test(body)), JSON.stringify(shown));
      assert.match(await p2.eval("document.getElementById('reminder-note').textContent"), /only work while this page is open.*Notifications are allowed/s);
      assert.deepEqual(p2.problems, []);
    });
  }

  await check(`${LABS_HOME}: the FFXIV link opens the timer`, async () => {
    const page = await chrome.newPage();
    await page.goto(LABS_HOME);
    const links = await page.eval("[...document.querySelectorAll('a[href]')].map(a => a.href).filter(h => /\\/ffxiv\\/?$/.test(new URL(h).pathname))");
    assert.ok(links.length > 0, 'no link to /ffxiv/ on the homepage');
    // A link that opens a new tab is followed in this one; otherwise it is clicked.
    const target = await page.eval("[...document.querySelectorAll('a[href]')].find(a => /\\/ffxiv\\/?$/.test(new URL(a.href).pathname)).target");
    if (target === '_blank') await page.goto(links[0]);
    else await page.eval("[...document.querySelectorAll('a[href]')].find(a => /\\/ffxiv\\/?$/.test(new URL(a.href).pathname)).click()");
    await page.waitFor(`location.href === ${JSON.stringify(URLS.find((u) => u.startsWith('https://radmagelabs.com')))} && document.title === ${JSON.stringify(TITLE)}`, 20000);
    await page.waitFor(READY, 20000);
    console.log(`     homepage links: ${links.join(', ')}`);
  });
} finally {
  await chrome.close();
}
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
