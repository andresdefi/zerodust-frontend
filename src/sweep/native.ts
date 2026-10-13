// A chain's own bridge to its parent chain, Ethereum (BNB Chain for opBNB): "Native bridges only".
// Offered only for a chain no other route takes out (owner, 2026-10-12). The funds leave the chain at
// once but arrive only after the recipient proves (OP stack) and claims the withdrawal on the parent,
// days later; ZeroDust does not claim for them yet. The page pins these chains itself: the API's word
// decides nothing here.

export type NativeStack = 'op' | 'arb' | 'zk' | 'taiko' | 'agglayer';

export interface NativeExit {
  stack: NativeStack;
  chainName: string;
  explorerUrl: string;
  /** Where the withdrawal is claimed: Ethereum, or BNB Chain (opBNB) */
  toChainId: ParentId;
  /** The chain's own bridge site, where the withdrawal is proved and claimed */
  bridgeUrl: string;
  bridgeName: string;
  /** Hours from the withdrawal until it can be claimed (OP: the prove's wait included) */
  claimAfterHours: number;
  /** OP stack: a prove transaction on Ethereum first, once the chain has posted its state */
  prove: boolean;
  /** The bridge's relayer delivers it on Ethereum for a fee paid in the sweep: nothing to claim (Taiko) */
  relayed?: boolean;
  /** What arrives when it is not ETH: the chain's gas token as an ERC-20 on Ethereum */
  token?: { symbol: string; name: string; address: string; decimals: number };
}

const ETHEREUM = 1 as const;
const BNB_CHAIN = 56 as const;
export type ParentId = typeof ETHEREUM | typeof BNB_CHAIN;

/** The chains own bridges settle on: where the prove and claim are sent, and paid */
export interface Parent { chainId: ParentId; name: string; symbol: string; explorer: string }
export const PARENTS: Readonly<Record<ParentId, Parent>> = {
  1: { chainId: 1, name: 'Ethereum', symbol: 'ETH', explorer: 'https://etherscan.io' },
  56: { chainId: 56, name: 'BNB Chain', symbol: 'BNB', explorer: 'https://bscscan.com' },
};
export const parentOf = (exit: NativeExit): Parent => PARENTS[exit.toChainId];

export const NATIVE_EXITS: Readonly<Record<number, NativeExit>> = {
  // Lisk: dispute games about every 6 h, then 7 days after the prove
  1135: { chainName: 'Lisk', explorerUrl: 'https://blockscout.lisk.com', stack: 'op', toChainId: ETHEREUM, bridgeUrl: 'https://bridge.lisk.com', bridgeName: 'Lisk Bridge', claimAfterHours: 7 * 24 + 6, prove: true },
  // Arbitrum Nova: the assertion that holds the withdrawal is confirmed about 6.4 days later
  42170: { chainName: 'Arbitrum Nova', explorerUrl: 'https://nova.arbiscan.io', stack: 'arb', toChainId: ETHEREUM, bridgeUrl: 'https://bridge.arbitrum.io', bridgeName: 'Arbitrum Bridge', claimAfterHours: 156, prove: false },
  // Blast: its L2OutputOracle posts state hourly; claimable 1 day after the prove
  81457: { chainName: 'Blast', explorerUrl: 'https://blastscan.io', stack: 'op', toChainId: ETHEREUM, bridgeUrl: 'https://blast.io/en/bridge', bridgeName: 'Blast Bridge', claimAfterHours: 26, prove: true },
  // Abstract (ZK Stack): claimable once its batch is executed on Ethereum, hours later
  2741: { chainName: 'Abstract', explorerUrl: 'https://abscan.org', stack: 'zk', toChainId: ETHEREUM, bridgeUrl: 'https://native-bridge.abs.xyz/bridge/', bridgeName: 'Abstract Native Bridge', claimAfterHours: 24, prove: false },
  // Fraxtal: L2OutputOracle outputs hourly, claimable 7 days after the prove; FRAX is paid out as FXS (an ERC-20)
  252: {
    chainName: 'Fraxtal', explorerUrl: 'https://fraxscan.com', stack: 'op', toChainId: ETHEREUM, bridgeUrl: 'https://docs.frax.com/fraxtal/tools/bridges', bridgeName: 'Fraxtal\'s bridges', claimAfterHours: 7 * 24 + 1, prove: true,
    token: { symbol: 'FXS', name: 'Frax Share', address: '0x3432B6A60D23Ca0dFCa7761B7ab56459D9C964D0', decimals: 18 },
  },
  // Taiko: its relayer processes the message on Ethereum for the fee the sweep pays (measured 24-53 min)
  167000: { chainName: 'Taiko', explorerUrl: 'https://taikoscan.io', stack: 'taiko', toChainId: ETHEREUM, bridgeUrl: 'https://bridge.taiko.xyz', bridgeName: 'Taiko Bridge', claimAfterHours: 1, prove: false, relayed: true },
  // opBNB: its own bridge to BNB Chain while Meson (its fast route) is paused; outputs every 3,600
  // blocks (about 15 min), claimable 7 days after the prove; BNB arrives as native BNB
  204: { chainName: 'opBNB', explorerUrl: 'https://opbnb.bscscan.com', stack: 'op', toChainId: BNB_CHAIN, bridgeUrl: 'https://opbnb-bridge.bnbchain.org', bridgeName: 'opBNB Bridge', claimAfterHours: 7 * 24 + 1, prove: true },
  // X Layer: the AggLayer bridge; its exit root reaches Ethereum about every 15 min, then OKB is claimed
  // there as the OKB ERC-20 (the claim's proofs are built on this page, sweep/agglayer.ts)
  196: {
    chainName: 'X Layer', explorerUrl: 'https://www.okx.com/web3/explorer/xlayer', stack: 'agglayer', toChainId: ETHEREUM, bridgeUrl: 'https://web3.okx.com/xlayer/bridge', bridgeName: 'X Layer Bridge', claimAfterHours: 1, prove: false,
    token: { symbol: 'OKB', name: 'OKB', address: '0x75231F58b43240C9718Dd58B4967c5114342a86c', decimals: 18 },
  },
  // Gravity (Arbitrum Orbit): G arrives as an ERC-20 on Ethereum, confirmed about 6.4 days later
  1625: {
    chainName: 'Gravity', explorerUrl: 'https://explorer.gravity.xyz', stack: 'arb', toChainId: ETHEREUM, bridgeUrl: 'https://bridge.gravity.xyz', bridgeName: 'Gravity Bridge', claimAfterHours: 156, prove: false,
    token: { symbol: 'G', name: 'Gravity', address: '0x9C7BEBa8F6eF6643aBd725e45a4E8387eF260649', decimals: 18 },
  },
};

export const nativeExitOf = (chainId: number): NativeExit | undefined => NATIVE_EXITS[chainId];

/** Gas on the parent chain for the user's own steps (measured: proves 315k-463k, OP claims 244k, a ZK finalize 175k, a Nova claim 113k) */
export const PROVE_GAS = 450_000n;
export const CLAIM_GAS: Readonly<Record<NativeStack, bigint>> = { op: 250_000n, arb: 150_000n, zk: 190_000n, taiko: 0n, agglayer: 250_000n };

/** Wei the user's own transactions on the parent chain cost at its gas price */
export function claimCostWei(exit: NativeExit, gasPrice: bigint): bigint {
  if (exit.relayed) return 0n;
  return (CLAIM_GAS[exit.stack] + (exit.prove ? PROVE_GAS : 0n)) * gasPrice;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * The latest day to start on a closing chain. Every step that reads the chain must happen while it
 * runs: an OP prove needs the chain's state, an Arbitrum claim a proof from its node (built when the
 * withdrawal is confirmed), a ZK claim a proof from its node. A day of margin on top.
 */
export function startByMs(exit: NativeExit, closesAtMs: number): number {
  const needsChainUntil = exit.stack === 'arb' ? exit.claimAfterHours * HOUR : exit.prove ? 12 * HOUR : exit.claimAfterHours * HOUR;
  return closesAtMs - needsChainUntil - DAY;
}

export function waitText(exit: NativeExit): string {
  const h = exit.claimAfterHours;
  if (h < 12) return h <= 1 ? 'about an hour' : `about ${h} hours`;
  return h < 48 ? `about ${h < 30 ? 'a day' : `${Math.round(h / 24)} days`}` : `about ${Math.round((h / 24) * 2) / 2} days`;
}

/** What happens after the sweep, step by step, before anything is signed */
export function nativeSteps(exit: NativeExit, chainName: string, recipient: string): string[] {
  const p = parentOf(exit);
  const arrives = exit.token ? `${exit.token.symbol} (${exit.token.name}), a token on ${p.name}, not ${p.symbol}` : `${p.symbol} on ${p.name}`;
  if (exit.relayed) {
    return [
      `The sweep sends everything into ${chainName}'s own bridge, with a fee for its relayer taken from the balance. The wallet on ${chainName} ends at exactly 0.`,
      `${chainName}'s relayer delivers it as ${arrives} in ${waitText(exit)}, at ${recipient}, with the part of its fee it did not use. Nothing to claim.`,
      `If it has not arrived after a few hours, claim it on ${exit.bridgeName} (${exit.bridgeUrl}) with the wallet at ${recipient}.`,
    ];
  }
  const steps = [`The sweep sends everything into ${chainName}'s own bridge. The wallet on ${chainName} ends at exactly 0.`];
  if (exit.prove) {
    steps.push(`Within a few hours, prove the withdrawal on ${p.name} (one transaction, paid in ${p.symbol} there).`);
    steps.push(`Wait ${waitText(exit)} in total, then claim it on ${p.name} (a second transaction).`);
  } else {
    steps.push(`Wait ${waitText(exit)}, then claim it on ${p.name} (one transaction, paid in ${p.symbol} there).`);
  }
  steps.push(`It arrives as ${arrives}, at ${recipient}. Nothing arrives until it is claimed; ZeroDust does not claim for you.`);
  steps.push(`${exit.prove ? 'Prove and claim' : 'Claim'} on this page (under "Waiting to be claimed") or on ${exit.bridgeName} (${exit.bridgeUrl}): any wallet with ${p.symbol} on ${p.name} may send ${exit.prove ? 'them' : 'it'}, the funds always go to the address above.`);
  return steps;
}

// ---- Withdrawals waiting to be claimed, kept in this browser only ----

export interface PendingClaim {
  chainId: number;
  chainName: string;
  /** The chain's explorer, for the withdrawal's link (a swept chain leaves the page's list) */
  explorerUrl: string;
  /** What was sent, in the chain's gas token (what arrives: ETH, or exit.token) */
  symbol: string;
  decimals: number;
  /** The swept wallet (the page lists the claims of the address it shows) */
  from: string;
  recipient: string;
  /** Wei (or the token's units) sent into the bridge */
  amount: string;
  txHash: string;
  sentAt: number;
}

const STORE = 'zd.pending-claims.v1';

function load(): PendingClaim[] {
  try {
    const raw = localStorage.getItem(STORE);
    const list = raw ? (JSON.parse(raw) as PendingClaim[]) : [];
    return Array.isArray(list) ? list.filter((c) => typeof c?.txHash === 'string' && NATIVE_EXITS[c.chainId]) : [];
  } catch {
    return [];
  }
}

function save(list: PendingClaim[]): void {
  try {
    localStorage.setItem(STORE, JSON.stringify(list));
  } catch {
    // Private mode or storage off: the sweep result still shows the transaction to keep
  }
}

export function pendingClaimsOf(address: string): PendingClaim[] {
  return load().filter((c) => c.from.toLowerCase() === address.toLowerCase()).sort((a, b) => b.sentAt - a.sentAt);
}

export function addPendingClaim(claim: PendingClaim): void {
  const list = load().filter((c) => c.txHash.toLowerCase() !== claim.txHash.toLowerCase());
  save([...list, claim]);
}

export function removePendingClaim(txHash: string): void {
  save(load().filter((c) => c.txHash.toLowerCase() !== txHash.toLowerCase()));
}

/** When the claim opens, by the chain's usual wait (an estimate: the bridge site has the exact state) */
export const claimableFrom = (c: PendingClaim): number => c.sentAt + NATIVE_EXITS[c.chainId]!.claimAfterHours * HOUR;
