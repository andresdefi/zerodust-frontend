import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DIRECT_RPC_URLS, RPC_URLS } from '../src/chains/rpcs';

const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')) as {
  headers: Array<{ headers: Array<{ key: string; value: string }> }>;
};
const csp = vercel.headers.flatMap((h) => h.headers).find((h) => h.key === 'Content-Security-Policy')!.value;
const connectSrc = csp.split(';').map((d) => d.trim().split(/\s+/)).find((d) => d[0] === 'connect-src')!.slice(1);

/**
 * Gas.zip's chain map: the SDK rebuilds a Gas.zip route's calldata from it
 * before signing. Without it every Gas.zip route was refused in the browser
 * ("cannot verify the Gas.zip route", 2026-10-05: Optimism, Arbitrum, Sonic).
 */
const GASZIP_CHAIN_MAP = 'https://backend.gas.zip';
/**
 * Relay's API: a MetaMask sweep routed through Relay asks Relay for the deposit itself, so the
 * recipient is the one the page asked for, not one the ZeroDust API could substitute (2026-10-06).
 */
const RELAY_API = 'https://api.relay.link';

describe('connect-src', () => {
  it('is exactly the page itself, the API, the RPC hosts the page reads, the Gas.zip chain map and Relay', () => {
    const rpcOrigins = [...Object.values(RPC_URLS), ...Object.values(DIRECT_RPC_URLS)].map((u) => new URL(u).origin);
    expect(new Set(connectSrc)).toEqual(new Set(["'self'", 'https://api.zerodust.xyz', GASZIP_CHAIN_MAP, RELAY_API, ...rpcOrigins]));
  });

  it('only lists https origins without paths', () => {
    for (const source of connectSrc.filter((s) => s !== "'self'")) {
      expect(source).toMatch(/^https:\/\/[a-z0-9.-]+$/);
    }
  });
});
