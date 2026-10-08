import { describe, expect, it } from 'vitest';
import { encodeFunctionData, parseAbi } from 'viem';
import { BURN_ADDRESS, GASZIP_DEPOSIT, LIFI_DIAMOND, relayDepositoryFor, ZERODUST_ADDRESS, type DirectPlan, type PlanTx } from '../src/direct/plan';
import { totalSpend, verifyPlan, type PlanContext } from '../src/direct/verify';
import { ACROSS, acrossDepositData, transferCall } from './fixtures/across-direct';

const FROM = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const PRICE = 25_000_000_000n;
const BALANCE = 10n ** 17n;
const FEE = 2n * 10n ** 15n;

const tx = (over: Partial<PlanTx>): PlanTx => ({ kind: 'sweep', to: OTHER, data: '0x', value: '0', gas: '21000', gasPrice: PRICE.toString(), nonce: 4, ...over });

/** A fee + sweep set that spends BALANCE to the wei */
function routePlan(sweep: Partial<PlanTx>, route: DirectPlan['route'] = 'gaszip'): DirectPlan {
  const gas = BigInt(sweep.gas ?? '21000');
  const value = BALANCE - FEE - 21_000n * PRICE - gas * PRICE;
  return {
    chainId: 43114, route, requestId: null, receive: '1', fee: FEE.toString(), balance: BALANCE.toString(),
    txs: [tx({ kind: 'fee', to: ZERODUST_ADDRESS, value: FEE.toString() }), tx({ nonce: 5, value: value.toString(), ...sweep })],
  };
}

const ctx = (over: Partial<PlanContext> = {}): PlanContext => ({ chainId: 43114, toChainId: 8453, from: FROM, recipient: FROM, mode: 'route', balance: BALANCE, nonce: 4, ...over });

describe('verifyPlan', () => {
  it('accepts a Gas.zip plan that spends the balance to the wei and names the right recipient', () => {
    const toSelf = routePlan({ to: GASZIP_DEPOSIT, data: '0x010036', gas: '21048' });
    expect(totalSpend(toSelf)).toBe(BALANCE);
    expect(() => verifyPlan(toSelf, ctx())).not.toThrow();
    const toOther = routePlan({ to: GASZIP_DEPOSIT, data: `0x02${OTHER.slice(2)}0036`, gas: '21368' });
    expect(() => verifyPlan(toOther, ctx({ recipient: OTHER }))).not.toThrow();
  });

  it('refuses a Gas.zip deposit for someone else, or sent elsewhere', () => {
    const stranger = '0x3333333333333333333333333333333333333333';
    expect(() => verifyPlan(routePlan({ to: GASZIP_DEPOSIT, data: `0x02${stranger.slice(2)}0036`, gas: '21368' }), ctx({ recipient: OTHER }))).toThrow(/does not name the address/);
    expect(() => verifyPlan(routePlan({ to: GASZIP_DEPOSIT, data: `0x02${OTHER.slice(2)}0036`, gas: '21368' }), ctx())).toThrow(/does not name the address/);
    expect(() => verifyPlan(routePlan({ to: OTHER, data: '0x010036', gas: '21048' }), ctx())).toThrow(/does not go to Gas.zip/);
  });

  it('refuses a set that would not leave exactly 0', () => {
    const plan = routePlan({ to: GASZIP_DEPOSIT, data: '0x010036', gas: '21048' });
    plan.txs[1]!.value = (BigInt(plan.txs[1]!.value) - 1n).toString();
    expect(() => verifyPlan(plan, ctx())).toThrow(/exactly 0/);
  });

  it('refuses a plan made for another balance, nonce, chain or price', () => {
    const plan = routePlan({ to: GASZIP_DEPOSIT, data: '0x010036', gas: '21048' });
    expect(() => verifyPlan(plan, ctx({ balance: BALANCE + 1n }))).toThrow(/balance changed/);
    expect(() => verifyPlan(plan, ctx({ nonce: 5 }))).toThrow(/nonces/);
    expect(() => verifyPlan(plan, ctx({ chainId: 25 }))).toThrow(/another chain/);
    const mixed = routePlan({ to: GASZIP_DEPOSIT, data: '0x010036', gas: '21048', gasPrice: (PRICE + 1n).toString() });
    expect(() => verifyPlan(mixed, ctx())).toThrow(/gas prices differ/);
  });

  it('refuses a fee that is not a plain transfer to ZeroDust, or above 5%', () => {
    const plan = routePlan({ to: GASZIP_DEPOSIT, data: '0x010036', gas: '21048' });
    plan.txs[0]!.to = OTHER;
    expect(() => verifyPlan(plan, ctx())).toThrow(/fee does not go to ZeroDust/);
    const big = routePlan({ to: GASZIP_DEPOSIT, data: '0x010036', gas: '21048' });
    big.txs[0]!.value = (BALANCE / 10n).toString();
    expect(() => verifyPlan(big, ctx())).toThrow(/above 5%/);
  });

  it("Relay: only a depositNative to Relay's pinned depository, crediting this wallet", () => {
    const data = (depositor: string) => `0x49290c1c000000000000000000000000${depositor.slice(2)}${'ee'.repeat(32)}`;
    const DEPOSITORY = '0x4cd00e387622c35bddb9b4c962c136462338bc31';
    expect(() => verifyPlan(routePlan({ to: DEPOSITORY, data: data(FROM), gas: '24830' }, 'relay'), ctx())).not.toThrow();
    // Any other contract could take the deposit and credit no one
    expect(() => verifyPlan(routePlan({ to: OTHER, data: data(FROM), gas: '24830' }, 'relay'), ctx())).toThrow(/Relay's depository/);
    expect(() => verifyPlan(routePlan({ to: DEPOSITORY, data: data(OTHER), gas: '24830' }, 'relay'), ctx())).toThrow(/credit this wallet/);
    expect(() => verifyPlan(routePlan({ to: DEPOSITORY, data: '0xdeadbeef', gas: '24830' }, 'relay'), ctx())).toThrow(/plain deposit/);
    expect(() => verifyPlan(routePlan({ to: DEPOSITORY, data: `${data(FROM)}00`, gas: '24830' }, 'relay'), ctx())).toThrow(/plain deposit/);
  });

  it("Relay on Cronos: its own depository, as Relay's quotes name it", () => {
    expect(relayDepositoryFor(25)).toBe('0x59916da825d2d2ec1bf878d71c88826f6633ecca');
    expect(relayDepositoryFor(999)).toBe('0x4cd00e387622c35bddb9b4c962c136462338bc31');
  });

  it('same chain: a plain transfer to the address set, never to the wallet itself', () => {
    const plan = routePlan({ to: OTHER }, 'transfer');
    expect(() => verifyPlan(plan, ctx({ toChainId: 43114, recipient: OTHER }))).not.toThrow();
    expect(() => verifyPlan(routePlan({ to: FROM }, 'transfer'), ctx({ toChainId: 43114 }))).toThrow(/does not go to the address you set|another address/);
  });

  it('burn and donate: one exact transfer to the burn address or ZeroDust, no fee', () => {
    const one = (to: string, route: 'burn' | 'donate'): DirectPlan => ({
      chainId: 43114, route, requestId: null, receive: '0', fee: '0', balance: BALANCE.toString(),
      txs: [tx({ to, value: (BALANCE - 21_000n * PRICE).toString() })],
    });
    expect(() => verifyPlan(one(BURN_ADDRESS, 'burn'), ctx({ mode: 'burn' }))).not.toThrow();
    expect(() => verifyPlan(one(ZERODUST_ADDRESS, 'donate'), ctx({ mode: 'donate' }))).not.toThrow();
    expect(() => verifyPlan(one(OTHER, 'burn'), ctx({ mode: 'burn' }))).toThrow(/burn address/);
    expect(() => verifyPlan(routePlan({ to: BURN_ADDRESS }, 'burn'), ctx({ mode: 'burn' }))).toThrow(/no fee/);
  });

  it('swap exit: LI.FI\'s contract, leaving the chain, with a bounded leftover', () => {
    const exit = (to: string, leftoverMax?: string): DirectPlan => {
      const swapGas = 400_000n;
      const value = BALANCE - FEE - 21_000n * PRICE - swapGas * PRICE - 10n ** 15n;
      return {
        chainId: 43114, route: 'lifi', requestId: null, receive: '1', fee: FEE.toString(), balance: BALANCE.toString(), leftoverMax,
        txs: [tx({ kind: 'fee', to: ZERODUST_ADDRESS, value: FEE.toString() }), tx({ kind: 'swap', to, data: '0xabcd', nonce: 5, value: value.toString(), gas: swapGas.toString() })],
      };
    };
    expect(() => verifyPlan(exit(LIFI_DIAMOND, String(2n * 10n ** 15n)), ctx({ mode: 'exit' }))).not.toThrow();
    expect(() => verifyPlan(exit(OTHER, String(2n * 10n ** 15n)), ctx({ mode: 'exit' }))).toThrow(/LI.FI/);
    expect(() => verifyPlan(exit(LIFI_DIAMOND, '1'), ctx({ mode: 'exit' }))).toThrow(/leftover/);
    expect(() => verifyPlan(exit(LIFI_DIAMOND, String(2n * 10n ** 15n)), ctx({ mode: 'exit', toChainId: 43114 }))).toThrow(/leave the chain/);
  });
});

describe('verifyPlan: gas-limit chains (Monad) and Across', () => {
  const MONAD = 143;
  const MON_BAL = 63n * 10n ** 18n;
  const MON_PRICE = 112_200_000_000n;
  const MON_FEE = 1_477_967_203_907_745_280n;
  const ACROSS_GAS = 908_509n;
  const QUOTE_TS = 1_790_938_644;
  const RECEIVE = 714_787_782_428_686n;
  const mon = (over: Partial<PlanTx>): PlanTx => tx({ gasPrice: MON_PRICE.toString(), nonce: 7, ...over });

  /** fee + Across deposit spending MON_BAL to the wei; the limit is far above what a fork uses */
  function acrossPlan(opts: Partial<Parameters<typeof acrossDepositData>[0]> = {}, valueDelta = 0n): DirectPlan {
    const value = MON_BAL - MON_FEE - 21_000n * MON_PRICE - ACROSS_GAS * MON_PRICE + valueDelta;
    return {
      chainId: MONAD, route: 'across', requestId: null, receive: RECEIVE.toString(), quoted: '736894621060501', fee: MON_FEE.toString(), balance: MON_BAL.toString(),
      txs: [
        mon({ kind: 'fee', to: ZERODUST_ADDRESS, value: MON_FEE.toString() }),
        mon({ nonce: 8, to: ACROSS.periphery, gas: ACROSS_GAS.toString(), value: value.toString(), data: acrossDepositData({ from: FROM, recipient: OTHER, value, quoteTimestamp: QUOTE_TS, ...opts }) }),
      ],
    };
  }
  const monCtx = (over: Partial<PlanContext> = {}) => ctx({ chainId: MONAD, toChainId: 8453, recipient: OTHER, balance: MON_BAL, nonce: 7, ...over });

  it('accepts an Across plan whose arithmetic is exact, and hands back the Settler and expiry to confirm', () => {
    const plan = acrossPlan();
    expect(totalSpend(plan)).toBe(MON_BAL);
    expect(verifyPlan(plan, monCtx())).toEqual({ across: { settler: ACROSS.settler, expiresAt: QUOTE_TS + 3600 } });
  });

  it('refuses a gas-limit plan where value + limit x price is not the balance', () => {
    expect(() => verifyPlan(acrossPlan({}, -1n), monCtx())).toThrow(/exactly 0/);
    expect(() => verifyPlan(acrossPlan({}, 1n), monCtx())).toThrow(/exactly 0/);
  });

  it('a plain transfer on a gas-limit chain is exactly 21,000', () => {
    const plan = acrossPlan();
    plan.txs[0]!.gas = '21001';
    plan.txs[1]!.value = (BigInt(plan.txs[1]!.value) - MON_PRICE).toString();
    expect(totalSpend(plan)).toBe(MON_BAL);
    expect(() => verifyPlan(plan, monCtx())).toThrow(/more than 21,000/);
  });

  it('refuses a tampered Across deposit before anything is signed', () => {
    const stranger = '0x4444444444444444444444444444444444444444';
    const cases: Array<[Partial<Parameters<typeof acrossDepositData>[0]>, RegExp]> = [
      [{ fallback: stranger }, /fallback recipient/],
      [{ drainTo: stranger }, /drain pays someone/],
      [{ spokePool: stranger }, /not Across's SpokePool/],
      [{ handler: stranger }, /handler for the destination/],
      [{ depositor: stranger }, /refunds go to/],
      [{ toChainId: 42161 }, /goes to chain 42161/],
      [{ submissionFee: 1n }, /submission fee/],
      [{ slippageRecipient: stranger }, /swap pays someone/],
      [{ minAmountOut: RECEIVE - 1n }, /less than the amount shown/],
      [{ extraCall: { target: ACROSS.baseUsdc, callData: transferCall(stranger) } }, /not one the handler route uses/],
      [{ extraCall: { target: stranger, callData: '0xd836083e', value: 1n } }, /carries value/],
    ];
    for (const [over, reason] of cases) expect(() => verifyPlan(acrossPlan(over), monCtx()), String(reason)).toThrow(reason);
    const elsewhere = acrossPlan();
    elsewhere.txs[1]!.to = stranger;
    expect(() => verifyPlan(elsewhere, monCtx())).toThrow(/not the Across periphery/);
    // The deposit's amount must be the value sent
    const swapped = acrossPlan();
    swapped.txs[1]!.data = acrossDepositData({ from: FROM, recipient: OTHER, value: 1n, quoteTimestamp: QUOTE_TS });
    expect(() => verifyPlan(swapped, monCtx())).toThrow(/amount swapped is not the amount sent/);
  });

  it('Across only on gas-limit chains, and never with nothing shown as arriving', () => {
    const avax = { ...acrossPlan(), chainId: 43114 };
    expect(() => verifyPlan(avax, monCtx({ chainId: 43114 }))).toThrow(/only used on chains that charge the whole gas limit/);
    expect(() => verifyPlan({ ...acrossPlan(), receive: '0' }, monCtx())).toThrow(/nothing arriving/);
  });
});

describe('verifyPlan: a token exit through the chain\'s own bridge (Telos -> TLOS on Base)', () => {
  const OFT = '0x02Ea28694Ae65358Be92bAFeF5Cb8C211f33Db1A';
  const SEND = parseAbi(['function sendFrom(address from, uint16 dstChainId, bytes32 toAddress, uint256 amount, (address refundAddress, address zroPaymentAddress, bytes adapterParams) callParams) payable']);
  const AP = `0x0001${(200_000).toString(16).padStart(64, '0')}` as const;
  const pad = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, '0')}` as `0x${string}`;
  const AMOUNT = 5n * 10n ** 16n;
  const telosCtx = (over: Partial<PlanContext> = {}) => ctx({ chainId: 40, toChainId: 8453, recipient: OTHER, mode: 'exit', ...over });
  function plan(o: { from?: string; dst?: number; to?: string; refund?: string; amount?: bigint; target?: string; receive?: bigint; route?: DirectPlan['route']; adapterParams?: `0x${string}`; leaveExtra?: bigint } = {}): DirectPlan {
    const data = encodeFunctionData({
      abi: SEND, functionName: 'sendFrom',
      args: [(o.from ?? FROM) as `0x${string}`, o.dst ?? 184, pad(o.to ?? OTHER), o.amount ?? AMOUNT, { refundAddress: (o.refund ?? ZERODUST_ADDRESS) as `0x${string}`, zroPaymentAddress: '0x0000000000000000000000000000000000000000', adapterParams: o.adapterParams ?? AP }],
    });
    const gas = 520_000n;
    const value = BALANCE - FEE - 21_000n * PRICE - gas * PRICE - 42_000n * PRICE - (o.leaveExtra ?? 0n);
    return {
      chainId: 40, route: o.route ?? 'oft', requestId: null, receive: String(o.receive ?? o.amount ?? AMOUNT), fee: FEE.toString(), balance: BALANCE.toString(),
      leftoverMax: String(gas * PRICE + 42_000n * PRICE + (o.leaveExtra ?? 0n)),
      txs: [tx({ kind: 'fee', to: ZERODUST_ADDRESS, value: FEE.toString() }), tx({ nonce: 5, to: o.target ?? OFT, data, value: value.toString(), gas: gas.toString() })],
    };
  }

  it('accepts the pinned OFT sending from the wallet to the recipient on Base, refund to ZeroDust', () => {
    expect(() => verifyPlan(plan(), telosCtx())).not.toThrow();
  });

  it('refuses another contract, sender, chain, recipient, a refund to the wallet, an amount it cannot carry, or a shown amount that differs', () => {
    expect(() => verifyPlan(plan({ target: OTHER }), telosCtx())).toThrow(/Telos's own bridge/);
    expect(() => verifyPlan(plan({ route: 'lifi' }), telosCtx())).toThrow(/Telos's own bridge/);
    expect(() => verifyPlan(plan({ from: OTHER }), telosCtx())).toThrow(/another wallet/);
    expect(() => verifyPlan(plan({ dst: 101 }), telosCtx())).toThrow(/another chain/);
    expect(() => verifyPlan(plan({ to: FROM }), telosCtx())).toThrow(/pays someone else/);
    expect(() => verifyPlan(plan({ refund: FROM }), telosCtx())).toThrow(/refund/);
    expect(() => verifyPlan(plan({ amount: BALANCE }), telosCtx())).toThrow(/does not fit/);
    expect(() => verifyPlan(plan({ receive: AMOUNT + 1n }), telosCtx())).toThrow(/amount shown/);
  });

  it('refuses other destination gas (it prices the fee) and a plan leaving more than the leftover transfer needs', () => {
    expect(() => verifyPlan(plan({ adapterParams: `0x0001${(5_000_000).toString(16).padStart(64, '0')}` }), telosCtx())).toThrow(/destination gas/);
    // Within the bound at exactly two plain transfers' gas; one wei more is refused
    expect(() => verifyPlan(plan({ leaveExtra: 1n }), telosCtx())).toThrow(/leaves more than the leftover transfer needs/);
  });

  it('a Telos exit to any other chain is still a LI.FI swap', () => {
    expect(() => verifyPlan(plan(), telosCtx({ toChainId: 1 }))).toThrow(/LI.FI/);
  });
});
