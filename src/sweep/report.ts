// Sweep reports: what this page saw for a direct-chain sweep or a failed
// sweep, sent to the API (POST /reports) so a user can be helped from a
// reference instead of a guess. Only what is public on-chain or on the page:
// never the key. The returned reference (ZD-1A2B3C4D) is shown on the row.
import { API_URL } from './constants';
import type { FailureKind } from './useSweep';

export const SITE_VERSION = typeof __SITE_VERSION__ === 'string' ? __SITE_VERSION__ : 'unknown';

export interface SweepReport {
  kind: 'direct' | 'sponsored';
  outcome: 'done' | 'failed';
  failureKind?: FailureKind;
  address: string;
  chainId: number;
  toChainId?: number;
  route?: string;
  mode?: string;
  txHashes?: string[];
  sweepId?: string;
  detail?: string;
}

const HASH = /^0x[0-9a-fA-F]{64}$/;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** The report as the API accepts it: unusable fields dropped, text cut to its limit */
export function reportBody(r: SweepReport): Record<string, unknown> {
  const body: Record<string, unknown> = { kind: r.kind, outcome: r.outcome, address: r.address, chainId: r.chainId, siteVersion: SITE_VERSION };
  if (r.outcome === 'failed' && r.failureKind) body.failureKind = r.failureKind;
  if (r.toChainId !== undefined && r.toChainId !== r.chainId) body.toChainId = r.toChainId;
  if (r.route && /^[a-z0-9-]{1,32}$/.test(r.route)) body.route = r.route;
  if (r.mode && /^[a-z-]{1,16}$/.test(r.mode)) body.mode = r.mode;
  const hashes = [...new Set((r.txHashes ?? []).filter((h) => HASH.test(h)))].slice(0, 4);
  if (hashes.length) body.txHashes = hashes;
  if (r.sweepId && UUID.test(r.sweepId)) body.sweepId = r.sweepId;
  if (r.detail) body.detail = r.detail.slice(0, 500);
  return body;
}

/** Sends the report; its reference, or undefined if it could not be recorded (the copy still works) */
export async function sendReport(r: SweepReport): Promise<string | undefined> {
  try {
    const res = await fetch(`${API_URL}/reports`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(reportBody(r)),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return undefined;
    const { reference } = (await res.json()) as { reference?: string };
    return reference && /^ZD-[0-9A-F]{8}$/.test(reference) ? reference : undefined;
  } catch {
    return undefined;
  }
}

/** The text "Copy details" puts on the clipboard: everything we need to look into it, nothing secret */
export function reportText(r: SweepReport & { chainName: string; toChainName?: string; label: string; reference?: string; explorerUrl?: string; at: Date }): string {
  const tx = (h: string) => (r.explorerUrl ? `${r.explorerUrl.replace(/\/$/, '')}/tx/${h}` : h);
  return [
    'ZeroDust sweep report',
    `Reference: ${r.reference ?? 'not recorded'}`,
    `Time: ${r.at.toISOString()}`,
    `Site version: ${SITE_VERSION}`,
    `Wallet: ${r.address}`,
    `Chain: ${r.chainName} (${r.chainId})${r.toChainId !== undefined && r.toChainId !== r.chainId ? ` to ${r.toChainName ?? 'chain'} (${r.toChainId})` : ''}`,
    `Type: ${r.kind}${r.route ? `, route ${r.route}` : ''}${r.mode && r.mode !== 'route' ? `, ${r.mode}` : ''}`,
    `Result: ${r.label}${r.detail ? `: ${r.detail}` : ''}`,
    ...(r.sweepId ? [`Sweep ID: ${r.sweepId}`] : []),
    ...(r.txHashes?.length ? ['Transactions:', ...r.txHashes.map((h) => `  ${tx(h)}`)] : ['Transactions: none sent']),
  ].join('\n');
}
