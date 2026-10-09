// Chains that announced a shutdown (backend config/closing-chains.ts, workspace
// docs/CHAIN-LIFECYCLE.md): the page warns while they close and never sends funds into them.

/** GET /chains and /direct/chains `closing`, present only for a chain that announced its shutdown */
export interface Closing {
  /** closing: still swept; cutoff: ZeroDust stopped sweeping it (sponsored) or sweeps it without a fee (direct) */
  stage: 'closing' | 'cutoff' | 'closed';
  closesAt: string;
  cutoffAt: string;
  /** The chain's own announcement */
  source: string;
  note: string;
}

const date = (iso: string, month: 'short' | 'long') =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month, timeZone: 'UTC' });

/** "31 Oct" */
export const closesShort = (c: Closing) => date(c.closesAt, 'short');
/** "31 October" */
export const closesLong = (c: Closing) => date(c.closesAt, 'long');
export const cutoffLong = (c: Closing) => date(c.cutoffAt, 'long');

/** Whether ZeroDust still takes this chain's gas out: not a sponsored chain past its cut-off */
export function stillSwept(row: { direct: boolean; closing?: Closing }): boolean {
  if (!row.closing) return true;
  return row.closing.stage === 'closing' || (row.direct && row.closing.stage === 'cutoff');
}
