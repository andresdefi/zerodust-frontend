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

const VALUES: Record<string, bigint> = { '8453-137-split': 518_000_000_000_000_000n, '42161-56-lifi': 50_000_000_000_000_000n, '137-8453-nofallback': 200_000_000_000_000_000_000n };
const expect_ = (k: string, over: Partial<SponsoredAcrossExpect> = {}): SponsoredAcrossExpect => {
  const [from, to] = k.split('-').map(Number) as [number, number];
  if (VALUES[k]) over = { value: VALUES[k], ...over };
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
const HYPEREVM = (k: string) => k.split('-')[1] === '999';

describe('verifySponsoredAcross: live routes', () => {
  it.each(Object.keys(SAMPLES).filter((k) => HYPEREVM(k)))('%s is refused: a leftover drain pays an unknown wallet', (k) => {
    expect(() => verifySponsoredAcross(SAMPLES[k]!, expect_(k))).toThrow(/a drain pays someone other than the address you set/);
  });

  it.each(Object.keys(SAMPLES).filter((k) => !HYPEREVM(k)))('%s passes, paying only the address you set', (k) => {
    const { settler } = verifySponsoredAcross(SAMPLES[k]!, expect_(k));
    // Uniswap-shaped routes (BNB Chain, Polygon) have no Settler; 0x-shaped ones name one to confirm on-chain
    if (/-(56|137)(-|$)/.test(k) || k === '10-8453' || k === '137-8453-nofallback') expect(settler).toBeNull();
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

describe('verifySponsoredAcross: hardening', () => {
  it('a Universal Router swap that leaves part of the bridged WETH in the router', () => {
    expect(() => verifySponsoredAcross(withUrSwap('8453-56', (x) => { x.amountIn -= 1n; }), expect_('8453-56'))).toThrow(/does not spend all of the bridged token/);
  });

  it('WETH drained into the Universal Router with no swap after it', () => {
    const noSwap = withMessage('8453-137', (m) => { m.calls = m.calls.filter((c) => !c.callData.startsWith('0x24856bc3')); });
    expect(() => verifySponsoredAcross(noSwap, expect_('8453-137'))).toThrow(/^Across route refused: /);
  });

  it('a swapAndBridge that deposits a token Across does not carry', () => {
    const odd = withSwapData('8453-43114', (a) => { (a.depositData as { inputToken: string }).inputToken = EVIL; });
    expect(() => verifySponsoredAcross(odd, expect_('8453-43114'))).toThrow(/not a token Across carries/);
  });

  it('a plain deposit (OP -> Base) passes, and is refused for another token, a smaller amount or another recipient', () => {
    const k = '10-8453';
    expect(verifySponsoredAcross(SAMPLES[k]!, expect_(k, { minNative: BigInt(SAMPLES[k]!.minOutputAmount) })).settler).toBeNull();
    const plain = (edit: (args: unknown[]) => void) => {
      const args = [...decodeFunctionData({ abi: PERIPHERY_ABI, data: SAMPLES[k]!.data }).args!] as unknown[];
      edit(args);
      return { to: SAMPLES[k]!.to, data: encodeFunctionData({ abi: PERIPHERY_ABI, functionName: 'depositNative', args: args as never }) };
    };
    expect(() => verifySponsoredAcross(plain((a) => { a[5] = `0x${EVIL.slice(2).toLowerCase().padStart(64, '0')}`; }), expect_(k))).toThrow(/another token than the native one/);
    expect(() => verifySponsoredAcross(plain((a) => { a[6] = 1n; }), expect_(k))).toThrow(/less than the amount shown/);
    expect(() => verifySponsoredAcross(SAMPLES[k]!, expect_(k, { recipient: EVIL }))).toThrow(/pays someone other than the address you set/);
    expect(() => verifySponsoredAcross(plain((a) => { a[3] = EVIL; }), expect_(k))).toThrow(/not WETH on the source/);
  });
});

describe('verifySponsoredAcross: the swap must buy the genuine wrapped native token', () => {
  const ZEROX = parseAbi([
    'function exec(address operator, address token, uint256 amount, address target, bytes data)',
    'function execute((address recipient, address buyToken, uint256 minAmountOut) slippage, bytes[] actions, bytes32 zid)',
    'function makeCallWithBalance(address target, bytes callData, uint256 value, (address token, uint256 offset)[] replacement)',
  ]);
  /** Points every unwrap at a fake token too, so only the buy-token pin can catch it */
  const unwrapFake = (m: Instructions) => {
    for (const c of m.calls) {
      if (!c.callData.startsWith('0xc41e8295')) continue;
      const [, inner, value, repl] = decodeFunctionData({ abi: ZEROX, data: c.callData }).args as unknown as [Hex, Hex, bigint, { token: Hex; offset: bigint }[]];
      c.callData = encodeFunctionData({ abi: ZEROX, functionName: 'makeCallWithBalance', args: [EVIL, inner, value, repl.map((r) => ({ ...r, token: EVIL as Hex }))] });
    }
  };

  it('Uniswap shape: a swap into a fake token, "unwrapped" by the fake token, is refused', () => {
    const fake = withMessage('8453-56', (m) => {
      const call = m.calls.find((c) => c.callData.startsWith('0x24856bc3'))!;
      const [commands, inputs] = decodeFunctionData({ abi: UR_ABI, data: call.callData }).args as unknown as [Hex, Hex[]];
      const [recipient, amountIn, minOut, path, payerIsUser] = decodeAbiParameters(V3_INPUT, inputs[0]!);
      const fakePath = `${path.slice(0, -40)}${EVIL.slice(2).toLowerCase()}` as Hex;
      call.callData = encodeFunctionData({ abi: UR_ABI, functionName: 'execute', args: [commands, [encodeAbiParameters(V3_INPUT, [recipient, amountIn, minOut, fakePath, payerIsUser])]] });
      unwrapFake(m);
    });
    expect(() => verifySponsoredAcross(fake, expect_('8453-56'))).toThrow(/buys another token than the native one/);
  });

  it('0x shape: a Settler swap into a fake token, "unwrapped" by the fake token, is refused', () => {
    const fake = withMessage('8453-43114', (m) => {
      const call = m.calls.find((c) => c.callData.startsWith('0x2213bc0b'))!;
      const [operator, token, amount, target, inner] = decodeFunctionData({ abi: ZEROX, data: call.callData }).args as unknown as [Hex, Hex, bigint, Hex, Hex];
      const [slippage, actions, zid] = decodeFunctionData({ abi: ZEROX, data: inner }).args as unknown as [{ recipient: Hex; buyToken: Hex; minAmountOut: bigint }, Hex[], Hex];
      const fakeInner = encodeFunctionData({ abi: ZEROX, functionName: 'execute', args: [{ ...slippage, buyToken: EVIL }, actions, zid] });
      call.callData = encodeFunctionData({ abi: ZEROX, functionName: 'exec', args: [operator, token, amount, target, fakeInner] });
      unwrapFake(m);
    });
    expect(() => verifySponsoredAcross(fake, expect_('8453-43114'))).toThrow(/buys another token than the native one/);
  });
});

describe('verifySponsoredAcross: split Universal Router swaps and LI.FI', () => {
  const SWEEP_INPUT = [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }] as const;
  /** Rewrites the split sample's commands and inputs */
  const withUr = (edit: (cmds: string[], inputs: Hex[]) => void) => withMessage('8453-137-split', (m) => {
    const call = m.calls.find((c) => c.callData.startsWith('0x24856bc3'))!;
    const [commands, inputs] = decodeFunctionData({ abi: UR_ABI, data: call.callData }).args as unknown as [Hex, Hex[]];
    const cmds = commands.slice(2).match(/../g)!;
    const ins = [...inputs];
    edit(cmds, ins);
    call.callData = encodeFunctionData({ abi: UR_ABI, functionName: 'execute', args: [`0x${cmds.join('')}`, ins] });
  });
  const sweepAt = (cmds: string[]) => cmds.indexOf('04');

  it('the split sample swaps into the router, then sweeps to the handler', () => {
    let cmds: string[] = [];
    withUr((c) => { cmds = [...c]; });
    expect(cmds).toContain('04');
    expect(verifySponsoredAcross(SAMPLES['8453-137-split']!, expect_('8453-137-split')).settler).toBeNull();
  });

  it('a sweep to someone else, a missing sweep, or a sweep minimum below the amount shown is refused', () => {
    const toEvil = withUr((c, ins) => {
      const i = sweepAt(c);
      const [token, , min] = decodeAbiParameters(SWEEP_INPUT, ins[i]!);
      ins[i] = encodeAbiParameters(SWEEP_INPUT, [token, EVIL, min]);
    });
    expect(() => verifySponsoredAcross(toEvil, expect_('8453-137-split'))).toThrow(/sweep pays someone other than the handler/);
    const noSweep = withUr((c, ins) => { const i = sweepAt(c); c.splice(i, 1); ins.splice(i, 1); });
    expect(() => verifySponsoredAcross(noSweep, expect_('8453-137-split'))).toThrow(/left in the Universal Router/);
    const lowMin = withUr((c, ins) => {
      const i = sweepAt(c);
      const [token, to] = decodeAbiParameters(SWEEP_INPUT, ins[i]!);
      ins[i] = encodeAbiParameters(SWEEP_INPUT, [token, to, 1n]);
    });
    expect(() => verifySponsoredAcross(lowMin, expect_('8453-137-split'))).toThrow(/less than the amount shown/);
  });

  const LIFI = parseAbi([
    'struct SwapData { address callTo; address approveTo; address sendingAssetId; address receivingAssetId; uint256 fromAmount; bytes callData; bool requiresDeposit; }',
    'function swapTokensSingleV3ERC20ToERC20(bytes32 transactionId, string integrator, string referrer, address receiver, uint256 minAmountOut, SwapData swapData)',
  ]);
  const withLifi = (edit: (args: unknown[]) => void) => withMessage('42161-56-lifi', (m) => {
    const call = m.calls.find((c) => c.callData.startsWith('0x4666fc80'))!;
    const args = [...decodeFunctionData({ abi: LIFI, data: call.callData }).args] as unknown[];
    edit(args);
    call.callData = encodeFunctionData({ abi: LIFI, functionName: 'swapTokensSingleV3ERC20ToERC20', args: args as never });
  });

  it('the LI.FI sample passes; another receiver, a low minimum or a fake output token is refused', () => {
    expect(verifySponsoredAcross(SAMPLES['42161-56-lifi']!, expect_('42161-56-lifi')).settler).toBeNull();
    expect(() => verifySponsoredAcross(withLifi((a) => { a[3] = EVIL; }), expect_('42161-56-lifi'))).toThrow(/pays someone other than the handler/);
    expect(() => verifySponsoredAcross(withLifi((a) => { a[4] = 1n; }), expect_('42161-56-lifi'))).toThrow(/less than the amount shown/);
    const fakeOut = withLifi((a) => {
      a[5] = { ...(a[5] as Record<string, unknown>), receivingAssetId: EVIL };
    });
    expect(() => verifySponsoredAcross(fakeOut, expect_('42161-56-lifi'))).toThrow(/buys another token than the native one/);
  });
});

describe('verifySponsoredAcross: no fallback, no swap (Polygon -> Base: POL to WETH, bridged, unwrapped)', () => {
  const k = '137-8453-nofallback';
  it('passes: the bridged WETH is unwrapped and drained, with the leftover WETH, to you', () => {
    expect(verifySponsoredAcross(SAMPLES[k]!, expect_(k)).settler).toBeNull();
  });

  it('without a fallback, a message that does not drain the bridged token is refused', () => {
    const keeps = withMessage(k, (m) => {
      m.calls = m.calls.filter((c) => !(c.callData.startsWith('0xef8738d3') && c.callData.slice(34, 74).toLowerCase() === '4200000000000000000000000000000000000006'));
    });
    expect(() => verifySponsoredAcross(keeps, expect_(k))).toThrow(/without a fallback, the bridged token must be drained/);
  });

  it('a bridged amount below the amount shown is refused', () => {
    expect(() => verifySponsoredAcross(SAMPLES[k]!, expect_(k, { minNative: 10n ** 30n }))).toThrow(/less than the amount shown/);
  });
});

describe('verifySponsoredAcross: steps must run swap, unwrap, then pay out', () => {
  const isUnwrap = (c: Call) => c.callData.startsWith('0xc41e8295');
  const isNativeDrain = (c: Call) => c.callData.startsWith('0xef8738d3') && /^0{64}$/.test(c.callData.slice(10, 74));
  const isSwap = (c: Call) => ['0x2213bc0b', '0x24856bc3', '0x4666fc80'].includes(c.callData.slice(0, 10));
  const moveBefore = (m: Instructions, which: (c: Call) => boolean, before: (c: Call) => boolean) => {
    const i = m.calls.findIndex(which);
    const [call] = m.calls.splice(i, 1);
    m.calls.splice(m.calls.findIndex(before), 0, call!);
  };

  it.each(['8453-56', '8453-43114', '42161-56-lifi'])('%s: native paid out before the unwrap is refused', (k) => {
    expect(() => verifySponsoredAcross(withMessage(k, (m) => moveBefore(m, isNativeDrain, isUnwrap)), expect_(k))).toThrow(/paid out before the swap or the unwrap/);
  });

  it.each(['8453-56', '8453-43114'])('%s: unwrap before the swap is refused', (k) => {
    expect(() => verifySponsoredAcross(withMessage(k, (m) => moveBefore(m, isUnwrap, isSwap)), expect_(k))).toThrow(/unwrap runs before the swap|paid out before/);
  });
});
