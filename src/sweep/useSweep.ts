import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getAddress, isAddress, type LocalAccount } from 'viem';
import { ZeroDust, ZeroDustAgent, type Destination } from '@zerodust/sdk';
import { RPC_URLS } from '../chains/rpcs';
import { inPool } from '../lib/pool';
import { readState } from '../lib/rpc';
import { deliveryStatus, directBalances, directChains, directRoute, BURN_ADDRESS, ZERODUST_ADDRESS, type PlanMode } from '../direct/plan';
import { broadcast, planChecked, settledBalance, signPlan } from '../direct/run';
import { API_URL } from './constants';

// Mirrors the local sweeper (local-sweeper/src/App.tsx), which is proven with
// real funds: ZeroDust's sponsored (EIP-7702) chains through the SDK, and
// direct chains (no 7702) swept by the wallet itself with exact legacy
// transactions, planned by the API and checked, replayed and sent by this page.

export { API_URL, BURN_ADDRESS, ZERODUST_ADDRESS };

/** Chains checked or swept at once; keeps well under the API's 60 quotes a minute */
const PARALLEL_CHAINS = 3;

/**
 * What to do with a chain no route takes to the destination. Direct chains
 * with a swap route can also swap out; the few cents of gas reserve the swap
 * leaves are then donated or burned, so the wallet still ends at exactly 0.
 */
export type Choice = 'exit-donate' | 'exit-burn' | 'donate' | 'burn';
export const isExit = (c?: Choice) => c === 'exit-donate' || c === 'exit-burn';

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
  choice?: Choice;
  /** Direct chains: ZeroDust's fee in the chain's token, paid as its own transfer */
  fee?: bigint;
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

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function useSweep(account: LocalAccount) {
  const address = account.address;
  const agent = useMemo(
    () => new ZeroDustAgent({ account, environment: 'mainnet', baseUrl: API_URL, rpcUrls: RPC_URLS }),
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
  const [directRoutes, setDirectRoutes] = useState<Record<number, { available: boolean | null; exit?: boolean }>>({});
  // No default destination (owner decision): the owner picks the chain
  const [destination, setDestinationState] = useState<number | null>(null);
  const [recipient, setRecipientState] = useState<string>(address);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [states, setStates] = useState<Record<number, RowState>>({});
  const [choices, setChoices] = useState<Record<number, Choice>>({});
  const [busy, setBusy] = useState(false);
  const [swept, setSwept] = useState(false);
  // Direct chains: a fee transfer that landed before its sweep failed is not charged again
  const feePaid = useRef<Record<number, string>>({});

  const setState = (chainId: number, state: RowState) => setStates((prev) => ({ ...prev, [chainId]: state }));

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
        .concat(direct.map((d): Row => ({
          chainId: d.chainId, name: d.name, token: d.token, decimals: d.decimals, explorerUrl: d.explorerUrl,
          balance: BigInt(d.balance), canSweep: BigInt(d.balance) > 0n, direct: true,
        })))
        // Only chains holding something; an empty chain has nothing to sweep
        .filter((r) => r.balance > 0n || keep.has(r.chainId))
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
  }, [address, loadDestinations]);

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
    const direct = rows.filter((r) => r.direct && r.balance > 0n && r.chainId !== destination);
    void inPool(direct, PARALLEL_CHAINS, async (row) => {
      const result = await directRoute({ chainId: row.chainId, toChainId: destination, from: address, recipient })
        .catch(() => ({ available: null }));
      if (!cancelled) setDirectRoutes((prev) => ({ ...prev, [row.chainId]: result }));
    });
    return () => { cancelled = true; };
    // Rows change identity on every refresh; which direct chains hold a balance is what matters
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, destination, recipient, recipientValid, directKey]);

  const setDestination = (chainId: number) => {
    setDestinationState(chainId);
    setDirectRoutes({});
    setStates({});
  };

  const setRecipient = (value: string) => {
    setRecipientState(value.trim());
    setDirectRoutes({});
    setStates({});
  };

  /** Why a row cannot go to the chosen destination, before anything is tried */
  const blockedReason = (row: Row): string | null => {
    if (choices[row.chainId] || destination === null) return null;
    if (row.chainId === destination) return toSelf ? 'Destination' : null;
    if (row.direct) {
      return directRoutes[row.chainId]?.available === false ? `No bridge takes ${row.token} to ${destRow?.name ?? 'this chain'} right now` : null;
    }
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
    return state?.phase === 'no-route' && isNoRoute(state.detail ?? '');
  };

  /** The choices a chain with no route gets: a swap out where one exists (direct chains), else donate or burn */
  const choicesFor = (row: Row): Choice[] => {
    const exit = row.direct && directRoutes[row.chainId]?.exit ? ['exit-donate', 'exit-burn'] as Choice[] : [];
    return [...exit, 'donate', 'burn'];
  };

  const toggle = (chainId: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(chainId)) next.delete(chainId);
      else next.add(chainId);
      return next;
    });

  const setChoice = (chainId: number, choice: Choice | null) => {
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
  const readyTotal = readyRows.reduce((sum, r) => sum + (states[r.chainId]?.receive ?? 0n), 0n);

  /** Where a row's balance goes: the destination (also for a swap exit), or burn/donate on its own chain */
  const targetFor = (row: Row) => {
    const choice = choices[row.chainId];
    if (choice === 'burn') return { toChainId: row.chainId, recipient: BURN_ADDRESS };
    if (choice === 'donate') return { toChainId: row.chainId, recipient: ZERODUST_ADDRESS };
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
          setState(row.chainId, {
            phase: 'ready', choice, fee: BigInt(plan.fee),
            ...(mode === 'burn' || mode === 'donate' ? {} : { receive: BigInt(plan.receive) }),
          });
        } catch (error) {
          setState(row.chainId, { phase: 'no-route', detail: error instanceof Error ? error.message : 'No route' });
        }
        return;
      }
      const target = targetFor(row);
      const result = await agent.sweep(
        { fromChainId: row.chainId, toChainId: target.toChainId, destination: getAddress(target.recipient) },
        { dryRun: true }
      );
      if (result.success && result.quote) {
        setState(row.chainId, choice ? { phase: 'ready', choice } : { phase: 'ready', receive: BigInt(result.quote.estimatedReceive) });
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
    let hash: string | undefined;
    const update = (s: Omit<RowState, 'choice'>) => setState(row.chainId, { ...s, choice, txHash: s.txHash ?? hash });
    try {
      update({ phase: 'sweeping', detail: 'Checking' });
      const plan = await planChecked(directTarget(row), mode, feePaid.current[row.chainId]);
      const fee = BigInt(plan.fee);
      const receive = mode === 'burn' || mode === 'donate' ? undefined : BigInt(plan.receive);
      update({ phase: 'sweeping', detail: 'Sending', fee });
      const sent = await broadcast(plan, await signPlan(account, plan), (h) => { hash = h; });
      if (sent.feePaidTx) feePaid.current[row.chainId] = sent.feePaidTx;
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
          const restSent = await broadcast(rest, await signPlan(account, rest));
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
      update({ phase: 'sweeping', receive, fee, detail: 'bridging' });
      for (let i = 0; i < 90; i++) {
        const s = await deliveryStatus(plan, hash!, destination ?? undefined).catch(() => ({ state: 'pending' as const }));
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
    }
  };

  const sweep = async () => {
    setBusy(true);
    setSwept(true);
    const targets = readyRows;
    for (const row of targets) setState(row.chainId, { ...states[row.chainId], phase: 'sweeping', detail: 'Queued' });
    await inPool(targets, PARALLEL_CHAINS, async (row) => {
      if (row.direct) return sweepDirect(row);
      const choice = choices[row.chainId];
      const target = targetFor(row);
      setState(row.chainId, { phase: 'sweeping', detail: 'Signing', choice });
      const result = await agent.sweep(
        { fromChainId: row.chainId, toChainId: target.toChainId, destination: getAddress(target.recipient) },
        { timeoutMs: 300_000, onStatusChange: (s) => setState(row.chainId, { phase: 'sweeping', detail: s.status, choice }) }
      );
      if (!result.success) {
        setState(row.chainId, { phase: 'failed', detail: result.error ?? 'Sweep failed', txHash: result.txHash, choice });
        return;
      }
      // Trust the chain, not the API: the balance must read exactly 0 and the
      // delegation must be gone. The revoke is its own transaction, sent after
      // the sweep confirms, so allow it up to two minutes.
      setState(row.chainId, { phase: 'sweeping', detail: 'Checking on-chain', txHash: result.txHash, choice });
      const receive = result.quote && !choice ? BigInt(result.quote.estimatedReceive) : undefined;
      try {
        let onChain = await readState(row.chainId, address);
        for (let i = 0; i < 24 && !(onChain.balance === 0n && onChain.code === '0x'); i++) {
          await wait(5000);
          onChain = await readState(row.chainId, address);
        }
        const zero = onChain.balance === 0n;
        const revoked = onChain.code === '0x';
        setState(row.chainId, {
          phase: zero && revoked ? 'done' : 'failed',
          txHash: result.txHash,
          receive,
          choice,
          detail: zero && revoked
            ? 'Balance reads 0 on-chain, delegation revoked'
            : `Sent, but the chain shows ${zero ? '' : 'a balance left'}${!zero && !revoked ? ' and ' : ''}${revoked ? '' : 'the delegation still set'}`,
        });
      } catch {
        setState(row.chainId, { phase: 'done', txHash: result.txHash, receive, choice, detail: 'Completed; the on-chain check could not run' });
      }
    });
    setBusy(false);
    // No automatic reload: results and transaction links stay until the owner refreshes
  };

  const reload = async () => {
    setBusy(true);
    setSwept(false);
    await refresh(new Set(Object.keys(states).map(Number)));
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
    address, rows, stage, loadError, prices, dests, sourceCount, destination, destRow, setDestination,
    recipient, setRecipient, recipientValid, toSelf, selected, toggle, states, choices, setChoice, choicesFor,
    blockedReason, needsChoice, selectedRows, readyRows, readyTotal, busy, check, sweep, reload,
  };
}

export type SweepModel = ReturnType<typeof useSweep>;

/** Errors that mean no bridge can take this chain to the destination (not transient ones) */
/**
 * What a chain row says when it cannot be swept: the same plain words on every
 * chain, whatever the method behind it (the raw reason stays in a tooltip)
 */
export function plainReason(detail: string, token: string, chain: string): string {
  if (isNoRoute(detail)) return `No bridge takes ${token} out of ${chain} right now`;
  if (/does not cover|INSUFFICIENT|too small/i.test(detail)) return 'Too small to cover its own transfer';
  if (/refus|unsafe|safety/i.test(detail)) return 'Stopped before signing: the plan failed a safety check';
  return 'Could not check this chain right now. Try again in a moment.';
}

export function isNoRoute(message: string): boolean {
  return /Chain Disabled|Limit Exceeded|not supported|no routes|does not deliver|router call|Insuf+icient Liquidity|No bridge|NO_ROUTE/i.test(message);
}
