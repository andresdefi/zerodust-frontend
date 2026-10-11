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
  | 'sweep-with-key';

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
