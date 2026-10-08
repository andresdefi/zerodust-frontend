import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, encodeFunctionData, parseAbi, parseTransaction, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { flzCompressLen, hexToBytes, l1FeeOf, settleL1Value, type L1Params } from '../src/direct/l1fee';
import type { DirectPlan } from '../src/direct/plan';
import { verifyPlan, type PlanContext } from '../src/direct/verify';

// Guard chains (Blast, Boba): the exact L1 fee from signed bytes, the settle search, the plan
// checks, and planChecked / signPlan against an offline chain that runs the real guard bytecode.

/** The two real guard sweeps (2026-10-08): signed bytes, the oracle at their block, the receipt's l1Fee */
const REAL = {
  blast: {
    raw: '0xf90151808310ca36830156a6942f95e6ed90a7dd67fc3fae5c5628647e6a83e48e865adc70975aebb8e41a8b33c40000000000000000000000004cd00e387622c35bddb9b4c962c136462338bc310000000000000000000000000000000000000000000000000000048c27a3236d0000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000000000004449290c1c000000000000000000000000e6914746fb229811073fe24f8d4f80d4b0fa05671a44934bd221cd5b8458c9c91c64e643f35d612270a0ba9196c3b8056cbc3f250000000000000000000000000000000000000000000000000000000083027c86a0ce92d098807834acee5a71c4c98e53bd33fe8c5e8fb0954f0bca8753a60c40c1a018012b1d32be4715379c71b423402dcf6e9ec0df070bc5a76dae7922c56c25a2',
    params: { l1BaseFee: 157_622_349n, blobBaseFee: 8_707_355n, baseFeeScalar: 1100n, blobBaseFeeScalar: 1n },
    l1Fee: 651_928_081n,
  },
  boba: {
    raw: '0xf90150808310c9f5830156a6942f95e6ed90a7dd67fc3fae5c5628647e6a83e48e865aae6b71a638b8e41a8b33c40000000000000000000000004cd00e387622c35bddb9b4c962c136462338bc310000000000000000000000000000000000000000000000000000048c656811f30000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000000000004449290c1c000000000000000000000000e6914746fb229811073fe24f8d4f80d4b0fa05675569ec01a643a25d67ef3d1bcd1baddd39e1129a817cf4fd9a8a35e145ad9c6e00000000000000000000000000000000000000000000000000000000820263a022555cb741db3924555cc98a544fd3cd3f9db8baae64eeb33cf683f21673da7ea020ac498f2d7928ad343c40c0e38463a17caa9810ce5932338519c35a86641f28',
    params: { l1BaseFee: 154_757_944n, blobBaseFee: 8_971_753n, baseFeeScalar: 500_000n, blobBaseFeeScalar: 1_014_213n },
    l1Fee: 198_312_482_538n,
  },
};

/** ZeroDustGuard's runtime code (zerodust contracts/out/ZeroDustGuard.yul), as deployed on both chains */
const GUARD_CODE = '0x631a8b33c45f3560e01c036100f2576004358060a01c6100f2576024356044359081600401359136602484830101116100f25733316100ed573482116100e857816100b7575b5f9383928594602486940184373403905af1156100b25733316100ad5760c85a106100a8575b5a610050105860069003575a5860410103565b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b00005b61014c565b61013d565b61012e565b5f808080857301ed5c94de39e73c986b98b85c2c0a3d1bedff7d9796975af1156100e357919091610045565b61011f565b610110565b610101565b63068b856560e21b5f5260045ffd5b6365a44a6960e01b5f5260045ffd5b630ef3fd9b60e31b5f5260045ffd5b634033e4e360e01b5f5260045ffd5b633204506f60e01b5f5260045ffd5b63cfe01bfb60e01b5f5260045ffd5b632163225d60e21b5f5260045ffd';

const GUARD = '0x2f95e6ED90a7dD67fc3Fae5c5628647E6A83e48e';
const RELAY = '0x4cd00e387622c35bddb9b4c962c136462338bc31';
const ZERODUST = '0x01eD5c94DE39E73C986b98B85C2c0A3d1BEDff7D';
const OTHER = '0x2222222222222222222222222222222222222222';
const BLAST = 81457;
const BASE = 8453;
const SWEEP = parseAbi(['function sweep(address target, uint256 fee, bytes data) payable']);
const hex = (n: bigint | number) => `0x${n.toString(16)}`;

describe('L1 fee from the signed bytes', () => {
  it('reproduces both real guard sweeps to the wei (Blast: Ecotone, Boba: Fjord)', () => {
    expect(l1FeeOf(hexToBytes(REAL.blast.raw), 'ecotone', REAL.blast.params)).toBe(REAL.blast.l1Fee);
    expect(l1FeeOf(hexToBytes(REAL.boba.raw), 'fjord', REAL.boba.params)).toBe(REAL.boba.l1Fee);
  });

  it('FastLZ length: short inputs are all literals, and repeats compress', () => {
    expect(flzCompressLen(new Uint8Array([]))).toBe(0);
    expect(flzCompressLen(new Uint8Array([1, 2, 3]))).toBe(4);
    // 32 literal bytes take a 33-byte run
    expect(flzCompressLen(Uint8Array.from({ length: 32 }, (_, i) => i * 7 + 1))).toBe(33);
    expect(flzCompressLen(new Uint8Array(200))).toBeLessThan(20);
  });

  it('Fjord charges at least the 100-byte floor', () => {
    const p: L1Params = REAL.boba.params;
    expect(l1FeeOf(new Uint8Array(10), 'fjord', p)).toBe((100_000_000n * (16n * p.baseFeeScalar * p.l1BaseFee + p.blobBaseFeeScalar * p.blobBaseFee)) / 10n ** 12n);
  });
});

describe('settleL1Value', () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const balance = 10n ** 14n;
  const gas = 87_718n;
  const gasPrice = 1_100_342n;
  for (const [formula, params] of [['ecotone', REAL.blast.params], ['fjord', REAL.boba.params]] as const) {
    it(`${formula}: value + gas x price + the signed transaction's own L1 fee is the balance`, async () => {
      for (let i = 0; i < 40; i++) {
        const forwarded = 94_000_000_000_000n + BigInt(i) * 999_983n;
        const settled = await settleL1Value({
          balance, gas, gasPrice, formula, params, firstValue: balance - gas * gasPrice,
          sign: async (value, g) => hexToBytes(await account.signTransaction({
            type: 'legacy', chainId: BLAST, nonce: 0, to: GUARD, value, gas: g, gasPrice,
            data: encodeFunctionData({ abi: SWEEP, functionName: 'sweep', args: [RELAY, value - forwarded, `0x49290c1c${'ab'.repeat(64)}`] }),
          })),
        });
        expect(settled.value + settled.gas * gasPrice + l1FeeOf(settled.signed, formula, params)).toBe(balance);
        expect(settled.gas - gas).toBeLessThan(16n);
        expect(settled.l1Fee).toBe(l1FeeOf(settled.signed, formula, params));
      }
    });
  }

  it('gives up rather than return a value that does not hold', async () => {
    // Every signature comes back a different size: no count ever matches its own
    let n = 0;
    await expect(settleL1Value({
      balance: 10n ** 14n, gas: 1n, gasPrice: 1n, formula: 'ecotone', params: REAL.blast.params, firstValue: 1n,
      sign: async () => new Uint8Array(100 + 7 * n++).fill(1),
    })).rejects.toThrow(/did not settle/);
  });
});

// ------------------------------------------------------------ plans

const BAL = 10n ** 14n;
const GAS = 87_718n;
const PRICE = 1_100_342n;
const L1 = 651_928_081n;
const FEE = 5_000_000_000_000n;
const FROM = '0xe6914746fb229811073fe24f8d4f80d4b0fa0567';
const RELAY_DATA = `0x49290c1c000000000000000000000000${FROM.slice(2)}${'1a'.repeat(32)}`;

function guardPlan(o: { target?: string; data?: string; fee?: bigint; route?: DirectPlan['route']; absorb?: 'fee' | 'amount'; from?: string } = {}): DirectPlan {
  const value = BAL - GAS * PRICE - L1;
  const fee = o.fee ?? FEE;
  const target = o.target ?? RELAY;
  const data = o.data ?? RELAY_DATA;
  return {
    chainId: BLAST, route: o.route ?? 'relay', requestId: '0x01', receive: '1', fee: fee.toString(), balance: BAL.toString(),
    txs: [{ kind: 'sweep', to: GUARD, data: encodeFunctionData({ abi: SWEEP, functionName: 'sweep', args: [target as Hex, fee, data as Hex] }), value: value.toString(), gas: GAS.toString(), gasPrice: PRICE.toString(), nonce: 0 }],
    guard: { address: GUARD, target, data, forwarded: (value - fee).toString(), l1Fee: L1.toString(), absorb: o.absorb ?? 'fee', l1Formula: 'ecotone' },
  };
}
const ctx = (o: Partial<PlanContext> = {}): PlanContext => ({ chainId: BLAST, toChainId: BASE, from: FROM, recipient: OTHER, mode: 'route', balance: BAL, nonce: 0, ...o });

describe('verifyPlan: guard chains', () => {
  it('accepts a Relay deposit through the guard that spends the balance with the L1 estimate', () => {
    expect(verifyPlan(guardPlan(), ctx())).toEqual({});
  });

  it('accepts a same-chain transfer and a burn, each moving the amount', () => {
    const same = guardPlan({ target: OTHER, data: '0x', route: 'transfer', absorb: 'amount' });
    same.receive = same.guard!.forwarded;
    expect(verifyPlan(same, ctx({ toChainId: BLAST }))).toEqual({});
    expect(verifyPlan(guardPlan({ target: '0x000000000000000000000000000000000000dEaD', data: '0x', route: 'burn', absorb: 'amount', fee: 0n }), ctx({ mode: 'burn' }))).toEqual({});
  });

  const refusals: Array<[string, () => DirectPlan, Partial<PlanContext>?]> = [
    ['no guard plan', () => ({ ...guardPlan(), guard: undefined })],
    ['another contract', () => { const p = guardPlan(); p.txs[0]!.to = OTHER; return p; }],
    ['another bridge target', () => guardPlan({ target: OTHER })],
    ['a deposit crediting someone else', () => guardPlan({ data: `0x49290c1c000000000000000000000000${OTHER.slice(2)}${'1a'.repeat(32)}` })],
    ['the fee moving the deposit amount', () => guardPlan({ absorb: 'amount' })],
    ['a fee above 5% plus the L1 estimate', () => guardPlan({ fee: BAL / 20n + L1 + 1n })],
    ['a bridge plan with no fee', () => guardPlan({ fee: 0n })],
    ['a value that leaves dust', () => { const p = guardPlan(); p.guard!.l1Fee = (L1 - 1n).toString(); return p; }],
    ['a fee shown that is not the fee paid', () => { const p = guardPlan(); p.fee = '1'; return p; }],
    ['a forwarded amount that does not add up', () => { const p = guardPlan(); p.guard!.forwarded = '1'; return p; }],
    ['another L1 formula', () => { const p = guardPlan(); p.guard!.l1Formula = 'fjord'; return p; }],
    ['two transactions', () => { const p = guardPlan(); p.txs.push({ ...p.txs[0]!, nonce: 1 }); return p; }],
    ['a stale nonce', () => guardPlan(), { nonce: 3 }],
    ['a swap exit', () => guardPlan(), { mode: 'exit' }],
    ['a burn that pays a fee', () => guardPlan({ target: '0x000000000000000000000000000000000000dEaD', data: '0x', route: 'burn', absorb: 'amount' }), { mode: 'burn' }],
  ];
  for (const [why, plan, over] of refusals) {
    it(`refuses ${why}`, () => {
      expect(() => verifyPlan(plan(), ctx(over))).toThrow(/Plan refused/);
    });
  }
});

// ------------------------------------------------------------ planChecked and signPlan, offline

const ORACLE = parseAbi(['function isFjord() view returns (bool)', 'function isIsthmus() view returns (bool)', 'function l1BaseFee() view returns (uint256)', 'function blobBaseFee() view returns (uint256)', 'function baseFeeScalar() view returns (uint32)', 'function blobBaseFeeScalar() view returns (uint32)']);
const selector = (functionName: 'isFjord' | 'isIsthmus' | 'l1BaseFee' | 'blobBaseFee' | 'baseFeeScalar' | 'blobBaseFeeScalar') => encodeFunctionData({ abi: ORACLE, functionName });

interface Net { plan: DirectPlan; kind?: string; guardCode?: string; fjord?: boolean | 'revert'; isthmus?: boolean | 'revert'; balance?: bigint; head?: number; tags?: string[] }

function network(net: Net, account: string) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const reply = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
    const revert = () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted' } }));
    if (url.includes('/direct/chains')) return new Response(JSON.stringify({ chains: [{ chainId: BLAST, name: 'Blast', token: 'ETH', decimals: 18, explorerUrl: '', rpcUrl: '', kind: net.kind ?? 'opguard', l1Formula: 'ecotone' }], prices: {} }));
    if (url.includes('/direct/prepare')) return new Response(JSON.stringify(net.plan));
    const { method, params } = JSON.parse(String(init!.body)) as { method: string; params: unknown[] };
    const who = String(params[0]).toLowerCase();
    switch (method) {
      // ZeroDust and Relay's depository exist on the real chains (a value call to an empty account costs 25,000 more)
      case 'eth_getBalance': return reply(hex(who === account.toLowerCase() ? (net.balance ?? BAL) : who === RELAY || who === ZERODUST.toLowerCase() ? 1n : 0n));
      case 'eth_getTransactionCount': return reply(hex(0));
      case 'eth_getCode': return reply(who === GUARD.toLowerCase() ? (net.guardCode ?? GUARD_CODE) : '0x');
      case 'eth_getStorageAt': return reply(hex(0));
      case 'eth_getBlockByNumber': return reply({ number: hex(1000), timestamp: hex(1_800_000_000), gasLimit: hex(30_000_000) });
      case 'eth_blockNumber': net.head = (net.head ?? 1000) + 1; return reply(hex(net.head));
      case 'eth_call': {
        const data = (params[0] as { data: string }).data;
        net.tags?.push(String(params[1]));
        // L1Block.sequenceNumber(): the L1 origin is fresh every third block here
        if (data === '0x64ca23ef') return reply(hex((net.head ?? 1000) % 3 === 0 ? 0 : 4));
        const flag = (v: boolean | 'revert' | undefined, dflt: boolean | 'revert') => ((v ?? dflt) === 'revert' ? revert() : reply(`0x${((v ?? dflt) ? 1 : 0).toString(16).padStart(64, '0')}`));
        if (data === selector('isFjord')) return flag(net.fjord, 'revert');
        if (data === selector('isIsthmus')) return flag(net.isthmus, 'revert');
        const p = REAL.blast.params;
        const v = data === selector('l1BaseFee') ? p.l1BaseFee : data === selector('blobBaseFee') ? p.blobBaseFee : data === selector('baseFeeScalar') ? p.baseFeeScalar : p.blobBaseFeeScalar;
        return reply(`0x${v.toString(16).padStart(64, '0')}`);
      }
      default: throw new Error(`unexpected ${method}`);
    }
  });
}

let run: typeof import('../src/direct/run');
beforeEach(async () => {
  vi.resetModules();
  run = await import('../src/direct/run');
});
afterEach(() => vi.unstubAllGlobals());

describe('planChecked and signPlan on Blast (the real guard bytecode on a fork)', () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const planFor = (o: Parameters<typeof guardPlan>[0] = {}) => {
    const data = `0x49290c1c000000000000000000000000${account.address.slice(2).toLowerCase()}${'1a'.repeat(32)}`;
    return guardPlan({ data, ...o });
  };
  const t = { chainId: BLAST, toChainId: BASE, from: account.address, recipient: OTHER };

  it('replays the guard: it pays the fee, deposits, and burns every unit of gas', async () => {
    vi.stubGlobal('fetch', network({ plan: planFor() }, account.address));
    await expect(run.planChecked(t, 'route')).resolves.toMatchObject({ route: 'relay' });
  });

  it('refuses code at the guard address that is not the guard', async () => {
    vi.stubGlobal('fetch', network({ plan: planFor(), guardCode: `${GUARD_CODE}00` }, account.address));
    await expect(run.planChecked(t, 'route')).rejects.toThrow(/guard is not deployed/);
  });

  it('refuses when the API does not call Blast a guard chain', async () => {
    vi.stubGlobal('fetch', network({ plan: planFor(), kind: 'evm' }, account.address));
    await expect(run.planChecked(t, 'route')).rejects.toThrow(/disagree/);
  });

  it('refuses a plan whose replay leaves the wallet above 0 (the guard reverts)', async () => {
    // The fork's balance is one wei above what the plan spends: the guard sees the wallet not at 0
    vi.stubGlobal('fetch', network({ plan: { ...planFor(), balance: BAL.toString() }, balance: BAL + 1n }, account.address));
    await expect(run.planChecked(t, 'route')).rejects.toThrow(/refused/);
  });

  it('signs with the exact L1 fee, moving the difference into the fee and keeping the deposit amount', async () => {
    const net: Net = { plan: planFor(), tags: [] };
    vi.stubGlobal('fetch', network(net, account.address));
    const plan = await run.planChecked(t, 'route');
    net.tags = [];
    const forwarded = BigInt(plan.guard!.forwarded);
    const [raw] = await run.signPlan(account, plan);
    const tx = parseTransaction(raw!);
    const l1 = l1FeeOf(hexToBytes(raw!), 'ecotone', REAL.blast.params);
    expect(tx.value! + tx.gas! * tx.gasPrice! + l1).toBe(BAL);
    expect(plan.txs[0]!.gas).toBe(tx.gas!.toString());
    const { args: [target, fee, data] } = decodeFunctionData({ abi: SWEEP, data: tx.data! });
    expect(target.toLowerCase()).toBe(RELAY);
    expect(data).toBe(planFor().guard!.data);
    expect(tx.value! - fee).toBe(forwarded);
    expect(plan.fee).toBe(fee.toString());
    expect(plan.txs[0]!.value).toBe(tx.value!.toString());
    // Block 1001 is mid-origin, so it waits for 1002 (the first of a fresh L1 origin) and reads
    // the oracle's six values at that exact block
    expect(net.tags).toEqual([hex(1001), hex(1002), ...Array(6).fill(hex(1002))]);
  });

  it('refuses to sign when the oracle reports another formula or an operator fee', async () => {
    vi.stubGlobal('fetch', network({ plan: planFor(), fjord: true }, account.address));
    await expect(run.signPlan(account, await run.planChecked(t, 'route'))).rejects.toThrow(/changed how it charges/);
    vi.stubGlobal('fetch', network({ plan: planFor(), isthmus: true }, account.address));
    await expect(run.signPlan(account, await run.planChecked(t, 'route'))).rejects.toThrow(/operator fee/);
  });

  it('accepts an oracle that answers false for flags it has', async () => {
    vi.stubGlobal('fetch', network({ plan: planFor(), fjord: false, isthmus: false }, account.address));
    await expect(run.signPlan(account, await run.planChecked(t, 'route'))).resolves.toHaveLength(1);
  });
});

describe('ZeroDust fee address', () => {
  it('is the one the guard pays (the constant in its bytecode)', () => {
    expect(GUARD_CODE.toLowerCase()).toContain(ZERODUST.slice(2).toLowerCase());
  });
});
