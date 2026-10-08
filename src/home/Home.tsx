import { ChainIcon } from '../components/ChainIcon';
import { SearchIcon, useAddressSearch } from '../components/SiteHeader';
import { ShieldIcon } from '../components/icons';
import { OFFLINE, SITE } from '../lib/env';

// The landing page (approved design, 2026-10-08): a ledger reading exactly zero, the
// search, before and after one sweep, three ways to reach zero, why a key is safe here.
// Copy is provisional: the redesign rewrites it.

const LOGOS: Array<[number, string]> = [
  [1, 'Ethereum'], [8453, 'Base'], [42161, 'Arbitrum'], [10, 'OP Mainnet'], [56, 'BNB Chain'], [137, 'Polygon'],
  [43114, 'Avalanche'], [59144, 'Linea'], [534352, 'Scroll'], [130, 'Unichain'], [146, 'Sonic'], [100, 'Gnosis'],
  [5000, 'Mantle'], [80094, 'Berachain'], [999, 'HyperEVM'], [143, 'Monad'], [324, 'zkSync Era'], [81457, 'Blast'],
];

/** Example only: what one sweep does to a wallet (all of it to Base, $30.95 at ~$2,690 per ETH) */
const EXAMPLE_DEST = 8453;
const EXAMPLE_ARRIVED = '0.0115 ETH';
const EXAMPLE: Array<[number, string, string]> = [
  [8453, 'Base', '0.0042 ETH'], [42161, 'Arbitrum', '0.0019 ETH'], [43114, 'Avalanche', '0.41 AVAX'], [137, 'Polygon', '3.21 POL'],
];

/** Live numbers for the page (App reads them from the API) */
export interface SiteCounts {
  /** Chains ZeroDust pays the gas on */
  sponsored: number;
  /** Of those, the ones MetaMask can sweep without the key */
  metamask: number;
  /** Chains swept by the wallet's own exact transactions */
  direct: number;
  /** Chains a sweep can land on */
  destinations: number;
}

export function Home({ counts, onMetaMask, metaMaskError }: { counts: SiteCounts; onMetaMask: () => void; metaMaskError: string | null }) {
  const { query, setQuery, submit } = useAddressSearch();
  const chainCount = counts.sponsored + counts.direct;
  return (
    <main className="hm">
      <section className="hm-hero">
        <p className="hm-ledger" aria-label="0 ETH left">
          <span>0.</span><span className="hm-ledger-dim hm-long">000000000000000000</span><span className="hm-ledger-dim hm-short">0000000000</span><span className="hm-ledger-unit">ETH left</span>
        </p>
        <p className="hm-ledger-cap"><span className="hm-dot" />What every chain reads after a sweep. Not "about zero": zero.</p>
        <h1>Leave nothing behind.</h1>
        <p className="hm-lede">Find the gas left on every chain for any address, and move it all to one place. Every chain ends at exactly zero.</p>
        <form className="hm-search" onSubmit={submit} role="search">
          <label className="hm-search-field">
            <SearchIcon />
            <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Paste an address or name.eth" aria-label="Address or ENS name" autoComplete="off" spellCheck={false} />
          </label>
          <button type="submit" className="btn btn-primary">Find my dust</button>
        </form>
        {OFFLINE
          ? <p className="hm-or">You are running the offline page from your own disk. Check for a newer version at <a href={`${SITE}/offline`}>zerodust.xyz/offline</a>.</p>
          : <p className="hm-or">or <button type="button" className="linkbtn" onClick={onMetaMask}>connect MetaMask</button> to load your own wallet</p>}
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
            <p className="hm-cap">and every other chain reads exactly 0</p>
            {/* Base is where everything lands: it holds the total; every other chain reads 0 */}
            {EXAMPLE.map(([id, name]) => (
              <div className="hm-prow" key={id}><ChainIcon chainId={id} name={name} size={22} /><span>{name}</span>{id === EXAMPLE_DEST ? <span className="hm-arrived">{EXAMPLE_ARRIVED}</span> : <span className="hm-zero">0</span>}</div>
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
            <div className="hm-way"><p className="hm-count">{counts.sponsored}<small>chains</small></p><b>ZeroDust pays the gas</b><p>For one sweep, your wallet lets ZeroDust's contract move its balance and pay the gas. The gas comes out of the fee, so nothing is left behind, and the permission is removed right after.</p><p className="hm-tags"><span className="tag">Key</span><span className="tag ok">MetaMask on {counts.metamask}</span></p></div>
            <div className="hm-way"><p className="hm-count">{counts.direct}<small>chains</small></p><b>Worked out to the wei</b><p>Where ZeroDust can't pay the gas, it calculates the exact gas and fee, so your one signed transaction spends the balance to the last wei. A wallet's "max" guesses the gas and leaves the rest behind.</p><p className="hm-tags"><span className="tag">Key</span></p></div>
            <div className="hm-way"><p className="hm-count">{counts.destinations}<small>destinations</small></p><b>It lands where you want</b><p>Same chain or another one: the bridge with the best quote carries it, and you get links to both: the one that left and the one that arrived.</p><p className="hm-tags"><span className="tag">Relay</span><span className="tag">Gas.zip</span><span className="tag">Across</span><span className="tag">Stargate</span></p></div>
          </div>
        </div>
      </section>

      <section className="hm-block">
        <h2>Built to be trusted with a key</h2>
        <div className="hm-safe">
          {!OFFLINE && <p><ShieldIcon /><span><b>No key needed on {counts.metamask} chains.</b> MetaMask grants a one-time permission per chain; the key never leaves it.</span></p>}
          {OFFLINE
            ? <p><ShieldIcon /><span><b>The key stays in this file.</b> Never sent, never stored. Only signatures leave it.</span></p>
            : <p><ShieldIcon /><span><b>The key stays on this page.</b> Never sent, never stored. Or download the <a href={`${SITE}/offline`}>offline page</a> and run it yourself.</span></p>}
          <p><ShieldIcon /><span><b>Your signature names the destination.</b> Funds can only go to the address and chain you approved.</span></p>
          <p><ShieldIcon /><span><b>Open source, every line.</b> Contracts, SDK and this site are public, and the page you load is hash-checked.</span></p>
        </div>
      </section>
    </main>
  );
}
