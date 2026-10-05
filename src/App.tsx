import { useEffect, useState } from 'react';
import type { LocalAccount } from 'viem';
import { Nav } from './components/Nav';
import { IDLE_FLAG, KeyEntry, type ClipboardState } from './components/KeyEntry';
import { SweepCard } from './components/SweepCard';
import { LeftPanel, RightPanel } from './components/SidePanels';
import { useSweep } from './sweep/useSweep';

/** Dropping the key: a reload clears this tab's memory */
const forget = () => window.location.reload();

/** A loaded key left alone this long is forgotten (never during a sweep) */
export const IDLE_FORGET_MS = 15 * 60 * 1000;

function Sweep({ account, clipboard }: { account: LocalAccount; clipboard: ClipboardState }) {
  const model = useSweep(account);
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
  // The account object holds the key in memory only; it never reaches the DOM
  const [loaded, setLoaded] = useState<{ account: LocalAccount; clipboard: ClipboardState } | null>(null);

  return (
    <>
      <Nav />
      <main className="home">
        <LeftPanel />
        {loaded
          ? <Sweep account={loaded.account} clipboard={loaded.clipboard} />
          : <KeyEntry onAccount={(account, clipboard) => setLoaded({ account, clipboard })} />}
        <RightPanel />
      </main>
    </>
  );
}
