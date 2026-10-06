import { readFileSync } from 'node:fs';
import { decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeFunctionData, parseAbi, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { verifySponsoredAcross, type SponsoredAcrossExpect } from '../src/sweep/across-route';

// Live Across swap API answers, 2026-10-06: 2e15 wei from Base / Arbitrum to every non-ETH destination
const SAMPLES = JSON.parse(readFileSync(new URL('./fixtures/across-sponsored-2026-10-06.json', import.meta.url), 'utf8')) as Record<string, { to: string; data: Hex; minOutputAmount: string }>;
const USER = '0x820653ccE8a755edbb52eC1bc5829D2a60CD5cc5';
const EVIL = '0x000000000000000000000000000000000000dEaD';

const PERIPHERY_ABI = parseAbi([
  'function depositNative(address spokePool, address depositor, bytes32 recipient, address inputToken, uint256 inputAmount, bytes32 outputToken, uint256 outputAmount, uint256 destinationChainId, bytes32 exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityParameter, bytes message)',
  'struct Fees { uint256 amount; address recipient; }',
  'struct BaseDepositData { address inputToken; bytes32 outputToken; uint256 outputAmount; address depositor; bytes32 recipient; uint256 destinationChainId; bytes32 exclusiveRelayer; uint32 quoteTimestamp; uint32 fillDeadline; uint32 exclusivityParameter; bytes message; }',
  'struct SwapAndDepositData { Fees submissionFees; BaseDepositData depositData; address swapToken; address exchange; uint8 transferType; uint256 swapTokenAmount; uint256 minExpectedInputTokenAmount; bytes routerCalldata; bool enableProportionalAdjustment; address spokePool; uint256 nonce; }',
  'function swapAndBridge(SwapAndDepositData swapAndDepositData)',
]);
const INSTRUCTIONS = [{
  type: 'tuple',
  components: [
    { name: 'calls', type: 'tuple[]', components: [{ name: 'target', type: 'address' }, { name: 'callData', type: 'bytes' }, { name: 'value', type: 'uint256' }] },
    { name: 'fallbackRecipient', type: 'address' },
  ],
}] as const;
const UR_ABI = parseAbi(['function execute(bytes commands, bytes[] inputs)']);
const V3_INPUT = [{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'bool' }] as const;

const expect_ = (k: string, over: Partial<SponsoredAcrossExpect> = {}): SponsoredAcrossExpect => {
  const [from, to] = k.split('-').map(Number) as [number, number];
  // The receive shown is the bridge's expected output less 3%: below the swap's minimum
  return { fromChainId: from, toChainId: to, user: USER, recipient: USER, value: 2_000_000_000_000_000n, minNative: (BigInt(SAMPLES[k]!.minOutputAmount) * 97n) / 100n, ...over };
};

type Call = { target: Hex; callData: Hex; value: bigint };
type Instructions = { calls: Call[]; fallbackRecipient: Hex };

/** Rewrites a sample's destination message */
function withMessage(k: string, edit: (m: Instructions) => void): { to: string; data: Hex } {
  const s = SAMPLES[k]!;
  const d = decodeFunctionData({ abi: PERIPHERY_ABI, data: s.data });
  if (d.functionName === 'depositNative') {
    const args = [...d.args] as unknown[];
    const [m] = decodeAbiParameters(INSTRUCTIONS, args[12] as Hex) as unknown as [Instructions];
    const copy: Instructions = { calls: m.calls.map((c) => ({ ...c })), fallbackRecipient: m.fallbackRecipient };
    edit(copy);
    args[12] = encodeAbiParameters(INSTRUCTIONS, [copy]);
    return { to: s.to, data: encodeFunctionData({ abi: PERIPHERY_ABI, functionName: 'depositNative', args: args as never }) };
  }
  const a = structuredClone(d.args[0]) as unknown as { depositData: { message: Hex } };
  const [m] = decodeAbiParameters(INSTRUCTIONS, a.depositData.message) as unknown as [Instructions];
  const copy: Instructions = { calls: m.calls.map((c) => ({ ...c })), fallbackRecipient: m.fallbackRecipient };
  edit(copy);
  a.depositData.message = encodeAbiParameters(INSTRUCTIONS, [copy]);
  return { to: s.to, data: encodeFunctionData({ abi: PERIPHERY_ABI, functionName: 'swapAndBridge', args: [a as never] }) };
}

/** Rewrites a swapAndBridge sample's source-side fields */
function withSwapData(k: string, edit: (a: Record<string, unknown>) => void): { to: string; data: Hex } {
  const s = SAMPLES[k]!;
  const a = structuredClone(decodeFunctionData({ abi: PERIPHERY_ABI, data: s.data }).args![0]) as unknown as Record<string, unknown>;
  edit(a);
  return { to: s.to, data: encodeFunctionData({ abi: PERIPHERY_ABI, functionName: 'swapAndBridge', args: [a as never] }) };
}

/** Rewrites the Universal Router swap's first input in a Uniswap-shaped sample */
function withUrSwap(k: string, edit: (input: { recipient: Hex; amountIn: bigint; minOut: bigint; path: Hex; payerIsUser: boolean }) => void) {
  return withMessage(k, (m) => {
    const call = m.calls.find((c) => c.callData.startsWith('0x24856bc3'))!;
    const [commands, inputs] = decodeFunctionData({ abi: UR_ABI, data: call.callData }).args as unknown as [Hex, Hex[]];
    const [recipient, amountIn, minOut, path, payerIsUser] = decodeAbiParameters(V3_INPUT, inputs[0]!);
    const x = { recipient: recipient as Hex, amountIn, minOut, path, payerIsUser };
    edit(x);
    const next = [encodeAbiParameters(V3_INPUT, [x.recipient, x.amountIn, x.minOut, x.path, x.payerIsUser]), ...inputs.slice(1)];
    call.callData = encodeFunctionData({ abi: UR_ABI, functionName: 'execute', args: [commands, next] });
  });
}

// HyperEVM: Across drains the swap's leftover USDC to 0x1bfF...d213, a wallet in no Across deployment
// list (no code on HyperEVM): refused until it is identified
const HYPEREVM = (k: string) => k.endsWith('-999');

describe('verifySponsoredAcross: live routes', () => {
  it.each(Object.keys(SAMPLES).filter((k) => HYPEREVM(k)))('%s is refused: a leftover drain pays an unknown wallet', (k) => {
    expect(() => verifySponsoredAcross(SAMPLES[k]!, expect_(k))).toThrow(/a drain pays someone other than the address you set/);
  });

  it.each(Object.keys(SAMPLES).filter((k) => !HYPEREVM(k)))('%s passes, paying only the address you set', (k) => {
    const { settler } = verifySponsoredAcross(SAMPLES[k]!, expect_(k));
    // Uniswap-shaped routes (BNB Chain, Polygon) have no Settler; 0x-shaped ones name one to confirm on-chain
    if (k.endsWith('-56') || k.endsWith('-137')) expect(settler).toBeNull();
    else expect(settler).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it.each(Object.keys(SAMPLES))('%s is refused for another recipient', (k) => {
    expect(() => verifySponsoredAcross(SAMPLES[k]!, expect_(k, { recipient: EVIL }))).toThrow(/^Across route refused: /);
  });

  it.each(Object.keys(SAMPLES))('%s is refused when refunds would go to another wallet, or the amount differs', (k) => {
    expect(() => verifySponsoredAcross(SAMPLES[k]!, expect_(k, { user: EVIL }))).toThrow(/refunds go to/);
    expect(() => verifySponsoredAcross(SAMPLES[k]!, expect_(k, { value: 1n }))).toThrow(/not the amount sent/);
  });

  it('refuses a destination swap that may deliver less than the amount shown', () => {
    for (const k of ['8453-56', '8453-9745']) {
      expect(() => verifySponsoredAcross(SAMPLES[k]!, expect_(k, { minNative: BigInt(SAMPLES[k]!.minOutputAmount) * 2n }))).toThrow(/less than the amount shown/);
    }
  });
});

describe('verifySponsoredAcross: tampered routes', () => {
  it('Uniswap swap paying someone else, pulling from a payer, or spending another token', () => {
    expect(() => verifySponsoredAcross(withUrSwap('8453-56', (x) => { x.recipient = EVIL; }), expect_('8453-56'))).toThrow(/pays someone other than the handler/);
    expect(() => verifySponsoredAcross(withUrSwap('8453-56', (x) => { x.payerIsUser = true; }), expect_('8453-56'))).toThrow(/pulls tokens/);
    expect(() => verifySponsoredAcross(withUrSwap('8453-56', (x) => { x.path = `0x${'11'.repeat(20)}${x.path.slice(42)}` as Hex; }), expect_('8453-56'))).toThrow(/another token than the bridged one/);
  });

  it('a Universal Router that is not the pinned one, and a drain to someone else', () => {
    const otherRouter = withMessage('8453-56', (m) => {
      for (const c of m.calls) if (c.target.toLowerCase() === '0x1906c1d672b88cd1b9ac7593301ca990f94eae07') c.target = EVIL;
    });
    expect(() => verifySponsoredAcross(otherRouter, expect_('8453-56'))).toThrow(/^Across route refused: /);
    const drainElsewhere = withMessage('8453-137', (m) => {
      const last = [...m.calls].reverse().find((c) => c.callData.startsWith('0xef8738d3'))!;
      last.callData = `${last.callData.slice(0, 74)}${EVIL.slice(2).toLowerCase().padStart(64, '0')}` as Hex;
    });
    expect(() => verifySponsoredAcross(drainElsewhere, expect_('8453-137'))).toThrow(/drain pays someone other/);
  });

  it('a fallback recipient that is not you, and an extra call', () => {
    expect(() => verifySponsoredAcross(withMessage('8453-9745', (m) => { m.fallbackRecipient = EVIL; }), expect_('8453-9745'))).toThrow(/fallback recipient/);
    const extra = withMessage('8453-9745', (m) => {
      m.calls.push({ target: EVIL, callData: encodeFunctionData({ abi: parseAbi(['function transfer(address,uint256)']), args: [EVIL, 1n] }), value: 0n });
    });
    expect(() => verifySponsoredAcross(extra, expect_('8453-9745'))).toThrow(/not one the handler route uses/);
  });

  it('a source swap through an unknown exchange, or one that may return less than is bridged', () => {
    expect(() => verifySponsoredAcross(withSwapData('8453-43114', (a) => { a.exchange = EVIL; }), expect_('8453-43114'))).toThrow(/source swap runs through/);
    expect(() => verifySponsoredAcross(withSwapData('42161-43114', (a) => { a.minExpectedInputTokenAmount = 1n; }), expect_('42161-43114'))).toThrow(/may return less than is bridged/);
    expect(() => verifySponsoredAcross(withSwapData('8453-143', (a) => { (a.submissionFees as { amount: bigint }).amount = 1n; }), expect_('8453-143'))).toThrow(/submission fee/);
  });

  it('a deposit into another SpokePool or through another periphery', () => {
    expect(() => verifySponsoredAcross(withSwapData('8453-9745', (a) => { a.spokePool = EVIL; }), expect_('8453-9745'))).toThrow(/not Across's SpokePool/);
    expect(() => verifySponsoredAcross({ ...SAMPLES['8453-56']!, to: EVIL }, expect_('8453-56'))).toThrow(/not the Across periphery/);
  });
});
