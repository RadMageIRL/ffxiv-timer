// Takes the README screenshot: screenshots/ffxiv-timer.png.
//
//   node tools/screenshot.mjs
//
// The GitHub Pages build in headless Chrome, a fresh profile (so the default starred zones),
// 1440 wide, en-US in the Europe/London time zone, with the clock started at a fixed moment so the
// image can be taken again exactly: ET 12:05 on the 17th Sun of the 4th Umbral Moon, Rain in
// Middle La Noscea, Snow in Urqopacha, Blizzards in Eureka Pagos. Cropped below the fifth zone.
// Retake it whenever the dashboard's look changes.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchChrome } from '../tests/lib/cdp.mjs';
import { build, ROOT } from './build.mjs';
import { serve } from './lib/static-server.mjs';

const AT = Date.parse('2026-10-24T08:35:16Z');
const tmp = mkdtempSync(join(tmpdir(), 'ffxiv-timer-shot-'));
const pages = build('pages', { outRoot: tmp });
const server = await serve({ mounts: [{ prefix: '/ffxiv-timer/', dir: pages.appDir, notFound: '404.html' }] });
const chrome = await launchChrome();
try {
  const page = await chrome.newPage();
  await page.viewport(1440, 1100);
  await page.emulate({ timezone: 'Europe/London', locale: 'en-US' });
  await page.startClockAt(AT);
  await page.goto(`${server.origin}/ffxiv-timer/#zone=eureka-pagos&fz=eureka-pagos&prev=fog&to=heat-waves`);
  await page.waitFor("document.querySelectorAll('#zone-list .zone-row').length > 0 && /^\\d\\d:\\d\\d$/.test(document.getElementById('et-time').textContent)");
  await new Promise((r) => setTimeout(r, 500));
  mkdirSync(join(ROOT, 'screenshots'), { recursive: true });
  const out = join(ROOT, 'screenshots', 'ffxiv-timer.png');
  const bottom = await page.eval("Math.ceil(document.querySelectorAll('#zone-list .zone-row')[4].getBoundingClientRect().bottom) + 14");
  await page.screenshot(out, { height: bottom });
  console.log(`wrote ${out}`);
} finally {
  await chrome.close();
  await server.close();
  rmSync(tmp, { recursive: true, force: true });
}
