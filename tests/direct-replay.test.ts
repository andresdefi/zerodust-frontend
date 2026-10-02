import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkReplay, etherlinkInclusionGas, GASLIMIT_MAX_OVER_USED, hardforkFor, pragueFloorGas, replay } from '../src/direct/replay';
import type { PlanTx } from '../src/direct/plan';

const FROM = '0x1111111111111111111111111111111111111111';
const TO = '0x2222222222222222222222222222222222222222';
const PRICE = 25_000_000_000n;
const BALANCE = 10n ** 17n;
const hex = (n: bigint | number) => `0x${n.toString(16)}`;

/** A contract that only returns (STOP): a deposit target whose execution costs nothing past intrinsic gas */
const CONTRACT = '0x3333333333333333333333333333333333333333';

/** A chain's public RPC, offline: one funded wallet, everything else empty */
function fakeRpc() {
  return vi.fn(async (_url: string, init: RequestInit) => {
    const { method, params } = JSON.parse(String(init.body)) as { method: string; params: unknown[] };
    const result = (() => {
      switch (method) {
        case 'eth_getBlockByNumber': return { number: hex(1000), timestamp: hex(1_800_000_000), gasLimit: hex(30_000_000) };
        case 'eth_getBalance': return hex(String(params[0]).toLowerCase() === FROM ? BALANCE : 0n);
        case 'eth_getTransactionCount': return hex(String(params[0]).toLowerCase() === FROM ? 4 : 0);
        case 'eth_getCode': return String(params[0]).toLowerCase() === CONTRACT ? '0x00' : '0x';
        case 'eth_getStorageAt': return hex(0);
        default: throw new Error(`unexpected ${method}`);
      }
    })();
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
  });
}

const transfer = (gas: bigint): PlanTx => ({
  kind: 'sweep', to: TO, data: '0x', gas: gas.toString(), gasPrice: PRICE.toString(), nonce: 4, value: (BALANCE - gas * PRICE).toString(),
});

afterEach(() => vi.unstubAllGlobals());

describe('replay (offline fork)', () => {
  it('an exact plain transfer uses exactly its gas and leaves 0', async () => {
    vi.stubGlobal('fetch', fakeRpc());
    const txs = [transfer(21_000n)];
    const r = await replay(43114, FROM, txs);
    expect(r.results).toEqual([{ ok: true, gasUsed: 21_000n, error: undefined }]);
    expect(r.after).toBe(0n);
    expect(() => checkReplay(43114, txs, r, null)).not.toThrow();
  });

  it('refuses a set whose gas limit is not what it uses (the wallet would keep dust)', async () => {
    vi.stubGlobal('fetch', fakeRpc());
    const txs = [transfer(21_001n)];
    const r = await replay(43114, FROM, txs);
    expect(r.after).toBe(PRICE);
    expect(() => checkReplay(43114, txs, r, null)).toThrow(/use 21000 gas, not its limit 21001/);
  });
});

describe('checkReplay', () => {
  const ok = (gasUsed: bigint) => ({ ok: true, gasUsed });

  it('refuses a revert, and a swap that leaves more than planned', () => {
    const txs = [transfer(21_000n)];
    expect(() => checkReplay(43114, txs, { results: [{ ok: false, gasUsed: 0n, error: 'revert' }], after: 0n }, null)).toThrow(/reverts/);
    expect(() => checkReplay(43114, txs, { results: [ok(21_000n)], after: 6n }, { leftoverMax: 5n })).toThrow(/more than planned/);
    expect(() => checkReplay(43114, txs, { results: [ok(21_000n)], after: 5n }, { leftoverMax: 5n })).not.toThrow();
  });

  it('Etherlink: the limit is execution plus the inclusion fee, which the fork leaves uncharged', () => {
    const price = 1_000_000_000n;
    const inclusion = etherlinkInclusionGas('0x', price);
    expect(inclusion).toBe(600_000n);
    const txs = [{ ...transfer(21_000n + inclusion), gasPrice: price.toString() }];
    expect(() => checkReplay(42793, txs, { results: [ok(21_000n)], after: inclusion * price }, null)).not.toThrow();
    expect(() => checkReplay(42793, txs, { results: [ok(21_000n)], after: 0n }, null)).toThrow(/keep/);
  });
});

describe('replay: chains that charge the whole gas limit (Monad)', () => {
  const MONAD = 143;
  const FEE = 10n ** 15n;
  /** fee transfer (21,000) + a call with a limit above what it uses, spending BALANCE to the wei */
  const set = (callGas: bigint, valueDelta = 0n): PlanTx[] => {
    const value = BALANCE - FEE - 21_000n * PRICE - callGas * PRICE + valueDelta;
    return [
      { kind: 'fee', to: TO, data: '0x', gas: '21000', gasPrice: PRICE.toString(), nonce: 4, value: FEE.toString() },
      { kind: 'sweep', to: CONTRACT, data: '0xabcdef', gas: callGas.toString(), gasPrice: PRICE.toString(), nonce: 5, value: value.toString() },
    ];
  };

  it('accepts a set whose arithmetic is exact even though the fork refunds the unused gas', async () => {
    vi.stubGlobal('fetch', fakeRpc());
    const txs = set(60_000n);
    const r = await replay(MONAD, FROM, txs);
    const used = r.results[1]!.gasUsed;
    expect(used).toBeLessThan(60_000n);
    // The fork gave back (limit - used) x price; on Monad the wallet ends at 0
    expect(r.after).toBe((60_000n - used) * PRICE);
    expect(() => checkReplay(MONAD, txs, r, null)).not.toThrow();
    // The same replay on an exact-gas chain is dust
    expect(() => checkReplay(43114, txs, r, null)).toThrow(/not its limit/);
  });

  it('refuses a set that does not spend the balance exactly (the wallet would keep wei)', async () => {
    vi.stubGlobal('fetch', fakeRpc());
    const txs = set(60_000n, -1n);
    const r = await replay(MONAD, FROM, txs);
    expect(() => checkReplay(MONAD, txs, r, null)).toThrow(/keep 1 wei/);
  });

  it('refuses a limit below what the call uses, or far above it', async () => {
    const txs = set(60_000n);
    const used = (n: bigint) => ({ ok: true, gasUsed: n });
    expect(() => checkReplay(MONAD, txs, { results: [used(21_000n), used(60_001n)], after: 0n }, null)).toThrow(/over its limit/);
    vi.stubGlobal('fetch', fakeRpc());
    const wasteful = set(1_000_000n);
    const r = await replay(MONAD, FROM, wasteful);
    expect(BigInt(wasteful[1]!.gas)).toBeGreaterThan(r.results[1]!.gasUsed * GASLIMIT_MAX_OVER_USED);
    expect(() => checkReplay(MONAD, wasteful, r, null)).toThrow(/asks for 1000000 gas/);
  });

  it('swap exit: the leftover is judged without the fork\'s refunds', () => {
    const txs = set(60_000n);
    const results = [{ ok: true, gasUsed: 21_000n }, { ok: true, gasUsed: 40_000n }];
    const refunds = 20_000n * PRICE;
    expect(() => checkReplay(MONAD, txs, { results, after: refunds + 5n }, { leftoverMax: 5n })).not.toThrow();
    expect(() => checkReplay(MONAD, txs, { results, after: refunds + 6n }, { leftoverMax: 5n })).toThrow(/more than planned/);
  });
});

describe('hardfork', () => {
  it('follows the EIP-7623 floor: a chain that accepted less is pre-Prague', () => {
    expect(pragueFloorGas('0x010036')).toBe(21_000n + 10n * (1n + 4n * 2n));
    expect(hardforkFor([{ gas: '21036', data: '0x010036' }])).toBe('cancun');
    expect(hardforkFor([{ gas: '21090', data: '0x010036' }])).toBe('prague');
  });
});
