import { readFileSync } from 'node:fs';
import { decodeFunctionData, keccak256, parseAbi, type Hex } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ETHEREUM_FALLBACK_RPC, RPC_URLS } from '../src/chains/rpcs';
import { formatTransactionReceipt, toEventSelector, type TransactionReceipt } from 'viem';
import { CLAIM_CONTRACTS, claimCall, claimState, findWithdrawal, proveCall, readWithdrawal, withdrawalOf, type ClaimState } from '../src/sweep/claims';

// Own-bridge withdrawals read from the chain and Ethereum (sweep/claims.ts), replayed from real
// RPC answers (scripts/record-claim-fixtures.mts, 2026-10-12): ZeroDust's own test withdrawals at
// each stage, and other people's open ones for the prove and claim calls. Each recorded call
// passed eth_estimateGas on Ethereum when it was recorded (the fixture keeps the estimate).

interface Case {
  name: string;
  chainId: number;
  txHash: Hex;
  recipient: string;
  amount: string;
  state: ClaimState;
  call?: { step: 'prove' | 'claim'; to: string; dataHash: Hex; gas: string };
}
const fixture = JSON.parse(readFileSync(new URL('./fixtures/claims-2026-10-12.json', import.meta.url), 'utf8')) as {
  now: number;
  cases: Case[];
  responses: Record<string, { result?: unknown; error?: unknown }>;
};
const ETH = new URL(RPC_URLS[1]!).origin;
const ETH_2 = new URL(ETHEREUM_FALLBACK_RPC).origin;
const TEST_WALLET = '0xBd6dC8d37b1E3FeE84b04d1AE08b34f9E871958A';

/** Answers from the recording; either Ethereum RPC answers for both */
function replay(rateLimited: Set<string> = new Set()) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const origin = new URL(String(input)).origin;
    const body = JSON.parse(String(init?.body)) as { id: number; method: string; params?: unknown[] };
    const respond = (payload: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, ...(payload as object) }), { headers: { 'content-type': 'application/json' } });
    if (rateLimited.has(origin)) return respond({ error: { code: -32005, message: 'rate limit exceeded' } });
    const key = (o: string) => `${o} ${body.method} ${JSON.stringify(body.params ?? [])}`;
    const hit = fixture.responses[key(origin)] ?? (origin === ETH_2 ? fixture.responses[key(ETH)] : origin === ETH ? fixture.responses[key(ETH_2)] : undefined);
    // A chain that never saw the transaction answers null
    if (!hit && body.method === 'eth_getTransactionReceipt') return respond({ result: null });
    if (!hit) throw new Error(`not recorded: ${key(origin)}`);
    return respond(hit);
  });
}

const byName = (name: string) => fixture.cases.find((c) => c.name === name)!;

describe('own-bridge withdrawals, read from the chain and Ethereum', () => {
  beforeEach(() => { vi.stubGlobal('fetch', replay()); });
  afterEach(() => { vi.unstubAllGlobals(); });

  for (const c of fixture.cases) {
    it(`${c.name}: recipient, amount, stage${c.call ? ` and the ${c.call.step} call` : ''}`, async () => {
      const w = (await readWithdrawal(c.chainId, c.txHash))!;
      expect(w.recipient).toBe(c.recipient);
      expect(w.amount.toString()).toBe(c.amount);
      expect(await claimState(w, fixture.now)).toEqual(c.state);
      if (c.call) {
        const built = c.call.step === 'prove' ? await proveCall(w) : await claimCall(w);
        expect(built.to).toBe(c.call.to);
        expect(keccak256(built.data)).toBe(c.call.dataHash);
      }
    }, 20_000);
  }

  it('our own: the recipient is the swept wallet on Ethereum, and the dates are the chain\'s', async () => {
    const lisk = byName('lisk proved, waiting');
    expect(lisk.recipient).toBe(TEST_WALLET);
    // Proved 2026-10-10 17:58:23 UTC; Lisk's proof maturity is 7 days
    expect(lisk.state).toEqual({ stage: 'proved', until: Date.parse('2026-10-17T17:58:23Z') });
    const nova = byName('nova waiting');
    expect(nova.recipient).toBe(TEST_WALLET);
    // No exact date for Arbitrum until it is confirmed: the usual 156 hours after it was sent
    const w = (await readWithdrawal(42170, nova.txHash))!;
    expect(nova.state).toEqual({ stage: 'waiting', until: w.sentAt + 156 * 3_600_000 });
    // Gravity: G (18 decimals), not ETH
    expect(Number(byName('gravity waiting (G)').amount) / 1e18).toBeCloseTo(1125.668, 3);
  });

  it('sends every call to the pinned contract of its chain', () => {
    for (const c of fixture.cases.filter((x) => x.call)) {
      const k = CLAIM_CONTRACTS[c.chainId]!;
      const pinned = k.kind === 'arb' ? k.outbox : k.kind === 'zk' ? k.nullifier : k.kind === 'taiko' ? k.l1Bridge : k.kind === 'agglayer' ? k.bridge : k.portal;
      expect(c.call!.to).toBe(pinned);
    }
  });

  it('Lisk: the claim names whoever proved it, so any wallet can send it', async () => {
    const c = byName('lisk ready to claim');
    const built = await claimCall((await readWithdrawal(c.chainId, c.txHash))!);
    const { functionName, args } = decodeFunctionData({
      abi: parseAbi(['struct WithdrawalTransaction { uint256 nonce; address sender; address target; uint256 value; uint256 gasLimit; bytes data; }', 'function finalizeWithdrawalTransactionExternalProof(WithdrawalTransaction _tx, address _proofSubmitter)']),
      data: built.data,
    });
    expect(functionName).toBe('finalizeWithdrawalTransactionExternalProof');
    expect(args[1]).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it('Arbitrum: the Outbox call carries the withdrawal\'s own position and recipient', async () => {
    const c = byName('nova ready to claim');
    const w = (await readWithdrawal(c.chainId, c.txHash))!;
    const { args } = decodeFunctionData({
      abi: parseAbi(['function executeTransaction(bytes32[] proof, uint256 index, address l2Sender, address to, uint256 l2Block, uint256 l1Block, uint256 l2Timestamp, uint256 value, bytes data)']),
      data: (await claimCall(w)).data,
    });
    expect(args[1]).toBe(w.arb!.position);
    expect(args[3]).toBe(w.recipient);
    expect(args[7]).toBe(w.amount);
  });

  it('finds a withdrawal by its hash alone, on whichever chain has it', async () => {
    const nova = byName('nova ready to claim');
    const w = await findWithdrawal(nova.txHash);
    expect(w?.chainId).toBe(42170);
    expect(w?.recipient).toBe(nova.recipient);
    expect(await findWithdrawal(`0x${'ab'.repeat(32)}`)).toBeNull();
  });

  it('reads nothing on a chain without a pinned own bridge', async () => {
    expect(await readWithdrawal(10, byName('lisk ready to prove').txHash)).toBeNull();
  });
});

describe('only the chains\' own contracts count (a pasted hash may be anyone\'s transaction)', () => {
  /** The recorded receipt of a case, as viem returns it, for doctoring */
  const receiptOf = (name: string): TransactionReceipt => {
    const c = byName(name);
    const key = Object.keys(fixture.responses).find((k) => k.includes('eth_getTransactionReceipt') && k.includes(c.txHash))!;
    return formatTransactionReceipt(structuredClone(fixture.responses[key]!.result) as never);
  };
  const ARB_SYS = '0x0000000000000000000000000000000000000064';
  const PASSER = '0x4200000000000000000000000000000000000016';
  const L2_BRIDGE = '0x4200000000000000000000000000000000000010';
  const ETH_BRIDGE_INITIATED = toEventSelector('ETHBridgeInitiated(address,address,uint256,bytes)');
  const bridgeEvent = (r: TransactionReceipt) => r.logs.find((l) => l.address.toLowerCase() === L2_BRIDGE && l.topics[0] === ETH_BRIDGE_INITIATED)!;

  it('reads the real receipts', () => {
    expect(withdrawalOf(42170, receiptOf('nova waiting'), 0)?.recipient).toBe(TEST_WALLET);
    expect(withdrawalOf(1135, receiptOf('lisk proved, waiting'), 0)?.recipient).toBe(TEST_WALLET);
  });

  it('Arbitrum: an L2ToL1Tx from any other contract is ignored, and two withdrawals are refused', () => {
    const fake = receiptOf('nova waiting');
    for (const l of fake.logs) if (l.address.toLowerCase() === ARB_SYS) l.address = '0x000000000000000000000000000000000000beef';
    expect(withdrawalOf(42170, fake, 0)).toBeNull();
    const twice = receiptOf('nova waiting');
    twice.logs = [...twice.logs, ...twice.logs.filter((l) => l.address.toLowerCase() === ARB_SYS)];
    expect(withdrawalOf(42170, twice, 0)).toBeNull();
  });

  it('OP stack: a bridge event from another contract cannot name the recipient', () => {
    const fake = receiptOf('lisk proved, waiting');
    const bridgeLog = bridgeEvent(fake);
    // Someone else's contract emits the same event naming another recipient
    fake.logs.push({ ...bridgeLog, address: '0x000000000000000000000000000000000000bEEF', topics: [bridgeLog.topics[0]!, bridgeLog.topics[1]!, `0x${'00'.repeat(12)}${'ee'.repeat(20)}`] });
    expect(withdrawalOf(1135, fake, 0)?.recipient).toBe(TEST_WALLET);
    const twice = receiptOf('lisk proved, waiting');
    twice.logs = [...twice.logs, ...twice.logs.filter((l) => l.address.toLowerCase() === PASSER)];
    expect(withdrawalOf(1135, twice, 0)).toBeNull();
  });

  it('Taiko: a MessageSent from any other contract is not a withdrawal', () => {
    const real = receiptOf('taiko delivered');
    expect(withdrawalOf(167000, real, 0)?.amount).toBe(6n * 10n ** 15n);
    const fake = receiptOf('taiko delivered');
    for (const l of fake.logs) if (l.address.toLowerCase() === '0x1670000000000000000000000000000000000001') l.address = '0x000000000000000000000000000000000000bEEF';
    expect(withdrawalOf(167000, fake, 0)).toBeNull();
  });

  it('OP stack: a bridge event whose amount is not the message\'s value is refused', () => {
    const r = receiptOf('lisk proved, waiting');
    const bridgeLog = bridgeEvent(r);
    // amount is the first word of the event's data
    bridgeLog.data = `0x${(1n).toString(16).padStart(64, '0')}${bridgeLog.data.slice(66)}`;
    expect(withdrawalOf(1135, r, 0)).toBeNull();
  });
});

describe('Ethereum RPC', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('falls back to the second RPC when the first rate-limits', async () => {
    const fetch = replay(new Set([ETH]));
    vi.stubGlobal('fetch', fetch);
    const c = byName('blast claimed');
    const w = (await readWithdrawal(c.chainId, c.txHash))!;
    expect(await claimState(w, fixture.now)).toEqual({ stage: 'claimed' });
    expect(fetch.mock.calls.some(([u]) => new URL(String(u)).origin === ETH_2)).toBe(true);
  }, 20_000);
});
