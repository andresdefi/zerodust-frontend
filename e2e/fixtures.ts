// An offline ZeroDust API and chain RPCs for the end-to-end tests.
//
// Quote numbers are the SDK's recorded fixtures (zerodust/sdk
// tests/helpers/sweep-api.ts): live GET /quote + POST /authorization
// responses on Base, 2026-09-30, a same-chain transfer and a Relay route to
// Arbitrum. Addresses are the test account's and the deadline is re-based on
// the current time. The SDK verifies every quote before signing, so these
// must stay valid quotes, not shapes.
import type { Page, Route } from '@playwright/test';
import { buildSweepIntentTypedData } from '@zerodust/sdk';
import type { Address, Hex } from 'viem';
import { RPC_URLS } from '../src/chains/rpcs';

export const API = 'https://api.zerodust.xyz';
const ZERODUST = '0x3732398281d0606aCB7EC1D490dFB0591BE4c4f2';
const ZERO = '0x0000000000000000000000000000000000000000';
const EMPTY_ROUTE = '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470';
const RELAY_DEPOSITORY = '0x4cd00e387622c35bddb9b4c962c136462338bc31';
const RELAY_ROUTE_HASH = '0xaa06bfdcca59d50f8d38c5a0cb67f2741c49ecdf1bf80b495785cb86490c6932';

export const BALANCE = 532742721152083939n;
const GAS_PRICE = 6_000_000n;
const AUTH_NONCE = 7;

export const CHAINS = [
  { chainId: 8453, name: 'Base', nativeToken: 'ETH', explorerUrl: 'https://basescan.org', available: true },
  { chainId: 10, name: 'Optimism', nativeToken: 'ETH', explorerUrl: 'https://optimistic.etherscan.io', available: true },
  { chainId: 42161, name: 'Arbitrum', nativeToken: 'ETH', explorerUrl: 'https://arbiscan.io', available: true },
  // No bridge takes Scroll out right now: the owner has to choose burn or donate
  { chainId: 534352, name: 'Scroll', nativeToken: 'ETH', explorerUrl: 'https://scrollscan.com', available: false },
];
/** Chains the test wallet holds a balance on */
export const FUNDED = [8453, 10, 534352];

const nowSeconds = () => Math.floor(Date.now() / 1000);

function quote(fromChainId: number, toChainId: number, destination: string) {
  const sameChain = fromChainId === toChainId;
  return {
    quoteId: crypto.randomUUID(),
    version: 3,
    userBalance: BALANCE.toString(),
    estimatedReceive: sameChain ? '532554719945600107' : '529832916922592715',
    mode: sameChain ? 0 : 1,
    fees: {
      overheadGasUnits: sameChain ? '110000' : '200000',
      protocolFeeGasUnits: '0',
      extraFeeWei: sameChain ? '186741206483832' : '186751530448240',
      reimbGasPriceCapWei: '7200000',
      maxTotalFeeWei: sameChain ? '188001206483832' : '188661272848240',
      revokeGasUnits: '50000',
    },
    autoRevoke: true,
    intent: {
      mode: sameChain ? 0 : 1,
      destination: destination.toLowerCase(),
      destinationChainId: String(toChainId),
      callTarget: sameChain ? ZERO : RELAY_DEPOSITORY,
      routeHash: sameChain ? EMPTY_ROUTE : RELAY_ROUTE_HASH,
      minReceive: sameChain ? '532554719945600107' : '503341271076463079',
    },
    deadline: nowSeconds() + 55,
    nonce: 0,
    authNonce: AUTH_NONCE,
    validForSeconds: 55,
  };
}

function authorization(q: ReturnType<typeof quote>, fromChainId: number, user: Address) {
  return {
    sweepType: q.mode === 0 ? 'same-chain' : 'cross-chain',
    typedData: buildSweepIntentTypedData(fromChainId, user, {
      mode: q.intent.mode,
      user,
      destination: q.intent.destination as Address,
      destinationChainId: BigInt(q.intent.destinationChainId),
      callTarget: q.intent.callTarget as Address,
      routeHash: q.intent.routeHash as Hex,
      minReceive: BigInt(q.intent.minReceive),
      maxTotalFeeWei: BigInt(q.fees.maxTotalFeeWei),
      overheadGasUnits: BigInt(q.fees.overheadGasUnits),
      protocolFeeGasUnits: BigInt(q.fees.protocolFeeGasUnits),
      extraFeeWei: BigInt(q.fees.extraFeeWei),
      reimbGasPriceCapWei: BigInt(q.fees.reimbGasPriceCapWei),
      deadline: BigInt(q.deadline),
      nonce: BigInt(q.nonce),
    }),
    contractAddress: ZERODUST,
    version: 3,
  };
}

const json = (route: Route, data: unknown, status = 200) =>
  route.fulfill({
    status,
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
  });

/** Everything the page may call, answered offline; returns what was swept */
export async function mockNetwork(page: Page, user: Address) {
  const quotes = new Map<string, ReturnType<typeof quote> & { from: number; to: number }>();
  const swept = new Set<number>();
  const sweeps = new Map<string, { fromChainId: number; toChainId: number }>();

  await page.route(`${API}/**`, async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === '/chains') {
      return json(route, { chains: CHAINS.map((c) => ({ ...c, nativeTokenDecimals: 18, minBalance: '0', contractAddress: ZERODUST, enabled: true, crossChain: { available: c.available } })) });
    }
    if (path === `/balances/${user}` || path.toLowerCase() === `/balances/${user.toLowerCase()}`) {
      return json(route, {
        address: user,
        chains: CHAINS.map((c) => ({
          chainId: c.chainId, name: c.name, nativeToken: c.nativeToken,
          balance: FUNDED.includes(c.chainId) && !swept.has(c.chainId) ? BALANCE.toString() : '0',
          balanceFormatted: '', canSweep: FUNDED.includes(c.chainId) && !swept.has(c.chainId), minBalance: '0',
        })),
      });
    }
    if (path === '/destinations') {
      const from = Number(url.searchParams.get('fromChainId'));
      return json(route, { fromChainId: from, destinations: CHAINS.filter((c) => c.chainId !== from).map((c) => ({ chainId: c.chainId, name: c.name, nativeSymbol: 'ETH', nativeDecimals: 18, bridges: ['relay'], zerodustChain: true })) });
    }
    if (path === '/prices') return json(route, { prices: { ETH: 2697.86 } });
    if (path === '/quote') {
      const p = url.searchParams;
      const from = Number(p.get('fromChainId'));
      const to = Number(p.get('toChainId'));
      const q = quote(from, to, p.get('destination')!);
      quotes.set(q.quoteId, { ...q, from, to });
      return json(route, q);
    }
    if (path === '/authorization') {
      const { quoteId } = route.request().postDataJSON() as { quoteId: string };
      const q = quotes.get(quoteId)!;
      return json(route, authorization(q, q.from, user));
    }
    if (path === '/sweep' && route.request().method() === 'POST') {
      const { quoteId } = route.request().postDataJSON() as { quoteId: string };
      const { from, to } = quotes.get(quoteId)!;
      const sweepId = crypto.randomUUID();
      sweeps.set(sweepId, { fromChainId: from, toChainId: to });
      swept.add(from);
      return json(route, { sweepId, status: 'pending', sweepType: from === to ? 'same-chain' : 'cross-chain' });
    }
    if (path.startsWith('/sweep/')) {
      const sweepId = path.split('/')[2]!;
      const s = sweeps.get(sweepId)!;
      return json(route, {
        sweepId, status: 'completed', sweepType: s.fromChainId === s.toChainId ? 'same-chain' : 'cross-chain', mode: 0,
        txHash: `0x${'ab'.repeat(32)}`, destination: user, fromChainId: s.fromChainId, toChainId: s.toChainId,
        version: 3, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), revokeStatus: 'confirmed',
      });
    }
    return json(route, { error: `unmocked ${path}` }, 404);
  });

  // The public RPCs: balance and nonce as the quotes expect; 0 once swept
  const rpcChains = new Map(Object.entries(RPC_URLS).map(([id, url]) => [new URL(url).origin, Number(id)]));
  await page.route((url) => rpcChains.has(url.origin), async (route) => {
    const chainId = rpcChains.get(new URL(route.request().url()).origin)!;
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' } });
    const body = route.request().postDataJSON() as { id: number; method: string } | Array<{ id: number; method: string }>;
    const answer = (r: { id: number; method: string }) => {
      const balance = FUNDED.includes(chainId) && !swept.has(chainId) ? BALANCE : 0n;
      const result = {
        eth_chainId: `0x${chainId.toString(16)}`,
        eth_getBalance: `0x${balance.toString(16)}`,
        eth_getTransactionCount: `0x${AUTH_NONCE.toString(16)}`,
        eth_gasPrice: `0x${GAS_PRICE.toString(16)}`,
        eth_getCode: '0x',
      }[r.method];
      return result === undefined ? { jsonrpc: '2.0', id: r.id, error: { code: -32601, message: `unmocked ${r.method}` } } : { jsonrpc: '2.0', id: r.id, result };
    };
    return json(route, Array.isArray(body) ? body.map(answer) : answer(body));
  });

  // Nothing else may be contacted
  await page.route((url) => !url.origin.startsWith('http://localhost') && url.origin !== API && !rpcChains.has(url.origin), (route) =>
    route.abort('blockedbyclient')
  );

  return { swept };
}
