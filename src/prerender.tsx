// Server build entry: the static pages as HTML (scripts/prerender.mjs writes them)
import { renderToStaticMarkup } from 'react-dom/server';
import { OfflinePage } from './pages/OfflinePage';
import { SecurityPage } from './pages/SecurityPage';
import type { PageBuild } from './pages/build-record';
import { DocsPage } from './pages/DocsPage';
import { DOC_NAV, docPath, docSource, renderDoc, renderLegal } from './pages/docs';
import { StaticPage } from './pages/Layout';
import { SiteHeader } from './components/SiteHeader';
import { SiteFooter } from './components/SiteFooter';
import { Home, SITE_COUNTS } from './home/Home';

export const PAGES: Record<string, { title: string; description: string; render: (build: PageBuild) => string }> = {
  security: {
    title: 'Security - ZeroDust',
    description: 'How ZeroDust handles your private key, what the page talks to, and how to verify the build.',
    render: (b) => renderToStaticMarkup(<SecurityPage build={b} />),
  },
  offline: {
    title: 'Offline page - ZeroDust',
    description: 'Download the ZeroDust sweeper as one HTML file, check its hash, and run it from your own disk.',
    render: (b) => renderToStaticMarkup(<OfflinePage build={b} />),
  },
  terms: {
    title: 'Terms - ZeroDust',
    description: 'The terms for using ZeroDust: what it does, your responsibilities, fees and risks.',
    render: () => renderToStaticMarkup(<StaticPage><div className="legal" dangerouslySetInnerHTML={{ __html: renderLegal('terms').html }} /></StaticPage>),
  },
  privacy: {
    title: 'Privacy - ZeroDust',
    description: 'What ZeroDust collects, why, how long it keeps it, and who else sees it.',
    render: () => renderToStaticMarkup(<StaticPage><div className="legal" dangerouslySetInnerHTML={{ __html: renderLegal('privacy').html }} /></StaticPage>),
  },
  // Docs: /docs (index) and /docs/<slug>; a listed page without its file is a build error
  ...Object.fromEntries(DOC_NAV.map((d) => {
    const { title } = renderDoc(d.slug);
    return [`docs/${d.slug}`, {
      title: `${title} - ZeroDust docs`,
      description: `ZeroDust developer docs: ${title}.`,
      render: () => renderToStaticMarkup(<DocsPage slug={d.slug} />),
    }];
  })),
};

/**
 * /llms-full.txt: every docs page's Markdown in sidebar order, site links made absolute,
 * so it always matches the pages
 */
export function llmsFull(): string {
  const pages = DOC_NAV.map((d) => {
    const source = docSource(d.slug);
    if (source === null) throw new Error(`llms-full: content/docs/${d.slug}.md is missing`);
    const body = source.trim().replace(/\]\((\/[^)\s]*)\)/g, '](https://zerodust.xyz$1)');
    return `<!-- https://zerodust.xyz${docPath(d.slug)} -->\n\n${body}`;
  });
  return `${pages.join('\n\n---\n\n')}\n`;
}

/**
 * The home page as the app first draws it (no wallet, the counts in SITE_COUNTS), written into
 * dist/index.html's root so crawlers and link previews read it without running scripts. The app
 * replaces it when it starts.
 */
export function renderHome(): string {
  const noop = () => {};
  return renderToStaticMarkup(
    <>
      <SiteHeader search={false} onMetaMask={noop} metaMaskBusy={false} account={null} />
      <Home counts={SITE_COUNTS} onMetaMask={noop} metaMaskError={null} />
      <SiteFooter />
    </>
  );
}
