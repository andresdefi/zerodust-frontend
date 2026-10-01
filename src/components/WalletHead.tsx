import { shortAddress } from '../lib/format';

/** Card title with the loaded wallet's address */
export function WalletHead({ title, address, titleId }: { title: string; address: string; titleId?: string }) {
  return (
    <div className="card-head">
      <h2 id={titleId}>{title}</h2>
      <span className="wallet-chip" title={address}><span className="avatar" aria-hidden="true" />{shortAddress(address)}</span>
    </div>
  );
}
