// Fails the build when a page in dist/ breaks the CSP or integrity rules
// (scripts/dist-checks.mjs), or when vercel.json's CSP loses one of them.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkCsp, checkHtml, checkOfflineHtml } from './dist-checks.mjs';

const dist = new URL('../dist/', import.meta.url).pathname;
const problems = [];

for (const file of readdirSync(dist, { recursive: true })) {
  if (!String(file).endsWith('.html')) continue;
  const html = readFileSync(join(dist, String(file)), 'utf8');
  // The downloadable offline page inlines its code under its own hash-based CSP
  if (String(file).startsWith('download/')) {
    const b64 = (s) => createHash('sha256').update(s, 'utf8').digest('base64');
    for (const p of checkOfflineHtml(html, b64)) problems.push(`${file}: ${p}`);
    continue;
  }
  for (const p of checkHtml(html)) problems.push(`${file}: ${p}`);
  // Each integrity value must match the file it names, as served
  for (const [, url, integrity] of html.matchAll(/(?:src|href)="\/?([^"]+)"[^>]*\sintegrity="(sha384-[^"]+)"/g)) {
    let actual;
    try {
      actual = `sha384-${createHash('sha384').update(readFileSync(join(dist, url))).digest('base64')}`;
    } catch {
      problems.push(`${file}: integrity for a file not in dist: ${url}`);
      continue;
    }
    if (actual !== integrity) problems.push(`${file}: integrity does not match ${url}`);
  }
}

// Every script must be loaded with integrity by some page: a script no page
// lists (a lazily loaded module) would run without its hash being checked
const referenced = new Set();
for (const file of readdirSync(dist, { recursive: true })) {
  if (!String(file).endsWith('.html') || String(file).startsWith('download/')) continue;
  const html = readFileSync(join(dist, String(file)), 'utf8');
  for (const [, src] of html.matchAll(/(?:src|href)="\/?([^"]+\.js)"[^>]*\sintegrity="/g)) referenced.add(src);
}
for (const file of readdirSync(join(dist, 'assets'))) {
  if (file.endsWith('.js') && !referenced.has(`assets/${file}`)) problems.push(`assets/${file}: a script no page loads with integrity (lazy chunk?)`);
}

const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
const csp = vercel.headers.flatMap((h) => h.headers).find((h) => h.key === 'Content-Security-Policy')?.value;
if (!csp) problems.push('vercel.json: no Content-Security-Policy');
else for (const p of checkCsp(csp)) problems.push(`vercel.json: ${p}`);

if (problems.length) {
  console.error(`check-dist: ${problems.length} problem(s)\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}
console.log('check-dist: every page passes the CSP and integrity rules');
