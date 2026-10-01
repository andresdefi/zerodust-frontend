// Server build entry: the static pages as HTML (scripts/prerender.mjs writes them)
import { renderToStaticMarkup } from 'react-dom/server';
import { OfflinePage } from './pages/OfflinePage';
import { SecurityPage } from './pages/SecurityPage';
import type { PageBuild } from './pages/build-record';

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
};
