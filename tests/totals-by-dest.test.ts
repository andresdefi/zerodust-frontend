import { describe, expect, it } from 'vitest';
import { rowToken, totalsByDest, type DestOption, type RowState } from '../src/sweep/useSweep';

const DESTS: DestOption[] = [
  { chainId: 8453, name: 'Base', token: 'ETH', decimals: 18, reachableFrom: 2 },
  { chainId: 10, name: 'Optimism', token: 'ETH', decimals: 18, reachableFrom: 2 },
  { chainId: 56, name: 'BNB Chain', token: 'BNB', decimals: 18, reachableFrom: 2 },
];
const destOf = (id: number) => DESTS.find((d) => d.chainId === id) ?? null;
const ready = (receive: bigint | undefined, toChainId?: number, token?: RowState['token']): RowState => ({ phase: 'ready', receive, toChainId, token });

describe('totalsByDest', () => {
  it('sums per chain, the chosen destination first', () => {
    const totals = totalsByDest([ready(5n, 10), ready(1n, 8453), ready(2n, 8453), ready(undefined)], 8453, destOf);
    expect(totals.map((t) => [t.dest.name, t.symbol, t.amount])).toEqual([['Base', 'ETH', 3n], ['Optimism', 'ETH', 5n]]);
  });

  it('leaves out burns and donations (nothing received) and chains it does not know', () => {
    expect(totalsByDest([ready(undefined, 8453), ready(4n, 999)], 8453, destOf)).toEqual([]);
  });

  it('keeps a delivered token apart from the gas of the same chain, after it', () => {
    const mito = rowToken(124816, 56);
    expect(mito).toEqual({ symbol: 'MITO', decimals: 18 });
    const totals = totalsByDest([ready(7n, 56, mito), ready(3n, 56), ready(2n, 56, mito)], 56, destOf);
    expect(totals.map((t) => [t.dest.name, t.symbol, t.isToken, t.amount])).toEqual([['BNB Chain', 'BNB', false, 3n], ['BNB Chain', 'MITO', true, 9n]]);
  });

  it('only Mitosis to BNB Chain delivers a token', () => {
    expect(rowToken(124816, 8453)).toBeUndefined();
    expect(rowToken(8453, 56)).toBeUndefined();
  });
});
