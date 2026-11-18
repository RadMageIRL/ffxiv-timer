// Checks js/recipes.js against a second, independent extraction of the game data: XIVAPI v2 (v2.xivapi.com), which
// reads the game files with its own code and schema. A fixed sample of recipes (every 250th by id, plus the cases
// most likely to go wrong: yields above 1, expert, specialist and master-book recipes, items with recipes on
// several jobs, the deepest tree, the recipes with an ingredient that is not on the market board) must agree on
// result, job, yield, recipe level with its job level and stars, flags, master book, HQ material factor,
// craftsmanship and control, and every ingredient with its amount, in slot order.
//
//   node tools/verify-recipes.mjs                  compare (needs network)
//   node tools/verify-recipes.mjs --write-fixture  also save the capture to tests/fixtures/
//
// The fixture lets the tests repeat the comparison offline.
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './lib/gamedata.mjs';
import { compareRecipesXivapi } from './lib/compare-recipes.mjs';
import { decodeRecipes, FLAG } from './build-recipes.mjs';

const XIVAPI_VERSION = '7.58';
const data = createRequire(import.meta.url)('../js/recipes.js');

// Items whose recipes are always in the sample: Bronze Ingot (BSM and ARM), Mythril Ingot (three jobs), Table Salt
// (makes 6), Camping Furniture (the longest chain), Glamour Prism and Island Prism (different materials per job),
// High House Supper Set (the most craftable steps), Crumbling Aqueduct (the most market items in one tree).
export const SAMPLE_ITEMS = [5056, 5065, 4847, 38623, 21800, 38536, 14053, 51272];

export function sampleIds(recipes) {
  const ids = new Set();
  recipes.forEach((r, i) => { if (i % 250 === 0) ids.add(r.id); });
  const pick = (test, n) => { let k = 0; for (const r of recipes) if (test(r) && k < n) { ids.add(r.id); k++; } };
  pick((r) => r.yield > 1, 6);
  pick((r) => r.flags & FLAG.expert, 4);
  pick((r) => r.flags & FLAG.specialist, 3);
  pick((r) => r.book, 4);
  pick((r) => r.craftsmanship > 0, 3);
  const extra = new Set(data.extra.map(([id]) => id));
  for (const r of recipes) if (r.ings.some(([i]) => extra.has(i)) || SAMPLE_ITEMS.includes(r.result)) ids.add(r.id);
  return [...ids].sort((a, b) => a - b);
}

async function getJson(url) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url);
    if (res.ok) return res.json();
    if (attempt === 3) throw new Error(`${url}: HTTP ${res.status}`);
    await new Promise((r) => setTimeout(r, 1000 * attempt));
  }
}

async function capture(ids) {
  const fields = ['ItemResult@as(raw)', 'AmountResult', 'Ingredient@as(raw)', 'AmountIngredient', 'CraftType@as(raw)',
    'RecipeLevelTable@as(raw)', 'RecipeLevelTable.ClassJobLevel', 'RecipeLevelTable.Stars', 'CanHq', 'CanQuickSynth',
    'IsExpert', 'IsSpecializationRequired', 'SecretRecipeBook@as(raw)', 'MaterialQualityFactor', 'RequiredCraftsmanship',
    'RequiredControl'].join(',');
  const out = [];
  let schema = null;
  for (let i = 0; i < ids.length; i += 50) {
    const rows = ids.slice(i, i + 50).join(',');
    const page = await getJson(`https://v2.xivapi.com/api/sheet/Recipe?rows=${rows}&fields=${encodeURIComponent(fields)}&version=${XIVAPI_VERSION}`);
    schema = page.schema;
    for (const r of page.rows) {
      const f = r.fields;
      out.push({
        id: r.row_id, result: f['ItemResult@as(raw)'], job: f['CraftType@as(raw)'], yield: f.AmountResult,
        rlvl: f['RecipeLevelTable@as(raw)'], level: f.RecipeLevelTable.fields.ClassJobLevel, stars: f.RecipeLevelTable.fields.Stars,
        canHq: f.CanHq, quickSynth: f.CanQuickSynth, expert: f.IsExpert, specialist: f.IsSpecializationRequired,
        book: f['SecretRecipeBook@as(raw)'], mqf: f.MaterialQualityFactor, craftsmanship: f.RequiredCraftsmanship, control: f.RequiredControl,
        ingredients: f['Ingredient@as(raw)'].map((id, k) => [id, f.AmountIngredient[k]]),
      });
    }
  }
  return { source: 'v2.xivapi.com', version: XIVAPI_VERSION, schema, recipes: out.sort((a, b) => a.id - b.id) };
}

async function main() {
  const recipes = decodeRecipes(data.recipes);
  const ids = sampleIds(recipes);
  const x = await capture(ids);
  if (process.argv.includes('--write-fixture')) {
    const { recipes: list, ...head } = x;
    writeFileSync(join(ROOT, 'tests', 'fixtures', 'xivapi-recipes.json'), `${JSON.stringify(head).slice(0, -1)},"recipes":[\n${list.map((r) => `  ${JSON.stringify(r)}`).join(',\n')}\n]}\n`);
    console.log('wrote tests/fixtures/xivapi-recipes.json');
  }
  const problems = compareRecipesXivapi(x, recipes, data.levels);
  if (x.recipes.length !== ids.length) problems.push(`asked for ${ids.length} recipes, XIVAPI returned ${x.recipes.length}`);
  if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
  console.log(`${x.recipes.length} sampled recipes agree with XIVAPI ${XIVAPI_VERSION}`);
}

// Only when run, never when the tests import SAMPLE_ITEMS (they must not touch the network).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
