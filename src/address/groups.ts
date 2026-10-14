import { ENDURANCE_ROUTE, HYPERLANE_ROUTES, OFT_ROUTES } from '@zerodust/sdk';
import { TOKEN_EXITS } from '../direct/plan';
import { OFFLINE } from '../lib/env';
import { nativeExitOf } from '../sweep/native';

// The address page sorts every chain holding gas into one group by how it is swept and
// what arrives (owner, 2026-10-08). A sweep acts on one group only: groups differ in
// who can sign or where the funds go, so mixing them in one confirmation would conflict.

export type GroupKey = 'gas' | 'token' | 'elsewhere' | 'own-chain' | 'claim';

/** Order on the page: the easiest sweeps first */
export const GROUP_ORDER: readonly GroupKey[] = ['gas', 'token', 'elsewhere', 'own-chain', 'claim'];

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
  /** Below every bridge's minimum: the least a bridge takes (stays in its gas group, not selected) */
  minimum?: bigint;
  /** Its bridge keeps a fixed fee whatever the amount (Meson from opBNB), and the chain it reaches */
  fixedFee?: FixedFee;
}

export interface FixedFee {
  /** In the chain's own token */
  amount: bigint;
  /** The API's route name (meson) */
  bridge: string;
  toChainId: number;
}

/** A token the chain's only way out delivers instead of gas, on a fixed chain */
export interface TokenRoute {
  symbol: string;
  toChainId: number;
  toChainName: string;
  /** Other chains the token can go to instead (0G: Ethereum), named for the row's tip */
  alsoTo?: string[];
}

/** The chains token routes deliver to (named here: the page's chain list may not include them) */
const TOKEN_ROUTE_CHAINS: Readonly<Record<number, string>> = { 1: 'Ethereum', 56: 'BNB Chain', 8453: 'Base' };
const named = (symbol: string, toChainId: number): TokenRoute => ({ symbol, toChainId, toChainName: TOKEN_ROUTE_CHAINS[toChainId] ?? `chain ${toChainId}` });

/**
 * Where a token chain's sweep goes: its only destination, or for a token with several (0G: BNB
 * Chain or Ethereum, owner 2026-10-14) the chosen destination when it is one of them, else the
 * first (the cheapest)
 */
export function tokenRouteOf(chainId: number, destination: number | null = null): TokenRoute | null {
  const hyperlane = HYPERLANE_ROUTES[chainId];
  if (hyperlane) return named(hyperlane.token.symbol, hyperlane.toChainId);
  if (chainId === ENDURANCE_ROUTE.chainId) return named(ENDURANCE_ROUTE.token.symbol, ENDURANCE_ROUTE.toChainId);
  const oft = OFT_ROUTES[chainId];
  if (oft) {
    const route = oft.routes.find((r) => r.toChainId === destination) ?? oft.routes[0]!;
    const others = oft.routes.filter((r) => r !== route).map((r) => TOKEN_ROUTE_CHAINS[r.toChainId] ?? `chain ${r.toChainId}`);
    return { ...named(route.token.symbol, route.toChainId), ...(others.length > 0 ? { alsoTo: others } : {}) };
  }
  const exit = TOKEN_EXITS[chainId];
  if (exit) return named(exit.token.symbol, exit.toChainId);
  return null;
}

/**
 * The group a chain falls in. `destination` is the chosen chain, or null before one is
 * picked (then only what the chain can do at all counts).
 */
export function groupOf(chain: AddressChain, routes: ChainRoutes, destination: number | null): GroupKey {
  // One gas group whoever signs (owner, 2026-10-08): the key sweeps all of it in one go, MetaMask
  // the chains it covers (the rest are tagged "Key only" and stay for the key)
  const signer: GroupKey = 'gas';
  // Staying on the same chain is always a plain transfer
  if (destination !== null && chain.chainId === destination) return signer;
  if (routes.gas === true || routes.minimum !== undefined) return signer;
  if (routes.notToDestination) return 'elsewhere';
  if (tokenRouteOf(chain.chainId)) return 'token';
  // Not known yet: the gas groups, until a bridge says otherwise
  if (routes.gas === null) return signer;
  // No route at all: the chain's own bridge, where it has one (owner, 2026-10-12: only then)
  if (nativeExitOf(chain.chainId)) return 'claim';
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
export function groupText(key: GroupKey, destinationName: string | null, opts: { keyOnly?: number; relayed?: 'all' | 'some'; tokens?: Array<{ chain: string; symbol: string }>; parents?: Array<{ chain: string; parent: string; symbol: string }>; claimHours?: number[] } = {}): { title: string; detail: string; tag?: string } {
  switch (key) {
    case 'gas':
      return {
        title: destinationName ? `Arrives as gas on ${destinationName}` : 'Arrives as gas',
        detail: OFFLINE ? 'Swept with this wallet\'s key, which stays in this file.'
          : opts.keyOnly ? 'Sign with the key for all of them, or with MetaMask (no key needed) for the ones it covers. Chains tagged Key only need the key.'
          : 'Sign with MetaMask (no key needed) or with the key.',
      };
    case 'token':
      return { title: 'Arrives as a token', tag: 'Not gas', detail: 'No bridge carries these out as gas. Each chain\'s own bridge sends its token to your wallet on another chain.' };
    case 'elsewhere':
      return { title: `Can't reach ${destinationName ?? 'that chain'}`, detail: 'Bridges take these out, but not to the chain you chose. Pick another chain for them.' };
    case 'own-chain':
      return { title: 'Stays on its own chain', detail: 'Nothing bridges out of these right now. The gas goes to an address you choose on the same chain.' };
    case 'claim': {
      // Chains whose gas arrives as a token on Ethereum, named in the group as in the rows
      const t = opts.tokens ?? [];
      const tokens = t.length === 0 ? ''
        : ` ${t.map((x, i) => i === 0 ? `${x.chain} arrives as ${x.symbol}` : `${x.chain} as ${x.symbol}`).join(t.length > 2 ? ', ' : ' and ')}, ${t.length === 1 ? 'a token' : 'tokens'} on Ethereum, not ETH.`;
      // How long until the claims open: days (OP and Arbitrum stacks), about an hour (X Layer), or both
      const hours = opts.claimHours ?? [];
      const wait = hours.length > 0 && Math.max(...hours) <= 2 ? 'after about an hour'
        : hours.length > 0 && Math.min(...hours) <= 2 ? 'after a wait of an hour to days (the rows say how long)'
          : 'after a wait of days';
      // Chains whose own bridge settles elsewhere than Ethereum (opBNB: BNB Chain), named in the sentence
      const all = opts.parents ?? [];
      const other = all.filter((x) => x.parent !== 'Ethereum');
      const to = other.length === 0 ? 'Ethereum'
        : other.length === all.length && new Set(other.map((x) => x.parent)).size === 1 ? other[0]!.parent
          : `Ethereum (${other.map((x) => `${x.chain}'s to ${x.parent}`).join(', ')})`;
      const how = opts.relayed === 'all'
        ? `No other bridge takes these out, so each chain's own bridge sends it to ${to}. It arrives by itself, about an hour later.`
        : opts.relayed === 'some'
          ? `No other bridge takes these out, so each chain's own bridge sends it to ${to}. Most need a claim there later, ${wait}; the rows say which.`
          : `Needs a claim later. No other bridge takes these out, so each chain's own bridge sends it to ${to}, where you claim it ${wait}. Nothing arrives by itself.`;
      return { title: 'Native bridges only', detail: `${how}${tokens} Sweep with the key.` };
    }
  }
}
