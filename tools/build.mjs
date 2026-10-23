// Builds a deployable copy of the site for one hosting target in deploy/targets.json.
//
//   node tools/build.mjs pages    -> dist/pages/        served at /ffxiv-timer/ (GitHub Pages)
//                                                       and /ffxiv/ (radmagelabs.com proxy)
//   node tools/build.mjs labs     -> dist/labs/ffxiv/   standalone copy for a host serving /ffxiv/
//   node tools/build.mjs --all
//
// Every path inside the site is relative, so the same files work under any base path and the
// source tree runs as-is for development (open index.html, or serve the folder anywhere). The
// build adds only what has to be absolute: the canonical and Open Graph URLs, a 404 page that
// knows its way home under each base path, and content-hash version stamps so a deploy is never
// half cached.
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const TARGETS = JSON.parse(readFileSync(join(ROOT, 'deploy', 'targets.json'), 'utf8'));

// Local files a page references through src= or href= (not anchors, not other sites).
export function localRefs(html) {
  const refs = new Set();
  for (const m of html.matchAll(/\b(?:src|href)="([^"]+)"/g)) {
    const ref = m[1];
    if (ref.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith('//')) continue;
    refs.add(ref.split(/[?#]/)[0]);
  }
  return [...refs];
}

const escapeAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

// The base paths a target is served under, from its urls ("https://host/ffxiv/" -> "/ffxiv/").
export function basePaths(t) { return [...new Set(t.urls.map((u) => new URL(u).pathname))]; }

export function checkTarget(name, t) {
  if (!Array.isArray(t.urls) || !t.urls.length) throw new Error(`${name}: needs at least one url`);
  for (const u of t.urls) {
    if (!/^https:\/\/[a-z0-9.-]+(\/[a-z0-9-]+)*\/$/.test(u)) throw new Error(`${name}: ${u} must be https://host/path/ ending in a slash`);
    if (t.mount && !new URL(u).pathname.endsWith(`/${t.mount}/`)) throw new Error(`${name}: ${u} does not end with mount ${t.mount}`);
  }
}

// GitHub Pages answers any missing path with this page, at that path. It sends the visitor to
// the app under whichever base path they came in on (the proxy keeps radmagelabs.com/ffxiv/),
// or the target's first one.
function notFoundPage(bases) {
  const list = JSON.stringify([...bases].sort((a, b) => b.length - a.length));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Not found - FFXIV Timer</title>
<meta name="robots" content="noindex">
<script>(function(){var b=${list},p=location.pathname,h=${JSON.stringify(bases[0])};for(var i=0;i<b.length;i++)if(p.indexOf(b[i])===0){h=b[i];break;}location.replace(h+location.hash);})();</script>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b101d;color:#e9edf6;font:16px/1.5 system-ui,sans-serif}a{color:#f3dc9b}</style>
</head>
<body><p>That page does not exist. <a href="${escapeAttr(bases[0])}">Go to FFXIV Timer</a>.</p></body>
</html>
`;
}

export function build(name, { outRoot = ROOT } = {}) {
  const t = TARGETS.targets[name];
  if (!t) throw new Error(`unknown target ${name}; known: ${Object.keys(TARGETS.targets).join(', ')}`);
  checkTarget(name, t);
  const outDir = resolve(outRoot, t.outDir);
  const appDir = join(outDir, t.mount);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(appDir, { recursive: true });

  let html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const files = localRefs(html);
  const stamps = {};
  for (const ref of files) {
    const src = join(ROOT, ref), dest = join(appDir, ref);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest);
    stamps[ref] = createHash('sha256').update(readFileSync(src)).digest('hex').slice(0, 10);
  }
  html = html.replace(/\b(src|href)="([^"?#]+)"/g, (all, attr, ref) => (stamps[ref] ? `${attr}="${ref}?v=${stamps[ref]}"` : all));

  const bases = basePaths(t);
  const canonical = TARGETS.canonical === 'self' ? t.urls[0] : TARGETS.canonical;
  const meta = [
    `<link rel="canonical" href="${escapeAttr(canonical)}">`,
    '<meta property="og:type" content="website">',
    '<meta property="og:title" content="FFXIV Timer">',
    '<meta property="og:description" content="Eorzea time, weather forecasts and weather transitions for FINAL FANTASY XIV.">',
    `<meta property="og:url" content="${escapeAttr(canonical)}">`,
    `<meta name="ffxiv-timer-build" content="${escapeAttr(`${name} ${bases.join(' ')}`)}">`,
  ].join('\n  ');
  if (!html.includes('<!-- deploy:meta -->')) throw new Error('index.html lost its <!-- deploy:meta --> marker');
  html = html.replace('<!-- deploy:meta -->', meta);
  writeFileSync(join(appDir, 'index.html'), html);
  writeFileSync(join(appDir, '404.html'), notFoundPage(bases));
  // A host serving outDir at its root (Vercel) looks for 404.html there, not in the mount folder.
  if (t.mount) writeFileSync(join(outDir, '404.html'), notFoundPage(bases));
  // GitHub Pages would otherwise run the files through Jekyll.
  if (name === 'pages') writeFileSync(join(outDir, '.nojekyll'), '');
  return { name, outDir, appDir, bases, canonical, files: ['index.html', '404.html', ...files] };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const names = args.includes('--all') ? Object.keys(TARGETS.targets) : args;
  if (!names.length) { console.error('usage: node tools/build.mjs <target>|--all'); process.exit(2); }
  for (const name of names) {
    const r = build(name);
    console.log(`${name}: ${r.files.length} files -> ${r.appDir} (served at ${r.bases.join(' and ')}, canonical ${r.canonical})`);
  }
}
