// Across as a direct-chain route, checked by the page before anything is
// signed (the API is untrusted). The API runs the same checks on its own copy
// (zerodust-backend src/services/direct/across.ts); keep the two identical.
//
// Across does not bridge MON itself. Its swap API answers Monad -> X with one
// SpokePoolPeriphery.swapAndBridge call (value = the input): MON is swapped
// to USDC on Monad, USDC is bridged, and on the destination Across's
// MulticallHandler runs a message that swaps USDC to the native gas token
// (0x AllowanceHolder + a 0x Settler), unwraps it, and drains everything to
// the recipient. Checked here, failing closed on any other shape:
// - origin: the periphery, Across's SpokePool for this chain, no submission
//   fee, the whole value swapped, refunds to this wallet, the right chain;
// - destination: Across's handler for that chain; fallback = the recipient;
//   no call carries value; no token transfer or approval except to 0x's
//   AllowanceHolder; handler self-calls only drain to the recipient or unwrap;
//   the 0x swap pays the handler at least the receive shown, of the token
//   that is unwrapped (or native), and its Settler is confirmed on-chain by
//   the caller in 0x's registry; a native drain to the recipient exists.

import { decodeAbiParameters, decodeFunctionData, parseAbi, type Hex } from 'viem';

/** SpokePoolPeriphery, the same address on every chain */
export const ACROSS_PERIPHERY = '0x97CCDBea4632140639aD5eA9b944aa034eb15fD4';
/** Across's SpokePool per direct source chain (across-protocol/contracts broadcast/deployed-addresses.json, 2026-10-02) */
export const ACROSS_SPOKE_POOLS: Readonly<Record<number, string>> = {
  143: '0xd2ecb3afe598b746F8123CaE365a598DA831A449',
};
/** Across's MulticallHandler per destination (same file, mainnets only) */
export const ACROSS_HANDLERS: Readonly<Record<number, string>> = {
  1: '0x0F7Ae28dE1C8532170AD4ee566B5801485c13a0E',
  10: '0x0F7Ae28dE1C8532170AD4ee566B5801485c13a0E',
  56: '0x0F7Ae28dE1C8532170AD4ee566B5801485c13a0E',
  130: '0x0F7Ae28dE1C8532170AD4ee566B5801485c13a0E',
  137: '0x0F7Ae28dE1C8532170AD4ee566B5801485c13a0E',
  480: '0x0F7Ae28dE1C8532170AD4ee566B5801485c13a0E',
  999: '0x5E7840E06fAcCb6d1c3b5F5E0d1d3d07F2829bba',
  1135: '0x0F7Ae28dE1C8532170AD4ee566B5801485c13a0E',
  1868: '0x0F7Ae28dE1C8532170AD4ee566B5801485c13a0E',
  4326: '0xFfc1285082deAB9bf0ECA5699e4930bb310aFbE4',
  8453: '0x0F7Ae28dE1C8532170AD4ee566B5801485c13a0E',
  9745: '0x5E7840E06fAcCb6d1c3b5F5E0d1d3d07F2829bba',
  34443: '0x0F7Ae28dE1C8532170AD4ee566B5801485c13a0E',
  42161: '0x0F7Ae28dE1C8532170AD4ee566B5801485c13a0E',
  43114: '0x9610954AcDCA5FF7905f051A040ce33fe613c60e',
  57073: '0x0F7Ae28dE1C8532170AD4ee566B5801485c13a0E',
  59144: '0xdF1C940487574EEfa79989a79a4936A0F979cDa2',
  534352: '0x0F7Ae28dE1C8532170AD4ee566B5801485c13a0E',
  7777777: '0x0F7Ae28dE1C8532170AD4ee566B5801485c13a0E',
};
/** 0x's AllowanceHolder (same address everywhere): the only spender a message may approve */
export const ZEROX_ALLOWANCE_HOLDER = '0x0000000000001fF3684f28c67538d4D072C22734';
/**
 * 0x's Settler registry (same address everywhere): ownerOf(2) is the current
 * taker-submitted Settler and prev(2) the one before. An exec operator must
 * be one of the two on the destination chain.
 */
export const ZEROX_DEPLOYER = '0x00000000000004533Fe15556B1E086BB1A72cEae';
export const ZEROX_SETTLER_FEATURE = 2n;
/**
 * The SpokePool reverts a deposit whose quoteTimestamp is older than this
 * (depositQuoteTimeBuffer on Monad's SpokePool, read 2026-10-02). Across's
 * swap API sets quoteTimestamp to about now - 3,570 s, so a deposit must land
 * within ~30 s of its quote (InvalidQuoteTimestamp otherwise; on a
 * 'gaslimit' chain the revert still costs the whole gas limit).
 */
export const ACROSS_QUOTE_BUFFER_SECONDS = 3600;
/** What 0x uses for the native token as a buy token */
const NATIVE_SENTINEL = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

const PERIPHERY_ABI = parseAbi([
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
const MESSAGE_ABI = parseAbi([
  'function approve(address spender, uint256 amount)',
  'function exec(address operator, address token, uint256 amount, address target, bytes data)',
  'function drainLeftoverTokens(address token, address destination)',
  'function makeCallWithBalance(address target, bytes callData, uint256 value, (address token, uint256 offset)[] replacement)',
  'function withdraw(uint256 amount)',
  'function emitData(bytes data)',
  'function execute((address recipient, address buyToken, uint256 minAmountOut) slippage, bytes[] actions, bytes32 zid)',
]);

const SEL = {
  approve: '0x095ea7b3',
  exec: '0x2213bc0b',
  drain: '0xef8738d3',
  callWithBalance: '0xc41e8295',
  withdraw: '0x2e1a7d4d',
  emitData: '0xd836083e',
  settlerExecute: '0x1fff991f',
} as const;

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const isZero = (a: string) => /^0x0{40}$/i.test(a);
const bytes32Of = (address: string) => `0x${address.slice(2).toLowerCase().padStart(64, '0')}`;
const addressOf = (word: string): string | null => (/^0x0{24}[0-9a-f]{40}$/i.test(word) ? `0x${word.slice(26)}` : null);

export interface AcrossExpect {
  chainId: number;
  toChainId: number;
  from: string;
  recipient: string;
  /** The tx value: the whole amount swapped and bridged */
  value: bigint;
  /** The least native the destination swap may deliver (the receive shown to the user) */
  minNative: bigint;
}

/**
 * Checks an Across deposit (to, data) against the request. Returns the 0x
 * Settler the destination swap runs through, which the caller must confirm
 * on the destination chain (isRegisteredSettler) before signing, and the
 * unix time after which the SpokePool refuses the deposit.
 */
export function verifyAcrossDeposit(tx: { to: string; data: string }, x: AcrossExpect): { settler: string; expiresAt: number } {
  const fail = (why: string): never => { throw new Error(`Across deposit refused: ${why}`); };
  const spokePool = ACROSS_SPOKE_POOLS[x.chainId];
  const handler = ACROSS_HANDLERS[x.toChainId];
  if (!spokePool) fail(`no known Across SpokePool on chain ${x.chainId}`);
  if (!handler) fail(`no known Across handler on chain ${x.toChainId}`);
  if (!eq(tx.to, ACROSS_PERIPHERY)) fail(`it targets ${tx.to}, not the Across periphery`);

  let d: { submissionFees: { amount: bigint }; depositData: { depositor: string; recipient: string; destinationChainId: bigint; outputToken: string; outputAmount: bigint; quoteTimestamp: number; message: Hex }; swapTokenAmount: bigint; spokePool: string };
  try {
    const decoded = decodeFunctionData({ abi: PERIPHERY_ABI, data: tx.data as Hex });
    d = decoded.args[0];
  } catch {
    return fail('it is not a swapAndBridge call');
  }
  if (!eq(d.spokePool, spokePool!)) fail(`it deposits into ${d.spokePool}, not Across's SpokePool`);
  if (d.submissionFees.amount !== 0n) fail('it pays a submission fee to someone');
  if (d.swapTokenAmount !== x.value) fail('the amount swapped is not the amount sent');
  const dep = d.depositData;
  if (!eq(dep.depositor, x.from)) fail(`refunds go to ${dep.depositor}, not this wallet`);
  if (dep.destinationChainId !== BigInt(x.toChainId)) fail(`it goes to chain ${dep.destinationChainId}, not ${x.toChainId}`);
  if (!eq(dep.recipient, bytes32Of(handler!))) fail('the deposit does not go to Across\'s handler for the destination');
  if (dep.outputAmount <= 0n) fail('nothing is bridged');
  const bridged = addressOf(dep.outputToken) ?? fail('the bridged token is not an address');

  let instructions: { calls: readonly { target: string; callData: Hex; value: bigint }[]; fallbackRecipient: string };
  try {
    [instructions] = decodeAbiParameters(INSTRUCTIONS, dep.message);
  } catch {
    return fail('the destination message is not a handler instruction list');
  }
  if (!eq(instructions.fallbackRecipient, x.recipient)) fail('the fallback recipient is not the address you set');

  const unwrapped = new Set<string>();
  let settler: string | null = null;
  let buyToken: string | null = null;
  let nativeDrain = false;
  for (const call of instructions.calls) {
    if (call.value !== 0n) fail('a destination call carries value');
    const sel = call.callData.slice(0, 10).toLowerCase();
    let args: readonly unknown[];
    try {
      args = decodeFunctionData({ abi: MESSAGE_ABI, data: call.callData }).args ?? [];
    } catch {
      return fail(`a destination call (${sel}) is not one the handler route uses`);
    }
    if (eq(call.target, handler!)) {
      if (sel === SEL.drain) {
        const [token, destination] = args as [string, string];
        if (!eq(destination, x.recipient)) fail('a drain pays someone other than the address you set');
        if (isZero(token)) nativeDrain = true;
      } else if (sel === SEL.callWithBalance) {
        const [target, inner, value] = args as [string, Hex, bigint];
        if (value !== 0n || !inner.toLowerCase().startsWith(SEL.withdraw)) fail('a handler call does more than unwrap');
        unwrapped.add(target.toLowerCase());
      } else {
        fail(`a handler call (${sel}) is not a drain or an unwrap`);
      }
    } else if (sel === SEL.approve) {
      const [spender] = args as [string];
      if (!eq(spender, ZEROX_ALLOWANCE_HOLDER)) fail(`an approval goes to ${spender}`);
      if (!eq(call.target, bridged)) fail('an approval is for another token than the bridged one');
    } else if (sel === SEL.exec) {
      if (!eq(call.target, ZEROX_ALLOWANCE_HOLDER)) fail('a swap does not go through 0x\'s AllowanceHolder');
      if (settler) fail('more than one swap');
      const [operator, token, , target, inner] = args as [string, string, bigint, string, Hex];
      if (!eq(operator, target)) fail('the swap operator is not its target');
      if (!eq(token, bridged)) fail('the swap spends another token than the bridged one');
      if (!inner.toLowerCase().startsWith(SEL.settlerExecute)) fail('the swap is not a 0x Settler execute');
      let slippage: { recipient: string; buyToken: string; minAmountOut: bigint };
      try {
        [slippage] = decodeFunctionData({ abi: MESSAGE_ABI, data: inner }).args as unknown as [typeof slippage];
      } catch {
        return fail('the 0x swap is malformed');
      }
      if (!eq(slippage.recipient, handler!)) fail('the swap pays someone other than the handler');
      if (slippage.minAmountOut < x.minNative) fail('the swap may deliver less than the amount shown');
      settler = operator;
      buyToken = slippage.buyToken.toLowerCase();
    } else if (sel !== SEL.emitData) {
      fail(`a destination call (${sel}) is not one the handler route uses`);
    }
  }
  if (!settler || !buyToken) return fail('no swap to the native token');
  if (buyToken !== NATIVE_SENTINEL && !unwrapped.has(buyToken)) fail('the swap output is not unwrapped to the native token');
  if (!nativeDrain) fail('nothing sends the native token to the address you set');
  // The last second the SpokePool still accepts this deposit
  return { settler, expiresAt: dep.quoteTimestamp + ACROSS_QUOTE_BUFFER_SECONDS };
}

/** eth_call data for the Settler registry: ownerOf(2) and prev(2) */
export const ZEROX_REGISTRY_CALLS = {
  ownerOf: `0x6352211e${ZEROX_SETTLER_FEATURE.toString(16).padStart(64, '0')}`,
  prev: `0xe2603dc2${ZEROX_SETTLER_FEATURE.toString(16).padStart(64, '0')}`,
} as const;

/**
 * Whether `settler` is 0x's current or previous Settler, from two eth_call
 * answers to ZEROX_DEPLOYER on the destination chain.
 */
export function isRegisteredSettler(settler: string, answers: string[]): boolean {
  return answers.some((word) => {
    const a = typeof word === 'string' ? addressOf(word) : null;
    return !!a && !isZero(a) && eq(a, settler);
  });
}
