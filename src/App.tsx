import { useEffect, useState } from 'react';
import { ZeroDust } from '@zerodust/sdk';
import { isAddressEqual, type Address } from 'viem';
import { SiteHeader } from './components/SiteHeader';
import { AddressPage } from './address/AddressPage';
import { Home } from './home/Home';
import { directChains } from './direct/plan';
import { addressHref, navigate, useView } from './lib/route';
import { API_URL } from './sweep/constants';
import { connectMetaMask, findMetaMask, type MetaMaskSession } from './sweep/metamask';

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
