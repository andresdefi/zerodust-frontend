import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { addIntegrity, integrityOf } from '../build/sri';

const js = 'console.log(1)';
const css = 'body{color:red}';
const files = new Map<string, string>([
  ['assets/index-abc.js', js],
  ['assets/index-def.css', css],
]);
const sha384 = (s: string) => `sha384-${createHash('sha384').update(s).digest('base64')}`;

describe('integrityOf', () => {
  it('is the base64 sha384 digest', () => {
    expect(integrityOf(js)).toBe(sha384(js));
  });
});

describe('addIntegrity', () => {
  it('adds integrity to the build entry script and stylesheet', () => {
    const html = '<script type="module" crossorigin src="/assets/index-abc.js"></script><link rel="stylesheet" crossorigin href="/assets/index-def.css">';
    const out = addIntegrity(html, files);
    expect(out).toContain(`src="/assets/index-abc.js" integrity="${sha384(js)}"`);
    expect(out).toContain(`href="/assets/index-def.css" integrity="${sha384(css)}"`);
  });

  it('adds integrity to modulepreload links and crossorigin where missing', () => {
    const out = addIntegrity('<link rel="modulepreload" href="/assets/index-abc.js">', files);
    expect(out).toBe(`<link rel="modulepreload" href="/assets/index-abc.js" integrity="${sha384(js)}" crossorigin>`);
  });

  it('leaves icons, unknown files and tags that already have integrity alone', () => {
    const html = '<link rel="icon" href="/favicon.svg"><script src="/other.js"></script><script src="/assets/index-abc.js" integrity="sha384-x"></script>';
    expect(addIntegrity(html, files)).toBe(html);
  });
});
