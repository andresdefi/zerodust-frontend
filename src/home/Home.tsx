import { ChainIcon } from '../components/ChainIcon';
import { SearchIcon, useAddressSearch } from '../components/SiteHeader';
import { ShieldIcon } from '../components/icons';
import { SITE } from '../lib/env';

// The landing page (approved design, 2026-10-08): a ledger reading exactly zero, the
// search, before and after one sweep, three ways to reach zero, why a key is safe here.
// Copy is provisional: the redesign rewrites it.

const LOGOS: Array<[number, string]> = [
  [1, 'Ethereum'], [8453, 'Base'], [42161, 'Arbitrum'], [10, 'OP Mainnet'], [56, 'BNB Chain'], [137, 'Polygon'],
  [43114, 'Avalanche'], [59144, 'Linea'], [534352, 'Scroll'], [130, 'Unichain'], [146, 'Sonic'], [100, 'Gnosis'],
  [5000, 'Mantle'], [80094, 'Berachain'], [999, 'HyperEVM'], [143, 'Monad'], [324, 'zkSync Era'], [81457, 'Blast'],
];

/** Example only: what one sweep does to a wallet */
const EXAMPLE: Array<[number, string, string]> = [
  [8453, 'Base', '0.0042 ETH'], [42161, 'Arbitrum', '0.0019 ETH'], [43114, 'Avalanche', '0.41 AVAX'], [137, 'Polygon', '3.21 POL'],
];

export function Home({ chainCount, onMetaMask, metaMaskError }: { chainCount: number; onMetaMask: () => void; metaMaskError: string | null }) {
  const { query, setQuery, submit } = useAddressSearch();
  return (
    <main className="hm">
      <section className="hm-hero">
        <p className="hm-ledger" aria-label="0 ETH left">
          <span>0.</span><span className="hm-ledger-dim hm-long">000000000000000000</span><span className="hm-ledger-dim hm-short">0000000000</span><span className="hm-ledger-unit">ETH left</span>
        </p>
        <p className="hm-ledger-cap"><span className="hm-dot" />What every chain reads after a sweep. Not "about zero": zero.</p>
        <h1>Leave nothing behind.</h1>
        <p className="hm-lede">The gas stuck on every chain, found for any address and moved to one place. Each chain ends at exactly 0 wei.</p>
        <form className="hm-search" onSubmit={submit} role="search">
          <label className="hm-search-field">
            <SearchIcon />
            <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Paste an address or name.eth" aria-label="Address or ENS name" autoComplete="off" spellCheck={false} />
          </label>
          <button type="submit" className="btn btn-primary">Find my dust</button>
        </form>
        <p className="hm-or">or <button type="button" className="linkbtn" onClick={onMetaMask}>connect MetaMask</button> to load your own wallet</p>
        {metaMaskError && <p className="hm-error" role="alert">{metaMaskError}</p>}
        <div className="hm-logos">
          {LOGOS.map(([id, name]) => <ChainIcon key={id} chainId={id} name={name} size={28} />)}
          <span>{chainCount > LOGOS.length ? `+${chainCount - LOGOS.length} more · ${chainCount} chains` : `${chainCount} chains`}</span>
        </div>
      </section>

      <section className="hm-block">
        <p className="hm-eyebrow">One sweep</p>
        <h2>From scattered to nothing left</h2>
        <div className="hm-ba">
          <div className="hm-panel">
            <h4>Your wallet today</h4>
            <p className="hm-big">$31.84</p>
            <p className="hm-cap">scattered across 7 chains, too little to move by hand</p>
            {EXAMPLE.map(([id, name, amount]) => (
              <div className="hm-prow" key={id}><ChainIcon chainId={id} name={name} size={22} /><span>{name}</span><span>{amount}</span></div>
            ))}
            <div className="hm-prow hm-more"><span>+3 more chains</span></div>
          </div>
          <div className="hm-arrow" aria-hidden="true">→</div>
          <div className="hm-panel">
            <h4>After the sweep</h4>
            <p className="hm-big">$30.95 <small>on Base</small></p>
            <p className="hm-cap">and every source chain reads exactly 0</p>
            {EXAMPLE.map(([id, name]) => (
              <div className="hm-prow" key={id}><ChainIcon chainId={id} name={name} size={22} /><span>{name}</span><span className="hm-zero">0</span></div>
            ))}
            <div className="hm-prow hm-more"><span>+3 more at 0</span></div>
          </div>
        </div>
      </section>

      <section className="hm-band">
        <div className="hm-block">
          <p className="hm-eyebrow">Why it works where a "max" send doesn't</p>
          <h2>Three ways to reach zero</h2>
          <div className="hm-ways">
            <div className="hm-way"><p className="hm-count">52<small>chains</small></p><b>ZeroDust pays the gas</b><p>Your wallet delegates to ZeroDust's contract for one sweep (EIP-7702). The gas comes out of the fee, so the whole balance can leave.</p><p className="hm-tags"><span className="tag">Key</span><span className="tag ok">MetaMask on 16</span></p></div>
            <div className="hm-way"><p className="hm-count">21<small>chains</small></p><b>Worked out to the wei</b><p>Where ZeroDust can't pay the gas, it calculates the exact gas and fee, so your one signed transaction spends the balance to the last wei. A wallet's "max" guesses the gas and leaves the rest behind.</p><p className="hm-tags"><span className="tag">Key</span></p></div>
            <div className="hm-way"><p className="hm-count">107<small>destinations</small></p><b>It lands where you want</b><p>Same chain or another one: the bridge with the best quote carries it, and the page shows both transactions.</p><p className="hm-tags"><span className="tag">Gas.zip</span><span className="tag">Relay</span><span className="tag">Stargate</span></p></div>
          </div>
        </div>
      </section>

      <section className="hm-block">
        <h2>Built to be trusted with a key</h2>
        <div className="hm-safe">
          <p><ShieldIcon /><span><b>No key needed on 16 chains.</b> MetaMask grants a one-time permission per chain; the key never leaves it.</span></p>
          <p><ShieldIcon /><span><b>The key stays on this page.</b> Never sent, never stored. Or download the <a href={`${SITE}/offline`}>offline page</a> and run it yourself.</span></p>
          <p><ShieldIcon /><span><b>Your signature names the destination.</b> Funds can only go to the address and chain you approved.</span></p>
          <p><ShieldIcon /><span><b>Open source, every line.</b> Contracts, SDK and this site are public, and the page you load is hash-checked.</span></p>
        </div>
      </section>
    </main>
  );
}
