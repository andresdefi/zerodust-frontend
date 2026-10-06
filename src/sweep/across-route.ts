// An Across route on a sponsored chain, checked by the page before a MetaMask sweep is signed
// (the API is untrusted). The SDK's verifySweepQuote already checks the periphery, the refund
// address and a plain deposit's recipient; this adds what it cannot read: where a deposit that
// swaps on the destination finally pays. Two shapes, both from Across's swap API (2026-10-06):
// - depositNative of WETH, then on the destination Uniswap's Universal Router swaps it to the
//   native gas token (BNB Chain, Polygon);
// - swapAndBridge: the source swaps to USDC (0x or LI.FI), then on the destination a 0x
//   Settler swaps it to the native gas token (Avalanche, HyperEVM, Monad, Plasma).
// Every contract is pinned from Across's and Uniswap's published deployments; any other shape
// is refused.

import { decodeFunctionData, parseAbi, type Hex } from 'viem';
import { ACROSS_HANDLERS, verifyAcrossMessage, ZEROX_ALLOWANCE_HOLDER } from '../direct/across';

/** SpokePoolPeriphery per source chain (across-protocol/contracts deployed-addresses.json, 2026-10-06) */
const PERIPHERY_DEFAULT = '0x97CCDBea4632140639aD5eA9b944aa034eb15fD4';
export const ACROSS_PERIPHERIES: Readonly<Record<number, string>> = {
  5042: '0xE791A2669bef779Ff7A4A9CF789F8Ee2CA20a32c',
};
/** SpokePool per source chain (same file) */
export const ACROSS_SOURCE_SPOKE_POOLS: Readonly<Record<number, string>> = {
  1: '0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5',
  10: '0x6f26Bf09B1C792e3228e5467807a900A503c0281',
  56: '0x4e8E101924eDE233C13e2D8622DC8aED2872d505',
  130: '0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64',
  137: '0x9295ee1d8C5b022Be115A2AD3c30C72E34e7F096',
  4663: '0xD29C85F15DF544bA632C9E25829fd29d767d7978',
  5042: '0x9b4A302A548c7e313c2b74C461db7b84d3074A84',
  8453: '0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64',
  42161: '0xe35e9842fceaCA96570B734083f4a58e8F7C5f2A',
  59144: '0x7E63A5f1a8F0B4d0934B2f2327DAED3F6bb2ee75',
};
/** Exchanges a swapAndBridge may swap through on the source: 0x's AllowanceHolder, LI.FI's Diamond */
const SOURCE_EXCHANGES = [ZEROX_ALLOWANCE_HOLDER, '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE'];

const PERIPHERY_ABI = parseAbi([
  'function depositNative(address spokePool, address depositor, bytes32 recipient, address inputToken, uint256 inputAmount, bytes32 outputToken, uint256 outputAmount, uint256 destinationChainId, bytes32 exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityParameter, bytes message)',
  'struct Fees { uint256 amount; address recipient; }',
  'struct BaseDepositData { address inputToken; bytes32 outputToken; uint256 outputAmount; address depositor; bytes32 recipient; uint256 destinationChainId; bytes32 exclusiveRelayer; uint32 quoteTimestamp; uint32 fillDeadline; uint32 exclusivityParameter; bytes message; }',
  'struct SwapAndDepositData { Fees submissionFees; BaseDepositData depositData; address swapToken; address exchange; uint8 transferType; uint256 swapTokenAmount; uint256 minExpectedInputTokenAmount; bytes routerCalldata; bool enableProportionalAdjustment; address spokePool; uint256 nonce; }',
  'function swapAndBridge(SwapAndDepositData swapAndDepositData)',
]);

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const bytes32Of = (address: string) => `0x${address.slice(2).toLowerCase().padStart(64, '0')}`;
const addressOf = (word: string): string | null => (/^0x0{24}[0-9a-f]{40}$/i.test(word) ? `0x${word.slice(26)}` : null);

export interface SponsoredAcrossExpect {
  fromChainId: number;
  toChainId: number;
  /** The sweeping wallet: refunds must go to it */
  user: string;
  /** The address the user set */
  recipient: string;
  /** What the sweep routes into the bridge (the quote's bridge.inputAmount) */
  value: bigint;
  /** The least native the destination may deliver (the quote's estimatedReceive) */
  minNative: bigint;
}

/**
 * Checks a sponsored-chain Across deposit end to end.
 * @returns the 0x Settler the destination swap runs through (the caller confirms it in 0x's
 *   registry on the destination chain), or null when there is none to confirm
 */
export function verifySponsoredAcross(tx: { to: string; data: string }, x: SponsoredAcrossExpect): { settler: string | null } {
  const fail = (why: string): never => { throw new Error(`Across route refused: ${why}`); };
  const spokePool = ACROSS_SOURCE_SPOKE_POOLS[x.fromChainId] ?? fail(`no known Across SpokePool on chain ${x.fromChainId}`);
  if (!eq(tx.to, ACROSS_PERIPHERIES[x.fromChainId] ?? PERIPHERY_DEFAULT)) fail(`it targets ${tx.to}, not the Across periphery`);

  let decoded;
  try {
    decoded = decodeFunctionData({ abi: PERIPHERY_ABI, data: tx.data as Hex });
  } catch {
    return fail('it is not a known Across deposit');
  }

  let dep: { depositor: string; recipient: string; destinationChainId: bigint; outputToken: string; outputAmount: bigint; message: Hex };
  if (decoded.functionName === 'depositNative') {
    const [pool, depositor, recipient, , inputAmount, outputToken, outputAmount, destinationChainId, , , , , message] = decoded.args;
    if (!eq(pool, spokePool)) fail(`it deposits into ${pool}, not Across's SpokePool`);
    if (inputAmount !== x.value) fail('the amount deposited is not the amount sent');
    dep = { depositor, recipient, destinationChainId, outputToken, outputAmount, message };
  } else {
    const d = decoded.args[0];
    if (!eq(d.spokePool, spokePool)) fail(`it deposits into ${d.spokePool}, not Across's SpokePool`);
    if (d.submissionFees.amount !== 0n) fail('it pays a submission fee to someone');
    if (d.swapTokenAmount !== x.value) fail('the amount swapped is not the amount sent');
    if (!SOURCE_EXCHANGES.some((e) => eq(e, d.exchange))) fail(`the source swap runs through ${d.exchange}`);
    // The periphery reverts unless the swap returns this much, and it bridges at most that
    if (d.minExpectedInputTokenAmount < d.depositData.outputAmount) fail('the source swap may return less than is bridged');
    dep = d.depositData;
  }

  if (!eq(dep.depositor, x.user)) fail(`refunds go to ${dep.depositor}, not this wallet`);
  if (dep.destinationChainId !== BigInt(x.toChainId)) fail(`it goes to chain ${dep.destinationChainId}, not ${x.toChainId}`);
  if (dep.outputAmount <= 0n) fail('nothing is bridged');

  // A plain deposit pays the recipient directly
  if (dep.message === '0x') {
    if (!eq(dep.recipient, bytes32Of(x.recipient))) fail('the deposit pays someone other than the address you set');
    return { settler: null };
  }

  // Otherwise Across's handler receives it and runs the message
  const handler = ACROSS_HANDLERS[x.toChainId] ?? fail(`no known Across handler on chain ${x.toChainId}`);
  if (!eq(dep.recipient, bytes32Of(handler))) fail('the deposit does not go to Across\'s handler for the destination');
  const bridged = addressOf(dep.outputToken) ?? fail('the bridged token is not an address');
  return verifyAcrossMessage(dep.message, { toChainId: x.toChainId, recipient: x.recipient, bridged, minNative: x.minNative }, fail);
}
