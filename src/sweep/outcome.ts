/**
 * @fileoverview What a row says about its outcome: bridging progress, too-small minimums, failure
 * kinds and plain reasons, totals per destination, and whether a wallet ended where it signed
 */

import { parseUnits } from 'viem';
import { ZERODUST_CONTRACT_ADDRESS } from '@zerodust/sdk';
import { formatAmountUp } from '../lib/format';
import type { DestOption, DestTotal, Row, RowState } from './sweep-types';
import { durationText, type ExpectedTime } from './timing';

/**
 * What a row says while a bridge delivers: the wallet already reads 0, who is delivering, and for
 * how long (a Gas.zip delivery once took 4 minutes and 8 retries on its side, 2026-10-06)
 */
export function bridgingText(bridge: string, to: string, seconds: number, expected?: ExpectedTime | null): string {
  const waited = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const usual = expected
    ? `usually ${durationText(expected.seconds)}${expected.slowLately ? ', slower than usual lately' : ''}`
    : 'usually under a minute, sometimes a few';
  return `Wallet reads 0. ${bridge} is delivering to ${to} (${waited}; ${usual})`;
}

/**
 * True when every selected chain that could be swept is the destination chain and the funds would
 * go to the same wallet: a same-chain sweep to yourself moves nothing, so the page must ask for
 * another address instead of offering a sweep (owner, 2026-10-06).
 */
export function onlySelfSweep(
  rows: Array<Pick<Row, 'chainId' | 'canSweep'>>,
  selected: Set<number>,
  destination: number | null,
  toSelf: boolean
): boolean {
  if (destination === null || !toSelf) return false;
  const chosen = rows.filter((r) => r.canSweep && selected.has(r.chainId));
  return chosen.length > 0 && chosen.every((r) => r.chainId === destination);
}

/**
 * What arrives, per chain and asset: the chosen destination's gas first, then
 * the rest ('elsewhere', delivered tokens). A token never adds into gas.
 */
export function totalsByDest(states: RowState[], destination: number | null, destOf: (chainId: number) => DestOption | null): DestTotal[] {
  const sums = new Map<string, DestTotal>();
  for (const s of states) {
    if (s.receive === undefined || s.toChainId === undefined) continue;
    const dest = destOf(s.toChainId);
    if (!dest) continue;
    const symbol = s.token?.symbol ?? dest.token;
    const key = `${dest.chainId}:${symbol}`;
    const prev = sums.get(key);
    sums.set(key, prev
      ? { ...prev, amount: prev.amount + s.receive }
      : { dest, amount: s.receive, symbol, decimals: s.token?.decimals ?? dest.decimals, isToken: !!s.token });
  }
  const rank = (t: DestTotal) => (t.dest.chainId === destination ? 0 : 2) + (t.isToken ? 1 : 0);
  return [...sums.values()].sort((a, b) => rank(a) - rank(b));
}

/**
 * The minimum the API names when a balance is too small to bridge
 * (AMOUNT_TOO_LOW: "... it needs at least 17.94 MITO. ..."), or null
 */
export function minimumOf(detail: string | undefined, decimals: number): bigint | null {
  const found = detail?.match(/needs at least (\d+(?:\.\d+)?) /);
  if (!found) return null;
  try {
    return parseUnits(found[1]!, decimals);
  } catch {
    return null;
  }
}

/** "Too small to bridge: needs at least 17.94 MITO, add 17.89 more" */
export function tooSmallText(minimum: bigint, row: { balance: bigint; decimals: number; token: string }): string {
  const more = minimum - row.balance;
  return `Too small to bridge: needs at least ${formatAmountUp(minimum, row.decimals)} ${row.token}${more > 0n ? `, add ${formatAmountUp(more, row.decimals)} more` : ''}`;
}

/**
 * What a failed row asks of the owner. Only a failure after something was sent
 * needs checking; before that nothing moved, and the reason says what to do.
 */
export type FailureKind = 'too-small' | 'no-route' | 'stopped' | 'try-again' | 'check';

export function failureKind(st: { detail?: string; sent?: boolean; txHash?: string }, decimals: number): FailureKind {
  if (st.sent || st.txHash) return 'check';
  const detail = st.detail ?? '';
  if (minimumOf(detail, decimals) !== null) return 'too-small';
  if (isNoRoute(detail)) return 'no-route';
  if (/refus|unsafe|safety/i.test(detail)) return 'stopped';
  return 'try-again';
}

export const FAILURE_LABEL: Record<FailureKind, string> = {
  'too-small': 'Too small',
  'no-route': 'No route',
  stopped: 'Stopped',
  'try-again': 'Try again',
  check: 'Check needed',
};

/**
 * What a chain row says when it cannot be swept: the same plain words on every
 * chain, whatever the method behind it (the raw reason stays in a tooltip)
 */
export function plainReason(detail: string, token: string, chain: string, row?: { balance: bigint; decimals: number }): string {
  const minimum = row ? minimumOf(detail, row.decimals) : null;
  if (minimum !== null && row) return tooSmallText(minimum, { ...row, token });
  if (isNoRoute(detail)) return `No bridge takes ${token} out of ${chain} right now`;
  if (/does not cover|INSUFFICIENT|too small/i.test(detail)) return 'Too small to cover its own transfer';
  if (/refus|unsafe|safety/i.test(detail)) return 'Stopped before signing: the plan failed a safety check';
  // The API's own plain words for what a MetaMask permission cannot do on this chain yet
  if (/MetaMask permission/i.test(detail)) return detail;
  return 'Could not check this chain right now. Try again in a moment.';
}

/** Errors that mean no bridge can take this chain to the destination (not transient ones) */
export function isNoRoute(message: string): boolean {
  return /Chain Disabled|Limit Exceeded|not supported|no routes|does not deliver|router call|Insuf+icient Liquidity|No bridge|NO_ROUTE/i.test(message);
}

/**
 * Whether a sweep left the wallet where its closing authorization puts it: no code, or the
 * smart-account delegate it had before (`closing`). Unknown (`null`): ZeroDust's delegation is
 * gone, whatever is there instead.
 */
export function endedWhereSigned(code: string, closing: string | null): boolean {
  const lower = code.toLowerCase();
  if (closing === null) return lower === '0x' || (lower.startsWith('0xef0100') && lower.slice(8) !== ZERODUST_CONTRACT_ADDRESS.slice(2).toLowerCase());
  if (BigInt(closing) === 0n) return lower === '0x';
  return lower === `0xef0100${closing.slice(2).toLowerCase()}`;
}
