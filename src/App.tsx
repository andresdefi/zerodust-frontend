import { useEffect, useState } from 'react';
import { ZeroDust } from '@zerodust/sdk';
import { isAddressEqual, type Address } from 'viem';
import { Nav } from './components/Nav';
import { IDLE_FLAG, KeyEntry, type ClipboardState } from './components/KeyEntry';
import { SweepCard } from './components/SweepCard';
import { SiteHeader } from './components/SiteHeader';
import { LeftPanel, RightPanel } from './components/SidePanels';
import { AddressPage } from './address/AddressPage';
import { Home } from './home/Home';
import { directChains } from './direct/plan';
import { addressHref, navigate, useView } from './lib/route';
import { API_URL } from './sweep/constants';
import { connectMetaMask, findMetaMask, type MetaMaskSession } from './sweep/metamask';
import { useSweep, type Wallet } from './sweep/useSweep';

/** Dropping the key: a reload clears this tab's memory */
const forget = () => window.location.reload();

/** A loaded key left alone this long is forgotten (never during a sweep) */
export const IDLE_FORGET_MS = 15 * 60 * 1000;

function Sweep({ wallet, clipboard }: { wallet: Wallet; clipboard: ClipboardState }) {
  const model = useSweep(wallet);
  const sweeping = model.stage === 'sweeping';
  useEffect(() => {
    if (sweeping) return;
    let timer = setTimeout(expire, IDLE_FORGET_MS);
    function expire() {
      try { sessionStorage.setItem(IDLE_FLAG, '1'); } catch { /* the reload still forgets the key */ }
      forget();
    }
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(expire, IDLE_FORGET_MS);
    };
    const events = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
    for (const e of events) window.addEventListener(e, reset, { passive: true });
    return () => {
      clearTimeout(timer);
      for (const e of events) window.removeEventListener(e, reset);
    };
  }, [sweeping]);
  return <SweepCard model={model} clipboard={clipboard} onForget={forget} />;
}

/**
 * The sweep flow as it is today (key or MetaMask, then the card). The redesign keeps it at
 * /sweep, and in the offline file, until the address page can sweep (phase 3).
 */
function LegacySweep() {
  // A key's account object lives in memory only and never reaches the DOM; a MetaMask session holds no key
  const [loaded, setLoaded] = useState<{ wallet: Wallet; clipboard: ClipboardState } | null>(null);
  return (
    <>
      <Nav />
      <main className="home">
        <LeftPanel />
        {loaded
          ? <Sweep wallet={loaded.wallet} clipboard={loaded.clipboard} />
          : <KeyEntry
              onAccount={(account, clipboard) => setLoaded({ wallet: { kind: 'key', account }, clipboard })}
              onMetaMask={(session) => setLoaded({ wallet: { kind: 'metamask', session }, clipboard: null })}
            />}
        <RightPanel />
      </main>
    </>
  );
}

const client = new ZeroDust({ environment: 'mainnet', baseUrl: API_URL });

/** How many chains ZeroDust sweeps (sponsored + direct), for the home page */
function useChainCount(): number {
  const [count, setCount] = useState(73);
  useEffect(() => {
    void Promise.all([client.getChains().catch(() => null), directChains().catch(() => null)]).then(([s, d]) => {
      if (s && d) setCount(s.length + d.chains.length);
    });
  }, []);
  return count;
}

function Site() {
  const view = useView();
  const chainCount = useChainCount();
  // One MetaMask session for the whole site: the header shows it, the address page signs with it
  const [session, setSession] = useState<MetaMaskSession | null>(null);
  const [mmBusy, setMmBusy] = useState(false);
  const [mmError, setMmError] = useState<string | null>(null);

  // Switching or disconnecting the account in MetaMask ends this session
  useEffect(() => {
    if (!session) return;
    const { provider, address } = session;
    if (!provider.on) return;
    const changed = (accounts: unknown) => {
      const next = Array.isArray(accounts) ? accounts[0] : undefined;
      if (typeof next !== 'string' || !isAddressEqual(next as Address, address)) setSession(null);
    };
    provider.on('accountsChanged', changed);
    return () => provider.removeListener?.('accountsChanged', changed);
  }, [session]);

  const onMetaMask = async () => {
    setMmError(null);
    // Already connected: the button opens the connected wallet's page
    if (session) {
      navigate(addressHref(session.address));
      return;
    }
    const provider = await findMetaMask();
    if (!provider) {
      setMmError('MetaMask was not found in this browser. Paste the address instead, or install MetaMask.');
      if (view.kind !== 'home') navigate('/');
      return;
    }
    setMmBusy(true);
    try {
      const s = await connectMetaMask(provider);
      setSession(s);
      navigate(addressHref(s.address));
    } catch (error) {
      setMmError(error instanceof Error ? error.message : 'MetaMask did not connect.');
    } finally {
      setMmBusy(false);
    }
  };

  if (view.kind === 'sweep') return <LegacySweep />;
  return (
    <>
      <SiteHeader search={view.kind !== 'home'} onMetaMask={() => void onMetaMask()} metaMaskBusy={mmBusy} account={session?.address ?? null} />
      {view.kind === 'home'
        ? <Home chainCount={chainCount} onMetaMask={() => void onMetaMask()} metaMaskError={mmError} />
        : (
          <>
            {mmError && <p className="hdr-error" role="alert">{mmError}</p>}
            <AddressPage key={view.query} query={view.query} session={session} onSession={setSession} />
          </>
        )}
    </>
  );
}

export function App() {
  return <Site />;
}
