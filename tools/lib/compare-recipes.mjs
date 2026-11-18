// Compares recipes from a second extraction of the game data (XIVAPI v2) with the generated catalog (decoded by
// tools/build-recipes.mjs decodeRecipes) and the recipe levels it carries. Returns one line per disagreement;
// empty means they agree.
import { FLAG } from '../build-recipes.mjs';

export function compareRecipesXivapi(capture, recipes, levels) {
  const byId = new Map(recipes.map((r) => [r.id, r]));
  const lv = new Map(levels.map(([rl, level, stars]) => [rl, { level, stars }]));
  const problems = [];
  for (const x of capture.recipes) {
    const ours = byId.get(x.id);
    if (!ours) { problems.push(`recipe ${x.id} (result ${x.result}): in XIVAPI, not in the catalog`); continue; }
    const want = {
      result: x.result, job: x.job, yield: x.yield, rlvl: x.rlvl, book: x.book, mqf: x.mqf,
      craftsmanship: x.craftsmanship, control: x.control,
      flags: (x.canHq ? FLAG.canHq : 0) | (x.quickSynth ? FLAG.quickSynth : 0) | (x.expert ? FLAG.expert : 0) | (x.specialist ? FLAG.specialist : 0),
      ings: JSON.stringify(x.ingredients.filter(([i, n]) => i > 0 && n > 0)),
    };
    const have = { ...ours, ings: JSON.stringify(ours.ings) };
    for (const k of Object.keys(want)) if (have[k] !== want[k]) problems.push(`recipe ${x.id}: ${k} ${have[k]} vs XIVAPI ${want[k]}`);
    const l = lv.get(x.rlvl);
    if (!l) problems.push(`recipe ${x.id}: recipe level ${x.rlvl} missing from the catalog`);
    else if (l.level !== x.level || l.stars !== x.stars) problems.push(`recipe ${x.id}: level ${l.level}/${l.stars} stars vs XIVAPI ${x.level}/${x.stars}`);
  }
  return problems;
}
