import { API_URL } from '../sweep/constants';
import { OFFLINE } from './env';

/** Steps the API never sees otherwise (backend services/page-events.ts has the same list) */
export type PageEvent =
  | 'home'
  | 'address'
  | 'metamask-connect'
  | 'metamask-connected'
  | 'metamask-missing'
  | 'metamask-refused'
  | 'sweep-dialog'
  | 'sweep-with-key'
  | 'key-entered'
  | 'sweep-confirm'
  | 'sweep-started'
  | 'page-error'
  | Source;

/** The kind of site a visit came from, counted once per visit; never the URL itself */
export type Source = 'from-x' | 'from-hiddenfunds' | 'from-search' | 'from-other' | 'from-direct';

const SEARCH = /(^|\.)(google|bing|duckduckgo|yahoo|yandex|baidu|ecosia|startpage|qwant|kagi)\.|^search\.brave\.com$/;

/** The referrer as a category; null when it is this site itself (a page linking to another) */
export function sourceOf(referrer: string): Source | null {
  if (!referrer) return 'from-direct';
  let host: string;
  try { host = new URL(referrer).hostname.toLowerCase(); } catch { return 'from-other'; }
  if (host === 'zerodust.xyz' || host.endsWith('.zerodust.xyz')) return null;
  if (host === 't.co' || host === 'x.com' || host.endsWith('.x.com') || host === 'twitter.com' || host.endsWith('.twitter.com')) return 'from-x';
  if (host === 'hiddenfunds.xyz' || host.endsWith('.hiddenfunds.xyz')) return 'from-hiddenfunds';
  if (SEARCH.test(host)) return 'from-search';
  return 'from-other';
}

/** Only the live site counts: never the offline file, local runs or previews */
export function counts(hostname: string, offline: boolean): boolean {
  return !offline && (hostname === 'zerodust.xyz' || hostname === 'www.zerodust.xyz');
}

/**
 * Tell the API a step happened: the bare event name and nothing else (no address, no
 * identifier). It only adds to daily totals. Fire and forget: a failure changes nothing.
 */
export function track(event: PageEvent): void {
  // A build-time constant: the offline file's build drops the rest of this function
  if (OFFLINE) return;
  if (typeof window === 'undefined' || !counts(window.location.hostname, false)) return;
  void fetch(`${API_URL}/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event }),
    keepalive: true,
  }).catch(() => {});
}

/**
 * Once per visit: where it came from, and whether the page hit an error it did not handle (only
 * errors from this site's own scripts; a wallet extension's are not ours).
 */
export function trackVisit(): void {
  if (OFFLINE) return;
  if (typeof window === 'undefined' || !counts(window.location.hostname, false)) return;
  const source = sourceOf(document.referrer);
  if (source) track(source);
  let failed = false;
  const failedOnce = () => { if (!failed) { failed = true; track('page-error'); } };
  window.addEventListener('error', (e) => { if (e.filename?.startsWith(window.location.origin)) failedOnce(); });
  window.addEventListener('unhandledrejection', failedOnce);
}
