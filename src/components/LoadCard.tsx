import { ShieldIcon } from './icons';

/**
 * The first state of the sweep card. Layout only for now: the key entry
 * (never in the DOM, clipboard wiped) arrives with the sweep flow.
 */
export function LoadCard() {
  return (
    <section className="card" aria-labelledby="load-title">
      <div className="card-head">
        <h2 id="load-title">Load wallet</h2>
      </div>
      <div className="load">
        <p>Type or paste the private key of the wallet you want to empty.</p>
        <label className="keyfield">
          <span className="visually-hidden">Private key</span>
          <input type="password" placeholder="Private key" autoComplete="off" spellCheck={false} disabled />
          <span className="hint">Paste or type</span>
        </label>
        <div className="safety">
          <div><ShieldIcon /><span>The key stays in this tab. It is never sent, saved or shown. Only signatures leave.</span></div>
          <div><ShieldIcon /><span>Pasting wipes your clipboard. Typing keeps the key off it entirely.</span></div>
        </div>
        <div className="offline">
          <span>Rather not trust a website with a key? Run the same page from your disk.</span>
          <a href="/offline">Offline page</a>
        </div>
      </div>
      <div className="actions">
        <button type="button" className="btn btn-primary btn-block" disabled>Load wallet</button>
      </div>
    </section>
  );
}
