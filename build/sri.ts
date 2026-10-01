import { createHash } from 'node:crypto';
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

/** Vite plugin: Subresource Integrity on the built HTML */
export function sri(): Plugin {
  return {
    name: 'zerodust-sri',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const files = new Map<string, string | Uint8Array>();
      for (const [fileName, output] of Object.entries(bundle)) {
        files.set(fileName, output.type === 'chunk' ? output.code : output.source);
      }
      for (const output of Object.values(bundle)) {
        if (output.type === 'asset' && output.fileName.endsWith('.html')) {
          output.source = addIntegrity(String(output.source), files);
        }
      }
    },
  };
}
