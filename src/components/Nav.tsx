import { useState } from 'react';
import { Mark, MoonIcon, SunIcon } from './icons';
import { applyTheme, storedTheme, systemTheme, type Theme } from '../lib/theme';

export function Nav() {
  const [theme, setTheme] = useState<Theme>(() => storedTheme() ?? systemTheme());
  const next: Theme = theme === 'dark' ? 'light' : 'dark';

  const toggle = () => {
    applyTheme(next);
    setTheme(next);
  };

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
      <button type="button" className="iconbtn" onClick={toggle} aria-label={`Switch to ${next} mode`}>
        {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
      </button>
    </nav>
  );
}
