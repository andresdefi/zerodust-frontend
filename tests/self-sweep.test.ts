import { describe, expect, it } from 'vitest';
import { bridgingText, onlySelfSweep, plainReason } from '../src/sweep/useSweep';

// A same-chain sweep to the same wallet moves nothing: the page asks for another address
// instead of offering it (owner, 2026-10-06, found sweeping Base to Base from MetaMask)
describe('onlySelfSweep', () => {
  const base = { chainId: 8453, canSweep: true };
  const arbitrum = { chainId: 42161, canSweep: true };
  const all = (...ids: number[]) => new Set(ids);

  it('is true when the only selected chain is the destination and the recipient is the wallet itself', () => {
    expect(onlySelfSweep([base], all(8453), 8453, true)).toBe(true);
  });

  it('is false once another address is set: Base to Base then empties the wallet', () => {
    expect(onlySelfSweep([base], all(8453), 8453, false)).toBe(false);
  });

  it('is false when another selected chain has something to bring to the destination', () => {
    expect(onlySelfSweep([base, arbitrum], all(8453, 42161), 8453, true)).toBe(false);
  });

  it('is true when the other chains are deselected or cannot be swept', () => {
    expect(onlySelfSweep([base, arbitrum], all(8453), 8453, true)).toBe(true);
    expect(onlySelfSweep([base, { ...arbitrum, canSweep: false }], all(8453, 42161), 8453, true)).toBe(true);
  });

  it('is false before a destination is chosen, and with nothing selected', () => {
    expect(onlySelfSweep([base], all(8453), null, true)).toBe(false);
    expect(onlySelfSweep([base], all(), 8453, true)).toBe(false);
  });
});

describe('plainReason for MetaMask permission limits', () => {
  it("passes the API's own plain words through instead of a generic retry", () => {
    const detail = 'No bridge that works with a MetaMask permission delivers from Base to chain 42161; sweeping with your key can';
    expect(plainReason(detail, 'ETH', 'Base')).toBe('No bridge takes ETH out of Base right now');
    const unavailable = 'Sweeping with a MetaMask permission is not available on Linea yet';
    expect(plainReason(unavailable, 'ETH', 'Linea')).toBe(unavailable);
  });
});

describe('bridgingText', () => {
  it('says the wallet reads 0, who delivers where, and for how long', () => {
    expect(bridgingText('Gas.zip', 'Base', 42)).toBe('Wallet reads 0. Gas.zip is delivering to Base (42s; usually under a minute, sometimes a few)');
    expect(bridgingText('Across', 'Arbitrum', 257)).toBe('Wallet reads 0. Across is delivering to Arbitrum (4m 17s; usually under a minute, sometimes a few)');
  });
});
