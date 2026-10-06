import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectMetaMask, requestPermissions, sweepBatchWithPermissions, type Eip1193Provider, type MetaMaskSession } from '../src/sweep/metamask';

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

describe('requestPermissions', () => {
  it('asks for every chain in one request: a one-time allowance, the router as redeemer and payee, an expiry, no adjustment', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-06T12:00:00Z'));
    const now = Math.floor(Date.now() / 1000);
    const { provider, calls } = fakeProvider({
      wallet_requestExecutionPermissions: [{ chainId: '0x2105', context: '0xabcd' }, { chainId: '0xa4b1', context: '0xef01' }],
    });

    const contexts = await requestPermissions(provider, ROUTER.toLowerCase() as `0x${string}`, [
      { chainId: 8453, amount: 1000n, chainName: 'Base' },
      { chainId: 42161, amount: 2000n, chainName: 'Arbitrum' },
    ]);

    expect(calls).toHaveLength(1);
    expect([...contexts]).toEqual([[8453, '0xabcd'], [42161, '0xef01']]);
    const requests = calls[0]!.params as Array<Record<string, unknown>>;
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual({
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
    expect((requests[1]!.permission as { data: { allowanceAmount: string } }).data.allowanceAmount).toBe('0x7d0');
  });

  it('maps answers without a chain id by order, and refuses an answer with no permission at all', async () => {
    const byOrder = fakeProvider({ wallet_requestExecutionPermissions: [{ context: '0x01' }, { context: '0x02' }] });
    const contexts = await requestPermissions(byOrder.provider, ROUTER, [{ chainId: 10, amount: 1n, chainName: 'OP' }, { chainId: 56, amount: 1n, chainName: 'BNB' }]);
    expect([...contexts]).toEqual([[10, '0x01'], [56, '0x02']]);
    const none = fakeProvider({ wallet_requestExecutionPermissions: [{}] });
    await expect(requestPermissions(none.provider, ROUTER, [{ chainId: 8453, amount: 1n, chainName: 'Base' }])).rejects.toThrow('did not return a permission');
  });
});

describe('sweepBatchWithPermissions', () => {
  const quoteFor = (chainId: number) => ({ quoteId: `q-${chainId}`, userBalance: '1000', estimatedReceive: '900', permission: { router: ROUTER, delegationManager: '0xdb9B', domainVersion: 'permission-2' } });

  /** The API as the page sees it: a quote per chain, the batch typed data, the sweeps and their status */
  function stubApi(opts: { verifyingContract?: string; sweepError?: (attempt: number) => { status: number; code: string } | null; status?: string } = {}) {
    const requests: Array<{ url: string; body?: Record<string, unknown> }> = [];
    let sweepCalls = 0;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ url, body });
      const json = (b: unknown, status = 200) => ({ ok: status < 400, status, json: async () => b });
      if (url.includes('/quote?')) return json(quoteFor(Number(new URL(url).searchParams.get('fromChainId'))));
      if (url.endsWith('/authorization/batch')) {
        return json({ typedData: { domain: { name: 'ZeroDust', version: 'permission-2', verifyingContract: opts.verifyingContract ?? ROUTER }, types: {}, primaryType: 'SweepBatch', message: { sweeps: body.quoteIds.map(() => ({})) } } });
      }
      if (url.endsWith('/sweep')) {
        const err = opts.sweepError?.(Math.floor(sweepCalls++ / 3));
        if (err) return json({ error: 'Quote expired', code: err.code }, err.status);
        return json({ sweepId: `s-${body.quoteId}` });
      }
      return json({ status: opts.status ?? 'completed', txHash: '0xfeed' });
    });
    return requests;
  }

  const session = (provider: Eip1193Provider): MetaMaskSession => ({ provider, address: USER, permissionChains: new Set([8453, 42161, 10]) });
  const item = (chainId: number, balance = 1000n) => ({ chainId, chainName: `chain ${chainId}`, toChainId: 8453, destination: DEST as `0x${string}`, readBalance: async () => balance });
  const granted = (ids: number[]) => ids.map((id) => ({ chainId: `0x${id.toString(16)}`, context: `0xc0${id.toString(16)}` }));

  it('three chains: one permission request, quotes, ONE signature, three sweeps carrying the whole batch', async () => {
    const requests = stubApi();
    const { provider, calls } = fakeProvider({ wallet_requestExecutionPermissions: granted([8453, 42161, 10]), eth_signTypedData_v4: '0x5151' });

    const results = await sweepBatchWithPermissions(session(provider), ROUTER, [item(8453), item(42161), item(10)], () => {});

    expect(calls.map((c) => c.method)).toEqual(['wallet_requestExecutionPermissions', 'eth_signTypedData_v4']);
    expect(requests.filter((r) => r.url.includes('/quote?'))).toHaveLength(3);
    expect(requests.find((r) => r.url.endsWith('/authorization/batch'))!.body).toEqual({ quoteIds: ['q-8453', 'q-42161', 'q-10'] });
    const sweeps = requests.filter((r) => r.url.endsWith('/sweep'));
    expect(sweeps.map((s) => s.body)).toEqual([8453, 42161, 10].map((id) => ({
      quoteId: `q-${id}`, signature: '0x5151', permissionContext: `0xc0${id.toString(16)}`, batchQuoteIds: ['q-8453', 'q-42161', 'q-10'],
    })));
    expect([...results.values()].every((r) => r.status === 'completed' && !r.error)).toBe(true);
  });

  it('skips an empty chain and a chain MetaMask did not grant, and sweeps the rest', async () => {
    stubApi();
    const { provider } = fakeProvider({ wallet_requestExecutionPermissions: granted([8453]), eth_signTypedData_v4: '0x5151' });
    const results = await sweepBatchWithPermissions(session(provider), ROUTER, [item(8453), item(42161), item(10, 0n)], () => {});
    expect(results.get(10)!.error).toBe('Nothing to sweep: the balance is 0');
    expect(results.get(42161)!.error).toBe('MetaMask did not grant the permission for this chain');
    expect(results.get(8453)!.status).toBe('completed');
  });

  it('re-quotes and asks for the signature once more when every quote expired while it was read', async () => {
    const requests = stubApi({ sweepError: (attempt) => (attempt === 0 ? { status: 400, code: 'QUOTE_EXPIRED' } : null) });
    const { provider, calls } = fakeProvider({ wallet_requestExecutionPermissions: granted([8453, 42161, 10]), eth_signTypedData_v4: '0x5151' });
    const results = await sweepBatchWithPermissions(session(provider), ROUTER, [item(8453), item(42161), item(10)], () => {});
    expect(calls.filter((c) => c.method === 'eth_signTypedData_v4')).toHaveLength(2);
    expect(calls.filter((c) => c.method === 'wallet_requestExecutionPermissions')).toHaveLength(1);
    expect(requests.filter((r) => r.url.includes('/quote?'))).toHaveLength(6);
    expect([...results.values()].every((r) => r.status === 'completed')).toBe(true);
  });

  it('stops before asking for a signature when the batch is not for the ZeroDust router', async () => {
    stubApi({ verifyingContract: '0x000000000000000000000000000000000000dEaD' });
    const { provider, calls } = fakeProvider({ wallet_requestExecutionPermissions: granted([8453]) });
    const results = await sweepBatchWithPermissions(session(provider), ROUTER, [item(8453)], () => {});
    expect(results.get(8453)!.error).toBe('Stopped before signing: the batch is not for the ZeroDust router');
    expect(calls.map((c) => c.method)).not.toContain('eth_signTypedData_v4');
  });

  it('a refused permission fails every chain without asking anything else', async () => {
    stubApi();
    const { provider, calls } = fakeProvider({ wallet_requestExecutionPermissions: new Error('User rejected the request.') });
    const results = await sweepBatchWithPermissions(session(provider), ROUTER, [item(8453), item(10)], () => {});
    expect([...results.values()].map((r) => r.error)).toEqual(['User rejected the request.', 'User rejected the request.']);
    expect(calls.map((c) => c.method)).toEqual(['wallet_requestExecutionPermissions']);
  });

  it('hands a bridging sweep back without waiting for the delivery (the page follows it)', async () => {
    stubApi({ status: 'bridging' });
    const { provider } = fakeProvider({ wallet_requestExecutionPermissions: granted([8453]), eth_signTypedData_v4: '0x5151' });
    const results = await sweepBatchWithPermissions(session(provider), ROUTER, [item(8453)], () => {});
    expect(results.get(8453)).toMatchObject({ status: 'bridging', sweepId: 's-q-8453' });
  });
});
