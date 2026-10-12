// Withdrawals through a chain's own bridge (sweep/native.ts), read from the chain and from
// Ethereum: where each one stands, and the prove and claim transactions to send there (phase 2,
// owner 2026-10-12). Anyone may send them; the funds always go to the withdrawal's recipient.
// Every contract is pinned here, nothing comes from the API.
import {
  createPublicClient, decodeAbiParameters, fallback, decodeEventLog, encodeFunctionData, http, isAddressEqual, parseAbi, parseEventLogs,
  slice, toEventSelector, type Address, type Hex, type PublicClient, type TransactionReceipt,
} from 'viem';
import { buildProveWithdrawal, getWithdrawals } from 'viem/op-stack';
import { DIRECT_RPC_URLS, ETHEREUM_FALLBACK_RPC, RPC_URLS } from '../chains/rpcs';
import { nativeExitOf } from './native';

// ---- Pinned contracts on Ethereum ----

interface OpGames { kind: 'op-games'; portal: Address; factory: Address }
interface OpOracle { kind: 'op-oracle'; portal: Address; oracle: Address; yieldManager: Address }
interface Arb { kind: 'arb'; rollup: Address; outbox: Address }
interface Zk { kind: 'zk'; nullifier: Address }
type Contracts = OpGames | OpOracle | Arb | Zk;

export const CLAIM_CONTRACTS: Readonly<Record<number, Contracts>> = {
  // Lisk: OptimismPortal2 with dispute games (games still report l2BlockNumber)
  1135: { kind: 'op-games', portal: '0x26dB93F8b8b4f7016240af62F7730979d353f9A7', factory: '0x0CF7D3706a27CCE2017aEB11E8a9c8b5388c282C' },
  // Blast: the older portal with an L2OutputOracle; a claim names a yield checkpoint hint
  81457: { kind: 'op-oracle', portal: '0x0Ec68c5B10F21EFFb74f2A5C61DFe6b08C0Db6Cb', oracle: '0x826D1B0D4111Ad9146Eb8941D7Ca2B6a44215c76', yieldManager: '0x98078db053902644191f93988341E31289E1C8FE' },
  42170: { kind: 'arb', rollup: '0xE7E8cCC7c381809BDC4b213CE44016300707B7Bd', outbox: '0xD4B80C3D7240325D18E645B49e6535A3Bf95cc58' },
  1625: { kind: 'arb', rollup: '0x2807B1d5d94ca823ca7d8642A5F5DDac120ce48f', outbox: '0x1153a1e4B1523DFf36f77d696bd6eBF2B0e7DAbF' },
  // Abstract: the ZK Stack's L1Nullifier (behind its shared bridge)
  2741: { kind: 'zk', nullifier: '0xD7f9f54194C633F36CCD5F3da84ad4a1c38cB2cB' },
};

const rpcOf = (chainId: number) => RPC_URLS[chainId] ?? DIRECT_RPC_URLS[chainId];
const clients = new Map<number, PublicClient>();
function client(chainId: number): PublicClient {
  let c = clients.get(chainId);
  if (!c) {
    const url = rpcOf(chainId);
    if (!url) throw new Error(`no RPC for chain ${chainId}`);
    const opts = { timeout: 15_000, retryCount: 2, retryDelay: 600 };
    // Ethereum: a second RPC when the first rate-limits (a claim reads a dozen things there)
    const transport = chainId === 1 ? fallback([http(url, opts), http(ETHEREUM_FALLBACK_RPC, opts)]) : http(url, opts);
    c = createPublicClient({ transport }) as PublicClient;
    clients.set(chainId, c);
  }
  return c;
}
export const l1 = () => client(1);

// ---- The withdrawal, from its transaction on the chain ----

const TX_STRUCT = 'struct WithdrawalTransaction { uint256 nonce; address sender; address target; uint256 value; uint256 gasLimit; bytes data; }';
type OpTx = { nonce: bigint; sender: Address; target: Address; value: bigint; gasLimit: bigint; data: Hex };
const L2_TO_L1_TX = parseAbi(['event L2ToL1Tx(address caller, address indexed destination, uint256 indexed hash, uint256 indexed position, uint256 arbBlockNum, uint256 ethBlockNum, uint256 timestamp, uint256 callvalue, bytes data)']);
const ETH_BRIDGE_INITIATED = parseAbi(['event ETHBridgeInitiated(address indexed from, address indexed to, uint256 amount, bytes extraData)']);
const ZK_WITHDRAWAL = parseAbi(['event Withdrawal(address indexed _l2Sender, address indexed _l1Receiver, uint256 _amount)']);
const L1_MESSENGER: Address = '0x0000000000000000000000000000000000008008';
const ZK_BASE_TOKEN: Address = '0x000000000000000000000000000000000000800A';
const L1_MESSAGE_SENT = toEventSelector('L1MessageSent(address,bytes32,bytes)');

export interface Withdrawal {
  chainId: number;
  txHash: Hex;
  /** Who receives it on Ethereum */
  recipient: Address;
  /** Wei, or the token's units (Gravity: G) */
  amount: bigint;
  /** When the chain included it */
  sentAt: number;
  /** What each stack needs to read its state and build its calls */
  op?: { tx: OpTx; hash: Hex; block: bigint };
  arb?: { position: bigint; caller: Address; destination: Address; arbBlockNum: bigint; ethBlockNum: bigint; timestamp: bigint; callvalue: bigint; data: Hex };
  zk?: { batch: bigint | null; txIndex: number; message: Hex; sender: Address; logIndex: number };
}

/** The withdrawal a sweep's transaction made, or null when it holds none (another of the sweep's transactions) */
export async function readWithdrawal(chainId: number, txHash: Hex): Promise<Withdrawal | null> {
  if (!CLAIM_CONTRACTS[chainId]) return null;
  const l2 = client(chainId);
  const receipt = await l2.getTransactionReceipt({ hash: txHash });
  if (receipt.status !== 'success') return null;
  const block = await l2.getBlock({ blockNumber: receipt.blockNumber });
  return withdrawalOf(chainId, receipt, Number(block.timestamp) * 1000);
}

// The chains' system contracts: only their events count (any contract can emit one with the same
// signature, and a pasted hash may be anyone's transaction)
const OP_MESSAGE_PASSER: Address = '0x4200000000000000000000000000000000000016';
const OP_L2_BRIDGE: Address = '0x4200000000000000000000000000000000000010';
/** Blast also has its own ETH bridge (L2BlastBridge), which emits the same event */
const BLAST_L2_BRIDGE: Address = '0x4300000000000000000000000000000000000005';
const OP_L2_MESSENGER: Address = '0x4200000000000000000000000000000000000007';
const ARB_SYS: Address = '0x0000000000000000000000000000000000000064';
const logsFrom = (receipt: TransactionReceipt, address: Address) => receipt.logs.filter((l) => isAddressEqual(l.address, address));

/**
 * The one withdrawal in a receipt, from the chain's own contracts' events. A transaction with more
 * than one is refused: which amount goes to which recipient could not be shown for sure.
 */
export function withdrawalOf(chainId: number, receipt: TransactionReceipt, sentAt: number): Withdrawal | null {
  const c = CLAIM_CONTRACTS[chainId];
  if (!c) return null;
  const base = { chainId, txHash: receipt.transactionHash, sentAt };
  if (c.kind === 'arb') {
    const events = parseEventLogs({ abi: L2_TO_L1_TX, logs: logsFrom(receipt, ARB_SYS) });
    if (events.length !== 1) return null;
    const a = events[0]!.args;
    return { ...base, recipient: a.destination, amount: a.callvalue, arb: { position: a.position, caller: a.caller, destination: a.destination, arbBlockNum: a.arbBlockNum, ethBlockNum: a.ethBlockNum, timestamp: a.timestamp, callvalue: a.callvalue, data: a.data } };
  }
  if (c.kind === 'zk') return readZk(receipt as ZkReceipt, base);
  const withdrawals = getWithdrawals({ logs: logsFrom(receipt, OP_MESSAGE_PASSER) });
  if (withdrawals.length !== 1) return null;
  const w = withdrawals[0]!;
  // Through L2StandardBridge the message goes to Ethereum's messenger; the bridge's event names the
  // user. It counts only when it is the message the messenger passed (same value).
  const bridges = c.kind === 'op-oracle' ? [OP_L2_BRIDGE, BLAST_L2_BRIDGE] : [OP_L2_BRIDGE];
  const bridged = parseEventLogs({ abi: ETH_BRIDGE_INITIATED, logs: bridges.flatMap((b) => logsFrom(receipt, b)) });
  const viaBridge = bridged.length === 1 && isAddressEqual(w.sender, OP_L2_MESSENGER) && bridged[0]!.args.amount === w.value ? bridged[0]!.args : undefined;
  if (bridged.length > 0 && !viaBridge) return null;
  const recipient = viaBridge ? viaBridge.to : w.target;
  const amount = viaBridge ? viaBridge.amount : w.value;
  return { ...base, recipient, amount, op: { tx: { nonce: w.nonce, sender: w.sender, target: w.target, value: w.value, gasLimit: w.gasLimit, data: w.data }, hash: w.withdrawalHash, block: receipt.blockNumber } };
}

type ZkReceipt = TransactionReceipt & { l1BatchNumber: Hex | bigint | null; l1BatchTxIndex: Hex | bigint | null; l2ToL1Logs: Array<{ sender: Address }> };

function readZk(receipt: ZkReceipt, base: Pick<Withdrawal, 'chainId' | 'txHash' | 'sentAt'>): Withdrawal | null {
  const events = parseEventLogs({ abi: ZK_WITHDRAWAL, logs: logsFrom(receipt, ZK_BASE_TOKEN) });
  const messages = logsFrom(receipt, L1_MESSENGER).filter((l) => l.topics[0] === L1_MESSAGE_SENT);
  const logIndex = (receipt.l2ToL1Logs ?? []).findIndex((l) => isAddressEqual(l.sender, L1_MESSENGER));
  if (events.length !== 1 || messages.length !== 1 || logIndex < 0) return null;
  const ev = events[0]!;
  const log = messages[0]!;
  const [message] = decodeAbiParameters([{ type: 'bytes' }], log.data);
  const big = (v: Hex | bigint | null) => (v === null || v === undefined ? null : BigInt(v));
  return {
    ...base, recipient: ev.args._l1Receiver, amount: ev.args._amount,
    zk: { batch: big(receipt.l1BatchNumber), txIndex: Number(big(receipt.l1BatchTxIndex) ?? 0n), message, sender: slice(log.topics[1]!, 12) as Address, logIndex },
  };
}

// ---- Where it stands ----

export type ClaimState =
  /** Nothing to send yet; `until` is an estimate when there is one */
  | { stage: 'waiting'; until?: number }
  /** OP stack: the chain's state covering it is on Ethereum; prove it */
  | { stage: 'prove' }
  /** OP stack: proved; claimable from `until` */
  | { stage: 'proved'; until: number }
  | { stage: 'claim' }
  | { stage: 'claimed' };

const HOUR = 3_600_000;

const PORTAL2 = parseAbi([
  'function finalizedWithdrawals(bytes32) view returns (bool)',
  'function numProofSubmitters(bytes32) view returns (uint256)',
  'function proofSubmitters(bytes32, uint256) view returns (address)',
  'function provenWithdrawals(bytes32, address) view returns (address disputeGameProxy, uint64 timestamp)',
  'function proofMaturityDelaySeconds() view returns (uint256)',
  'function respectedGameType() view returns (uint32)',
  'function checkWithdrawal(bytes32, address) view',
  'struct OutputRootProof { bytes32 version; bytes32 stateRoot; bytes32 messagePasserStorageRoot; bytes32 latestBlockhash; }',
  TX_STRUCT,
  'function proveWithdrawalTransaction(WithdrawalTransaction _tx, uint256 _disputeGameIndex, OutputRootProof _outputRootProof, bytes[] _withdrawalProof)',
  'function finalizeWithdrawalTransactionExternalProof(WithdrawalTransaction _tx, address _proofSubmitter)',
]);
const FACTORY = parseAbi(['function gameCount() view returns (uint256)', 'function gameAtIndex(uint256) view returns (uint32 gameType, uint64 timestamp, address proxy)']);
const GAME = parseAbi(['function l2BlockNumber() view returns (uint256)']);
const PORTAL1 = parseAbi([
  'function finalizedWithdrawals(bytes32) view returns (bool)',
  'function provenWithdrawals(bytes32) view returns (bytes32 outputRoot, uint128 timestamp, uint128 l2OutputIndex, uint256 requestId)',
  'struct OutputRootProof { bytes32 version; bytes32 stateRoot; bytes32 messagePasserStorageRoot; bytes32 latestBlockhash; }',
  TX_STRUCT,
  'function proveWithdrawalTransaction(WithdrawalTransaction _tx, uint256 _l2OutputIndex, OutputRootProof _outputRootProof, bytes[] _withdrawalProof)',
  'function finalizeWithdrawalTransaction(uint256 hintId, WithdrawalTransaction _tx)',
]);
const ORACLE = parseAbi([
  'function latestBlockNumber() view returns (uint256)',
  'function FINALIZATION_PERIOD_SECONDS() view returns (uint256)',
  'function getL2OutputIndexAfter(uint256) view returns (uint256)',
  'function getL2Output(uint256) view returns ((bytes32 outputRoot, uint128 timestamp, uint128 l2BlockNumber))',
]);
const YIELD = parseAbi(['function getLastCheckpointId() view returns (uint256)', 'function findCheckpointHint(uint256, uint256, uint256) view returns (uint256)']);
const OUTBOX = parseAbi([
  'function roots(bytes32) view returns (bytes32)',
  'function isSpent(uint256) view returns (bool)',
  'function executeTransaction(bytes32[] proof, uint256 index, address l2Sender, address to, uint256 l2Block, uint256 l1Block, uint256 l2Timestamp, uint256 value, bytes data)',
]);
const NULLIFIER = parseAbi([
  'function isWithdrawalFinalized(uint256 chainId, uint256 l2BatchNumber, uint256 l2MessageIndex) view returns (bool)',
  'function finalizeDeposit((uint256 chainId, uint256 l2BatchNumber, uint256 l2MessageIndex, address l2Sender, uint16 l2TxNumberInBatch, bytes message, bytes32[] merkleProof) _finalizeWithdrawalParams)',
]);

export async function claimState(w: Withdrawal, now = Date.now()): Promise<ClaimState> {
  const c = CLAIM_CONTRACTS[w.chainId]!;
  const estimate = (): ClaimState => {
    const until = w.sentAt + (nativeExitOf(w.chainId)?.claimAfterHours ?? 0) * HOUR;
    return { stage: 'waiting', ...(until > now ? { until } : {}) };
  };
  if (c.kind === 'op-games') {
    const { hash, block } = w.op!;
    if (await l1().readContract({ address: c.portal, abi: PORTAL2, functionName: 'finalizedWithdrawals', args: [hash] })) return { stage: 'claimed' };
    const submitter = await provedBy(c, hash);
    if (submitter) {
      const [[, proved], delay] = await Promise.all([
        l1().readContract({ address: c.portal, abi: PORTAL2, functionName: 'provenWithdrawals', args: [hash, submitter] }),
        l1().readContract({ address: c.portal, abi: PORTAL2, functionName: 'proofMaturityDelaySeconds' }),
      ]);
      const until = (Number(proved) + Number(delay)) * 1000;
      if (until > now) return { stage: 'proved', until };
      // Past the wait: ready once its dispute game has resolved (checkWithdrawal reverts until then)
      try {
        await l1().readContract({ address: c.portal, abi: PORTAL2, functionName: 'checkWithdrawal', args: [hash, submitter] });
        return { stage: 'claim' };
      } catch {
        return { stage: 'proved', until: now + HOUR };
      }
    }
    return (await latestGame(c)).l2BlockNumber >= block ? { stage: 'prove' } : { stage: 'waiting' };
  }
  if (c.kind === 'op-oracle') {
    const { hash, block } = w.op!;
    if (await l1().readContract({ address: c.portal, abi: PORTAL1, functionName: 'finalizedWithdrawals', args: [hash] })) return { stage: 'claimed' };
    const [, proved] = await l1().readContract({ address: c.portal, abi: PORTAL1, functionName: 'provenWithdrawals', args: [hash] });
    if (proved > 0n) {
      const period = await l1().readContract({ address: c.oracle, abi: ORACLE, functionName: 'FINALIZATION_PERIOD_SECONDS' });
      const until = (Number(proved) + Number(period)) * 1000;
      return until > now ? { stage: 'proved', until } : { stage: 'claim' };
    }
    const latest = await l1().readContract({ address: c.oracle, abi: ORACLE, functionName: 'latestBlockNumber' });
    return latest >= block ? { stage: 'prove' } : { stage: 'waiting' };
  }
  if (c.kind === 'arb') {
    const a = w.arb!;
    if (await l1().readContract({ address: c.outbox, abi: OUTBOX, functionName: 'isSpent', args: [a.position] })) return { stage: 'claimed' };
    const { sendCount } = await confirmedArb(w.chainId, c);
    return sendCount > a.position ? { stage: 'claim' } : estimate();
  }
  const z = w.zk!;
  if (z.batch === null) return estimate();
  const details = await zkRpc<{ executedAt: string | null } | null>(w.chainId, 'zks_getL1BatchDetails', [Number(z.batch)]);
  if (!details?.executedAt) return estimate();
  const proof = await zkProof(w);
  if (await l1().readContract({ address: c.nullifier, abi: NULLIFIER, functionName: 'isWithdrawalFinalized', args: [BigInt(w.chainId), z.batch, BigInt(proof.id)] })) return { stage: 'claimed' };
  return { stage: 'claim' };
}

// ---- OP stack ----

async function provedBy(c: OpGames, hash: Hex): Promise<Address | undefined> {
  const n = await l1().readContract({ address: c.portal, abi: PORTAL2, functionName: 'numProofSubmitters', args: [hash] });
  if (n === 0n) return undefined;
  return l1().readContract({ address: c.portal, abi: PORTAL2, functionName: 'proofSubmitters', args: [hash, n - 1n] });
}

/** The newest game of the type the portal accepts (a few recent ones are checked) */
async function latestGame(c: OpGames): Promise<{ index: bigint; l2BlockNumber: bigint }> {
  const [count, type] = await Promise.all([
    l1().readContract({ address: c.factory, abi: FACTORY, functionName: 'gameCount' }),
    l1().readContract({ address: c.portal, abi: PORTAL2, functionName: 'respectedGameType' }),
  ]);
  for (let i = count - 1n; i >= 0n && i >= count - 20n; i--) {
    const [gameType, , proxy] = await l1().readContract({ address: c.factory, abi: FACTORY, functionName: 'gameAtIndex', args: [i] });
    if (gameType !== type) continue;
    const l2BlockNumber = await l1().readContract({ address: proxy, abi: GAME, functionName: 'l2BlockNumber' });
    return { index: i, l2BlockNumber };
  }
  throw new Error('no recent dispute game of the accepted type');
}

export interface L1Call { to: Address; data: Hex }

/** OP stack: the prove transaction, against the newest state on Ethereum that covers the withdrawal */
export async function proveCall(w: Withdrawal): Promise<L1Call> {
  const c = CLAIM_CONTRACTS[w.chainId]!;
  const { tx, block } = w.op!;
  const withdrawal = { ...tx, withdrawalHash: w.op!.hash };
  const l2 = client(w.chainId);
  if (c.kind === 'op-games') {
    const game = await latestGame(c);
    if (game.l2BlockNumber < block) throw new Error('not provable yet');
    const args = await buildProveWithdrawal(l2 as never, { withdrawal, game } as never);
    return { to: c.portal, data: encodeFunctionData({ abi: PORTAL2, functionName: 'proveWithdrawalTransaction', args: [tx, game.index, args.outputRootProof, [...args.withdrawalProof]] }) };
  }
  if (c.kind === 'op-oracle') {
    const outputIndex = await l1().readContract({ address: c.oracle, abi: ORACLE, functionName: 'getL2OutputIndexAfter', args: [block] });
    const out = await l1().readContract({ address: c.oracle, abi: ORACLE, functionName: 'getL2Output', args: [outputIndex] });
    const args = await buildProveWithdrawal(l2 as never, { withdrawal, output: { outputIndex, l2BlockNumber: out.l2BlockNumber } } as never);
    return { to: c.portal, data: encodeFunctionData({ abi: PORTAL1, functionName: 'proveWithdrawalTransaction', args: [tx, outputIndex, args.outputRootProof, [...args.withdrawalProof]] }) };
  }
  throw new Error('only OP stack withdrawals are proved');
}

/** The claim transaction on Ethereum */
export async function claimCall(w: Withdrawal): Promise<L1Call> {
  const c = CLAIM_CONTRACTS[w.chainId]!;
  if (c.kind === 'op-games') {
    const submitter = await provedBy(c, w.op!.hash);
    if (!submitter) throw new Error('not proved yet');
    return { to: c.portal, data: encodeFunctionData({ abi: PORTAL2, functionName: 'finalizeWithdrawalTransactionExternalProof', args: [w.op!.tx, submitter] }) };
  }
  if (c.kind === 'op-oracle') {
    const [, , , requestId] = await l1().readContract({ address: c.portal, abi: PORTAL1, functionName: 'provenWithdrawals', args: [w.op!.hash] });
    let hintId = 0n;
    if (requestId !== 0n) {
      const last = await l1().readContract({ address: c.yieldManager, abi: YIELD, functionName: 'getLastCheckpointId' });
      hintId = await l1().readContract({ address: c.yieldManager, abi: YIELD, functionName: 'findCheckpointHint', args: [requestId, 1n, last] });
    }
    return { to: c.portal, data: encodeFunctionData({ abi: PORTAL1, functionName: 'finalizeWithdrawalTransaction', args: [hintId, w.op!.tx] }) };
  }
  if (c.kind === 'arb') {
    const a = w.arb!;
    const { sendCount, sendRoot } = await confirmedArb(w.chainId, c);
    if (sendCount <= a.position) throw new Error('not confirmed on Ethereum yet');
    const [, root, proof] = await client(w.chainId).readContract({
      address: NODE_INTERFACE, abi: parseAbi(['function constructOutboxProof(uint64 size, uint64 leaf) view returns (bytes32 send, bytes32 root, bytes32[] proof)']),
      functionName: 'constructOutboxProof', args: [sendCount, a.position],
    });
    if (root.toLowerCase() !== sendRoot.toLowerCase()) throw new Error('the chain\'s proof does not match the root on Ethereum');
    return { to: c.outbox, data: encodeFunctionData({ abi: OUTBOX, functionName: 'executeTransaction', args: [proof, a.position, a.caller, a.destination, a.arbBlockNum, a.ethBlockNum, a.timestamp, a.callvalue, a.data] }) };
  }
  const z = w.zk!;
  if (z.batch === null) throw new Error('not in a batch yet');
  const proof = await zkProof(w);
  return {
    to: c.nullifier,
    data: encodeFunctionData({ abi: NULLIFIER, functionName: 'finalizeDeposit', args: [{
      chainId: BigInt(w.chainId), l2BatchNumber: z.batch, l2MessageIndex: BigInt(proof.id), l2Sender: z.sender,
      l2TxNumberInBatch: z.txIndex, message: z.message, merkleProof: proof.proof,
    }] }),
  };
}

// ---- Arbitrum stack ----

const NODE_INTERFACE: Address = '0x00000000000000000000000000000000000000C8';
const GLOBAL = 'struct GlobalState { bytes32[2] bytes32Vals; uint64[2] u64Vals; }';
const BOLD = parseAbi([
  'struct AssertionNode { uint64 firstChildBlock; uint64 secondChildBlock; uint64 createdAtBlock; bool isFirstChild; uint8 status; bytes32 configHash; }',
  'function getAssertion(bytes32) view returns (AssertionNode)',
]);
const BOLD_EVENT = parseAbi([GLOBAL, 'struct AssertionState { GlobalState globalState; uint8 machineStatus; bytes32 endHistoryRoot; }', 'struct ConfigData { bytes32 wasmModuleRoot; uint256 requiredStake; address challengeManager; uint64 confirmPeriodBlocks; uint64 nextInboxPosition; }', 'struct BeforeStateData { bytes32 prevPrevAssertionHash; bytes32 sequencerBatchAcc; ConfigData configData; }', 'struct AssertionInputs { BeforeStateData beforeStateData; AssertionState beforeState; AssertionState afterState; }', 'event AssertionCreated(bytes32 indexed assertionHash, bytes32 indexed parentAssertionHash, AssertionInputs assertion, bytes32 afterInboxBatchAcc, uint256 inboxMaxCount, bytes32 wasmModuleRoot, uint256 requiredStake, address challengeManager, uint64 confirmPeriodBlocks)']);
const LEGACY = parseAbi([
  'struct Node { bytes32 stateHash; bytes32 challengeHash; bytes32 confirmData; uint64 prevNum; uint64 deadlineBlock; uint64 noChildConfirmedBeforeBlock; uint64 stakerCount; uint64 childStakerCount; uint64 firstChildBlock; uint64 latestChildNumber; uint64 createdAtBlock; bytes32 nodeHash; }',
  'function getNode(uint64) view returns (Node)',
]);
const LEGACY_EVENT = parseAbi([GLOBAL, 'struct ExecutionState { GlobalState globalState; uint8 machineStatus; }', 'struct Assertion { ExecutionState beforeState; ExecutionState afterState; uint64 numBlocks; }', 'event NodeCreated(uint64 indexed nodeNum, bytes32 indexed parentNodeHash, bytes32 indexed nodeHash, bytes32 executionHash, Assertion assertion, bytes32 afterInboxBatchAcc, bytes32 wasmModuleRoot, uint256 inboxMaxCount)']);

/** The rollup's latest confirmed state on Ethereum: its send root (held by the Outbox) and how many withdrawals it covers */
async function confirmedArb(chainId: number, c: Arb): Promise<{ sendRoot: Hex; sendCount: bigint }> {
  const raw = await l1().call({ to: c.rollup, data: '0x65f7f80d' }); // latestConfirmed()
  const value = BigInt(raw.data ?? '0x0');
  let after: { blockHash: Hex; sendRoot: Hex } | undefined;
  if (value > 2n ** 64n) {
    // BoLD: an assertion hash; its AssertionCreated event holds the state after it
    const hash = raw.data as Hex;
    const node = await l1().readContract({ address: c.rollup, abi: BOLD, functionName: 'getAssertion', args: [hash] });
    const logs = await l1().getLogs({ address: c.rollup, fromBlock: node.createdAtBlock, toBlock: node.createdAtBlock });
    for (const log of logs) {
      try {
        const d = decodeEventLog({ abi: BOLD_EVENT, data: log.data, topics: log.topics });
        if (d.eventName === 'AssertionCreated' && d.args.assertionHash === hash) {
          const [blockHash, sendRoot] = d.args.assertion.afterState.globalState.bytes32Vals;
          after = { blockHash, sendRoot };
        }
      } catch { /* another event */ }
    }
  } else {
    const node = await l1().readContract({ address: c.rollup, abi: LEGACY, functionName: 'getNode', args: [value] });
    const logs = await l1().getLogs({ address: c.rollup, fromBlock: node.createdAtBlock, toBlock: node.createdAtBlock });
    for (const log of logs) {
      try {
        const d = decodeEventLog({ abi: LEGACY_EVENT, data: log.data, topics: log.topics });
        if (d.eventName === 'NodeCreated' && d.args.nodeNum === value) {
          const [blockHash, sendRoot] = d.args.assertion.afterState.globalState.bytes32Vals;
          after = { blockHash, sendRoot };
        }
      } catch { /* another event */ }
    }
  }
  if (!after) throw new Error('the rollup\'s confirmed state was not found');
  const held = await l1().readContract({ address: c.outbox, abi: OUTBOX, functionName: 'roots', args: [after.sendRoot] });
  if (held.toLowerCase() !== after.blockHash.toLowerCase()) throw new Error('the Outbox does not hold the confirmed root');
  const block = await client(chainId).request({ method: 'eth_getBlockByHash' as never, params: [after.blockHash, false] as never }) as { sendCount: Hex } | null;
  if (!block) throw new Error('the chain did not return its confirmed block');
  return { sendRoot: after.sendRoot, sendCount: BigInt(block.sendCount) };
}

// ---- ZK Stack ----

async function zkRpc<T>(chainId: number, method: string, params: unknown[]): Promise<T> {
  return client(chainId).request({ method: method as never, params: params as never }) as Promise<T>;
}

async function zkProof(w: Withdrawal): Promise<{ id: number; proof: Hex[] }> {
  const proof = await zkRpc<{ id: number; proof: Hex[] } | null>(w.chainId, 'zks_getL2ToL1LogProof', [w.txHash, w.zk!.logIndex]);
  if (!proof) throw new Error('no proof from the chain yet');
  return proof;
}

/** A withdrawal by its transaction hash alone: looked up on every chain with an own bridge here */
export async function findWithdrawal(txHash: Hex): Promise<Withdrawal | null> {
  const found = await Promise.all(Object.keys(CLAIM_CONTRACTS).map((id) => readWithdrawal(Number(id), txHash).catch(() => null)));
  return found.find((w) => w !== null) ?? null;
}
