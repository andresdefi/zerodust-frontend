import { API_URL } from '../sweep/constants';

// Direct chains: no EIP-7702 in ZeroDust, swept by the wallet itself with
// exact legacy transactions. The API plans (/direct/*, quote-only); this page
// checks the plan on its own, replays it on a fork, signs and broadcasts.

/** ZeroDust's address (the sponsor, same EOA on every chain): fees and donations go here */
export const ZERODUST_ADDRESS = '0x01eD5c94DE39E73C986b98B85C2c0A3d1BEDff7D';
export const BURN_ADDRESS = '0x000000000000000000000000000000000000dEaD';
/** Gas.zip's direct-deposit address: a plain account, takes calldata 0x01|0x02 + recipient + dest short */
export const GASZIP_DEPOSIT = '0x391E7C679d29bD940d63be94AD22A25d25b5A604';
/** Relay depository's depositNative(address depositor, bytes32 id) */
export const RELAY_DEPOSIT_NATIVE = '0x49290c1c';
/** LI.FI's contract (the same address on the chains it serves) */
export const LIFI_DIAMOND = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE';

export type DirectRoute = 'gaszip' | 'relay' | 'transfer' | 'burn' | 'donate' | 'lifi';
export type PlanMode = 'route' | 'burn' | 'donate' | 'exit';

export interface PlanTx {
  kind: 'fee' | 'sweep' | 'swap';
  to: string;
  data: string;
  value: string;
  gas: string;
  gasPrice: string;
  nonce: number;
}

export interface DirectPlan {
  chainId: number;
  route: DirectRoute;
  requestId: string | null;
  txs: PlanTx[];
  receive: string;
  /** Bridge routes: the bridge's raw quote before the 3% display buffer, echoed to /direct/status for delivery stats */
  quoted?: string;
  fee: string;
  /** The balance the plan spends (exactly, or minus the swap's leftover) */
  balance: string;
  leftoverMax?: string;
  tool?: string;
}

export interface DirectChainInfo {
  chainId: number;
  name: string;
  token: string;
  decimals: number;
  explorerUrl: string;
  rpcUrl: string;
}

export interface DirectBalance {
  chainId: number;
  name: string;
  token: string;
  decimals: number;
  explorerUrl: string;
  balance: string;
}

export interface Target {
  chainId: number;
  toChainId: number;
  from: string;
  recipient: string;
}

async function get<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
  const query = params
    ? `?${new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]))}`
    : '';
  const res = await fetch(`${API_URL}/direct/${path}${query}`);
  const body = (await res.json()) as T & { error?: string; message?: string };
  if (!res.ok) throw new Error(body.error ?? body.message ?? `HTTP ${res.status}`);
  return body;
}

export const directChains = () => get<{ chains: DirectChainInfo[]; prices: Record<string, number> }>('chains');

export const directBalances = (address: string) => get<DirectBalance[]>(`balances/${address}`);

/** Before any check: can a bridge take it there (false + exit: only a swap can), null = unknown */
export const directRoute = (t: Target) => get<{ available: boolean | null; exit?: boolean; reason?: string }>('route', { ...t });

export const preparePlan = (t: Target & { mode: Exclude<PlanMode, 'exit'>; feePaidTx?: string }) =>
  get<DirectPlan>('prepare', { ...t, mode: t.mode === 'route' ? undefined : t.mode });

export const prepareExit = (t: Target & { feePaidTx?: string }) => get<DirectPlan>('exit', { ...t });

/** Polls a bridge; `quoted` lets the API record delivered vs quoted (no address or hash is stored) */
export const deliveryStatus = (plan: DirectPlan, hash: string, toChainId?: number) =>
  get<{ state: 'pending' | 'delivered' | 'failed'; destTx?: string }>('status', {
    route: plan.route, hash, requestId: plan.requestId ?? undefined,
    quoted: plan.quoted, fromChainId: plan.quoted ? plan.chainId : undefined, toChainId: plan.quoted ? toChainId : undefined,
  });
