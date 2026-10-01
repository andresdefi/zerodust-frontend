// The only script on the static pages: the theme button, and the build
// record on the Security page (a page cannot embed the hash of the files it
// is part of, so it reads /.well-known/zerodust-build.json, which the hash
// leaves out).
import { applyTheme, storedTheme, systemTheme } from './lib/theme';

applyTheme(storedTheme(), false);

document.getElementById('theme-toggle')?.addEventListener('click', () => {
  const current = document.documentElement.dataset.theme ?? systemTheme();
  applyTheme(current === 'dark' ? 'light' : 'dark');
});

const slots = document.querySelectorAll<HTMLElement>('[data-build]');
if (slots.length) {
  fetch('/.well-known/zerodust-build.json')
    .then((r) => r.json())
    .then((record: Record<string, string>) => {
      for (const slot of slots) {
        const value = record[slot.dataset.build!];
        if (value) slot.textContent = value;
      }
    })
    .catch(() => {});
}
