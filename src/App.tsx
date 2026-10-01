import { Nav } from './components/Nav';
import { LoadCard } from './components/LoadCard';
import { LeftPanel, RightPanel } from './components/SidePanels';

export function App() {
  return (
    <>
      <Nav />
      <main className="home">
        <LeftPanel />
        <LoadCard />
        <RightPanel />
      </main>
    </>
  );
}
