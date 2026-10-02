/**
 * Builds an Across swapAndBridge deposit shaped like the live Monad -> Base
 * quote of 2026-10-02 (origin swap to USDC, bridge, 0x swap to WETH on the
 * destination, unwrap, drain to the recipient). Each field can be tampered.
 */

import { encodeAbiParameters, encodeFunctionData, parseAbi, type Hex } from 'viem';

const ABI = parseAbi([
  'struct Fees { uint256 amount; address recipient; }',
  'struct BaseDepositData { address inputToken; bytes32 outputToken; uint256 outputAmount; address depositor; bytes32 recipient; uint256 destinationChainId; bytes32 exclusiveRelayer; uint32 quoteTimestamp; uint32 fillDeadline; uint32 exclusivityParameter; bytes message; }',
  'struct SwapAndDepositData { Fees submissionFees; BaseDepositData depositData; address swapToken; address exchange; uint8 transferType; uint256 swapTokenAmount; uint256 minExpectedInputTokenAmount; bytes routerCalldata; bool enableProportionalAdjustment; address spokePool; uint256 nonce; }',
  'function swapAndBridge(SwapAndDepositData swapAndDepositData)',
  'function approve(address spender, uint256 amount)',
  'function transfer(address to, uint256 amount)',
  'function exec(address operator, address token, uint256 amount, address target, bytes data)',
  'function drainLeftoverTokens(address token, address destination)',
  'function makeCallWithBalance(address target, bytes callData, uint256 value, (address token, uint256 offset)[] replacement)',
  'function withdraw(uint256 amount)',
  'function emitData(bytes data)',
  'function execute((address recipient, address buyToken, uint256 minAmountOut) slippage, bytes[] actions, bytes32 zid)',
]);

export const ACROSS = {
  periphery: '0x97CCDBea4632140639aD5eA9b944aa034eb15fD4',
  monadSpokePool: '0xd2ecb3afe598b746F8123CaE365a598DA831A449',
  baseHandler: '0x0F7Ae28dE1C8532170AD4ee566B5801485c13a0E',
  allowanceHolder: '0x0000000000001fF3684f28c67538d4D072C22734',
  settler: '0x4f6f91599858bf0d19fabCF2c5d591fE13f7C059',
  baseUsdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  baseWeth: '0x4200000000000000000000000000000000000006',
  monadUsdc: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603',
  wmon: '0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A',
  emitter: '0xBF75133b48b0a42AB9374027902E83C5E2949034',
} as const;

const word = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, '0')}` as Hex;
const NATIVE = '0x0000000000000000000000000000000000000000';

export interface AcrossDepositOptions {
  from: string;
  recipient: string;
  value: bigint;
  toChainId?: number;
  minAmountOut?: bigint;
  spokePool?: string;
  handler?: string;
  fallback?: string;
  drainTo?: string;
  settler?: string;
  slippageRecipient?: string;
  submissionFee?: bigint;
  depositor?: string;
  /** Unix seconds; Across's swap API sets it ~3,570 s in the past */
  quoteTimestamp?: number;
  /** An extra destination call appended to the message */
  extraCall?: { target: string; callData: Hex; value?: bigint };
}

export function acrossDepositData(o: AcrossDepositOptions): Hex {
  const handler = o.handler ?? ACROSS.baseHandler;
  const settler = o.settler ?? ACROSS.settler;
  const settlerCall = encodeFunctionData({
    abi: ABI, functionName: 'execute',
    args: [{ recipient: (o.slippageRecipient ?? handler) as Hex, buyToken: ACROSS.baseWeth, minAmountOut: o.minAmountOut ?? 732_738_915_419_557n }, ['0x1234'], word('0x01')],
  });
  const calls: { target: Hex; callData: Hex; value: bigint }[] = [
    { target: ACROSS.baseUsdc, callData: encodeFunctionData({ abi: ABI, functionName: 'approve', args: [ACROSS.allowanceHolder, 2n ** 256n - 1n] }), value: 0n },
    { target: ACROSS.allowanceHolder, callData: encodeFunctionData({ abi: ABI, functionName: 'exec', args: [settler as Hex, ACROSS.baseUsdc, 2n ** 256n - 1n, settler as Hex, settlerCall] }), value: 0n },
    { target: handler as Hex, callData: encodeFunctionData({ abi: ABI, functionName: 'makeCallWithBalance', args: [ACROSS.baseWeth, encodeFunctionData({ abi: ABI, functionName: 'withdraw', args: [0n] }), 0n, [{ token: ACROSS.baseWeth, offset: 4n }]] }), value: 0n },
    { target: handler as Hex, callData: encodeFunctionData({ abi: ABI, functionName: 'drainLeftoverTokens', args: [NATIVE, (o.drainTo ?? o.recipient) as Hex] }), value: 0n },
    { target: handler as Hex, callData: encodeFunctionData({ abi: ABI, functionName: 'drainLeftoverTokens', args: [ACROSS.baseUsdc, (o.drainTo ?? o.recipient) as Hex] }), value: 0n },
    { target: ACROSS.emitter, callData: encodeFunctionData({ abi: ABI, functionName: 'emitData', args: ['0xabcd'] }), value: 0n },
    ...(o.extraCall ? [{ target: o.extraCall.target as Hex, callData: o.extraCall.callData, value: o.extraCall.value ?? 0n }] : []),
  ];
  const message = encodeAbiParameters(
    [{ type: 'tuple', components: [{ name: 'calls', type: 'tuple[]', components: [{ name: 'target', type: 'address' }, { name: 'callData', type: 'bytes' }, { name: 'value', type: 'uint256' }] }, { name: 'fallbackRecipient', type: 'address' }] }],
    [{ calls, fallbackRecipient: (o.fallback ?? o.recipient) as Hex }],
  );
  return encodeFunctionData({
    abi: ABI, functionName: 'swapAndBridge',
    args: [{
      submissionFees: { amount: o.submissionFee ?? 0n, recipient: NATIVE },
      depositData: {
        inputToken: ACROSS.monadUsdc, outputToken: word(ACROSS.baseUsdc), outputAmount: 2_023_448n,
        depositor: (o.depositor ?? o.from) as Hex, recipient: word(handler), destinationChainId: BigInt(o.toChainId ?? 8453),
        exclusiveRelayer: word('0xfd03abcadaf3f930fa4e37eb2f6ea3a44a41b7f0'), quoteTimestamp: o.quoteTimestamp ?? 1_790_937_408, fillDeadline: 1_790_947_931,
        exclusivityParameter: 3, message,
      },
      swapToken: ACROSS.wmon, exchange: '0x0D97Dc33264bfC1c226207428A79b26757fb9dc3', transferType: 1,
      swapTokenAmount: o.value, minExpectedInputTokenAmount: 2_040_323n, routerCalldata: '0x24856bc3',
      enableProportionalAdjustment: true, spokePool: (o.spokePool ?? ACROSS.monadSpokePool) as Hex, nonce: 0n,
    }],
  });
}

/** A transfer() of the bridged token to someone: what a tampered message would add */
export const transferCall = (to: string) => encodeFunctionData({ abi: ABI, functionName: 'transfer', args: [to as Hex, 1n] });

/** eth_call answer word for an address (0x registry ownerOf/prev) */
export const addressWord = (a: string) => word(a);
