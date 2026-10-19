import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeFunctionData, parseAbi, type Hex } from 'viem';
import { groupOf, type AddressChain } from '../src/address/groups';
import { ZERODUST_ADDRESS, ZK_PAYMASTERS, type DirectPlan, type PlanTx } from '../src/direct/plan';
import { checkNativeCall, NATIVE_BRIDGE_CONTRACT, verifyPlan, type PlanContext } from '../src/direct/verify';
import {
  addPendingClaim, claimableFrom, claimCostWei, DONE_KEEP_MS, markClaimDone, NATIVE_EXITS, nativeSummary, pendingClaimsOf, removePendingClaim, startByMs, waitText,
  type PendingClaim,
} from '../src/sweep/native';

// A chain's own bridge to Ethereum (owner, 2026-10-12: only where no other route exists). The page
// pins the chains and checks each plan's withdrawal itself: contract, recipient, 1:1 amount.

const FROM = '0x1111111111111111111111111111111111111111';
const TO = '0x2222222222222222222222222222222222222222';
const STRANGER = '0x3333333333333333333333333333333333333333';
const NOVA = 42170;
const GRAVITY = 1625;
const ABSTRACT = 2741;
const BLAST = 81457;
const LISK = 1135;

const OP = parseAbi(['function bridgeETHTo(address _to, uint32 _minGasLimit, bytes _extraData) payable']);
const ARB = parseAbi(['function withdrawEth(address destination) payable returns (uint256)']);
const ZK = parseAbi(['function withdraw(address _l1Receiver) payable']);
const opData = (to: string, gas = 200_000, extra: Hex = '0x') => encodeFunctionData({ abi: OP, functionName: 'bridgeETHTo', args: [to as Hex, gas, extra] });
const arbData = (to: string) => encodeFunctionData({ abi: ARB, functionName: 'withdrawEth', args: [to as Hex] });
const zkData = (to: string) => encodeFunctionData({ abi: ZK, functionName: 'withdraw', args: [to as Hex] });

describe('checkNativeCall', () => {
  it('accepts each stack\'s withdrawal to the recipient, on Ethereum', () => {
    expect(() => checkNativeCall(BLAST, 1, NATIVE_BRIDGE_CONTRACT.op, opData(TO), TO)).not.toThrow();
    expect(() => checkNativeCall(GRAVITY, 1, NATIVE_BRIDGE_CONTRACT.arb, arbData(TO), TO)).not.toThrow();
    expect(() => checkNativeCall(ABSTRACT, 1, NATIVE_BRIDGE_CONTRACT.zk, zkData(TO), TO)).not.toThrow();
  });

  const refusals: Array<[string, () => void]> = [
    ['a withdrawal to someone else', () => checkNativeCall(GRAVITY, 1, NATIVE_BRIDGE_CONTRACT.arb, arbData(STRANGER), TO)],
    ['another contract', () => checkNativeCall(GRAVITY, 1, STRANGER, arbData(TO), TO)],
    ['another stack\'s contract', () => checkNativeCall(GRAVITY, 1, NATIVE_BRIDGE_CONTRACT.op, opData(TO), TO)],
    ['other message gas', () => checkNativeCall(BLAST, 1, NATIVE_BRIDGE_CONTRACT.op, opData(TO, 1), TO)],
    ['extra data', () => checkNativeCall(BLAST, 1, NATIVE_BRIDGE_CONTRACT.op, opData(TO, 200_000, '0x01'), TO)],
    ['calldata that is not the withdrawal', () => checkNativeCall(GRAVITY, 1, NATIVE_BRIDGE_CONTRACT.arb, '0xdeadbeef', TO)],
    ['a chain the page does not know', () => checkNativeCall(8453, 1, NATIVE_BRIDGE_CONTRACT.op, opData(TO), TO)],
    ['another destination than Ethereum', () => checkNativeCall(GRAVITY, 8453, NATIVE_BRIDGE_CONTRACT.arb, arbData(TO), TO)],
  ];
  for (const [why, run] of refusals) it(`refuses ${why}`, () => expect(run).toThrow(/Plan refused/));
});

describe('verifyPlan: own-bridge plans', () => {
  const PRICE = 1_000_000_000n;
  const BALANCE = 10n ** 18n;
  const FEE = 10n ** 16n;
  const tx = (over: Partial<PlanTx>): PlanTx => ({ kind: 'sweep', to: TO, data: '0x', value: '0', gas: '21000', gasPrice: PRICE.toString(), nonce: 0, ...over });
  const ctx = (over: Partial<PlanContext> = {}): PlanContext => ({ chainId: GRAVITY, toChainId: 1, from: FROM, recipient: TO, mode: 'route', balance: BALANCE, nonce: 0, bridge: 'native', ...over });

  /** Gravity: a fee to ZeroDust, then ArbSys.withdrawEth(recipient) with the rest, 1:1 */
  function gravityPlan(o: { data?: string; receive?: bigint } = {}): DirectPlan {
    const gas = 120_000n;
    const value = BALANCE - FEE - 21_000n * PRICE - gas * PRICE;
    return {
      chainId: GRAVITY, route: 'native', requestId: null, receive: (o.receive ?? value).toString(), fee: FEE.toString(), balance: BALANCE.toString(),
      txs: [tx({ kind: 'fee', to: ZERODUST_ADDRESS, value: FEE.toString() }), tx({ nonce: 1, to: NATIVE_BRIDGE_CONTRACT.arb, data: o.data ?? arbData(TO), value: value.toString(), gas: gas.toString() })],
    };
  }

  it('accepts a plain chain\'s withdrawal that spends the balance and shows what goes in', () => {
    expect(verifyPlan(gravityPlan(), ctx())).toEqual({ native: true });
  });

  it('refuses an own-bridge plan nobody chose, and a plan without it when it was chosen', () => {
    // To Ethereum, the API could otherwise swap a fast bridge for a withdrawal that waits days for a claim
    expect(() => verifyPlan(gravityPlan(), ctx({ bridge: undefined }))).toThrow(/own bridge, which you did not choose/);
    const relay = { ...gravityPlan(), route: 'relay' as const };
    expect(() => verifyPlan(relay, ctx())).toThrow(/does not use the chain's own bridge, which you chose/);
  });

  it('refuses one that shows more than goes in, or pays someone else', () => {
    expect(() => verifyPlan(gravityPlan({ receive: 1n }), ctx())).toThrow(/amount shown/);
    expect(() => verifyPlan(gravityPlan({ data: arbData(STRANGER) }), ctx())).toThrow(/pays someone else/);
  });

  it('accepts a ZK withdrawal paid through the paymaster', () => {
    const paymaster = ZK_PAYMASTERS[ABSTRACT]!;
    const pm = { paymaster, paymasterInput: `0x8c5a3445${'0'.repeat(64)}`, gasPerPubdata: '800' };
    const gasFee = 10n ** 14n;
    const value = BALANCE - FEE - gasFee;
    const plan: DirectPlan = {
      chainId: ABSTRACT, route: 'native', requestId: null, receive: value.toString(), fee: FEE.toString(), gasFee: gasFee.toString(), balance: BALANCE.toString(),
      txs: [tx({ kind: 'fee', to: paymaster, value: (FEE + gasFee).toString(), gas: '50000', ...pm }), tx({ nonce: 1, to: NATIVE_BRIDGE_CONTRACT.zk, data: zkData(TO), value: value.toString(), gas: '50000', ...pm })],
    };
    expect(verifyPlan(plan, ctx({ chainId: ABSTRACT }))).toEqual({ native: true });
  });
});

describe('groupOf: the claim group', () => {
  const chain = (chainId: number, over: Partial<AddressChain> = {}): AddressChain => ({ chainId, name: String(chainId), token: 'ETH', decimals: 18, balance: 1n, explorerUrl: '', direct: false, metamask: false, ...over });

  it('takes a chain with its own bridge only when nothing else takes it out', () => {
    expect(groupOf(chain(NOVA), { gas: false }, 8453)).toBe('claim');
    expect(groupOf(chain(GRAVITY, { direct: true }), { gas: false }, 8453)).toBe('claim');
  });

  it('leaves it where a bridge, another destination or a minimum still applies', () => {
    expect(groupOf(chain(NOVA), { gas: true }, 8453)).toBe('gas');
    expect(groupOf(chain(LISK), { gas: false, notToDestination: true }, 8453)).toBe('elsewhere');
    expect(groupOf(chain(BLAST, { direct: true }), { gas: false, minimum: 10n }, 8453)).toBe('gas');
    expect(groupOf(chain(BLAST, { direct: true }), { gas: null }, 8453)).toBe('gas');
    // No own bridge: stays on its chain
    expect(groupOf(chain(8217), { gas: false }, 8453)).toBe('own-chain');
  });
});

describe('steps, costs and dates', () => {
  it('says when each chain is proved and claimed, and what arrives, before signing', () => {
    const lisk = nativeSummary(NATIVE_EXITS[LISK]!, 'Lisk');
    expect(lisk.when).toMatch(/^Prove it within a few hours, then claim it after about/);
    expect(lisk.arrives).toBe('Arrives as ETH on Ethereum');
    const gravity = nativeSummary(NATIVE_EXITS[GRAVITY]!, 'Gravity');
    expect(gravity.when).not.toMatch(/prove/i);
    expect(gravity.arrives).toBe('Arrives as G (Gravity), a token on Ethereum, not ETH');
    expect(waitText(NATIVE_EXITS[NOVA]!)).toBe('about 6.5 days');
    expect(waitText(NATIVE_EXITS[BLAST]!)).toBe('about a day');
  });

  it('prices the prove and the claim at the given gas', () => {
    // OP stack: a prove (450k) and a claim (250k: our Blast claims used 244k)
    expect(claimCostWei(NATIVE_EXITS[LISK]!, 1n)).toBe(700_000n);
    expect(claimCostWei(NATIVE_EXITS[NOVA]!, 2n)).toBe(300_000n);
    expect(claimCostWei(NATIVE_EXITS[ABSTRACT]!, 1n)).toBe(190_000n);
  });

  it('starts a closing chain early enough for every step that reads it', () => {
    const closes = Date.parse('2026-11-01T00:00:00Z');
    // Gravity: the claim's proof comes from the chain once confirmed (156 h), plus a day
    expect(new Date(startByMs(NATIVE_EXITS[GRAVITY]!, closes)).toISOString()).toBe('2026-10-24T12:00:00.000Z');
    // Lisk: only the prove needs the chain (12 h), plus a day
    expect(new Date(startByMs(NATIVE_EXITS[LISK]!, closes)).toISOString()).toBe('2026-10-30T12:00:00.000Z');
  });
});

describe('pending claims (this browser only)', () => {
  let store: Record<string, string>;
  beforeEach(() => {
    store = {};
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v; },
    });
  });
  afterEach(() => vi.unstubAllGlobals());
  const claim = (over: Partial<PendingClaim> = {}): PendingClaim => ({
    chainId: NOVA, chainName: 'Arbitrum Nova', explorerUrl: 'https://nova.arbiscan.io', symbol: 'ETH', decimals: 18,
    from: FROM, recipient: TO, amount: '1730925974698840', txHash: '0xa6f1', sentAt: Date.parse('2026-10-10T19:06:21Z'), ...over,
  });

  it('keeps each withdrawal once, lists them per swept wallet, newest first, and forgets on request', () => {
    addPendingClaim(claim());
    addPendingClaim(claim());
    addPendingClaim(claim({ txHash: '0xb2', sentAt: Date.parse('2026-10-11T00:00:00Z') }));
    addPendingClaim(claim({ txHash: '0xc3', from: STRANGER }));
    expect(pendingClaimsOf(FROM.toUpperCase().replace('0X', '0x')).map((c) => c.txHash)).toEqual(['0xb2', '0xa6f1']);
    removePendingClaim('0xB2');
    expect(pendingClaimsOf(FROM).map((c) => c.txHash)).toEqual(['0xa6f1']);
    expect(new Date(claimableFrom(claim())).toISOString()).toBe('2026-10-17T07:06:21.000Z');
  });

  it('a delivered or claimed withdrawal leaves the list by itself 10 minutes after it is first seen done', () => {
    const t0 = Date.parse('2026-10-19T15:00:00Z');
    addPendingClaim(claim());
    addPendingClaim(claim({ txHash: '0xb2' }));
    markClaimDone('0xA6F1', t0);
    // Seen done again later: the countdown does not restart
    markClaimDone('0xa6f1', t0 + 5 * 60_000);
    expect(DONE_KEEP_MS).toBe(10 * 60_000);
    expect(pendingClaimsOf(FROM, t0 + DONE_KEEP_MS - 1).map((c) => c.txHash)).toEqual(['0xa6f1', '0xb2']);
    expect(pendingClaimsOf(FROM, t0 + DONE_KEEP_MS).map((c) => c.txHash)).toEqual(['0xb2']);
    // Gone from the store too, not only hidden
    expect(JSON.parse(store['zd.pending-claims.v1']!).map((c: PendingClaim) => c.txHash)).toEqual(['0xb2']);
  });

  it('drops unknown chains and survives broken storage', () => {
    store['zd.pending-claims.v1'] = JSON.stringify([claim({ chainId: 8453 }), claim()]);
    expect(pendingClaimsOf(FROM)).toHaveLength(1);
    store['zd.pending-claims.v1'] = '{not json';
    expect(pendingClaimsOf(FROM)).toEqual([]);
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } });
    expect(pendingClaimsOf(FROM)).toEqual([]);
    expect(() => addPendingClaim(claim())).not.toThrow();
  });
});

describe('planChecked: Arbitrum-stack own-bridge plans (no fork can run ArbSys)', () => {
  const PRICE = 1_000_000_000n;
  const BALANCE = 10n ** 18n;
  const FEE = 10n ** 16n;
  const USED = { fee: 21_000n, sweep: 120_000n };
  const hex = (n: bigint | number) => `0x${n.toString(16)}`;
  const plan = (feeGas = USED.fee, sweepGas = USED.sweep): DirectPlan => {
    const value = BALANCE - FEE - feeGas * PRICE - sweepGas * PRICE;
    const tx = (o: Partial<PlanTx>): PlanTx => ({ kind: 'sweep', to: TO, data: '0x', value: '0', gas: '21000', gasPrice: PRICE.toString(), nonce: 3, ...o });
    return {
      chainId: GRAVITY, route: 'native', requestId: null, receive: value.toString(), fee: FEE.toString(), balance: BALANCE.toString(),
      txs: [tx({ kind: 'fee', to: ZERODUST_ADDRESS, value: FEE.toString(), gas: feeGas.toString() }), tx({ nonce: 4, to: NATIVE_BRIDGE_CONTRACT.arb, data: arbData(TO), value: value.toString(), gas: sweepGas.toString() })],
    };
  };

  /** The chain answers eth_call with success exactly when the limit covers what the call uses */
  function chain(p: DirectPlan) {
    return vi.fn(async (url: string, init?: RequestInit) => {
      const reply = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
      if (url.includes('/direct/chains')) return new Response(JSON.stringify({ chains: [{ chainId: GRAVITY, name: 'Gravity', token: 'G', decimals: 18, explorerUrl: '', rpcUrl: '', kind: 'arbitrum' }], prices: {} }));
      if (url.includes('/direct/prepare')) return new Response(JSON.stringify(p));
      const { method, params } = JSON.parse(String(init!.body)) as { method: string; params: Array<Record<string, string>> };
      switch (method) {
        case 'eth_getBalance': return reply(hex(BALANCE));
        case 'eth_getTransactionCount': return reply(hex(3));
        case 'eth_gasPrice': return reply(hex(PRICE));
        case 'eth_getCode': return reply('0x');
        case 'eth_call': {
          const call = params[0]!;
          const used = call.to!.toLowerCase() === NATIVE_BRIDGE_CONTRACT.arb ? USED.sweep : USED.fee;
          return BigInt(call.gas!) >= used ? reply('0x') : new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'out of gas' } }));
        }
        default: return reply('0x');
      }
    });
  }
  const target = { chainId: GRAVITY, toChainId: 1, from: FROM, recipient: TO };
  afterEach(() => vi.unstubAllGlobals());

  it('accepts a plan whose every limit is exactly what the chain says it uses', async () => {
    vi.resetModules();
    vi.stubGlobal('fetch', chain(plan()));
    const run = await import('../src/direct/run');
    await expect(run.planChecked(target, 'route', undefined, 'native')).resolves.toMatchObject({ route: 'native' });
  });

  it('refuses a fee transfer or a withdrawal with more gas than it uses (the refund would be dust)', async () => {
    for (const p of [plan(USED.fee + 5_000n), plan(USED.fee, USED.sweep + 1n)]) {
      vi.resetModules();
      vi.stubGlobal('fetch', chain(p));
      const run = await import('../src/direct/run');
      await expect(run.planChecked(target, 'route', undefined, 'native')).rejects.toThrow(/gas limit is not exactly what it uses/);
    }
  });

  it('refuses an own-bridge plan the owner did not ask for', async () => {
    vi.resetModules();
    vi.stubGlobal('fetch', chain(plan()));
    const run = await import('../src/direct/run');
    await expect(run.planChecked(target, 'route')).rejects.toThrow(/did not choose/);
  });
});

describe('Reya, HPP, RISE (2026-10-14): own bridges, a bridge site only where one claims ETH', () => {
  it('pins each to Ethereum with its stack', () => {
    expect(NATIVE_EXITS[1729]).toMatchObject({ chainName: 'Reya', stack: 'arb', toChainId: 1, prove: false });
    expect(NATIVE_EXITS[190415]).toMatchObject({ chainName: 'HPP', stack: 'arb', toChainId: 1, prove: false, bridge: { url: 'https://bridge.arbitrum.io', name: 'Arbitrum Bridge' } });
    expect(NATIVE_EXITS[4153]).toMatchObject({ chainName: 'RISE', stack: 'op', toChainId: 1, prove: true });
    expect(NATIVE_EXITS[1729]!.bridge).toBeUndefined();
    expect(NATIVE_EXITS[4153]!.bridge).toBeUndefined();
  });

  it('pins Codex and Metal L2 (OP Stack) to Ethereum, proved and claimed on this page', () => {
    for (const id of [81224, 1750]) {
      expect(NATIVE_EXITS[id]).toMatchObject({ stack: 'op', toChainId: 1, prove: true });
      expect(NATIVE_EXITS[id]!.bridge).toBeUndefined();
      expect(nativeSummary(NATIVE_EXITS[id]!, NATIVE_EXITS[id]!.chainName).when).toMatch(/^Prove it within a few hours, then claim it after/);
    }
  });

  it('says when and what for chains without a bridge site, with nothing left undefined', () => {
    for (const [id, name] of [[1729, 'Reya'], [190415, 'HPP'], [4153, 'RISE']] as const) {
      const says = nativeSummary(NATIVE_EXITS[id]!, name);
      expect(`${says.when} ${says.arrives}`).not.toMatch(/undefined|https:/);
    }
    expect(nativeSummary(NATIVE_EXITS[1729]!, 'Reya').when).toMatch(/^Claim it after/);
  });
});
