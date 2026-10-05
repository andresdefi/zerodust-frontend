import { useState } from 'react';
import { Mark, MoonIcon, SunIcon } from './icons';
import { applyTheme, storedTheme, systemTheme, type Theme } from '../lib/theme';
import { SITE } from '../lib/env';

export function Nav() {
  const [theme, setTheme] = useState<Theme>(() => storedTheme() ?? systemTheme());
  const next: Theme = theme === 'dark' ? 'light' : 'dark';

  const toggle = () => {
    applyTheme(next);
    setTheme(next);
  };

  return (
    <nav className="nav" aria-label="Main">
      <a className="logo" href={SITE || '/'}>
        <Mark />
        zerodust
      </a>
      <div className="navlinks">
        <a href={`${SITE}/security`}>Security</a>
        <a href={`${SITE}/offline`}>Offline page</a>
        <a href={`${SITE}/docs`}>Docs</a>
        <a href="https://github.com/andresdefi/zerodust">GitHub</a>
      </div>
      <button type="button" className="iconbtn" onClick={toggle} aria-label={`Switch to ${next} mode`}>
        {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
      </button>
    </nav>
  );
}
