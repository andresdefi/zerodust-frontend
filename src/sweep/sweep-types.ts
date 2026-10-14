/**
 * @fileoverview What the sweep flow works with: chains (rows) and their per-row state, the
 * choices for a chain no route takes to the destination, destinations, stages, the wallet
 */

import type { LocalAccount } from 'viem';
import { deliveredToken } from '@zerodust/sdk';
import { tokenExitFor } from '../direct/plan';
import type { MetaMaskSession } from './metamask';
import type { SweepReport } from './report';

/**
 * What to do with a chain no route takes to the destination. Direct chains
 * with a swap route can also swap out; the few cents of gas reserve the swap
 * leaves are then donated or burned, so the wallet still ends at exactly 0.
 */
/** 'native': the chain's own bridge to its parent (Ethereum; BNB Chain for opBNB), for a chain no other route takes out (sweep/native.ts) */
export type Choice = 'exit-donate' | 'exit-burn' | 'donate' | 'burn' | 'elsewhere' | 'address' | 'native';
export const isExit = (c?: Choice) => c === 'exit-donate' || c === 'exit-burn';
/** The balance reaches the recipient (on the chosen chain, or on another one for 'elsewhere') */
export const isRouted = (c?: Choice) => !c || isExit(c) || c === 'elsewhere' || c === 'address' || c === 'native';

export interface Row {
  chainId: number;
  name: string;
  token: string;
  decimals: number;
  balance: bigint;
  canSweep: boolean;
  explorerUrl: string;
  /** No 7702 in ZeroDust: the wallet sweeps itself with exact legacy transactions */
  direct?: boolean;
  /** Why this wallet cannot sweep the chain at all (MetaMask: no permission there); shown instead of "too small" */
  unavailable?: string;
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
  /** Cross-chain: the transaction that delivered on the destination, once the bridge reports it */
  arrivalTx?: string;
  /** A transaction left this wallet (or the relayer took the sweep): a failure then needs checking */
  sent?: boolean;
  /** What was reported to the API (POST /reports), for "Copy details" */
  report?: SweepReport;
  /** The API's reference for that report (ZD-1A2B3C4D); absent if it could not be recorded */
  reference?: string;
  choice?: Choice;
  /** Direct chains: ZeroDust's fee in the chain's token, paid as its own transfer */
  fee?: bigint;
  /** Where `receive` arrives: the destination, or another chain for 'elsewhere' */
  toChainId?: number;
  /**
   * Token delivery (a Hyperlane warp route, e.g. Mitosis): `receive` is this
   * token on the destination, not its gas
   */
  token?: { symbol: string; decimals: number };
  /** A fixed fee the bridge keeps whatever the amount (Meson), in the chain's token; already out of receive */
  bridgeFee?: bigint;
}

/** The token a row delivers instead of gas on `toChainId`, if any (owner decision 2026-10-03) */
export function rowToken(sourceChainId: number, toChainId: number): RowState['token'] {
  const t = deliveredToken(sourceChainId, toChainId) ?? tokenExitFor(sourceChainId, toChainId)?.token;
  return t ? { symbol: t.symbol, decimals: t.decimals } : undefined;
}

/** What arrives on one chain, in one asset (its gas, or a delivered token) */
export interface DestTotal {
  dest: DestOption;
  amount: bigint;
  symbol: string;
  decimals: number;
  /** A token, not the chain's gas */
  isToken: boolean;
}

export type Stage = 'loading' | 'error' | 'empty' | 'select' | 'checked' | 'sweeping' | 'done';

/**
 * The wallet being swept: a key held in this tab (the SDK signs everything), or a MetaMask
 * account that grants a permission per chain (metamask.ts; the key stays in MetaMask)
 */
export type Wallet = { kind: 'key'; account: LocalAccount } | { kind: 'metamask'; session: MetaMaskSession };

/** Shown on a chain MetaMask cannot sweep: the plain way out is the key */
export const NEEDS_KEY = 'MetaMask cannot sweep this chain yet. Load the wallet with its key instead.';
