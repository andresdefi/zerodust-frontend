/**
 * ZeroDust's service fee for one chain, in USD, as published: 5% of a
 * balance under $1; from $1, 1% with a $0.05 minimum and a $0.50 maximum.
 * Display only: the API sizes the real fee into each quote.
 */
export function serviceFeeUsd(balanceUsd: number): number {
  if (balanceUsd <= 0) return 0;
  if (balanceUsd < 1) return balanceUsd * 0.05;
  return Math.min(0.5, Math.max(0.05, balanceUsd * 0.01));
}
