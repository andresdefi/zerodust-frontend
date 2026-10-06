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
        {/* The offline page is key-only: MetaMask needs a hosted origin */}
        {OFFLINE ? (
          <ol>
            <li><span><b>Load the wallet</b>The key stays in this tab. Only signatures leave it.</span></li>
            <li><span><b>Choose where it goes</b>One chain and one address, your own by default.</span></li>
            <li><span><b>Check</b>Real quotes, signed and simulated. Nothing is sent.</span></li>
            <li><span><b>Sweep</b>Done when each balance reads 0 on-chain and the funds arrive.</span></li>
          </ol>
        ) : (
          <ol>
            <li><span><b>Connect MetaMask</b>Your key stays in MetaMask. For chains MetaMask does not cover, load the wallet with its key; it stays in this tab.</span></li>
            <li><span><b>Choose where it goes</b>One chain and one address, your own by default. A chain's menu can send it to another address on that chain.</span></li>
            <li><span><b>Check</b>Real quotes for every chain, with the bridge and its usual time. Nothing is signed or sent.</span></li>
            <li><span><b>Sweep</b>Approve in MetaMask. Done when each balance reads 0 on-chain and the funds arrive.</span></li>
          </ol>
        )}
      </details>
      {!OFFLINE && (
        <details className="fold">
          <summary><span>What MetaMask shows</span><span className="gist">Approve each chain, then sign once</span></summary>
          <ol>
            <li><span><b>Switch to smart account</b>The first time on a chain only. MetaMask's own upgrade, a little gas from that chain's balance.</span></li>
            <li><span><b>Grant, then Confirm</b>Per chain: a one-time permission for that chain's balance. Only ZeroDust's router can use it, for 10 minutes.</span></li>
            <li><span><b>One signature</b>Covers every chain at once: where each one goes and the most it can cost.</span></li>
          </ol>
        </details>
      )}
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
      <details className="fold">
        <summary><span>Open source</span><span className="gist">Contracts, SDK and this site, on GitHub</span></summary>
        <ul>
          <li><a className="link" href="https://github.com/andresdefi/zerodust">andresdefi/zerodust</a>: the sweep contract, the SDK and the agent tools.</li>
          <li><a className="link" href="https://github.com/andresdefi/zerodust-frontend">andresdefi/zerodust-frontend</a>: this site. Its build is reproducible: <a className="link" href={`${SITE}/security`}>check it</a>.</li>
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
