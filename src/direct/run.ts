import type { Hex, LocalAccount } from 'viem';
import { DIRECT_RPC_URLS } from '../chains/rpcs';
import { prepareExit, preparePlan, type DirectPlan, type PlanMode, type Target } from './plan';
import { checkReplay, replay } from './replay';
import { verifyPlan } from './verify';

async function rpc<T>(chainId: number, method: string, params: unknown[]): Promise<T> {
  const url = DIRECT_RPC_URLS[chainId];
  if (!url) throw new Error(`No RPC for chain ${chainId}`);
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error || body.result === undefined) throw new Error(body.error?.message ?? `${method}: no result`);
  return body.result;
}

/** Balance and next nonce, read by the page from the chain itself */
export async function readWallet(chainId: number, address: string): Promise<{ balance: bigint; nonce: number }> {
  const [balance, nonce] = await Promise.all([
    rpc<string>(chainId, 'eth_getBalance', [address, 'latest']),
    rpc<string>(chainId, 'eth_getTransactionCount', [address, 'pending']),
  ]);
  return { balance: BigInt(balance), nonce: Number(BigInt(nonce)) };
}

/**
 * A plan the page has checked on its own: the API's transactions verified
 * against the owner's request and the chain's state, then replayed on a fork
 * of the chain. Nothing is signed or sent here.
 */
export async function planChecked(t: Target, mode: PlanMode, feePaidTx?: string): Promise<DirectPlan> {
  const plan = mode === 'exit' ? await prepareExit({ ...t, feePaidTx }) : await preparePlan({ ...t, mode, feePaidTx });
  const wallet = await readWallet(t.chainId, t.from);
  verifyPlan(plan, { ...t, mode, ...wallet });
  const result = await replay(t.chainId, t.from, plan.txs);
  checkReplay(t.chainId, plan.txs, result, mode === 'exit' ? { leftoverMax: BigInt(plan.leftoverMax!) } : null);
  return plan;
}

export function signPlan(account: LocalAccount, plan: DirectPlan): Promise<Hex[]> {
  return Promise.all(plan.txs.map((t) => account.signTransaction({
    type: 'legacy',
    chainId: plan.chainId,
    nonce: t.nonce,
    to: t.to as `0x${string}`,
    data: t.data as Hex,
    value: BigInt(t.value),
    gas: BigInt(t.gas),
    gasPrice: BigInt(t.gasPrice),
  })));
}

export interface Broadcast {
  hashes: string[];
  ok: boolean;
  /** A fee transfer that landed: passed to the next plan so a retry is not charged twice */
  feePaidTx?: string;
}

/** Sends the signed set straight to the chain's RPC, each after the previous one confirms */
export async function broadcast(plan: DirectPlan, raws: Hex[], onSent?: (hash: string, index: number) => void): Promise<Broadcast> {
  const out: Broadcast = { hashes: [], ok: true };
  for (const [i, raw] of raws.entries()) {
    const hash = await rpc<string>(plan.chainId, 'eth_sendRawTransaction', [raw]);
    out.hashes.push(hash);
    onSent?.(hash, i);
    let receipt: { status: string } | null = null;
    for (let tries = 0; tries < 90 && !receipt; tries++) {
      receipt = await rpc<{ status: string } | null>(plan.chainId, 'eth_getTransactionReceipt', [hash]).catch(() => null);
      if (!receipt) await new Promise((r) => setTimeout(r, 2000));
    }
    if (!receipt || receipt.status !== '0x1') return { ...out, ok: false };
    if (plan.txs[i]!.kind === 'fee') out.feePaidTx = hash;
  }
  return out;
}

/** The balance after a sweep, read until it is 0 (a node can lag its own receipt) or tries run out */
export async function settledBalance(chainId: number, address: string, expectZero: boolean): Promise<bigint> {
  let balance = (await readWallet(chainId, address)).balance;
  for (let i = 0; i < 10 && expectZero && balance !== 0n; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    balance = (await readWallet(chainId, address)).balance;
  }
  return balance;
}
