import { chainConfig as zkChainConfig } from 'viem/zksync';
import { bytesToHex, decodeFunctionData, decodeFunctionResult, encodeFunctionData, keccak256, parseAbi, type Hex, type LocalAccount } from 'viem';
import { DIRECT_RPC_URLS, RPC_URLS } from '../chains/rpcs';
import { isRegisteredSettler, ZEROX_DEPLOYER, ZEROX_REGISTRY_CALLS } from './across';
import { hexToBytes, OP_GAS_PRICE_ORACLE, settleL1Value, type L1Params } from './l1fee';
import {
  directChains, FIXED_PRICE_CHAINS, GASLIMIT_CHAINS, GUARD_CHAINS, OFT_FEE_MARGIN_PERCENT, tokenExitFor, ZERODUST_GUARD, ZERODUST_GUARD_CODEHASH, ZK_PAYMASTERS,
  prepareExit, preparePlan, TX_GAP_BLOCKS, type DirectPlan, type PlanMode, type Target,
} from './plan';
import { checkReplay, replay } from './replay';
import { GUARD_SWEEP, MAX_FEE_SHARE, verifyPlan } from './verify';

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

const OFT_SEND_ABI = parseAbi(['function sendFrom(address from, uint16 dstChainId, bytes32 toAddress, uint256 amount, (address refundAddress, address zroPaymentAddress, bytes adapterParams) callParams) payable']);
const OFT_FEE_ABI = parseAbi(['function estimateSendFee(uint16 dstChainId, bytes32 toAddress, uint256 amount, bool useZro, bytes adapterParams) view returns (uint256 nativeFee, uint256 zroFee)']);

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
  if ((kinds[t.chainId] === 'opguard') !== (GUARD_CHAINS[t.chainId] !== undefined)) throw new Error('Plan refused: the API and this page disagree on how this chain charges its L1 fee');
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
  if (tokenExit) {
    // What the bridge keeps as its fee (value - amount, refunded beyond the real fee to ZeroDust) may
    // be at most LayerZero's own quote, read here, plus 10% and the rounding to shared decimals
    const send = plan.txs.at(-1)!;
    const { args } = decodeFunctionData({ abi: OFT_SEND_ABI, data: send.data as Hex });
    const quoted = await rpc<string>(t.chainId, 'eth_call', [{ to: tokenExit.oft, data: encodeFunctionData({ abi: OFT_FEE_ABI, functionName: 'estimateSendFee', args: [tokenExit.lzChainId, args[2], args[3], false, tokenExit.adapterParams as Hex] }) }, 'latest']);
    const [nativeFee] = decodeFunctionResult({ abi: OFT_FEE_ABI, functionName: 'estimateSendFee', data: quoted as Hex });
    if (BigInt(send.value) - args[3] > (nativeFee * OFT_FEE_MARGIN_PERCENT) / 100n + tokenExit.dustRate) {
      throw new Error('Plan refused: the bridge fee in it is above what the bridge quotes');
    }
  }
  // ZK-stack chains: the paymaster pays all gas, so the values adding up to the balance (checked
  // above) is the whole exact-zero argument; there is no EVM fork to replay them on
  if (ZK_PAYMASTERS[t.chainId]) return plan;
  if (GUARD_CHAINS[t.chainId]) {
    // The guard is what makes exact zero hold: its code must be the audited one
    const code = await rpc<Hex>(t.chainId, 'eth_getCode', [ZERODUST_GUARD, 'latest']);
    if (code === '0x' || keccak256(code) !== ZERODUST_GUARD_CODEHASH) throw new Error('Plan refused: ZeroDust\'s guard is not deployed on this chain as expected');
    // The fork charges no L1 fee: replay with the planned L1 fee added to the value, so the wallet
    // is at 0 while the guard runs, as on-chain; the guard must then burn every unit of its gas
    const l1Fee = BigInt(plan.guard!.l1Fee);
    const txs = plan.txs.map((tx) => ({ ...tx, value: (BigInt(tx.value) + l1Fee).toString() }));
    checkReplay(t.chainId, txs, await replay(t.chainId, t.from, txs), null);
    return plan;
  }
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

const ORACLE_ABI = parseAbi([
  'function isFjord() view returns (bool)',
  'function isIsthmus() view returns (bool)',
  'function l1BaseFee() view returns (uint256)',
  'function blobBaseFee() view returns (uint256)',
  'function baseFeeScalar() view returns (uint32)',
  'function blobBaseFeeScalar() view returns (uint32)',
]);

/** OP-stack L1Block predeploy: sequenceNumber() is 0 in the first L2 block of each L1 origin */
const L1_BLOCK = '0x4200000000000000000000000000000000000015';
const L1_SEQUENCE_NUMBER = '0x64ca23ef';
/** How long the page waits for a fresh L1 origin before signing anyway */
const L1_ORIGIN_WAIT_TRIES = 20;
const L1_ORIGIN_POLL_MS = 750;

/**
 * The block to price the L1 fee at: the first or second of an L1 origin. The fee's parameters
 * change only when the origin moves (every L1 block, ~6 L2 blocks on Blast and Boba), and a
 * transaction priced against one origin and included under the next is refused by the guard
 * (Boba, 2026-10-08: signed two blocks before an 8% L1 base fee drop). Signing right after a
 * change leaves the rest of the origin's blocks for inclusion.
 */
async function freshL1OriginBlock(chainId: number): Promise<string> {
  let tag = 'latest';
  for (let i = 0; i < L1_ORIGIN_WAIT_TRIES; i++) {
    tag = await rpc<string>(chainId, 'eth_blockNumber', []);
    const seq = await rpc<Hex>(chainId, 'eth_call', [{ to: L1_BLOCK, data: L1_SEQUENCE_NUMBER }, tag]).then(BigInt).catch(() => null);
    if (seq !== null && seq <= 1n) return tag;
    await sleep(L1_ORIGIN_POLL_MS);
  }
  return tag;
}

/** The chain's L1 fee parameters at a block, after checking its oracle reports the formula the page computes */
async function readL1Params(chainId: number, tag: string): Promise<L1Params> {
  type Fn = 'isFjord' | 'isIsthmus' | 'l1BaseFee' | 'blobBaseFee' | 'baseFeeScalar' | 'blobBaseFeeScalar';
  const read = async (functionName: Fn): Promise<bigint | boolean | null> => {
    const out = await rpc<Hex>(chainId, 'eth_call', [{ to: OP_GAS_PRICE_ORACLE, data: encodeFunctionData({ abi: ORACLE_ABI, functionName }) }, tag])
      // A flag the oracle does not have yet reverts: the upgrade has not happened
      .catch(() => null);
    if (out === null) return null;
    const v = decodeFunctionResult({ abi: ORACLE_ABI, functionName, data: out }) as bigint | number | boolean;
    // uint32 scalars decode as numbers
    return typeof v === 'number' ? BigInt(v) : v;
  };
  const [fjord, isthmus, l1BaseFee, blobBaseFee, baseFeeScalar, blobBaseFeeScalar] = await Promise.all(
    (['isFjord', 'isIsthmus', 'l1BaseFee', 'blobBaseFee', 'baseFeeScalar', 'blobBaseFeeScalar'] as const).map(read)
  );
  if ((fjord === true) !== (GUARD_CHAINS[chainId] === 'fjord')) throw new Error('This chain changed how it charges its L1 fee; ZeroDust cannot sweep it to exactly 0 until it is updated');
  // Isthmus adds an operator fee the page does not compute
  if (isthmus === true) throw new Error('This chain added an operator fee; ZeroDust cannot sweep it to exactly 0 until it is updated');
  if ([l1BaseFee, blobBaseFee, baseFeeScalar, blobBaseFeeScalar].some((v) => typeof v !== 'bigint')) throw new Error('The chain\'s L1 fee oracle did not answer; try again');
  return { l1BaseFee: l1BaseFee as bigint, blobBaseFee: blobBaseFee as bigint, baseFeeScalar: baseFeeScalar as bigint, blobBaseFeeScalar: blobBaseFeeScalar as bigint };
}

/**
 * Guard chains: the one transaction, signed with value = balance - gas x price - its exact L1
 * fee (l1fee.ts settleL1Value; the gas limit may go up a few units for a fresh signature, all of
 * it burned). The difference from the API's estimate moves into ZeroDust's fee
 * (a bridge deposit keeps its quoted amount) or into the amount forwarded, bounded: the fee stays
 * within 5% of the balance plus the planned L1 fee, and nothing goes below 0. The plan's transaction is updated to what
 * was signed.
 */
async function signGuardTransaction(account: LocalAccount, plan: DirectPlan): Promise<Hex[]> {
  const g = plan.guard!;
  const tx = plan.txs[0]!;
  const params = await readL1Params(plan.chainId, await freshL1OriginBlock(plan.chainId));
  const balance = BigInt(plan.balance);
  const fee0 = BigInt(plan.fee);
  const forwarded0 = BigInt(g.forwarded);
  const split = (value: bigint) => {
    const extra = value - (fee0 + forwarded0);
    const s = g.absorb === 'fee' ? { fee: fee0 + extra, forwarded: forwarded0 } : { fee: fee0, forwarded: forwarded0 + extra };
    if (s.fee < 0n || s.forwarded <= 0n || s.fee > balance / MAX_FEE_SHARE + BigInt(g.l1Fee)) throw new Error('The L1 fee is far from what was planned; check again');
    return s;
  };
  const build = (value: bigint, gas: bigint) => {
    const { fee } = split(value);
    return {
      type: 'legacy' as const, chainId: plan.chainId, nonce: tx.nonce, to: ZERODUST_GUARD as `0x${string}`, value,
      data: encodeFunctionData({ abi: GUARD_SWEEP, functionName: 'sweep', args: [g.target as `0x${string}`, fee, g.data as Hex] }),
      gas, gasPrice: BigInt(tx.gasPrice),
    };
  };
  const settled = await settleL1Value({
    balance, gas: BigInt(tx.gas), gasPrice: BigInt(tx.gasPrice), formula: g.l1Formula, params, firstValue: BigInt(tx.value),
    sign: async (value, gas) => hexToBytes(await account.signTransaction(build(value, gas))),
  });
  const final = build(settled.value, settled.gas);
  const { fee, forwarded } = split(settled.value);
  plan.txs[0] = { ...tx, value: settled.value.toString(), data: final.data, gas: settled.gas.toString() };
  plan.guard = { ...g, l1Fee: settled.l1Fee.toString(), forwarded: forwarded.toString() };
  plan.fee = fee.toString();
  if (plan.route === 'transfer') plan.receive = forwarded.toString();
  return [bytesToHex(settled.signed)];
}

export function signPlan(account: LocalAccount, plan: DirectPlan): Promise<Hex[]> {
  if (ZK_PAYMASTERS[plan.chainId]) return Promise.all(plan.txs.map((t) => signZkTransaction(account, plan.chainId, t)));
  if (GUARD_CHAINS[plan.chainId]) return signGuardTransaction(account, plan);
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
    if (receipt && receipt.status !== '0x1' && GUARD_CHAINS[plan.chainId]) {
      return { ...out, ok: false, reason: 'The L1 fee changed between signing and inclusion, so ZeroDust\'s guard refused the sweep. Only this attempt\'s gas was spent; sweep again' };
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
