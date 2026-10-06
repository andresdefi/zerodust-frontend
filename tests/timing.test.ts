import { describe, expect, it } from 'vitest';
import { bridgingText } from '../src/sweep/useSweep';
import { durationText, expectedTime, parseTimings } from '../src/sweep/timing';

const timings = parseTimings({
  routes: {
    relay: { typicalSeconds: 18, p90Seconds: 40, samples: 12, slowLately: false },
    gaszip: { typicalSeconds: 22, p90Seconds: 90, samples: 9, slowLately: true },
  },
  pairs: { 'relay:42161': { typicalSeconds: 9, samples: 4 } },
});

describe('expectedTime', () => {
  it("uses the source chain's own time when measured, else the bridge's", () => {
    expect(expectedTime(timings, 'Relay', 42161)).toEqual({ seconds: 9, slowLately: false });
    expect(expectedTime(timings, 'Relay', 8453)).toEqual({ seconds: 18, slowLately: false });
    expect(expectedTime(timings, 'Gas.zip', 10)).toEqual({ seconds: 22, slowLately: true });
  });

  it('says nothing for a bridge without enough deliveries or an unknown name', () => {
    expect(expectedTime(timings, 'Across', 10)).toBeNull();
    expect(expectedTime(timings, 'Hyperlane', 10)).toBeNull();
    expect(expectedTime(timings, undefined, 10)).toBeNull();
  });
});

describe('parseTimings', () => {
  it('drops malformed entries from the network', () => {
    const t = parseTimings({
      routes: { relay: { typicalSeconds: 'x', p90Seconds: 1, samples: 3 }, across: null, lifi: { typicalSeconds: -1, p90Seconds: 1, samples: 3 } },
      pairs: { 'relay:1': { typicalSeconds: 5 } },
    });
    expect(t).toEqual({ routes: {}, pairs: {} });
    expect(parseTimings(null)).toEqual({ routes: {}, pairs: {} });
    expect(parseTimings('nope')).toEqual({ routes: {}, pairs: {} });
  });
});

describe('durationText', () => {
  it('reads as seconds under a minute, minutes above', () => {
    expect(durationText(0.4)).toBe('1s');
    expect(durationText(20)).toBe('20s');
    expect(durationText(150)).toBe('3 min');
  });
});

describe('bridgingText with a known time', () => {
  it('names the usual time, and says when the bridge is slow lately', () => {
    expect(bridgingText('Relay', 'Base', 12, { seconds: 18, slowLately: false })).toBe('Wallet reads 0. Relay is delivering to Base (12s; usually 18s)');
    expect(bridgingText('Gas.zip', 'Base', 75, { seconds: 22, slowLately: true })).toBe('Wallet reads 0. Gas.zip is delivering to Base (1m 15s; usually 22s, slower than usual lately)');
  });
});
