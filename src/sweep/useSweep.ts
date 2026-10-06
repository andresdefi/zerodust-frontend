import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getAddress, isAddress, parseUnits, type Address, type LocalAccount } from 'viem';
import { ZeroDust, ZeroDustAgent, deliveredToken, deliversOnlyToSender, type Destination } from '@zerodust/sdk';
import { DIRECT_RPC_URLS, RPC_URLS } from '../chains/rpcs';
import { inPool } from '../lib/pool';
import { readState } from '../lib/rpc';
import { deliveryStatus, directBalances, directChains, directRoute, BURN_ADDRESS, ZERODUST_ADDRESS, type PlanMode } from '../direct/plan';
import { broadcast, planChecked, settledBalance, signPlan } from '../direct/run';
import { API_URL } from './constants';
import { formatAmountUp } from '../lib/format';
import { sendReport, type SweepReport } from './report';
import { permissionQuote, sweepBatchWithPermissions, sweepStatus, type MetaMaskSession } from './metamask';

// Mirrors the local sweeper (local-sweeper/src/App.tsx), which is proven with
// real funds: ZeroDust's sponsored (EIP-7702) chains through the SDK, and
// direct chains (no 7702) swept by the wallet itself with exact legacy
// transactions, planned by the API and checked, replayed and sent by this page.

export { API_URL, BURN_ADDRESS, ZERODUST_ADDRESS };

/** Chains checked or swept at once; keeps well under the API's 60 quotes a minute */
const PARALLEL_CHAINS = 3;

/** A route the API could not confirm is asked again this often before other chains are offered */
const ROUTE_RETRIES = 2;
const ROUTE_RETRY_MS = 3000;

/**
 * What to do with a chain no route takes to the destination. Direct chains
 * with a swap route can also swap out; the few cents of gas reserve the swap
 * leaves are then donated or burned, so the wallet still ends at exactly 0.
 */
export type Choice = 'exit-donate' | 'exit-burn' | 'donate' | 'burn' | 'elsewhere';
export const isExit = (c?: Choice) => c === 'exit-donate' || c === 'exit-burn';
/** The balance reaches the recipient (on the chosen chain, or on another one for 'elsewhere') */
export const isRouted = (c?: Choice) => !c || isExit(c) || c === 'elsewhere';

/**
 * Chains offered instead when a source cannot reach the chosen destination
 * ('elsewhere'): the balance goes to the same address on one of these.
 */
const ALT_CANDIDATES = [8453, 10, 42161, 1, 56, 137];

export interface Row {
  chainId: number;
  name: string;
  token: string;
  decimals: number;
  balance: bigint;
  canSweep: boolean;
  explorerUrl: string;
  /** No 7702 in ZeroDust: the wallet sweeps itself with exact legacy transactions */
  direct?: boolean;
  /** Why this wallet cannot sweep the chain at all (MetaMask: no permission there); shown instead of "too small" */
  unavailable?: string;
}

/** A chain the funds can go to, and from how many of the loaded sources */
export interface DestOption {
  chainId: number;
  name: string;
  token: string;
  decimals: number;
  reachableFrom: number;
}

export type Phase = 'idle' | 'quoting' | 'ready' | 'no-route' | 'sweeping' | 'done' | 'failed';

export interface RowState {
  phase: Phase;
  /** Estimated amount arriving, in the destination's token */
  receive?: bigint;
  detail?: string;
  txHash?: string;
  /** A transaction left this wallet (or the relayer took the sweep): a failure then needs checking */
  sent?: boolean;
  /** What was reported to the API (POST /reports), for "Copy details" */
  report?: SweepReport;
  /** The API's reference for that report (ZD-1A2B3C4D); absent if it could not be recorded */
  reference?: string;
  choice?: Choice;
  /** Direct chains: ZeroDust's fee in the chain's token, paid as its own transfer */
  fee?: bigint;
  /** Where `receive` arrives: the destination, or another chain for 'elsewhere' */
  toChainId?: number;
  /**
   * Token delivery (a Hyperlane warp route, e.g. Mitosis): `receive` is this
   * token on the destination, not its gas
   */
  token?: { symbol: string; decimals: number };
}

/** Display names of the bridges a direct plan can use (the API's own adapters name the sponsored ones) */
const DIRECT_BRIDGE_NAMES: Record<string, string> = { gaszip: 'Gas.zip', relay: 'Relay', across: 'Across', lifi: 'LI.FI' };

/** The bridge that carries a sponsored quote, as the API names it (none for a same-chain transfer) */
/** The quote's bridge id (gaszip, relay, across, hyperlane, endurance), for reports */
function bridgeName(quote: unknown): string | undefined {
  return (quote as { bridge?: { name?: string } } | undefined)?.bridge?.name;
}

function quoteBridge(quote: unknown): string | undefined {
  return (quote as { bridge?: { displayName?: string } } | undefined)?.bridge?.displayName;
}

/** The token a row delivers instead of gas on `toChainId`, if any (owner decision 2026-10-03) */
export function rowToken(sourceChainId: number, toChainId: number): RowState['token'] {
  const t = deliveredToken(sourceChainId, toChainId);
  return t ? { symbol: t.symbol, decimals: t.decimals } : undefined;
}

/** What arrives on one chain, in one asset (its gas, or a delivered token) */
export interface DestTotal {
  dest: DestOption;
  amount: bigint;
  symbol: string;
  decimals: number;
  /** A token, not the chain's gas */
  isToken: boolean;
}

export type Stage = 'loading' | 'error' | 'empty' | 'select' | 'checked' | 'sweeping' | 'done';

interface ChainInfo {
  name: string;
  nativeToken: string;
  nativeTokenDecimals: number;
  explorerUrl: string;
  crossChain?: { available: boolean | null };
}

const client = new ZeroDust({ environment: 'mainnet', baseUrl: API_URL });

/**
 * The wallet being swept: a key held in this tab (the SDK signs everything), or a MetaMask
 * account that grants a permission per chain (metamask.ts; the key stays in MetaMask)
 */
export type Wallet = { kind: 'key'; account: LocalAccount } | { kind: 'metamask'; session: MetaMaskSession };

/** Shown on a chain MetaMask cannot sweep: the plain way out is the key */
export const NEEDS_KEY = 'MetaMask cannot sweep this chain yet. Load the wallet with its key instead.';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Seconds since `start` (ms); module-level so the hook body stays pure */
const secondsSince = (start: number) => Math.round((Date.now() - start) / 1000);
const nowMs = () => Date.now();

export function useSweep(wallet: Wallet) {
  const account = wallet.kind === 'key' ? wallet.account : null;
  const session = wallet.kind === 'metamask' ? wallet.session : null;
  const address: Address = account ? account.address : session!.address;
  const agent = useMemo(
    () => (account ? new ZeroDustAgent({ account, environment: 'mainnet', baseUrl: API_URL, rpcUrls: RPC_URLS }) : null),
    [account]
  );

  const [rows, setRows] = useState<Row[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [prices, setPrices] = useState<Record<string, number>>({});
  const [dests, setDests] = useState<DestOption[]>([]);
  const [sourceCount, setSourceCount] = useState(0);
  // Per sponsored source: does any bridge accept it now (route status, re-probed
  // every 10 min by the API), and which chains its bridges deliver to
  const [routes, setRoutes] = useState<Record<number, { available: boolean | null; dests: Set<number> }>>({});
  // Per direct source, for the chosen destination: can a bridge take it (exit: only a swap can)
  const [directRoutes, setDirectRoutes] = useState<Record<number, { available: boolean | null; exit?: boolean; minimumBalanceWei?: string }>>({});
  // No default destination (owner decision): the owner picks the chain
  const [destination, setDestinationState] = useState<number | null>(null);
  const [recipient, setRecipientState] = useState<string>(address);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [states, setStates] = useState<Record<number, RowState>>({});
  const [choices, setChoices] = useState<Record<number, Choice>>({});
  // Direct sources that cannot reach the destination: the other chains a bridge takes them to
  const [alts, setAlts] = useState<Record<number, number[]>>({});
  // 'elsewhere' choices: the chain each of those sources goes to instead
  const [elsewhere, setElsewhere] = useState<Record<number, number>>({});
  // Which bridge carries each chain (owner, 2026-10-03: say plainly the bridging is theirs, not ZeroDust's)
  const [bridgeOf, setBridgeOf] = useState<Record<number, string>>({});
  const setBridge = (chainId: number, name: string | undefined) =>
    setBridgeOf((prev) => {
      const next = { ...prev };
      if (name) next[chainId] = name;
      else delete next[chainId];
      return next;
    });
  const [busy, setBusy] = useState(false);
  const [swept, setSwept] = useState(false);
  // Direct chains: a fee transfer that landed before its sweep failed is not charged again
  const feePaid = useRef<Record<number, string>>({});
  // MetaMask: the permission router the API quotes (the same address on every chain)
  const router = useRef<Address | null>(null);

  const setState = (chainId: number, state: RowState) => setStates((prev) => ({ ...prev, [chainId]: state }));

  /**
   * Reports a finished row (POST /reports) and puts the reference on it. Never
   * throws or waits on the sweep: a failed report only means no reference.
   */
  const report = (row: Row, st: RowState, r: Omit<SweepReport, 'outcome' | 'failureKind' | 'address' | 'chainId' | 'detail'>) => {
    const failed = st.phase === 'failed';
    const full: SweepReport = {
      ...r,
      outcome: failed ? 'failed' : 'done',
      ...(failed ? { failureKind: failureKind(st, row.decimals) } : {}),
      address,
      chainId: row.chainId,
      ...(st.detail ? { detail: st.detail } : {}),
    };
    setStates((prev) => ({ ...prev, [row.chainId]: { ...prev[row.chainId]!, report: full } }));
    void sendReport(full).then((reference) => {
      if (reference) setStates((prev) => ({ ...prev, [row.chainId]: { ...prev[row.chainId]!, reference } }));
    });
  };

  const loadDestinations = useCallback(async (loadedRows: Row[], chainInfo: Map<number, ChainInfo>) => {
    const sources = loadedRows.filter((r) => r.canSweep && !r.direct);
    const lists: Destination[][] = await Promise.all(sources.map((r) => client.getDestinations(r.chainId).catch(() => [])));
    setRoutes(Object.fromEntries(sources.map((r, i) => [r.chainId, {
      available: chainInfo.get(r.chainId)?.crossChain?.available ?? null,
      dests: new Set(lists[i]!.map((d) => d.chainId)),
    }])));
    const merged = new Map<number, DestOption>();
    // Every ZeroDust chain is a destination too; the check confirms each route
    for (const [chainId, c] of chainInfo) {
      merged.set(chainId, { chainId, name: c.name, token: c.nativeToken, decimals: c.nativeTokenDecimals, reachableFrom: 0 });
    }
    lists.forEach((list, i) => {
      for (const d of list) {
        if (d.chainId === sources[i]!.chainId) continue;
        const entry = merged.get(d.chainId) ?? { chainId: d.chainId, name: d.name, token: d.nativeSymbol, decimals: d.nativeDecimals, reachableFrom: 0 };
        entry.reachableFrom += 1;
        merged.set(d.chainId, entry);
      }
    });
    // A source chain is reached by its own balance when it is the destination
    for (const r of sources) {
      const entry = merged.get(r.chainId);
      if (entry) entry.reachableFrom += 1;
    }
    setSourceCount(sources.length);
    setDests([...merged.values()].sort((a, b) => b.reachableFrom - a.reachableFrom || a.name.localeCompare(b.name)));
  }, []);

  // `keep`: chains to list even at 0, so a finished sweep stays on screen with its result
  const refresh = useCallback(async (keep: Set<number> = new Set()) => {
    try {
      const [chains, balances, direct] = await Promise.all([
        client.getChains(),
        client.getBalances(address),
        // Direct chains are extra: their absence must not block the sponsored ones
        directBalances(address).catch(() => []),
      ]);
      const byId = new Map<number, ChainInfo>(chains.map((c) => [c.chainId, c as unknown as ChainInfo]));
      const next = balances.chains
        .map((b): Row => ({
          chainId: b.chainId,
          name: b.name,
          token: b.nativeToken,
          decimals: byId.get(b.chainId)?.nativeTokenDecimals ?? 18,
          balance: BigInt(b.balance),
          canSweep: b.canSweep,
          explorerUrl: byId.get(b.chainId)?.explorerUrl ?? '',
        }))
        // Only direct chains this page can serve (its own RPC list): the API may list a chain first
        .concat(direct.filter((d) => DIRECT_RPC_URLS[d.chainId] !== undefined).map((d): Row => ({
          chainId: d.chainId, name: d.name, token: d.token, decimals: d.decimals, explorerUrl: d.explorerUrl,
          balance: BigInt(d.balance), canSweep: BigInt(d.balance) > 0n, direct: true,
        })))
        // Only chains holding something; an empty chain has nothing to sweep
        .filter((r) => r.balance > 0n || keep.has(r.chainId))
        // MetaMask sweeps only through a permission: direct chains, and chains MetaMask grants none on, need the key
        .map((r) => (session && (r.direct || !session.permissionChains.has(r.chainId)) ? { ...r, canSweep: false, unavailable: NEEDS_KEY } : r))
        .sort((a, b) => a.name.localeCompare(b.name));
      setRows(next);
      setLoadError(null);
      setLoaded(true);
      void loadDestinations(next, byId);
      return next;
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Could not load balances.');
      setLoaded(true);
      return [];
    }
  }, [address, loadDestinations, session]);

  useEffect(() => {
    // Data fetch on load: refresh only sets state after its requests resolve
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh().then((loadedRows) => {
      // Direct chains are selected too (owner decision, 2026-10-01)
      setSelected(new Set(loadedRows.filter((r) => r.canSweep).map((r) => r.chainId)));
    });
  }, [refresh]);

  // USD prices, only to show what a sweep is worth; nothing depends on them.
  // Direct chains' tokens come from Gas.zip's list; the API's prices win where both exist.
  useEffect(() => {
    fetch(`${API_URL}/prices`)
      .then((r) => r.json())
      .then((body: { prices?: Record<string, number> }) => setPrices((prev) => ({ ...prev, ...(body.prices ?? {}) })))
      .catch(() => {});
    directChains()
      .then((body) => setPrices((prev) => ({ ...body.prices, ...prev })))
      .catch(() => {});
  }, []);

  const recipientValid = isAddress(recipient, { strict: false });
  const toSelf = recipient.toLowerCase() === address.toLowerCase();
  const destRow = dests.find((d) => d.chainId === destination) ?? null;

  // Direct chains: can a bridge take each one to this destination and recipient?
  const directKey = rows.filter((r) => r.direct && r.balance > 0n).map((r) => r.chainId).join();
  useEffect(() => {
    if (destination === null || !recipientValid) return;
    let cancelled = false;
    const direct = rows.filter((r) => r.direct && r.canSweep && r.balance > 0n && r.chainId !== destination);
    void inPool(direct, PARALLEL_CHAINS, async (row) => {
      const probe = () => directRoute({ chainId: row.chainId, toChainId: destination, from: address, recipient })
        .catch(() => ({ available: null }));
      let result = await probe();
      // "Unknown" is often a bridge's passing hiccup: ask again before offering other chains
      for (let i = 0; i < ROUTE_RETRIES && result.available === null && !cancelled; i++) {
        await wait(ROUTE_RETRY_MS);
        result = await probe();
      }
      if (!cancelled) setDirectRoutes((prev) => ({ ...prev, [row.chainId]: result }));
      if (result.available === true) return;
      // Not confirmed to the destination: which other major chains can it go to?
      const found: number[] = [];
      for (const toChainId of ALT_CANDIDATES) {
        if (cancelled) return;
        if (toChainId === destination || toChainId === row.chainId) continue;
        const alt = await directRoute({ chainId: row.chainId, toChainId, from: address, recipient }).catch(() => null);
        if (alt?.available === true) found.push(toChainId);
      }
      if (!cancelled) setAlts((prev) => ({ ...prev, [row.chainId]: found }));
    });
    return () => { cancelled = true; };
    // Rows change identity on every refresh; which direct chains hold a balance is what matters
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, destination, recipient, recipientValid, directKey]);

  /** Alternatives are found per destination: a new one drops them and any 'elsewhere' choice */
  const resetRoutes = () => {
    setDirectRoutes({});
    setAlts({});
    setElsewhere({});
    setChoices((prev) => Object.fromEntries(Object.entries(prev).filter(([, c]) => c !== 'elsewhere')));
    setStates({});
    setBridgeOf({});
  };

  const setDestination = (chainId: number) => {
    setDestinationState(chainId);
    resetRoutes();
  };

  const setRecipient = (value: string) => {
    setRecipientState(value.trim());
    resetRoutes();
  };

  const destOf = (chainId: number) => dests.find((d) => d.chainId === chainId) ?? null;

  /** Other chains this row can go to when it cannot reach the destination (only ones the page knows) */
  const altsFor = (row: Row): DestOption[] => {
    if (destination === null) return [];
    const ids = row.direct
      ? alts[row.chainId] ?? []
      : routes[row.chainId]?.available === false ? [] : ALT_CANDIDATES.filter((id) => id !== destination && id !== row.chainId && routes[row.chainId]?.dests.has(id)
        // A bridge that pays only the sender cannot reach another recipient on any chain
        && (toSelf || !deliversOnlyToSender(row.chainId, id)));
    return ids.map(destOf).filter((d): d is DestOption => d !== null);
  };

  /** Why a row cannot go to the chosen destination, before anything is tried */
  const blockedReason = (row: Row): string | null => {
    if (choices[row.chainId] || destination === null) return null;
    if (row.chainId === destination) return toSelf ? 'Destination' : null;  // same wallet, same chain: nothing would move
    if (row.direct) {
      // Unconfirmed (null) counts as blocked only when another chain is confirmed instead
      const available = directRoutes[row.chainId]?.available;
      const minimum = directRoutes[row.chainId]?.minimumBalanceWei;
      if (available === false && minimum) return tooSmallText(BigInt(minimum), row);
      const blocked = available === false || (available === null && (alts[row.chainId]?.length ?? 0) > 0);
      return blocked ? `No bridge takes ${row.token} to ${destRow?.name ?? 'this chain'} right now` : null;
    }
    // Its bridge has no recipient: it can only pay the loaded wallet (Endurance)
    if (!toSelf && deliversOnlyToSender(row.chainId, destination)) return `${row.name} can only be swept to your own wallet`;
    const route = routes[row.chainId];
    if (!route) return null;
    if (route.available === false) return `No bridge takes ${row.token} out of ${row.name} right now`;
    if (route.dests.size > 0 && !route.dests.has(destination)) return `No bridge takes ${row.token} to ${destRow?.name ?? 'this chain'}`;
    return null;
  };

  /** No route leaves this chain for the destination: the owner chooses what happens instead */
  const needsChoice = (row: Row): boolean => {
    if (!row.canSweep || choices[row.chainId]) return false;
    const blocked = blockedReason(row);
    if (blocked && blocked !== 'Destination') return true;
    const state = states[row.chainId];
    return state?.phase === 'no-route' && (isNoRoute(state.detail ?? '') || altsFor(row).length > 0);
  };

  /** The choices a chain with no route gets: a swap out where one exists (direct chains), else donate or burn */
  const choicesFor = (row: Row): Array<Exclude<Choice, 'elsewhere'>> => {
    const exit = row.direct && directRoutes[row.chainId]?.exit ? ['exit-donate', 'exit-burn'] as const : [];
    return [...exit, 'donate', 'burn'];
  };

  const toggle = (chainId: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(chainId)) next.delete(chainId);
      else next.add(chainId);
      return next;
    });

  const setChoice = (chainId: number, choice: Choice | null, toChainId?: number) => {
    setElsewhere((prev) => {
      const next = { ...prev };
      if (choice === 'elsewhere' && toChainId !== undefined) next[chainId] = toChainId;
      else delete next[chainId];
      return next;
    });
    setChoices((prev) => {
      const next = { ...prev };
      if (choice) next[chainId] = choice;
      else delete next[chainId];
      return next;
    });
    if (choice) setSelected((prev) => new Set(prev).add(chainId));
    setState(chainId, { phase: 'idle' });
  };

  // A swept chain is finished: a new check would overwrite its result
  const selectedRows = rows.filter((r) =>
    selected.has(r.chainId) && r.canSweep && !blockedReason(r) && recipientValid && destination !== null && states[r.chainId]?.phase !== 'done'
  );
  const readyRows = selectedRows.filter((r) => states[r.chainId]?.phase === 'ready');
  // Everything selected is the destination chain itself, to this same wallet: nothing would move
  const selfOnly = onlySelfSweep(rows, selected, destination, toSelf);
  const readyTotals = totalsByDest(readyRows.map((r) => states[r.chainId]!), destination, destOf);

  /** Where a row's balance goes: the destination (also for a swap exit), or burn/donate on its own chain */
  const targetFor = (row: Row) => {
    const choice = choices[row.chainId];
    if (choice === 'burn') return { toChainId: row.chainId, recipient: BURN_ADDRESS };
    if (choice === 'donate') return { toChainId: row.chainId, recipient: ZERODUST_ADDRESS };
    if (choice === 'elsewhere') return { toChainId: elsewhere[row.chainId]!, recipient };
    return { toChainId: destination!, recipient };
  };

  const planModeFor = (row: Row): PlanMode => {
    const choice = choices[row.chainId];
    if (choice === 'burn' || choice === 'donate') return choice;
    return isExit(choice) ? 'exit' : 'route';
  };

  const directTarget = (row: Row) => ({ chainId: row.chainId, from: address, ...targetFor(row) });

  /** Real quotes, checked and replayed (direct) or signed and verified by the SDK (sponsored); nothing sent */
  const check = async () => {
    setBusy(true);
    await inPool(selectedRows, PARALLEL_CHAINS, async (row) => {
      setState(row.chainId, { phase: 'quoting' });
      const choice = choices[row.chainId];
      if (row.direct) {
        try {
          const mode = planModeFor(row);
          setState(row.chainId, { phase: 'quoting', detail: 'Replaying on a fork of the chain' });
          const plan = await planChecked(directTarget(row), mode, feePaid.current[row.chainId]);
          setBridge(row.chainId, DIRECT_BRIDGE_NAMES[plan.route]);
          setState(row.chainId, {
            phase: 'ready', choice, fee: BigInt(plan.fee),
            ...(mode === 'burn' || mode === 'donate' ? {} : { receive: BigInt(plan.receive), toChainId: targetFor(row).toChainId }),
          });
        } catch (error) {
          setState(row.chainId, { phase: 'no-route', detail: error instanceof Error ? error.message : 'No route' });
        }
        return;
      }
      const target = targetFor(row);
      if (session) {
        // A permission quote: nothing is signed until the sweep
        try {
          const quote = await permissionQuote({ fromChainId: row.chainId, toChainId: target.toChainId, user: address, destination: getAddress(target.recipient) });
          router.current = quote.permission.router;
          setBridge(row.chainId, quote.bridge?.displayName);
          setState(row.chainId, isRouted(choice) && !isExit(choice)
            ? { phase: 'ready', choice, receive: BigInt(quote.estimatedReceive), toChainId: target.toChainId, token: rowToken(row.chainId, target.toChainId) }
            : { phase: 'ready', choice });
        } catch (error) {
          setState(row.chainId, { phase: 'no-route', detail: error instanceof Error ? error.message : 'No quote' });
        }
        return;
      }
      const result = await agent!.sweep(
        { fromChainId: row.chainId, toChainId: target.toChainId, destination: getAddress(target.recipient) },
        { dryRun: true }
      );
      if (result.success && result.quote) {
        setBridge(row.chainId, quoteBridge(result.quote));
        setState(row.chainId, isRouted(choice) && !isExit(choice)
          ? { phase: 'ready', choice, receive: BigInt(result.quote.estimatedReceive), toChainId: target.toChainId, token: rowToken(row.chainId, target.toChainId) }
          : { phase: 'ready', choice });
      } else {
        setState(row.chainId, { phase: 'no-route', detail: result.error ?? 'No quote' });
      }
    });
    setBusy(false);
  };

  /**
   * A direct chain, end to end: a fresh plan, checked and replayed again,
   * signed here, sent straight to the chain's RPC. Done when the balance reads
   * exactly 0 on-chain (and the bridge reports delivery).
   */
  const sweepDirect = async (row: Row) => {
    const choice = choices[row.chainId];
    const mode = planModeFor(row);
    const { toChainId } = targetFor(row);
    let hash: string | undefined;
    let sentAny = false;
    let route: string | undefined;
    const hashes: string[] = [];
    let last: RowState | undefined;
    const update = (s: Omit<RowState, 'choice'>) => {
      last = { ...s, choice, toChainId, txHash: s.txHash ?? hash, sent: sentAny || hash !== undefined };
      setState(row.chainId, last);
    };
    const onSent = (h: string) => {
      hash = h;
      hashes.push(h);
    };
    try {
      update({ phase: 'sweeping', detail: 'Checking' });
      const plan = await planChecked(directTarget(row), mode, feePaid.current[row.chainId]);
      const fee = BigInt(plan.fee);
      const receive = mode === 'burn' || mode === 'donate' ? undefined : BigInt(plan.receive);
      setBridge(row.chainId, DIRECT_BRIDGE_NAMES[plan.route]);
      route = plan.route;
      update({ phase: 'sweeping', detail: 'Sending', fee });
      const sent = await broadcast(plan, await signPlan(account!, plan), onSent);
      if (sent.feePaidTx) {
        feePaid.current[row.chainId] = sent.feePaidTx;
        sentAny = true;
      }
      if (!sent.ok) {
        update({ phase: 'failed', detail: sent.reason ?? 'A transaction reverted or did not confirm' });
        return;
      }
      if (mode === 'exit') {
        // The swap leaves its unused gas reserve: send exactly that to ZeroDust or the burn address
        update({ phase: 'sweeping', detail: 'Swap sent; clearing the cents left', fee });
        const left = await settledBalance(row.chainId, address, false);
        if (left > BigInt(plan.leftoverMax ?? '0')) {
          update({ phase: 'failed', detail: 'The swap left more than planned; not burning or donating it. Did the swap fail?' });
          return;
        }
        if (left > 0n) {
          const rest = await planChecked({ chainId: row.chainId, toChainId: row.chainId, from: address, recipient: address }, choice === 'exit-burn' ? 'burn' : 'donate');
          const restSent = await broadcast(rest, await signPlan(account!, rest), onSent);
          if (!restSent.ok) {
            update({ phase: 'failed', detail: 'Swapped out, but clearing the cents left failed' });
            return;
          }
        }
      }
      const balance = await settledBalance(row.chainId, address, true);
      if (balance !== 0n) {
        update({ phase: 'failed', detail: 'Sent, but the chain still shows a balance' });
        return;
      }
      delete feePaid.current[row.chainId];
      if (mode === 'burn' || mode === 'donate' || plan.route === 'transfer') {
        update({ phase: 'done', receive, fee, detail: 'Balance reads 0 on-chain' });
        return;
      }
      const bridgeStarted = nowMs();
      const bridgeName = DIRECT_BRIDGE_NAMES[plan.route] ?? 'The bridge';
      update({ phase: 'sweeping', receive, fee, detail: bridgingText(bridgeName, destOf(toChainId!)?.name ?? 'the destination', 0) });
      for (let i = 0; i < 90; i++) {
        if (i > 0) update({ phase: 'sweeping', receive, fee, detail: bridgingText(bridgeName, destOf(toChainId!)?.name ?? 'the destination', secondsSince(bridgeStarted)) });
        const s = await deliveryStatus(plan, hash!, toChainId).catch(() => ({ state: 'pending' as const }));
        if (s.state === 'delivered') {
          update({ phase: 'done', receive, fee, detail: 'Balance reads 0 on-chain, delivered' });
          return;
        }
        if (s.state === 'failed') {
          update({ phase: 'failed', detail: 'The balance is 0, but the bridge reports the delivery failed or refunded' });
          return;
        }
        await wait(5000);
      }
      update({ phase: 'done', receive, fee, detail: 'Balance reads 0 on-chain; delivery still pending' });
    } catch (error) {
      update({ phase: 'failed', detail: error instanceof Error ? error.message : 'Sweep failed' });
    } finally {
      // Every direct sweep is reported, done or failed: the API never sees them otherwise
      if (last && (last.phase === 'done' || last.phase === 'failed')) {
        report(row, last, { kind: 'direct', ...(toChainId !== undefined ? { toChainId } : {}), ...(route ? { route } : {}), mode, txHashes: hashes });
      }
    }
  };

  /**
   * Every MetaMask chain at once: one permission request, one signature (metamask.ts), then
   * each chain on its own: done when its balance reads exactly 0 on-chain (the account stays
   * MetaMask's smart account: MetaMask's own delegation, not ZeroDust's, so no revoke to check).
   * A cross-chain sweep is then followed until the bridge delivers.
   */
  const sweepMetaMaskAll = async (targets: Row[]) => {
    const meta = new Map(targets.map((row) => [row.chainId, { row, choice: choices[row.chainId], target: targetFor(row) }]));
    const step = (chainId: number, detail: string) => {
      const m = meta.get(chainId)!;
      if (detail !== 'failed') setState(chainId, { phase: 'sweeping', detail, choice: m.choice });
    };
    let routerAddress = router.current;
    if (!routerAddress && targets[0]) {
      const t0 = meta.get(targets[0].chainId)!;
      routerAddress = (await permissionQuote({ fromChainId: t0.row.chainId, toChainId: t0.target.toChainId, user: address, destination: getAddress(t0.target.recipient) })).permission.router;
    }
    const results = await sweepBatchWithPermissions(
      session!,
      routerAddress!,
      targets.map((row) => {
        const m = meta.get(row.chainId)!;
        return {
          chainId: row.chainId,
          chainName: row.name,
          toChainId: m.target.toChainId,
          destination: getAddress(m.target.recipient),
          readBalance: async () => (await readState(row.chainId, address)).balance,
        };
      }),
      step
    );

    await Promise.all(targets.map(async (row) => {
      const { choice, target } = meta.get(row.chainId)!;
      const toChainId = target.toChainId;
      const token = rowToken(row.chainId, toChainId);
      const result = results.get(row.chainId) ?? { error: 'Not swept' };
      const sponsored = (st: RowState) => report(row, st, {
        kind: 'sponsored', toChainId, mode: 'permission',
        ...(result.quote?.bridge?.name ? { route: result.quote.bridge.name } : {}),
        ...(result.txHash ? { txHashes: [result.txHash] } : {}),
        ...(result.sweepId ? { sweepId: result.sweepId } : {}),
      });
      setBridge(row.chainId, result.quote?.bridge?.displayName);
      if (result.error || !result.sweepId) {
        const failed: RowState = { phase: 'failed', detail: result.error ?? 'Sweep failed', txHash: result.txHash, sent: !!result.sweepId, choice };
        setState(row.chainId, failed);
        sponsored(failed);
        return;
      }
      const receive = result.quote && (!choice || choice === 'elsewhere') ? BigInt(result.quote.estimatedReceive) : undefined;
      setState(row.chainId, { phase: 'sweeping', detail: 'Checking on-chain', txHash: result.txHash, choice });
      try {
        let balance = (await readState(row.chainId, address)).balance;
        for (let i = 0; i < 24 && balance !== 0n; i++) {
          await wait(5000);
          balance = (await readState(row.chainId, address)).balance;
        }
        if (balance !== 0n) {
          const failed: RowState = { phase: 'failed', detail: 'Sent, but the chain still shows a balance', txHash: result.txHash, sent: true, choice };
          setState(row.chainId, failed);
          sponsored(failed);
          return;
        }
        // Cross-chain: the wallet already reads 0; say so while the bridge delivers
        let status = result.status;
        const started = nowMs();
        const bridge = result.quote?.bridge?.displayName ?? 'The bridge';
        for (let i = 0; status === 'bridging' && i < 200; i++) {
          const secs = secondsSince(started);
          setState(row.chainId, { phase: 'sweeping', detail: bridgingText(bridge, m(toChainId), secs), txHash: result.txHash, choice });
          await wait(5000);
          status = (await sweepStatus(result.sweepId).catch(() => ({ status }))).status;
        }
        setState(row.chainId, {
          phase: status === 'failed' ? 'failed' : 'done',
          txHash: result.txHash, sent: true, receive, toChainId, token, choice,
          detail: status === 'failed' ? 'The balance is 0, but the bridge reports the delivery failed or refunded'
            : status === 'completed' || toChainId === row.chainId ? 'Balance reads 0 on-chain' + (toChainId !== row.chainId ? ', delivered' : '')
            : 'Balance reads 0 on-chain; delivery still pending',
        });
      } catch {
        setState(row.chainId, { phase: 'done', txHash: result.txHash, receive, toChainId, token, choice, detail: 'Completed; the on-chain check could not run' });
      }
    }));
  };

  /** The chain a row delivers to, by name */
  const m = (chainId: number) => destOf(chainId)?.name ?? 'the destination';

  const sweep = async () => {
    setBusy(true);
    setSwept(true);
    const targets = readyRows;
    for (const row of targets) setState(row.chainId, { ...states[row.chainId], phase: 'sweeping', detail: 'Queued' });
    // MetaMask: one permission request and one signature for every chain
    if (session) {
      await sweepMetaMaskAll(targets);
      setBusy(false);
      return;
    }
    await inPool(targets, PARALLEL_CHAINS, async (row) => {
      if (row.direct) return sweepDirect(row);
      const choice = choices[row.chainId];
      const target = targetFor(row);
      const toChainId = target.toChainId;
      const token = rowToken(row.chainId, toChainId);
      setState(row.chainId, { phase: 'sweeping', detail: 'Signing', choice });
      const result = await agent!.sweep(
        { fromChainId: row.chainId, toChainId: target.toChainId, destination: getAddress(target.recipient) },
        { timeoutMs: 300_000, onStatusChange: (s) => setState(row.chainId, { phase: 'sweeping', detail: s.status, choice }) }
      );
      const sponsored = (st: RowState) => report(row, st, {
        kind: 'sponsored', toChainId,
        ...(bridgeName(result.quote) ? { route: bridgeName(result.quote)! } : {}),
        ...(result.txHash ? { txHashes: [result.txHash] } : {}),
        ...(result.sweepId ? { sweepId: result.sweepId } : {}),
      });
      if (!result.success) {
        const failed: RowState = { phase: 'failed', detail: result.error ?? 'Sweep failed', txHash: result.txHash, sent: !!(result.sweepId || result.txHash), choice };
        setState(row.chainId, failed);
        sponsored(failed);
        return;
      }
      // Trust the chain, not the API: the balance must read exactly 0 and the
      // delegation must be gone. The revoke is its own transaction, sent after
      // the sweep confirms, so allow it up to two minutes.
      setBridge(row.chainId, quoteBridge(result.quote));
      setState(row.chainId, { phase: 'sweeping', detail: 'Checking on-chain', txHash: result.txHash, choice });
      const receive = result.quote && (!choice || choice === 'elsewhere') ? BigInt(result.quote.estimatedReceive) : undefined;
      try {
        let onChain = await readState(row.chainId, address);
        for (let i = 0; i < 24 && !(onChain.balance === 0n && onChain.code === '0x'); i++) {
          await wait(5000);
          onChain = await readState(row.chainId, address);
        }
        const zero = onChain.balance === 0n;
        const revoked = onChain.code === '0x';
        const final: RowState = {
          phase: zero && revoked ? 'done' : 'failed',
          txHash: result.txHash,
          sent: true,
          receive,
          toChainId,
          token,
          choice,
          detail: zero && revoked
            ? 'Balance reads 0 on-chain, delegation revoked'
            : `Sent, but the chain shows ${zero ? '' : 'a balance left'}${!zero && !revoked ? ' and ' : ''}${revoked ? '' : 'the delegation still set'}`,
        };
        setState(row.chainId, final);
        // The relayer recorded the sweep; what the chain showed afterwards it did not
        if (final.phase === 'failed') sponsored(final);
      } catch {
        setState(row.chainId, { phase: 'done', txHash: result.txHash, receive, toChainId, token, choice, detail: 'Completed; the on-chain check could not run' });
      }
    });
    setBusy(false);
    // No automatic reload: results and transaction links stay until the owner refreshes
  };

  /**
   * Read every chain again and start over from what is left: a chain swept to 0 drops off (with
   * nothing left, the page says so), and whatever holds a balance now starts selected, like on
   * load (owner, 2026-10-06: a refreshed list kept the swept chains at 0)
   */
  const reload = async () => {
    setBusy(true);
    setSwept(false);
    const next = await refresh();
    setStates({});
    setBridgeOf({});
    setChoices((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => next.some((r) => r.chainId === Number(id)))));
    setSelected(new Set(next.filter((r) => r.canSweep).map((r) => r.chainId)));
    setBusy(false);
  };

  const sweepingNow = busy && rows.some((r) => states[r.chainId]?.phase === 'sweeping');
  const stage: Stage = !loaded ? 'loading'
    : loadError ? 'error'
    : rows.length === 0 ? 'empty'
    : sweepingNow ? 'sweeping'
    : swept ? 'done'
    : readyRows.length > 0 && selectedRows.every((r) => ['ready', 'no-route'].includes(states[r.chainId]?.phase ?? '')) ? 'checked'
    : 'select';

  return {
    wallet: wallet.kind, address, rows, stage, loadError, prices, dests, sourceCount, destination, destRow, setDestination,
    recipient, setRecipient, recipientValid, toSelf, selected, toggle, states, choices, setChoice, choicesFor,
    altsFor, elsewhere, destOf, bridgeOf, blockedReason, needsChoice, selectedRows, readyRows, readyTotals, busy, check, sweep, reload, selfOnly,
  };
}

export type SweepModel = ReturnType<typeof useSweep>;

/**
 * What a row says while a bridge delivers: the wallet already reads 0, who is delivering, and for
 * how long (a Gas.zip delivery once took 4 minutes and 8 retries on its side, 2026-10-06)
 */
export function bridgingText(bridge: string, to: string, seconds: number): string {
  const waited = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `Wallet reads 0. ${bridge} is delivering to ${to} (${waited}; usually under a minute, sometimes a few)`;
}

/**
 * True when every selected chain that could be swept is the destination chain and the funds would
 * go to the same wallet: a same-chain sweep to yourself moves nothing, so the page must ask for
 * another address instead of offering a sweep (owner, 2026-10-06).
 */
export function onlySelfSweep(
  rows: Array<Pick<Row, 'chainId' | 'canSweep'>>,
  selected: Set<number>,
  destination: number | null,
  toSelf: boolean
): boolean {
  if (destination === null || !toSelf) return false;
  const chosen = rows.filter((r) => r.canSweep && selected.has(r.chainId));
  return chosen.length > 0 && chosen.every((r) => r.chainId === destination);
}

/**
 * What arrives, per chain and asset: the chosen destination's gas first, then
 * the rest ('elsewhere', delivered tokens). A token never adds into gas.
 */
export function totalsByDest(states: RowState[], destination: number | null, destOf: (chainId: number) => DestOption | null): DestTotal[] {
  const sums = new Map<string, DestTotal>();
  for (const s of states) {
    if (s.receive === undefined || s.toChainId === undefined) continue;
    const dest = destOf(s.toChainId);
    if (!dest) continue;
    const symbol = s.token?.symbol ?? dest.token;
    const key = `${dest.chainId}:${symbol}`;
    const prev = sums.get(key);
    sums.set(key, prev
      ? { ...prev, amount: prev.amount + s.receive }
      : { dest, amount: s.receive, symbol, decimals: s.token?.decimals ?? dest.decimals, isToken: !!s.token });
  }
  const rank = (t: DestTotal) => (t.dest.chainId === destination ? 0 : 2) + (t.isToken ? 1 : 0);
  return [...sums.values()].sort((a, b) => rank(a) - rank(b));
}

/** Errors that mean no bridge can take this chain to the destination (not transient ones) */
/**
 * What a chain row says when it cannot be swept: the same plain words on every
 * chain, whatever the method behind it (the raw reason stays in a tooltip)
 */
/**
 * The minimum the API names when a balance is too small to bridge
 * (AMOUNT_TOO_LOW: "... it needs at least 17.94 MITO. ..."), or null
 */
export function minimumOf(detail: string | undefined, decimals: number): bigint | null {
  const found = detail?.match(/needs at least (\d+(?:\.\d+)?) /);
  if (!found) return null;
  try {
    return parseUnits(found[1]!, decimals);
  } catch {
    return null;
  }
}

/** "Too small to bridge: needs at least 17.94 MITO, add 17.89 more" */
export function tooSmallText(minimum: bigint, row: { balance: bigint; decimals: number; token: string }): string {
  const more = minimum - row.balance;
  return `Too small to bridge: needs at least ${formatAmountUp(minimum, row.decimals)} ${row.token}${more > 0n ? `, add ${formatAmountUp(more, row.decimals)} more` : ''}`;
}

/**
 * What a failed row asks of the owner. Only a failure after something was sent
 * needs checking; before that nothing moved, and the reason says what to do.
 */
export type FailureKind = 'too-small' | 'no-route' | 'stopped' | 'try-again' | 'check';

export function failureKind(st: { detail?: string; sent?: boolean; txHash?: string }, decimals: number): FailureKind {
  if (st.sent || st.txHash) return 'check';
  const detail = st.detail ?? '';
  if (minimumOf(detail, decimals) !== null) return 'too-small';
  if (isNoRoute(detail)) return 'no-route';
  if (/refus|unsafe|safety/i.test(detail)) return 'stopped';
  return 'try-again';
}

export const FAILURE_LABEL: Record<FailureKind, string> = {
  'too-small': 'Too small',
  'no-route': 'No route',
  stopped: 'Stopped',
  'try-again': 'Try again',
  check: 'Check needed',
};

export function plainReason(detail: string, token: string, chain: string, row?: { balance: bigint; decimals: number }): string {
  const minimum = row ? minimumOf(detail, row.decimals) : null;
  if (minimum !== null && row) return tooSmallText(minimum, { ...row, token });
  if (isNoRoute(detail)) return `No bridge takes ${token} out of ${chain} right now`;
  if (/does not cover|INSUFFICIENT|too small/i.test(detail)) return 'Too small to cover its own transfer';
  if (/refus|unsafe|safety/i.test(detail)) return 'Stopped before signing: the plan failed a safety check';
  // The API's own plain words for what a MetaMask permission cannot do on this chain yet
  if (/MetaMask permission/i.test(detail)) return detail;
  return 'Could not check this chain right now. Try again in a moment.';
}

export function isNoRoute(message: string): boolean {
  return /Chain Disabled|Limit Exceeded|not supported|no routes|does not deliver|router call|Insuf+icient Liquidity|No bridge|NO_ROUTE/i.test(message);
}
