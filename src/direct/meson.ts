// Meson (meson.fi): opBNB's way out, BNB to native BNB on BNB Chain. The sweep pays Meson's
// simpleExecuteSwap(encodedSwap) exactly amount x 10^12 wei, and Meson's relayer pays amount - fee
// to the recipient (registered with Meson's API when the API asked for the swap, as with a Relay
// request). Meson's fee is a fixed amount of BNB whatever is sent, so the page says it before
// signing (owner, 2026-10-13). Pinned here, checked against every plan (verify.ts).

/** Meson's contract, the same address on opBNB and BNB Chain */
export const MESON_CONTRACT = '0x25aB3Efd52e6470681CE037cD546Dc60726948D3';
/** simpleExecuteSwap(uint256 encodedSwap) */
export const MESON_EXECUTE = '0x264849e7';
/** Meson amounts carry 6 decimals: a native amount is a multiple of 10^12 wei */
export const MESON_UNIT = 10n ** 12n;

interface MesonRoute {
  toChainId: number;
  /** SLIP-44 short coin types in the encoded swap */
  inChain: number;
  outChain: number;
  /** Meson's index for the chain's native token, in and out */
  tokenIndex: number;
}

export const MESON_ROUTES: Readonly<Record<number, MesonRoute>> = {
  204: { toChainId: 56, inChain: 0x00cc, outChain: 0x02ca, tokenIndex: 0xfb },
};

export interface MesonSwap {
  /** In wei */
  amount: bigint;
  /** Meson's fee in wei, taken from what arrives */
  fee: bigint;
}

/** A sweep's call into Meson: this route's swap for exactly `value`, native in and out. Throws why not */
export function checkMesonCall(chainId: number, toChainId: number, data: string, value: bigint): MesonSwap {
  const route = MESON_ROUTES[chainId];
  if (!route || route.toChainId !== toChainId) throw new Error('Meson does not take this chain there');
  if (!data.toLowerCase().startsWith(MESON_EXECUTE) || data.length !== 2 + 8 + 64) throw new Error('the Meson call is not a plain swap');
  const n = BigInt(`0x${data.slice(10)}`);
  const bits = (shift: number, width: number) => (n >> BigInt(shift)) & ((1n << BigInt(width)) - 1n);
  if (bits(248, 8) !== 1n) throw new Error('the Meson swap has an unknown version');
  if (Number(bits(8, 16)) !== route.inChain || Number(bits(32, 16)) !== route.outChain) throw new Error('the Meson swap is for other chains');
  if (Number(bits(0, 8)) !== route.tokenIndex || Number(bits(24, 8)) !== route.tokenIndex) throw new Error('the Meson swap is not for the native token');
  const amount = bits(208, 40) * MESON_UNIT;
  const fee = bits(88, 40) * MESON_UNIT;
  if (amount !== value) throw new Error('the Meson swap amount is not the amount sent');
  if (fee >= amount) throw new Error('Meson\'s fee takes everything');
  return { amount, fee };
}
