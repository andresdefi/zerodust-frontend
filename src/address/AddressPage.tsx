import { useMemo, useState } from 'react';
import type { Address } from 'viem';
import { ChainIcon } from '../components/ChainIcon';
import { DestinationPicker } from '../components/DestinationPicker';
import { formatAmount, formatUsd, shortAddress } from '../lib/format';
import { groupChains, groupText, tokenRouteOf, type GroupKey } from './groups';
import { useAddressData, useEstimates, useResolved, type AddressRow, type Estimate } from './useAddress';

// One address, read-only (redesign phase 2): every chain holding gas, in groups by how
// it is swept and what arrives. Selecting works within one group (a sweep acts on one
// group); signing arrives in phase 3, so the sweep buttons are not live yet.

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
  const [destination, setDestination] = useState<number | null>(null);
  const [picking, setPicking] = useState(false);
  const recipient = address;
  const data = useAddressData(address, destination, recipient);
  const groups = useMemo(() => groupChains(data.rows, data.routesOf, destination), [data.rows, data.routesOf, destination]);
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
  const sweepable = (c: AddressRow) => !data.routesOf(c.chainId).unknown && !estimates[c.chainId]?.error;
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

  const total = data.rows.reduce((s, r) => s + (r.usd ?? 0), 0);
  const selectedRows = active ? active.chains.filter((c) => selectedIds.has(c.chainId)) : [];
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

      <section className="ap-card ap-dest">
        <span className="ap-dim">Bridged gas goes to</span>
        <span className="ap-val">{shortAddress(recipient)} <small>(this wallet)</small></span>
        <span className="ap-dim">on</span>
        {destination === null
          ? <span className="ap-val ap-dim">a chain you choose</span>
          : <span className="ap-val"><ChainIcon chainId={destination} name={destName!} size={22} />{destName}</span>}
        <button type="button" className={`btn ${destination === null ? 'btn-primary' : 'btn-ghost'} btn-sm ap-push`} onClick={() => setPicking(true)}>
          {destination === null ? 'Choose a chain' : 'Change'}
        </button>
      </section>

      <div className="ap-tabs" role="tablist">
        <span role="tab" aria-selected="true" className="on">Balances</span>
        <span role="tab" aria-selected="false" aria-disabled="true">Delegations</span>
      </div>

      {data.state === 'loading' && <div className="ap-state">Reading balances on every chain…</div>}
      {data.state === 'error' && <div className="ap-state" role="alert">{data.error}</div>}
      {data.state === 'ready' && data.rows.length === 0 && (
        <div className="ap-state">Nothing to sweep: this address holds no gas on any of the {data.chainOptions.length} chains ZeroDust covers.</div>
      )}

      {groups.map((g) => {
        const text = groupText(g.key, destName);
        const isActive = g.key === activeGroup;
        const chosen = isActive ? g.chains.filter((c) => selectedIds.has(c.chainId)) : [];
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
              <button type="button" className={`btn btn-sm ${isActive ? 'btn-primary' : 'btn-ghost'}`} disabled title="Sweeping arrives in the next step of the redesign">
                Sweep {isActive ? chosen.length : g.chains.length} {(isActive ? chosen.length : g.chains.length) === 1 ? 'chain' : 'chains'}
              </button>
            </header>
            <ul className="ap-rows">
              {g.chains.map((c) => (
                <ChainRow
                  key={c.chainId} row={c} group={g.key} selected={isActive && selectedIds.has(c.chainId)} keyOnly={mixedSigners && !c.metamask}
                  onToggle={() => toggle(g.key, c.chainId)} destination={destination} destName={destName}
                  destToken={destToken ?? null} estimate={estimates[c.chainId]}
                  destPrice={destToken ? data.priceOf(destToken.token) : undefined}
                  unknownRoute={data.routesOf(c.chainId).unknown === true}
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
            <button type="button" className="btn btn-primary" disabled title="Sweeping arrives in the next step of the redesign">
              Sweep {selectedRows.length} {selectedRows.length === 1 ? 'chain' : 'chains'}
            </button>
          </div>
        </div>
      )}

      <DestinationPicker
        open={picking}
        dests={data.chainOptions.map((c) => ({ ...c, reachableFrom: 0 }))}
        sourceCount={0}
        current={destination}
        onPick={(id) => { setDestination(id); setPicking(false); setSelection(null); }}
        onClose={() => setPicking(false)}
      />
    </main>
  );
}

function ChainRow({ row, group, selected, keyOnly, onToggle, destination, destName, destToken, estimate, destPrice, unknownRoute }: {
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
}) {
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
