import { PNG_LOGOS } from './logo-ids';

/** Where a chain's logo is served from (the offline build swaps this module for logo-src.offline.ts) */
export function logoSrc(chainId: number): string {
  return `/chains/${chainId}.${PNG_LOGOS.has(chainId) ? 'png' : 'svg'}`;
}
