import { useState } from 'react';
import { isAddress } from 'viem';
import type { ClipboardState } from './KeyEntry';
import { ChainIcon } from './ChainIcon';
import { ConfirmDialog } from './ConfirmDialog';
import { DestinationPicker } from './DestinationPicker';
import { ProgressCard } from './ProgressCard';
import { WalletHead } from './WalletHead';
import { ChevronIcon, DownIcon, PencilIcon, RefreshIcon } from './icons';
import { formatAmount, formatUsd, shortAddress, usdValue } from '../lib/format';
import { serviceFeeUsd } from '../lib/fees';
import { deliversOnlyToSender } from '@zerodust/sdk';
import { durationText } from '../sweep/timing';
import { isRouted, plainReason, rowToken, type Choice, type DestTotal, type Row, type SweepModel } from '../sweep/useSweep';

const CHOICES: Record<Exclude<Choice, 'elsewhere' | 'address'> | 'leave', { label: string; text: (amount: string, dest: string) => string; danger?: boolean; quiet?: boolean }> = {
  'exit-donate': { label: 'Swap out', text: (_a, d) => `Swap to a token a bridge takes, then send it to ${d}. The few cents of gas reserve left are donated to ZeroDust.` },
  'exit-burn': { label: 'Swap out, burn the cents left', text: () => 'Same, but the cents left are burned instead of donated.' },
  donate: { label: 'Donate all to ZeroDust', text: (a) => `${a} goes to ZeroDust. You receive nothing.` },
  burn: { label: 'Burn all', text: (a) => `${a} is destroyed. Nobody receives it.`, danger: true },
  leave: { label: 'Leave it', text: () => 'This chain is not swept and keeps its balance.', quiet: true },
};

/** How a chosen fallback reads on its row */
export const CHOICE_LABEL: Record<Choice, string> = {
  'exit-donate': 'Swap out; cents left donated',
  'exit-burn': 'Swap out; cents left burned',
  donate: 'Donate all to ZeroDust',
  burn: 'Burn all, not received',
  elsewhere: 'Goes to another chain',
  address: 'Goes to another address on this chain',
};

/** "0.0013 ETH on Base, 0.000015 ETH on Optimism" */
export const totalsText = (totals: DestTotal[]) =>
  totals.map((t) => `${formatAmount(t.amount, t.decimals, 6)} ${t.symbol}${t.isToken ? ' (token)' : ''} on ${t.dest.name}`).join(', ');

/** Every destination's total in USD, or null while a price is missing */
export function totalsUsd(totals: DestTotal[], prices: Record<string, number>): number | null {
  let sum = 0;
  for (const t of totals) {
    const usd = usdValue(t.amount, t.decimals, prices[t.symbol]);
    if (usd === null) return null;
    sum += usd;
  }
  return sum;
}

export function SweepCard({ model, clipboard, onForget }: { model: SweepModel; clipboard: ClipboardState; onForget: () => void }) {
  const m = model;
  const [pickerOpen, setPickerOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [menuFor, setMenuFor] = useState<number | null>(null);
  // The "Send to an address on this chain" form: which row it is open on, and its draft
  const [addressFormFor, setAddressFormFor] = useState<number | null>(null);
  const [addressDraft, setAddressDraft] = useState('');
  const openMenu = (chainId: number) => {
    setMenuFor(menuFor === chainId ? null : chainId);
    setAddressFormFor(null);
    setAddressDraft('');
  };
  const [showAll, setShowAll] = useState(false);

  if (m.stage === 'sweeping' || m.stage === 'done') return <ProgressCard model={m} onForget={onForget} />;

  const price = (token: string) => m.prices[token];
  const rowUsd = (r: Row) => usdValue(r.balance, r.decimals, price(r.token));
  const amountText = (r: Row) => `${formatAmount(r.balance, r.decimals)} ${r.token}${formatUsd(rowUsd(r)) ? ` (${formatUsd(rowUsd(r))})` : ''}`;

  if (m.stage === 'loading' || m.stage === 'error' || m.stage === 'empty') {
    return (
      <section className="card" aria-live="polite">
        <WalletHead title="Sweep" address={m.address} />
        <div className="card-message">
          {m.stage === 'loading' && <p>Reading balances on every chain…</p>}
          {m.stage === 'error' && <p className="field-error" role="alert">Could not load balances: {m.loadError}</p>}
          {m.stage === 'empty' && (
            <>
              <p><strong>Nothing to sweep.</strong></p>
              <p className="muted">Every chain reads 0 for {shortAddress(m.address)}.</p>
            </>
          )}
        </div>
        <div className={m.stage === 'empty' ? 'actions two' : 'actions'}>
          {m.stage === 'error' && <button type="button" className="btn btn-primary btn-block" onClick={m.reload}>Try again</button>}
          {m.stage === 'empty' && (
            <>
              {/* A wallet funded after it was loaded: read the chains again without reloading it */}
              <button type="button" className="btn btn-ghost btn-block" onClick={onForget}>Load another wallet</button>
              <button type="button" className="btn btn-primary btn-block" onClick={m.reload} disabled={m.busy}>{m.busy ? 'Checking…' : 'Check again'}</button>
            </>
          )}
        </div>
      </section>
    );
  }

  const checked = m.stage === 'checked';
  const sorted = [...m.rows].sort((a, b) => (rowUsd(b) ?? 0) - (rowUsd(a) ?? 0));
  const VISIBLE = 7;
  const flagged = (r: Row) => m.needsChoice(r) || !!m.choices[r.chainId];
  const shownRows = showAll ? sorted : sorted.filter((r, i) => i < VISIBLE || flagged(r));
  const hiddenRows = sorted.filter((r) => !shownRows.includes(r));
  const hiddenUsd = hiddenRows.reduce((s, r) => s + (rowUsd(r) ?? 0), 0);

  const selectedAll = m.rows.filter((r) => m.selected.has(r.chainId) && r.canSweep && m.blockedReason(r) !== 'Destination');
  const totalUsd = m.rows.reduce((s, r) => s + (rowUsd(r) ?? 0), 0);
  // Before a destination is chosen, count what is selected; after, what can actually go
  const counted = m.destination === null ? selectedAll : m.selectedRows;
  const routed = counted.filter((r) => isRouted(m.choices[r.chainId]));
  // A direct chain's checked fee is exact; otherwise the published schedule
  const feeUsd = routed.reduce((s, r) => {
    const fee = m.states[r.chainId]?.fee;
    return s + (fee !== undefined ? usdValue(fee, r.decimals, price(r.token)) ?? 0 : serviceFeeUsd(rowUsd(r) ?? 0));
  }, 0);
  // The headline is the destination's gas; when only a token arrives (token delivery), that token
  const headline: DestTotal | undefined = m.readyTotals.find((t) => t.dest.chainId === m.destination && !t.isToken) ?? m.readyTotals[0];
  const otherTotals = m.readyTotals.filter((t) => t !== headline);
  const receiveUsd = m.destRow ? totalsUsd(m.readyTotals, m.prices) : null;
  const readyRoutedUsd = m.readyRows.filter((r) => isRouted(m.choices[r.chainId]) && m.choices[r.chainId] !== 'address').reduce((s, r) => s + (rowUsd(r) ?? 0), 0);
  const gasUsd = receiveUsd === null ? null : Math.max(0, readyRoutedUsd - receiveUsd - feeUsd);
  const readyBridges = [...new Set(m.readyRows.map((r) => m.bridgeOf[r.chainId]).filter((b): b is string => !!b))];
  const burned = m.selectedRows.filter((r) => m.choices[r.chainId] === 'burn');
  const donated = m.selectedRows.filter((r) => m.choices[r.chainId] === 'donate');
  const toAddress = m.selectedRows.filter((r) => m.choices[r.chainId] === 'address');

  let action: { label: string; onClick?: () => void; disabled?: boolean };
  if (m.destination === null) action = { label: 'Choose where it goes', onClick: () => setPickerOpen(true) };
  else if (!m.recipientValid) action = { label: 'Enter a valid address', disabled: true };
  else if (m.selfOnly) action = { label: 'Enter another address', onClick: () => setEditing(true) };
  else if (m.selectedRows.length === 0) action = { label: 'Select a chain to sweep', disabled: true };
  else if (checked) action = { label: `Sweep ${m.readyRows.length} chain${m.readyRows.length === 1 ? '' : 's'}`, onClick: () => setConfirmOpen(true), disabled: m.busy };
  else action = { label: m.busy ? 'Checking…' : 'Check sweep', onClick: m.check, disabled: m.busy };

  return (
    <section className="card" aria-labelledby="sweep-title">
      <WalletHead title="Sweep" address={m.address} titleId="sweep-title" />
      <p className="wallet-line">
        {m.wallet === 'metamask' ? 'Connected MetaMask account' : 'Loaded'} <span className="addr">{m.address}</span>. Check this is the wallet you meant.
        {clipboard === 'cleared' && ' Clipboard wiped.'}
      </p>

      <div className="panel">
        <div className="panel-label">
          <span>From</span>
          <button type="button" className="link-btn" onClick={m.reload} disabled={m.busy}><RefreshIcon /> Refresh</button>
        </div>
        <div className="total">
          <div>
            <div className="amt">{formatUsd(totalUsd) || `${m.rows.length} chains`}</div>
            <div className="sub">{m.rows.length} chain{m.rows.length === 1 ? '' : 's'}, {selectedAll.length} selected</div>
          </div>
        </div>
        <ul className="rows">
          {shownRows.map((r) => {
            const st = m.states[r.chainId];
            const blocked = m.blockedReason(r);
            const isDest = blocked === 'Destination';
            const choice = m.choices[r.chainId];
            const needs = m.needsChoice(r);
            const disabled = m.busy || isDest || !r.canSweep || (!!blocked && !choice);
            const on = m.selected.has(r.chainId) && !disabled;
            return (
              <li key={r.chainId} className={`row${needs || choice ? ' flag' : ''}`}>
                <input
                  type="checkbox"
                  className="check"
                  checked={on}
                  disabled={disabled}
                  onChange={() => m.toggle(r.chainId)}
                  aria-label={`Sweep ${r.name}`}
                />
                <ChainIcon chainId={r.chainId} name={r.name} />
                <span className="name"><span className="name-line">{r.name}</span></span>
                <span className="right">
                  {formatUsd(rowUsd(r)) || '-'}
                  <span className="bal">
                    {st?.phase === 'ready' && isRouted(choice) && <span className="ok-text">Ready, </span>}
                    {formatAmount(r.balance, r.decimals)} {r.token}
                  </span>
                </span>
                {isDest && <span className="detail muted">Same chain, same wallet: nothing would move</span>}
                {!isDest && !blocked && (() => {
                  const to = m.elsewhere[r.chainId] ?? m.destination;
                  const token = to === null ? undefined : rowToken(r.chainId, to);
                  return token && (
                    <span className="detail warn-text">
                      Arrives as {token.symbol} (a token) on {m.destOf(to!)?.name ?? 'the destination'}, not as gas{deliversOnlyToSender(r.chainId, to!) ? ', to this wallet only' : ''}
                    </span>
                  );
                })()}
                {!r.canSweep && <span className="detail muted">{r.unavailable ?? 'Too small to sweep'}</span>}
                {st?.phase === 'quoting' && <span className="detail muted">Checking…</span>}
                {st?.phase === 'ready' && m.bridgeOf[r.chainId] && (() => {
                  const expected = m.expectedFor(r);
                  return (
                    <span className="detail muted">
                      Bridged by {m.bridgeOf[r.chainId]}{expected && `, usually ${durationText(expected.seconds)}`}
                      {expected?.slowLately && <span className="warn-text">. Slower than usual lately</span>}
                    </span>
                  );
                })()}
                {st?.phase === 'no-route' && !needs && <span className="detail warn-text" title={st.detail}>{plainReason(st.detail ?? '', r.token, r.name, r)}</span>}
                {needs && (
                  <span className="detail split">
                    <span className="warn-text">{blocked ?? st?.detail}</span>
                    <button type="button" className="choose" onClick={() => openMenu(r.chainId)} aria-expanded={menuFor === r.chainId}>
                      {blocked?.startsWith('Too small') ? 'Too small' : 'No route'}: choose <ChevronIcon />
                    </button>
                  </span>
                )}
                {!needs && !choice && r.canSweep && !m.busy && m.destination !== null && (
                  <span className="detail">
                    <button type="button" className="link-btn quiet-link" onClick={() => openMenu(r.chainId)} aria-expanded={menuFor === r.chainId}>
                      Send elsewhere <ChevronIcon />
                    </button>
                  </span>
                )}
                {menuFor === r.chainId && (needs || !choice) && (
                  <span className="menu" role="group" aria-label={`What to do with ${r.name}`}>
                    <span className="menu-title">
                      {!needs
                        ? isDest
                          ? `${r.name} is the destination chain. To empty it, send it to another address:`
                          : `Instead of ${m.destRow?.name ?? 'the destination'}, ${r.name} can go to:`
                        : !m.toSelf && m.destination !== null && deliversOnlyToSender(r.chainId, m.destination)
                          ? `${r.name}'s bridge can only send to the loaded wallet, not to the address you set. Use your wallet as the recipient, or instead:`
                          : blocked?.startsWith('Too small')
                            ? `Add ${r.token} on ${r.name} to bridge it, or instead:`
                            : `Nothing can carry ${r.token} to ${m.destRow?.name ?? 'the destination'} right now. Instead:`}
                    </span>
                    {(() => {
                      const draftValid = isAddress(addressDraft, { strict: false });
                      const isSelf = draftValid && addressDraft.toLowerCase() === m.address.toLowerCase();
                      if (addressFormFor !== r.chainId) {
                        return (
                          <button type="button" className="menu-item" onClick={() => { setAddressFormFor(r.chainId); setAddressDraft(''); }}>
                            <b>Send to an address on {r.name}</b>
                            <span>For example an exchange deposit address for {r.token} on {r.name}. {amountText(r)} goes there, on {r.name}.</span>
                          </button>
                        );
                      }
                      return (
                        <span className="menu-item address-form">
                          <b>Send to an address on {r.name}</b>
                          <label className="addr-label" htmlFor={`addr-${r.chainId}`}>Address on {r.name}</label>
                          <input
                            id={`addr-${r.chainId}`}
                            className={`addr-field${addressDraft && !draftValid ? ' invalid' : ''}`}
                            value={addressDraft}
                            onChange={(e) => setAddressDraft(e.target.value.trim())}
                            placeholder="0x…"
                            spellCheck={false}
                            autoComplete="off"
                          />
                          {addressDraft && !draftValid && <span className="field-error" role="alert">Not a valid address: 0x and 40 hex characters.</span>}
                          {isSelf && <span className="field-error" role="alert">That is the loaded wallet: sending {r.name} to itself moves nothing.</span>}
                          {draftValid && !isSelf && <AddressCheck address={addressDraft} />}
                          <ul className="address-warnings">
                            <li>The address must accept {r.token} on {r.name}. An exchange address for another network can lose the funds.</li>
                            <li>Exchanges ignore deposits below their minimum. Check it for {r.token} on {r.name} first.</li>
                            {!r.direct && <li>ZeroDust sends this from a contract call (an internal transfer). Some exchanges do not credit those: check with yours, or try a small amount first.</li>}
                          </ul>
                          <span className="address-actions">
                            <button type="button" className="btn btn-ghost" onClick={() => setAddressFormFor(null)}>Back</button>
                            <button
                              type="button"
                              className="btn btn-primary"
                              disabled={!draftValid || isSelf}
                              onClick={() => { m.setChoice(r.chainId, 'address', undefined, addressDraft); setMenuFor(null); setAddressFormFor(null); }}
                            >
                              Use this address
                            </button>
                          </span>
                        </span>
                      );
                    })()}
                    {needs && m.altsFor(r).map((d) => (
                      <button key={`to-${d.chainId}`} type="button" className="menu-item" onClick={() => { m.setChoice(r.chainId, 'elsewhere', d.chainId); setMenuFor(null); }}>
                        <b>Send to {d.name} instead{rowToken(r.chainId, d.chainId) ? ` as ${rowToken(r.chainId, d.chainId)!.symbol} (token)` : ''}</b>
                        <span>
                          {amountText(r)} goes to {d.name}, to {m.toSelf ? 'your wallet' : 'the address you set'}
                          {rowToken(r.chainId, d.chainId) ? `, as the ${rowToken(r.chainId, d.chainId)!.symbol} token, not ${d.token} gas` : ''}. Everything else still goes to {m.destRow?.name ?? 'the destination'}.
                        </span>
                      </button>
                    ))}
                    {(needs ? [...m.choicesFor(r), 'leave' as const] : []).map((key) => {
                      const c = CHOICES[key];
                      return (
                        <button
                          key={key}
                          type="button"
                          className={`menu-item${c.danger ? ' danger' : ''}${c.quiet ? ' quiet' : ''}`}
                          onClick={() => {
                            if (key !== 'leave') m.setChoice(r.chainId, key);
                            else if (m.selected.has(r.chainId)) m.toggle(r.chainId);
                            setMenuFor(null);
                          }}
                        >
                          <b>{c.label}</b>
                          <span>{c.text(amountText(r), m.destRow?.name ?? 'the destination')}</span>
                        </button>
                      );
                    })}
                  </span>
                )}
                {choice && (
                  <span className="detail split">
                    <span className={choice === 'burn' ? 'danger-text strong' : choice === 'elsewhere' || choice === 'address' ? 'strong' : 'warn-text strong'}>
                      {choice === 'elsewhere'
                        ? `Goes to ${m.destOf(m.elsewhere[r.chainId]!)?.name ?? 'another chain'} instead`
                        : choice === 'address'
                          ? `To ${shortAddress(m.addressOf[r.chainId]!)} on ${r.name}`
                          : CHOICE_LABEL[choice]}
                    </span>
                    <button type="button" className="link-btn" onClick={() => m.setChoice(r.chainId, null)} disabled={m.busy}>Change</button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
        {hiddenRows.length > 0 && (
          <button type="button" className="more" onClick={() => setShowAll(true)}>
            {hiddenRows.length} more chain{hiddenRows.length === 1 ? '' : 's'}, {formatUsd(hiddenUsd)}
          </button>
        )}
      </div>

      <div className="arrow" aria-hidden="true"><span><i><DownIcon /></i></span></div>

      <div className="panel">
        <div className="panel-label">
          <span>To</span>
          {editing || !m.toSelf
            ? <button type="button" className="link-btn" onClick={() => { m.setRecipient(m.address); setEditing(false); }}>Use my wallet</button>
            : <button type="button" className="link-btn" onClick={() => setEditing(true)}>Receive at: your wallet <PencilIcon /></button>}
        </div>
        <div className="to-row">
          <button type="button" className="chain-pill" onClick={() => setPickerOpen(true)} disabled={m.busy}>
            {m.destRow ? <ChainIcon chainId={m.destRow.chainId} name={m.destRow.name} size={28} /> : <span className="ci ci-empty" aria-hidden="true" />}
            <span>{m.destRow ? m.destRow.token : 'Choose chain'}{m.destRow && <small>{m.destRow.name}</small>}</span>
            <ChevronIcon />
          </button>
          <div className="recv">
            {checked && m.destRow
              ? <>
                  <div className="amt">{headline ? `${formatAmount(headline.amount, headline.decimals, 6)} ${headline.symbol}` : `0 ${m.destRow.token}`}</div>
                  <div className="sub">
                    {headline?.isToken ? `a token on ${headline.dest.name}, not gas; ` : ''}
                    {otherTotals.length > 0 ? `plus ${totalsText(otherTotals)}; at least ${formatUsd(receiveUsd)} in all` : `at least ${formatUsd(receiveUsd)}`}
                  </div>
                </>
              : <div className="sub">{m.destination === null ? 'Pick the chain that receives everything' : 'Check for a quote'}</div>}
          </div>
        </div>
        {m.selfOnly && (
          <p className="field-warn" role="alert">
            {m.destRow?.name ?? 'This chain'} to the same wallet on {m.destRow?.name ?? 'the same chain'} moves nothing. To empty it, receive at another address.
          </p>
        )}
        {(editing || !m.toSelf || m.selfOnly) && (
          <div className="recipient">
            <label className="addr-label" htmlFor="recipient">Receive at</label>
            <input
              id="recipient"
              className={`addr-field${m.recipientValid ? '' : ' invalid'}`}
              value={m.recipient}
              onChange={(e) => m.setRecipient(e.target.value)}
              spellCheck={false}
              autoComplete="off"
              disabled={m.busy}
              aria-invalid={!m.recipientValid}
              aria-describedby="recipient-help"
            />
            {!m.recipientValid && <p id="recipient-help" className="field-error" role="alert">Not a valid address: 0x and 40 hex characters.</p>}
            {m.recipientValid && !m.toSelf && (
              <div id="recipient-help" className="addr-warn" role="alert">
                <b>This is not the loaded wallet.</b> Check that it starts and ends like the address you meant. A sweep to the wrong address cannot be undone.
                <AddressCheck address={m.recipient} />
              </div>
            )}
          </div>
        )}
      </div>

      <dl className="summary">
        {checked && m.destRow && (
          <div><dt>You receive at least</dt><dd>{totalsText(m.readyTotals) || `0 ${m.destRow.token}`}{formatUsd(receiveUsd) && ` (${formatUsd(receiveUsd)})`}</dd></div>
        )}
        {checked && readyBridges.length > 0 && <div><dt>Bridged by</dt><dd>{readyBridges.join(', ')}</dd></div>}
        <div><dt>ZeroDust fee</dt><dd>{checked ? '' : 'about '}{formatUsd(feeUsd) || '$0.00'}</dd></div>
        {checked && gasUsd !== null && <div><dt>Gas and bridges</dt><dd>{formatUsd(gasUsd) || '$0.00'}</dd></div>}
        {toAddress.length > 0 && <div><dt>To other addresses</dt><dd>{toAddress.map((r) => `${amountText(r)} on ${r.name}`).join(', ')}</dd></div>}
        {burned.length > 0 && <div><dt>Burned</dt><dd className="danger-text">{burned.map(amountText).join(', ')}</dd></div>}
        {donated.length > 0 && <div><dt>Donated</dt><dd className="warn-text">{donated.map(amountText).join(', ')}</dd></div>}
        <div><dt>Chains</dt><dd>{counted.length} of {m.rows.length}</dd></div>
      </dl>
      <p className="footnote">
        {checked ? 'Each chain is quoted again when it is swept.' : 'Check gets real quotes and simulates every chain. Nothing is sent.'}
        {checked && readyBridges.length > 0 && ' The bridges named above carry the funds across chains; ZeroDust builds each transfer and checks it before you sign.'}
      </p>
      <div className="actions">
        <button type="button" className="btn btn-primary btn-block" onClick={action.onClick} disabled={action.disabled}>
          {action.label}
        </button>
      </div>

      <DestinationPicker
        open={pickerOpen}
        dests={m.dests}
        sourceCount={m.sourceCount}
        current={m.destination}
        onPick={(id) => { m.setDestination(id); setPickerOpen(false); }}
        onClose={() => setPickerOpen(false)}
      />
      <ConfirmDialog open={confirmOpen} model={m} onCancel={() => setConfirmOpen(false)} onConfirm={() => { setConfirmOpen(false); void m.sweep(); }} />
    </section>
  );
}

/**
 * The address as one unbroken string, its first and last characters picked out: what people
 * compare against the address they meant (owner, 2026-10-06: a spaced copy read as an error)
 */
export function AddressCheck({ address }: { address: string }) {
  const head = address.slice(0, 6);
  const tail = address.slice(-4);
  const middle = address.slice(6, -4);
  return (
    <div className="addr-check" aria-label={`Address ${address}`}>
      <b>{head}</b>{middle}<b>{tail}</b>
    </div>
  );
}
