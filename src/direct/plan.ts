import { API_URL } from '../sweep/constants';
import type { Closing } from '../address/closing';
import type { L1Formula } from './l1fee';

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
/**
 * Relay's depository, the only contract a Relay deposit may go to: its standard address, except
 * where Relay's own quotes name another (read from live quotes on every direct chain, 2026-10-08:
 * Cronos uses its own; Avalanche and Metis route through a router call, which the API refuses).
 * A plan naming any other contract is refused.
 */
export const RELAY_DEPOSITORY = '0x4cd00e387622c35bddb9b4c962c136462338bc31';
const RELAY_DEPOSITORY_BY_CHAIN: Readonly<Record<number, string>> = { 25: '0x59916da825d2d2ec1bf878d71c88826f6633ecca' };
export const relayDepositoryFor = (chainId: number): string => RELAY_DEPOSITORY_BY_CHAIN[chainId] ?? RELAY_DEPOSITORY;
/**
 * The most a plan may offer over the chain's own eth_gasPrice. The planner offers 1x-1.1x
 * (2026-10-08, every direct chain); a higher price would only burn the wallet's money, or on
 * ZK-stack chains prepay it to the paymaster.
 */
export const MAX_GAS_PRICE_FACTOR = 2n;
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
 * Direct chains whose own bridge is the exit (the API's route 'oft'): a
 * LayerZero v1 native OFT that delivers the chain's token as an ERC-20 on one
 * destination, not gas (owner decision 2026-10-07, like MITO). Pinned here: a
 * plan naming another contract, chain or token is refused.
 */
export const TOKEN_EXITS: Readonly<Record<number, {
  toChainId: number;
  oft: string;
  lzChainId: number;
  /** The only adapterParams accepted: type 1 with the OFT's minimum destination gas (it prices the fee) */
  adapterParams: string;
  /** Amounts round down to a multiple of this (the OFT's shared decimals); the rounding joins the fee */
  dustRate: bigint;
  bridge: string;
  token: { symbol: string; address: string; decimals: number };
}>> = {
  40: {
    toChainId: 8453, oft: '0x02Ea28694Ae65358Be92bAFeF5Cb8C211f33Db1A', lzChainId: 184,
    adapterParams: `0x0001${(200_000).toString(16).padStart(64, '0')}`, dustRate: 10n ** 14n, bridge: "Telos's own bridge",
    token: { symbol: 'TLOS', address: '0x7252c865c05378Ffc15120F428dd65804dD0CE63', decimals: 18 },
  },
};

/**
 * OP-stack chains without EIP-7702 (the API's kind 'opguard'), with the L1 fee formula each one
 * charges. Every transaction there also pays an L1 data fee, so the wallet sweeps in one
 * transaction through ZeroDustGuard, which reverts unless the wallet is at exactly 0 once gas and
 * the L1 fee are taken, and burns the gas left. The page computes the L1 fee exactly from what it
 * signs (l1fee.ts). Pinned here; the page refuses a plan when /direct/chains disagrees, and refuses
 * to sign when the chain's own oracle reports another formula.
 */
export const GUARD_CHAINS: Readonly<Record<number, L1Formula>> = { 81457: 'ecotone', 288: 'fjord' };
/** ZeroDustGuard (zerodust contracts/src/ZeroDustGuard.yul): CREATE2, the same address on every guard chain */
export const ZERODUST_GUARD = '0x2f95e6ED90a7dD67fc3Fae5c5628647E6A83e48e';
/** keccak256 of its runtime code: the page checks the code at the address before signing */
export const ZERODUST_GUARD_CODEHASH = '0x0e00b07c95af7e18d655633d521d110ce6e95ff3c330ff3a4ac2d1b44fed685e';

/** Headroom the page allows on the LayerZero fee it reads itself (the planner adds 10%) */
export const OFT_FEE_MARGIN_PERCENT = 110n;

/** The pinned token exit from `chainId` to `toChainId`, if there is one */
export const tokenExitFor = (chainId: number, toChainId: number) => (TOKEN_EXITS[chainId]?.toChainId === toChainId ? TOKEN_EXITS[chainId] : undefined);

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

export type DirectRoute = 'gaszip' | 'relay' | 'across' | 'transfer' | 'burn' | 'donate' | 'lifi' | 'oft';
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
  /** Token exits: what arrives is this token, not gas (the page uses its own pinned TOKEN_EXITS) */
  receiveToken?: { chainId: number; symbol: string; address: string; decimals: number };
  /** Guard chains: the one transaction through ZeroDustGuard (sweep(target, fee, data)) */
  guard?: GuardPlan;
}

export interface GuardPlan {
  address: string;
  /** What the guard calls with what is left after the fee, and the calldata */
  target: string;
  data: string;
  /** The value the guard forwards to the target, as planned */
  forwarded: string;
  /** The API's L1 fee estimate; the page computes the real one when it signs */
  l1Fee: string;
  /** Where the difference between the two goes: ZeroDust's fee (bridge deposits keep the quoted amount) or the amount forwarded */
  absorb: 'fee' | 'amount';
  l1Formula: L1Formula;
}

export interface DirectChainInfo {
  chainId: number;
  name: string;
  token: string;
  decimals: number;
  explorerUrl: string;
  rpcUrl: string;
  /** The chain's gas rule: evm, arbitrum, etherlink, gaslimit, fixedprice, zk or opguard */
  kind?: string;
  /** Guard chains: the OP-stack L1 fee formula */
  l1Formula?: string;
  txGapBlocks?: number;
  /** The chain announced its shutdown (address/closing.ts) */
  closing?: Closing;
}

export interface DirectBalance {
  chainId: number;
  name: string;
  token: string;
  decimals: number;
  explorerUrl: string;
  balance: string;
  /** false: the chain's RPCs did not answer in time; balance "0" but unknown */
  checked?: boolean;
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
