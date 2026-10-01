import { describe, expect, it } from 'vitest';
import { BURN_ADDRESS, GASZIP_DEPOSIT, LIFI_DIAMOND, ZERODUST_ADDRESS, type DirectPlan, type PlanTx } from '../src/direct/plan';
import { totalSpend, verifyPlan, type PlanContext } from '../src/direct/verify';

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

  it('Relay: only a depositNative crediting this wallet', () => {
    const data = (depositor: string) => `0x49290c1c000000000000000000000000${depositor.slice(2)}${'ee'.repeat(32)}`;
    expect(() => verifyPlan(routePlan({ to: OTHER, data: data(FROM), gas: '24830' }, 'relay'), ctx())).not.toThrow();
    expect(() => verifyPlan(routePlan({ to: OTHER, data: data(OTHER), gas: '24830' }, 'relay'), ctx())).toThrow(/credit this wallet/);
    expect(() => verifyPlan(routePlan({ to: OTHER, data: '0xdeadbeef', gas: '24830' }, 'relay'), ctx())).toThrow(/plain deposit/);
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
