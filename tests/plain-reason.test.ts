import { describe, expect, it } from 'vitest';
import { FAILURE_LABEL, failureKind, minimumOf, plainReason, tooSmallText } from '../src/sweep/useSweep';
import { formatAmountUp } from '../src/lib/format';

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

describe('too small to bridge (AMOUNT_TOO_LOW)', () => {
  const mitosis = { balance: 50_000_000_000_000_000n, decimals: 18, token: 'MITO' };
  const API = 'The balance is too small to bridge from Mitosis to BNB Chain: it needs at least 17.94 MITO. Add funds to sweep it, or sweep it on Mitosis.';

  it('reads the minimum the API names', () => {
    expect(minimumOf(API, 18)).toBe(17_940_000_000_000_000_000n);
    expect(minimumOf('No bridge route from Mitosis right now', 18)).toBeNull();
    expect(minimumOf(undefined, 18)).toBeNull();
  });

  it('says the minimum and the top-up, both rounded up', () => {
    expect(tooSmallText(17_940_000_000_000_000_000n, mitosis)).toBe('Too small to bridge: needs at least 17.94 MITO, add 17.89 more');
    expect(tooSmallText(1_906_123_400_000_000_000n, { balance: 1n * 10n ** 18n, decimals: 18, token: 'MON' }))
      .toBe('Too small to bridge: needs at least 1.907 MON, add 0.9062 more');
    // Balance already above it (it grew since): no top-up
    expect(tooSmallText(10n, { balance: 20n, decimals: 0, token: 'X' })).toBe('Too small to bridge: needs at least 10 X');
  });

  it('plainReason keeps the minimum instead of a generic line', () => {
    expect(plainReason(API, 'MITO', 'Mitosis', mitosis)).toBe('Too small to bridge: needs at least 17.94 MITO, add 17.89 more');
    expect(plainReason('Balance does not cover the fees', 'MITO', 'Mitosis', mitosis)).toBe('Too small to cover its own transfer');
  });

  it('formatAmountUp never rounds a minimum down', () => {
    expect(formatAmountUp(17_890_000_000_000_000_001n, 18)).toBe('17.9');
    expect(formatAmountUp(0n, 18)).toBe('0');
  });
});

describe('failureKind: only a failure after something was sent needs checking', () => {
  it('names what to do when nothing was sent', () => {
    expect(failureKind({ detail: 'The balance is too small to bridge from Mitosis to BNB Chain: it needs at least 17.94 MITO. Add funds.' }, 18)).toBe('too-small');
    expect(failureKind({ detail: 'Gas.zip: Source: Chain Disabled; Relay: no routes found' }, 18)).toBe('no-route');
    expect(failureKind({ detail: 'Refusing to sign: cannot verify the Gas.zip route to chain 8453' }, 18)).toBe('stopped');
    expect(failureKind({ detail: 'A chain or bridge did not answer in time. Try again in a minute.' }, 18)).toBe('try-again');
    expect(failureKind({ detail: 'Internal Server Error' }, 18)).toBe('try-again');
  });

  it('needs checking once a transaction left or the relayer took the sweep', () => {
    expect(failureKind({ detail: 'Sent, but the chain still shows a balance', sent: true }, 18)).toBe('check');
    expect(failureKind({ detail: 'Gas.zip: Source: Chain Disabled', txHash: '0xab' }, 18)).toBe('check');
    expect(FAILURE_LABEL.check).toBe('Check needed');
  });
});
