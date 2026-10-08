import { useEffect, useRef, useState } from 'react';
import { isAddressEqual, type Address } from 'viem';
import { KeyEntry } from '../components/KeyEntry';
import { ChainIcon } from '../components/ChainIcon';
import { TOKEN_EXITS } from '../direct/plan';
import { formatAmount, formatUsd, shortAddress, usdValue } from '../lib/format';
import { connectMetaMask, findMetaMask } from '../sweep/metamask';
import { isPaused, useServiceStatus } from '../sweep/status';
import { useSweep, type Row, type RowState, type SweepModel, type Wallet } from '../sweep/useSweep';
import { tokenRouteOf, type GroupKey } from './groups';
import type { AddressRow } from './useAddress';

// Sweeping one group from the address page (redesign phase 3): pick how to sign, then
// the proven sweep machinery (sweep/useSweep.ts) checks every chain with real quotes,
// the confirm dialog shows what happens, and the rows show progress until each chain
// reads exactly 0 and its bridge delivers.

/** Per route in the confirm dialog: rows shown before "+N more" */
const ROUTE_ROWS = 8;
/** A bridge keeping more than this share of a chain's value is called out before signing */
const BRIDGE_TAKES_FLAG = 0.5;

export interface SweepPlan {
  group: GroupKey;
  chains: AddressRow[];
  destination: number;
  recipient: Address;
  /** 'own-chain' group: where on each chain the gas goes */
  ownChainAddress?: Address;
  /** 'elsewhere' group: the chain these go to instead */
  elsewhereChain?: number;
}

function useDialog(open: boolean) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return ref;
}

/** "Sweep with": MetaMask (the chains it covers, no key) or the key (every chain) */
export function SweepWithDialog({ open, plan, address, onWallet, onClose }: {
  open: boolean;
  plan: SweepPlan | null;
  address: Address;
  onWallet: (wallet: Wallet) => void;
  onClose: () => void;
}) {
  const ref = useDialog(open);
  const [mode, setMode] = useState<'choose' | 'key'>('choose');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const status = useServiceStatus();
  const paused = isPaused(status);
  const chains = plan?.chains ?? [];
  const covered = chains.filter((c) => c.metamask && !c.direct);
  const left = chains.filter((c) => !c.metamask || c.direct);
  const n = chains.length;

  const close = () => { setMode('choose'); setError(null); onClose(); };
  const connectWithMetaMask = async () => {
    setBusy(true);
    setError(null);
    try {
      const provider = await findMetaMask();
      if (!provider) throw new Error('MetaMask was not found in this browser. Use the key, or open this page where MetaMask is installed.');
      const session = await connectMetaMask(provider);
      if (!isAddressEqual(session.address, address)) throw new Error(`MetaMask is on ${shortAddress(session.address)}. Switch MetaMask to ${shortAddress(address)}, the address on this page, and try again.`);
      setMode('choose');
      onWallet({ kind: 'metamask', session });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'MetaMask did not connect.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog ref={ref} className="modal zd-with" onClose={close} aria-labelledby="with-title">
      <div className="modal-head">
        <h3 id="with-title">Sweep {n} {n === 1 ? 'chain' : 'chains'} with</h3>
        <button type="button" className="iconbtn" onClick={close} aria-label="Close">✕</button>
      </div>
      {paused && <p className="status-notice" role="status">{status?.message ?? 'ZeroDust is paused right now. Sweeps resume automatically; please come back shortly.'}</p>}
      {mode === 'choose' ? (
        <>
          <p className="lead">Pick how to sign. Nothing is sent until you confirm the next step.</p>
          <div className="zd-opts">
            {covered.length > 0 && (
              <button type="button" className="zd-opt" onClick={() => void connectWithMetaMask()} disabled={busy || paused}>
                <span className="zd-opt-ic" aria-hidden="true">🦊</span>
                <span className="zd-opt-t"><b>MetaMask</b><span>Covers {covered.length === n ? (n === 1 ? 'it' : `all ${n}`) : `${covered.length} of ${n}`} · the key never leaves MetaMask</span></span>
                <span className="tag ok">{busy ? 'Connecting…' : 'Recommended'}</span>
              </button>
            )}
            <button type="button" className="zd-opt" onClick={() => setMode('key')} disabled={paused}>
              <span className="zd-opt-ic" aria-hidden="true">🔑</span>
              <span className="zd-opt-t"><b>Private key</b><span>Covers {n === 1 ? 'it' : `all ${n}`} · stays in this page, never sent</span></span>
            </button>
          </div>
          {covered.length > 0 && left.length > 0 && (
            <p className="zd-note">With MetaMask, {left.map((c) => c.name).join(', ')} {left.length === 1 ? 'is' : 'are'} left for later: {left.length === 1 ? 'it needs' : 'they need'} the key. You can sweep {left.length === 1 ? 'it' : 'them'} afterwards, or use the offline page.</p>
          )}
          {error && <p className="field-error" role="alert">{error}</p>}
        </>
      ) : (
        <>
          <KeyEntry
            keyOnly
            title="Use the private key"
            help={`Type or paste the private key of ${shortAddress(address)}, the address on this page.`}
            onAccount={(account) => {
              if (!isAddressEqual(account.address, address)) {
                setError(`That key belongs to ${shortAddress(account.address)}, not ${shortAddress(address)}. Nothing was loaded.`);
                return;
              }
              setMode('choose');
              setError(null);
              onWallet({ kind: 'key', account });
            }}
          />
          {error && <p className="field-error" role="alert">{error}</p>}
          <button type="button" className="linkbtn zd-back" onClick={() => { setMode('choose'); setError(null); }}>Back</button>
        </>
      )}
    </dialog>
  );
}

/**
 * Runs one group's sweep with the chosen wallet: applies the page's destination, recipient and
 * the group's way out, checks every chain, asks for confirmation, sweeps, and reports each
 * chain's state back to the page as it goes.
 */
export function SweepSession({ wallet, plan, onProgress, onEnd }: {
  wallet: Wallet;
  plan: SweepPlan;
  onProgress: (states: Record<number, RowState>, bridgeOf: Record<number, string>) => void;
  onEnd: () => void;
}) {
  const model = useSweep(wallet);
  const [step, setStep] = useState<'route' | 'choices' | 'check' | 'checking' | 'confirm' | 'sweeping' | 'done'>('route');
  const ids = plan.chains.map((c) => c.chainId);
  const loaded = model.stage !== 'loading';

  // 1. Where everything goes (a new destination resets the hook's routes, so choices come after)
  useEffect(() => {
    if (!loaded || step !== 'route') return;
    model.setDestination(plan.destination);
    model.setRecipient(plan.recipient);
    // A step per render: each step needs the state the previous one committed (useSweep's own setters)
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStep('choices');
  }, [loaded, step, model, plan]);

  // 2. The group's way out, then exactly its chains
  useEffect(() => {
    if (step !== 'choices') return;
    for (const c of plan.chains) {
      if (plan.group === 'token') {
        if (c.direct && TOKEN_EXITS[c.chainId]) model.setChoice(c.chainId, 'exit-donate');
        else model.setChoice(c.chainId, 'elsewhere', tokenRouteOf(c.chainId)?.toChainId);
      } else if (plan.group === 'elsewhere' && plan.elsewhereChain !== undefined) {
        model.setChoice(c.chainId, 'elsewhere', plan.elsewhereChain);
      } else if (plan.group === 'own-chain' && plan.ownChainAddress) {
        model.setChoice(c.chainId, 'address', undefined, plan.ownChainAddress);
      }
    }
    model.select(new Set(ids));
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStep('check');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // 3. Real quotes and plans for every chain (nothing signed)
  useEffect(() => {
    if (step !== 'check') return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStep('checking');
    void model.check().then(() => setStep('confirm'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  useEffect(() => { onProgress(model.states, model.bridgeOf); }, [model.states, model.bridgeOf, onProgress]);

  const confirm = async () => {
    setStep('sweeping');
    await model.sweep();
    setStep('done');
  };

  return (
    <ConfirmSweep
      open={step === 'confirm'}
      model={model}
      plan={plan}
      onCancel={onEnd}
      onConfirm={() => void confirm()}
    />
  );
}

/** Before anything is signed: every chain that will move, by route, with what arrives where */
function ConfirmSweep({ open, model: m, plan, onCancel, onConfirm }: {
  open: boolean;
  model: SweepModel;
  plan: SweepPlan;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const ref = useDialog(open);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Closing the dialog fires its close event: after a confirm that is not a cancel (cancelling
  // there unmounted the running sweep and froze its rows)
  const confirmed = useRef(false);
  const ready = m.readyRows;
  const notReady = plan.chains.filter((c) => !ready.some((r) => r.chainId === c.chainId));
  const n = ready.length;
  const st = (r: Row) => m.states[r.chainId];

  // Group by route (the bridge, or same chain / an address on the chain)
  const routeOf = (r: Row) => {
    const choice = m.choices[r.chainId];
    if (choice === 'address') return 'To an address on the same chain';
    if (r.chainId === plan.destination) return 'Same chain';
    return m.bridgeOf[r.chainId] ?? 'Bridge';
  };
  const routes = new Map<string, Row[]>();
  for (const r of ready) routes.set(routeOf(r), [...(routes.get(routeOf(r)) ?? []), r]);

  const amountOut = (r: Row) => {
    const s = st(r);
    if (s?.receive === undefined) return '';
    const to = s.toChainId !== undefined ? m.destOf(s.toChainId) : null;
    const symbol = s.token?.symbol ?? to?.token ?? '';
    return `${formatAmount(s.receive, s.token?.decimals ?? to?.decimals ?? 18)} ${symbol}`;
  };
  const takes = (r: Row) => {
    const s = st(r);
    if (s?.receive === undefined || s.token || s.toChainId === undefined) return 0;
    const to = m.destOf(s.toChainId);
    const inUsd = usdValue(r.balance, r.decimals, m.prices[r.token]);
    const outUsd = to ? usdValue(s.receive, to.decimals, m.prices[to.token]) : null;
    return inUsd && outUsd !== null ? 1 - outUsd / inUsd : 0;
  };
  const eaten = ready.filter((r) => takes(r) > BRIDGE_TAKES_FLAG);
  const destName = m.destOf(plan.destination)?.name ?? 'the destination';
  const totals = m.readyTotals;
  const totalText = totals.map((t) => `${formatAmount(t.amount, t.decimals)} ${t.symbol}${t.dest.chainId !== plan.destination ? ` on ${t.dest.name}` : ''}`).join(' + ');
  const totalUsd = totals.reduce((s, t) => s + (usdValue(t.amount, t.decimals, m.prices[t.isToken ? t.symbol : t.dest.token]) ?? 0), 0);
  const title = plan.group === 'own-chain' ? `Sweep ${n} ${n === 1 ? 'chain' : 'chains'} to an address on ${n === 1 ? 'its' : 'each'} chain?`
    : plan.group === 'token' ? `Sweep ${n} ${n === 1 ? 'chain' : 'chains'} as tokens?`
    : `Sweep ${n} ${n === 1 ? 'chain' : 'chains'} to ${plan.group === 'elsewhere' ? m.destOf(plan.elsewhereChain!)?.name ?? 'another chain' : destName}?`;

  return (
    <dialog ref={ref} className="modal zd-confirm" onClose={() => { if (!confirmed.current) onCancel(); }} aria-labelledby="zd-confirm-title">
      <div className="zd-confirm-top">
        <h3 id="zd-confirm-title">{n === 0 ? 'Nothing can be swept right now' : title}</h3>
        <p className="lead">Every balance below leaves your wallet and each chain ends at exactly 0. This cannot be undone.</p>
      </div>
      <div className="zd-confirm-list">
        {[...routes.entries()].map(([route, rows]) => {
          const open = expanded.has(route) || rows.length <= ROUTE_ROWS + 1;
          const shown = open ? rows : rows.slice(0, ROUTE_ROWS);
          return (
            <div key={route} className="zd-route">
              <p className="zd-route-h"><span>{route} · {rows.length}</span></p>
              {shown.map((r) => (
                <p key={r.chainId} className="zd-cl">
                  <ChainIcon chainId={r.chainId} name={r.name} size={22} />
                  <span className="zd-cl-name">{r.name}
                    <small>{formatAmount(r.balance, r.decimals)} {r.token}{st(r)?.token ? ` · arrives as ${st(r)!.token!.symbol} on ${m.destOf(st(r)!.toChainId!)?.name ?? ''}` : ''}{m.choices[r.chainId] === 'address' ? ` · to ${shortAddress(m.addressOf[r.chainId]!)}` : ''}</small>
                  </span>
                  <span>{amountOut(r)}</span>
                </p>
              ))}
              {!open && <button type="button" className="linkbtn zd-more" onClick={() => setExpanded((p) => new Set(p).add(route))}>+{rows.length - ROUTE_ROWS} more on {route} · Show</button>}
            </div>
          );
        })}
        {notReady.length > 0 && (
          <div className="zd-route">
            <p className="zd-route-h"><span>Not included · {notReady.length}</span></p>
            {notReady.map((c) => (
              <p key={c.chainId} className="zd-cl zd-cl-out">
                <ChainIcon chainId={c.chainId} name={c.name} size={22} />
                <span className="zd-cl-name">{c.name}<small>{m.states[c.chainId]?.detail ?? (c.metamask ? 'Not ready' : 'Needs the key')}</small></span>
              </p>
            ))}
          </div>
        )}
      </div>
      <div className="zd-confirm-bottom">
        {eaten.length > 0 && (
          <p className="zd-note">{eaten.length === 1 ? '1 chain loses' : `${eaten.length} chains lose`} most of its value to the bridge: {eaten.map((r) => `${r.name} (${Math.round(takes(r) * 100)}%)`).join(', ')}. Untick {eaten.length === 1 ? 'it' : 'them'} on the page to keep {eaten.length === 1 ? 'it' : 'them'}.</p>
        )}
        {n > 0 && totals.length > 0 && (
          <p className="zd-total"><span>You receive at least, at {m.toSelf ? 'your wallet' : shortAddress(m.recipient)}{plan.group !== 'token' ? ` on ${plan.group === 'elsewhere' ? m.destOf(plan.elsewhereChain!)?.name : destName}` : ''}</span><b>{totalText}{totalUsd > 0 ? ` (${formatUsd(totalUsd)})` : ''}</b></p>
        )}
        <div className="btns">
          <button type="button" className="btn btn-ghost" onClick={onCancel}>{n === 0 ? 'Close' : 'Back'}</button>
          {n > 0 && <button type="button" className="btn btn-primary" onClick={() => { confirmed.current = true; onConfirm(); }}>Sweep {n} {n === 1 ? 'chain' : 'chains'}</button>}
        </div>
      </div>
    </dialog>
  );
}
