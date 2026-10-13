// Meson (meson.fi): opBNB's way out, BNB to native BNB on BNB Chain. The sweep pays Meson's
// simpleExecuteSwap(encodedSwap) exactly amount x 10^12 wei, and Meson's relayer pays amount - fee
// to the recipient registered with Meson's API when the swap was asked for. The page asks for the
// swap it signs itself (requestMesonSwap), so that recipient is the one it shows. Meson's fee is a
// fixed amount of BNB whatever is sent, so the page says it before signing (owner, 2026-10-13).
// Pinned here, checked against every plan (verify.ts).

export const MESON_API = 'https://relayer.meson.fi/api/v1';
/** Meson's contract, the same address on opBNB and BNB Chain */
export const MESON_CONTRACT = '0x25aB3Efd52e6470681CE037cD546Dc60726948D3';
/** simpleExecuteSwap(uint256 encodedSwap) */
export const MESON_EXECUTE = '0x264849e7';
/** Meson amounts carry 6 decimals: a native amount is a multiple of 10^12 wei */
export const MESON_UNIT = 10n ** 12n;

interface MesonRoute {
  toChainId: number;
  /** Meson's network and token ids, as its API names them */
  from: string;
  to: string;
  token: string;
  /** SLIP-44 short coin types in the encoded swap */
  inChain: number;
  outChain: number;
  /** Meson's index for the chain's native token, in and out */
  tokenIndex: number;
}

export const MESON_ROUTES: Readonly<Record<number, MesonRoute>> = {
  204: { toChainId: 56, from: 'opbnb', to: 'bnb', token: 'bnb', inChain: 0x00cc, outChain: 0x02ca, tokenIndex: 0xfb },
};

export interface MesonSwap {
  /** In wei */
  amount: bigint;
  /** Meson's fee in wei, taken from what arrives */
  fee: bigint;
}

/**
 * Flags in the salt's first byte (MesonHelpers): 0x80 set = paid to the recipient, not a dapp
 * contract; 0x40 set = no service fee on release; 0x06 clear = nothing shared with a partner.
 * Any other combination pays out less than amount - fee, or somewhere else.
 */
const FLAGS_MASK = 0xc6;
const FLAGS_PLAIN = 0xc0;
/** A swap whose expiry is this close is refused (Meson reverts one too close to expiring; only gas would be lost) */
const MIN_LIFE_SECONDS = 20 * 60;

/** A sweep's call into Meson: this route's swap for exactly `value`, native in and out. Throws why not */
export function checkMesonCall(chainId: number, toChainId: number, data: string, value: bigint, nowMs: number = Date.now()): MesonSwap {
  const route = MESON_ROUTES[chainId];
  if (!route || route.toChainId !== toChainId) throw new Error('Meson does not take this chain there');
  if (!data.toLowerCase().startsWith(MESON_EXECUTE) || data.length !== 2 + 8 + 64) throw new Error('the Meson call is not a plain swap');
  const n = BigInt(`0x${data.slice(10)}`);
  const bits = (shift: number, width: number) => (n >> BigInt(shift)) & ((1n << BigInt(width)) - 1n);
  if (bits(248, 8) !== 1n) throw new Error('the Meson swap has an unknown version');
  if (Number(bits(8, 16)) !== route.inChain || Number(bits(32, 16)) !== route.outChain) throw new Error('the Meson swap is for other chains');
  if (Number(bits(0, 8)) !== route.tokenIndex || Number(bits(24, 8)) !== route.tokenIndex) throw new Error('the Meson swap is not for the native token');
  if ((Number(bits(200, 8)) & FLAGS_MASK) !== FLAGS_PLAIN) throw new Error('the Meson swap is not a plain transfer to the recipient');
  if (Number(bits(48, 40)) < nowMs / 1000 + MIN_LIFE_SECONDS) throw new Error('the Meson swap expires too soon; check again');
  const amount = bits(208, 40) * MESON_UNIT;
  const fee = bits(88, 40) * MESON_UNIT;
  if (amount !== value) throw new Error('the Meson swap amount is not the amount sent');
  if (fee >= amount) throw new Error('Meson\'s fee takes everything');
  return { amount, fee };
}

/**
 * The page asks Meson for the swap itself, naming the recipient it shows: the swap in the API's
 * plan registered a recipient with Meson that the page cannot see, so it is only a quote. Same
 * amount, same chains, and Meson's fee must not have moved since the plan.
 */
export async function requestMesonSwap(chainId: number, toChainId: number, from: string, recipient: string, amount: bigint, fee: bigint): Promise<string> {
  const route = MESON_ROUTES[chainId];
  if (!route || route.toChainId !== toChainId) throw new Error('Plan refused: Meson does not take this chain there');
  const units = amount / MESON_UNIT;
  const res = await fetch(`${MESON_API}/swap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      from: `${route.from}:${route.token}`, to: `${route.to}:${route.token}`,
      amount: `${units / 1_000_000n}.${(units % 1_000_000n).toString().padStart(6, '0')}`, fromAddress: from, recipient,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { result?: { encoded?: string; tx?: { to?: string; value?: string; data?: string } }; error?: { message?: string } };
  const tx = body.result?.tx;
  if (!tx?.to || !tx.data || tx.value === undefined) throw new Error(`Meson did not give a swap (${body.error?.message ?? res.status}); check again`);
  if (tx.to.toLowerCase() !== MESON_CONTRACT.toLowerCase() || BigInt(tx.value) !== amount) throw new Error('Plan refused: Meson\'s swap is not for this amount');
  let swap: MesonSwap;
  try {
    swap = checkMesonCall(chainId, toChainId, tx.data, amount);
  } catch (error) {
    throw new Error(`Plan refused: ${(error as Error).message}`);
  }
  if (swap.fee !== fee) throw new Error('Meson\'s fee changed since the plan; check again');
  return tx.data;
}
