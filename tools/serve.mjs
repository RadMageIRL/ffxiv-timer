// Local preview of every way the site is reached, on one port:
//
//   node tools/serve.mjs [--port 8017]
//
//   /dev/           the source tree, unbuilt (edit and reload)
//   /ffxiv-timer/   the GitHub Pages build, as radmageirl.github.io serves it (no news feeds)
//   /ffxiv/         the same build, as radmagelabs.com serves it through its proxy
//
// Under /ffxiv/ and /dev/, news/topics.xml and news/news.xml are fetched from the Lodestone, as
// the radmagelabs.com rewrites do. The Pages build is rebuilt into dist/ at start; restart to
// pick up changes there.
import { build } from './build.mjs';
import { ROOT } from './lib/gamedata.mjs';
import { serve } from './lib/static-server.mjs';

const args = process.argv.slice(2);
const port = args.includes('--port') ? Number(args[args.indexOf('--port') + 1]) : 8017;
const pages = build('pages');
const routes = {};
for (const base of ['/ffxiv/', '/dev/']) {
  for (const feed of ['topics', 'news']) routes[`${base}news/${feed}.xml`] = { proxy: `https://na.finalfantasyxiv.com/lodestone/news/${feed}.xml` };
}
const server = await serve({
  port,
  routes,
  mounts: [
    { prefix: '/dev/', dir: ROOT },
    { prefix: '/ffxiv-timer/', dir: pages.appDir, notFound: '404.html' },
    { prefix: '/ffxiv/', dir: pages.appDir, notFound: '404.html' },
  ],
});
console.log(`FFXIV Timer preview (Ctrl+C to stop):
  source tree       ${server.origin}/dev/
  GitHub Pages      ${server.origin}/ffxiv-timer/
  radmagelabs.com   ${server.origin}/ffxiv/`);
