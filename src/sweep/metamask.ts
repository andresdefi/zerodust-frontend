// Sweeping from MetaMask without a private key (workspace docs/METAMASK-PERMISSIONS.md).
//
// The wallet grants a one-time ERC-7715 "native-token-allowance" to ZeroDust's permission
// router (its redeemer and payee), signs the usual sweep intent with the router as the
// EIP-712 verifyingContract, and ZeroDust's sponsor sweeps it to exactly 0 through the router.
// The key never leaves MetaMask. The first grant on a chain also switches the account to
// MetaMask's smart account (an EIP-7702 upgrade MetaMask runs and the wallet pays for).
//
// Raw EIP-1193 calls, as MetaMask's own smart-accounts-kit sends them (v2.0), without the kit
// (it also sends usage analytics).

import { l1FeeAllowanceWei, SWEEP_INTENT_TYPES, verifySweepQuote, type QuoteResponse, type SweepIntentMessage } from '@zerodust/sdk';
import { getAddress, isAddress, toHex, type Address, type Hex } from 'viem';
import { DIRECT_RPC_URLS, RPC_URLS } from '../chains/rpcs';
import { rpcCall } from '../lib/rpc';
import { verifySponsoredAcross } from './across-route';
import { API_URL, DELEGATION_MANAGER, PERMISSION_DOMAIN_VERSION, PERMISSION_ROUTER } from './constants';

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] | Record<string, unknown> }): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
}

interface Eip6963Detail {
  info: { rdns: string; name: string };
  provider: Eip1193Provider;
}

/**
 * MetaMask's provider: announced through EIP-6963 (so another wallet extension holding
 * window.ethereum does not stand in for it), else window.ethereum if it says it is MetaMask.
 */
export async function findMetaMask(timeoutMs = 400): Promise<Eip1193Provider | null> {
  const found = await new Promise<Eip1193Provider | null>((resolve) => {
    let done = false;
    const onAnnounce = (event: Event) => {
      const detail = (event as CustomEvent<Eip6963Detail>).detail;
      if (!done && detail?.info?.rdns?.startsWith('io.metamask')) {
        done = true;
        window.removeEventListener('eip6963:announceProvider', onAnnounce);
        resolve(detail.provider);
      }
    };
    window.addEventListener('eip6963:announceProvider', onAnnounce);
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    setTimeout(() => {
      if (done) return;
      done = true;
      window.removeEventListener('eip6963:announceProvider', onAnnounce);
      resolve(null);
    }, timeoutMs);
  });
  if (found) return found;
  const injected = (window as unknown as { ethereum?: Eip1193Provider & { isMetaMask?: boolean } }).ethereum;
  return injected?.isMetaMask ? injected : null;
}

export interface MetaMaskSession {
  provider: Eip1193Provider;
  address: Address;
  /** Chains where MetaMask grants a native-token-allowance */
  permissionChains: Set<number>;
}

/** Asks MetaMask for the account and which chains it grants native-token permissions on */
export async function connectMetaMask(provider: Eip1193Provider): Promise<MetaMaskSession> {
  const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as string[];
  const first = accounts?.[0];
  if (!first || !isAddress(first)) throw new Error('MetaMask did not share an account.');
  let supported: Record<string, { chainIds?: string[] }> = {};
  try {
    supported = (await provider.request({ method: 'wallet_getSupportedExecutionPermissions', params: [] })) as typeof supported;
  } catch {
    throw new Error('This MetaMask does not support Advanced Permissions. Update MetaMask (13.23 or later), or sweep with your key.');
  }
  const chainIds = supported?.['native-token-allowance']?.chainIds ?? [];
  return { provider, address: getAddress(first), permissionChains: new Set(chainIds.map((id) => Number(BigInt(id)))) };
}

/** Puts MetaMask on this chain (the permission and the signature are per chain) */
export async function switchChain(provider: Eip1193Provider, chainId: number): Promise<void> {
  await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: toHex(chainId) }] });
}

/**
 * Asks MetaMask, in ONE request, for a one-time allowance per chain to the router: the router
 * alone can use it (redeemer) and receive from it (payee), and it expires in `ttlSeconds`.
 * MetaMask shows each chain in turn (Grant, Confirm, and the smart-account upgrade the first
 * time on a chain), without network switching. Returns each chain's permission context.
 */
export async function requestPermissions(
  provider: Eip1193Provider,
  router: Address,
  items: Array<{ chainId: number; amount: bigint; chainName: string }>,
  ttlSeconds = 600
): Promise<Map<number, Hex>> {
  const now = Math.floor(Date.now() / 1000);
  const to = getAddress(router);
  const result = (await provider.request({
    method: 'wallet_requestExecutionPermissions',
    params: items.map((p) => ({
      chainId: toHex(p.chainId),
      permission: {
        type: 'native-token-allowance',
        data: {
          allowanceAmount: toHex(p.amount),
          startTime: now,
          justification: `ZeroDust: move this wallet's whole ${p.chainName} balance once, so it ends at exactly 0. Only ZeroDust's router can use this, and only for 10 minutes.`,
        },
        isAdjustmentAllowed: false,
      },
      to,
      rules: [
        { type: 'expiry', data: { timestamp: now + ttlSeconds } },
        { type: 'redeemer', data: { addresses: [to] } },
        { type: 'payee', data: { addresses: [to] } },
      ],
    })),
  })) as Array<{ chainId?: string; context?: string }> | null;
  const contexts = new Map<number, Hex>();
  for (const [i, r] of (result ?? []).entries()) {
    if (!r?.context || !/^0x[0-9a-fA-F]+$/.test(r.context)) continue;
    // Each answer names its chain; fall back to the request's order
    const chainId = r.chainId ? Number(BigInt(r.chainId)) : items[i]?.chainId;
    if (chainId !== undefined) contexts.set(chainId, r.context as Hex);
  }
  if (contexts.size === 0) throw new Error('MetaMask did not return a permission.');
  return contexts;
}

// ============ ZeroDust API ============

export interface PermissionQuote extends Omit<QuoteResponse, 'authNonce'> {
  signer?: string;
  bridge?: { name: string; displayName: string; inputAmount?: string; expectedOutput?: string };
  permission: { router: Address; delegationManager: string; domainVersion: string };
}

/** The API's error text and code, kept together so the page can say what happened */
export class ApiError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
  }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, { ...init, headers: { 'content-type': 'application/json', ...init?.headers }, signal: AbortSignal.timeout(20_000) });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string; code?: string };
  if (!res.ok) throw new ApiError(body.error ?? `Request failed (${res.status})`, body.code);
  return body;
}

/** A quote for a permission sweep (no signing) */
export function permissionQuote(p: { fromChainId: number; toChainId: number; user: Address; destination: Address }): Promise<PermissionQuote> {
  const q = new URLSearchParams({
    fromChainId: String(p.fromChainId),
    toChainId: String(p.toChainId),
    userAddress: p.user,
    destination: p.destination,
    signer: 'permission',
  });
  return api<PermissionQuote>(`/quote?${q}`).then((quote) => {
    assertPinnedContracts(quote);
    return quote;
  });
}

const sameAddress = (a: unknown, b: string) => typeof a === 'string' && isAddress(a) && a.toLowerCase() === b.toLowerCase();

/** A permission quote must name ZeroDust's router, MetaMask's DelegationManager and the router's domain */
export function assertPinnedContracts(quote: PermissionQuote): void {
  const p = quote?.permission;
  if (quote?.signer !== 'permission' || !p || !sameAddress(p.router, PERMISSION_ROUTER) || !sameAddress(p.delegationManager, DELEGATION_MANAGER) || p.domainVersion !== PERMISSION_DOMAIN_VERSION) {
    throw new Error('Stopped: the quote is not for the ZeroDust router');
  }
}

// ============ Relay: the deposit comes from Relay, to this page ============

const RELAY_API = 'https://api.relay.link';
const NATIVE = '0x0000000000000000000000000000000000000000';

interface RelayQuoteAnswer {
  requestId?: string;
  message?: string;
  steps?: Array<{ kind?: string; requestId?: string; items: Array<{ data: { to: string; data: string; value: string; chainId: number } }> }>;
  details?: { recipient?: string; currencyOut?: { amount?: string; currency?: { address?: string; chainId?: number } } };
}

/**
 * Relay keeps a request's recipient on its own servers; the deposit calldata only names an id. So
 * for a Relay route the page asks Relay itself for the deposit (the recipient and refunds it sets,
 * the exact amount the sweep routes), checks Relay's answer, and binds that deposit into the quote
 * (POST /quote/:quoteId/relay-route). A compromised ZeroDust API cannot substitute its own request.
 */
export async function bindOwnRelayDeposit(
  quote: PermissionQuote,
  want: { user: Address; fromChainId: number; toChainId: number; destination: Address }
): Promise<PermissionQuote> {
  const stop = (why: string): never => { throw new Error(`Stopped before signing: ${why}`); };
  const amount = quote.bridge?.inputAmount ?? stop('the Relay route has no amount to check');
  const res = await fetch(`${RELAY_API}/quote`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({
      user: want.user,
      recipient: want.destination,
      refundTo: want.user,
      originChainId: want.fromChainId,
      destinationChainId: want.toChainId,
      originCurrency: NATIVE,
      destinationCurrency: NATIVE,
      amount,
      tradeType: 'EXACT_INPUT',
    }),
  }).catch(() => stop('Relay did not answer; try again'));
  const answer = (await res.json().catch(() => ({}))) as RelayQuoteAnswer;
  if (!res.ok || !Array.isArray(answer.steps)) stop(`Relay did not quote this sweep (${answer.message ?? res.status})`);

  const steps = answer.steps!.filter((step) => step.items.length > 0);
  if (steps.length !== 1 || steps[0]!.kind !== 'transaction' || steps[0]!.items.length !== 1) stop('Relay asked for more than one transaction');
  const tx = steps[0]!.items[0]!.data;
  const requestId = steps[0]!.requestId ?? answer.requestId ?? '';
  if (tx.chainId !== want.fromChainId) stop('Relay\'s deposit is on another chain');
  if (BigInt(tx.value) !== BigInt(amount)) stop('Relay\'s deposit is for another amount');
  if (!/^0x[0-9a-fA-F]{64}$/.test(requestId)) stop('Relay\'s answer has no request id');
  const recipient = answer.details?.recipient;
  if (!recipient || recipient.toLowerCase() !== want.destination.toLowerCase()) stop('Relay would pay someone other than the address you set');
  const out = answer.details?.currencyOut;
  if (out?.currency?.address?.toLowerCase() !== NATIVE || out?.currency?.chainId !== want.toChainId) stop('Relay would not deliver native gas');
  if (BigInt(out?.amount ?? '0') < BigInt(quote.estimatedReceive)) stop('Relay now quotes less than the amount shown; check again');

  const bound = await api<{ intent: PermissionQuote['intent'] & { callData?: string } }>(`/quote/${quote.quoteId}/relay-route`, {
    method: 'POST',
    body: JSON.stringify({ callTarget: tx.to, callData: tx.data, requestId }),
  });
  if (bound.intent?.callData?.toLowerCase() !== tx.data.toLowerCase() || bound.intent.callTarget.toLowerCase() !== tx.to.toLowerCase()) {
    stop('the API did not bind the deposit Relay gave this page');
  }
  return { ...quote, intent: { ...quote.intent, ...bound.intent } };
}

// ============ Checks before signing ============

/** What the page reads from the chain itself to check a quote (never the API's word) */
export interface ChainReads {
  gasPrice(chainId: number): Promise<bigint>;
  /** Rollups: the L1 data fee allowance from the chain's oracle; 0 elsewhere */
  l1Fee(chainId: number): Promise<bigint>;
  /** An address's code on a chain (the destination too: is the recipient a contract?) */
  code(chainId: number, address: string): Promise<Hex>;
}

/** From the chain's public RPC in the page's CSP */
export const rpcChainReads: ChainReads = {
  gasPrice: async (chainId) => BigInt(await rpcCall<string>(chainId, 'eth_gasPrice', [])),
  l1Fee: (chainId) => l1FeeAllowanceWei(chainId, async (call) => rpcCall<Hex>(chainId, 'eth_call', [call, 'latest'])),
  code: async (chainId, address) => {
    const url = RPC_URLS[chainId] ?? DIRECT_RPC_URLS[chainId];
    if (!url) throw new Error(`No RPC for chain ${chainId}`);
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getCode', params: [address, 'latest'] }) });
    const body = (await res.json()) as { result?: Hex; error?: { message: string } };
    if (body.error || body.result === undefined) throw new Error(body.error?.message ?? 'RPC error');
    return body.result;
  },
};

/** Bridges the router can call: they name the refund address and recipient themselves (backend permission.ts) */
const ROUTER_SAFE_BRIDGES = new Set(['relay', 'across', 'hyperlane']);

/**
 * Checks one chain's permission quote the way the SDK checks a key sweep (verifySweepQuote:
 * wallet, destination and chain as the user chose, the bridge contract and its decoded deposit
 * paying this wallet's refunds and the destination, fees within bounds read from the chain,
 * deadline), and returns the SweepIntent to sign, built here from the checked fields.
 */
export async function verifyPermissionQuote(
  quote: PermissionQuote,
  want: { user: Address; fromChainId: number; toChainId: number; destination: Address; balance: bigint },
  reads: ChainReads
): Promise<SweepIntentMessage> {
  assertPinnedContracts(quote);
  const [gasPriceWei, l1FeeWei] = await Promise.all([reads.gasPrice(want.fromChainId), reads.l1Fee(want.fromChainId)]);
  let verified;
  try {
    verified = await verifySweepQuote(quote as unknown as QuoteResponse, {
      signer: want.user,
      fromChainId: want.fromChainId,
      toChainId: want.toChainId,
      destination: want.destination,
      balanceWei: want.balance,
      gasPriceWei,
      nowSeconds: Math.floor(Date.now() / 1000),
      l1FeeWei,
    });
  } catch (error) {
    throw new Error(`Stopped before signing: ${error instanceof Error ? error.message.replace(/^Refusing to sign: /, '') : 'the quote failed a check'}`);
  }
  if (verified.route.bridge !== null && !ROUTER_SAFE_BRIDGES.has(verified.route.bridge)) {
    throw new Error(`Stopped before signing: ${verified.route.bridge} cannot carry a MetaMask sweep`);
  }
  if (verified.route.bridge === 'across') await verifyAcrossRecipient(quote, want, reads);
  return verified.typedData.message;
}

/**
 * An Across deposit must be a plain ETH deposit paying the address set (across-route.ts), and that
 * address must be an ordinary or EIP-7702 wallet on the destination: Across pays a contract WETH
 */
async function verifyAcrossRecipient(
  quote: PermissionQuote,
  want: { user: Address; fromChainId: number; toChainId: number; destination: Address },
  reads: ChainReads
): Promise<void> {
  const callData = (quote.intent as { callData?: string }).callData;
  const value = quote.bridge?.inputAmount;
  if (!callData || !value) throw new Error('Stopped before signing: the Across route cannot be checked');
  try {
    verifySponsoredAcross({ to: quote.intent.callTarget, data: callData }, {
      fromChainId: want.fromChainId,
      toChainId: want.toChainId,
      user: want.user,
      recipient: want.destination,
      value: BigInt(value),
      minNative: BigInt(quote.estimatedReceive),
    });
  } catch (error) {
    throw new Error(`Stopped before signing: ${error instanceof Error ? error.message : 'the Across route failed a check'}`);
  }
  const readCode = () => reads.code(want.toChainId, want.destination);
  const code = await readCode().catch(() => readCode()).catch(() => null);
  if (code === null) throw new Error(`Stopped before signing: could not check the destination address on chain ${want.toChainId}; try again`);
  if (code !== '0x' && !code.toLowerCase().startsWith('0xef0100')) {
    throw new Error('Stopped before signing: the destination address is a contract, and Across would pay it WETH, not ETH');
  }
}

const INTENT_FIELDS = SWEEP_INTENT_TYPES.SweepIntent.map((f) => f.name);

/**
 * The SweepBatch to sign, built here: the router's domain (no chain id) and every chain's
 * checked intent, uint256 values as decimal strings (mode a number), exactly as the backend builds it.
 */
export function buildSweepBatch(entries: Array<{ chainId: number; intent: SweepIntentMessage }>): TypedData {
  return {
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'verifyingContract', type: 'address' },
      ],
      SweepIntent: SWEEP_INTENT_TYPES.SweepIntent.map((f) => ({ ...f })),
      ChainSweep: [
        { name: 'chainId', type: 'uint256' },
        { name: 'intent', type: 'SweepIntent' },
      ],
      SweepBatch: [{ name: 'sweeps', type: 'ChainSweep[]' }],
    },
    primaryType: 'SweepBatch',
    domain: { name: 'ZeroDust', version: PERMISSION_DOMAIN_VERSION, verifyingContract: getAddress(PERMISSION_ROUTER) },
    message: {
      sweeps: entries.map((e) => ({
        chainId: String(e.chainId),
        intent: Object.fromEntries(INTENT_FIELDS.map((k) => {
          const v = (e.intent as unknown as Record<string, unknown>)[k];
          return [k, typeof v === 'bigint' ? v.toString() : v];
        })),
      })),
    },
  };
}

/** Addresses, hashes and numbers compared by value, whatever case or type the API used */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical((value as Record<string, unknown>)[k])]));
  }
  if (typeof value === 'bigint' || typeof value === 'number') return value.toString();
  return typeof value === 'string' ? value.toLowerCase() : value;
}

/** The API's batch must be exactly the one built here: same domain, types and every intent */
export function assertBatchMatches(api: TypedData, local: TypedData): void {
  if (JSON.stringify(canonical(api)) !== JSON.stringify(canonical(local))) {
    throw new Error('Stopped before signing: the batch differs from the checked quotes');
  }
}

export type SweepStatus = 'pending' | 'simulating' | 'executing' | 'broadcasted' | 'bridging' | 'completed' | 'failed';

type TypedData = { domain: Record<string, unknown>; types: Record<string, unknown>; primaryType: string; message: Record<string, unknown> };

export interface BatchItem {
  chainId: number;
  chainName: string;
  toChainId: number;
  destination: Address;
  readBalance: () => Promise<bigint>;
}

export interface BatchResult {
  /** A failure before or at submission (nothing left the wallet) */
  error?: string;
  quote?: PermissionQuote;
  sweepId?: string;
  txHash?: string;
  status?: SweepStatus;
}

/**
 * Every chain at once, through MetaMask:
 *   1. one permission request for every chain (the allowance is each balance now);
 *   2. a quote per chain at the balance left after MetaMask's upgrade;
 *   3. ONE signature over the SweepBatch (no chain id in the domain: no network switch);
 *   4. a sweep per chain, followed until the relayer is done with it.
 * Quotes live ~55 s: if they expire while the batch is being read, the page quotes again
 * and asks for the signature once more. A chain that fails a step is reported and the rest go on.
 */
export async function sweepBatchWithPermissions(
  session: MetaMaskSession,
  items: BatchItem[],
  onStep: (chainId: number, step: string) => void,
  reads: ChainReads = rpcChainReads
): Promise<Map<number, BatchResult>> {
  const router = getAddress(PERMISSION_ROUTER);
  const { provider, address } = session;
  const results = new Map<number, BatchResult>();
  const fail = (chainId: number, error: string) => {
    results.set(chainId, { error });
    onStep(chainId, 'failed');
  };

  // 1. Balances, then one permission request for every chain that holds something
  const balances = await Promise.all(items.map((it) => it.readBalance().catch(() => 0n)));
  const funded = items.filter((it, i) => {
    if (balances[i]! > 0n) return true;
    fail(it.chainId, 'Nothing to sweep: the balance is 0');
    return false;
  });
  if (funded.length === 0) return results;
  for (const it of funded) onStep(it.chainId, 'Approve in MetaMask');
  let contexts: Map<number, Hex>;
  try {
    contexts = await requestPermissions(provider, router, funded.map((it) => ({ chainId: it.chainId, amount: balances[items.indexOf(it)]!, chainName: it.chainName })));
  } catch (error) {
    for (const it of funded) fail(it.chainId, error instanceof Error ? error.message : 'MetaMask refused the permission');
    return results;
  }
  const granted = funded.filter((it) => {
    if (contexts.has(it.chainId)) return true;
    fail(it.chainId, 'MetaMask did not grant the permission for this chain');
    return false;
  });

  // 2-4. Quote, sign once, submit; once more if the quotes ran out while signing
  for (let attempt = 0; attempt < 2; attempt++) {
    const quoted: Array<{ item: BatchItem; quote: PermissionQuote; intent: SweepIntentMessage }> = [];
    await Promise.all(granted.map(async (item) => {
      onStep(item.chainId, 'Quoting');
      try {
        let quote = await permissionQuote({ fromChainId: item.chainId, toChainId: item.toChainId, user: address, destination: item.destination });
        // A Relay route: the page asks Relay for the deposit itself, so Relay pays the recipient asked for here
        if (quote.bridge?.name === 'relay') {
          onStep(item.chainId, 'Asking Relay');
          quote = await bindOwnRelayDeposit(quote, { user: address, fromChainId: item.chainId, toChainId: item.toChainId, destination: item.destination });
        }
        onStep(item.chainId, 'Checking');
        const intent = await verifyPermissionQuote(
          quote,
          { user: address, fromChainId: item.chainId, toChainId: item.toChainId, destination: item.destination, balance: await item.readBalance() },
          reads
        );
        quoted.push({ item, quote, intent });
      } catch (error) {
        fail(item.chainId, error instanceof Error ? error.message : 'No quote');
      }
    }));
    if (quoted.length === 0) return results;
    quoted.sort((a, b) => granted.indexOf(a.item) - granted.indexOf(b.item));
    const quoteIds = quoted.map((q) => q.quote.quoteId);

    let signature: Hex;
    try {
      const { typedData } = await api<{ typedData: TypedData }>('/authorization/batch', { method: 'POST', body: JSON.stringify({ quoteIds }) });
      if (!sameAddress(typedData?.domain?.verifyingContract, router)) {
        throw new Error('Stopped before signing: the batch is not for the ZeroDust router');
      }
      // Sign the batch built here from the checked quotes; the API's is only compared
      const local = buildSweepBatch(quoted.map((q) => ({ chainId: q.item.chainId, intent: q.intent })));
      assertBatchMatches(typedData, local);
      for (const { item } of quoted) onStep(item.chainId, 'Sign in MetaMask');
      signature = (await provider.request({ method: 'eth_signTypedData_v4', params: [address, JSON.stringify(local)] })) as Hex;
    } catch (error) {
      for (const { item } of quoted) fail(item.chainId, error instanceof Error ? error.message : 'Signature refused');
      return results;
    }

    const submitted = await Promise.all(quoted.map(async ({ item, quote }) => {
      onStep(item.chainId, 'Submitting');
      try {
        const { sweepId } = await api<{ sweepId: string }>('/sweep', {
          method: 'POST',
          body: JSON.stringify({ quoteId: quote.quoteId, signature, permissionContext: contexts.get(item.chainId), batchQuoteIds: quoteIds }),
        });
        return { item, quote, sweepId };
      } catch (error) {
        return { item, quote, error };
      }
    }));
    const expired = submitted.filter((s) => s.error instanceof ApiError && s.error.code === 'QUOTE_EXPIRED');
    if (expired.length === submitted.length && attempt === 0) {
      // Every quote ran out while the batch was read: quote again and ask once more
      continue;
    }

    await Promise.all(submitted.map(async (s) => {
      if (!('sweepId' in s) || !s.sweepId) {
        fail(s.item.chainId, s.error instanceof Error ? s.error.message : 'Could not submit');
        return;
      }
      // Follow it: the relayer sends within seconds; a bridge can take minutes
      let last: { status: SweepStatus; txHash?: string; errorMessage?: string } = { status: 'pending' };
      for (let i = 0; i < 150; i++) {
        last = await api<typeof last>(`/sweep/${s.sweepId}`).catch(() => last);
        onStep(s.item.chainId, last.status);
        if (last.status === 'completed' || last.status === 'failed' || last.status === 'bridging') break;
        await new Promise((r) => setTimeout(r, 3000));
      }
      results.set(s.item.chainId, { quote: s.quote, sweepId: s.sweepId, txHash: last.txHash, status: last.status, ...(last.status === 'failed' ? { error: last.errorMessage ?? 'Sweep failed' } : {}) });
    }));
    return results;
  }
  return results;
}

/** A sweep's status, for following a bridge after the source chain reads 0 */
export function sweepStatus(sweepId: string): Promise<{ status: SweepStatus; txHash?: string; destinationTxHash?: string; bridgeTrackingUrl?: string; errorMessage?: string }> {
  return api(`/sweep/${sweepId}`);
}
