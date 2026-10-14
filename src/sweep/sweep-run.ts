/**
 * @fileoverview The page's two sweep executors, apart from the hook's state (useSweep.ts passes
 * what each needs): a direct chain end to end (plan, check, sign, send, exact 0, delivery), and
 * every MetaMask chain at once (one permission, one signature, then each chain followed)
 */

import { getAddress, type Address, type LocalAccount } from 'viem';
import { readState } from '../lib/rpc';
import { deliveryStatus, type DirectPlan, type PlanMode } from '../direct/plan';
import { broadcast, GUARD_ATTEMPTS, planChecked, settledBalance, signPlan, waitForNonce } from '../direct/run';
import { sweepBatchWithPermissions, sweepStatus, type MetaMaskSession } from './metamask';
import { bridgingText } from './outcome';
import type { SweepReport } from './report';
import { type Choice, type Row, type RowState, rowToken } from './sweep-types';
import { expectedTime, type BridgeTimings } from './timing';

/** Guard chains: the wait before planning again after the guard refused a sweep */
const GUARD_RETRY_WAIT_MS = 1500;

/**
 * A retry's plan: the API may read the balance from a node that has not seen the refused sweep
 * yet, which the page's check refuses as a changed balance; that is asked again a few times.
 */
async function planGuardRetry(attempt: number, plan: () => Promise<DirectPlan>): Promise<DirectPlan> {
  for (let tries = 1; ; tries++) {
    try {
      return await plan();
    } catch (error) {
      if (attempt === 1 || tries >= 4 || !/balance changed|nonce is stale/.test(String((error as Error).message))) throw error;
      await new Promise((r) => setTimeout(r, GUARD_RETRY_WAIT_MS));
    }
  }
}

/** Display names of the bridges a direct plan can use (the API's own adapters name the sponsored ones) */
export const DIRECT_BRIDGE_NAMES: Record<string, string> = { gaszip: 'Gas.zip', relay: 'Relay', across: 'Across', lifi: 'LI.FI', oft: 'LayerZero', meson: 'Meson' };

export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Seconds since `start` (ms); module-level so the hook body stays pure */
export const secondsSince = (start: number) => Math.round((Date.now() - start) / 1000);
export const nowMs = () => Date.now();

type Report = (row: Row, st: RowState, r: Omit<SweepReport, 'outcome' | 'failureKind' | 'address' | 'chainId' | 'detail'>) => void;

/** What a direct row's sweep needs from the hook */
export interface DirectRowContext {
  address: Address;
  account: LocalAccount;
  choice: Choice | undefined;
  mode: PlanMode;
  toChainId: number;
  /** The plan's target (chain, from, destination chain, recipient) */
  target: Parameters<typeof planChecked>[0];
  /** The chain's own bridge, when that is the row's way out */
  bridge: 'native' | undefined;
  /** Fee transfers already sent per chain, so a retry is not charged twice */
  feePaid: { current: Record<number, string> };
  timings: () => BridgeTimings;
  destName: (chainId: number) => string;
  setState: (chainId: number, state: RowState) => void;
  setBridge: (chainId: number, name: string | undefined) => void;
  notePending: (row: Row, txHash: string | undefined, amount: bigint | undefined) => void;
  nativeDoneText: (row: Row) => string;
  report: Report;
}

/**
 * A direct chain, end to end: a fresh plan, checked and replayed again,
 * signed here, sent straight to the chain's RPC. Done when the balance reads
 * exactly 0 on-chain (and the bridge reports delivery).
 */
export async function sweepDirectRow(row: Row, ctx: DirectRowContext): Promise<void> {
  const { address, account, choice, mode, toChainId, feePaid, setState, setBridge, notePending, nativeDoneText, report } = ctx;
  let hash: string | undefined;
  let sentAny = false;
  let route: string | undefined;
  const hashes: string[] = [];
  let last: RowState | undefined;
  const update = (s: Omit<RowState, 'choice'>) => {
    last = { ...s, choice, toChainId, token: rowToken(row.chainId, toChainId), txHash: s.txHash ?? hash, sent: sentAny || hash !== undefined };
    setState(row.chainId, last);
  };
  const onSent = (h: string) => {
    hash = h;
    hashes.push(h);
  };
  try {
    update({ phase: 'sweeping', detail: 'Checking' });
    let plan: DirectPlan;
    let sent: Awaited<ReturnType<typeof broadcast>>;
    // Guard chains: a sweep the guard refused because the L1 fee moved is planned and sent again
    for (let attempt = 1; ; attempt++) {
      plan = await planGuardRetry(attempt, () => planChecked(ctx.target, mode, feePaid.current[row.chainId], ctx.bridge));
      setBridge(row.chainId, DIRECT_BRIDGE_NAMES[plan.route]);
      route = plan.route;
      update({ phase: 'sweeping', detail: attempt === 1 ? 'Sending' : `The L1 fee moved before it landed; sending again (try ${attempt} of ${GUARD_ATTEMPTS})`, fee: BigInt(plan.fee) });
      sent = await broadcast(plan, await signPlan(account, plan), onSent);
      if (sent.ok || !sent.guardRefused || attempt >= GUARD_ATTEMPTS) break;
      // Plan again only once the chain's reads include the refused transaction
      if (sent.hashes.length === 0) await new Promise((r) => setTimeout(r, GUARD_RETRY_WAIT_MS));
      else if (!(await waitForNonce(row.chainId, address, plan.txs[0]!.nonce + 1))) break;
    }
    const fee = BigInt(plan.fee);
    const receive = mode === 'burn' || mode === 'donate' ? undefined : BigInt(plan.receive);
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
        const restSent = await broadcast(rest, await signPlan(account, rest), onSent);
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
    if (plan.route === 'native') {
      // Nothing to follow: the withdrawal exists now and is claimed on its parent chain later
      notePending(row, hash, receive);
      update({ phase: 'done', receive, fee, detail: nativeDoneText(row) });
      return;
    }
    if (mode === 'burn' || mode === 'donate' || plan.route === 'transfer') {
      update({ phase: 'done', receive, fee, detail: 'Balance reads 0 on-chain' });
      return;
    }
    const bridgeStarted = nowMs();
    const bridgeName = DIRECT_BRIDGE_NAMES[plan.route] ?? 'The bridge';
    const expected = expectedTime(ctx.timings(), bridgeName, row.chainId);
    update({ phase: 'sweeping', receive, fee, detail: bridgingText(bridgeName, ctx.destName(toChainId), 0, expected) });
    for (let i = 0; i < 90; i++) {
      if (i > 0) update({ phase: 'sweeping', receive, fee, detail: bridgingText(bridgeName, ctx.destName(toChainId), secondsSince(bridgeStarted), expected) });
      const s = await deliveryStatus(plan, hash!, toChainId).catch(() => ({ state: 'pending' as const }));
      if (s.state === 'delivered') {
        update({ phase: 'done', receive, fee, detail: 'Balance reads 0 on-chain, delivered', arrivalTx: (s as { destTx?: string }).destTx });
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
}

/** What the MetaMask sweep needs from the hook */
export interface MetaMaskRowsContext {
  address: Address;
  session: MetaMaskSession;
  choiceOf: (row: Row) => Choice | undefined;
  targetOf: (row: Row) => { toChainId: number; recipient: string };
  timings: () => BridgeTimings;
  destName: (chainId: number) => string;
  setState: (chainId: number, state: RowState) => void;
  setBridge: (chainId: number, name: string | undefined) => void;
  report: Report;
}

/**
 * Every MetaMask chain at once: one permission request, one signature (metamask.ts), then
 * each chain on its own: done when its balance reads exactly 0 on-chain (the account stays
 * MetaMask's smart account: MetaMask's own delegation, not ZeroDust's, so no revoke to check).
 * A cross-chain sweep is then followed until the bridge delivers.
 */
export async function sweepMetaMaskRows(targets: Row[], ctx: MetaMaskRowsContext): Promise<void> {
  const { address, session, setState, setBridge, report } = ctx;
  const meta = new Map(targets.map((row) => [row.chainId, { row, choice: ctx.choiceOf(row), target: ctx.targetOf(row) }]));
  const step = (chainId: number, detail: string) => {
    const m = meta.get(chainId)!;
    if (detail !== 'failed') setState(chainId, { phase: 'sweeping', detail, choice: m.choice });
  };
  const results = await sweepBatchWithPermissions(
    session,
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
      let arrivalTx: string | undefined;
      const started = nowMs();
      const bridge = result.quote?.bridge?.displayName ?? 'The bridge';
      const expected = expectedTime(ctx.timings(), bridge, row.chainId);
      for (let i = 0; status === 'bridging' && i < 200; i++) {
        const secs = secondsSince(started);
        setState(row.chainId, { phase: 'sweeping', detail: bridgingText(bridge, ctx.destName(toChainId), secs, expected), txHash: result.txHash, choice });
        await wait(5000);
        const s = await sweepStatus(result.sweepId).catch(() => ({ status, destinationTxHash: undefined }));
        status = s.status;
        arrivalTx = s.destinationTxHash || arrivalTx;
      }
      if (!arrivalTx && toChainId !== row.chainId) arrivalTx = (await sweepStatus(result.sweepId).catch(() => null))?.destinationTxHash || undefined;
      setState(row.chainId, {
        phase: status === 'failed' ? 'failed' : 'done',
        txHash: result.txHash, sent: true, receive, toChainId, token, choice, arrivalTx,
        detail: status === 'failed' ? 'The balance is 0, but the bridge reports the delivery failed or refunded'
          : status === 'completed' || toChainId === row.chainId ? 'Balance reads 0 on-chain' + (toChainId !== row.chainId ? ', delivered' : '')
          : 'Balance reads 0 on-chain; delivery still pending',
      });
    } catch {
      setState(row.chainId, { phase: 'done', txHash: result.txHash, receive, toChainId, token, choice, detail: 'Completed; the on-chain check could not run' });
    }
  }));
}
