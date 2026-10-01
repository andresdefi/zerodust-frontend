// Writes the static pages (Security, Offline, ...) as plain HTML into dist/,
// rendered by the server build (dist-ssr/prerender.js). They load the site's
// stylesheet and one small script (src/static-theme.ts), each with
// Subresource Integrity, and no app code. Also copies the offline file into
// dist/download/ and removes Vite's manifest from what is served.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../', import.meta.url).pathname;
const dist = join(root, 'dist');
const integrity = (rel) => `sha384-${createHash('sha384').update(readFileSync(join(dist, rel))).digest('base64')}`;
const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

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

const { PAGES } = await import(join(root, 'dist-ssr', 'prerender.js'));
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
    <link rel="stylesheet" crossorigin href="/${css}" integrity="${integrity(css)}">
    <script type="module" crossorigin src="/${theme.file}" integrity="${integrity(theme.file)}"></script>
${preloads.map((f) => `    <link rel="modulepreload" crossorigin href="/${f}" integrity="${integrity(f)}">`).join('\n')}
  </head>
  <body>
${body}
  </body>
</html>
`;
  writeFileSync(join(dist, `${name}.html`), html);
}

rmSync(join(dist, 'theme-manifest.json'), { force: true });
console.log(`prerender: ${Object.keys(PAGES).join(', ')}; offline page copied; commit ${commit.slice(0, 12)}`);
