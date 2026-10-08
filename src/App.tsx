import { useEffect, useState } from 'react';
import { ZeroDust } from '@zerodust/sdk';
import { isAddressEqual, type Address } from 'viem';
import { SiteHeader } from './components/SiteHeader';
import { AddressPage } from './address/AddressPage';
import { Home, type SiteCounts } from './home/Home';
import { SiteFooter } from './components/SiteFooter';
import { directChains } from './direct/plan';
import { addressHref, navigate, useView } from './lib/route';
import { API_URL } from './sweep/constants';
import { connectMetaMask, findMetaMask, type MetaMaskSession } from './sweep/metamask';

const client = new ZeroDust({ environment: 'mainnet', baseUrl: API_URL });

/** The home page's numbers, read live (the defaults are the counts on 2026-10-08, shown until the API answers) */
function useSiteCounts(): SiteCounts {
  const [counts, setCounts] = useState<SiteCounts>({ sponsored: 52, metamask: 16, direct: 21, destinations: 109 });
  useEffect(() => {
    void Promise.all([
      client.getChains().catch(() => null),
      directChains().catch(() => null),
      client.getDestinations(8453).catch(() => null),
    ]).then(([s, d, dests]) => {
      setCounts((prev) => ({
        sponsored: s?.length ?? prev.sponsored,
        // GET /chains marks the chains a MetaMask permission can sweep
        metamask: s ? s.filter((c) => (c as { metamask?: boolean }).metamask).length : prev.metamask,
        direct: d?.chains.length ?? prev.direct,
        // Every chain a sweep can land on, counted from Base (the destination itself included)
        destinations: dests ? dests.length + 1 : prev.destinations,
      }));
    });
  }, []);
  return counts;
}

function Site() {
  const view = useView();
  const counts = useSiteCounts();
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
        ? <Home counts={counts} onMetaMask={() => void onMetaMask()} metaMaskError={mmError} />
        : (
          <>
            {mmError && <p className="hdr-error" role="alert">{mmError}</p>}
            <AddressPage key={view.query} query={view.query} session={session} onSession={setSession} />
          </>
        )}
      <SiteFooter />
    </>
  );
}

export function App() {
  return <Site />;
}
