import { describe, expect, it } from 'vitest';
import { DOC_NAV, docSource, renderDoc, renderMarkdown, slugify } from '../src/pages/docs';

describe('docs rendering', () => {
  it('escapes raw HTML: a content file cannot put markup or script on a page', () => {
    const html = renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">');
    expect(html).not.toMatch(/<script|<img/);
    expect(html).toContain('&lt;script&gt;');
  });

  it('refuses javascript: and data: links, keeps web and site links', () => {
    expect(() => renderMarkdown('[x](javascript:alert(1))')).toThrow(/refused link/);
    expect(() => renderMarkdown('![x](data:image/svg+xml,abc)')).toThrow(/refused link/);
    expect(renderMarkdown('[sdk](/docs/sdk) [npm](https://www.npmjs.com/package/@zerodust/sdk)')).toMatch(/href="\/docs\/sdk".*href="https:\/\/www\.npmjs\.com/s);
  });

  it('renders tables and code without inline styles', () => {
    const html = renderMarkdown('| a | b |\n|:--|--:|\n| 1 | 2 |\n\n```ts\nconst x = 1\n```');
    expect(html).toContain('<table>');
    expect(html).toContain('class="language-ts"');
    expect(html).not.toMatch(/\sstyle="/);
  });

  it('gives h2 and h3 an id for deep links, escaping nothing unsafe into it', () => {
    expect(renderMarkdown('## API keys')).toBe('<h2 id="api-keys">API keys</h2>\n');
    expect(renderMarkdown('### `GET /agent/me`')).toBe('<h3 id="get-agentme"><code>GET /agent/me</code></h3>\n');
    expect(renderMarkdown('# Title')).toBe('<h1>Title</h1>\n');
    expect(slugify('<b>"x" onload=1</b>')).toBe('bx-onload1b');
  });
});

describe('docs content', () => {
  const pages = Object.fromEntries(DOC_NAV.map((d) => [d.slug, renderDoc(d.slug).html]));

  it('every /docs link with an anchor lands on a heading that exists', () => {
    const broken: string[] = [];
    for (const [slug, html] of Object.entries(pages)) {
      for (const [, target, anchor] of html.matchAll(/href="\/docs(?:\/([a-z-]+))?#([a-z0-9-]+)"/g)) {
        const page = pages[target ?? 'index'];
        if (!page?.includes(`id="${anchor}"`)) broken.push(`${slug} -> ${target ?? 'index'}#${anchor}`);
      }
      for (const [, anchor] of html.matchAll(/href="#([a-z0-9-]+)"/g)) {
        if (!html.includes(`id="${anchor}"`)) broken.push(`${slug} -> #${anchor}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('documents the MetaMask flow and its endpoints', () => {
    for (const text of ['signer=permission', 'POST /authorization/batch', 'batchQuoteIds', 'permissionContext', 'GET /bridges/timing']) {
      expect(docSource('api')).toContain(text);
    }
    expect(docSource('index')).toMatch(/switch to smart account/);
    // Delivery is native gas; the two token exceptions are named (owner, 2026-10-06)
    expect(docSource('index')).toMatch(/## What arrives/);
    for (const text of ['Mitosis', 'Endurance', 'receiveToken', 'OWN_WALLET_ONLY']) expect(docSource('index')).toContain(text);
    for (const text of ['receiveToken', 'AMOUNT_TOO_LOW', 'OWN_WALLET_ONLY']) expect(docSource('api')).toContain(text);
  });
});
