import { LOGO_IDS } from '../chains/logo-ids';

/** The chain's logo (self-hosted), or its initials when there is none yet */
export function ChainIcon({ chainId, name, size = 30 }: { chainId: number; name: string; size?: number }) {
  if (LOGO_IDS.has(chainId)) {
    return <img className="ci" src={`/chains/${chainId}.svg`} alt="" width={size} height={size} />;
  }
  const initials = name.replace(/[^A-Za-z0-9 ]/g, '').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  return <span className="ci ci-text" aria-hidden="true">{initials || '?'}</span>;
}
