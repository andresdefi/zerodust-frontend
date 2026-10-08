import { describe, expect, it } from 'vitest';
import { groupChains, groupOf, groupText, tokenRouteOf, type AddressChain } from '../src/address/groups';
import { parseView } from '../src/lib/route';

const chain = (chainId: number, over: Partial<AddressChain> = {}): AddressChain => ({
  chainId, name: `Chain ${chainId}`, token: 'ETH', decimals: 18, balance: 1n, explorerUrl: '', direct: false, metamask: false, ...over,
});
const BASE = 8453;

describe('groupOf: one group per way of sweeping and what arrives', () => {
  it('gas that a bridge carries: MetaMask chains apart from key-only ones', () => {
    expect(groupOf(chain(42161, { metamask: true }), { gas: true }, BASE)).toBe('metamask');
    expect(groupOf(chain(534352), { gas: true }, BASE)).toBe('key');
    // A direct chain is always key only, whatever MetaMask covers
    expect(groupOf(chain(43114, { direct: true, metamask: true }), { gas: true }, BASE)).toBe('key');
  });

  it('the destination chain itself is a plain transfer, whatever bridges say', () => {
    expect(groupOf(chain(BASE, { metamask: true }), { gas: false }, BASE)).toBe('metamask');
  });

  it('token-only chains (Mitosis, Endurance, Intuition, Telos) arrive as a token', () => {
    for (const id of [124816, 648, 1155, 40]) expect(groupOf(chain(id), { gas: false }, BASE), String(id)).toBe('token');
    expect(tokenRouteOf(124816)).toEqual({ symbol: 'MITO', toChainId: 56, toChainName: 'BNB Chain' });
    expect(tokenRouteOf(648)).toEqual({ symbol: 'ACE', toChainId: 56, toChainName: 'BNB Chain' });
    expect(tokenRouteOf(40)).toEqual({ symbol: 'TLOS', toChainId: 8453, toChainName: 'Base' });
  });

  it('no bridge at all: stays on its own chain; bridges but not to the destination: its own group', () => {
    expect(groupOf(chain(8217), { gas: false }, BASE)).toBe('own-chain');
    expect(groupOf(chain(1329), { gas: false, notToDestination: true }, BASE)).toBe('elsewhere');
  });

  it('not known yet (or no bridge answered): kept with the gas groups', () => {
    expect(groupOf(chain(1480, { direct: true }), { gas: null }, BASE)).toBe('key');
    expect(groupOf(chain(1480, { direct: true }), { gas: null, unknown: true }, BASE)).toBe('key');
  });
});

describe('groupChains', () => {
  it('orders groups easiest first and leaves empty ones out', () => {
    const routes: Record<number, { gas: boolean | null; notToDestination?: boolean }> = { 1: { gas: true }, 8217: { gas: false }, 124816: { gas: false }, 534352: { gas: true } };
    const groups = groupChains([chain(8217), chain(124816), chain(534352), chain(1, { metamask: true })], (id) => routes[id]!, BASE);
    expect(groups.map((g) => g.key)).toEqual(['metamask', 'key', 'token', 'own-chain']);
    expect(groups.map((g) => g.chains.map((c) => c.chainId))).toEqual([[1], [534352], [124816], [8217]]);
  });

  it('every group has a title, and the gas groups name the destination', () => {
    for (const key of ['metamask', 'key', 'token', 'elsewhere', 'own-chain', 'claim'] as const) expect(groupText(key, 'Base').title).toBeTruthy();
    expect(groupText('metamask', 'Base').detail).toContain('on Base');
    expect(groupText('key', null).detail).toContain('the chain you choose');
  });
});

describe('parseView', () => {
  it('home, an address page (address or ENS name), and the sweep flow kept at /sweep', () => {
    expect(parseView('/', '')).toEqual({ kind: 'home' });
    expect(parseView('/address/0x820653ccE8a755edbb52eC1bc5829D2a60CD5cc5', '')).toEqual({ kind: 'address', query: '0x820653ccE8a755edbb52eC1bc5829D2a60CD5cc5' });
    expect(parseView('/address/vitalik.eth', '')).toEqual({ kind: 'address', query: 'vitalik.eth' });
    expect(parseView('/address/', '')).toEqual({ kind: 'home' });
    expect(parseView('/sweep', '')).toEqual({ kind: 'sweep' });
  });
});
