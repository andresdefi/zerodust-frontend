import { useEffect, useMemo, useState } from 'react';
import type { Closing } from './closing';
import { createPublicClient, getAddress, http, isAddress, type Address } from 'viem';
import { mainnet } from 'viem/chains';
import { normalize } from 'viem/ens';
import { ZeroDust } from '@zerodust/sdk';
import { DIRECT_RPC_URLS, RPC_URLS } from '../chains/rpcs';
import { directBalances, directChains, directRoute, preparePlan } from '../direct/plan';
import { inPool } from '../lib/pool';
import { API_URL } from '../sweep/constants';
import type { AddressChain, ChainRoutes } from './groups';

// Read-only data for one address: no wallet, no key, nothing signed. Balances and
// prices come from the API; routes from its route status (sponsored chains) or a
// route probe (direct chains); "you receive" from real quotes, asked only for the
// group the owner is looking at, after a destination is chosen.

const client = new ZeroDust({ environment: 'mainnet', baseUrl: API_URL });

/** Bridges that deliver a token, not gas (their routes go to one fixed chain) */
const TOKEN_BRIDGES = new Set(['hyperlane', 'endurance']);
/** Quotes asked at once: well under the API's 60 a minute */
const QUOTE_POOL = 3;
/** A route a bridge could not confirm ("try again") is asked this many more times */
const ROUTE_RETRIES = 2;
const ROUTE_RETRY_MS = 3000;
/** Chains a direct chain is tried on when no bridge takes it to the chosen one (as useSweep's alternatives) */
const ALT_CANDIDATES = [8453, 10, 42161, 1, 56, 137];

/** A direct chain's bridge reach to the chosen destination */
interface DirectReach {
  available: boolean | null;
  /** No bridge to the destination, but one to another chain */
  elsewhere?: boolean;
  /** Below every bridge's minimum: the least that would go */
  minimum?: bigint;
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface AddressRow extends AddressChain {
  usd: number | null;
  /** The chain announced its shutdown (closing.ts) */
  closing?: Closing;
}

export interface ChainOption {
  chainId: number;
  name: string;
  token: string;
  decimals: number;
  explorerUrl: string;
}

export type Resolution =
  | { state: 'loading' }
  | { state: 'ok'; address: Address; name: string | null }
  | { state: 'error'; message: string };

const ens = createPublicClient({ chain: mainnet, transport: http(RPC_URLS[1]) });

/** An address or ENS name typed as a recipient: the address, or why not */
export async function resolveName(q: string): Promise<{ address: Address } | { error: string }> {
  if (isAddress(q, { strict: false })) return { address: getAddress(q) };
  if (!q.includes('.')) return { error: 'That is not an address or an ENS name.' };
  try {
    const address = await ens.getEnsAddress({ name: normalize(q) });
    return address ? { address: getAddress(address) } : { error: `No address is set for ${q}.` };
  } catch {
    return { error: `Could not look up ${q}.` };
  }
}

/**
 * Whether ScamSniffer's public scam list names this address (GET /address-check, checked on our
 * server; the address never goes to ScamSniffer). null when the check could not answer: then
 * nothing is shown, the check only ever adds a warning.
 */
export async function isListedScam(address: Address): Promise<boolean | null> {
  try {
    const res = await fetch(`${API_URL}/address-check/${address}`, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const body = (await res.json()) as { listed?: unknown; available?: unknown };
    return body.available === true ? body.listed === true : null;
  } catch {
    return null;
  }
}

/** An address or an ENS name, to the address (and the name to show) */
export function useResolved(query: string): Resolution {
  const [result, setResult] = useState<{ query: string; res: Resolution } | null>(null);
  useEffect(() => {
    let cancelled = false;
    const run = async (): Promise<Resolution> => {
      if (isAddress(query, { strict: false })) {
        const address = getAddress(query);
        const name = await ens.getEnsName({ address }).catch(() => null);
        return { state: 'ok', address, name };
      }
      if (!query.includes('.')) return { state: 'error', message: 'That is not an address or an ENS name.' };
      let normalized: string;
      try {
        normalized = normalize(query);
      } catch {
        return { state: 'error', message: 'That name has characters ENS does not allow.' };
      }
      const address = await ens.getEnsAddress({ name: normalized }).catch(() => null);
      return address ? { state: 'ok', address: getAddress(address), name: normalized } : { state: 'error', message: `No address is set for ${normalized}.` };
    };
    void run().then((res) => { if (!cancelled) setResult({ query, res }); });
    return () => { cancelled = true; };
  }, [query]);
  return result?.query === query ? result.res : { state: 'loading' };
}

interface ChainInfo {
  chainId: number;
  name: string;
  nativeToken: string;
  nativeTokenDecimals: number;
  explorerUrl: string;
  metamask?: boolean;
  crossChain?: { available: boolean | null; bridges?: string[] };
  closing?: Closing;
}

export interface AddressData {
  state: 'loading' | 'error' | 'ready';
  error?: string;
  rows: AddressRow[];
  /** Every chain the funds can be sent to */
  chainOptions: ChainOption[];
  /** Chains whose balance could not be read just now (shown as such, never as empty) */
  unchecked: string[];
  routesOf: (chainId: number) => ChainRoutes;
  /** USD per token symbol, when known */
  priceOf: (symbol: string) => number | undefined;
}

/** Balances, prices and what can move each chain's gas, for any address */
export function useAddressData(address: Address | null, destination: number | null, recipient: Address | null, version = 0): AddressData {
  const [base, setBase] = useState<{ address: Address; rows: AddressRow[]; info: Map<number, ChainInfo>; chainOptions: ChainOption[]; prices: Record<string, number>; unchecked: string[] } | { address: Address; error: string } | null>(null);
  // Per destination: sponsored sources that cannot reach it, direct routes
  const [destRoutes, setDestRoutes] = useState<{ key: string; unreachable: Set<number>; direct: Record<number, DirectReach> } | null>(null);

  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    void (async () => {
      try {
        const [chains, balances, direct, directInfo, prices] = await Promise.all([
          client.getChains() as unknown as Promise<ChainInfo[]>,
          client.getBalances(address),
          directBalances(address).catch(() => []),
          directChains().catch(() => ({ chains: [], prices: {} as Record<string, number> })),
          fetch(`${API_URL}/prices`).then((r) => r.json() as Promise<{ prices?: Record<string, number> }>).then((b) => b.prices ?? {}).catch(() => ({} as Record<string, number>)),
        ]);
        const price = (symbol: string) => prices[symbol] ?? directInfo.prices[symbol];
        const usd = (balance: bigint, decimals: number, symbol: string) => {
          const p = price(symbol);
          return p ? (Number(balance) / 10 ** decimals) * p : null;
        };
        const info = new Map(chains.map((c) => [c.chainId, c]));
        const rows: AddressRow[] = [
          ...balances.chains.map((b) => {
            const c = info.get(b.chainId);
            const decimals = c?.nativeTokenDecimals ?? 18;
            return {
              chainId: b.chainId, name: b.name, token: b.nativeToken, decimals, balance: BigInt(b.balance),
              explorerUrl: c?.explorerUrl ?? '', direct: false, metamask: c?.metamask === true,
              usd: usd(BigInt(b.balance), decimals, b.nativeToken),
              ...(c?.closing ? { closing: c.closing } : {}),
            };
          }),
          // Only direct chains this page can sweep (its own RPC list)
          ...direct.filter((d) => DIRECT_RPC_URLS[d.chainId] !== undefined).map((d) => {
            const closing = directInfo.chains.find((c) => c.chainId === d.chainId)?.closing;
            return {
              chainId: d.chainId, name: d.name, token: d.token, decimals: d.decimals, balance: BigInt(d.balance),
              explorerUrl: d.explorerUrl, direct: true, metamask: false, usd: usd(BigInt(d.balance), d.decimals, d.token),
              ...(closing ? { closing } : {}),
            };
          }),
        ]
          .filter((r) => r.balance > 0n)
          .sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0) || a.name.localeCompare(b.name));
        // A chain that announced its shutdown is never a destination
        const chainOptions = [
          ...chains.filter((c) => !c.closing).map((c) => ({ chainId: c.chainId, name: c.name, token: c.nativeToken, decimals: c.nativeTokenDecimals, explorerUrl: c.explorerUrl })),
          ...directInfo.chains.filter((c) => !c.closing).map((c) => ({ chainId: c.chainId, name: c.name, token: c.token, decimals: c.decimals, explorerUrl: c.explorerUrl })),
        ].sort((a, b) => a.name.localeCompare(b.name));
        const unchecked = [
          ...(balances.chains as Array<{ name: string; checked?: boolean }>).filter((b) => b.checked === false).map((b) => b.name),
          ...direct.filter((d) => d.checked === false && DIRECT_RPC_URLS[d.chainId] !== undefined).map((d) => d.name),
        ].sort((a, b) => a.localeCompare(b));
        if (!cancelled) setBase({ address, rows, info, chainOptions, prices: { ...directInfo.prices, ...prices }, unchecked });
      } catch (error) {
        if (!cancelled) setBase({ address, error: error instanceof Error ? error.message : 'Could not load balances.' });
      }
    })();
    return () => { cancelled = true; };
  }, [address, version]);

  const ready = base && base.address === address && 'rows' in base ? base : null;
  const destKey = `${address}:${destination}:${recipient}`;

  useEffect(() => {
    if (!ready || destination === null || !recipient) return;
    let cancelled = false;
    void (async () => {
      const sponsored = ready.rows.filter((r) => !r.direct && r.chainId !== destination && gasBridges(ready.info.get(r.chainId)));
      const lists = await Promise.all(sponsored.map((r) => client.getDestinations(r.chainId).catch(() => null)));
      const unreachable = new Set<number>();
      sponsored.forEach((r, i) => {
        const list = lists[i];
        if (list && !list.some((d) => d.chainId === destination)) unreachable.add(r.chainId);
      });
      const direct: Record<number, DirectReach> = {};
      await inPool(ready.rows.filter((r) => r.direct && r.chainId !== destination), QUOTE_POOL, async (r) => {
        const probe = (toChainId: number) => directRoute({ chainId: r.chainId, toChainId, from: ready.address, recipient }).catch(() => ({ available: null } as Awaited<ReturnType<typeof directRoute>>));
        let res = await probe(destination);
        for (let i = 0; i < ROUTE_RETRIES && res.available === null && !cancelled; i++) {
          await wait(ROUTE_RETRY_MS);
          res = await probe(destination);
        }
        // Too small for every bridge: says how much is needed rather than looking unroutable
        if (res.available === false && res.minimumBalanceWei) {
          direct[r.chainId] = { available: false, minimum: BigInt(res.minimumBalanceWei) };
          return;
        }
        // No bridge to the chosen chain, or none answering after the retries: does one take it
        // somewhere else? Unconfirmed counts as blocked only when another chain is confirmed instead
        let elsewhere = false;
        if (res.available !== true) {
          for (const alt of ALT_CANDIDATES.filter((id) => id !== destination && id !== r.chainId)) {
            if (cancelled) break;
            if ((await probe(alt)).available === true) { elsewhere = true; break; }
          }
        }
        direct[r.chainId] = { available: res.available, elsewhere };
      });
      if (!cancelled) setDestRoutes({ key: destKey, unreachable, direct });
    })();
    return () => { cancelled = true; };
  }, [ready, destination, recipient, destKey]);

  const routes = destRoutes?.key === destKey ? destRoutes : null;
  const routesOf = useMemo(() => (chainId: number): ChainRoutes => {
    const row = ready?.rows.find((r) => r.chainId === chainId);
    if (!ready || !row) return { gas: null };
    if (row.direct) {
      if (destination === null) return { gas: null };
      if (!routes) return { gas: null };
      const reach = routes.direct[chainId];
      const gas = reach?.available ?? null;
      if (reach?.minimum !== undefined) return { gas: false, minimum: reach.minimum };
      if (reach?.elsewhere) return { gas: false, notToDestination: true };
      return gas === null ? { gas: null, unknown: true } : { gas };
    }
    const c = ready.info.get(chainId);
    const gas = gasBridges(c);
    if (!gas) return { gas: c?.crossChain?.available === null ? null : false };
    if (destination !== null && routes?.unreachable.has(chainId)) return { gas: false, notToDestination: true };
    return { gas: true };
  }, [ready, routes, destination]);

  const none = { rows: [], chainOptions: [], unchecked: [], routesOf: () => ({ gas: null }), priceOf: () => undefined };
  if (!address || !base || base.address !== address) return { state: 'loading', ...none };
  if ('error' in base) return { state: 'error', error: base.error, ...none };
  const prices = base.prices;
  return { state: 'ready', rows: base.rows, chainOptions: base.chainOptions, unchecked: base.unchecked, routesOf, priceOf: (symbol) => prices[symbol] };
}

/** Any bridge that carries this chain's gas out right now (not only a token route) */
function gasBridges(c: ChainInfo | undefined): boolean {
  return !!c?.crossChain?.available && (c.crossChain.bridges ?? []).some((b) => !TOKEN_BRIDGES.has(b));
}

export interface Estimate {
  receive?: bigint;
  /** The bridge that carries it, or "Same chain" */
  route?: string;
  error?: string;
}

/** "You receive" for these chains, from real quotes (nothing signed), asked a few at a time */
export function useEstimates(address: Address | null, rows: AddressRow[], destination: number | null, recipient: Address | null): Record<number, Estimate> {
  const [store, setStore] = useState<{ key: string; values: Record<number, Estimate> }>({ key: '', values: {} });
  const ids = rows.map((r) => r.chainId).join();
  const key = `${address}:${destination}:${recipient}:${ids}`;
  useEffect(() => {
    if (!address || destination === null || !recipient || rows.length === 0) return;
    let cancelled = false;
    const put = (chainId: number, e: Estimate) => setStore((prev) => (prev.key === key ? { key, values: { ...prev.values, [chainId]: e } } : { key, values: { [chainId]: e } }));
    void inPool(rows, QUOTE_POOL, async (r) => {
      try {
        if (r.direct) {
          const plan = await preparePlan({ chainId: r.chainId, toChainId: destination, from: address, recipient, mode: 'route' });
          if (!cancelled) put(r.chainId, { receive: BigInt(plan.receive), route: plan.route === 'transfer' ? 'Same chain' : DIRECT_ROUTE_NAMES[plan.route] ?? plan.route });
        } else {
          const q = await client.getQuote({ fromChainId: r.chainId, toChainId: destination, userAddress: address, destination: recipient });
          const bridge = (q as { bridge?: { displayName?: string } }).bridge?.displayName;
          if (!cancelled) put(r.chainId, { receive: BigInt(q.estimatedReceive), route: r.chainId === destination ? 'Same chain' : bridge ?? 'Bridge' });
        }
      } catch (error) {
        if (!cancelled) put(r.chainId, { error: error instanceof Error ? error.message : 'No quote' });
      }
    });
    return () => { cancelled = true; };
    // `rows` is keyed by `ids`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return store.key === key ? store.values : {};
}

const DIRECT_ROUTE_NAMES: Record<string, string> = { gaszip: 'Gas.zip', relay: 'Relay', across: 'Across', lifi: 'LI.FI', oft: 'LayerZero' };
