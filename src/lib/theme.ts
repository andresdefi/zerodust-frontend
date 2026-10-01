export type Theme = 'light' | 'dark';

const KEY = 'zerodust-theme';

/** The theme the viewer picked, if any; storage can be missing or blocked */
export function storedTheme(): Theme | null {
  try {
    const value = localStorage.getItem(KEY);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null;
  }
}

export function systemTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** Apply a theme and remember it; without a stored choice the page follows the system */
export function applyTheme(theme: Theme | null, remember = true): void {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  if (!remember || !theme) return;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // Storage unavailable: the choice lasts for this page only
  }
}
