import { useCallback, useEffect, useMemo, useState } from 'react';
import { getAddress, isAddress, type LocalAccount } from 'viem';
import { ZeroDust, ZeroDustAgent, type Destination } from '@zerodust/sdk';
import { RPC_URLS } from '../chains/rpcs';
import { inPool } from '../lib/pool';
import { readState } from '../lib/rpc';

// Mirrors the local sweeper (local-sweeper/src/App.tsx), which is proven with
// real funds, for ZeroDust's sponsored (EIP-7702) chains.

export const API_URL = 'https://api.zerodust.xyz';

/** Where a balance goes when the owner picks burn: nobody holds this key */
export const BURN_ADDRESS = '0x000000000000000000000000000000000000dEaD';
/** ZeroDust's address (the sponsor, same on every chain): donations go here */
export const ZERODUST_ADDRESS = '0x01eD5c94DE39E73C986b98B85C2c0A3d1BEDff7D';

/** Chains checked or swept at once; keeps well under the API's 60 quotes a minute */
const PARALLEL_CHAINS = 3;

/** What to do with a chain no route takes to the destination */
export type Choice = 'donate' | 'burn';

export interface Row {
  chainId: number;
  name: string;
  token: string;
  decimals: number;
  balance: bigint;
  canSweep: boolean;
  explorerUrl: string;
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
  // Per source chain: does any bridge accept it now (route status, re-probed
  // every 10 min by the API), and which chains its bridges deliver to
  const [routes, setRoutes] = useState<Record<number, { available: boolean | null; dests: Set<number> }>>({});
  // No default destination (owner decision): the owner picks the chain
  const [destination, setDestinationState] = useState<number | null>(null);
  const [recipient, setRecipientState] = useState<string>(address);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [states, setStates] = useState<Record<number, RowState>>({});
  const [choices, setChoices] = useState<Record<number, Choice>>({});
  const [busy, setBusy] = useState(false);
  const [swept, setSwept] = useState(false);

  const setState = (chainId: number, state: RowState) => setStates((prev) => ({ ...prev, [chainId]: state }));

  const loadDestinations = useCallback(async (loadedRows: Row[], chainInfo: Map<number, ChainInfo>) => {
    const sources = loadedRows.filter((r) => r.canSweep);
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
      const [chains, balances] = await Promise.all([client.getChains(), client.getBalances(address)]);
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
      setSelected(new Set(loadedRows.filter((r) => r.canSweep).map((r) => r.chainId)));
    });
  }, [refresh]);

  // USD prices, only to show what a sweep is worth; nothing depends on them
  useEffect(() => {
    fetch(`${API_URL}/prices`)
      .then((r) => r.json())
      .then((body: { prices?: Record<string, number> }) => setPrices(body.prices ?? {}))
      .catch(() => {});
  }, []);

  const recipientValid = isAddress(recipient, { strict: false });
  const toSelf = recipient.toLowerCase() === address.toLowerCase();
  const destRow = dests.find((d) => d.chainId === destination) ?? null;

  const setDestination = (chainId: number) => {
    setDestinationState(chainId);
    setStates({});
  };

  const setRecipient = (value: string) => {
    setRecipientState(value.trim());
    setStates({});
  };

  /** Why a row cannot go to the chosen destination, before anything is tried */
  const blockedReason = (row: Row): string | null => {
    if (choices[row.chainId] || destination === null) return null;
    if (row.chainId === destination) return toSelf ? 'Destination' : null;
    const route = routes[row.chainId];
    if (!route) return null;
    if (route.available === false) return `No bridge takes ${row.token} out of ${row.name} right now`;
    if (route.dests.size > 0 && !route.dests.has(destination)) return `No bridge takes ${row.token} to ${destRow?.name ?? 'this chain'}`;
    return null;
  };

  /** No route leaves this chain for the destination: the owner chooses burn or donate */
  const needsChoice = (row: Row): boolean => {
    if (!row.canSweep || choices[row.chainId]) return false;
    const blocked = blockedReason(row);
    if (blocked && blocked !== 'Destination') return true;
    const state = states[row.chainId];
    return state?.phase === 'no-route' && isNoRoute(state.detail ?? '');
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

  /** Where a row's balance goes: the destination, or burn/donate on its own chain */
  const targetFor = (row: Row) => {
    const choice = choices[row.chainId];
    if (choice === 'burn') return { toChainId: row.chainId, recipient: BURN_ADDRESS };
    if (choice === 'donate') return { toChainId: row.chainId, recipient: ZERODUST_ADDRESS };
    return { toChainId: destination!, recipient };
  };

  /** Real quotes, everything signed and verified by the SDK, nothing sent */
  const check = async () => {
    setBusy(true);
    await inPool(selectedRows, PARALLEL_CHAINS, async (row) => {
      setState(row.chainId, { phase: 'quoting' });
      const choice = choices[row.chainId];
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

  const sweep = async () => {
    setBusy(true);
    setSwept(true);
    const targets = readyRows;
    for (const row of targets) setState(row.chainId, { ...states[row.chainId], phase: 'sweeping', detail: 'Queued' });
    await inPool(targets, PARALLEL_CHAINS, async (row) => {
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
          await new Promise((r) => setTimeout(r, 5000));
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
    recipient, setRecipient, recipientValid, toSelf, selected, toggle, states, choices, setChoice,
    blockedReason, needsChoice, selectedRows, readyRows, readyTotal, busy, check, sweep, reload,
  };
}

export type SweepModel = ReturnType<typeof useSweep>;

/** Errors that mean no bridge can take this chain to the destination (not transient ones) */
export function isNoRoute(message: string): boolean {
  return /Chain Disabled|Limit Exceeded|not supported|no routes|does not deliver|router call|Insuf+icient Liquidity/i.test(message);
}
