// An Across route on a sponsored chain, checked by the page before a MetaMask sweep is signed
// (the API is untrusted). ZeroDust delivers the destination's native gas, so Across is used only
// for ETH to ETH as a plain deposit (owner, 2026-10-06): WETH in, paid out as native ETH to an
// ordinary or EIP-7702 wallet. Anything that swaps or runs a destination message is refused:
// Across settles those in another token when a swap fails or leaves a remainder, and pays WETH
// to a contract recipient. Contracts are pinned from Across's published deployments.

import { decodeFunctionData, parseAbi, type Hex } from 'viem';
import { ACROSS_TOKENS } from '../direct/across';

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

const PERIPHERY_ABI = parseAbi([
  'function depositNative(address spokePool, address depositor, bytes32 recipient, address inputToken, uint256 inputAmount, bytes32 outputToken, uint256 outputAmount, uint256 destinationChainId, bytes32 exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityParameter, bytes message)',
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
  /** The least the destination may deliver (the quote's estimatedReceive) */
  minNative: bigint;
}

/**
 * Checks a sponsored-chain Across deposit: a plain WETH-to-WETH depositNative (paid out as native
 * ETH) into Across's SpokePool, refunding to this wallet, paying the address set at least the
 * amount shown. The caller still checks that the recipient is not a contract on the destination.
 */
export function verifySponsoredAcross(tx: { to: string; data: string }, x: SponsoredAcrossExpect): void {
  const fail = (why: string): never => { throw new Error(`Across route refused: ${why}`); };
  const spokePool = ACROSS_SOURCE_SPOKE_POOLS[x.fromChainId] ?? fail(`no known Across SpokePool on chain ${x.fromChainId}`);
  const sourceWeth = ACROSS_TOKENS[x.fromChainId]?.weth ?? fail(`Across does not carry ETH from chain ${x.fromChainId}`);
  const destWeth = ACROSS_TOKENS[x.toChainId]?.weth ?? fail(`Across does not deliver ETH on chain ${x.toChainId}`);
  if (!eq(tx.to, ACROSS_PERIPHERIES[x.fromChainId] ?? PERIPHERY_DEFAULT)) fail(`it targets ${tx.to}, not the Across periphery`);

  let args;
  try {
    const decoded = decodeFunctionData({ abi: PERIPHERY_ABI, data: tx.data as Hex });
    args = decoded.args;
  } catch {
    return fail('it swaps or is not a plain Across deposit; ZeroDust only uses plain ETH deposits');
  }
  const [pool, depositor, recipient, inputToken, inputAmount, outputToken, outputAmount, destinationChainId, , , , , message] = args;
  if (!eq(pool, spokePool)) fail(`it deposits into ${pool}, not Across's SpokePool`);
  if (!eq(inputToken, sourceWeth)) fail('a native deposit that is not WETH on the source');
  if (inputAmount !== x.value) fail('the amount deposited is not the amount sent');
  if (!eq(depositor, x.user)) fail(`refunds go to ${depositor}, not this wallet`);
  if (destinationChainId !== BigInt(x.toChainId)) fail(`it goes to chain ${destinationChainId}, not ${x.toChainId}`);
  if (message !== '0x') fail('it runs a destination message; ZeroDust only uses plain ETH deposits');
  if (!eq(recipient, bytes32Of(x.recipient))) fail('the deposit pays someone other than the address you set');
  if (!eq(addressOf(outputToken) ?? '', destWeth)) fail('the deposit delivers another token than ETH');
  if (outputAmount < x.minNative) fail('the deposit may deliver less than the amount shown');
}
