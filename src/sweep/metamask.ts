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

import { getAddress, isAddress, toHex, type Address, type Hex } from 'viem';
import { API_URL } from './constants';

/** The page shows "Connect MetaMask" only with ?metamask in the URL while this is being tested */
export function metamaskEnabled(): boolean {
  try {
    return new URLSearchParams(window.location.search).has('metamask');
  } catch {
    return false;
  }
}

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

export interface GrantedPermission {
  context: Hex;
  delegationManager?: string;
}

/**
 * Asks MetaMask for a one-time allowance of `amount` to the router: the router alone can use it
 * (redeemer) and receive from it (payee), and it expires in `ttlSeconds`.
 */
export async function requestPermission(
  provider: Eip1193Provider,
  p: { chainId: number; router: Address; amount: bigint; chainName: string; ttlSeconds?: number }
): Promise<GrantedPermission> {
  const now = Math.floor(Date.now() / 1000);
  const router = getAddress(p.router);
  const result = (await provider.request({
    method: 'wallet_requestExecutionPermissions',
    params: [{
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
      to: router,
      rules: [
        { type: 'expiry', data: { timestamp: now + (p.ttlSeconds ?? 600) } },
        { type: 'redeemer', data: { addresses: [router] } },
        { type: 'payee', data: { addresses: [router] } },
      ],
    }],
  })) as Array<{ context?: string; delegationManager?: string }> | null;
  const context = result?.[0]?.context;
  if (!context || !/^0x[0-9a-fA-F]+$/.test(context)) throw new Error('MetaMask did not return a permission.');
  return { context: context as Hex, delegationManager: result![0]!.delegationManager };
}

// ============ ZeroDust API ============

export interface PermissionQuote {
  quoteId: string;
  userBalance: string;
  estimatedReceive: string;
  bridge?: { name: string; displayName: string };
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
  return api<PermissionQuote>(`/quote?${q}`);
}

export type SweepStatus = 'pending' | 'simulating' | 'executing' | 'broadcasted' | 'bridging' | 'completed' | 'failed';

/**
 * One chain, end to end: grant the permission, quote at the balance left after MetaMask's
 * upgrade, sign the intent, submit, and follow the sweep until the relayer is done with it.
 * Throws with what went wrong; `onStep` names the step for the page.
 */
export async function sweepWithPermission(
  session: MetaMaskSession,
  p: { chainId: number; chainName: string; toChainId: number; destination: Address; readBalance: () => Promise<bigint> },
  onStep: (step: string) => void
): Promise<{ sweepId: string; txHash?: string; quote: PermissionQuote; status: SweepStatus; error?: string }> {
  const { provider, address } = session;
  onStep('Switch network in MetaMask');
  await switchChain(provider, p.chainId);

  // The allowance covers the balance now; MetaMask's upgrade (first time) spends a little of it
  const before = await p.readBalance();
  if (before === 0n) throw new Error('Nothing to sweep: the balance is 0');
  const first = await permissionQuote({ fromChainId: p.chainId, toChainId: p.toChainId, user: address, destination: p.destination });

  onStep('Approve in MetaMask');
  const granted = await requestPermission(provider, { chainId: p.chainId, router: first.permission.router, amount: before, chainName: p.chainName });

  // A fresh quote: the 55-second signing window starts now, and the balance may have dropped
  onStep('Quoting');
  const quote = await permissionQuote({ fromChainId: p.chainId, toChainId: p.toChainId, user: address, destination: p.destination });
  const { typedData } = await api<{ typedData: { domain: Record<string, unknown>; types: Record<string, unknown>; primaryType: string; message: Record<string, unknown> } }>(
    '/authorization',
    { method: 'POST', body: JSON.stringify({ quoteId: quote.quoteId }) }
  );
  if (String(typedData.domain.verifyingContract).toLowerCase() !== first.permission.router.toLowerCase()) {
    throw new Error('Stopped before signing: the intent is not for the ZeroDust router');
  }

  onStep('Sign in MetaMask');
  const signature = (await provider.request({
    method: 'eth_signTypedData_v4',
    params: [address, JSON.stringify(typedData)],
  })) as Hex;

  onStep('Submitting');
  const submitted = await api<{ sweepId: string }>('/sweep', {
    method: 'POST',
    body: JSON.stringify({ quoteId: quote.quoteId, signature, permissionContext: granted.context }),
  });

  // Follow it: the relayer sends within seconds; a bridge can take minutes
  let last: { status: SweepStatus; txHash?: string; errorMessage?: string; error?: string } = { status: 'pending' };
  for (let i = 0; i < 120; i++) {
    last = await api<typeof last>(`/sweep/${submitted.sweepId}`).catch(() => last);
    onStep(last.status === 'bridging' ? 'bridging' : last.status);
    if (last.status === 'completed' || last.status === 'failed') break;
    await new Promise((r) => setTimeout(r, 4000));
  }
  return { sweepId: submitted.sweepId, txHash: last.txHash, quote, status: last.status, error: last.errorMessage ?? last.error };
}
