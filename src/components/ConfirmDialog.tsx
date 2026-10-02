import { useEffect, useRef } from 'react';
import { formatAmount, formatUsd, shortAddress, usdValue } from '../lib/format';
import { isExit, type Row, type SweepModel } from '../sweep/useSweep';

/** Last stop before anything is sent: every chain, its amount, and any burn or donation spelled out */
export function ConfirmDialog({ open, model: m, onCancel, onConfirm }: {
  open: boolean;
  model: SweepModel;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  const amount = (r: Row) => {
    const usd = formatUsd(usdValue(r.balance, r.decimals, m.prices[r.token]));
    return `${formatAmount(r.balance, r.decimals)} ${r.token}${usd ? ` (${usd})` : ''}`;
  };
  const routed = m.readyRows.filter((r) => !m.choices[r.chainId] || isExit(m.choices[r.chainId]));
  const exits = m.readyRows.filter((r) => isExit(m.choices[r.chainId]));
  const burned = m.readyRows.filter((r) => m.choices[r.chainId] === 'burn');
  const donated = m.readyRows.filter((r) => m.choices[r.chainId] === 'donate');
  const dest = m.destRow;
  const receiveUsd = dest ? formatUsd(usdValue(m.readyTotal, dest.decimals, m.prices[dest.token])) : '';
  const n = m.readyRows.length;

  return (
    <dialog ref={dialog} className="modal confirm" onClose={onCancel} aria-labelledby="confirm-title" aria-describedby="confirm-lead">
      <h3 id="confirm-title">Sweep {n} chain{n === 1 ? '' : 's'}{dest ? ` to ${dest.name}` : ''}?</h3>
      <p id="confirm-lead" className="lead">Every balance below leaves your wallet and each chain ends at exactly 0. This cannot be undone.</p>
      <ul className="dlist">
        {routed.map((r) => <li key={r.chainId}><span>{r.name}</span><span>{amount(r)}</span></li>)}
      </ul>
      {exits.map((r) => <p key={r.chainId} className="donate-note">{r.name}: swapped out through LI.FI; the few cents of gas reserve left are {m.choices[r.chainId] === 'exit-burn' ? 'burned' : 'donated to ZeroDust'}.</p>)}
      {burned.map((r) => <p key={r.chainId} className="burn-note">{r.name}: {amount(r)} is burned. You will not receive it.</p>)}
      {donated.map((r) => <p key={r.chainId} className="donate-note">{r.name}: {amount(r)} is donated to ZeroDust. You will not receive it.</p>)}
      {dest && routed.length > 0 && (
        <p className="dest-note">
          You receive at least <strong>{formatAmount(m.readyTotal, dest.decimals, 6)} {dest.token}{receiveUsd && ` (${receiveUsd})`}</strong> on {dest.name} at{' '}
          {m.toSelf ? <><strong>your wallet</strong>, {shortAddress(m.recipient)}</> : <strong className="addr">{m.recipient}</strong>}.
        </p>
      )}
      <div className="btns">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>
        <button type="button" className="btn btn-primary" onClick={onConfirm}>Sweep {n} chain{n === 1 ? '' : 's'}</button>
      </div>
    </dialog>
  );
}
