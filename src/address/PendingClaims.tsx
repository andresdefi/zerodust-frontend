import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { Address, Hex } from 'viem';
import { ChainIcon } from '../components/ChainIcon';
import { formatAmount, shortAddress } from '../lib/format';
import { claimState, findWithdrawal, readWithdrawal, type ClaimState, type Withdrawal } from '../sweep/claims';
import { addPendingClaim, claimableFrom, DONE_KEEP_MS, markClaimDone, nativeExitOf, parentOf, pendingClaimsOf, removePendingClaim, type PendingClaim } from '../sweep/native';
import { ClaimDialog, type ClaimStep } from './ClaimDialog';

interface Live {
  /** null: the transaction holds no withdrawal */
  withdrawal?: Withdrawal | null;
  state?: ClaimState;
  error?: boolean;
}

const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/**
 * Withdrawals sent into a chain's own bridge from this browser, still to be claimed on its parent
 * chain (sweep/native.ts). Each one's stage is read from the chain and the parent (sweep/claims.ts), and
 * the prove and claim are sent from here; the chain's bridge site, where it has one, stays linked as the fallback.
 */
export function PendingClaims({ address, version, onSummary }: {
  address: Address;
  version: number;
  /** How many there are, and how many can be proved or claimed now (the tab's count) */
  onSummary?: (summary: { total: number; ready: number }) => void;
}) {
  const [list, setList] = useState<PendingClaim[]>([]);
  const [live, setLive] = useState<Record<string, Live>>({});
  const [acting, setActing] = useState<{ claim: PendingClaim; step: ClaimStep } | null>(null);

  const read = useCallback(async (c: PendingClaim) => {
    try {
      const withdrawal = await readWithdrawal(c.chainId, c.txHash as Hex);
      const state = withdrawal ? await claimState(withdrawal) : undefined;
      setLive((l) => ({ ...l, [c.txHash]: { withdrawal, state } }));
      // Delivered by the chain's relayer: nothing was left to do, so it leaves the list at once (owner, 2026-10-20)
      if (state?.stage === 'claimed' && nativeExitOf(c.chainId)?.relayed) {
        removePendingClaim(c.txHash);
        setList(pendingClaimsOf(c.from));
        return;
      }
      // Claimed: it leaves the list by itself a few minutes from now
      if (state?.stage === 'claimed' && c.doneAt === undefined) {
        markClaimDone(c.txHash);
        setList(pendingClaimsOf(c.from));
      }
    } catch {
      setLive((l) => ({ ...l, [c.txHash]: { error: true } }));
    }
  }, []);

  useEffect(() => {
    const claims = pendingClaimsOf(address);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setList(claims);
    // One at a time: a handful of reads each, on public RPCs
    void (async () => { for (const c of claims) await read(c); })();
  }, [address, version, read]);

  const add = async (txHash: Hex): Promise<string | null> => {
    const w = await findWithdrawal(txHash);
    if (!w) return 'No withdrawal through a chain\'s own bridge in that transaction (Lisk, Arbitrum Nova, Abstract, Gravity, Taiko, Fraxtal).';
    const exit = nativeExitOf(w.chainId)!;
    addPendingClaim({
      chainId: w.chainId, chainName: exit.chainName, explorerUrl: exit.explorerUrl, symbol: exit.token?.symbol ?? parentOf(exit).symbol, decimals: exit.token?.decimals ?? 18,
      from: address, recipient: w.recipient, amount: w.amount.toString(), txHash, sentAt: w.sentAt,
    });
    setList(pendingClaimsOf(address));
    void read(pendingClaimsOf(address).find((c) => c.txHash === txHash)!);
    return null;
  };

  // Drop each done withdrawal when its few minutes are up
  useEffect(() => {
    const next = Math.min(...list.map((c) => (c.doneAt === undefined ? Infinity : c.doneAt + DONE_KEEP_MS)));
    if (next === Infinity) return;
    const timer = setTimeout(() => setList(pendingClaimsOf(address)), Math.max(0, next - Date.now()) + 1_000);
    return () => clearTimeout(timer);
  }, [list, address]);

  // A relayed withdrawal (Taiko) is listed only once read and not delivered: never one that needs nothing
  const shown = list.filter((c) => !nativeExitOf(c.chainId)?.relayed || live[c.txHash] !== undefined);
  const ready = shown.filter((c) => { const st = live[c.txHash]?.state?.stage; return (st === 'prove' || st === 'claim') && !!live[c.txHash]?.withdrawal; }).length;
  useEffect(() => { onSummary?.({ total: shown.length, ready }); }, [shown.length, ready, onSummary]);

  const needsProve = shown.some((c) => nativeExitOf(c.chainId)?.prove);
  const remove = (txHash: string) => { removePendingClaim(txHash); setList(pendingClaimsOf(address)); };
  return (
    <section className="ap-card ap-claims" aria-label="Waiting to be claimed">
      <p className="ap-claims-lead">
        {shown.length === 0
          ? 'Nothing waiting. A sweep through a chain\'s own bridge shows up here until it is claimed.'
          : <>Withdrawals into a chain&apos;s own bridge, kept in this browser. Nothing arrives until it is {needsProve ? 'proved and ' : ''}claimed, from here or on the chain&apos;s bridge site. Any wallet can pay that gas; the funds go to the recipient either way.</>}
      </p>
      {shown.length > 0 && (
        <ul className="ap-claim-list">
          {shown.map((c) => {
            const exit = nativeExitOf(c.chainId)!;
            const l = live[c.txHash];
            const s = l?.state;
            const tag = statusTag(c, l);
            const canAct = (s?.stage === 'prove' || s?.stage === 'claim') && !!l?.withdrawal;
            const steps = stepsOf(c, l);
            return (
              <li key={c.txHash} className="ap-claim">
                <div className="ap-claim-top">
                  <span className="ap-claim-chain">
                    <ChainIcon chainId={c.chainId} name={c.chainName} size={30} />
                    <span><b>{c.chainName}</b><small>sent {day(c.sentAt)}</small></span>
                  </span>
                  <span className="ap-claim-amt">
                    <b>{formatAmount(BigInt(c.amount), c.decimals)} {exit.token?.symbol ?? c.symbol}</b>
                    <small>to {shortAddress(c.recipient)} on {parentOf(exit).name}</small>
                  </span>
                  <span className="ap-claim-act">
                    {canAct
                      ? <button type="button" className="btn btn-primary btn-sm" onClick={() => setActing({ claim: c, step: s!.stage as ClaimStep })}>{s!.stage === 'prove' ? 'Prove now' : 'Claim now'}</button>
                      : <span className={`tag ${tag.tone}`}>{tag.text}</span>}
                  </span>
                </div>
                <ol className="ap-claim-steps" aria-label="Progress">
                  {steps.labels.map((label, i) => (
                    <li key={label} className={i < steps.done ? 'done' : i === steps.done ? (steps.ready ? 'now ready' : 'now') : ''} aria-current={i === steps.done ? 'step' : undefined}>{label}</li>
                  ))}
                </ol>
                <p className="ap-claim-detail">{detailText(c, l)}</p>
                <p className="ap-claim-links">
                  {c.explorerUrl && <a href={`${c.explorerUrl.replace(/\/$/, '')}/tx/${c.txHash}`} target="_blank" rel="noreferrer">Withdrawal ↗</a>}
                  {s?.stage !== 'claimed' && exit.bridge && <a href={exit.bridge.url} target="_blank" rel="noreferrer">{exit.bridge.name} ↗</a>}
                  {l?.withdrawal === null && <button type="button" className="linkbtn" onClick={() => remove(c.txHash)}>Remove</button>}
                </p>
              </li>
            );
          })}
        </ul>
      )}
      <AddClaim onAdd={add} />
      {acting && live[acting.claim.txHash]?.withdrawal && (
        <ClaimDialog
          open
          step={acting.step}
          withdrawal={live[acting.claim.txHash]!.withdrawal!}
          chainName={acting.claim.chainName}
          symbol={acting.claim.symbol}
          decimals={acting.claim.decimals}
          onSent={() => void read(acting.claim)}
          onClose={() => setActing(null)}
        />
      )}
    </section>
  );
}

/** A withdrawal sent from another browser or device: added by its transaction hash */
function AddClaim({ onAdd }: { onAdd: (txHash: Hex) => Promise<string | null> }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const hash = value.trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) { setError('A transaction hash is 0x and 64 hex characters.'); return; }
    setBusy(true);
    setError(null);
    const problem = await onAdd(hash.toLowerCase() as Hex).catch(() => 'Could not read the chains right now. Try again in a moment.');
    setBusy(false);
    if (problem) setError(problem);
    else { setValue(''); setOpen(false); }
  };
  if (!open) {
    return <p className="ap-claims-add"><button type="button" className="linkbtn" onClick={() => setOpen(true)}>Sent into a chain&apos;s own bridge from another browser? Add the withdrawal</button></p>;
  }
  return (
    <form className="ap-claims-add ap-claims-form" onSubmit={(e) => void submit(e)}>
      <label htmlFor="claim-tx">The withdrawal&apos;s transaction on its chain (the sweep&apos;s &ldquo;Sent&rdquo; link)</label>
      <div>
        <input id="claim-tx" value={value} onChange={(e) => setValue(e.target.value)} placeholder="0x…" spellCheck={false} autoComplete="off" aria-invalid={error ? true : undefined} />
        <button type="submit" className="btn btn-ghost btn-sm" disabled={busy}>{busy ? 'Looking…' : 'Add'}</button>
        <button type="button" className="linkbtn" onClick={() => { setOpen(false); setError(null); }}>Cancel</button>
      </div>
      {error && <p className="field-error" role="alert">{error}</p>}
    </form>
  );
}

/** The withdrawal's steps, how many are done, and whether the next one can be sent now */
function stepsOf(c: PendingClaim, l: Live | undefined): { labels: string[]; done: number; ready: boolean } {
  const exit = nativeExitOf(c.chainId)!;
  const stage = l?.withdrawal ? l.state?.stage : undefined;
  if (exit.relayed) return { labels: ['Sent', 'Delivered'], done: stage === 'claimed' ? 2 : 1, ready: false };
  if (exit.prove) {
    const done = stage === 'claimed' ? 4 : stage === 'claim' ? 3 : stage === 'proved' ? 2 : 1;
    return { labels: ['Sent', 'Prove', 'Wait', 'Claim'], done, ready: stage === 'prove' || stage === 'claim' };
  }
  const done = stage === 'claimed' ? 3 : stage === 'claim' ? 2 : 1;
  return { labels: ['Sent', 'Wait', 'Claim'], done, ready: stage === 'claim' };
}

function statusTag(c: PendingClaim, l: Live | undefined): { text: string; tone: string } {
  if (!l) return { text: 'Checking…', tone: 'plain' };
  if (nativeExitOf(c.chainId)?.relayed && !l.error && l.withdrawal) {
    return l.state?.stage === 'waiting' && l.state.until ? { text: `Arrives about ${day(l.state.until)}`, tone: 'plain' } : { text: 'Not arrived yet', tone: 'warn' };
  }
  if (l.error) return { text: `Claim from about ${day(claimableFrom(c))}`, tone: 'plain' };
  if (l.withdrawal === null) return { text: 'No withdrawal found', tone: 'warn' };
  const s = l.state!;
  switch (s.stage) {
    case 'prove': return { text: 'Ready to prove', tone: 'ok' };
    case 'proved': return { text: `Proved · claim from ${day(s.until)}`, tone: 'plain' };
    case 'claim': return { text: 'Ready to claim', tone: 'ok' };
    case 'claimed': return { text: 'Claimed', tone: 'ok' };
    case 'waiting': return { text: s.until ? `Claim from about ${day(s.until)}` : nativeExitOf(c.chainId)?.prove ? 'Prove opens in a few hours' : 'Claim opens soon', tone: 'plain' };
  }
}

function detailText(c: PendingClaim, l: Live | undefined): string {
  const exit = nativeExitOf(c.chainId)!;
  if (l?.error) return 'Could not read it from the chain right now; the date is the usual wait.';
  if (l?.withdrawal === null) return 'This transaction holds no withdrawal.';
  if (exit.relayed) {
    return l?.state?.stage === 'waiting' && l.state.until
      ? `${c.chainName}'s relayer delivers it; nothing to claim.`
      : `${c.chainName}'s relayer has not delivered it yet. If it does not within a few hours, claim it on ${exit.bridge?.name ?? `${c.chainName}'s bridge`} with the recipient's wallet.`;
  }
  switch (l?.state?.stage) {
    case 'prove': return `${c.chainName}'s state covering it is on ${parentOf(exit).name}: prove it now to start the wait.`;
    case 'proved': return `Proved on ${parentOf(exit).name}. Claim when the wait ends.`;
    case 'claim': return 'The wait is over.';
    case 'claimed': return `Claimed on ${parentOf(exit).name}. It leaves this list in a few minutes.`;
    case 'waiting': return exit.prove ? `Waiting for ${c.chainName} to post its state on ${parentOf(exit).name}; then prove it.` : `Waiting for ${parentOf(exit).name} to confirm it.`;
    default: return '';
  }
}
