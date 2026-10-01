// Turns the offline build (dist-offline/) into one HTML file: the app's
// script and styles inlined, fonts and logos already data: URIs, under a
// Content-Security-Policy <meta> that allows exactly those inline blocks by
// their SHA-256 and the same API and RPC hosts as the site. Writes
// offline-out/zerodust-offline.html and its SHA-256.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../', import.meta.url).pathname;
const built = join(root, 'dist-offline');
const out = join(root, 'offline-out');
const FILE = 'zerodust-offline.html';

const read = (rel) => readFileSync(join(built, rel.replace(/^\.\//, '')), 'utf8');
const b64sha = (s) => createHash('sha256').update(s, 'utf8').digest('base64');

export function offlineCsp(connectSrc, scriptHashes, styleHashes) {
  return [
    "default-src 'none'",
    `script-src ${scriptHashes.map((h) => `'sha256-${h}'`).join(' ')}`,
    `style-src ${styleHashes.map((h) => `'sha256-${h}'`).join(' ')}`,
    'img-src data:',
    'font-src data:',
    `connect-src ${connectSrc.join(' ')}`,
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let html = read('index.html');
  const scriptSrc = html.match(/<script type="module" crossorigin src="([^"]+)"><\/script>/)?.[1];
  const cssHref = html.match(/<link rel="stylesheet" crossorigin href="([^"]+)">/)?.[1];
  if (!scriptSrc || !cssHref) throw new Error('offline build: entry script or stylesheet not found');
  if (html.match(/<script[^>]+src=/g)?.length !== 1) throw new Error('offline build: expected exactly one script');

  // A literal "</script" inside the code would end the element early
  const js = read(scriptSrc).replace(/<\/script/gi, '<\\/script');
  const css = read(cssHref);
  const favicon = `data:image/svg+xml;base64,${readFileSync(join(built, 'favicon.svg')).toString('base64')}`;

  const vercel = JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8'));
  const siteCsp = vercel.headers.flatMap((h) => h.headers).find((h) => h.key === 'Content-Security-Policy').value;
  // The site's connect-src without 'self' (a file has no origin to talk to)
  const connect = siteCsp.split(';').map((d) => d.trim().split(/\s+/)).find((d) => d[0] === 'connect-src').slice(1).filter((s) => s !== "'self'");

  const csp = offlineCsp(connect, [b64sha(js)], [b64sha(css)]);
  html = html
    .replace(/<script type="module" crossorigin src="[^"]+"><\/script>/, () => `<script type="module">${js}</script>`)
    .replace(/<link rel="stylesheet" crossorigin href="[^"]+">/, () => `<style>${css}</style>`)
    .replace(/<link rel="icon" href="[^"]+" type="image\/svg\+xml" \/>/, `<link rel="icon" href="${favicon}" type="image/svg+xml" />`)
    .replace('<meta charset="utf-8" />', () => `<meta charset="utf-8" />\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`)
    .replace(/<title>[^<]*<\/title>/, '<title>ZeroDust (offline page)</title>');

  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, FILE), html);
  const sha = createHash('sha256').update(html, 'utf8').digest('hex');
  writeFileSync(join(out, 'sha256.txt'), `${sha}\n`);
  console.log(`offline page: ${FILE}, ${(html.length / 1024).toFixed(0)} KB, sha256 ${sha}`);
}
