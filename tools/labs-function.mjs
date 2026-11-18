// Puts the price function together with a radmagelabs.com vercel.json, for the isolated prototype
// now and for the Labs repo at release (each step needs Dos's approval; this tool only writes into
// the folder it is given).
//
//   node tools/labs-function.mjs <labs vercel.json> <out dir>
//
// writes <out dir>/vercel.json (the Labs file with radmagelabs/vercel.prices.json merged in) and
// copies radmagelabs/api/ to <out dir>/api/. The merge adds the price rewrite just before the
// first /ffxiv/ catch-all rewrite (rules run in order, and the catch-all sends everything else
// under /ffxiv/ to GitHub Pages), adds the function's settings, and puts the page's
// Content-Security-Policy header rules first in "headers"; every other rule is kept as it is, in
// its place.
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './lib/gamedata.mjs';

export const FRAGMENT = JSON.parse(readFileSync(join(ROOT, 'radmagelabs', 'vercel.prices.json'), 'utf8'));

export function mergeLabsConfig(labs, fragment = FRAGMENT) {
  const rewrites = labs.rewrites || [];
  const ours = new Set(fragment.rewrites.map((r) => r.source));
  if (rewrites.some((r) => ours.has(r.source) || r.source.startsWith('/ffxiv/prices'))) throw new Error('the Labs config already has a price rule');
  const at = rewrites.findIndex((r) => r.source === '/ffxiv/' || r.source.startsWith('/ffxiv/:'));
  if (at < 0) throw new Error('no /ffxiv/ catch-all rewrite found; where should the price rule go?');
  const functions = { ...(labs.functions || {}) };
  for (const [k, v] of Object.entries(fragment.functions)) {
    if (functions[k]) throw new Error(`the Labs config already configures ${k}`);
    functions[k] = v;
  }
  if (!Array.isArray(labs.headers)) throw new Error('the Labs config has no "headers" list for the page\'s header rules');
  const ourHeaders = new Set(fragment.headers.map((h) => h.source));
  if (labs.headers.some((h) => ourHeaders.has(h.source))) throw new Error('the Labs config already has header rules for the page');
  const out = {};
  for (const [k, v] of Object.entries(labs)) {
    out[k] = k === 'rewrites' ? [...rewrites.slice(0, at), ...fragment.rewrites, ...rewrites.slice(at)]
      : k === 'headers' ? [...fragment.headers, ...v] : v;
    if (k === '$schema') out.functions = functions;
  }
  if (!out.functions) out.functions = functions;
  return out;
}

// The same merge done on the file's text, so the Labs file keeps its own layout and the change is
// only the added lines: the functions block after "$schema", the rewrite line above the catch-all
// and the header rules at the top of "headers". The result is checked against mergeLabsConfig.
export function mergeLabsText(text, fragment = FRAGMENT) {
  const want = mergeLabsConfig(JSON.parse(text), fragment);
  const lines = text.split('\n');
  const schema = lines.findIndex((l) => /^\s*"\$schema":/.test(l));
  const rewritesAt = lines.findIndex((l) => /^\s*"rewrites":\s*\[/.test(l));
  const catchAll = lines.findIndex((l, i) => i > rewritesAt && /"source":\s*"\/ffxiv\/(:[^"]*)?"/.test(l));
  const headersAt = lines.findIndex((l) => /^ {2}"headers":\s*\[\s*$/.test(l)); // the top-level list, after the rewrites
  if (schema < 0 || rewritesAt < 0 || catchAll < 0 || headersAt < catchAll) throw new Error('the Labs vercel.json does not have the expected layout');
  const indent = lines[catchAll].match(/^\s*/)[0];
  const rule = (r) => `${indent}{ ${Object.entries(r).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(', ')} },`;
  const fn = Object.entries(fragment.functions).map(([k, v], i, all) => `    ${JSON.stringify(k)}: { ${Object.entries(v).map(([a, b]) => `${JSON.stringify(a)}: ${JSON.stringify(b)}`).join(', ')} }${i < all.length - 1 ? ',' : ''}`);
  // Each header rule in the Labs layout: source on one line, its headers on the next.
  const pair = (o) => `{ ${Object.entries(o).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(', ')} }`;
  const head = fragment.headers.flatMap((h) => ['    {', `      "source": ${JSON.stringify(h.source)},`, `      "headers": [${h.headers.map(pair).join(', ')}]`, '    },']);
  const out = [...lines];
  out.splice(headersAt + 1, 0, ...head);
  out.splice(catchAll, 0, ...fragment.rewrites.map(rule));
  out.splice(schema + 1, 0, '  "functions": {', ...fn, '  },');
  const result = out.join('\n');
  assertEqualJson(JSON.parse(result), want);
  return result;
}
function assertEqualJson(a, b) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error('the text merge does not match the structured merge');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [labsFile, outDir] = process.argv.slice(2);
  if (!labsFile || !outDir) { console.error('usage: node tools/labs-function.mjs <labs vercel.json> <out dir>'); process.exit(2); }
  const text = mergeLabsText(readFileSync(labsFile, 'utf8'));
  const merged = JSON.parse(text);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'vercel.json'), text);
  cpSync(join(ROOT, 'radmagelabs', 'api'), join(outDir, 'api'), { recursive: true });
  console.log(`wrote ${join(outDir, 'vercel.json')} (${merged.rewrites.length} rewrites) and ${join(outDir, 'api')}`);
}
