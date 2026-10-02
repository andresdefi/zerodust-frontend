import { CheckIcon } from './icons';
import { ChainIcon } from './ChainIcon';
import { WalletHead } from './WalletHead';
import { formatAmount, formatUsd, usdValue } from '../lib/format';
import type { SweepModel } from '../sweep/useSweep';

const STATUS_LABEL: Record<string, string> = {
  Queued: 'Queued',
  Signing: 'Signing',
  pending: 'Submitted',
  simulating: 'Simulating',
  executing: 'Sending',
  broadcasted: 'Confirming',
  bridging: 'Bridging',
  completed: 'Checking on-chain',
  'Checking on-chain': 'Checking on-chain',
};

/** Sweep in progress, then the result: each chain ends at "0 left" with a link */
export function ProgressCard({ model: m, onForget }: { model: SweepModel; onForget: () => void }) {
  const swept = m.rows.filter((r) => m.states[r.chainId] && m.states[r.chainId]!.phase !== 'idle' && m.states[r.chainId]!.phase !== 'ready' && m.states[r.chainId]!.phase !== 'no-route');
  const done = swept.filter((r) => m.states[r.chainId]!.phase === 'done');
  const failed = swept.filter((r) => m.states[r.chainId]!.phase === 'failed');
  const finished = m.stage === 'done';
  const dest = m.destRow;
  const arrived = done.reduce((s, r) => s + (m.states[r.chainId]!.receive ?? 0n), 0n);
  const arrivedUsd = dest ? formatUsd(usdValue(arrived, dest.decimals, m.prices[dest.token])) : '';
  const pct = swept.length ? Math.round(((done.length + failed.length) / swept.length) * 100) : 0;

  return (
    <section className="card" aria-labelledby="progress-title" aria-live="polite">
      <WalletHead title={finished ? 'Done' : 'Sweeping'} address={m.address} titleId="progress-title" />
      <div className="progress-head">
        {finished && failed.length === 0 ? (
          <div className="done-hero">
            <span className="done-ring"><CheckIcon /></span>
            <div>
              <div className="amt">{done.length} of {swept.length} at zero</div>
              <div className="sub">Every balance reads 0 on-chain{swept.some((r) => !r.direct) ? ' and every delegation is revoked' : ''}</div>
            </div>
          </div>
        ) : (
          <>
            <div className="amt">{done.length} of {swept.length} at zero</div>
            <div className="sub">
              {failed.length > 0 ? `${failed.length} need${failed.length === 1 ? 's' : ''} attention. ` : ''}
              {dest && arrived > 0n ? `At least ${formatAmount(arrived, dest.decimals, 6)} ${dest.token} on its way to ${dest.name}` : 'Keep this tab open until every chain shows 0'}
            </div>
            <div className="bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><i style={{ transform: `scaleX(${pct / 100})` }} /></div>
          </>
        )}
      </div>
      <div className="panel">
        {finished && dest && arrived > 0n && (
          <div className="received">
            <div><div className="bal">At least this arrives on {dest.name} at {m.toSelf ? 'your wallet' : 'the address you set'}</div><div className="amt">{formatAmount(arrived, dest.decimals, 6)} {dest.token}</div></div>
            <div className="sub">{arrivedUsd}</div>
          </div>
        )}
        <ul className="rows">
          {swept.map((r) => {
            const st = m.states[r.chainId]!;
            const tx = st.txHash && r.explorerUrl ? `${r.explorerUrl.replace(/\/$/, '')}/tx/${st.txHash}` : null;
            const what = st.choice === 'burn' ? `Burned ${formatAmount(r.balance, r.decimals)} ${r.token}`
              : st.choice === 'donate' ? `Donated ${formatAmount(r.balance, r.decimals)} ${r.token}`
              : st.receive !== undefined && dest ? `${formatAmount(st.receive, dest.decimals, 6)} ${dest.token} to ${dest.name}` : '';
            return (
              <li key={r.chainId} className="row">
                <span />
                <ChainIcon chainId={r.chainId} name={r.name} />
                <span className="name">{r.name}<span className="bal">{st.phase === 'failed' ? st.detail : what || st.detail}</span></span>
                <span className="right">
                  {st.phase === 'done' && <span className="done-zero">0 left</span>}
                  {st.phase === 'failed' && <span className="danger-text strong">Check needed</span>}
                  {st.phase === 'sweeping' && <span className="pill neutral"><span className="spin" aria-hidden="true" />{STATUS_LABEL[st.detail ?? ''] ?? st.detail}</span>}
                  {tx && <a className="tx" href={tx} target="_blank" rel="noreferrer noopener">View tx</a>}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
      <p className="footnote">
        {finished ? 'The key is still in this tab’s memory. Forget it when you are done.' : 'Keep this tab open until every chain shows 0. Results stay here until you leave.'}
      </p>
      <div className="actions two">
        {finished ? (
          <>
            <button type="button" className="btn btn-ghost btn-block" onClick={m.reload}>Refresh balances</button>
            <button type="button" className="btn btn-primary btn-block" onClick={onForget}>Forget key</button>
          </>
        ) : (
          <button type="button" className="btn btn-ghost btn-block" disabled>Sweeping…</button>
        )}
      </div>
    </section>
  );
}
