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
/**
 * Tokens Across bridges per chain (its /available-routes, 2026-10-06): WETH (a plain deposit's
 * delivery, paid out as native ETH) and the stablecoins a swap route carries. A deposit of any
 * other token, or a plain deposit delivering anything but WETH, is refused.
 */
export const ACROSS_TOKENS: Readonly<Record<number, { weth: string | null; stables: readonly string[] }>> = {
  1: { weth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', stables: ['0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', '0xdAC17F958D2ee523a2206206994597C13D831ec7'] },
  10: { weth: '0x4200000000000000000000000000000000000006', stables: ['0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', '0x7F5c764cBc14f9669B88837ca1490cCa17c31607', '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58'] },
  56: { weth: '0x2170Ed0880ac9A755fd29B2688956BD959F933F8', stables: [] },
  130: { weth: '0x4200000000000000000000000000000000000006', stables: ['0x078D782b760474a361dDA0AF3839290b0EF57AD6', '0x9151434b16b9763660705744891fA906F660EcC5'] },
  137: { weth: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', stables: ['0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', '0xc2132D05D31c914a87C6611C10748AEb04B58e8F'] },
  143: { weth: null, stables: ['0x754704Bc059F8C67012fEd69BC8A327a5aafb603', '0xe7cd86e13AC4309349F30B3435a9d337750fC82D'] },
  324: { weth: '0x5AEa5775959fBC2557Cc8789bC1bf90A239D9a91', stables: ['0x3355df6D4c9C3035724Fd0e3914dE96A5a83aaf4', '0x493257fD37EDB34451f62EDf8D2a0C418852bA4C'] },
  480: { weth: '0x4200000000000000000000000000000000000006', stables: ['0x79A02482A880bCE3F13e09Da970dC34db4CD24d1'] },
  999: { weth: null, stables: ['0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb', '0xb88339CB7199b77E23DB6E890353E22632Ba630f'] },
  1868: { weth: '0x4200000000000000000000000000000000000006', stables: ['0xbA9986D2381edf1DA03B0B9c1f8b00dc4AacC369'] },
  4217: { weth: null, stables: ['0x20C000000000000000000000b9537d11c60E8b50'] },
  4326: { weth: '0x4200000000000000000000000000000000000006', stables: ['0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb'] },
  4663: { weth: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', stables: [] },
  5042: { weth: null, stables: ['0x3600000000000000000000000000000000000000'] },
  8453: { weth: '0x4200000000000000000000000000000000000006', stables: ['0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2'] },
  9745: { weth: null, stables: ['0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb'] },
  42161: { weth: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', stables: ['0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8', '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'] },
  43114: { weth: null, stables: ['0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7', '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E'] },
  57073: { weth: '0x4200000000000000000000000000000000000006', stables: ['0x0200C29006150606B650577BBE7B6248F58470c1', '0x2D270e6886d130D724215A266106e6832161EAEd'] },
  59144: { weth: '0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34f', stables: ['0x176211869cA2b568f2A7D4EE941E073a821EE1ff', '0xA219439258ca9da29E9Cc4cE5596924745e12B93'] },
  728126428: { weth: null, stables: ['TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'] },
};
const bridgeable = (chainId: number, token: string) => {
  const t = ACROSS_TOKENS[chainId];
  return !!t && ((t.weth !== null && eqAddr(t.weth, token)) || t.stables.some((s) => eqAddr(s, token)));
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
function eqAddr(a: string, b: string) { return a.toLowerCase() === b.toLowerCase(); }
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
    const [pool, depositor, recipient, inputToken, inputAmount, outputToken, outputAmount, destinationChainId, , , , , message] = decoded.args;
    if (!eq(pool, spokePool)) fail(`it deposits into ${pool}, not Across's SpokePool`);
    if (inputAmount !== x.value) fail('the amount deposited is not the amount sent');
    const weth = ACROSS_TOKENS[x.fromChainId]?.weth;
    if (!weth || !eq(inputToken, weth)) fail('a native deposit that is not WETH on the source');
    dep = { depositor, recipient, destinationChainId, outputToken, outputAmount, message };
  } else {
    const d = decoded.args[0];
    if (!eq(d.spokePool, spokePool)) fail(`it deposits into ${d.spokePool}, not Across's SpokePool`);
    if (d.submissionFees.amount !== 0n) fail('it pays a submission fee to someone');
    if (d.swapTokenAmount !== x.value) fail('the amount swapped is not the amount sent');
    if (!SOURCE_EXCHANGES.some((e) => eq(e, d.exchange))) fail(`the source swap runs through ${d.exchange}`);
    // The periphery reverts unless the swap returns this much, and it bridges at most that
    if (d.minExpectedInputTokenAmount < d.depositData.outputAmount) fail('the source swap may return less than is bridged');
    if (!bridgeable(x.fromChainId, d.depositData.inputToken)) fail(`it bridges ${d.depositData.inputToken}, not a token Across carries`);
    dep = d.depositData;
  }

  if (!eq(dep.depositor, x.user)) fail(`refunds go to ${dep.depositor}, not this wallet`);
  if (dep.destinationChainId !== BigInt(x.toChainId)) fail(`it goes to chain ${dep.destinationChainId}, not ${x.toChainId}`);
  if (dep.outputAmount <= 0n) fail('nothing is bridged');

  const bridged = addressOf(dep.outputToken) ?? fail('the bridged token is not an address');

  // A plain deposit pays the recipient directly: WETH, which Across pays out as native ETH
  if (dep.message === '0x') {
    if (!eq(dep.recipient, bytes32Of(x.recipient))) fail('the deposit pays someone other than the address you set');
    const weth = ACROSS_TOKENS[x.toChainId]?.weth;
    if (!weth || !eq(bridged, weth)) fail('the deposit delivers another token than the native one');
    if (dep.outputAmount < x.minNative) fail('the deposit may deliver less than the amount shown');
    return { settler: null };
  }

  // Otherwise Across's handler receives it and runs the message
  const handler = ACROSS_HANDLERS[x.toChainId] ?? fail(`no known Across handler on chain ${x.toChainId}`);
  if (!eq(dep.recipient, bytes32Of(handler))) fail('the deposit does not go to Across\'s handler for the destination');
  if (!bridgeable(x.toChainId, bridged)) fail(`it delivers ${bridged}, not a token Across carries`);
  return verifyAcrossMessage(dep.message, { toChainId: x.toChainId, recipient: x.recipient, bridged, bridgedAmount: dep.outputAmount, minNative: x.minNative }, fail);
}
