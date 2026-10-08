// OP-stack L1 data fee of a signed transaction, computed exactly from its bytes
// (op-geth rollup cost). Direct chains of kind 'opguard' (Blast, Boba) sweep
// through ZeroDustGuard, which reverts unless the wallet is at exactly 0 once
// gas and the L1 fee are taken, so the page needs the fee to the wei: the
// API's plan carries only an estimate. Reproduced to the wei on real receipts
// on both chains (scripts/check-l1fee.ts).

export const OP_GAS_PRICE_ORACLE = '0x420000000000000000000000000000000000000F';

export type L1Formula = 'ecotone' | 'fjord';

export interface L1Params {
  l1BaseFee: bigint;
  blobBaseFee: bigint;
  baseFeeScalar: bigint;
  blobBaseFeeScalar: bigint;
}

export const hexToBytes = (hex: string): Uint8Array => {
  const s = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
};

/**
 * Length of the FastLZ (level 1) compression of `ib`, as op-geth's FlzCompressLen and Solady's
 * LibZip.flzCompress compute it (ported from Solady's js/solady.js, counting instead of writing).
 */
export function flzCompressLen(ib: Uint8Array): number {
  const b = ib.length - 4;
  const ht = new Map<number, number>();
  let a = 0;
  let i = 2;
  let o = 0;
  const u24 = (k: number) => ib[k]! | (ib[k + 1]! << 8) | (ib[k + 2]! << 16);
  const hash = (x: number) => ((Math.imul(2654435769, x) >> 19) & 8191);
  const literals = (r: number) => {
    while (r >= 32) { o += 33; r -= 32; }
    if (r) o += r + 1;
  };
  while (i < b - 9) {
    let s: number;
    let r: number;
    let c: number;
    let d: number;
    let h: number;
    do {
      s = u24(i);
      h = hash(s);
      r = ht.get(h) ?? 0;
      ht.set(h, i);
      d = i - r;
      c = d < 8192 ? u24(r) : 0x1000000;
    } while (i < b - 9 && i++ && s !== c);
    if (i >= b - 9) break;
    if (--i > a) literals(i - a);
    let l = 0;
    const p = r + 3;
    const q = i + 3;
    let e = b - q;
    for (; l < e; l++) e *= ib[p + l] === ib[q + l] ? 1 : 0;
    i += l;
    for (--d; l > 262; l -= 262) o += 3;
    o += l < 7 ? 2 : 3;
    ht.set(hash(u24(i)), i); i++;
    ht.set(hash(u24(i)), i); i++;
    a = i;
  }
  literals(b + 4 - a);
  return o;
}

/**
 * What the fee is a function of: calldata gas on Ecotone (4 per zero byte, 16 per other byte),
 * the FastLZ-compressed length on Fjord
 */
export function l1UnitsOf(signed: Uint8Array, formula: L1Formula): number {
  if (formula === 'fjord') return flzCompressLen(signed);
  let gas = 0;
  for (const byte of signed) gas += byte === 0 ? 4 : 16;
  return gas;
}

/** The L1 fee for that many units, as op-geth computes it */
export function l1FeeForUnits(units: number, formula: L1Formula, p: L1Params): bigint {
  const scaled = 16n * p.baseFeeScalar * p.l1BaseFee + p.blobBaseFeeScalar * p.blobBaseFee;
  if (formula === 'ecotone') return (BigInt(units) * scaled) / 16_000_000n;
  const estimated = -42_585_600n + 836_500n * BigInt(units);
  const size = estimated < 100_000_000n ? 100_000_000n : estimated;
  return (size * scaled) / 1_000_000_000_000n;
}

/** The L1 fee op-geth charges a transaction with these signed bytes */
export const l1FeeOf = (signed: Uint8Array, formula: L1Formula, p: L1Params): bigint => l1FeeForUnits(l1UnitsOf(signed, formula), formula, p);

/** Gas limits tried (the plan's, then one more each time) before giving up */
const SETTLE_GAS_BUMPS = 16;
/** Unit offsets tried per gas limit, most likely first: a zero byte in the signature is 12 units less (Ecotone) */
const ECOTONE_OFFSETS = [0, -12, 12, -4, 4, -24, 24, -8, 8, -16, 16];
const FJORD_OFFSETS = [0, -1, 1, -2, 2, -3, 3];

/**
 * A signed transaction whose value is exactly balance - gas x gasPrice - its own L1 fee, so the
 * wallet holds exactly 0 once the chain has charged it. The fee depends on the signed bytes,
 * which depend on the value and on the signature (new for every value), so a plain fixed-point
 * iteration can cycle. Instead: for unit counts near the first signature's, set the value as if
 * the fee were that count's, sign, and keep the first whose own count gives the same fee. A
 * value's signature is fixed (RFC 6979), so when no count matches, the gas limit goes up by one
 * for fresh signatures: the guard burns the extra gas, so the limit is still exact, and each step
 * costs one gas at the plan's price.
 * `sign` builds and signs the transaction for a value and gas limit (folding the difference into
 * the fee or the forwarded amount, as the plan says).
 */
export async function settleL1Value(p: {
  balance: bigint;
  gas: bigint;
  gasPrice: bigint;
  formula: L1Formula;
  params: L1Params;
  firstValue: bigint;
  sign: (value: bigint, gas: bigint) => Promise<Uint8Array>;
}): Promise<{ value: bigint; gas: bigint; l1Fee: bigint; signed: Uint8Array }> {
  const offsets = p.formula === 'ecotone' ? ECOTONE_OFFSETS : FJORD_OFFSETS;
  for (let bump = 0n; bump < BigInt(SETTLE_GAS_BUMPS); bump++) {
    const gas = p.gas + bump;
    const gasCost = gas * p.gasPrice;
    const first = l1UnitsOf(await p.sign(p.firstValue - bump * p.gasPrice, gas), p.formula);
    for (const offset of offsets) {
      const l1Fee = l1FeeForUnits(first + offset, p.formula, p.params);
      const value = p.balance - gasCost - l1Fee;
      if (value <= 0n) continue;
      const signed = await p.sign(value, gas);
      if (l1FeeOf(signed, p.formula, p.params) === l1Fee) return { value, gas, l1Fee, signed };
    }
  }
  throw new Error('The L1 fee did not settle on a value; try again');
}
