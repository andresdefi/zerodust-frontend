import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { IDLE_FLAG } from '../components/KeyEntry';
import { isAddressEqual, type Address } from 'viem';
import { deliversOnlyToSender } from '@zerodust/sdk';
import { ChainIcon } from '../components/ChainIcon';
import { DestinationPicker } from '../components/DestinationPicker';
import { formatAmount, formatUsd, shortAddress } from '../lib/format';
import { groupChains, groupOf, groupText, tokenRouteOf, type GroupKey } from './groups';
import { closesLong, closesShort, cutoffLong, stillSwept } from './closing';
import { isListedScam, resolveName, useAddressData, useEstimates, useResolved, type AddressRow, type ChainOption, type Estimate } from './useAddress';
import { SweepSession, SweepWithDialog, type SweepPlan } from './SweepSession';
import { FAILURE_LABEL, failureKind, minimumOf, tooSmallText, type RowState, type Wallet } from '../sweep/useSweep';
import { reportText } from '../sweep/report';
import { durationText, expectedTime, fetchTimings, NO_TIMINGS, type BridgeTimings, type ExpectedTime } from '../sweep/timing';
import type { MetaMaskSession } from '../sweep/metamask';
import { OFFLINE } from '../lib/env';

// One address: every chain holding gas, in groups by how it is swept and what arrives.
// Reading needs nothing; sweeping a group asks how to sign (MetaMask or the key of this
// address), checks every chain, confirms, and shows each chain's progress in its row.

/** A loaded key left alone this long is forgotten (never during a sweep) */
const IDLE_FORGET_MS = 15 * 60 * 1000;

/** Forgetting the key: a reload clears this tab's memory (the account object lives nowhere else) */
function forgetKey(idle: boolean) {
  if (idle) {
    try { sessionStorage.setItem(IDLE_FLAG, '1'); } catch { /* the reload still forgets the key */ }
  }
  window.location.reload();
}

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

export function AddressPage({ query, session, onSession }: { query: string; session: MetaMaskSession | null; onSession: (s: MetaMaskSession) => void }) {
  const resolved = useResolved(query);
  if (resolved.state === 'loading') return <main className="ap"><div className="ap-state">Looking up {query}…</div></main>;
  if (resolved.state === 'error') return <main className="ap"><div className="ap-state" role="alert">{resolved.message}</div></main>;
  return <Loaded address={resolved.address} name={resolved.name} session={session} onSession={onSession} />;
}

function Loaded({ address, name, session, onSession }: { address: Address; name: string | null; session: MetaMaskSession | null; onSession: (s: MetaMaskSession) => void }) {
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
    // Never a chain that announced its shutdown
    const top = data.rows.filter((r) => !r.direct && !r.closing && data.routesOf(r.chainId).gas === true).sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0))[0];
    setDefaultDest(top?.chainId ?? 8453);
  }
  const toSelf = isAddressEqual(recipient, address);
  // To this same wallet, the destination chain's own balance is already where everything goes
  const here = toSelf && destination !== null ? data.rows.find((r) => r.chainId === destination) : undefined;
  const movable = useMemo(() => (here ? data.rows.filter((r) => r !== here) : data.rows), [data.rows, here]);
  // A closing chain ZeroDust can no longer take out (past a sponsored chain's cut-off, or no bridge
  // left: keeping it on its own chain is refused) leaves the groups for the closing notice
  const routesOf = data.routesOf;
  const stopped = useMemo(() => movable.filter((r) => r.closing && (!stillSwept(r) || groupOf(r, routesOf(r.chainId), destination) === 'own-chain')), [movable, routesOf, destination]);
  const leaving = useMemo(() => movable.filter((r) => !stopped.includes(r)), [movable, stopped]);
  const groups = useMemo(() => groupChains(leaving, routesOf, destination), [leaving, routesOf, destination]);
  const closingRows = data.rows.filter((r) => r.closing);
  const destName = destination === null ? null : data.chainOptions.find((c) => c.chainId === destination)?.name ?? `Chain ${destination}`;
  const destToken = destination === null ? null : data.chainOptions.find((c) => c.chainId === destination);

  // One group at a time: picking a chain in another group starts a new selection there
  const [selection, setSelection] = useState<{ group: GroupKey; ids: Set<number> } | null>(null);
  const activeGroup = selection?.group ?? groups.find((g) => g.key === 'gas')?.key ?? null;
  const active = groups.find((g) => g.key === activeGroup);
  const gasGroup = activeGroup === 'gas';
  // Both gas groups share the destination: quote them together
  const gasChains = groups.filter((g) => g.key === 'gas').flatMap((g) => g.chains);
  const estimates = useEstimates(address, gasChains, destination, recipient);
  // How long each bridge usually takes (GET /bridges/timing), to set expectations on each row
  const [timings, setTimings] = useState<BridgeTimings>(NO_TIMINGS);
  useEffect(() => { void fetchTimings().then(setTimings, () => undefined); }, []);
  // By default a group's chains are all selected, except those no bridge answered for or that failed to quote
  const [progress, setProgress] = useState<{ states: Record<number, RowState>; bridgeOf: Record<number, string> }>({ states: {}, bridgeOf: {} });
  // A chain swept to 0 is not offered again until the balances are read again
  const finished = useMemo(() => new Set(Object.entries(progress.states).filter(([, st]) => st.phase === 'done').map(([id]) => Number(id))), [progress.states]);
  // A token route whose bridge pays only the sending wallet (Endurance) cannot reach another recipient
  const senderOnly = (c: AddressRow) => { const t = tokenRouteOf(c.chainId); return !toSelf && t !== null && deliversOnlyToSender(c.chainId, t.toChainId); };
  const sweepable = (c: AddressRow) => { const r = data.routesOf(c.chainId); return !r.unknown && r.minimum === undefined && !senderOnly(c) && !estimates[c.chainId]?.error && !finished.has(c.chainId); };
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
  // The key stays only while it is used: 15 minutes without activity forgets it (never mid-sweep),
  // as on the old page; between groups too, not only while a sweep session is open
  const keyLoaded = wallet?.kind === 'key';
  // MetaMask connected (here or from the header) on this page's address
  const mmHere = session !== null && isAddressEqual(session.address, address) ? session : null;
  useEffect(() => {
    if (!keyLoaded || sweepingNow) return;
    let timer = setTimeout(() => forgetKey(true), IDLE_FORGET_MS);
    const reset = () => { clearTimeout(timer); timer = setTimeout(() => forgetKey(true), IDLE_FORGET_MS); };
    const events = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
    for (const e of events) window.addEventListener(e, reset, { passive: true });
    return () => { clearTimeout(timer); for (const e of events) window.removeEventListener(e, reset); };
  }, [keyLoaded, sweepingNow]);
  const anyResult = Object.values(progress.states).some((st) => st.phase === 'done' || st.phase === 'failed');
  const refresh = () => { setProgress({ states: {}, bridgeOf: {} }); setRun(null); setSelection(null); setVersion((v) => v + 1); };
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

  // What a sweep moves: the destination chain's own balance (to this same wallet) is already there
  const toSweepUsd = leaving.reduce((s, r) => s + (r.usd ?? 0), 0);
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
            {keyLoaded
              ? <span className="tag acc">Key loaded · <button type="button" className="linkbtn" onClick={() => forgetKey(false)} disabled={sweepingNow}>Forget it</button></span>
              : OFFLINE ? <span className="tag">Offline page</span> : mmHere ? <span className="tag ok">MetaMask connected</span> : <span className="tag">Not connected</span>}
          </p>
          <p className="ap-links">
            <a href={`https://etherscan.io/address/${address}`} target="_blank" rel="noreferrer">etherscan ↗</a>
            <a href={`https://debank.com/profile/${address}`} target="_blank" rel="noreferrer">debank ↗</a>
            <a href={`https://eth.blockscout.com/address/${address}`} target="_blank" rel="noreferrer">blockscout ↗</a>
          </p>
        </div>
        <dl className="ap-kpis">
          <div><dt>Chains to sweep</dt><dd>{data.state === 'ready' ? leaving.length : '…'}</dd></div>
          <div><dt>To sweep</dt><dd>{data.state === 'ready' ? formatUsd(toSweepUsd) || '$0.00' : '…'}</dd></div>
          <div><dt>Groups</dt><dd>{data.state === 'ready' ? groups.length : '…'}</dd></div>
        </dl>
      </section>

      <DestinationBar
        address={address} recipient={recipient} destination={destination} destName={destName} isDefault={isDefault}
        here={here} onPickChain={() => setPicking(true)}
        onRecipient={(r) => { setRecipient(r); setSelection(null); }}
      />

      <div className="ap-tabbar">
        <h2 className="ap-section-title">Balances</h2>
        {anyResult && !sweepingNow && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={refresh}>Refresh balances</button>
        )}
      </div>

      {data.state === 'loading' && <div className="ap-state">Reading balances on every chain…</div>}
      {data.state === 'error' && <div className="ap-state" role="alert">{data.error}</div>}
      {data.state === 'ready' && data.unchecked.length > 0 && (
        <div className="ap-unchecked" role="status">
          <p>Couldn't read {listNames(data.unchecked)} just now, so {data.unchecked.length === 1 ? 'it' : 'they'} may hold gas that isn't shown here.</p>
          {!sweepingNow && <button type="button" className="btn btn-ghost btn-sm" onClick={refresh}>Check again</button>}
        </div>
      )}
      {data.state === 'ready' && closingRows.length > 0 && <ClosingNotice rows={closingRows} stopped={stopped} />}
      {data.state === 'ready' && data.rows.length === 0 && (
        <div className="ap-state">{data.unchecked.length === 0
          ? `Nothing to sweep: this address holds no gas on any of the ${data.chainOptions.length} chains ZeroDust covers.`
          : 'Nothing to sweep on the chains that answered.'}</div>
      )}

      {groups.map((g) => {
        const text = groupText(g.key, destName, { keyOnly: g.chains.filter((c) => !OFFLINE && (!c.metamask || c.direct)).length });
        const isActive = g.key === activeGroup;
        const chosen = isActive ? g.chains.filter((c) => selectedIds.has(c.chainId) && !finished.has(c.chainId)) : [];
        const subtotal = g.chains.reduce((s, c) => s + (c.usd ?? 0), 0);
        // Rows MetaMask cannot sweep say so where both kinds share a group (never offline: all key there)
        const keyOnlyRow = (c: AddressRow) => !OFFLINE && (!c.metamask || c.direct) && g.chains.some((o) => o.metamask && !o.direct);
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
                  key={c.chainId} row={c} group={g.key} selected={isActive && selectedIds.has(c.chainId)} keyOnly={keyOnlyRow(c)}
                  onToggle={() => toggle(g.key, c.chainId)} destination={destination} destName={destName}
                  onSweep={sweepable(c) && !sweepingNow && destination !== null && !(g.key === 'own-chain' && !ownAddress) ? () => startSweep(g.key, [c]) : undefined}
                  destToken={destToken ?? null} estimate={estimates[c.chainId]}
                  destPrice={destToken ? data.priceOf(destToken.token) : undefined}
                  unknownRoute={data.routesOf(c.chainId).unknown === true}
                  minimum={data.routesOf(c.chainId).minimum}
                  usual={estimates[c.chainId]?.route ? expectedTime(timings, estimates[c.chainId]!.route, c.chainId) : null}
                  senderOnly={senderOnly(c)}
                  state={progress.states[c.chainId]}
                  bridge={progress.bridgeOf[c.chainId]}
                  arrivalExplorer={progress.states[c.chainId]?.toChainId !== undefined ? optionOf(progress.states[c.chainId]!.toChainId!)?.explorerUrl : undefined}
                  arrivalName={progress.states[c.chainId]?.toChainId !== undefined ? optionOf(progress.states[c.chainId]!.toChainId!)?.name : undefined}
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
              <small>Groups are swept one at a time.</small>
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
      <SweepWithDialog
        open={pending !== null}
        plan={pending}
        address={address}
        session={mmHere}
        onWallet={(w) => {
          if (w.kind === 'metamask') onSession(w.session);
          if (pending) begin(pending, w);
        }}
        onClose={() => setPending(null)}
      />
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
  const [flagged, setFlagged] = useState<Address | null>(null);
  const applyRecipient = (a: Address) => {
    onRecipient(a);
    setFlagged(null);
    setEditing(false);
    setInput('');
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await resolveName(input.trim());
    if ('error' in res) { setBusy(false); setError(res.error); return; }
    const listed = await isListedScam(res.address);
    setBusy(false);
    // A known scam address takes an explicit second step
    if (listed) { setFlagged(res.address); return; }
    applyRecipient(res.address);
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
          <input value={input} onChange={(e) => { setInput(e.target.value); setFlagged(null); }} placeholder="0x… or name.eth" aria-label="Send to address" autoComplete="off" spellCheck={false} autoFocus />
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !input.trim()}>Use this address</button>
          {error && <span className="ap-dest-err" role="alert">{error}</span>}
        </form>
      )}
      {flagged && <ScamWarning address={flagged} onUse={() => applyRecipient(flagged)} onCancel={() => setFlagged(null)} />}
    </section>
  );
}

/** A typed address that ScamSniffer lists: said plainly, used only after a second, explicit step */
function ScamWarning({ address, onUse, onCancel }: { address: Address; onUse: () => void; onCancel: () => void }) {
  return (
    <div className="ap-scam" role="alert">
      <p><b>{shortAddress(address)} is on ScamSniffer's list of scam addresses.</b> Anything sent there is gone for good. If someone asked you to send your gas to this address, it is most likely a scam.</p>
      <p className="ap-scam-btns">
        <button type="button" className="btn btn-primary btn-sm" onClick={onCancel}>Don't use it</button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onUse}>Use it anyway</button>
      </p>
    </div>
  );
}

/** Chains in the wallet that announced their shutdown: sweep them before the date, or use their own bridge */
function ClosingNotice({ rows, stopped }: { rows: AddressRow[]; stopped: AddressRow[] }) {
  return (
    <div className="ap-closing" role="status">
      {rows.map((r) => {
        const c = r.closing!;
        const amount = `${formatAmount(r.balance, r.decimals)} ${r.token}`;
        if (stopped.includes(r)) {
          const why = stillSwept(r) ? 'nothing bridges it out right now' : `ZeroDust stopped sweeping it on ${cutoffLong(c)}`;
          return (
            <p key={r.chainId}>
              <b>{r.name} closes on {closesLong(c)}</b> and {why}. Move the {amount} with {r.name}'s own bridge before then: <a href={c.source} target="_blank" rel="noreferrer">{r.name}'s announcement</a>.
            </p>
          );
        }
        const lastDays = r.direct && c.stage === 'cutoff' ? ' No ZeroDust fee in its last days.' : '';
        return (
          <p key={r.chainId}>
            <b>{r.name} closes on {closesLong(c)}.</b> Sweep the {amount} before then; ZeroDust won't send anything there.{lastDays}
          </p>
        );
      })}
    </div>
  );
}

/** "A", "A and B", "A, B and C" */
function listNames(names: string[]): string {
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** The address the 'Stays on its own chain' group sends to, on each of its chains */
function OwnChainAddress({ value, onChange }: { value: Address | null; onChange: (a: Address | null) => void }) {
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [flagged, setFlagged] = useState<Address | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const res = await resolveName(input.trim());
    if ('error' in res) { setError(res.error); return; }
    setError(null);
    // A known scam address takes an explicit second step
    if (await isListedScam(res.address)) { setFlagged(res.address); return; }
    onChange(res.address);
  };
  if (flagged) {
    return <ScamWarning address={flagged} onUse={() => { onChange(flagged); setFlagged(null); }} onCancel={() => setFlagged(null)} />;
  }
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

function ChainRow({ row, group, selected, keyOnly, onToggle, onSweep, destination, destName, destToken, estimate, destPrice, unknownRoute, minimum, usual, senderOnly, state, bridge, arrivalExplorer, arrivalName, running }: {
  row: AddressRow;
  group: GroupKey;
  selected: boolean;
  keyOnly: boolean;
  onToggle: () => void;
  /** Sweep just this chain; absent while it cannot be swept */
  onSweep: (() => void) | undefined;
  destination: number | null;
  destName: string | null;
  destToken: { token: string; decimals: number } | null;
  estimate: Estimate | undefined;
  destPrice: number | undefined;
  unknownRoute: boolean;
  /** Below every bridge's minimum (direct chains: known before any quote) */
  minimum: bigint | undefined;
  /** How long its bridge usually takes from this chain, when measured */
  usual: ExpectedTime | null;
  /** Its bridge pays only the sending wallet, and the gas is set to go elsewhere */
  senderOnly: boolean;
  state: RowState | undefined;
  bridge: string | undefined;
  arrivalExplorer: string | undefined;
  arrivalName: string | undefined;
  running: boolean;
}) {
  const shown = state && (SHOWN_PHASES.has(state.phase) || (running && state.phase === 'quoting'));
  if (shown) return <ProgressRow row={row} state={state!} bridge={bridge} arrivalExplorer={arrivalExplorer} arrivalName={arrivalName} />;
  const token = tokenRouteOf(row.chainId);
  let route: { text: string; tone: 'ok' | 'warn' | 'acc' | 'plain'; title?: string };
  let receive: string = '';
  if (group === 'gas') {
    if (destination === null) route = { text: 'Choose a chain', tone: 'plain' };
    else if (minimum !== undefined) route = { text: 'Below the minimum', tone: 'warn', title: tooSmallText(minimum, row) };
    else if (unknownRoute && !estimate?.receive) route = { text: 'Bridges not answering', tone: 'warn', title: 'No bridge confirmed or refused a route just now. Try again in a few minutes.' };
    else if (estimate?.error) {
      const least = minimumOf(estimate.error, row.decimals);
      route = least !== null || /too (small|low)|minimum/i.test(estimate.error)
        ? { text: 'Below the minimum', tone: 'warn', title: least !== null ? tooSmallText(least, row) : estimate.error }
        : { text: 'No quote right now', tone: 'warn', title: estimate.error };
    }
    else if (estimate?.route) {
      // Flag a bridge that keeps most of the value (owner, 2026-10-08)
      const arrivesUsd = estimate.receive !== undefined && destToken && destPrice ? (Number(estimate.receive) / 10 ** destToken.decimals) * destPrice : null;
      const takes = arrivesUsd !== null && row.usd ? 1 - arrivesUsd / row.usd : 0;
      route = takes > BRIDGE_TAKES_FLAG ? { text: `Bridge takes ${Math.round(takes * 100)}%`, tone: 'warn' }
        : usual?.slowLately ? { text: `${estimate.route} · slower lately`, tone: 'warn', title: `Usually ${durationText(usual.seconds)}, but slower than usual lately` }
        : usual ? { text: `${estimate.route} · usually ${durationText(usual.seconds)}`, tone: 'ok' }
        : { text: estimate.route, tone: 'ok' };
    }
    else route = { text: row.chainId === destination ? 'Same chain' : 'Checking…', tone: 'plain' };
    if (estimate?.receive !== undefined && destToken && minimum === undefined) receive = `${formatAmount(estimate.receive, destToken.decimals)} ${destToken.token}`;
  } else if (group === 'token' && token) {
    route = senderOnly
      ? { text: 'Your wallet only', tone: 'warn', title: `${row.name} can only be swept to your own wallet: its bridge pays only the wallet that sends` }
      : { text: `${token.symbol} on ${token.toChainName}`, tone: 'acc' };
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
        <span>{row.name}{keyOnly && <span className="tag acc">Key only</span>}{row.closing && <span className="tag warn" title={row.closing.note}>Closes {closesShort(row.closing)}</span>}</span>
      </span>
      <span className="ap-bal">{formatAmount(row.balance, row.decimals)} {row.token}<small>{formatUsd(row.usd)}</small></span>
      <span className="ap-route"><span className={`tag ${route.tone}`} title={route.title}>{route.text}</span></span>
      <span className="ap-recv">{receive}</span>
      <button type="button" className="btn btn-ghost btn-xs" disabled={!onSweep} onClick={onSweep} aria-label={`Sweep ${row.name}`}>Sweep</button>
    </li>
  );
}

/**
 * A chain while and after it is swept: its state, and links to what was sent and what arrived.
 * A failure says what kind it is in plain words; one that was reported carries its reference
 * and the details to copy (they hold no key).
 */
function ProgressRow({ row, state, bridge, arrivalExplorer, arrivalName }: { row: AddressRow; state: RowState; bridge: string | undefined; arrivalExplorer: string | undefined; arrivalName: string | undefined }) {
  const [copied, setCopied] = useState(false);
  const kind = state.phase === 'failed' ? failureKind(state, row.decimals) : null;
  const tone = state.phase === 'done' ? 'ok' : kind === 'check' ? 'danger' : kind ? 'warn' : 'plain';
  const label = state.phase === 'done' ? 'Done · 0 left' : kind ? FAILURE_LABEL[kind] : state.phase === 'quoting' ? 'Checking…' : 'Sweeping…';
  // Only a failure after something was sent needs checking; otherwise say what to do
  const least = kind === 'too-small' ? minimumOf(state.detail, row.decimals) : null;
  const detail = least !== null ? tooSmallText(least, row) : kind && kind !== 'check' ? `${state.detail} Nothing was sent.` : state.detail;
  const copy = async () => {
    if (!kind || !state.report) return;
    try {
      await navigator.clipboard.writeText(reportText({
        ...state.report, chainName: row.name, toChainName: arrivalName, label: FAILURE_LABEL[kind], reference: state.reference,
        explorerUrl: row.explorerUrl, at: new Date(),
      }));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard refused (permissions): the reference is still on screen
    }
  };
  const tx = (base: string, hash: string) => `${base.replace(/\/$/, '')}/tx/${hash}`;
  return (
    <li className={`ap-row ap-prog ${state.phase}`}>
      <span className="ap-cb" aria-hidden="true" />
      <span className="ap-chain"><ChainIcon chainId={row.chainId} name={row.name} size={28} /><span>{row.name}</span></span>
      <span className="ap-bal">{formatAmount(row.balance, row.decimals)} {row.token}{bridge && <small>via {bridge}</small>}</span>
      <span className="ap-route"><span className={`tag ${tone}`}>{label}</span></span>
      <span className="ap-prog-detail">
        {detail}
        {kind && state.report && (
          <span className="ap-report">
            {state.reference && <span>Ref {state.reference}</span>}
            <button type="button" className="linkbtn" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy details'}</button>
            <span>Send them to <a href="https://x.com/andresdefi" target="_blank" rel="noreferrer noopener">@andresdefi on X</a>. They hold no key.</span>
          </span>
        )}
      </span>
      <span className="ap-links-tx">
        {state.txHash && row.explorerUrl && <a href={tx(row.explorerUrl, state.txHash)} target="_blank" rel="noreferrer">Sent ↗</a>}
        {state.arrivalTx && arrivalExplorer && <a href={tx(arrivalExplorer, state.arrivalTx)} target="_blank" rel="noreferrer">Arrived ↗</a>}
      </span>
    </li>
  );
}
