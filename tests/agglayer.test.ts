import { encodeAbiParameters, encodeEventTopics, encodePacked, keccak256, parseAbi, type Hex, type TransactionReceipt } from 'viem';
import { describe, expect, it } from 'vitest';
import { aggClaimData, aggWithdrawalOf, listProof, listRoot, localProof, rootOf, type AggContracts } from '../src/sweep/agglayer';

// X Layer's AggLayer exit (sweep/agglayer.ts): the deposit tree's frontier, roots and proofs against
// a reference verification (the bridge's verifyMerkleProof), and which receipts count as withdrawals.
// Proofs built by this code from real data were accepted by Ethereum's bridge (2026-10-13: deposits
// 10195 with 15 later leaves, and 10209).

const hash2 = (a: Hex, b: Hex) => keccak256(encodePacked(['bytes32', 'bytes32'], [a, b]));
const ZERO: Hex[] = [`0x${'00'.repeat(32)}`];
for (let h = 1; h < 32; h++) ZERO.push(hash2(ZERO[h - 1]!, ZERO[h - 1]!));

/** The bridge's verifyMerkleProof */
function verify(leaf: Hex, proof: Hex[], index: number, root: Hex): boolean {
  let node = leaf;
  for (let h = 0; h < 32; h++) node = ((index >> h) & 1) === 1 ? hash2(proof[h]!, node) : hash2(node, proof[h]!);
  return node === root;
}

/** The deposit contract's append, keeping its frontier */
function frontierAfter(leaves: Hex[]): Hex[] {
  const branch = [...ZERO];
  leaves.forEach((leaf, i) => {
    let node = leaf;
    const size = i + 1;
    for (let h = 0; h < 32; h++) {
      if (((size >> h) & 1) === 1) { branch[h] = node; break; }
      node = hash2(branch[h]!, node);
    }
  });
  return branch;
}

const leaves = Array.from({ length: 37 }, (_, i) => keccak256(encodePacked(['uint256'], [BigInt(i + 1)])));

describe('AggLayer deposit tree', () => {
  it('every leaf proves against the root of every later size, from the frontier before it and the leaves after it', () => {
    for (const index of [0, 1, 2, 7, 8, 15, 16, 22, 31, 36]) {
      const frontier = frontierAfter(leaves.slice(0, index));
      for (const size of [index + 1, index + 2, 37]) {
        if (size > 37) continue;
        const root = rootOf(frontierAfter(leaves.slice(0, size)), size);
        const proof = localProof(frontier, leaves.slice(index, size), index);
        expect(verify(leaves[index]!, proof, index, root), `leaf ${index} in ${size}`).toBe(true);
      }
    }
  });

  it('a wrong leaf, index or root does not verify', () => {
    const root = rootOf(frontierAfter(leaves), 37);
    const proof = localProof(frontierAfter(leaves.slice(0, 5)), leaves.slice(5), 5);
    expect(verify(leaves[6]!, proof, 5, root)).toBe(false);
    expect(verify(leaves[5]!, proof, 4, root)).toBe(false);
    expect(verify(leaves[5]!, proof, 5, rootOf(frontierAfter(leaves.slice(0, 36)), 36))).toBe(false);
  });

  it('the rollup exit tree: one leaf per rollup, proofs for each', () => {
    const lers = leaves.slice(0, 29);
    const root = listRoot(lers);
    for (const i of [0, 2, 28]) expect(verify(lers[i]!, listProof(lers, i), i, root)).toBe(true);
  });
});

describe('AggLayer withdrawals in a receipt', () => {
  const C: AggContracts = {
    kind: 'agglayer', bridge: '0x2a3DD3EB832aF982ec71669E178424b10Dca2EDe', rollupManager: '0x5132A183E9F3CB7C848b0AAC5Ae0c4f0491B7aB2',
    germ: '0x580bda1e7A0CFAe92Fa7F6c20A3794F169CE3CFb', rollupId: 3, gasToken: '0x75231F58b43240C9718Dd58B4967c5114342a86c',
  };
  const EVENT = parseAbi(['event BridgeEvent(uint8 leafType, uint32 originNetwork, address originAddress, uint32 destinationNetwork, address destinationAddress, uint256 amount, bytes metadata, uint32 depositCount)']);
  const RECIPIENT = '0x2222222222222222222222222222222222222222';
  const log = (o: Partial<{ address: string; leafType: number; originNetwork: number; originAddress: string; destinationNetwork: number }> = {}) => ({
    address: o.address ?? C.bridge, topics: encodeEventTopics({ abi: EVENT, eventName: 'BridgeEvent' }),
    data: encodeAbiParameters(EVENT[0].inputs, [o.leafType ?? 0, o.originNetwork ?? 0, (o.originAddress ?? C.gasToken) as Hex, o.destinationNetwork ?? 0, RECIPIENT, 10n ** 15n, '0x1234', 10210]),
  });
  const receipt = (logs: ReturnType<typeof log>[]) => ({ blockNumber: 73_000_000n, logs } as unknown as TransactionReceipt);

  it('the gas token to Ethereum, from the bridge itself: recipient, amount, leaf and the claim built from them', () => {
    const w = aggWithdrawalOf(C, receipt([log()]))!;
    expect(w).toMatchObject({ recipient: RECIPIENT, amount: 10n ** 15n, depositCount: 10210, block: 73_000_000n });
    const data = aggClaimData(C, w, { local: ZERO, rollup: ZERO, mainnetExitRoot: ZERO[1]!, rollupExitRoot: ZERO[2]! });
    expect(data.startsWith('0xccaa2d11')).toBe(true); // claimAsset
    // globalIndex: rollup index 2 << 32 | deposit count
    expect(data.includes(((2n << 32n) | 10210n).toString(16).padStart(64, '0'))).toBe(true);
  });

  it('nothing else counts: another contract, token, network or message, or two withdrawals', () => {
    expect(aggWithdrawalOf(C, receipt([log({ address: '0x000000000000000000000000000000000000bEEF' })]))).toBeNull();
    expect(aggWithdrawalOf(C, receipt([log({ originAddress: '0xdAC17F958D2ee523a2206206994597C13D831ec7' })]))).toBeNull();
    expect(aggWithdrawalOf(C, receipt([log({ destinationNetwork: 1 })]))).toBeNull();
    expect(aggWithdrawalOf(C, receipt([log({ leafType: 1 })]))).toBeNull();
    expect(aggWithdrawalOf(C, receipt([log(), log()]))).toBeNull();
  });
});
