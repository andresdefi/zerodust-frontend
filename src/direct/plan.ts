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

/**
 * Chains that charge gasLimit x gasPrice and refund nothing (the API's kind
 * 'gaslimit'): any sufficient limit leaves exactly 0. Pinned here, not taken
 * from the API: on a chain that refunds, a plan checked this way would leave
 * dust. The page refuses a plan when /direct/chains disagrees.
 */
export const GASLIMIT_CHAINS: ReadonlySet<number> = new Set([143]);

/**
 * Chains that charge their own fixed network gas price whatever a transaction
 * offers (the API's kind 'fixedprice'; Telos, 2026-10-07: a 1.1x offer was
 * charged 1.0x). A plan priced above it would leave the difference as dust, so
 * the page requires every transaction's price to equal the network price it
 * reads itself. Pinned here; the page refuses a plan when /direct/chains disagrees.
 */
export const FIXED_PRICE_CHAINS: ReadonlySet<number> = new Set([40]);

/**
 * ZK-stack chains (direct kind 'zk'): the ZeroDust paymaster pays all gas, so a
 * fee transaction plus a sweep whose values add up to the balance leave exactly
 * 0. Pinned here, not taken from the API: a plan naming another paymaster is
 * refused. Deployed 2026-10-02 (contracts-zk), owner and approver ZeroDust.
 */
export const ZK_PAYMASTERS: Readonly<Record<number, string>> = {
  324: '0x986e4Bb55AEEE6a8c80c28Ca787b13E216fD25B8', // zkSync Era
  2741: '0x986e4Bb55AEEE6a8c80c28Ca787b13E216fD25B8', // Abstract
  232: '0x986e4Bb55AEEE6a8c80c28Ca787b13E216fD25B8', // Lens
};
/** IPaymasterFlow.general(bytes): the only paymaster flow a plan may use */
export const PAYMASTER_GENERAL = '0x8c5a3445';
/**
 * Monad's reserve rule: a transaction that takes the wallet below 10 MON
 * reverts unless no other transaction from it landed in the past 3 blocks,
 * so each transaction waits this many blocks after the previous one's block.
 */
export const TX_GAP_BLOCKS: Readonly<Record<number, number>> = { 143: 4 };

export type DirectRoute = 'gaszip' | 'relay' | 'across' | 'transfer' | 'burn' | 'donate' | 'lifi';
export type PlanMode = 'route' | 'burn' | 'donate' | 'exit';

export interface PlanTx {
  kind: 'fee' | 'sweep' | 'swap';
  to: string;
  data: string;
  value: string;
  gas: string;
  gasPrice: string;
  nonce: number;
  /** ZK-stack chains: an EIP-712 (type 113) transaction naming the ZeroDust paymaster */
  paymaster?: string;
  paymasterInput?: string;
  gasPerPubdata?: string;
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
  /** ZK-stack chains: the gas the fee transaction prepays (its value is fee + gasFee) */
  gasFee?: string;
  /** The balance the plan spends (exactly, or minus the swap's leftover) */
  balance: string;
  leftoverMax?: string;
  tool?: string;
  /** Chains with a reserve rule (Monad): blocks between transactions (the page uses its own TX_GAP_BLOCKS) */
  txGapBlocks?: number;
  /** Across: unix seconds after which the deposit reverts; the page recomputes it from the calldata */
  expiresAt?: number;
}

export interface DirectChainInfo {
  chainId: number;
  name: string;
  token: string;
  decimals: number;
  explorerUrl: string;
  rpcUrl: string;
  /** The chain's gas rule: evm, arbitrum, etherlink or gaslimit */
  kind?: string;
  txGapBlocks?: number;
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
/** minimumBalanceWei: too small for every bridge, this balance would go through (AMOUNT_TOO_LOW) */
export const directRoute = (t: Target) => get<{ available: boolean | null; exit?: boolean; reason?: string; minimumBalanceWei?: string }>('route', { ...t });

export const preparePlan = (t: Target & { mode: Exclude<PlanMode, 'exit'>; feePaidTx?: string }) =>
  get<DirectPlan>('prepare', { ...t, mode: t.mode === 'route' ? undefined : t.mode });

export const prepareExit = (t: Target & { feePaidTx?: string }) => get<DirectPlan>('exit', { ...t });

/**
 * Polls a bridge; `quoted` lets the API record delivered vs quoted (no address
 * or hash is stored). Across looks deposits up by origin chain, so it always
 * gets fromChainId.
 */
export const deliveryStatus = (plan: DirectPlan, hash: string, toChainId?: number) =>
  get<{ state: 'pending' | 'delivered' | 'failed'; destTx?: string }>('status', {
    route: plan.route, hash, requestId: plan.requestId ?? undefined,
    quoted: plan.quoted,
    fromChainId: plan.quoted || plan.route === 'across' ? plan.chainId : undefined,
    toChainId: plan.quoted ? toChainId : undefined,
  });
