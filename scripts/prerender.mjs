// Writes the static pages (Security, Offline, ...) as plain HTML into dist/,
// rendered by the server build (dist-ssr/prerender.js). They load the site's
// stylesheet and one small script (src/static-theme.ts), each with
// Subresource Integrity, and no app code. Also copies the offline file into
// dist/download/ and removes Vite's manifest from what is served.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const root = new URL('../', import.meta.url).pathname;
const dist = join(root, 'dist');
const integrity = (rel) => `sha384-${createHash('sha384').update(readFileSync(join(dist, rel))).digest('base64')}`;
const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

// Link previews and search: every page names its address on the www host and shares one card
const SITE = 'https://www.zerodust.xyz';
const share = (title, description, path) => [
  `<link rel="canonical" href="${SITE}${path}" />`,
  '<meta property="og:type" content="website" />',
  '<meta property="og:site_name" content="ZeroDust" />',
  `<meta property="og:title" content="${esc(title)}" />`,
  `<meta property="og:description" content="${esc(description)}" />`,
  `<meta property="og:url" content="${SITE}${path}" />`,
  `<meta property="og:image" content="${SITE}/og.png" />`,
  '<meta property="og:image:width" content="1200" />',
  '<meta property="og:image:height" content="630" />',
  '<meta property="og:image:alt" content="0.000000000000000000 ETH left. Leave nothing behind." />',
  '<meta name="twitter:card" content="summary_large_image" />',
].map((t) => `    ${t}`).join('\n');
// A page's address: docs/index is /docs, the rest drop .html (cleanUrls)
const pathOf = (name) => `/${name.replace(/\/index$/, '')}`;

// The theme script and the chunks it imports, from Vite's manifest
const manifest = JSON.parse(readFileSync(join(dist, 'theme-manifest.json'), 'utf8'));
const theme = manifest['src/static-theme.ts'];
if (!theme) throw new Error('prerender: theme entry missing from the manifest');
const preloads = (theme.imports ?? []).map((key) => manifest[key].file);

// The site's stylesheet, as the app's index.html links it
const indexHtml = readFileSync(join(dist, 'index.html'), 'utf8');
const css = indexHtml.match(/<link rel="stylesheet" crossorigin href="\/([^"]+)"/)?.[1];
if (!css) throw new Error('prerender: stylesheet not found in index.html');

// The offline file, built before the site
const OFFLINE = 'zerodust-offline.html';
mkdirSync(join(dist, 'download'), { recursive: true });
copyFileSync(join(root, 'offline-out', OFFLINE), join(dist, 'download', OFFLINE));
const offlineSha256 = readFileSync(join(root, 'offline-out', 'sha256.txt'), 'utf8').trim();

let commit = 'unknown';
try {
  commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
} catch {
  // Built without git (an upload without .git): the record says so
}

const { PAGES, llmsFull, renderHome } = await import(join(root, 'dist-ssr', 'prerender.js'));
for (const [name, page] of Object.entries(PAGES)) {
  const body = page.render({ offlineSha256, commit });
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="referrer" content="no-referrer" />
    <meta name="color-scheme" content="light dark" />
    <title>${esc(page.title)}</title>
    <meta name="description" content="${esc(page.description)}" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
${share(page.title, page.description, pathOf(name))}
    <link rel="stylesheet" crossorigin href="/${css}" integrity="${integrity(css)}">
    <script type="module" crossorigin src="/${theme.file}" integrity="${integrity(theme.file)}"></script>
${preloads.map((f) => `    <link rel="modulepreload" crossorigin href="/${f}" integrity="${integrity(f)}">`).join('\n')}
  </head>
  <body>
${body}
  </body>
</html>
`;
  const file = join(dist, `${name}.html`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, html);
}

// The home page with its first screen in the HTML (crawlers and link previews run no scripts).
// Address pages load the empty shell instead (app.html, vercel.json), so they never flash the home.
const ROOT = '<div id="root"></div>';
if (!indexHtml.includes(ROOT)) throw new Error('prerender: empty root not found in index.html');
writeFileSync(join(dist, 'app.html'), indexHtml);
writeFileSync(join(dist, 'index.html'), indexHtml
  .replace('  </head>', `    <link rel="canonical" href="${SITE}/" />\n    <meta property="og:url" content="${SITE}/" />\n  </head>`)
  .replace(ROOT, `<div id="root">${renderHome()}</div>`));

// What search engines may list: the home page and every prerendered page
const urls = ['/', ...Object.keys(PAGES).map(pathOf)];
writeFileSync(join(dist, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${SITE}${u === '/' ? '/' : u}</loc></url>`).join('\n')}
</urlset>
`);

// The docs as one Markdown file for LLMs, generated so it cannot drift from the pages
writeFileSync(join(dist, 'llms-full.txt'), llmsFull());

rmSync(join(dist, 'theme-manifest.json'), { force: true });
console.log(`prerender: home, ${Object.keys(PAGES).join(', ')}, sitemap.xml, llms-full.txt; offline page copied; commit ${commit.slice(0, 12)}`);
