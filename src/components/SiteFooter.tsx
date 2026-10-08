import { SITE } from '../lib/env';

/** The site's links, as on the static pages (the offline file links to the live site) */
export function SiteFooter() {
  return (
    <footer className="foot">
      <span>ZeroDust</span>
      <span className="foot-links">
        <a href={`${SITE}/security`}>Security</a>
        <a href={`${SITE}/offline`}>Offline page</a>
        <a href={`${SITE}/docs`}>Docs</a>
        <a href={`${SITE}/terms`}>Terms</a>
        <a href={`${SITE}/privacy`}>Privacy</a>
        <a href="https://github.com/andresdefi/zerodust">Contracts and SDK</a>
        <a href="https://github.com/andresdefi/zerodust-frontend">Site source</a>
      </span>
    </footer>
  );
}
