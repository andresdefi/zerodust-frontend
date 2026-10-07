import { chainConfig as zkChainConfig } from 'viem/zksync';
import type { Hex, LocalAccount } from 'viem';
import { DIRECT_RPC_URLS, RPC_URLS } from '../chains/rpcs';
import { isRegisteredSettler, ZEROX_DEPLOYER, ZEROX_REGISTRY_CALLS } from './across';
import { directChains, FIXED_PRICE_CHAINS, GASLIMIT_CHAINS, tokenExitFor, ZK_PAYMASTERS, prepareExit, preparePlan, TX_GAP_BLOCKS, type DirectPlan, type PlanMode, type Target } from './plan';
import { checkReplay, replay } from './replay';
import { verifyPlan } from './verify';

/** An Across deposit must still have this long to live when the page signs it, and when it sends it */
export const ACROSS_SIGN_MARGIN_S = 10;
export const ACROSS_SEND_MARGIN_S = 4;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nowS = () => Date.now() / 1000;

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

let chainKinds: Promise<Record<number, string | undefined>> | null = null;
/** The API's gas rule per direct chain, read once per page load */
function apiChainKinds(): Promise<Record<number, string | undefined>> {
  chainKinds ??= directChains().then((r) => Object.fromEntries(r.chains.map((c) => [c.chainId, c.kind]))).catch((error: unknown) => {
    chainKinds = null;
    throw error;
  });
  return chainKinds;
}

/** The destination swap of an Across route must run through 0x's current or previous Settler */
async function confirmSettler(toChainId: number, settler: string): Promise<void> {
  const url = RPC_URLS[toChainId];
  if (!url) throw new Error('Plan refused: no RPC to check the destination swap on that chain');
  const call = async (data: string) => {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: ZEROX_DEPLOYER, data }, 'latest'] }) });
    return ((await res.json()) as { result?: string }).result ?? '0x';
  };
  const answers = await Promise.all([call(ZEROX_REGISTRY_CALLS.ownerOf), call(ZEROX_REGISTRY_CALLS.prev)]);
  if (!isRegisteredSettler(settler, answers)) throw new Error('Plan refused: the destination swap does not run through 0x\'s registered Settler');
}

const expired = (plan: DirectPlan, marginS: number) => plan.expiresAt !== undefined && nowS() > plan.expiresAt - marginS;

/**
 * A plan the page has checked on its own: the API's transactions verified
 * against the owner's request and the chain's state, then replayed on a fork
 * of the chain. Nothing is signed or sent here.
 */
export async function planChecked(t: Target, mode: PlanMode, feePaidTx?: string): Promise<DirectPlan> {
  const plan = mode === 'exit' ? await prepareExit({ ...t, feePaidTx }) : await preparePlan({ ...t, mode, feePaidTx });
  const [wallet, kinds] = await Promise.all([readWallet(t.chainId, t.from), apiChainKinds()]);
  // The page's own list decides how a plan is checked; the API must agree with it
  if ((kinds[t.chainId] === 'gaslimit') !== GASLIMIT_CHAINS.has(t.chainId)) throw new Error('Plan refused: the API and this page disagree on how this chain charges gas');
  if ((kinds[t.chainId] === 'zk') !== (ZK_PAYMASTERS[t.chainId] !== undefined)) throw new Error('Plan refused: the API and this page disagree on how this chain pays gas');
  if ((kinds[t.chainId] === 'fixedprice') !== FIXED_PRICE_CHAINS.has(t.chainId)) throw new Error('Plan refused: the API and this page disagree on how this chain prices gas');
  if (FIXED_PRICE_CHAINS.has(t.chainId)) {
    // The chain charges its network price whatever is offered: any other price leaves dust
    const network = BigInt(await rpc<string>(t.chainId, 'eth_gasPrice', []));
    if (plan.txs.some((tx) => BigInt(tx.gasPrice) !== network)) throw new Error('Plan refused: its gas price is not the network gas price, so the sweep would leave dust');
  }
  const tokenExit = mode === 'exit' ? tokenExitFor(t.chainId, t.toChainId) : undefined;
  if (tokenExit) {
    // The OFT spends a wrapped balance first and would keep the native value as its fee
    const wrapped = await rpc<string>(t.chainId, 'eth_call', [{ to: tokenExit.oft, data: `0x70a08231${t.from.slice(2).toLowerCase().padStart(64, '0')}` }, 'latest']);
    if (BigInt(wrapped) !== 0n) throw new Error(`Plan refused: this wallet holds wrapped ${tokenExit.token.symbol} on the bridge; unwrap it first`);
  }
  const checks = verifyPlan(plan, { ...t, mode, ...wallet });
  // ZK-stack chains: the paymaster pays all gas, so the values adding up to the balance (checked
  // above) is the whole exact-zero argument; there is no EVM fork to replay them on
  if (ZK_PAYMASTERS[t.chainId]) return plan;
  // Never the API's expiry: the one in the deposit itself (or none)
  delete plan.expiresAt;
  if (checks.across) {
    await confirmSettler(t.toChainId, checks.across.settler);
    plan.expiresAt = checks.across.expiresAt;
  }
  const result = await replay(t.chainId, t.from, plan.txs);
  checkReplay(t.chainId, plan.txs, result, mode === 'exit' ? { leftoverMax: BigInt(plan.leftoverMax!) } : null);
  if (expired(plan, ACROSS_SIGN_MARGIN_S)) throw new Error('The Across quote expired while it was being checked; check again');
  return plan;
}

/**
 * ZK-stack chains: an EIP-712 (type 113) transaction naming the paymaster, signed the way viem's
 * signEip712Transaction does it: the ZKsync transaction domain, signed by the account, serialized
 */
async function signZkTransaction(account: LocalAccount, chainId: number, t: DirectPlan['txs'][number]): Promise<Hex> {
  const tx = {
    chainId, from: account.address, to: t.to as `0x${string}`, data: t.data as Hex, value: BigInt(t.value), nonce: t.nonce,
    gas: BigInt(t.gas), maxFeePerGas: BigInt(t.gasPrice), maxPriorityFeePerGas: 0n,
    paymaster: t.paymaster as `0x${string}`, paymasterInput: t.paymasterInput as Hex, gasPerPubdata: BigInt(t.gasPerPubdata!),
    type: 'eip712' as const,
  };
  const customSignature = await account.signTypedData(zkChainConfig.custom.getEip712Domain(tx) as never);
  return zkChainConfig.serializers.transaction({ ...tx, customSignature }, { r: '0x0', s: '0x0', v: 0n }) as Hex;
}

export function signPlan(account: LocalAccount, plan: DirectPlan): Promise<Hex[]> {
  if (ZK_PAYMASTERS[plan.chainId]) return Promise.all(plan.txs.map((t) => signZkTransaction(account, plan.chainId, t)));
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
  /** Why the set stopped, when the page stopped it on purpose */
  reason?: string;
  /** A fee transfer that landed: passed to the next plan so a retry is not charged twice */
  feePaidTx?: string;
}

/** Per chain: the block of the last transaction this page landed (for TX_GAP_BLOCKS) */
const lastBlock: Record<number, bigint> = {};

/** Waits until the chain is TX_GAP_BLOCKS past this page's last transaction on it; false if it never gets there */
async function waitForGap(chainId: number): Promise<boolean> {
  const gap = TX_GAP_BLOCKS[chainId];
  const last = lastBlock[chainId];
  if (!gap || last === undefined) return true;
  for (let tries = 0; tries < 120; tries++) {
    const head = BigInt(await rpc<string>(chainId, 'eth_blockNumber', []));
    if (head >= last + BigInt(gap)) return true;
    await sleep(500);
  }
  return false;
}

/**
 * Sends the signed set straight to the chain's RPC, each after the previous
 * one confirms; on chains with a reserve rule, also TX_GAP_BLOCKS after it.
 * An Across sweep is not sent once its deposit would revert as expired.
 */
export async function broadcast(plan: DirectPlan, raws: Hex[], onSent?: (hash: string, index: number) => void): Promise<Broadcast> {
  const out: Broadcast = { hashes: [], ok: true };
  for (const [i, raw] of raws.entries()) {
    if (!(await waitForGap(plan.chainId))) return { ...out, ok: false, reason: 'The chain did not advance; the rest of the set was not sent' };
    if (plan.txs[i]!.kind === 'sweep' && expired(plan, ACROSS_SEND_MARGIN_S)) {
      return { ...out, ok: false, reason: 'The Across quote expired before the sweep could be sent, so it was not sent. Check again (a fee already paid is not charged twice)' };
    }
    const hash = await rpc<string>(plan.chainId, 'eth_sendRawTransaction', [raw]);
    out.hashes.push(hash);
    onSent?.(hash, i);
    let receipt: { status: string; blockNumber?: string } | null = null;
    for (let tries = 0; tries < 90 && !receipt; tries++) {
      receipt = await rpc<{ status: string; blockNumber?: string } | null>(plan.chainId, 'eth_getTransactionReceipt', [hash]).catch(() => null);
      if (!receipt) await sleep(TX_GAP_BLOCKS[plan.chainId] ? 500 : 2000);
    }
    if (receipt?.blockNumber) lastBlock[plan.chainId] = BigInt(receipt.blockNumber);
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
