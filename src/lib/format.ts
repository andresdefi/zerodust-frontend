import { formatUnits } from 'viem';

/** A token amount with at most `digits` decimals, trailing zeros dropped */
export function formatAmount(value: bigint, decimals: number, digits = 6): string {
  const [whole, frac = ''] = formatUnits(value, decimals).split('.');
  const trimmed = frac.slice(0, digits).replace(/0+$/, '');
  if (trimmed) return `${whole}.${trimmed}`;
  // A balance too small for the digits shown is still not zero
  return value > 0n && whole === '0' ? `< 0.${'0'.repeat(digits - 1)}1` : whole!;
}

/**
 * An amount someone must reach (a minimum, a top-up), rounded UP to
 * `significant` digits so reaching the shown figure is always enough
 */
export function formatAmountUp(value: bigint, decimals: number, significant = 4): string {
  if (value <= 0n) return '0';
  const drop = BigInt(Math.max(0, value.toString().length - significant));
  const step = 10n ** drop;
  return formatUnits(((value + step - 1n) / step) * step, decimals);
}

/** USD value of an amount, or null when the token has no price */
export function usdValue(amount: bigint, decimals: number, price: number | undefined): number | null {
  if (!price) return null;
  return (Number(amount) / 10 ** decimals) * price;
}

/** "$1.23", "< $0.01", or "" for no price */
export function formatUsd(value: number | null): string {
  if (value === null) return '';
  if (value > 0 && value < 0.01) return '< $0.01';
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** 0x8f3A…21c4 */
export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
