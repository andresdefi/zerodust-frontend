import { useEffect, useRef, useState } from 'react';
import type { DestOption } from '../sweep/useSweep';
import { ChainIcon } from './ChainIcon';

/** Modal list of every chain the funds can go to, with how many sources reach each */
export function DestinationPicker({
  open, dests, sourceCount, current, onPick, onClose,
}: {
  open: boolean;
  dests: DestOption[];
  sourceCount: number;
  current: number | null;
  onPick: (chainId: number) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) {
      setQuery('');
      d.showModal();
    }
    if (!open && d.open) d.close();
  }, [open]);

  const q = query.trim().toLowerCase();
  const shown = dests.filter((d) => !q || d.name.toLowerCase().includes(q) || d.token.toLowerCase().includes(q) || String(d.chainId) === q);

  return (
    <dialog ref={dialog} className="modal picker" onClose={onClose} aria-labelledby="picker-title">
      <div className="modal-head">
        <h3 id="picker-title">Receive on</h3>
        <button type="button" className="iconbtn" onClick={onClose} aria-label="Close">✕</button>
      </div>
      <input
        className="search"
        type="search"
        placeholder={`Search ${dests.length} chains`}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label="Search chains"
        autoFocus
      />
      {sourceCount > 1 && dests.some((d) => d.reachableFrom < sourceCount) && (
        <p className="picker-note">Chains only some of your balances can reach show how many. The rest are left out of the sweep.</p>
      )}
      <ul className="picks">
        {shown.map((d) => {
          const partial = sourceCount > 0 && d.reachableFrom < sourceCount;
          return (
            <li key={d.chainId}>
              <button type="button" className={`pick${d.chainId === current ? ' sel' : ''}`} onClick={() => onPick(d.chainId)} aria-current={d.chainId === current}>
                <ChainIcon chainId={d.chainId} name={d.name} />
                <span className="pick-name">{d.name}<small>{d.token}</small></span>
                {sourceCount > 0 && (
                  <span className={partial ? 'reach warn' : 'reach'}>
                    {partial ? `From ${d.reachableFrom} of ${sourceCount}` : sourceCount === 1 ? 'Reachable' : `From all ${sourceCount}`}
                  </span>
                )}
              </button>
            </li>
          );
        })}
        {shown.length === 0 && <li className="picker-empty">No chain matches “{query}”.</li>}
      </ul>
    </dialog>
  );
}
