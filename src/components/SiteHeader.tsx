import { useState, type FormEvent } from 'react';
import { Mark, MoonIcon, SunIcon } from './icons';
import { applyTheme, storedTheme, systemTheme, type Theme } from '../lib/theme';
import { SITE } from '../lib/env';
import { addressHref, homeHref, navigate } from '../lib/route';

/** Sends an address or ENS name to its address page */
export function useAddressSearch() {
  const [query, setQuery] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    if (q) navigate(addressHref(q));
  };
  return { query, setQuery, submit };
}

function SearchIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
    </svg>
  );
}
export { SearchIcon };

/**
 * Logo, links, theme, the MetaMask button, and (on every page but home, whose hero is the
 * search) a full-width bar to look up any address
 */
export function SiteHeader({ search = true, onMetaMask, metaMaskBusy = false }: { search?: boolean; onMetaMask: () => void; metaMaskBusy?: boolean }) {
  const [theme, setTheme] = useState<Theme>(() => storedTheme() ?? systemTheme());
  const next: Theme = theme === 'dark' ? 'light' : 'dark';
  const { query, setQuery, submit } = useAddressSearch();
  const home = homeHref();

  return (
    <header className="hdr">
      <nav className="hdr-bar" aria-label="Main">
        <a className="logo" href={home} onClick={(e) => { e.preventDefault(); navigate(home); }}>
          <Mark />
          zerodust
        </a>
        <div className="navlinks">
          <a href={`${SITE}/docs`}>Docs</a>
          <a href={`${SITE}/security`}>Security</a>
          <a href={`${SITE}/offline`}>Offline page</a>
        </div>
        <button type="button" className="iconbtn" onClick={() => { applyTheme(next); setTheme(next); }} aria-label={`Switch to ${next} mode`}>
          {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
        </button>
        <button type="button" className="btn btn-ink hdr-mm" onClick={onMetaMask} disabled={metaMaskBusy}>
          <span className="hdr-mm-long">Connect MetaMask</span>
          <span className="hdr-mm-short">Connect</span>
        </button>
      </nav>
      {search && (
        <form className="hdr-search" onSubmit={submit} role="search">
          <SearchIcon />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search any address or ENS name"
            aria-label="Search any address or ENS name"
            autoComplete="off"
            spellCheck={false}
          />
        </form>
      )}
    </header>
  );
}
