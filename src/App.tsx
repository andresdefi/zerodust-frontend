import { useEffect, useState } from 'react';
import { Nav } from './components/Nav';
import { IDLE_FLAG, KeyEntry, type ClipboardState } from './components/KeyEntry';
import { SweepCard } from './components/SweepCard';
import { LeftPanel, RightPanel } from './components/SidePanels';
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

export function App() {
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
