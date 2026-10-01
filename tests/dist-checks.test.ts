import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkCsp, checkHtml, checkOfflineHtml } from '../scripts/dist-checks.mjs';
import { manifest } from '../scripts/hash-dist.mjs';

const ok = '<script type="module" crossorigin src="/assets/a.js" integrity="sha384-abc"></script><link rel="stylesheet" href="/assets/a.css" integrity="sha384-def">';

describe('checkHtml', () => {
  it('passes a page whose scripts and styles are files with integrity', () => {
    expect(checkHtml(ok)).toEqual([]);
  });

  it('rejects inline scripts, styles and handlers', () => {
    expect(checkHtml('<script>alert(1)</script>')).toEqual([expect.stringContaining('inline script')]);
    expect(checkHtml('<style>a{}</style>')).toEqual(['inline <style> element']);
    expect(checkHtml('<div style="color:red"></div>')).toEqual(['inline style attribute']);
    expect(checkHtml('<img onerror="x()">')).toEqual(['inline event handler']);
  });

  it('rejects scripts and styles without integrity or from another host', () => {
    expect(checkHtml('<script src="/assets/a.js"></script>')).toEqual(['script without integrity: /assets/a.js']);
    expect(checkHtml('<script src="https://cdn.example/x.js" integrity="sha384-a"></script>')).toEqual(['third-party script: https://cdn.example/x.js']);
    expect(checkHtml('<link rel="stylesheet" href="//fonts.example/a.css" integrity="sha384-a">')).toEqual(['third-party resource: //fonts.example/a.css']);
    expect(checkHtml('<link rel="modulepreload" href="/assets/b.js">')).toEqual([expect.stringContaining('link without integrity')]);
  });
});

describe('checkCsp', () => {
  const good = "default-src 'none'; script-src 'self'; style-src 'self'; frame-ancestors 'none'";

  it('passes the launch policy', () => {
    expect(checkCsp(good)).toEqual([]);
  });

  it('rejects a weaker script-src, unsafe sources and wildcards', () => {
    expect(checkCsp(good.replace("script-src 'self'", "script-src 'self' https://cdn.example"))).toEqual(["script-src must be 'self'"]);
    expect(checkCsp(`${good}; style-src-attr 'unsafe-inline'`)).toEqual(['unsafe-* source in the CSP']);
    expect(checkCsp(`${good}; img-src *`)).toEqual(['wildcard source in the CSP']);
    expect(checkCsp("script-src 'self'")).toEqual(["default-src must be 'none'", "frame-ancestors must be 'none'"]);
  });
});

describe('manifest', () => {
  it('lists every file with its sha256, sorted by path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zd-dist-'));
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'index.html'), 'a');
    writeFileSync(join(dir, 'assets', 'x.js'), 'b');
    expect(manifest(dir)).toBe(
      '3e23e8160039594a33894f6564e1b1348bbd7a0088d42c4acb73eeaed59c009d  assets/x.js\n' +
        'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb  index.html'
    );
  });
});

describe('checkOfflineHtml', () => {
  const b64 = (s: string) => createHash('sha256').update(s, 'utf8').digest('base64');
  const js = 'console.log(1)';
  const css = 'body{color:red}';
  const page = (csp: string, extra = '') =>
    `<meta http-equiv="Content-Security-Policy" content="${csp}" /><style>${css}</style><script type="module">${js}</script>${extra}`;
  const good = `default-src 'none'; script-src 'sha256-${b64(js)}'; style-src 'sha256-${b64(css)}'; connect-src https://api.zerodust.xyz`;

  it('passes inline code allowed by its hashes', () => {
    expect(checkOfflineHtml(page(good), b64)).toEqual([]);
  });

  it('rejects code the CSP does not list, external code, or a weak policy', () => {
    expect(checkOfflineHtml(page(good, '<script>alert(1)</script>'), b64)).toEqual(['offline page: inline script not allowed by the CSP']);
    expect(checkOfflineHtml(page(good, '<script src="https://cdn.example/x.js"></script>'), b64)).toContain('offline page: script loaded from a file');
    expect(checkOfflineHtml(page(good.replace(/script-src [^;]+/, "script-src 'unsafe-inline'")), b64)).toEqual(expect.arrayContaining(['offline page: script-src must list only sha256 hashes']));
    expect(checkOfflineHtml(page(good.replace("default-src 'none'", 'default-src *')), b64)).toEqual(expect.arrayContaining(["offline page: default-src must be 'none'"]));
    expect(checkOfflineHtml('<script type="module">x</script>', b64)).toEqual(['offline page: expected exactly one CSP meta']);
  });
});
