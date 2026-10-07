import { StaticPage } from './Layout';
import type { PageBuild as BuildRecord } from './build-record';

export function SecurityPage({ build }: { build: BuildRecord }) {
  return (
    <StaticPage>
      <h1>Security</h1>
      <p className="doc-lede">
        With MetaMask, this page never sees your key: MetaMask grants a narrow permission and signs. For
        chains MetaMask does not cover, and on the offline page, the page needs the wallet's private key.
        Here is exactly what each way allows, what the page talks to, and how to check that the page you
        run is the one published here.
      </p>

      <h2>With MetaMask</h2>
      <ul>
        <li>The key stays in MetaMask. The page gets your address and what you approve, nothing else.</li>
        <li>
          Per chain, MetaMask grants a one-time permission (ERC-7715) to move that chain's balance once.
          ZeroDust's router is the only contract that can use it and the only one that can receive from it,
          and it expires after 10 minutes.
        </li>
        <li>
          You sign one message for every chain. It names each chain's destination, the least that must
          arrive and the most the fees can take. The router refuses any sweep that differs from it, and
          reverts unless the wallet ends at exactly 0.
        </li>
        <li>
          The first time on a chain, MetaMask also switches the account to its smart account. That is
          MetaMask's own delegation, not ZeroDust's, and it stays after the sweep.
        </li>
        <li>Router: <code>0x369A97dd256F7eb37fF7116C4EcBd50318eBb286</code>, the same address on every chain it is on.</li>
      </ul>

      <h2>With the key</h2>
      <ul>
        <li>It stays in the memory of the tab. It is never sent anywhere, saved, logged or shown.</li>
        <li>
          The key field never holds it: keystrokes and pastes are collected in memory and only dots are
          drawn, so the key is not in the page's HTML for an extension or a screen reader to read.
        </li>
        <li>Pasting wipes your clipboard. Typing the key keeps it off the clipboard entirely.</li>
        <li>Only signatures and signed transactions leave the tab. Reloading the page or pressing Forget key drops the key.</li>
      </ul>

      <h2>What the page talks to</h2>
      <ul>
        <li><strong>api.zerodust.xyz</strong>: balances, quotes and plans. It never receives the key.</li>
        <li>
          <strong>Each chain's public RPC</strong>: to read balances and nonces, to check a sweep landed at
          exactly 0, and for chains without a sponsor, to send the signed transactions directly. The list is
          fixed in the page's Content-Security-Policy; the browser blocks anything else.
        </li>
        <li><strong>MetaMask</strong>, through the extension in your browser, when you connect it.</li>
        <li>
          <strong>api.relay.link</strong>: for a MetaMask sweep that Relay carries, to ask Relay for the deposit
          itself. It receives your address, the destination address, the chains and the amount.
        </li>
        <li>Nothing else: no analytics, no third-party scripts or fonts, no wallet SDKs, no tracking cookies.</li>
      </ul>

      <h2>Nothing is signed on trust</h2>
      <ul>
        <li>
          Chains with a sponsor (EIP-7702): the ZeroDust SDK builds what you sign itself and checks every
          quote against your request and against the chain before signing. The delegation can only point at
          the ZeroDust contract, and the sweep cannot finish unless your balance ends at exactly 0.
        </li>
        <li>
          With MetaMask: the router's address is fixed in the page, not taken from the API. Each chain's
          quote gets the same checks as a key sweep, and the one message you sign is built in the page from
          those checked quotes. A quote or message that names another contract or differs in any field is
          refused before MetaMask is asked to sign. For a Relay route the page asks Relay for the deposit
          itself, so Relay pays the address you set; an Across route must be a plain ETH deposit to a
          wallet, checked on the destination chain.
        </li>
        <li>
          Chains without a sponsor: the page checks the plan the API sends (it spends your balance to the
          wei, the fee is at most 5%, the deposit names your address) and replays it on a copy of the chain
          inside the page before signing. A plan that fails any check is refused, never adjusted.
        </li>
      </ul>

      <h2>How the page is locked down</h2>
      <ul>
        <li>Content-Security-Policy with <code>default-src 'none'</code> and <code>script-src 'self'</code>: no inline code, no eval, no other hosts.</li>
        <li>Subresource Integrity on every script and stylesheet; the build checks every hash before it ships.</li>
        <li>The page cannot be framed, sends no referrer, and has camera, microphone, payment and similar permissions switched off.</li>
        <li>Dependencies are pinned to exact versions. The source is public.</li>
      </ul>

      <h2>Check the build</h2>
      <p>
        The build is reproducible: building the public source at the same commit gives the same files, byte
        for byte. One SHA-256 over every file (each file's hash and path, sorted) identifies it.
      </p>
      <dl className="hashes">
        <dt>This site</dt>
        {/* A page cannot hold the hash of the files it is part of: filled in from the build record */}
        <dd><code data-build="siteSha256">see /.well-known/zerodust-build.json</code></dd>
        <dt>Offline page</dt>
        <dd><code>{build.offlineSha256}</code></dd>
        <dt>Commit</dt>
        <dd><code>{build.commit}</code></dd>
      </dl>
      <pre className="cmd"><code>{`git clone https://github.com/andresdefi/zerodust-frontend
cd zerodust-frontend && git checkout ${build.commit}
npm ci && npm run build   # prints "build sha256: ..."`}</code></pre>
      <p>
        Rather not trust a hosted page at all? <a href="/offline">Use the offline page</a>: one file you
        check once and run from your own disk.
      </p>

      <h2>What we never do</h2>
      <ul>
        <li>Ask for your key anywhere but this page, or by email, chat or support.</li>
        <li>Hold your funds: they move from your wallet to the destination in the sweep itself.</li>
        <li>Run analytics, ads or tracking on this page.</li>
      </ul>
    </StaticPage>
  );
}
