import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getAddress, isAddress, type Address } from 'viem';
import { ZeroDust, ZeroDustAgent, closingDelegateFor, deliversOnlyToSender, type Destination } from '@zerodust/sdk';
import { DIRECT_RPC_URLS, RPC_URLS } from '../chains/rpcs';
import { inPool } from '../lib/pool';
import { readState } from '../lib/rpc';
import { directBalances, directChains, directRoute, relayBusy, tokenExitFor, BURN_ADDRESS, TOKEN_EXITS, ZERODUST_ADDRESS, type PlanMode } from '../direct/plan';
import { planChecked } from '../direct/run';

import { API_URL } from './constants';
import { sendReport, type SweepReport } from './report';
import { permissionQuote, sweepStatus } from './metamask';
import { expectedTime, fetchTimings, NO_TIMINGS, type BridgeTimings } from './timing';
import { addPendingClaim, nativeExitOf, parentOf, waitText } from './native';
import { type Choice, type DestOption, NEEDS_KEY, type Row, type RowState, type Stage, type Wallet, isExit, isRouted, rowToken } from './sweep-types';
import { endedWhereSigned, failureKind, isNoRoute, onlySelfSweep, tooSmallText, totalsByDest } from './outcome';
import { DIRECT_BRIDGE_NAMES, nowMs, sweepDirectRow, sweepMetaMaskRows, wait } from './sweep-run';

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
 * Chains offered instead when a source cannot reach the chosen destination
 * ('elsewhere'): the balance goes to the same address on one of these.
 */
const ALT_CANDIDATES = [8453, 10, 42161, 1, 56, 137];


/** The quote's bridge id (gaszip, relay, across, stargate, hyperlane, endurance, layerzero), for reports */
function bridgeName(quote: unknown): string | undefined {
  return (quote as { bridge?: { name?: string } } | undefined)?.bridge?.name;
}

/** The bridge that carries a sponsored quote, as the API names it (none for a same-chain transfer) */
function quoteBridge(quote: unknown): string | undefined {
  return (quote as { bridge?: { displayName?: string } } | undefined)?.bridge?.displayName;
}

interface ChainInfo {
  name: string;
  nativeToken: string;
  nativeTokenDecimals: number;
  explorerUrl: string;
  crossChain?: { available: boolean | null };
}

const client = new ZeroDust({ environment: 'mainnet', baseUrl: API_URL });




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
  // How long each bridge usually takes (GET /bridges/timing); a ref too, for the delivery loops
  const [timings, setTimings] = useState<BridgeTimings>(NO_TIMINGS);
  const timingsRef = useRef<BridgeTimings>(NO_TIMINGS);
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
  // 'address' choices: another address on the chain itself, e.g. an exchange deposit (owner,
  // 2026-10-06: for chains no bridge serves, and anyone who wants one chain somewhere else)
  const [addressOf, setAddressOf] = useState<Record<number, string>>({});
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
    fetchTimings()
      .then((t) => { timingsRef.current = t; setTimings(t); })
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
      // Relay over its limit: other destinations would ask it again, so the route stays unknown
      if (result.available === true || relayBusy(result)) return;
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
      // Its own bridge is the way out, as a token: not a passing outage
      const tokenExit = tokenExitFor(row.chainId, destination);
      if (blocked && tokenExit) return `No gas bridge takes ${row.token} to ${destRow?.name ?? 'this chain'}; ${tokenExit.bridge} sends it as the ${tokenExit.token.symbol} token`;
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
  const choicesFor = (row: Row): Array<Exclude<Choice, 'elsewhere' | 'address'>> => {
    // A token exit (the chain's own bridge): one option, its leftover counts toward ZeroDust's fee
    const tokenExit = destination !== null && tokenExitFor(row.chainId, destination);
    const exit = row.direct && directRoutes[row.chainId]?.exit ? (tokenExit ? ['exit-donate'] as const : ['exit-donate', 'exit-burn'] as const) : [];
    return [...exit, 'donate', 'burn'];
  };

  /** The chains to sweep, set as a whole (the address page sends one group's selection) */
  const select = (ids: Set<number>) => setSelected(new Set(ids));

  const toggle = (chainId: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(chainId)) next.delete(chainId);
      else next.add(chainId);
      return next;
    });

  const setChoice = (chainId: number, choice: Choice | null, toChainId?: number, address?: string) => {
    setAddressOf((prev) => {
      const next = { ...prev };
      if (choice === 'address' && address) next[chainId] = getAddress(address);
      else delete next[chainId];
      return next;
    });
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
  const selfOnly = onlySelfSweep(rows, new Set([...selected].filter((id) => choices[id] !== 'address')), destination, toSelf);
  // What the user receives: not what goes to another address
  const readyTotals = totalsByDest(readyRows.filter((r) => choices[r.chainId] !== 'address').map((r) => states[r.chainId]!), destination, destOf);

  /** The usual delivery time of the bridge carrying this row, once it is known */
  const expectedFor = (row: Row) => expectedTime(timings, bridgeOf[row.chainId], row.chainId);

  /** Where a row's balance goes: the destination (also for a swap exit), or burn/donate on its own chain */
  const targetFor = (row: Row) => {
    const choice = choices[row.chainId];
    if (choice === 'burn') return { toChainId: row.chainId, recipient: BURN_ADDRESS };
    if (choice === 'donate') return { toChainId: row.chainId, recipient: ZERODUST_ADDRESS };
    if (choice === 'elsewhere') return { toChainId: elsewhere[row.chainId]!, recipient };
    if (choice === 'address') return { toChainId: row.chainId, recipient: addressOf[row.chainId]! };
    if (choice === 'native') return { toChainId: nativeExitOf(row.chainId)!.toChainId, recipient };
    // A chain's own token bridge delivers on one fixed chain, whatever the destination (Telos: TLOS on Base)
    if (isExit(choice) && TOKEN_EXITS[row.chainId]) return { toChainId: TOKEN_EXITS[row.chainId]!.toChainId, recipient };
    return { toChainId: destination!, recipient };
  };

  const planModeFor = (row: Row): PlanMode => {
    const choice = choices[row.chainId];
    if (choice === 'burn' || choice === 'donate') return choice;
    return isExit(choice) ? 'exit' : 'route';
  };

  const directTarget = (row: Row) => ({ chainId: row.chainId, from: address, ...targetFor(row) });
  /** The chain's own bridge, when that is the row's way out */
  const bridgeFor = (row: Row): 'native' | undefined => (choices[row.chainId] === 'native' ? 'native' : undefined);
  /** What arrives: a token route's token, or the token a chain's own bridge delivers (Gravity: G) */
  const tokenFor = (row: Row, toChainId: number): RowState['token'] => {
    const exit = choices[row.chainId] === 'native' ? nativeExitOf(row.chainId) : undefined;
    return exit?.token ? { symbol: exit.token.symbol, decimals: exit.token.decimals } : rowToken(row.chainId, toChainId);
  };
  /** Saves a withdrawal through a chain's own bridge, to be claimed on its parent chain later (this browser only) */
  const notePending = (row: Row, txHash: string | undefined, amount: bigint | undefined) => {
    if (!txHash || amount === undefined) return;
    const exit = nativeExitOf(row.chainId);
    addPendingClaim({
      chainId: row.chainId, chainName: row.name, explorerUrl: row.explorerUrl,
      symbol: exit?.token?.symbol ?? row.token, decimals: exit?.token?.decimals ?? row.decimals,
      from: address, recipient: getAddress(targetFor(row).recipient), amount: amount.toString(), txHash, sentAt: nowMs(),
    });
  };
  const nativeDoneText = (row: Row) => {
    const exit = nativeExitOf(row.chainId)!;
    return exit.relayed
      ? `Balance reads 0 on-chain. Sent into ${row.name}'s own bridge: its relayer delivers it on ${parentOf(exit).name} in ${waitText(exit)}`
      : `Balance reads 0 on-chain. Withdrawn into ${row.name}'s own bridge: claim it on ${parentOf(exit).name} in ${waitText(exit)} (see "Waiting to be claimed")`;
  };

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
          const plan = await planChecked(directTarget(row), mode, feePaid.current[row.chainId], bridgeFor(row));
          setBridge(row.chainId, plan.route === 'native' ? `${row.name}'s own bridge` : DIRECT_BRIDGE_NAMES[plan.route]);
          setState(row.chainId, {
            phase: 'ready', choice, fee: BigInt(plan.fee), ...(plan.bridgeFee ? { bridgeFee: BigInt(plan.bridgeFee) } : {}),
            ...(mode === 'burn' || mode === 'donate' ? {} : { receive: BigInt(plan.receive), toChainId: targetFor(row).toChainId, token: tokenFor(row, targetFor(row).toChainId) }),
          });
        } catch (error) {
          setState(row.chainId, { phase: 'no-route', detail: error instanceof Error ? error.message : 'No route' });
        }
        return;
      }
      const target = targetFor(row);
      if (session) {
        if (choice === 'native') {
          setState(row.chainId, { phase: 'no-route', detail: 'A chain\'s own bridge needs the key: MetaMask cannot sign it here' });
          return;
        }
        // A permission quote: nothing is signed until the sweep
        try {
          const quote = await permissionQuote({ fromChainId: row.chainId, toChainId: target.toChainId, user: address, destination: getAddress(target.recipient) });
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
        { fromChainId: row.chainId, toChainId: target.toChainId, destination: getAddress(target.recipient), ...(bridgeFor(row) ? { bridge: bridgeFor(row) } : {}) },
        { dryRun: true }
      );
      if (result.success && result.quote && bridgeFor(row) && bridgeName(result.quote) !== 'native') {
        setState(row.chainId, { phase: 'no-route', detail: 'Refused: the quote does not use the chain\'s own bridge, which this group needs' });
      } else if (result.success && result.quote) {
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

  /** The chain a row delivers to, by name */
  const m = (chainId: number) => destOf(chainId)?.name ?? 'the destination';

  /** A direct chain, end to end (sweep-run.ts) */
  const sweepDirect = (row: Row) => sweepDirectRow(row, {
    address, account: account!, choice: choices[row.chainId], mode: planModeFor(row), toChainId: targetFor(row).toChainId,
    target: directTarget(row), bridge: bridgeFor(row), feePaid, timings: () => timingsRef.current, destName: m,
    setState, setBridge, notePending, nativeDoneText, report,
  });

  /** Every MetaMask chain at once (sweep-run.ts) */
  const sweepMetaMaskAll = (targets: Row[]) => sweepMetaMaskRows(targets, {
    address, session: session!, choiceOf: (row) => choices[row.chainId], targetOf: targetFor, timings: () => timingsRef.current,
    destName: m, setState, setBridge, report,
  });


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
      const token = tokenFor(row, toChainId);
      setState(row.chainId, { phase: 'sweeping', detail: 'Signing', choice });
      // Where the sweep must leave the wallet: no delegation, or back on MetaMask's smart-account
      // delegate when it is one (the SDK signs the same rule; a failed read only loosens the check
      // to "ZeroDust's delegation is gone")
      const closing = await readState(row.chainId, address).then((st) => closingDelegateFor(st.code)).catch(() => null);
      const result = await agent!.sweep(
        { fromChainId: row.chainId, toChainId: target.toChainId, destination: getAddress(target.recipient), ...(bridgeFor(row) ? { bridge: bridgeFor(row) } : {}) },
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
      const receive = result.quote && (!choice || choice === 'elsewhere' || choice === 'native') ? BigInt(result.quote.estimatedReceive) : undefined;
      try {
        const ended = (code: string) => endedWhereSigned(code, closing);
        let onChain = await readState(row.chainId, address);
        for (let i = 0; i < 24 && !(onChain.balance === 0n && ended(onChain.code)); i++) {
          await wait(5000);
          onChain = await readState(row.chainId, address);
        }
        const zero = onChain.balance === 0n;
        const revoked = ended(onChain.code);
        if (zero && choice === 'native') notePending(row, result.txHash, receive);
        const final: RowState = {
          phase: zero && revoked ? 'done' : 'failed',
          txHash: result.txHash,
          sent: true,
          receive,
          toChainId,
          token,
          choice,
          detail: zero && revoked
            ? choice === 'native' ? nativeDoneText(row) : 'Balance reads 0 on-chain'
            : [zero ? '' : 'Sent, but the chain shows a balance left', revoked ? '' : 'ZeroDust\'s access to this wallet was not removed yet; it is retried automatically'].filter(Boolean).join('. '),
        };
        setState(row.chainId, final);
        // The relayer recorded the sweep; what the chain showed afterwards it did not
        if (final.phase === 'failed') sponsored(final);
        // Cross-chain: the bridge's delivery transaction, for the arrival link (owner note 7)
        if (final.phase === 'done' && toChainId !== row.chainId && result.sweepId) {
          const delivered = await sweepStatus(result.sweepId).catch(() => null);
          if (delivered?.destinationTxHash) setStates((prev) => ({ ...prev, [row.chainId]: { ...prev[row.chainId]!, arrivalTx: delivered.destinationTxHash } }));
        }
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
    recipient, setRecipient, recipientValid, toSelf, selected, toggle, select, states, choices, setChoice, choicesFor,
    altsFor, elsewhere, addressOf, destOf, bridgeOf, expectedFor, blockedReason, needsChoice, selectedRows, readyRows, readyTotals, busy, check, sweep, reload, selfOnly,
  };
}

export type SweepModel = ReturnType<typeof useSweep>;
