import { useEffect, useState } from 'react';
import { OFFLINE } from './env';

// Two views: the home page and one address (/address/<0x… or name.eth>). The site
// routes by path (Vercel rewrites /address/* to the app); the offline file runs
// from disk, where paths mean files, so it routes by hash (#/address/…).

export type View = { kind: 'home' } | { kind: 'address'; query: string };

const PREFIX = '/address/';

export function parseView(pathname: string, hash: string): View {
  const path = OFFLINE ? hash.replace(/^#/, '') : pathname;
  // Today's sweep flow, kept until the address page can sweep (redesign phase 3)
  if (path.startsWith(PREFIX)) {
    const query = decodeURIComponent(path.slice(PREFIX.length)).trim();
    if (query) return { kind: 'address', query };
  }
  return { kind: 'home' };
}

export const addressHref = (query: string) => `${OFFLINE ? '#' : ''}${PREFIX}${encodeURIComponent(query)}`;
export const homeHref = () => (OFFLINE ? '#/' : '/');

const current = () => parseView(window.location.pathname, window.location.hash);

/** Moves to another view without a reload */
export function navigate(href: string): void {
  if (OFFLINE) window.location.hash = href.replace(/^#/, '');
  else {
    window.history.pushState(null, '', href);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }
  window.scrollTo(0, 0);
}

/** The view in the address bar, kept in step with back/forward */
export function useView(): View {
  const [view, setView] = useState<View>(current);
  useEffect(() => {
    const update = () => setView(current());
    window.addEventListener('popstate', update);
    window.addEventListener('hashchange', update);
    return () => {
      window.removeEventListener('popstate', update);
      window.removeEventListener('hashchange', update);
    };
  }, []);
  return view;
}
