import { describe, expect, it } from 'vitest';
import { plainReason } from '../src/sweep/useSweep';

// Every chain says the same plain words, whatever the method behind it (owner, 2026-10-02)
describe('plainReason', () => {
  it('maps bridge refusals from any method to one sentence', () => {
    for (const raw of ['Gas.zip: Source: Chain Disabled', 'NO_ROUTE: no routes found', 'No bridge delivers from Base to chain 999']) {
      expect(plainReason(raw, 'MON', 'Monad')).toBe('No bridge takes MON out of Monad right now');
    }
  });

  it('says when the balance is too small, when a safety check stopped it, and otherwise to try again', () => {
    expect(plainReason('The balance does not cover the gas', 'ETH', 'Base')).toBe('Too small to cover its own transfer');
    expect(plainReason('Plan refused: the fee is above 5% of the balance', 'FLR', 'Flare')).toBe('Stopped before signing: the plan failed a safety check');
    // The SDK words it 'Refusing to sign' (Doma before its Relay depository was allowlisted)
    expect(plainReason('Refusing to sign: call target 0x4cD0 is not a known bridge contract on chain 97477', 'ETH', 'Doma')).toBe('Stopped before signing: the plan failed a safety check');
    expect(plainReason('Relay gas did not settle; try again', 'MON', 'Monad')).toBe('Could not check this chain right now. Try again in a moment.');
  });
});
