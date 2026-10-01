/** Where a chain's logo is served from (the offline build swaps this module for logo-src.offline.ts) */
export function logoSrc(chainId: number): string {
  return `/chains/${chainId}.svg`;
}
