import { useCallback, useMemo, useRef, useState, type FormEvent } from 'react';
import { isAddressEqual, type Address } from 'viem';
import { ChainIcon } from '../components/ChainIcon';
import { DestinationPicker } from '../components/DestinationPicker';
import { formatAmount, formatUsd, shortAddress } from '../lib/format';
import { groupChains, groupText, tokenRouteOf, type GroupKey } from './groups';
import { resolveName, useAddressData, useEstimates, useResolved, type AddressRow, type ChainOption, type Estimate } from './useAddress';
import { SweepSession, SweepWithDialog, type SweepPlan } from './SweepSession';
import type { RowState, Wallet } from '../sweep/useSweep';

// One address: every chain holding gas, in groups by how it is swept and what arrives.
// Reading needs nothing; sweeping a group asks how to sign (MetaMask or the key of this
// address), checks every chain, confirms, and shows each chain's progress in its row.

/** A bridge keeping more than this share of a chain's value is flagged next to it */
const BRIDGE_TAKES_FLAG = 0.5;

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className="ap-copy" aria-label="Copy address" onClick={() => { void navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1200); }); }}>
      {done ? '✓' : '⧉'}
    </button>
  );
}

export function AddressPage({ query }: { query: string }) {
  const resolved = useResolved(query);
  if (resolved.state === 'loading') return <main className="ap"><div className="ap-state">Looking up {query}…</div></main>;
  if (resolved.state === 'error') return <main className="ap"><div className="ap-state" role="alert">{resolved.message}</div></main>;
  return <Loaded address={resolved.address} name={resolved.name} />;
}

function Loaded({ address, name }: { address: Address; name: string | null }) {
  const [chosenDest, setChosenDest] = useState<number | null>(null);
  const [picking, setPicking] = useState(false);
  const [recipient, setRecipient] = useState<Address>(address);
  const [defaultDest, setDefaultDest] = useState<number | null>(null);
  const destination = chosenDest ?? defaultDest;
  const isDefault = chosenDest === null && destination !== null;
  const [version, setVersion] = useState(0);
  const data = useAddressData(address, destination, recipient, version);
  // Default destination (owner, 2026-10-08): where most of the wallet's bridgeable gas already is,
  // so the most stays put; shown prominently as changeable. Base when nothing qualifies.
  if (data.state === 'ready' && defaultDest === null) {
    const top = data.rows.filter((r) => !r.direct && data.routesOf(r.chainId).gas === true).sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0))[0];
    setDefaultDest(top?.chainId ?? 8453);
  }
  const toSelf = isAddressEqual(recipient, address);
  // To this same wallet, the destination chain's own balance is already where everything goes
  const here = toSelf && destination !== null ? data.rows.find((r) => r.chainId === destination) : undefined;
  const movable = useMemo(() => (here ? data.rows.filter((r) => r !== here) : data.rows), [data.rows, here]);
  const groups = useMemo(() => groupChains(movable, data.routesOf, destination), [movable, data.routesOf, destination]);
  const destName = destination === null ? null : data.chainOptions.find((c) => c.chainId === destination)?.name ?? `Chain ${destination}`;
  const destToken = destination === null ? null : data.chainOptions.find((c) => c.chainId === destination);

  // One group at a time: picking a chain in another group starts a new selection there
  const [selection, setSelection] = useState<{ group: GroupKey; ids: Set<number> } | null>(null);
  const activeGroup = selection?.group ?? groups.find((g) => g.key === 'metamask' || g.key === 'key')?.key ?? null;
  const active = groups.find((g) => g.key === activeGroup);
  const gasGroup = activeGroup === 'metamask' || activeGroup === 'key';
  // Both gas groups share the destination: quote them together
  const gasChains = groups.filter((g) => g.key === 'metamask' || g.key === 'key').flatMap((g) => g.chains);
  const estimates = useEstimates(address, gasChains, destination, recipient);
  // By default a group's chains are all selected, except those no bridge answered for or that failed to quote
  const [progress, setProgress] = useState<{ states: Record<number, RowState>; bridgeOf: Record<number, string> }>({ states: {}, bridgeOf: {} });
  // A chain swept to 0 is not offered again until the balances are read again
  const finished = useMemo(() => new Set(Object.entries(progress.states).filter(([, st]) => st.phase === 'done').map(([id]) => Number(id))), [progress.states]);
  const sweepable = (c: AddressRow) => !data.routesOf(c.chainId).unknown && !estimates[c.chainId]?.error && !finished.has(c.chainId);
  const selectedIds = selection?.ids ?? new Set(active?.chains.filter(sweepable).map((c) => c.chainId) ?? []);

  const toggle = (group: GroupKey, chainId: number) => {
    const ids = new Set(group === activeGroup ? selectedIds : []);
    if (ids.has(chainId)) ids.delete(chainId);
    else ids.add(chainId);
    setSelection({ group, ids });
  };
  const toggleGroup = (group: GroupKey, chains: AddressRow[]) => {
    const all = group === activeGroup && chains.every((c) => selectedIds.has(c.chainId));
    setSelection({ group, ids: all ? new Set() : new Set(chains.map((c) => c.chainId)) });
  };

  // Sweeping: the wallet chosen to sign (kept for the next group), the group waiting for one, the run
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [pending, setPending] = useState<SweepPlan | null>(null);
  const [run, setRun] = useState<{ id: number; plan: SweepPlan; wallet: Wallet } | null>(null);
  const [ownAddress, setOwnAddress] = useState<Address | null>(null);
  const [elsewhereChain, setElsewhereChain] = useState<number | null>(null);
  const [pickingElsewhere, setPickingElsewhere] = useState(false);
  const onProgress = useCallback((states: Record<number, RowState>, bridgeOf: Record<number, string>) => {
    setProgress((prev) => ({ states: { ...prev.states, ...states }, bridgeOf: { ...prev.bridgeOf, ...bridgeOf } }));
  }, []);
  const sweepingNow = Object.values(progress.states).some((st) => st.phase === 'sweeping');
  const anyResult = Object.values(progress.states).some((st) => st.phase === 'done' || st.phase === 'failed');
  const runs = useRef(0);
  const begin = (plan: SweepPlan, w: Wallet) => {
    setWallet(w);
    setPending(null);
    runs.current += 1;
    setRun({ id: runs.current, plan, wallet: w });
  };
  const startSweep = (group: GroupKey, chains: AddressRow[]) => {
    if (destination === null || chains.length === 0 || sweepingNow) return;
    if (group === 'own-chain' && !ownAddress) return;
    if (group === 'elsewhere' && elsewhereChain === null) { setPickingElsewhere(true); return; }
    setSelection({ group, ids: new Set(chains.map((c) => c.chainId)) });
    const plan: SweepPlan = { group, chains, destination, recipient, ownChainAddress: ownAddress ?? undefined, elsewhereChain: elsewhereChain ?? undefined };
    // A loaded key signs for every chain: no need to ask again
    if (wallet?.kind === 'key') begin(plan, wallet);
    else setPending(plan);
  };
  const optionOf = (chainId: number): ChainOption | undefined => data.chainOptions.find((o) => o.chainId === chainId);

  const total = data.rows.reduce((s, r) => s + (r.usd ?? 0), 0);
  const selectedRows = active ? active.chains.filter((c) => selectedIds.has(c.chainId) && !finished.has(c.chainId)) : [];
  const quotedRows = selectedRows.filter((r) => estimates[r.chainId]?.receive !== undefined);
  const selectedReceive = quotedRows.reduce((s, r) => s + estimates[r.chainId]!.receive!, 0n);

  return (
    <main className="ap">
      <section className="ap-card ap-acct">
        <div className="ap-acct-main">
          <h1>{name ?? shortAddress(address)} <CopyButton text={address} /></h1>
          <p className="ap-badges">
            {name && <span className="tag">{shortAddress(address)}</span>}
            <span className="tag">Not connected</span>
          </p>
          <p className="ap-links">
            <a href={`https://etherscan.io/address/${address}`} target="_blank" rel="noreferrer">etherscan ↗</a>
            <a href={`https://debank.com/profile/${address}`} target="_blank" rel="noreferrer">debank ↗</a>
            <a href={`https://eth.blockscout.com/address/${address}`} target="_blank" rel="noreferrer">blockscout ↗</a>
          </p>
        </div>
        <dl className="ap-kpis">
          <div><dt>Chains with gas</dt><dd>{data.state === 'ready' ? data.rows.length : '…'}</dd></div>
          <div><dt>Total value</dt><dd>{data.state === 'ready' ? formatUsd(total) || '$0.00' : '…'}</dd></div>
          <div><dt>Groups</dt><dd>{data.state === 'ready' ? groups.length : '…'}</dd></div>
        </dl>
      </section>

      <DestinationBar
        address={address} recipient={recipient} destination={destination} destName={destName} isDefault={isDefault}
        here={here} onPickChain={() => setPicking(true)}
        onRecipient={(r) => { setRecipient(r); setSelection(null); }}
      />

      <div className="ap-tabbar">
        <div className="ap-tabs" role="tablist">
          <span role="tab" aria-selected="true" className="on">Balances</span>
          <span role="tab" aria-selected="false" aria-disabled="true">Delegations</span>
        </div>
        {anyResult && !sweepingNow && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setProgress({ states: {}, bridgeOf: {} }); setRun(null); setSelection(null); setVersion((v) => v + 1); }}>Refresh balances</button>
        )}
      </div>

      {data.state === 'loading' && <div className="ap-state">Reading balances on every chain…</div>}
      {data.state === 'error' && <div className="ap-state" role="alert">{data.error}</div>}
      {data.state === 'ready' && data.rows.length === 0 && (
        <div className="ap-state">Nothing to sweep: this address holds no gas on any of the {data.chainOptions.length} chains ZeroDust covers.</div>
      )}

      {groups.map((g) => {
        const text = groupText(g.key, destName);
        const isActive = g.key === activeGroup;
        const chosen = isActive ? g.chains.filter((c) => selectedIds.has(c.chainId) && !finished.has(c.chainId)) : [];
        const subtotal = g.chains.reduce((s, c) => s + (c.usd ?? 0), 0);
        const mixedSigners = g.key !== 'metamask' && g.key !== 'key' && g.chains.some((c) => c.metamask) && g.chains.some((c) => !c.metamask);
        return (
          <section key={g.key} className={`ap-card ap-grp${isActive ? ' active' : ' dim'}`} aria-label={text.title}>
            <header className="ap-grp-h">
              <input type="checkbox" className="ap-cb" aria-label={`Select all in ${text.title}`} checked={isActive && chosen.length === g.chains.length} onChange={() => toggleGroup(g.key, g.chains)} />
              <div className="ap-grp-t">
                <h2>{text.title}{text.tag && <span className="tag ok">{text.tag}</span>}</h2>
                <p>{text.detail}</p>
              </div>
              <div className="ap-grp-sub">
                <b>{g.chains.length} {g.chains.length === 1 ? 'chain' : 'chains'}</b>
                <small>{formatUsd(subtotal)}</small>
              </div>
              {g.key === 'elsewhere' && (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPickingElsewhere(true)}>
                  {elsewhereChain === null ? 'Choose a chain' : `To ${optionOf(elsewhereChain)?.name ?? 'chain'} · change`}
                </button>
              )}
              <button
                type="button"
                className={`btn btn-sm ${isActive ? 'btn-primary' : 'btn-ghost'}`}
                disabled={sweepingNow || destination === null || (isActive && chosen.length === 0) || (g.key === 'own-chain' && !ownAddress)}
                onClick={() => startSweep(g.key, isActive ? chosen : g.chains.filter(sweepable))}
              >
                Sweep {isActive ? chosen.length : g.chains.filter(sweepable).length} {(isActive ? chosen.length : g.chains.filter(sweepable).length) === 1 ? 'chain' : 'chains'}
              </button>
            </header>
            {g.key === 'own-chain' && <OwnChainAddress value={ownAddress} onChange={setOwnAddress} />}
            <ul className="ap-rows">
              {g.chains.map((c) => (
                <ChainRow
                  key={c.chainId} row={c} group={g.key} selected={isActive && selectedIds.has(c.chainId)} keyOnly={mixedSigners && !c.metamask}
                  onToggle={() => toggle(g.key, c.chainId)} destination={destination} destName={destName}
                  destToken={destToken ?? null} estimate={estimates[c.chainId]}
                  destPrice={destToken ? data.priceOf(destToken.token) : undefined}
                  unknownRoute={data.routesOf(c.chainId).unknown === true}
                  state={progress.states[c.chainId]}
                  bridge={progress.bridgeOf[c.chainId]}
                  arrivalExplorer={progress.states[c.chainId]?.toChainId !== undefined ? optionOf(progress.states[c.chainId]!.toChainId!)?.explorerUrl : undefined}
                  running={run !== null}
                />
              ))}
            </ul>
          </section>
        );
      })}

      {active && data.rows.length > 0 && (
        <div className="ap-sticky">
          <div className="ap-sticky-in">
            <p>
              <b>{groupText(active.key, destName).title} · {selectedRows.length} {selectedRows.length === 1 ? 'chain' : 'chains'}</b>
              {gasGroup && destination !== null && quotedRows.length > 0 && destToken
                ? <span> · you receive at least {formatAmount(selectedReceive, destToken.decimals)} {destToken.token} on {destName}{quotedRows.length < selectedRows.length ? ` (${quotedRows.length} of ${selectedRows.length} quoted)` : ''}</span>
                : gasGroup && destination === null ? <span> · choose where it goes</span> : null}
              <small>One group at a time: each group has its own way of signing and its own destination</small>
            </p>
            <button
              type="button"
              className="btn btn-primary"
              disabled={sweepingNow || destination === null || selectedRows.length === 0 || (active.key === 'own-chain' && !ownAddress)}
              onClick={() => startSweep(active.key, selectedRows)}
            >
              {sweepingNow ? 'Sweeping…' : `Sweep ${selectedRows.length} ${selectedRows.length === 1 ? 'chain' : 'chains'}`}
            </button>
          </div>
        </div>
      )}

      <DestinationPicker
        open={pickingElsewhere}
        dests={data.chainOptions.filter((c) => c.chainId !== destination).map((c) => ({ ...c, reachableFrom: 0 }))}
        sourceCount={0}
        current={elsewhereChain}
        onPick={(id) => { setElsewhereChain(id); setPickingElsewhere(false); }}
        onClose={() => setPickingElsewhere(false)}
      />
      <SweepWithDialog open={pending !== null} plan={pending} address={address} onWallet={(w) => pending && begin(pending, w)} onClose={() => setPending(null)} />
      {run && <SweepSession key={run.id} wallet={run.wallet} plan={run.plan} onProgress={onProgress} onEnd={() => setRun(null)} />}

      <DestinationPicker
        open={picking}
        dests={data.chainOptions.map((c) => ({ ...c, reachableFrom: 0 }))}
        sourceCount={0}
        current={destination}
        onPick={(id) => { setChosenDest(id); setPicking(false); setSelection(null); }}
        onClose={() => setPicking(false)}
      />
    </main>
  );
}

/**
 * Where swept gas goes: the recipient (this wallet, or another address) and the chain. A default
 * chain is highlighted with why it was picked and a plain way to change it.
 */
function DestinationBar({ address, recipient, destination, destName, isDefault, here, onPickChain, onRecipient }: {
  address: Address;
  recipient: Address;
  destination: number | null;
  destName: string | null;
  isDefault: boolean;
  here: AddressRow | undefined;
  onPickChain: () => void;
  onRecipient: (recipient: Address) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toSelf = isAddressEqual(recipient, address);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await resolveName(input.trim());
    setBusy(false);
    if ('error' in res) { setError(res.error); return; }
    onRecipient(res.address);
    setEditing(false);
    setInput('');
  };
  return (
    <section className={`ap-card ap-dest${isDefault ? ' is-default' : ''}`} aria-label="Where swept gas goes">
      <div className="ap-dest-line">
        <span className="ap-dim">Everything goes to</span>
        <span className="ap-val">{shortAddress(recipient)} <small>{toSelf ? '(this wallet)' : '(another address)'}</small></span>
        <span className="ap-dim">on</span>
        {destination === null
          ? <span className="ap-val ap-dim">…</span>
          : <span className="ap-val"><ChainIcon chainId={destination} name={destName!} size={22} />{destName}</span>}
        <span className="ap-dest-btns">
          <button type="button" className="btn btn-ink btn-sm" onClick={onPickChain}>Change chain</button>
          {toSelf
            ? <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing((v) => !v)}>Send to another address</button>
            : <button type="button" className="btn btn-ghost btn-sm" onClick={() => onRecipient(address)}>Back to this wallet</button>}
        </span>
      </div>
      {isDefault && destName && (
        <p className="ap-dest-note">Picked because most of this wallet's gas is already on {destName}. Change it if you want everything somewhere else.</p>
      )}
      {here && destName && (
        <p className="ap-dest-note">Already on {destName}: {formatAmount(here.balance, here.decimals)} {here.token} {here.usd !== null ? `(${formatUsd(here.usd)}) ` : ''}stays where it is.</p>
      )}
      {editing && (
        <form className="ap-dest-edit" onSubmit={(e) => void submit(e)}>
          <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="0x… or name.eth" aria-label="Send to address" autoComplete="off" spellCheck={false} autoFocus />
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !input.trim()}>Use this address</button>
          {error && <span className="ap-dest-err" role="alert">{error}</span>}
        </form>
      )}
    </section>
  );
}

/** The address the 'Stays on its own chain' group sends to, on each of its chains */
function OwnChainAddress({ value, onChange }: { value: Address | null; onChange: (a: Address | null) => void }) {
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const res = await resolveName(input.trim());
    if ('error' in res) { setError(res.error); return; }
    setError(null);
    onChange(res.address);
  };
  if (value) {
    return (
      <p className="ap-own">Each chain's gas goes to <b>{value}</b> on that same chain. <button type="button" className="linkbtn" onClick={() => onChange(null)}>Change</button></p>
    );
  }
  return (
    <form className="ap-own" onSubmit={(e) => void submit(e)}>
      <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Address to send to on each chain (0x… or name.eth)" aria-label="Address on each chain" autoComplete="off" spellCheck={false} />
      <button type="submit" className="btn btn-ghost btn-sm" disabled={!input.trim()}>Use this address</button>
      {error && <span className="ap-dest-err" role="alert">{error}</span>}
    </form>
  );
}

const SHOWN_PHASES = new Set(['sweeping', 'done', 'failed']);

function ChainRow({ row, group, selected, keyOnly, onToggle, destination, destName, destToken, estimate, destPrice, unknownRoute, state, bridge, arrivalExplorer, running }: {
  row: AddressRow;
  group: GroupKey;
  selected: boolean;
  keyOnly: boolean;
  onToggle: () => void;
  destination: number | null;
  destName: string | null;
  destToken: { token: string; decimals: number } | null;
  estimate: Estimate | undefined;
  destPrice: number | undefined;
  unknownRoute: boolean;
  state: RowState | undefined;
  bridge: string | undefined;
  arrivalExplorer: string | undefined;
  running: boolean;
}) {
  const shown = state && (SHOWN_PHASES.has(state.phase) || (running && state.phase === 'quoting'));
  if (shown) return <ProgressRow row={row} state={state!} bridge={bridge} arrivalExplorer={arrivalExplorer} />;
  const token = tokenRouteOf(row.chainId);
  let route: { text: string; tone: 'ok' | 'warn' | 'acc' | 'plain'; title?: string };
  let receive: string = '';
  if (group === 'metamask' || group === 'key') {
    if (destination === null) route = { text: 'Choose a chain', tone: 'plain' };
    else if (unknownRoute && !estimate?.receive) route = { text: 'Bridges not answering', tone: 'warn', title: 'No bridge confirmed or refused a route just now. Try again in a few minutes.' };
    else if (estimate?.error) route = { text: /too (small|low)|minimum/i.test(estimate.error) ? 'Below the minimum' : 'No quote right now', tone: 'warn', title: estimate.error };
    else if (estimate?.route) {
      // Flag a bridge that keeps most of the value (owner, 2026-10-08)
      const arrivesUsd = estimate.receive !== undefined && destToken && destPrice ? (Number(estimate.receive) / 10 ** destToken.decimals) * destPrice : null;
      const takes = arrivesUsd !== null && row.usd ? 1 - arrivesUsd / row.usd : 0;
      route = takes > BRIDGE_TAKES_FLAG ? { text: `Bridge takes ${Math.round(takes * 100)}%`, tone: 'warn' } : { text: estimate.route, tone: 'ok' };
    }
    else route = { text: row.chainId === destination ? 'Same chain' : 'Checking…', tone: 'plain' };
    if (estimate?.receive !== undefined && destToken) receive = `${formatAmount(estimate.receive, destToken.decimals)} ${destToken.token}`;
  } else if (group === 'token' && token) {
    route = { text: `${token.symbol} on ${token.toChainName}`, tone: 'acc' };
    receive = `as ${token.symbol}`;
  } else if (group === 'elsewhere') {
    route = { text: `Not to ${destName}`, tone: 'warn' };
    receive = 'Pick another chain';
  } else {
    route = { text: 'Same chain only', tone: 'plain' };
    receive = `to an address on ${row.name}`;
  }
  return (
    <li className={`ap-row${selected ? ' sel' : ''}`}>
      <input type="checkbox" className="ap-cb" checked={selected} onChange={onToggle} aria-label={`Select ${row.name}`} />
      <span className="ap-chain">
        <ChainIcon chainId={row.chainId} name={row.name} size={28} />
        <span>{row.name}{keyOnly && <span className="tag acc">Key only</span>}</span>
      </span>
      <span className="ap-bal">{formatAmount(row.balance, row.decimals)} {row.token}<small>{formatUsd(row.usd)}</small></span>
      <span className="ap-route"><span className={`tag ${route.tone}`} title={route.title}>{route.text}</span></span>
      <span className="ap-recv">{receive}</span>
      <button type="button" className="btn btn-ghost btn-xs" disabled title="Sweeping arrives in the next step of the redesign">Sweep</button>
    </li>
  );
}

/** A chain while and after it is swept: its state, and links to what was sent and what arrived */
function ProgressRow({ row, state, bridge, arrivalExplorer }: { row: AddressRow; state: RowState; bridge: string | undefined; arrivalExplorer: string | undefined }) {
  const tone = state.phase === 'done' ? 'ok' : state.phase === 'failed' ? 'warn' : 'plain';
  const label = state.phase === 'done' ? 'Done · 0 left' : state.phase === 'failed' ? 'Failed' : state.phase === 'quoting' ? 'Checking…' : 'Sweeping…';
  const tx = (base: string, hash: string) => `${base.replace(/\/$/, '')}/tx/${hash}`;
  return (
    <li className={`ap-row ap-prog ${state.phase}`}>
      <span className="ap-cb" aria-hidden="true" />
      <span className="ap-chain"><ChainIcon chainId={row.chainId} name={row.name} size={28} /><span>{row.name}</span></span>
      <span className="ap-bal">{formatAmount(row.balance, row.decimals)} {row.token}{bridge && <small>via {bridge}</small>}</span>
      <span className="ap-route"><span className={`tag ${tone}`}>{label}</span></span>
      <span className="ap-prog-detail">{state.detail}</span>
      <span className="ap-links-tx">
        {state.txHash && row.explorerUrl && <a href={tx(row.explorerUrl, state.txHash)} target="_blank" rel="noreferrer">Sent ↗</a>}
        {state.arrivalTx && arrivalExplorer && <a href={tx(arrivalExplorer, state.arrivalTx)} target="_blank" rel="noreferrer">Arrived ↗</a>}
      </span>
    </li>
  );
}
