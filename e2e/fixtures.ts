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
import { DIRECT_RPC_URLS, RPC_URLS } from '../src/chains/rpcs';

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

/** A direct chain (Avalanche) holding AVAX_BALANCE when `direct` is on */
export const AVAX = 43114;
export const AVAX_BALANCE = 10n ** 17n;
const AVAX_PRICE = 27_500_000_000n;
const ZERODUST_SPONSOR = '0x01eD5c94DE39E73C986b98B85C2c0A3d1BEDff7D';
const GASZIP_DEPOSIT = '0x391E7C679d29bD940d63be94AD22A25d25b5A604';

/** The API's plan for Avalanche to self: fee, then a Gas.zip deposit (0x01 + Base's short), exact */
function avaxPlan(nonce: number) {
  const fee = 2n * 10n ** 15n;
  const depositGas = 21_036n; // 21,000 + 16 x 2 non-zero bytes + 4 x 1 zero byte (pre-Prague)
  const value = AVAX_BALANCE - fee - 21_000n * AVAX_PRICE - depositGas * AVAX_PRICE;
  return {
    chainId: AVAX, route: 'gaszip', requestId: null, receive: '700000000000000', fee: fee.toString(), balance: AVAX_BALANCE.toString(),
    txs: [
      { kind: 'fee', to: ZERODUST_SPONSOR, data: '0x', value: fee.toString(), gas: '21000', gasPrice: AVAX_PRICE.toString(), nonce },
      { kind: 'sweep', to: GASZIP_DEPOSIT, data: '0x010036', value: value.toString(), gas: depositGas.toString(), gasPrice: AVAX_PRICE.toString(), nonce: nonce + 1 },
    ],
  };
}

/** Everything the page may call, answered offline; returns what was swept */
export async function mockNetwork(page: Page, user: Address, opts: { direct?: boolean; tamper?: boolean } = {}) {
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
    if (path === '/direct/chains') return json(route, { chains: [{ chainId: AVAX, name: 'Avalanche', token: 'AVAX', decimals: 18, explorerUrl: 'https://snowtrace.io', rpcUrl: DIRECT_RPC_URLS[AVAX] }], prices: { AVAX: 25 } });
    if (path.startsWith('/direct/balances/')) {
      return json(route, opts.direct ? [{ chainId: AVAX, name: 'Avalanche', token: 'AVAX', decimals: 18, explorerUrl: 'https://snowtrace.io', balance: (swept.has(AVAX) ? 0n : AVAX_BALANCE).toString() }] : []);
    }
    if (path === '/direct/route') return json(route, { available: true });
    if (path === '/direct/prepare') {
      const plan = avaxPlan(directNonce);
      // A compromised API: the same amounts, but the deposit credits an attacker on Base
      if (opts.tamper) plan.txs[1]!.data = `0x02${'ba'.repeat(20)}0036`;
      return json(route, plan);
    }
    if (path === '/direct/status') return json(route, { state: 'delivered', destTx: `0x${'cd'.repeat(32)}` });
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

  // The public RPCs: balance and nonce as the quotes expect; 0 once swept.
  // Direct chain (Avalanche): the page also replays on a fork and broadcasts here.
  let directNonce = 4;
  const sent: string[] = [];
  const rpcChains = new Map([...Object.entries(RPC_URLS), ...Object.entries(DIRECT_RPC_URLS)].map(([id, url]) => [new URL(url).origin, Number(id)]));
  await page.route((url) => rpcChains.has(url.origin), async (route) => {
    const chainId = rpcChains.get(new URL(route.request().url()).origin)!;
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' } });
    const body = route.request().postDataJSON() as { id: number; method: string; params?: unknown[] } | Array<{ id: number; method: string; params?: unknown[] }>;
    const answer = (r: { id: number; method: string; params?: unknown[] }) => {
      const isUser = String(r.params?.[0] ?? '').toLowerCase() === user.toLowerCase();
      const direct = chainId === AVAX;
      const balance = direct
        ? (isUser && opts.direct && !swept.has(AVAX) ? AVAX_BALANCE : 0n)
        : (FUNDED.includes(chainId) && !swept.has(chainId) ? BALANCE : 0n);
      if (r.method === 'eth_sendRawTransaction') {
        sent.push(String(r.params![0]));
        directNonce += 1;
        // The sweep is the second transaction: after it the wallet is empty
        if (sent.length === 2) swept.add(AVAX);
        return { jsonrpc: '2.0', id: r.id, result: `0x${sent.length.toString(16).padStart(64, '0')}` };
      }
      const result = {
        eth_chainId: `0x${chainId.toString(16)}`,
        eth_getBalance: `0x${(direct ? balance : isUser || !r.params ? balance : 0n).toString(16)}`,
        eth_getTransactionCount: direct ? `0x${(isUser ? directNonce : 0).toString(16)}` : `0x${AUTH_NONCE.toString(16)}`,
        eth_gasPrice: `0x${GAS_PRICE.toString(16)}`,
        eth_getCode: '0x',
        eth_getStorageAt: `0x${'0'.repeat(64)}`,
        eth_getBlockByNumber: { number: '0x3e8', timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}`, gasLimit: '0x1c9c380' },
        eth_getTransactionReceipt: { status: '0x1' },
      }[r.method];
      return result === undefined ? { jsonrpc: '2.0', id: r.id, error: { code: -32601, message: `unmocked ${r.method}` } } : { jsonrpc: '2.0', id: r.id, result };
    };
    return json(route, Array.isArray(body) ? body.map(answer) : answer(body));
  });

  // Nothing else may be contacted
  await page.route((url) => !url.origin.startsWith('http://localhost') && url.origin !== API && !rpcChains.has(url.origin), (route) =>
    route.abort('blockedbyclient')
  );

  return { swept, sent };
}
