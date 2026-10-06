import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectMetaMask, requestPermission, sweepWithPermission, type Eip1193Provider, type MetaMaskSession } from '../src/sweep/metamask';

const ROUTER = '0x589CB1Fc24F8Cf6e41755Ea518e7815423e83f70';
const USER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const DEST = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';

/** A MetaMask stand-in: answers per method and records every request */
function fakeProvider(answers: Record<string, unknown | ((params: unknown) => unknown)>) {
  const calls: Array<{ method: string; params?: unknown }> = [];
  const provider: Eip1193Provider = {
    request: async ({ method, params }) => {
      calls.push({ method, params });
      const a = answers[method];
      if (a instanceof Error) throw a;
      return typeof a === 'function' ? (a as (p: unknown) => unknown)(params) : a;
    },
  };
  return { provider, calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('connectMetaMask', () => {
  it("takes the account and the chains MetaMask grants a native-token allowance on (hex ids)", async () => {
    const { provider } = fakeProvider({
      eth_requestAccounts: [USER.toLowerCase()],
      wallet_getSupportedExecutionPermissions: {
        'native-token-allowance': { chainIds: ['0x2105', '0x1'], ruleTypes: ['expiry', 'redeemer', 'payee'] },
        'erc20-token-periodic': { chainIds: ['0xa'] },
      },
    });
    const session = await connectMetaMask(provider);
    expect(session.address).toBe(USER);
    expect([...session.permissionChains]).toEqual([8453, 1]);
  });

  it('explains an old MetaMask without Advanced Permissions, and an empty account list', async () => {
    const old = fakeProvider({ eth_requestAccounts: [USER], wallet_getSupportedExecutionPermissions: new Error('Method not found') });
    await expect(connectMetaMask(old.provider)).rejects.toThrow('does not support Advanced Permissions');
    const none = fakeProvider({ eth_requestAccounts: [] });
    await expect(connectMetaMask(none.provider)).rejects.toThrow('did not share an account');
  });
});

describe('requestPermission', () => {
  it('asks for a one-time allowance with the router as redeemer and payee, an expiry, and no adjustment', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-06T12:00:00Z'));
    const now = Math.floor(Date.now() / 1000);
    const { provider, calls } = fakeProvider({ wallet_requestExecutionPermissions: [{ context: '0xabcd', delegationManager: '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3' }] });

    const granted = await requestPermission(provider, { chainId: 8453, router: ROUTER.toLowerCase() as `0x${string}`, amount: 1000n, chainName: 'Base' });

    expect(granted.context).toBe('0xabcd');
    const [request] = calls[0]!.params as Array<Record<string, unknown>>;
    expect(request).toEqual({
      chainId: '0x2105',
      permission: {
        type: 'native-token-allowance',
        data: { allowanceAmount: '0x3e8', startTime: now, justification: expect.stringContaining('whole Base balance once') },
        isAdjustmentAllowed: false,
      },
      to: ROUTER,
      rules: [
        { type: 'expiry', data: { timestamp: now + 600 } },
        { type: 'redeemer', data: { addresses: [ROUTER] } },
        { type: 'payee', data: { addresses: [ROUTER] } },
      ],
    });
  });

  it('refuses an answer without a context', async () => {
    const { provider } = fakeProvider({ wallet_requestExecutionPermissions: [{}] });
    await expect(requestPermission(provider, { chainId: 8453, router: ROUTER, amount: 1n, chainName: 'Base' })).rejects.toThrow('did not return a permission');
  });
});

describe('sweepWithPermission', () => {
  const quote = { quoteId: 'q-1', userBalance: '1000', estimatedReceive: '900', permission: { router: ROUTER, delegationManager: '0xdb9B', domainVersion: 'permission-1' } };

  /** The API as the page sees it: two quotes, the typed data, the sweep and its status */
  function stubApi(verifyingContract: string, statuses: string[]) {
    const requests: Array<{ url: string; body?: unknown }> = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const json = (body: unknown) => ({ ok: true, json: async () => body });
      if (url.includes('/quote?')) return json(quote);
      if (url.endsWith('/authorization')) return json({ typedData: { domain: { name: 'ZeroDust', version: 'permission-1', chainId: 8453, verifyingContract }, types: {}, primaryType: 'SweepIntent', message: {} } });
      if (url.endsWith('/sweep')) return json({ sweepId: 's-1' });
      return json({ status: statuses.shift() ?? 'completed', txHash: '0xfeed' });
    });
    return requests;
  }

  const session = (provider: Eip1193Provider): MetaMaskSession => ({ provider, address: USER, permissionChains: new Set([8453]) });

  it('switches, grants, quotes again after the grant, signs the router-domain intent and submits the context', async () => {
    const requests = stubApi(ROUTER, ['completed']);
    const { provider, calls } = fakeProvider({
      wallet_switchEthereumChain: null,
      wallet_requestExecutionPermissions: [{ context: '0xc0ffee' }],
      eth_signTypedData_v4: '0x5151',
    });
    const steps: string[] = [];

    const result = await sweepWithPermission(session(provider), { chainId: 8453, chainName: 'Base', toChainId: 8453, destination: DEST, readBalance: async () => 1000n }, (s) => steps.push(s));

    expect(calls.map((c) => c.method)).toEqual(['wallet_switchEthereumChain', 'wallet_requestExecutionPermissions', 'eth_signTypedData_v4']);
    expect(requests.filter((r) => r.url.includes('/quote?'))).toHaveLength(2);
    expect(requests.find((r) => r.url.endsWith('/sweep'))!.body).toEqual({ quoteId: 'q-1', signature: '0x5151', permissionContext: '0xc0ffee' });
    expect(result).toMatchObject({ sweepId: 's-1', txHash: '0xfeed', status: 'completed' });
    expect(steps).toContain('Sign in MetaMask');
  });

  it('stops before asking for a signature when the typed data is not for the router', async () => {
    stubApi('0x000000000000000000000000000000000000dEaD', []);
    const { provider, calls } = fakeProvider({ wallet_switchEthereumChain: null, wallet_requestExecutionPermissions: [{ context: '0xc0ffee' }] });
    await expect(sweepWithPermission(session(provider), { chainId: 8453, chainName: 'Base', toChainId: 8453, destination: DEST, readBalance: async () => 1000n }, () => {}))
      .rejects.toThrow('not for the ZeroDust router');
    expect(calls.map((c) => c.method)).not.toContain('eth_signTypedData_v4');
  });

  it('asks for nothing on an empty wallet', async () => {
    stubApi(ROUTER, []);
    const { provider, calls } = fakeProvider({ wallet_switchEthereumChain: null });
    await expect(sweepWithPermission(session(provider), { chainId: 8453, chainName: 'Base', toChainId: 8453, destination: DEST, readBalance: async () => 0n }, () => {}))
      .rejects.toThrow('the balance is 0');
    expect(calls.map((c) => c.method)).toEqual(['wallet_switchEthereumChain']);
  });
});
