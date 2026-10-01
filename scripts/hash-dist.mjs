// Prints one SHA-256 over the whole build, so anyone can rebuild the public
// repo at a commit and compare. The digest covers every file's path and
// contents, in sorted order, as lines of "sha256(file)  path".
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export function manifest(dir) {
  return readdirSync(dir, { recursive: true })
    .map(String)
    .filter((f) => statSync(join(dir, f)).isFile())
    .map((f) => f.split('\\').join('/'))
    .sort()
    .map((f) => `${createHash('sha256').update(readFileSync(join(dir, f))).digest('hex')}  ${f}`)
    .join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const lines = manifest(new URL('../dist/', import.meta.url).pathname);
  const digest = createHash('sha256').update(`${lines}\n`).digest('hex');
  console.log(`${lines}\n\nbuild sha256: ${digest} (${lines.split('\n').length} files)`);
}
