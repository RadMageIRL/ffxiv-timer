// Captures the Universalis answers the tests read, once, into tests/fixtures/universalis/.
//
//   node tools/capture-universalis.mjs
//
// Test data only: none of these files is part of the page or the deployed build, and the page
// never ships prices of its own. Every request is a plain GET of exactly the upstream URL the
// price rules use (radmagelabs/api/_ffxiv-prices/contract.mjs), so the item answers carry only the pinned
// fields, as the page will receive them. manifest.json records what was asked and when.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './lib/gamedata.mjs';
import { UPSTREAM, upstreamFor } from '../radmagelabs/api/_ffxiv-prices/contract.mjs';

export const DIR = join(ROOT, 'tests', 'fixtures', 'universalis');
// Shapes the parsers must handle: a cheap, fast-selling material without HQ (Fire Shard, Fire
// Cluster), an HQ-capable one (Iron Ingot), an ore, a dye, current-tier materia and medicine,
// old items with thin data (Phallaina, a 7.0 painting, old housing), and ids that are not on the
// market board at all (1 is gil; 30000 is not an item).
export const IDS = [1, 2, 14, 5057, 5121, 13115, 30000, 36521, 41773, 44162, 6544, 7008, 24511];
const AGENT = 'Mozilla/5.0 (compatible; test-client)';

async function get(url) {
  const res = await fetch(url, { headers: { 'user-agent': AGENT } });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch (e) { body = text; }
  return { status: res.status, type: res.headers.get('content-type'), body };
}

async function main() {
  mkdirSync(DIR, { recursive: true });
  const manifest = { capturedAt: new Date().toISOString(), upstream: UPSTREAM, files: {} };
  const save = async (name, url, { pretty = true } = {}) => {
    const r = await get(url);
    writeFileSync(join(DIR, `${name}.json`), `${pretty ? JSON.stringify(r.body, null, 1) : JSON.stringify(r.body)}\n`);
    manifest.files[name] = { url, status: r.status, contentType: r.type };
    console.log(`${String(r.status).padEnd(4)} ${name}`);
    await new Promise((ok) => setTimeout(ok, 300)); // a gentle pace for a one-off run
  };
  const ids = IDS.join(',');
  // Build-time cross-checks only.
  await save('marketable', `${UPSTREAM}/marketable`, { pretty: false });
  await save('data-centers', `${UPSTREAM}/data-centers`);
  await save('worlds', `${UPSTREAM}/worlds`, { pretty: false });
  // What the page receives, one file per shape.
  await save('aggregated-dc', upstreamFor(`aggregated/Aether/${ids}`).url);
  await save('aggregated-region', upstreamFor(`aggregated/North-America/${ids}`).url);
  await save('aggregated-world', upstreamFor(`aggregated/Gilgamesh/${ids}`).url);
  await save('item-dc-hq', upstreamFor('item/Aether/5057').url);
  await save('item-dc-nq', upstreamFor('item/Aether/2').url);
  await save('item-world', upstreamFor('item/Gilgamesh/5057').url);
  await save('item-thin', upstreamFor('item/Aether/36521').url);
  // An item with no listings or sales on Materia when captured (5849 Pristine Archon Egg, seasonal):
  // aggregated gives empty objects and no worldUploadTimes; details give empty lists and zeros.
  await save('aggregated-empty', upstreamFor('aggregated/Materia/2,5849').url);
  await save('item-empty', upstreamFor('item/Materia/5849').url);
  await save('tax-gilgamesh', upstreamFor('tax/63').url);
  await save('error-unknown-scope', upstreamFor('aggregated/Nowhere/5057').url);
  writeFileSync(join(DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

await main();
