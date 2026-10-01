// Prints one SHA-256 over the whole build, so anyone can rebuild the public
// repo at a commit and compare. The digest covers every file's path and
// contents, in sorted order, as lines of "sha256(file)  path". The build
// record (.well-known/zerodust-build.json) is written after and left out: a
// file cannot contain the hash of the set it belongs to.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const RECORD = '.well-known/zerodust-build.json';

export function manifest(dir) {
  return readdirSync(dir, { recursive: true })
    .map(String)
    .filter((f) => statSync(join(dir, f)).isFile())
    .map((f) => f.split('\\').join('/'))
    .filter((f) => f !== RECORD)
    .sort()
    .map((f) => `${createHash('sha256').update(readFileSync(join(dir, f))).digest('hex')}  ${f}`)
    .join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = new URL('../', import.meta.url).pathname;
  const dist = join(root, 'dist');
  const lines = manifest(dist);
  const siteSha256 = createHash('sha256').update(`${lines}\n`).digest('hex');
  const offlineSha256 = createHash('sha256').update(readFileSync(join(dist, 'download', 'zerodust-offline.html'))).digest('hex');
  const commit = readFileSync(join(dist, 'security.html'), 'utf8').match(/git checkout ([0-9a-f]{40}|unknown)/)?.[1] ?? 'unknown';
  mkdirSync(join(dist, '.well-known'), { recursive: true });
  writeFileSync(join(dist, RECORD), `${JSON.stringify({ siteSha256, offlineSha256, commit }, null, 2)}\n`);
  console.log(`${lines}\n\nbuild sha256: ${siteSha256} (${lines.split('\n').length} files)\noffline sha256: ${offlineSha256}`);
}
