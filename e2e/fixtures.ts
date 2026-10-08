// An offline ZeroDust API and chain RPCs for the end-to-end tests.
//
// Quote numbers are the SDK's recorded fixtures (zerodust/sdk
// tests/helpers/sweep-api.ts): live GET /quote + POST /authorization
// responses on Base, 2026-09-30, a same-chain transfer and a Relay route to
// Arbitrum. Addresses are the test account's and the deadline is re-based on
// the current time. The SDK verifies every quote before signing, so these
// must stay valid quotes, not shapes.
import type { Page, Route } from '@playwright/test';
import { buildSweepIntentTypedData } from '@zerodust/sdk';
import { encodeFunctionData, keccak256, parseAbi, type Address, type Hex } from 'viem';
import { DIRECT_RPC_URLS, RPC_URLS } from '../src/chains/rpcs';
import { ACROSS, acrossDepositData, addressWord } from '../tests/fixtures/across-direct';

export const API = 'https://api.zerodust.xyz';
const ZERODUST = '0x3732398281d0606aCB7EC1D490dFB0591BE4c4f2';
const ZERO = '0x0000000000000000000000000000000000000000';
const EMPTY_ROUTE = '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470';
const RELAY_DEPOSITORY = '0x4cd00e387622c35bddb9b4c962c136462338bc31';
const RELAY_ROUTE_HASH = '0xaa06bfdcca59d50f8d38c5a0cb67f2741c49ecdf1bf80b495785cb86490c6932';
const RELAY_API = 'https://api.relay.link';
/** The one-time token a Relay-routed quote carries; the page/SDK must send it back to bind a route */
const RELAY_ROUTE_TOKEN = 'c'.repeat(64);
const relayDeposit = (depositor: string) => encodeFunctionData({
  abi: parseAbi(['function depositNative(address depositor, bytes32 id)']),
  args: [depositor as Address, `0x${'d2'.repeat(32)}`],
});

export const BALANCE = 532742721152083939n;
const GAS_PRICE = 6_000_000n;
const AUTH_NONCE = 7;

export const CHAINS = [
  { chainId: 8453, name: 'Base', nativeToken: 'ETH', explorerUrl: 'https://basescan.org', available: true },
  { chainId: 10, name: 'Optimism', nativeToken: 'ETH', explorerUrl: 'https://optimistic.etherscan.io', available: true },
  { chainId: 42161, name: 'Arbitrum', nativeToken: 'ETH', explorerUrl: 'https://arbiscan.io', available: true },
  // No bridge takes Scroll out right now: the owner has to choose burn or donate
  { chainId: 534352, name: 'Scroll', nativeToken: 'ETH', explorerUrl: 'https://scrollscan.com', available: false },
];
/** Chains the test wallet holds a balance on */
export const FUNDED = [8453, 10, 534352];

/** Mitosis (token delivery): its MITO leaves through Hyperlane as MITO on BNB Chain */
export const MITOSIS = 124816;
const MITOSIS_CHAIN = { chainId: MITOSIS, name: 'Mitosis', nativeToken: 'MITO', explorerUrl: 'https://mitoscan.io', available: true };
const HYPERLANE_ROUTER = '0xF6CC9B10c607afB777380bF71F272E4D7037C3A9';
const HYPERLANE_FEE = 16n * 10n ** 15n; // scaled to the shared test balance (0.53)
const TRANSFER_REMOTE = parseAbi(['function transferRemote(uint32 destination, bytes32 recipient, uint256 amount) payable returns (bytes32)']);

/** Endurance (token delivery, own wallet only): ACE leaves through Fusionist's bridge as ACE on BNB Chain */
export const ENDURANCE = 648;
const ENDURANCE_CHAIN = { chainId: ENDURANCE, name: 'Endurance', nativeToken: 'ACE', explorerUrl: 'https://explorer-endurance.fusionist.io', available: true };
const ENDURANCE_BRIDGE = '0xf3310e3f0D46FF5EE7daB69C73452D0ff3979Bed';
const ENDURANCE_FEE = 10n ** 16n; // scaled to the shared test balance (0.53)
const REQUEST_FROM_USER = parseAbi(['function requestFromUser(uint256 nonce_, uint256 amount_) payable']);

/** The API's Endurance -> BNB Chain quote: requestFromUser(next nonce, routed - fee); only for the user's own address */
function enduranceQuote(destination: string) {
  const q = quote(ENDURANCE, 56, destination);
  const routed = BALANCE - BigInt(q.fees.maxTotalFeeWei);
  const callData = encodeFunctionData({ abi: REQUEST_FROM_USER, functionName: 'requestFromUser', args: [1n, routed - ENDURANCE_FEE] });
  const received = ((routed - ENDURANCE_FEE) * 97n) / 100n;
  return {
    ...q,
    estimatedReceive: received.toString(),
    bridge: { name: 'endurance', displayName: 'Endurance Bridge' },
    receiveToken: { symbol: 'ACE', address: '0xc27A719105A987b4c34116223CAE8bd8F4B5def4', decimals: 18 },
    intent: { ...q.intent, callTarget: ENDURANCE_BRIDGE.toLowerCase(), callData, routeHash: keccak256(callData), minReceive: received.toString() },
  };
}

/** The API's Mitosis -> BNB Chain quote: the pinned router, transferRemote(56, user, routed - fee) */
function mitosisQuote(destination: string) {
  const q = quote(MITOSIS, 56, destination);
  const routed = BALANCE - BigInt(q.fees.maxTotalFeeWei);
  const callData = encodeFunctionData({
    abi: TRANSFER_REMOTE,
    functionName: 'transferRemote',
    args: [56, `0x${destination.slice(2).toLowerCase().padStart(64, '0')}`, routed - HYPERLANE_FEE],
  });
  const received = ((routed - HYPERLANE_FEE) * 97n) / 100n;
  return {
    ...q,
    estimatedReceive: received.toString(),
    bridge: { name: 'hyperlane', displayName: 'Hyperlane' },
    receiveToken: { symbol: 'MITO', address: '0x8e1e6BF7E13C400269987B65Ab2b5724b016CaEF', decimals: 18 },
    intent: { ...q.intent, callTarget: HYPERLANE_ROUTER.toLowerCase(), callData, routeHash: keccak256(callData), minReceive: received.toString() },
  };
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

function quote(fromChainId: number, toChainId: number, destination: string) {
  const sameChain = fromChainId === toChainId;
  return {
    quoteId: crypto.randomUUID(),
    version: 3,
    userBalance: BALANCE.toString(),
    estimatedReceive: sameChain ? '532554719945600107' : '529832916922592715',
    mode: sameChain ? 0 : 1,
    fees: {
      overheadGasUnits: sameChain ? '110000' : '200000',
      protocolFeeGasUnits: '0',
      extraFeeWei: sameChain ? '186741206483832' : '186751530448240',
      reimbGasPriceCapWei: '7200000',
      maxTotalFeeWei: sameChain ? '188001206483832' : '188661272848240',
      revokeGasUnits: '50000',
    },
    autoRevoke: true,
    ...(sameChain ? {} : {
      // What the contract routes: the balance less the reserve (the SDK recomputes and compares it)
      bridge: { name: 'relay', displayName: 'Relay', inputAmount: (BALANCE - 188661272848240n).toString(), expectedOutput: '546220532909889397' },
      relayRouteToken: RELAY_ROUTE_TOKEN,
    }),
    intent: {
      mode: sameChain ? 0 : 1,
      destination: destination.toLowerCase(),
      destinationChainId: String(toChainId),
      callTarget: sameChain ? ZERO : RELAY_DEPOSITORY,
      routeHash: sameChain ? EMPTY_ROUTE : RELAY_ROUTE_HASH,
      minReceive: sameChain ? '532554719945600107' : '503341271076463079',
    },
    deadline: nowSeconds() + 55,
    nonce: 0,
    authNonce: AUTH_NONCE,
    validForSeconds: 55,
  };
}

function authorization(q: Pick<ReturnType<typeof quote>, 'mode' | 'intent' | 'fees' | 'deadline' | 'nonce'>, fromChainId: number, user: Address) {
  return {
    sweepType: q.mode === 0 ? 'same-chain' : 'cross-chain',
    typedData: buildSweepIntentTypedData(fromChainId, user, {
      mode: q.intent.mode,
      user,
      destination: q.intent.destination as Address,
      destinationChainId: BigInt(q.intent.destinationChainId),
      callTarget: q.intent.callTarget as Address,
      routeHash: q.intent.routeHash as Hex,
      minReceive: BigInt(q.intent.minReceive),
      maxTotalFeeWei: BigInt(q.fees.maxTotalFeeWei),
      overheadGasUnits: BigInt(q.fees.overheadGasUnits),
      protocolFeeGasUnits: BigInt(q.fees.protocolFeeGasUnits),
      extraFeeWei: BigInt(q.fees.extraFeeWei),
      reimbGasPriceCapWei: BigInt(q.fees.reimbGasPriceCapWei),
      deadline: BigInt(q.deadline),
      nonce: BigInt(q.nonce),
    }),
    contractAddress: ZERODUST,
    version: 3,
  };
}

const json = (route: Route, data: unknown, status = 200) =>
  route.fulfill({
    status,
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
  });

/** A direct chain (Avalanche) holding AVAX_BALANCE when `direct` is on */
export const AVAX = 43114;
export const AVAX_BALANCE = 10n ** 17n;
const AVAX_PRICE = 27_500_000_000n;
const ZERODUST_SPONSOR = '0x01eD5c94DE39E73C986b98B85C2c0A3d1BEDff7D';
const GASZIP_DEPOSIT = '0x391E7C679d29bD940d63be94AD22A25d25b5A604';

/** The API's plan for Avalanche to self: fee, then a Gas.zip deposit (0x01 + Base's short), exact */
function avaxPlan(nonce: number) {
  const fee = 2n * 10n ** 15n;
  const depositGas = 21_036n; // 21,000 + 16 x 2 non-zero bytes + 4 x 1 zero byte (pre-Prague)
  const value = AVAX_BALANCE - fee - 21_000n * AVAX_PRICE - depositGas * AVAX_PRICE;
  return {
    chainId: AVAX, route: 'gaszip', requestId: null, receive: '700000000000000', fee: fee.toString(), balance: AVAX_BALANCE.toString(),
    txs: [
      { kind: 'fee', to: ZERODUST_SPONSOR, data: '0x', value: fee.toString(), gas: '21000', gasPrice: AVAX_PRICE.toString(), nonce },
      { kind: 'sweep', to: GASZIP_DEPOSIT, data: '0x010036', value: value.toString(), gas: depositGas.toString(), gasPrice: AVAX_PRICE.toString(), nonce: nonce + 1 },
    ],
  };
}

/** A gas-limit direct chain (Monad) holding MONAD_BALANCE when `monad` is on, swept through Across */
export const MONAD = 143;
export const MONAD_BALANCE = 63n * 10n ** 18n;
const MONAD_PRICE = 112_200_000_000n;

/**
 * The API's plan for Monad to Base: fee, then an Across swapAndBridge whose
 * limit is above what the fork uses (Monad charges the whole limit), exact.
 * The quote timestamp is as Across sets it: 3,570 s ago (30 s to live).
 */
function monadPlan(nonce: number, recipient: string, tamper: boolean) {
  const fee = 10n ** 18n;
  const gas = 200_000n;
  const value = MONAD_BALANCE - fee - 21_000n * MONAD_PRICE - gas * MONAD_PRICE;
  // A compromised API: the deposit's fallback and drains pay an attacker
  const payTo = tamper ? `0x${'ba'.repeat(20)}` : recipient;
  const data = acrossDepositData({ from: recipient, recipient: payTo, value, quoteTimestamp: nowSeconds() - 3570 });
  return {
    chainId: MONAD, route: 'across', requestId: null, receive: '714787782428686', quoted: '736894621060501', fee: fee.toString(), balance: MONAD_BALANCE.toString(),
    txGapBlocks: 4,
    txs: [
      { kind: 'fee', to: ZERODUST_SPONSOR, data: '0x', value: fee.toString(), gas: '21000', gasPrice: MONAD_PRICE.toString(), nonce },
      { kind: 'sweep', to: ACROSS.periphery, data, value: value.toString(), gas: gas.toString(), gasPrice: MONAD_PRICE.toString(), nonce: nonce + 1 },
    ],
  };
}

/** Telos (direct, fixed price) holding TELOS_BALANCE when `telos` is on: its only exit is its own TLOS bridge to Base */
export const TELOS = 40;
export const TELOS_BALANCE = 60n * 10n ** 18n;
const TELOS_OFT = '0x02Ea28694Ae65358Be92bAFeF5Cb8C211f33Db1A';
const TELOS_FEE = 10n ** 18n;
const TELOS_SEND_GAS = 520_000n;
const TELOS_AFTER_FEE = TELOS_BALANCE - TELOS_FEE - 21_000n * GAS_PRICE;
const TELOS_SEND_VALUE = TELOS_AFTER_FEE - TELOS_SEND_GAS * GAS_PRICE - 42_000n * GAS_PRICE;
/** What the bridge send leaves (its whole gas reserve, in this mock) */
const TELOS_LEFTOVER = TELOS_AFTER_FEE - TELOS_SEND_VALUE;
export const TELOS_BRIDGED = ((TELOS_SEND_VALUE - 35n * 10n ** 17n) / 10n ** 14n) * 10n ** 14n;
const OFT_SEND = parseAbi(['function sendFrom(address from, uint16 dstChainId, bytes32 toAddress, uint256 amount, (address refundAddress, address zroPaymentAddress, bytes adapterParams) callParams) payable']);

/** The API's Telos exit to Base: fee, then sendFrom on Telos's own bridge; the leftover follows as a donation */
function telosExitPlan(nonce: number, from: string, recipient: string) {
  const data = encodeFunctionData({
    abi: OFT_SEND, functionName: 'sendFrom',
    args: [from as Address, 184, `0x${recipient.slice(2).toLowerCase().padStart(64, '0')}`, TELOS_BRIDGED, { refundAddress: ZERODUST_SPONSOR, zroPaymentAddress: ZERO, adapterParams: `0x0001${(200_000).toString(16).padStart(64, '0')}` }],
  });
  return {
    chainId: TELOS, route: 'oft', requestId: null, receive: TELOS_BRIDGED.toString(), quoted: TELOS_BRIDGED.toString(), fee: TELOS_FEE.toString(), balance: TELOS_BALANCE.toString(),
    leftoverMax: ((TELOS_LEFTOVER * 101n) / 100n).toString(), tool: 'TLOS bridge (LayerZero)',
    receiveToken: { chainId: 8453, symbol: 'TLOS', address: '0x7252c865c05378Ffc15120F428dd65804dD0CE63', decimals: 18 },
    txs: [
      { kind: 'fee', to: ZERODUST_SPONSOR, data: '0x', value: TELOS_FEE.toString(), gas: '21000', gasPrice: GAS_PRICE.toString(), nonce },
      { kind: 'sweep', to: TELOS_OFT, data, value: TELOS_SEND_VALUE.toString(), gas: TELOS_SEND_GAS.toString(), gasPrice: GAS_PRICE.toString(), nonce: nonce + 1 },
    ],
  };
}

/** The leftover after the bridge send, donated to ZeroDust exactly */
function telosLeftoverPlan(nonce: number) {
  return {
    chainId: TELOS, route: 'donate', requestId: null, receive: '0', fee: '0', balance: TELOS_LEFTOVER.toString(),
    txs: [{ kind: 'sweep', to: ZERODUST_SPONSOR, data: '0x', value: (TELOS_LEFTOVER - 21_000n * GAS_PRICE).toString(), gas: '21000', gasPrice: GAS_PRICE.toString(), nonce }],
  };
}

/** Everything the page may call, answered offline; returns what was swept */
/**
 * `onlyTo`: the direct chain's bridges reach only this chain; any other answers
 * "unknown" (as Gas.zip's "Please Try Again" does for Lens to Base);
 * `hiccups`: the first route checks answer "unknown", then the real answer
 */
export async function mockNetwork(page: Page, user: Address, opts: { direct?: boolean; monad?: boolean; tamper?: boolean; onlyTo?: number; hiccups?: number; mitosis?: boolean; endurance?: boolean; telos?: boolean; tooSmall?: 'direct' | 'check' | 'sweep'; paused?: boolean; timings?: unknown } = {}) {
  const chains = [...CHAINS, ...(opts.mitosis ? [MITOSIS_CHAIN] : []), ...(opts.endurance ? [ENDURANCE_CHAIN] : [])];
  const funded = [...FUNDED, ...(opts.mitosis ? [MITOSIS] : []), ...(opts.endurance ? [ENDURANCE] : [])];
  let hiccups = opts.hiccups ?? 0;
  /** The funded direct chain, if any */
  const DIRECT = opts.telos ? TELOS : opts.monad ? MONAD : AVAX;
  const DIRECT_BALANCE = opts.telos ? TELOS_BALANCE : opts.monad ? MONAD_BALANCE : AVAX_BALANCE;
  const directInfo = opts.telos
    ? { chainId: TELOS, name: 'Telos', token: 'TLOS', decimals: 18, explorerUrl: 'https://teloscan.io' }
    : opts.monad
      ? { chainId: MONAD, name: 'Monad', token: 'MON', decimals: 18, explorerUrl: 'https://monadvision.com' }
      : { chainId: AVAX, name: 'Avalanche', token: 'AVAX', decimals: 18, explorerUrl: 'https://snowtrace.io' };
  /** Telos: transactions sent so far (fee, bridge send, leftover) */
  let telosSent = 0;
  /** Stored quotes: Relay ones carry inputAmount and a route token; token-delivery ones a simpler bridge */
  type StoredQuote = Omit<ReturnType<typeof quote>, 'bridge' | 'relayRouteToken'> & {
    bridge?: { name: string; displayName: string; inputAmount?: string; expectedOutput?: string };
    relayRouteToken?: string;
    from: number;
    to: number;
  };
  const quotes = new Map<string, StoredQuote>();
  const swept = new Set<number>();
  const sweeps = new Map<string, { fromChainId: number; toChainId: number }>();
  let mitosisQuotes = 0;
  /** POST /reports bodies, in order */
  const reports: Array<Record<string, unknown>> = [];
  /** GET /quote requests, in order */
  const quoted: Array<{ from: number; to: number; destination: string }> = [];

  await page.route(`${API}/**`, async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === '/chains') {
      return json(route, { chains: chains.map((c) => ({ ...c, nativeTokenDecimals: 18, minBalance: '0', contractAddress: ZERODUST, enabled: true, crossChain: { available: c.available } })) });
    }
    if (path === `/balances/${user}` || path.toLowerCase() === `/balances/${user.toLowerCase()}`) {
      return json(route, {
        address: user,
        chains: chains.map((c) => ({
          chainId: c.chainId, name: c.name, nativeToken: c.nativeToken,
          balance: funded.includes(c.chainId) && !swept.has(c.chainId) ? BALANCE.toString() : '0',
          balanceFormatted: '', canSweep: funded.includes(c.chainId) && !swept.has(c.chainId), minBalance: '0',
        })),
      });
    }
    if (path === '/destinations') {
      const from = Number(url.searchParams.get('fromChainId'));
      if (from === ENDURANCE) {
        return json(route, { fromChainId: from, destinations: [{ chainId: 56, name: 'BNB Chain', nativeSymbol: 'BNB', nativeDecimals: 18, bridges: ['endurance'], zerodustChain: true }] });
      }
      if (from === MITOSIS) {
        return json(route, { fromChainId: from, destinations: [{ chainId: 56, name: 'BNB Chain', nativeSymbol: 'BNB', nativeDecimals: 18, bridges: ['hyperlane'], zerodustChain: true }] });
      }
      return json(route, { fromChainId: from, destinations: CHAINS.filter((c) => c.chainId !== from).map((c) => ({ chainId: c.chainId, name: c.name, nativeSymbol: 'ETH', nativeDecimals: 18, bridges: ['relay'], zerodustChain: true })) });
    }
    if (path === '/bridges/timing') return json(route, opts.timings ?? { routes: {}, pairs: {} });
    if (path === '/prices') return json(route, { prices: { ETH: 2697.86, MITO: 0.0158, ACE: 0.18 } });
    if (path === '/direct/chains') {
      return json(route, {
        chains: [
          { chainId: AVAX, name: 'Avalanche', token: 'AVAX', decimals: 18, explorerUrl: 'https://snowtrace.io', rpcUrl: DIRECT_RPC_URLS[AVAX], kind: 'evm' },
          { chainId: MONAD, name: 'Monad', token: 'MON', decimals: 18, explorerUrl: 'https://monadvision.com', rpcUrl: DIRECT_RPC_URLS[MONAD], kind: 'gaslimit', txGapBlocks: 4 },
          { chainId: TELOS, name: 'Telos', token: 'TLOS', decimals: 18, explorerUrl: 'https://teloscan.io', rpcUrl: DIRECT_RPC_URLS[TELOS], kind: 'fixedprice' },
        ],
        prices: { AVAX: 25, MON: 0.034, TLOS: 0.0192 },
      });
    }
    if (path.startsWith('/direct/balances/')) {
      return json(route, opts.direct || opts.monad || opts.telos ? [{ ...directInfo, balance: (swept.has(DIRECT) ? 0n : DIRECT_BALANCE).toString() }] : []);
    }
    if (path === '/direct/route') {
      const to = Number(url.searchParams.get('toChainId'));
      // Telos: no gas bridge; its own bridge delivers TLOS as a token on Base
      if (opts.telos) return json(route, to === 8453 ? { available: false, exit: true, reason: 'No gas bridge takes TLOS out; its own bridge delivers TLOS as a token' } : { available: false, exit: false, reason: 'Gas.zip: Quote: Please Try Again' });
      // A bridge's passing hiccup: the first answers are "unknown"
      if (hiccups > 0) {
        hiccups -= 1;
        return json(route, { available: null, reason: 'Relay: 429' });
      }
      // Below every bridge's minimum: the API names the balance that would go through
      if (opts.tooSmall === 'direct') {
        return json(route, { available: false, reason: 'The balance is too small to bridge from Monad: it needs at least 64.2 MON. Add funds to sweep it.', minimumBalanceWei: (642n * 10n ** 17n).toString() });
      }
      return json(route, opts.onlyTo === undefined || opts.onlyTo === to ? { available: true } : { available: null, reason: 'Gas.zip: Quote: Please Try Again' });
    }
    if (path === '/direct/prepare' && opts.monad) return json(route, monadPlan(directNonce, url.searchParams.get('recipient')!, !!opts.tamper));
    if (path === '/direct/exit' && opts.telos) return json(route, telosExitPlan(directNonce, url.searchParams.get('from')!, url.searchParams.get('recipient')!));
    if (path === '/direct/prepare' && opts.telos) return json(route, telosLeftoverPlan(directNonce));
    if (path === '/direct/prepare') {
      const plan = avaxPlan(directNonce);
      // A compromised API: the same amounts, but the deposit credits an attacker on Base
      if (opts.tamper) plan.txs[1]!.data = `0x02${'ba'.repeat(20)}0036`;
      return json(route, plan);
    }
    if (path === '/status') {
      return json(route, opts.paused
        ? { sponsoredSweeps: 'paused', directChains: 'paused', message: 'ZeroDust is paused: it cannot sign sweeps right now. No funds are at risk and nothing needs doing; sweeps resume automatically. Please come back shortly.' }
        : { sponsoredSweeps: 'available', directChains: 'available', message: null });
    }
    if (path === '/reports' && route.request().method() === 'POST') {
      reports.push(route.request().postDataJSON() as Record<string, unknown>);
      return json(route, { reference: `ZD-${(0x1a2b3c00 + reports.length).toString(16).toUpperCase()}` });
    }
    if (path === '/direct/status') return json(route, { state: 'delivered', destTx: `0x${'cd'.repeat(32)}` });
    if (path === '/quote') {
      const p = url.searchParams;
      const from = Number(p.get('fromChainId'));
      // Mitosis below Hyperlane's fee: refused at the check, or only once the sweep requotes
      mitosisQuotes += from === MITOSIS ? 1 : 0;
      if (from === MITOSIS && (opts.tooSmall === 'check' || (opts.tooSmall === 'sweep' && mitosisQuotes > 1))) {
        return json(route, {
          error: 'The balance is too small to bridge from Mitosis to BNB Chain: it needs at least 17.94 MITO. Add funds to sweep it, or sweep it on Mitosis.',
          code: 'AMOUNT_TOO_LOW', minimumBalanceWei: '17940000000000000000',
        }, 400);
      }
      const to = Number(p.get('toChainId'));
      quoted.push({ from, to, destination: p.get('destination')! });
      const q = from === MITOSIS ? mitosisQuote(p.get('destination')!) : from === ENDURANCE ? enduranceQuote(p.get('destination')!) : quote(from, to, p.get('destination')!);
      quotes.set(q.quoteId, { ...q, from, to });
      return json(route, q);
    }
    // A Relay deposit the page/SDK fetched from Relay itself: stored as the quote's route
    if (path.startsWith('/quote/') && path.endsWith('/relay-route')) {
      const quoteId = path.split('/')[2]!;
      const body = route.request().postDataJSON() as { callTarget: string; callData: Hex; routeToken?: string };
      const q = quotes.get(quoteId)!;
      if (body.routeToken !== RELAY_ROUTE_TOKEN) return json(route, { error: 'routeToken does not match this quote', code: 'INVALID_ROUTE_TOKEN' }, 400);
      q.intent = { ...q.intent, callTarget: body.callTarget.toLowerCase(), routeHash: keccak256(body.callData), callData: body.callData } as typeof q.intent;
      return json(route, { quoteId, intent: q.intent });
    }
    if (path === '/authorization') {
      const { quoteId } = route.request().postDataJSON() as { quoteId: string };
      const q = quotes.get(quoteId)!;
      return json(route, authorization(q, q.from, user));
    }
    if (path === '/sweep' && route.request().method() === 'POST') {
      const { quoteId } = route.request().postDataJSON() as { quoteId: string };
      const { from, to } = quotes.get(quoteId)!;
      const sweepId = crypto.randomUUID();
      sweeps.set(sweepId, { fromChainId: from, toChainId: to });
      swept.add(from);
      return json(route, { sweepId, status: 'pending', sweepType: from === to ? 'same-chain' : 'cross-chain' });
    }
    if (path.startsWith('/sweep/')) {
      const sweepId = path.split('/')[2]!;
      const s = sweeps.get(sweepId)!;
      return json(route, {
        sweepId, status: 'completed', sweepType: s.fromChainId === s.toChainId ? 'same-chain' : 'cross-chain', mode: 0,
        txHash: `0x${'ab'.repeat(32)}`, destination: user, fromChainId: s.fromChainId, toChainId: s.toChainId,
        version: 3, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), revokeStatus: 'confirmed',
      });
    }
    return json(route, { error: `unmocked ${path}` }, 404);
  });

  // The public RPCs: balance and nonce as the quotes expect; 0 once swept.
  // Direct chain (Avalanche): the page also replays on a fork and broadcasts here.
  let directNonce = 4;
  let head = 1000;
  const sent: string[] = [];
  const rpcChains = new Map([...Object.entries(RPC_URLS), ...Object.entries(DIRECT_RPC_URLS)].map(([id, url]) => [new URL(url).origin, Number(id)]));
  await page.route((url) => rpcChains.has(url.origin), async (route) => {
    const chainId = rpcChains.get(new URL(route.request().url()).origin)!;
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' } });
    const body = route.request().postDataJSON() as { id: number; method: string; params?: unknown[] } | Array<{ id: number; method: string; params?: unknown[] }>;
    const answer = (r: { id: number; method: string; params?: unknown[] }) => {
      const isUser = String(r.params?.[0] ?? '').toLowerCase() === user.toLowerCase();
      const direct = chainId === AVAX || chainId === MONAD || chainId === TELOS;
      // Telos: the full balance, then after the fee and the bridge send only the leftover
      const telosBalance = telosSent < 2 ? TELOS_BALANCE : telosSent === 2 ? TELOS_LEFTOVER : 0n;
      const balance = direct
        ? (isUser && chainId === DIRECT && (opts.direct || opts.monad || opts.telos) && !swept.has(DIRECT) ? (opts.telos ? telosBalance : DIRECT_BALANCE) : 0n)
        : (funded.includes(chainId) && !swept.has(chainId) ? BALANCE : 0n);
      if (r.method === 'eth_sendRawTransaction' && opts.telos) {
        sent.push(String(r.params![0]));
        directNonce += 1;
        telosSent += 1;
        if (telosSent === 3) swept.add(TELOS);
        return { jsonrpc: '2.0', id: r.id, result: `0x${sent.length.toString(16).padStart(64, '0')}` };
      }
      if (r.method === 'eth_sendRawTransaction') {
        sent.push(String(r.params![0]));
        directNonce += 1;
        // The sweep is the second transaction: after it the wallet is empty
        if (sent.length === 2) swept.add(DIRECT);
        return { jsonrpc: '2.0', id: r.id, result: `0x${sent.length.toString(16).padStart(64, '0')}` };
      }
      if (r.method === 'eth_blockNumber') {
        head += 1;
        return { jsonrpc: '2.0', id: r.id, result: `0x${head.toString(16)}` };
      }
      // 0x's Settler registry on a destination (Across routes): ownerOf(2) is the fixture's Settler
      if (r.method === 'eth_call') {
        const data = String((r.params?.[0] as { data?: string } | undefined)?.data ?? '');
        // Telos's bridge: LayerZero's fee (3.2 TLOS) for estimateSendFee
        if (data.startsWith('0x365260b4')) return { jsonrpc: '2.0', id: r.id, result: `0x${(32n * 10n ** 17n).toString(16).padStart(64, '0')}${'0'.repeat(64)}` };
        return { jsonrpc: '2.0', id: r.id, result: addressWord(data.startsWith('0x6352211e') ? ACROSS.settler : ZERO) };
      }
      const result = {
        eth_chainId: `0x${chainId.toString(16)}`,
        eth_getBalance: `0x${(direct ? balance : isUser || !r.params ? balance : 0n).toString(16)}`,
        eth_getTransactionCount: direct ? `0x${(isUser ? directNonce : 0).toString(16)}` : `0x${AUTH_NONCE.toString(16)}`,
        // Each chain's own price: the page refuses a plan priced over twice it
        eth_gasPrice: `0x${(chainId === 43114 ? AVAX_PRICE : chainId === 143 ? MONAD_PRICE : GAS_PRICE).toString(16)}`,
        eth_getCode: '0x',
        eth_getStorageAt: `0x${'0'.repeat(64)}`,
        eth_getBlockByNumber: { number: '0x3e8', timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}`, gasLimit: '0x1c9c380' },
        eth_getTransactionReceipt: { status: '0x1', blockNumber: `0x${head.toString(16)}` },
      }[r.method];
      return result === undefined ? { jsonrpc: '2.0', id: r.id, error: { code: -32601, message: `unmocked ${r.method}` } } : { jsonrpc: '2.0', id: r.id, result };
    };
    return json(route, Array.isArray(body) ? body.map(answer) : answer(body));
  });

  // Relay's API: the deposit the page/SDK asks for itself, paying the recipient it asked for
  await page.route(`${RELAY_API}/quote`, async (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' } });
    const b = route.request().postDataJSON() as { user: string; recipient: string; amount: string; originChainId: number; destinationChainId: number };
    return json(route, {
      steps: [{ kind: 'transaction', requestId: `0x${'17'.repeat(32)}`, items: [{ data: { to: RELAY_DEPOSITORY, data: relayDeposit(b.user), value: b.amount, chainId: b.originChainId } }] }],
      details: { recipient: b.recipient, currencyOut: { amount: '546220532909889397', currency: { address: ZERO, chainId: b.destinationChainId } } },
    });
  });

  // Nothing else may be contacted
  await page.route((url) => url.protocol !== 'file:' && url.protocol !== 'data:' && !url.origin.startsWith('http://localhost') && url.origin !== API && url.origin !== RELAY_API && !rpcChains.has(url.origin), (route) =>
    route.abort('blockedbyclient')
  );

  return { swept, sent, reports, quoted };
}
