import { describe, expect, it } from 'vitest';
import { totalsByDest, type DestOption, type RowState } from '../src/sweep/useSweep';

const DESTS: DestOption[] = [
  { chainId: 8453, name: 'Base', token: 'ETH', decimals: 18, reachableFrom: 2 },
  { chainId: 10, name: 'Optimism', token: 'ETH', decimals: 18, reachableFrom: 2 },
];
const destOf = (id: number) => DESTS.find((d) => d.chainId === id) ?? null;
const ready = (receive: bigint | undefined, toChainId?: number): RowState => ({ phase: 'ready', receive, toChainId });

describe('totalsByDest', () => {
  it('sums per chain, the chosen destination first', () => {
    const totals = totalsByDest([ready(5n, 10), ready(1n, 8453), ready(2n, 8453), ready(undefined)], 8453, destOf);
    expect(totals.map((t) => [t.dest.name, t.amount])).toEqual([['Base', 3n], ['Optimism', 5n]]);
  });

  it('leaves out burns and donations (nothing received) and chains it does not know', () => {
    expect(totalsByDest([ready(undefined, 8453), ready(4n, 999)], 8453, destOf)).toEqual([]);
  });
});
