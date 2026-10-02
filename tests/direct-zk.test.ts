import { describe, expect, it } from 'vitest';
import { recoverTypedDataAddress, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { chainConfig, parseEip712Transaction } from 'viem/zksync';
import { GASZIP_DEPOSIT, PAYMASTER_GENERAL, ZK_PAYMASTERS, type DirectPlan, type PlanTx } from '../src/direct/plan';
import { signPlan } from '../src/direct/run';
import { verifyPlan, type PlanContext } from '../src/direct/verify';

// ZK-stack chains: the paymaster pays all gas, so a plan leaves exactly 0 when its values add up
// to the balance; every transaction must name ZeroDust's paymaster (pinned in the page).
const ZK = 324;
const PAYMASTER = ZK_PAYMASTERS[ZK]!;
const FROM = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const PRICE = 49_775_000n;
const BALANCE = 739_123_035_883_107n;
const SERVICE = 18_776_874_401_487n;
const FEE_GAS = 175_662n;
const SWEEP_GAS = 226_268n;
const GAS_FEE = (FEE_GAS + SWEEP_GAS) * PRICE;
const INPUT = `${PAYMASTER_GENERAL}${'00'.repeat(64)}`;

const tx = (over: Partial<PlanTx>): PlanTx => ({
  kind: 'sweep', to: OTHER, data: '0x', value: '0', gas: SWEEP_GAS.toString(), gasPrice: PRICE.toString(), nonce: 0,
  paymaster: PAYMASTER, paymasterInput: INPUT, gasPerPubdata: '50000', ...over,
});

function zkPlan(over: Partial<DirectPlan> = {}, fee: Partial<PlanTx> = {}, sweep: Partial<PlanTx> = {}): DirectPlan {
  const feeValue = SERVICE + GAS_FEE;
  return {
    chainId: ZK, route: 'gaszip', requestId: null, receive: '1', fee: SERVICE.toString(), gasFee: GAS_FEE.toString(), balance: BALANCE.toString(),
    txs: [
      tx({ kind: 'fee', to: PAYMASTER, value: feeValue.toString(), gas: FEE_GAS.toString(), ...fee }),
      tx({ nonce: 1, to: GASZIP_DEPOSIT, data: '0x010036', value: (BALANCE - feeValue).toString(), ...sweep }),
    ],
    ...over,
  };
}

const ctx = (over: Partial<PlanContext> = {}): PlanContext => ({ chainId: ZK, toChainId: 8453, from: FROM, recipient: FROM, mode: 'route', balance: BALANCE, nonce: 0, ...over });

describe('ZK-stack plans', () => {
  it('accepts a fee + sweep whose values add up to the balance, gas paid by the paymaster', () => {
    expect(() => verifyPlan(zkPlan(), ctx())).not.toThrow();
  });

  it('accepts the sweep alone (credit left at the paymaster by an earlier fee)', () => {
    const plan = zkPlan({ fee: '0', gasFee: '0', txs: [tx({ to: GASZIP_DEPOSIT, data: '0x010036', value: BALANCE.toString() })] });
    expect(() => verifyPlan(plan, ctx())).not.toThrow();
  });

  it('refuses another paymaster, another flow, or a plan without one', () => {
    const stranger = '0x3333333333333333333333333333333333333333';
    expect(() => verifyPlan(zkPlan({}, {}, { paymaster: stranger }), ctx())).toThrow(/ZeroDust's paymaster/);
    expect(() => verifyPlan(zkPlan({}, { paymasterInput: '0x949431dc' }), ctx())).toThrow(/general flow/);
    expect(() => verifyPlan(zkPlan({}, {}, { paymaster: undefined, paymasterInput: undefined }), ctx())).toThrow(/ZeroDust's paymaster/);
  });

  it('refuses values that do not add up to the balance', () => {
    expect(() => verifyPlan(zkPlan({}, {}, { value: (BALANCE - SERVICE - GAS_FEE - 1n).toString() }), ctx())).toThrow(/exactly 0/);
  });

  it('refuses a fee that is not to the paymaster, not fee + gas, above 5%, or prepaying more gas than possible', () => {
    expect(() => verifyPlan(zkPlan({}, { to: OTHER }), ctx())).toThrow(/does not go to the paymaster/);
    expect(() => verifyPlan(zkPlan({ gasFee: (GAS_FEE - 1n).toString() }), ctx())).toThrow(/not the fee plus the gas/);
    const big = BALANCE / 10n;
    expect(() => verifyPlan(zkPlan({ fee: big.toString() }, { value: (big + GAS_FEE).toString() }, { value: (BALANCE - big - GAS_FEE).toString() }), ctx())).toThrow(/above 5%/);
    const over = GAS_FEE + 1n;
    expect(() => verifyPlan(zkPlan({ gasFee: over.toString() }, { value: (SERVICE + over).toString() }, { value: (BALANCE - SERVICE - over).toString() }), ctx())).toThrow(/more gas/);
  });

  it('refuses a paymaster on a chain that does not use one', () => {
    const plan = zkPlan({ chainId: 43114 });
    expect(() => verifyPlan(plan, ctx({ chainId: 43114 }))).toThrow(/does not use one/);
  });

  it('signs each transaction as ZKsync type 113, by the wallet, with the plan exactly as given', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const plan = zkPlan();
    const raws = await signPlan(account, plan);
    expect(raws).toHaveLength(2);
    for (const [i, raw] of raws.entries()) {
      expect(raw.slice(0, 4)).toBe('0x71');
      const parsed = parseEip712Transaction(raw);
      const t = plan.txs[i]!;
      expect(parsed).toMatchObject({ chainId: ZK, value: BigInt(t.value), nonce: t.nonce, gas: BigInt(t.gas), paymasterInput: INPUT });
      expect(parsed.to?.toLowerCase()).toBe(t.to.toLowerCase());
      expect(parsed.paymaster?.toLowerCase()).toBe(PAYMASTER.toLowerCase());
      const domain = chainConfig.custom.getEip712Domain({ ...parsed, from: account.address, type: 'eip712' } as never) as Record<string, unknown>;
      const signer = await recoverTypedDataAddress({ ...domain, signature: parsed.customSignature as Hex } as never);
      expect(signer).toBe(account.address);
    }
  });
});
