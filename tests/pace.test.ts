// One address on ~30 chains made 95 route checks in 20 s; the API refused 35 of them (60 a minute
// per visitor) and each refusal read as "unknown", which asked again (2026-10-27)
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pacer, reuse } from '../src/lib/pace';

describe('pacer', () => {
  afterEach(() => vi.useRealTimers());

  it('starts at most `limit` requests in any window, then the rest as the window moves', async () => {
    vi.useFakeTimers();
    const slot = pacer(3, 60_000);
    const started: number[] = [];
    for (let i = 0; i < 5; i++) void slot().then(() => started.push(Date.now()));
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(started).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(started).toHaveLength(5);
  });
});

describe('reuse', () => {
  afterEach(() => vi.useRealTimers());

  it('asks once for the same key at the same time and within keepMs, then again', async () => {
    vi.useFakeTimers();
    const shared = reuse<number>(30_000);
    const ask = vi.fn(async () => 7);
    expect(await Promise.all([shared('a', ask), shared('a', ask)])).toEqual([7, 7]);
    expect(await shared('a', ask)).toBe(7);
    expect(ask).toHaveBeenCalledTimes(1);
    await shared('b', ask);
    expect(ask).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30_000);
    await shared('a', ask);
    expect(ask).toHaveBeenCalledTimes(3);
  });

  it('never keeps an answer `keep` refuses (an unknown route) or a failure', async () => {
    const shared = reuse<{ available: boolean | null }>(30_000, (a) => a.available !== null);
    const unknown = vi.fn(async () => ({ available: null }));
    await shared('r', unknown);
    await shared('r', unknown);
    expect(unknown).toHaveBeenCalledTimes(2);
    const failing = vi.fn(async () => { throw new Error('HTTP 429'); });
    await expect(shared('f', failing)).rejects.toThrow('HTTP 429');
    await expect(shared('f', failing)).rejects.toThrow('HTTP 429');
    expect(failing).toHaveBeenCalledTimes(2);
  });
});
