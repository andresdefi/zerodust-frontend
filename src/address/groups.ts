import { ENDURANCE_ROUTE, HYPERLANE_ROUTES } from '@zerodust/sdk';
import { TOKEN_EXITS } from '../direct/plan';
import { OFFLINE } from '../lib/env';

// The address page sorts every chain holding gas into one group by how it is swept and
// what arrives (owner, 2026-10-08). A sweep acts on one group only: groups differ in
// who can sign or where the funds go, so mixing them in one confirmation would conflict.

export type GroupKey = 'metamask' | 'key' | 'token' | 'elsewhere' | 'own-chain' | 'claim';

/** Order on the page: the easiest sweeps first */
export const GROUP_ORDER: readonly GroupKey[] = ['metamask', 'key', 'token', 'elsewhere', 'own-chain', 'claim'];

export interface AddressChain {
  chainId: number;
  name: string;
  token: string;
  decimals: number;
  balance: bigint;
  explorerUrl: string;
  /** No EIP-7702 in ZeroDust: swept by the wallet's own exact transactions (key only) */
  direct: boolean;
  /** Sweepable with a MetaMask permission (GET /chains `metamask`) */
  metamask: boolean;
}

/** What a bridge can do with a chain's balance, as far as the page knows */
export interface ChainRoutes {
  /**
   * A bridge carries it out as gas: to the chosen destination when one is set, to anywhere
   * otherwise. null: not known yet (a direct chain before its route is asked, a bridge that
   * did not answer).
   */
  gas: boolean | null;
  /** Gas bridges exist, but none reaches the chosen destination */
  notToDestination?: boolean;
  /** Asked, and no bridge gave an answer either way (throttled, down): not selected by default */
  unknown?: boolean;
}

/** A token the chain's only way out delivers instead of gas, on a fixed chain */
export interface TokenRoute {
  symbol: string;
  toChainId: number;
  toChainName: string;
}

/** The chains token routes deliver to (named here: the page's chain list may not include them) */
const TOKEN_ROUTE_CHAINS: Readonly<Record<number, string>> = { 56: 'BNB Chain', 8453: 'Base' };
const named = (symbol: string, toChainId: number): TokenRoute => ({ symbol, toChainId, toChainName: TOKEN_ROUTE_CHAINS[toChainId] ?? `chain ${toChainId}` });

export function tokenRouteOf(chainId: number): TokenRoute | null {
  const hyperlane = HYPERLANE_ROUTES[chainId];
  if (hyperlane) return named(hyperlane.token.symbol, hyperlane.toChainId);
  if (chainId === ENDURANCE_ROUTE.chainId) return named(ENDURANCE_ROUTE.token.symbol, ENDURANCE_ROUTE.toChainId);
  const exit = TOKEN_EXITS[chainId];
  if (exit) return named(exit.token.symbol, exit.toChainId);
  return null;
}

/**
 * The group a chain falls in. `destination` is the chosen chain, or null before one is
 * picked (then only what the chain can do at all counts).
 */
export function groupOf(chain: AddressChain, routes: ChainRoutes, destination: number | null): GroupKey {
  // The offline file is key-only, so every gas chain is in the key group there
  const signer: GroupKey = chain.metamask && !chain.direct && !OFFLINE ? 'metamask' : 'key';
  // Staying on the same chain is always a plain transfer
  if (destination !== null && chain.chainId === destination) return signer;
  if (routes.gas === true) return signer;
  if (routes.notToDestination) return 'elsewhere';
  if (tokenRouteOf(chain.chainId)) return 'token';
  // Not known yet: the gas groups, until a bridge says otherwise
  if (routes.gas === null) return signer;
  return 'own-chain';
}

export interface Group<T extends AddressChain = AddressChain> {
  key: GroupKey;
  chains: T[];
}

/** The chains in their groups, in page order; empty groups are left out */
export function groupChains<T extends AddressChain>(chains: T[], routesOf: (chainId: number) => ChainRoutes, destination: number | null): Group<T>[] {
  const byKey = new Map<GroupKey, T[]>();
  for (const c of chains) {
    const key = groupOf(c, routesOf(c.chainId), destination);
    byKey.set(key, [...(byKey.get(key) ?? []), c]);
  }
  return GROUP_ORDER.filter((k) => byKey.has(k)).map((key) => ({ key, chains: byKey.get(key)! }));
}

/** Copy for each group (provisional, rewritten with the rest of the site's copy) */
export function groupText(key: GroupKey, destinationName: string | null): { title: string; detail: string; tag?: string } {
  const to = destinationName ? `on ${destinationName}` : 'on the chain you choose';
  switch (key) {
    case 'metamask':
      return { title: 'MetaMask or key', tag: destinationName ? `Gas ${to}` : undefined, detail: `Swept with MetaMask (no key) or the key. Arrives as gas ${to}.` };
    case 'key':
      return OFFLINE
        ? { title: 'With the key', tag: destinationName ? `Gas ${to}` : undefined, detail: `Swept with this wallet's key, which stays in this file. Arrives as gas ${to}.` }
        : { title: 'Key only', tag: destinationName ? `Gas ${to}` : undefined, detail: `MetaMask doesn't cover these yet. Arrives as gas ${to}.` };
    case 'token':
      return { title: 'Arrives as a token', tag: 'Not gas', detail: 'No bridge carries these as gas. Each one\'s own bridge delivers its token to your wallet on another chain.' };
    case 'elsewhere':
      return { title: `Can't reach ${destinationName ?? 'that chain'}`, detail: 'Bridges take these out, but not to the chain you chose. Pick another chain for them.' };
    case 'own-chain':
      return { title: 'Stays on its own chain', detail: 'Nothing bridges out of these right now. The gas goes to an address you choose on the same chain.' };
    case 'claim':
      return { title: 'Needs a claim later', tag: 'Native bridge', detail: 'The chain\'s own bridge carries it to Ethereum. It arrives after its waiting period, once you send a claim transaction there.' };
  }
}
