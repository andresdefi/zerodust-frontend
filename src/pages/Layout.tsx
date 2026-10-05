import type { ReactNode } from 'react';
import { Mark, MoonIcon } from '../components/icons';

// Static pages (rendered to HTML at build time, no app code). The theme
// button is wired by src/static-theme.ts, the only script these pages load.

export function StaticNav() {
  return (
    <nav className="nav" aria-label="Main">
      <a className="logo" href="/">
        <Mark />
        zerodust
      </a>
      <div className="navlinks">
        <a href="/security">Security</a>
        <a href="/offline">Offline page</a>
        <a href="/docs">Docs</a>
      </div>
      <button type="button" className="iconbtn" id="theme-toggle" aria-label="Switch theme">
        <MoonIcon />
      </button>
    </nav>
  );
}

export function StaticPage({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <>
      <StaticNav />
      <main className={wide ? 'page-wide' : 'doc'}>{children}</main>
      <footer className="foot">
        <span>ZeroDust</span>
        <span className="foot-links">
          <a href="/security">Security</a>
          <a href="/offline">Offline page</a>
          <a href="/docs">Docs</a>
          <a href="/terms">Terms</a>
          <a href="/privacy">Privacy</a>
          <a href="https://github.com/andresdefi/zerodust">Contracts and SDK</a>
          <a href="https://github.com/andresdefi/zerodust-frontend">Site source</a>
        </span>
      </footer>
    </>
  );
}
