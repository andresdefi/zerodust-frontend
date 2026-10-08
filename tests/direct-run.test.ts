import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeFunctionData, parseAbi } from 'viem';
import type { DirectPlan, PlanTx } from '../src/direct/plan';
import { ACROSS, acrossDepositData, addressWord } from './fixtures/across-direct';

// planChecked and broadcast against an offline API, Monad RPC and Base RPC.
// run.ts keeps per-page-load state (chain kinds, last block per chain), so
// every test loads a fresh copy of it.

const FROM = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const MONAD = 143;
const BAL = 63n * 10n ** 18n;
const PRICE = 112_200_000_000n;
const FEE = 10n ** 18n;
const GAS = 200_000n;
const RECEIVE = 714_787_782_428_686n;
const hex = (n: bigint | number) => `0x${n.toString(16)}`;
const nowS = () => Math.floor(Date.now() / 1000);

function acrossPlan(quoteTimestamp: number): DirectPlan {
  const value = BAL - FEE - 21_000n * PRICE - GAS * PRICE;
  const tx = (o: Partial<PlanTx>): PlanTx => ({ kind: 'sweep', to: OTHER, data: '0x', value: '0', gas: '21000', gasPrice: PRICE.toString(), nonce: 7, ...o });
  return {
    chainId: MONAD, route: 'across', requestId: null, receive: RECEIVE.toString(), fee: FEE.toString(), balance: BAL.toString(),
    txGapBlocks: 4,
    // The page never takes the API's word for this
    expiresAt: nowS() + 100_000,
    txs: [
      tx({ kind: 'fee', to: '0x01eD5c94DE39E73C986b98B85C2c0A3d1BEDff7D', value: FEE.toString() }),
      tx({ nonce: 8, to: ACROSS.periphery, gas: GAS.toString(), value: value.toString(), data: acrossDepositData({ from: FROM, recipient: OTHER, value, quoteTimestamp }) }),
    ],
  };
}

interface Net {
  plan?: DirectPlan;
  /** The chain's own eth_gasPrice */
  networkPrice?: bigint;
  kind?: string;
  settler?: string;
  log: string[];
  head: number;
}

function network(net: Net) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const reply = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
    if (url.includes('/direct/chains')) return new Response(JSON.stringify({ chains: [{ chainId: MONAD, name: 'Monad', token: 'MON', decimals: 18, explorerUrl: '', rpcUrl: '', kind: net.kind ?? 'gaslimit' }], prices: {} }));
    if (url.includes('/direct/prepare')) return new Response(JSON.stringify(net.plan));
    const { method, params } = JSON.parse(String(init!.body)) as { method: string; params: unknown[] };
    net.log.push(method);
    if (url.includes('base')) {
      // 0x's registry on the destination: ownerOf(2), prev(2)
      return reply(addressWord(String((params[0] as { data: string }).data).startsWith('0x6352211e') ? (net.settler ?? ACROSS.settler) : '0x7747F8D2a76BD6345Cc29622a946A929647F2359'));
    }
    const isUser = String(params[0]).toLowerCase() === FROM;
    switch (method) {
      case 'eth_getBalance': return reply(hex(isUser ? BAL : 0n));
      case 'eth_getTransactionCount': return reply(hex(isUser ? 7 : 0));
      case 'eth_getCode': return reply('0x');
      case 'eth_gasPrice': return reply(hex(net.networkPrice ?? 102_000_000_000n));
      case 'eth_getStorageAt': return reply(hex(0));
      case 'eth_getBlockByNumber': return reply({ number: hex(1000), timestamp: hex(nowS()), gasLimit: hex(200_000_000) });
      case 'eth_blockNumber': net.head += 1; return reply(hex(net.head));
      case 'eth_sendRawTransaction': return reply(`0x${String(net.log.filter((m) => m === 'eth_sendRawTransaction').length).padStart(64, '0')}`);
      case 'eth_getTransactionReceipt': return reply({ status: '0x1', blockNumber: hex(100) });
      default: throw new Error(`unexpected ${method}`);
    }
  });
}

const target = { chainId: MONAD, toChainId: 8453, from: FROM, recipient: OTHER };
let run: typeof import('../src/direct/run');

beforeEach(async () => {
  vi.resetModules();
  run = await import('../src/direct/run');
});
afterEach(() => vi.unstubAllGlobals());

describe('planChecked: Across on Monad', () => {
  it('confirms the Settler on the destination and takes the expiry from the deposit, not the API', async () => {
    const quoteTimestamp = nowS() - 3570;
    const net: Net = { plan: acrossPlan(quoteTimestamp), log: [], head: 100 };
    vi.stubGlobal('fetch', network(net));
    const plan = await run.planChecked(target, 'route');
    expect(plan.expiresAt).toBe(quoteTimestamp + 3600);
    expect(net.log.filter((m) => m === 'eth_call')).toHaveLength(2);
  });

  it('refuses a Settler 0x\'s registry does not list', async () => {
    vi.stubGlobal('fetch', network({ plan: acrossPlan(nowS() - 3570), settler: '0x5555555555555555555555555555555555555555', log: [], head: 100 }));
    await expect(run.planChecked(target, 'route')).rejects.toThrow(/registered Settler/);
  });

  it('refuses a gas price more than twice the chain\'s own (the balance would go on gas)', async () => {
    const net: Net = { plan: acrossPlan(nowS()), log: [], head: 0, networkPrice: PRICE / 2n - 1n };
    vi.stubGlobal('fetch', network(net));
    await expect(run.planChecked(target, 'route')).rejects.toThrow(/gas price is far above/);
  });

  it('refuses when the API and the page disagree on the chain\'s gas rule', async () => {
    vi.stubGlobal('fetch', network({ plan: acrossPlan(nowS() - 3570), kind: 'evm', log: [], head: 100 }));
    await expect(run.planChecked(target, 'route')).rejects.toThrow(/disagree on how this chain charges gas/);
  });

  it('refuses a quote that expires before it could be signed', async () => {
    vi.stubGlobal('fetch', network({ plan: acrossPlan(nowS() - 3595), log: [], head: 100 }));
    await expect(run.planChecked(target, 'route')).rejects.toThrow(/expired while it was being checked/);
  });
});

describe('broadcast on Monad', () => {
  it('sends the sweep only once the chain is 4 blocks past the fee transfer\'s block', async () => {
    const net: Net = { log: [], head: 100 };
    vi.stubGlobal('fetch', network(net));
    const plan = { ...acrossPlan(nowS() - 3570), expiresAt: nowS() + 25 };
    const out = await run.broadcast(plan, ['0xf801', '0xf802']);
    expect(out).toMatchObject({ ok: true, feePaidTx: `0x${'1'.padStart(64, '0')}` });
    const sends = net.log.map((m, i) => [m, i] as const).filter(([m]) => m === 'eth_sendRawTransaction').map(([, i]) => i);
    // Between the two sends: the head was polled up to block 104 (receipt block 100 + 4)
    expect(net.log.slice(sends[0], sends[1]).filter((m) => m === 'eth_blockNumber')).toHaveLength(4);
  });

  it('does not send an Across sweep whose deposit has expired; the fee stays recorded', async () => {
    const net: Net = { log: [], head: 100 };
    vi.stubGlobal('fetch', network(net));
    const plan = { ...acrossPlan(nowS() - 3570), expiresAt: nowS() + 2 };
    const out = await run.broadcast(plan, ['0xf801', '0xf802']);
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/expired before the sweep could be sent/);
    expect(out.feePaidTx).toBeDefined();
    expect(net.log.filter((m) => m === 'eth_sendRawTransaction')).toHaveLength(1);
  });
});

describe('planChecked: a fixed-price chain (Telos)', () => {
  const TELOS = 40;
  const NETWORK = 5_254_371_152_317n;
  const telosTarget = { chainId: TELOS, toChainId: TELOS, from: FROM, recipient: OTHER };
  const telosPlan = (price: bigint): DirectPlan => {
    const bal = 80n * 10n ** 18n;
    return {
      chainId: TELOS, route: 'transfer', requestId: null, fee: '0', balance: bal.toString(), receive: (bal - 21_000n * price).toString(),
      txs: [{ kind: 'sweep', to: OTHER, data: '0x', value: (bal - 21_000n * price).toString(), gas: '21000', gasPrice: price.toString(), nonce: 0 }],
    };
  };
  const telosNet = (plan: DirectPlan, kind = 'fixedprice', wrapped = 0n, lzFee = 3n * 10n ** 18n) => vi.fn(async (url: string, init?: RequestInit) => {
    const reply = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
    if (url.includes('/direct/chains')) return new Response(JSON.stringify({ chains: [{ chainId: TELOS, name: 'Telos', token: 'TLOS', decimals: 18, explorerUrl: '', rpcUrl: '', kind }], prices: {} }));
    if (url.includes('/direct/prepare') || url.includes('/direct/exit')) return new Response(JSON.stringify(plan));
    const { method } = JSON.parse(String(init!.body)) as { method: string };
    if (method === 'eth_gasPrice') return reply(hex(NETWORK));
    if (method === 'eth_call') {
      const data = String((JSON.parse(String(init!.body)) as { params: [{ data: string }] }).params[0].data);
      // estimateSendFee: LayerZero's fee for the send; balanceOf: the wallet's wrapped TLOS
      if (data.startsWith('0x365260b4')) return reply(`0x${lzFee.toString(16).padStart(64, '0')}${'0'.repeat(64)}`);
      return reply(hex(wrapped));
    }
    if (method === 'eth_getBalance') return reply(hex(80n * 10n ** 18n));
    if (method === 'eth_getTransactionCount') return reply('0x0');
    throw new Error(`stop after the price check: ${method}`);
  });

  it('refuses a plan priced above the network price (it would be charged less and leave dust)', async () => {
    vi.stubGlobal('fetch', telosNet(telosPlan((NETWORK * 11n) / 10n)));
    await expect(run.planChecked(telosTarget, 'route')).rejects.toThrow(/not the network gas price/);
  });

  it('passes the price check when the plan offers exactly the network price', async () => {
    vi.stubGlobal('fetch', telosNet(telosPlan(NETWORK)));
    await expect(run.planChecked(telosTarget, 'route')).rejects.not.toThrow(/gas price|disagree/);
  });

  it('refuses a token exit from a wallet holding wrapped TLOS on the bridge (it would be spent first)', async () => {
    vi.stubGlobal('fetch', telosNet({ ...telosPlan(NETWORK), route: 'oft' }, 'fixedprice', 1n));
    await expect(run.planChecked({ ...telosTarget, toChainId: 8453 }, 'exit')).rejects.toThrow(/wrapped TLOS/);
  });

  it("refuses a token exit whose bridge fee is above LayerZero's own quote (the excess would go to ZeroDust)", async () => {
    const OFT = '0x02Ea28694Ae65358Be92bAFeF5Cb8C211f33Db1A';
    const AP = `0x0001${(200_000).toString(16).padStart(64, '0')}` as const;
    const bal = 80n * 10n ** 18n;
    const gas = 520_000n;
    const value = bal - gas * NETWORK - 42_000n * NETWORK;
    const exitPlan = (amount: bigint): DirectPlan => ({
      chainId: TELOS, route: 'oft', requestId: null, fee: '0', balance: bal.toString(), receive: amount.toString(),
      leftoverMax: String(gas * NETWORK + 42_000n * NETWORK),
      txs: [{ kind: 'sweep', to: OFT, value: value.toString(), gas: gas.toString(), gasPrice: NETWORK.toString(), nonce: 0,
        data: encodeFunctionData({ abi: parseAbi(['function sendFrom(address from, uint16 dstChainId, bytes32 toAddress, uint256 amount, (address refundAddress, address zroPaymentAddress, bytes adapterParams) callParams) payable']), functionName: 'sendFrom',
          args: [FROM, 184, `0x${OTHER.slice(2).padStart(64, '0')}`, amount, { refundAddress: '0x01eD5c94DE39E73C986b98B85C2c0A3d1BEDff7D', zroPaymentAddress: '0x0000000000000000000000000000000000000000', adapterParams: AP }] }) }],
    });
    const target = { ...telosTarget, toChainId: 8453 };
    // A tenth of the value bridged: the rest would be "fee", refunded to ZeroDust
    vi.stubGlobal('fetch', telosNet(exitPlan(10n ** 18n), 'fixedprice', 0n));
    await expect(run.planChecked(target, 'exit')).rejects.toThrow(/above what the bridge quotes/);
    // The quoted 3 TLOS fee with 10%: past the fee check (the replay then runs, and this mock stops it)
    const amount = ((value - 33n * 10n ** 17n) / 10n ** 14n) * 10n ** 14n;
    vi.stubGlobal('fetch', telosNet(exitPlan(amount), 'fixedprice', 0n));
    await expect(run.planChecked(target, 'exit')).rejects.not.toThrow(/above what the bridge quotes|refused/);
  });

  it('refuses when the API does not call Telos a fixed-price chain', async () => {
    vi.stubGlobal('fetch', telosNet(telosPlan(NETWORK), 'evm'));
    await expect(run.planChecked(telosTarget, 'route')).rejects.toThrow(/disagree on how this chain prices gas/);
  });
});
