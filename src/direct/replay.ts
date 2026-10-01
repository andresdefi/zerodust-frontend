import { createBlock } from '@ethereumjs/block';
import { createCustomCommon, Hardfork, Mainnet } from '@ethereumjs/common';
import { RPCStateManager } from '@ethereumjs/statemanager';
import { createLegacyTx } from '@ethereumjs/tx';
import { createAccount, createAddressFromString, hexToBytes, KECCAK256_NULL, KECCAK256_RLP, type Address } from '@ethereumjs/util';
import { createVM, runTx } from '@ethereumjs/vm';
import { keccak256 } from 'viem';
import { DIRECT_RPC_URLS } from '../chains/rpcs';
import type { PlanTx } from './plan';

// The local sweeper replays every signed set on an anvil fork before sending.
// A browser cannot run anvil and the public RPCs cannot simulate, so the page
// runs the set in an EVM of its own (ethereumjs), forked from the chain's
// public RPC at the latest block. Spike: workspace
// docs/data/browser-replay-spike-2026-10-01.md (Relay deposits replay to the
// real sweeps' exact gas; a LI.FI swap replays without revert).

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error || body.result === undefined) throw new Error(`${method}: ${body.error?.message ?? 'no result'}`);
  return body.result;
}

/** Forked state from basic reads (many public RPCs refuse eth_getProof) */
class PublicRpcState extends RPCStateManager {
  constructor(private readonly url: string, blockTag: bigint) {
    super({ provider: url, blockTag });
  }

  override async getAccountFromProvider(address: Address) {
    const a = address.toString();
    const tag = `0x${this._blockTag === 'earliest' ? '0' : BigInt(this._blockTag).toString(16)}`;
    const [balance, nonce, code] = await Promise.all([
      rpc<string>(this.url, 'eth_getBalance', [a, tag]),
      rpc<string>(this.url, 'eth_getTransactionCount', [a, tag]),
      rpc<`0x${string}`>(this.url, 'eth_getCode', [a, tag]),
    ]);
    return createAccount({
      balance: BigInt(balance),
      nonce: BigInt(nonce),
      codeHash: code === '0x' ? KECCAK256_NULL : hexToBytes(keccak256(code)),
      storageRoot: KECCAK256_RLP,
    });
  }
}

/** EIP-7623 (Prague) calldata floor: a chain that accepted less gas than this is pre-Prague */
export function pragueFloorGas(data: string): bigint {
  const bytes = hexToBytes(data as `0x${string}`);
  const zeros = bytes.filter((b) => b === 0).length;
  return 21_000n + 10n * BigInt(zeros + 4 * (bytes.length - zeros));
}

export function hardforkFor(txs: Pick<PlanTx, 'gas' | 'data'>[]): Hardfork {
  return txs.some((t) => BigInt(t.gas) < pragueFloorGas(t.data)) ? Hardfork.Cancun : Hardfork.Prague;
}

export interface ReplayResult {
  results: Array<{ ok: boolean; gasUsed: bigint; error?: string }>;
  /** The wallet's balance after the set */
  after: bigint;
}

/** Runs the set, in order, as the wallet (no signature needed in the fork) */
export async function replay(chainId: number, from: string, txs: PlanTx[]): Promise<ReplayResult> {
  const url = DIRECT_RPC_URLS[chainId];
  if (!url) throw new Error(`No RPC for chain ${chainId}`);
  const head = await rpc<{ number: string; timestamp: string; gasLimit: string }>(url, 'eth_getBlockByNumber', ['latest', false]);
  const common = createCustomCommon({ chainId }, Mainnet, { hardfork: hardforkFor(txs) });
  const vm = await createVM({ common, stateManager: new PublicRpcState(url, BigInt(head.number)) });
  // Base fee 0: the legacy price pays the whole fee, and the planner already
  // applied each chain's price rule (Arbitrum stack: base fee at its floor)
  const block = createBlock({
    header: { number: BigInt(head.number) + 1n, timestamp: BigInt(head.timestamp) + 2n, gasLimit: BigInt(head.gasLimit), baseFeePerGas: 0n },
  }, { common });
  const sender = createAddressFromString(from);
  const results: ReplayResult['results'] = [];
  for (const t of txs) {
    const tx = createLegacyTx({ nonce: BigInt(t.nonce), gasPrice: BigInt(t.gasPrice), gasLimit: BigInt(t.gas), to: t.to as `0x${string}`, value: BigInt(t.value), data: t.data as `0x${string}` }, { common });
    const asWallet = Object.assign(Object.create(tx) as typeof tx, { getSenderAddress: () => sender, isSigned: () => true });
    const r = await runTx(vm, { tx: asWallet, block, skipHardForkValidation: true });
    results.push({ ok: !r.execResult.exceptionError, gasUsed: r.totalGasSpent, error: r.execResult.exceptionError?.error });
  }
  const after = (await vm.stateManager.getAccount(sender))?.balance ?? 0n;
  return { results, after };
}

/** Etherlink charges its inclusion fee as gas, which an EVM does not: 0.000004 XTZ x (150 + calldata bytes) */
export function etherlinkInclusionGas(data: string, gasPrice: bigint): bigint {
  const bytes = BigInt((data.length - 2) / 2);
  return (4_000_000_000_000n * (150n + bytes)) / gasPrice;
}

export const ETHERLINK = 42793;

/**
 * What a replay must show before the set is signed. Exact sets: every
 * transaction uses exactly its gas and the wallet ends at 0. Swap exits:
 * nothing reverts and what is left fits the planned leftover.
 */
export function checkReplay(chainId: number, txs: PlanTx[], r: ReplayResult, exit: { leftoverMax: bigint } | null): void {
  const fail = (why: string): never => { throw new Error(`Replay refused the set: ${why}`); };
  r.results.forEach((x, i) => {
    if (!x.ok) fail(`transaction ${i + 1} reverts (${x.error ?? 'unknown'})`);
  });
  if (exit) {
    if (r.after > exit.leftoverMax) fail('the swap would leave more than planned');
    return;
  }
  // On Etherlink the fork charges execution gas only: the inclusion fee the
  // chain adds is what the replayed wallet keeps, and must be exactly that
  let uncharged = 0n;
  r.results.forEach((x, i) => {
    const t = txs[i]!;
    const inclusion = chainId === ETHERLINK ? etherlinkInclusionGas(t.data, BigInt(t.gasPrice)) : 0n;
    uncharged += inclusion * BigInt(t.gasPrice);
    if (x.gasUsed + inclusion !== BigInt(t.gas)) fail(`transaction ${i + 1} would use ${x.gasUsed + inclusion} gas, not its limit ${t.gas}`);
  });
  if (r.after !== uncharged) fail(`the wallet would keep ${r.after - uncharged} wei`);
}
