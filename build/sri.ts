import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';

/** Base64 sha384 digest in the form an `integrity` attribute takes */
export function integrityOf(content: string | Uint8Array): string {
  return `sha384-${createHash('sha384').update(content).digest('base64')}`;
}

/**
 * Adds `integrity` to every script and stylesheet/modulepreload link whose
 * URL is a file of this build. A tag that points at anything else is left
 * alone here and rejected by scripts/check-dist.mjs, so a missed tag fails
 * the build instead of shipping without integrity.
 */
export function addIntegrity(html: string, files: Map<string, string | Uint8Array>): string {
  return html.replace(/<(script|link)\b([^>]*?)(\s*\/?)>/g, (tag, name: string, attrs: string, close: string) => {
    if (/\sintegrity=/.test(attrs)) return tag;
    const url = attrs.match(/\s(?:src|href)="([^"]+)"/)?.[1];
    if (!url) return tag;
    if (name === 'link' && !/\srel="(stylesheet|modulepreload)"/.test(attrs)) return tag;
    const content = files.get(url.replace(/^\.?\//, ''));
    if (content === undefined) return tag;
    const cors = /\scrossorigin\b/.test(attrs) ? '' : ' crossorigin';
    return `<${name}${attrs} integrity="${integrityOf(content)}"${cors}${close}>`;
  });
}

/**
 * Vite plugin: Subresource Integrity on the built HTML. Runs after the files
 * are written and hashes them as they are on disk: Vite still rewrites
 * chunks (preload helpers for dynamic imports) after generateBundle, so a
 * hash taken earlier can be wrong. scripts/check-dist.mjs re-verifies.
 */
export function sri(): Plugin {
  return {
    name: 'zerodust-sri',
    apply: 'build',
    enforce: 'post',
    writeBundle(options, bundle) {
      const dir = options.dir!;
      const files = new Map<string, Uint8Array>();
      for (const fileName of Object.keys(bundle)) files.set(fileName, readFileSync(join(dir, fileName)));
      for (const fileName of Object.keys(bundle)) {
        if (!fileName.endsWith('.html')) continue;
        const path = join(dir, fileName);
        writeFileSync(path, addIntegrity(readFileSync(path, 'utf8'), files));
      }
    },
  };
}
