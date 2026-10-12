import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { Address, Hex } from 'viem';
import { ChainIcon } from '../components/ChainIcon';
import { formatAmount, shortAddress } from '../lib/format';
import { claimState, findWithdrawal, readWithdrawal, type ClaimState, type Withdrawal } from '../sweep/claims';
import { addPendingClaim, claimableFrom, nativeExitOf, pendingClaimsOf, removePendingClaim, type PendingClaim } from '../sweep/native';
import { ClaimDialog, type ClaimStep } from './ClaimDialog';

interface Live {
  /** null: the transaction holds no withdrawal */
  withdrawal?: Withdrawal | null;
  state?: ClaimState;
  error?: boolean;
}

const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/**
 * Withdrawals sent into a chain's own bridge from this browser, still to be claimed on Ethereum
 * (sweep/native.ts). Each one's stage is read from the chain and Ethereum (sweep/claims.ts), and
 * the prove and claim are sent from here; the chain's bridge site stays linked as the fallback.
 */
export function PendingClaims({ address, version }: { address: Address; version: number }) {
  const [list, setList] = useState<PendingClaim[]>([]);
  const [live, setLive] = useState<Record<string, Live>>({});
  const [acting, setActing] = useState<{ claim: PendingClaim; step: ClaimStep } | null>(null);

  const read = useCallback(async (c: PendingClaim) => {
    try {
      const withdrawal = await readWithdrawal(c.chainId, c.txHash as Hex);
      const state = withdrawal ? await claimState(withdrawal) : undefined;
      setLive((l) => ({ ...l, [c.txHash]: { withdrawal, state } }));
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
    if (!w) return 'No withdrawal through a chain\'s own bridge in that transaction (Lisk, Arbitrum Nova, Blast, Abstract, Gravity).';
    const exit = nativeExitOf(w.chainId)!;
    addPendingClaim({
      chainId: w.chainId, chainName: exit.chainName, explorerUrl: exit.explorerUrl, symbol: exit.token?.symbol ?? 'ETH', decimals: exit.token?.decimals ?? 18,
      from: address, recipient: w.recipient, amount: w.amount.toString(), txHash, sentAt: w.sentAt,
    });
    setList(pendingClaimsOf(address));
    void read(pendingClaimsOf(address).find((c) => c.txHash === txHash)!);
    return null;
  };

  if (list.length === 0) return <AddClaim onAdd={add} />;
  const needsProve = list.some((c) => nativeExitOf(c.chainId)?.prove);
  return (
    <section className="ap-card ap-claims" aria-label="Waiting to be claimed">
      <header className="ap-grp-h">
        <div className="ap-grp-t">
          <h2>Waiting to be claimed<span className="tag acc">On Ethereum</span></h2>
          <p>Withdrawals into a chain&apos;s own bridge, kept in this browser. Nothing arrives until it is {needsProve ? 'proved and ' : ''}claimed on Ethereum, from here or on the chain&apos;s bridge site. Any wallet can pay that gas; the funds go to the recipient either way.</p>
        </div>
      </header>
      <ul className="ap-rows">
        {list.map((c) => {
          const exit = nativeExitOf(c.chainId)!;
          const l = live[c.txHash];
          const s = l?.state;
          const tag = statusTag(c, l);
          return (
            <li key={c.txHash} className="ap-row ap-claim">
              <span className="ap-chain"><ChainIcon chainId={c.chainId} name={c.chainName} size={28} /><span>{c.chainName}</span></span>
              <span className="ap-bal">{formatAmount(BigInt(c.amount), c.decimals)} {c.symbol}<small>sent {day(c.sentAt)}</small></span>
              <span className="ap-route"><span className={`tag ${tag.tone}`}>{tag.text}</span></span>
              <span className="ap-prog-detail">{detailText(c, l)} To {shortAddress(c.recipient)} on Ethereum{exit.token ? `, as ${exit.token.symbol}` : ''}.</span>
              <span className="ap-links-tx">
                {c.explorerUrl && <a href={`${c.explorerUrl.replace(/\/$/, '')}/tx/${c.txHash}`} target="_blank" rel="noreferrer">Withdrawal ↗</a>}
                {s?.stage !== 'claimed' && <a href={exit.bridgeUrl} target="_blank" rel="noreferrer">{exit.bridgeName} ↗</a>}
                {s?.stage === 'claimed'
                  ? <button type="button" className="linkbtn" onClick={() => { removePendingClaim(c.txHash); setList(pendingClaimsOf(address)); }}>Remove</button>
                  : l?.withdrawal === null && <button type="button" className="linkbtn" onClick={() => { removePendingClaim(c.txHash); setList(pendingClaimsOf(address)); }}>Remove</button>}
                {(s?.stage === 'prove' || s?.stage === 'claim') && l?.withdrawal && (
                  <button type="button" className="btn btn-primary btn-sm" onClick={() => setActing({ claim: c, step: s.stage as ClaimStep })}>
                    {s.stage === 'prove' ? 'Prove' : 'Claim'}
                  </button>
                )}
              </span>
            </li>
          );
        })}
      </ul>
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

function statusTag(c: PendingClaim, l: Live | undefined): { text: string; tone: string } {
  if (!l) return { text: 'Checking…', tone: 'plain' };
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
  switch (l?.state?.stage) {
    case 'prove': return `${c.chainName}'s state covering it is on Ethereum: prove it now to start the wait.`;
    case 'proved': return 'Proved on Ethereum. Claim when the wait ends.';
    case 'claim': return 'The wait is over.';
    case 'claimed': return 'Claimed on Ethereum.';
    case 'waiting': return exit.prove ? `Waiting for ${c.chainName} to post its state on Ethereum; then prove it.` : 'Waiting for Ethereum to confirm it.';
    default: return '';
  }
}
