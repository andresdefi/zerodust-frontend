import { useState } from 'react';
import type { LocalAccount } from 'viem';
import { Nav } from './components/Nav';
import { KeyEntry, type ClipboardState } from './components/KeyEntry';
import { SweepCard } from './components/SweepCard';
import { LeftPanel, RightPanel } from './components/SidePanels';
import { useSweep } from './sweep/useSweep';

/** Dropping the key: a reload clears this tab's memory */
const forget = () => window.location.reload();

function Sweep({ account, clipboard }: { account: LocalAccount; clipboard: ClipboardState }) {
  const model = useSweep(account);
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
