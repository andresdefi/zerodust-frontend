import { useEffect, useRef, useState } from 'react';
import { formatEther, getAddress, isAddress } from 'viem';
import { KeyEntry } from '../components/KeyEntry';
import { OFFLINE } from '../lib/env';
import { formatAmount, shortAddress } from '../lib/format';
import { claimCall, proveCall, type Withdrawal } from '../sweep/claims';
import { payerAddress, quoteCall, sendCall, waitMined, type CallQuote, type Payer } from '../sweep/claim-send';
import { findMetaMask, walletErrorText } from '../sweep/metamask';
import type { L1Call } from '../sweep/claims';
import { nativeExitOf, parentOf } from '../sweep/native';

export type ClaimStep = 'prove' | 'claim';

/**
 * Proving or claiming one withdrawal on its parent chain, Ethereum or BNB Chain (sweep/claims.ts): pick who pays the gas
 * (MetaMask, any account, or a key), see the cost, send. Anyone may send it; the funds always
 * go to the withdrawal's recipient.
 */
export function ClaimDialog({ open, step, withdrawal, chainName, symbol, decimals, onSent, onClose }: {
  open: boolean;
  step: ClaimStep;
  withdrawal: Withdrawal;
  chainName: string;
  symbol: string;
  decimals: number;
  /** After it is mined: refresh the row */
  onSent: (hash: string, ok: boolean) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  const [mode, setMode] = useState<'choose' | 'key' | 'review' | 'sending' | 'done'>(OFFLINE ? 'key' : 'choose');
  const [payer, setPayer] = useState<Payer | null>(null);
  const [call, setCall] = useState<L1Call | null>(null);
  const [quote, setQuote] = useState<CallQuote | null>(null);
  const [hash, setHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const verb = step === 'prove' ? 'Prove' : 'Claim';
  const { name: on, symbol: gas, explorer } = parentOf(nativeExitOf(withdrawal.chainId)!);

  const close = () => {
    if (mode === 'sending') return;
    setMode(OFFLINE ? 'key' : 'choose'); setPayer(null); setCall(null); setQuote(null); setHash(null); setError(null);
    onClose();
  };

  /** Builds the call and prices it for this payer; a call that would fail is stopped here */
  const review = async (p: Payer) => {
    setPayer(p);
    setBusy(true);
    setError(null);
    try {
      const c = step === 'prove' ? await proveCall(withdrawal) : await claimCall(withdrawal);
      setCall(c);
      setQuote(await quoteCall(withdrawal.chainId, c, payerAddress(p)));
      setMode('review');
    } catch (e) {
      setError(`${verb} is not possible right now: ${firstLine(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const withMetaMask = async () => {
    setBusy(true);
    setError(null);
    try {
      const provider = await findMetaMask();
      if (!provider) throw new Error('MetaMask was not found in this browser. Use a key instead.');
      const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as string[];
      const first = accounts?.[0];
      if (!first || !isAddress(first)) throw new Error('MetaMask did not share an account.');
      setBusy(false);
      await review({ kind: 'metamask', provider, address: getAddress(first) });
    } catch (e) {
      setBusy(false);
      setError(firstLine(e));
    }
  };

  const send = async () => {
    if (!payer || !call || !quote) return;
    setMode('sending');
    setError(null);
    try {
      const h = await sendCall(withdrawal.chainId, payer, call, quote);
      setHash(h);
      const ok = await waitMined(withdrawal.chainId, h);
      setMode('done');
      if (!ok) setError(`The transaction failed on ${on}. Nothing moved; the gas it used is spent.`);
      onSent(h, ok);
    } catch (e) {
      setMode('review');
      setError(firstLine(e));
    }
  };

  const short = quote !== null && quote.balance < quote.maxCostWei;
  return (
    <dialog ref={ref} className="modal zd-with" onClose={close} aria-labelledby="claim-title">
      <div className="modal-head">
        <h3 id="claim-title">{verb} on {on}</h3>
        <button type="button" className="iconbtn" onClick={close} aria-label="Close" disabled={mode === 'sending'}>✕</button>
      </div>
      <p className="lead">
        {formatAmount(withdrawal.amount, decimals)} {symbol} from {chainName}, to {shortAddress(withdrawal.recipient)} on {on}.
        {step === 'prove' ? ' Proving starts the wait; a claim follows when it ends.' : ''} Any wallet can pay the gas: the funds go to {shortAddress(withdrawal.recipient)} either way.
      </p>
      {mode === 'choose' && (
        <div className="zd-opts">
          <button type="button" className="zd-opt" onClick={() => void withMetaMask()} disabled={busy}>
            <span className="zd-opt-ic" aria-hidden="true">🦊</span>
            <span className="zd-opt-t"><b>MetaMask</b><span>Any account with {gas} on {on}</span></span>
            {busy && <span className="tag plain">Connecting…</span>}
          </button>
          <button type="button" className="zd-opt" onClick={() => setMode('key')} disabled={busy}>
            <span className="zd-opt-ic" aria-hidden="true">🔑</span>
            <span className="zd-opt-t"><b>Private key</b><span>Of any wallet with {gas} on {on} · stays on this page</span></span>
          </button>
        </div>
      )}
      {mode === 'key' && (
        <>
          <KeyEntry
            title="Pay the gas with a key"
            help={`Type or paste the private key of a wallet that holds ${gas} on ${on}. It signs this one transaction.`}
            onAccount={(account) => void review({ kind: 'key', account })}
          />
          {busy && <p className="lead" role="status">Checking…</p>}
          {!OFFLINE && <button type="button" className="linkbtn zd-back" onClick={() => { setMode('choose'); setError(null); }}>Back</button>}
        </>
      )}
      {(mode === 'review' || mode === 'sending') && quote && payer && (
        <div className="zd-claim-review">
          <p><span>Paid by</span><b>{shortAddress(payerAddress(payer))}</b></p>
          <p><span>Gas on {on}</span><b>about {formatEther(quote.costWei).slice(0, 10)} {gas} (at most {formatEther(quote.maxCostWei).slice(0, 10)})</b></p>
          <p><span>It holds</span><b>{formatEther(quote.balance).slice(0, 10)} {gas}</b></p>
          {short && <p className="zd-note">This wallet holds less than the most it can cost. Add {gas} on {on} or use another wallet.</p>}
          <div className="btns">
            <button type="button" className="btn btn-ghost" disabled={mode === 'sending'} onClick={() => { setMode(OFFLINE ? 'key' : 'choose'); setError(null); }}>Back</button>
            <button type="button" className="btn btn-primary" disabled={short || mode === 'sending'} onClick={() => void send()}>
              {mode === 'sending' ? (hash ? `Waiting for ${on}…` : payer.kind === 'metamask' ? 'Confirm in MetaMask…' : 'Sending…') : `${verb} now`}
            </button>
          </div>
        </div>
      )}
      {mode === 'done' && hash && (
        <div className="zd-claim-review">
          <p>{error ? 'Failed' : step === 'prove' ? 'Proved. The claim opens when the wait ends; it shows on this page.' : `Claimed: the funds are at ${shortAddress(withdrawal.recipient)} on ${on}.`}</p>
          <p><a href={`${explorer}/tx/${hash}`} target="_blank" rel="noreferrer">Transaction ↗</a></p>
          <div className="btns"><span /><button type="button" className="btn btn-primary" onClick={close}>Done</button></div>
        </div>
      )}
      {error && <p className="field-error" role="alert">{error}</p>}
    </dialog>
  );
}

function firstLine(e: unknown): string {
  const text = e instanceof Error ? ((e as { shortMessage?: string }).shortMessage ?? e.message) : walletErrorText(e, 'the request');
  return text.split('\n')[0]!.slice(0, 240);
}
