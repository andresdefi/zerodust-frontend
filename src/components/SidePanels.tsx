// The information around the sweep card. Each block is collapsed to one
// line that carries its gist (native <details>: keyboard accessible, no
// script), so the card stays the one thing that asks for attention. On
// narrow screens the card comes right after the headline and these follow.
import { OFFLINE, SITE } from '../lib/env';

export function LeftPanel() {
  return (
    <aside className="side left">
      <div>
        <h1>Empty a wallet to exactly zero.</h1>
        <p className="lede">The native gas left on every chain, moved to one address in one go. Not one wei stays behind.</p>
      </div>
      <details className="fold">
        <summary><span>How it works</span><span className="gist">4 steps, nothing sent until you confirm</span></summary>
        <ol>
          <li><span><b>Load the wallet</b>The key stays in this tab. Only signatures leave it.</span></li>
          <li><span><b>Choose where it goes</b>One chain and one address, your own by default.</span></li>
          <li><span><b>Check</b>Real quotes, signed and simulated. Nothing is sent.</span></li>
          <li><span><b>Sweep</b>Done when each balance reads 0 on-chain and the funds arrive.</span></li>
        </ol>
      </details>
    </aside>
  );
}

export function RightPanel() {
  return (
    <aside className="side">
      <details className="fold">
        <summary><span>Fees</span><span className="gist">5% under $1, then 1% ($0.05 to $0.50)</span></summary>
        <dl>
          <dt>$1 or more</dt><dd>1%, $0.05 to $0.50</dd>
          <dt>Under $1</dt><dd>5%</dd>
          <dt>Gas and bridge</dt><dd>At cost</dd>
        </dl>
      </details>
      <details className="fold">
        <summary><span>Before you sweep</span><span className="gist">A sweep cannot be undone</span></summary>
        <ul>
          <li><strong>A sweep cannot be undone.</strong> Check the address.</li>
          <li><strong>Burning is permanent,</strong> and only offered where no route exists.</li>
          <li>ZeroDust never holds your funds.</li>
        </ul>
      </details>
      <p className="note">
        {OFFLINE
          ? <>Offline page. Check for a newer version at <a className="link" href={`${SITE}/offline`}>zerodust.xyz/offline</a>.</>
          : <>Rather not trust a website with a key? <a className="link" href="/offline">Use the offline page</a>.</>}
      </p>
    </aside>
  );
}
