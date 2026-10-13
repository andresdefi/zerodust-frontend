// X Layer's own bridge, the AggLayer unified bridge (sweep/native.ts): its withdrawals are claimed on
// Ethereum with claimAsset and two Merkle proofs, built here from public data only (research
// 2026-10-13; OKX's own proof API is private):
// - the local proof, of the withdrawal's leaf in X Layer's exit tree: the tree's frontier is in the
//   bridge's storage (_branch, slots 51-82), read at the block before the withdrawal on X Layer's
//   archive RPC; the leaves after it (about 3 a day) are found by a binary search on depositCount's
//   history (slot 83), since its RPC caps logs at 100 blocks;
// - the rollup proof, of X Layer's exit root among every rollup's on Ethereum (RollupManager).
// Ethereum checks both on claim; a wrong proof only fails there, the funds always go to the leaf's
// recipient.
import { encodeFunctionData, encodePacked, keccak256, parseAbi, parseEventLogs, type Address, type Hex, type PublicClient, type TransactionReceipt } from 'viem';

export interface AggContracts {
  kind: 'agglayer';
  /** The unified bridge, the same address on X Layer and Ethereum */
  bridge: Address;
  rollupManager: Address;
  /** Ethereum's global exit root manager */
  germ: Address;
  /** X Layer's rollup id (its network id too) */
  rollupId: number;
  /** The gas token on Ethereum: what a withdrawal of the chain's gas pays out (OKB) */
  gasToken: Address;
}

/** What a withdrawal needs to be proved and claimed */
export interface AggWithdrawal {
  depositCount: number;
  block: bigint;
  leaf: Hex;
  originNetwork: number;
  originAddress: Address;
  amount: bigint;
  metadata: Hex;
}

const BRANCH_SLOT = 51n;
const COUNT_SLOT = 83n;
const DEPTH = 32;
const EVENT = parseAbi(['event BridgeEvent(uint8 leafType, uint32 originNetwork, address originAddress, uint32 destinationNetwork, address destinationAddress, uint256 amount, bytes metadata, uint32 depositCount)']);
export const AGG_L1 = parseAbi([
  'function isClaimed(uint32 leafIndex, uint32 sourceBridgeNetwork) view returns (bool)',
  'function claimAsset(bytes32[32] smtProofLocalExitRoot, bytes32[32] smtProofRollupExitRoot, uint256 globalIndex, bytes32 mainnetExitRoot, bytes32 rollupExitRoot, uint32 originNetwork, address originTokenAddress, uint32 destinationNetwork, address destinationAddress, uint256 amount, bytes metadata)',
]);
const RM = parseAbi([
  'function rollupCount() view returns (uint32)',
  'function getRollupExitRoot() view returns (bytes32)',
  'function rollupIDToRollupData(uint32) view returns (address rollupContract, uint64 chainID, address verifier, uint64 forkID, bytes32 lastLocalExitRoot, uint64 lastBatchSequenced, uint64 lastVerifiedBatch, uint64 lastPendingState, uint64 lastPendingStateConsolidated, uint64 lastVerifiedBatchBeforeUpgrade, uint64 rollupTypeID, uint8 rollupCompatibilityID)',
]);
const GERM = parseAbi(['function lastMainnetExitRoot() view returns (bytes32)', 'function globalExitRootMap(bytes32) view returns (uint256)']);

const ZERO: Hex[] = [`0x${'00'.repeat(32)}`];
for (let h = 1; h < DEPTH; h++) ZERO.push(hash2(ZERO[h - 1]!, ZERO[h - 1]!));
function hash2(a: Hex, b: Hex): Hex { return keccak256(encodePacked(['bytes32', 'bytes32'], [a, b])); }

const leafHash = (a: { leafType: number; originNetwork: number; originAddress: Address; destinationNetwork: number; destinationAddress: Address; amount: bigint; metadata: Hex }) =>
  keccak256(encodePacked(['uint8', 'uint32', 'address', 'uint32', 'address', 'uint256', 'bytes32'],
    [a.leafType, a.originNetwork, a.originAddress, a.destinationNetwork, a.destinationAddress, a.amount, keccak256(a.metadata)]));

/**
 * The one withdrawal of the gas token to Ethereum in a receipt, from the bridge's own event; null
 * for anything else (another token, another network, more than one).
 */
export function aggWithdrawalOf(c: AggContracts, receipt: TransactionReceipt): (AggWithdrawal & { recipient: Address }) | null {
  const events = parseEventLogs({ abi: EVENT, logs: receipt.logs.filter((l) => l.address.toLowerCase() === c.bridge.toLowerCase()) });
  if (events.length !== 1) return null;
  const a = events[0]!.args;
  if (a.leafType !== 0 || a.destinationNetwork !== 0 || a.originNetwork !== 0 || a.originAddress.toLowerCase() !== c.gasToken.toLowerCase()) return null;
  return {
    recipient: a.destinationAddress, depositCount: a.depositCount, block: receipt.blockNumber, leaf: leafHash(a),
    originNetwork: a.originNetwork, originAddress: a.originAddress, amount: a.amount, metadata: a.metadata,
  };
}

const storageAt = async (l2: PublicClient, c: AggContracts, slot: bigint, blockNumber: bigint): Promise<Hex> =>
  (await l2.getStorageAt({ address: c.bridge, slot: `0x${slot.toString(16)}`, blockNumber })) ?? ZERO[0]!;
const countAt = async (l2: PublicClient, c: AggContracts, blockNumber: bigint) => Number(BigInt(await storageAt(l2, c, COUNT_SLOT, blockNumber)));

/**
 * The leaves of deposits [first, last), from their blocks: one search over the block range that
 * splits only where depositCount changes (deposits are rare, so most halves are skipped), a few
 * requests at a time (X Layer's RPC rate-limits), then each block's logs.
 */
async function leavesBetween(l2: PublicClient, c: AggContracts, first: number, last: number, from: bigint, to: bigint): Promise<Hex[]> {
  if (last <= first) return [];
  const blocks: bigint[] = [];
  // Ranges (lo, hi] where depositCount goes from cLo to cHi: deposits happened in it
  const queue: Array<{ lo: bigint; hi: bigint; cLo: number; cHi: number }> = [{ lo: from - 1n, hi: to, cLo: await countAt(l2, c, from - 1n), cHi: await countAt(l2, c, to) }];
  while (queue.length > 0) {
    const batch = queue.splice(0, 3);
    await Promise.all(batch.map(async (r) => {
      // Only what touches [first, last) matters
      if (r.cHi <= first || r.cLo >= last || r.cHi === r.cLo) return;
      if (r.hi - r.lo === 1n) { blocks.push(r.hi); return; }
      const mid = (r.lo + r.hi) / 2n;
      const cMid = await countAt(l2, c, mid);
      queue.push({ lo: r.lo, hi: mid, cLo: r.cLo, cHi: cMid }, { lo: mid, hi: r.hi, cLo: cMid, cHi: r.cHi });
    }));
  }
  const byIndex = new Map<number, Hex>();
  for (const block of blocks.sort((a, b) => (a < b ? -1 : 1))) {
    const logs = await l2.getLogs({ address: c.bridge, fromBlock: block, toBlock: block });
    for (const e of parseEventLogs({ abi: EVENT, logs })) byIndex.set(e.args.depositCount, leafHash(e.args));
  }
  return Array.from({ length: last - first }, (_, i) => {
    const leaf = byIndex.get(first + i);
    if (!leaf) throw new Error(`X Layer deposit ${first + i} was not found`);
    return leaf;
  });
}

export interface AggProof {
  local: Hex[];
  rollup: Hex[];
  mainnetExitRoot: Hex;
  rollupExitRoot: Hex;
}

/**
 * The claim's proofs against Ethereum's current roots, or null while X Layer's exit root there does
 * not cover the withdrawal yet.
 */
export async function aggProof(l2: PublicClient, l1: PublicClient, c: AggContracts, w: AggWithdrawal): Promise<AggProof | null> {
  // Ethereum: every rollup's exit root (X Layer's among them) and the matching global roots
  const rollupCount = await l1.readContract({ address: c.rollupManager, abi: RM, functionName: 'rollupCount' });
  const [lers, rollupExitRoot, mainnetExitRoot] = await Promise.all([
    Promise.all(Array.from({ length: rollupCount }, (_, i) => l1.readContract({ address: c.rollupManager, abi: RM, functionName: 'rollupIDToRollupData', args: [i + 1] }).then((d) => d[4]))),
    l1.readContract({ address: c.rollupManager, abi: RM, functionName: 'getRollupExitRoot' }),
    l1.readContract({ address: c.germ, abi: GERM, functionName: 'lastMainnetExitRoot' }),
  ]);
  const ler = lers[c.rollupId - 1]!;

  // X Layer: the frontier before the withdrawal, then leaves until the tree's root is that exit root
  const head = await l2.getBlockNumber();
  const before = w.block - 1n;
  const [startBranch, startCount, nowCount] = await Promise.all([
    Promise.all(Array.from({ length: DEPTH }, (_, h) => storageAt(l2, c, BRANCH_SLOT + BigInt(h), before))),
    countAt(l2, c, before),
    countAt(l2, c, head),
  ]);
  // Deposits earlier in the withdrawal's own block come first, then every one after it
  const earlier = await leavesBetween(l2, c, startCount, w.depositCount, w.block, w.block);
  const later = await leavesBetween(l2, c, w.depositCount + 1, nowCount, w.block, head);
  const branch = [...startBranch];
  let count = startCount;
  const add = (leaf: Hex) => {
    let node = leaf;
    count += 1;
    for (let h = 0; h < DEPTH; h++) {
      if (((count >> h) & 1) === 1) { branch[h] = node; return; }
      node = hash2(branch[h]!, node);
    }
  };
  earlier.forEach(add);
  const frontier = [...branch];
  const leaves = [w.leaf];
  add(w.leaf);
  let covered = rootOf(branch, count) === ler;
  for (const leaf of later) {
    if (covered) break;
    leaves.push(leaf);
    add(leaf);
    covered = rootOf(branch, count) === ler;
  }
  if (!covered) return null;

  const local = localProof(frontier, leaves, w.depositCount);
  const rollup = listProof(lers, c.rollupId - 1);
  // The pair must be a global exit root Ethereum knows (a newer update between the reads: try again)
  const ger = hash2(mainnetExitRoot, rollupExitRoot);
  if ((await l1.readContract({ address: c.germ, abi: GERM, functionName: 'globalExitRootMap', args: [ger] })) === 0n) throw new Error('Ethereum\'s exit roots moved; try again');
  if (listRoot(lers) !== rollupExitRoot) throw new Error('the rollups\' exit roots on Ethereum do not add up; try again');
  return { local, rollup, mainnetExitRoot, rollupExitRoot };
}

export function rootOf(branch: Hex[], count: number): Hex {
  let node = ZERO[0]!;
  for (let h = 0; h < DEPTH; h++) node = ((count >> h) & 1) === 1 ? hash2(branch[h]!, node) : hash2(node, ZERO[h]!);
  return node;
}

/** Leaf `index`'s proof: left siblings are the frontier before it, right ones built from the leaves after it */
export function localProof(frontier: Hex[], leaves: Hex[], index: number): Hex[] {
  const proof: Hex[] = [];
  let level = leaves;
  let pos = index;
  for (let h = 0; h < DEPTH; h++) {
    if ((pos & 1) === 1) {
      proof.push(frontier[h]!);
    } else {
      proof.push(level[1] ?? ZERO[h]!);
    }
    // The next level, starting at our node's parent: our pair first, then the later nodes in pairs
    const next: Hex[] = [];
    const left = (pos & 1) === 1;
    const start = left ? -1 : 0;
    for (let j = start; j < level.length; j += 2) {
      const a = j < 0 ? frontier[h]! : level[j]!;
      const b = j + 1 < level.length ? level[j + 1]! : ZERO[h]!;
      next.push(hash2(a, b));
    }
    level = next;
    pos >>= 1;
  }
  return proof;
}

/** A full list's root and proofs (the rollup exit tree: one leaf per rollup) */
export function listRoot(items: Hex[]): Hex {
  let level = items;
  for (let h = 0; h < DEPTH; h++) {
    const next: Hex[] = [];
    for (let j = 0; j < level.length; j += 2) next.push(hash2(level[j]!, j + 1 < level.length ? level[j + 1]! : ZERO[h]!));
    level = next.length ? next : [ZERO[h + 1] ?? hash2(ZERO[h]!, ZERO[h]!)];
  }
  return level[0]!;
}
export function listProof(items: Hex[], index: number): Hex[] {
  const proof: Hex[] = [];
  let level = items;
  let p = index;
  for (let h = 0; h < DEPTH; h++) {
    const sib = p ^ 1;
    proof.push(sib < level.length ? level[sib]! : ZERO[h]!);
    const next: Hex[] = [];
    for (let j = 0; j < level.length; j += 2) next.push(hash2(level[j]!, j + 1 < level.length ? level[j + 1]! : ZERO[h]!));
    level = next;
    p >>= 1;
  }
  return proof;
}

/** The claim: globalIndex = rollup index << 32 | deposit count (not mainnet) */
export function aggClaimData(c: AggContracts, w: AggWithdrawal & { recipient: Address }, p: AggProof): Hex {
  const globalIndex = (BigInt(c.rollupId - 1) << 32n) | BigInt(w.depositCount);
  return encodeFunctionData({
    abi: AGG_L1, functionName: 'claimAsset',
    args: [p.local as never, p.rollup as never, globalIndex, p.mainnetExitRoot, p.rollupExitRoot, w.originNetwork, w.originAddress, 0, w.recipient, w.amount, w.metadata],
  });
}
