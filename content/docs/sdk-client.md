# API client

`ZeroDust` is a thin client for the [REST API](/docs/api): one method per endpoint, input validation, timeouts and retries. It does not sign anything.

```ts
import { ZeroDust } from '@zerodust/sdk';

const zerodust = new ZeroDust({ environment: 'mainnet' });
```

Options are on the [SDK overview](/docs/sdk). All amounts are strings in wei.

## Chains

### getChains(testnet?)

`GET /chains`. Returns `Chain[]`: `chainId`, `name`, `nativeToken`, `nativeTokenDecimals`, `minBalance`, `contractAddress`, `explorerUrl`, `enabled`. The result is cached in the client for one minute.

```ts
const chains = await zerodust.getChains();
```

`testnet` defaults to `false`. The API currently serves no testnet chains.

### getChain(chainId)

`GET /chains/:chainId`. Returns one `Chain`. An unknown chain ID throws `NOT_FOUND`.

### getDestinations(fromChainId)

`GET /destinations`. Returns `Destination[]`: every chain a cross-chain sweep from `fromChainId` can deliver native gas to, sorted by name. Each has `chainId`, `name`, `nativeSymbol`, `nativeDecimals`, `bridges` and `zerodustChain` (whether it is also a ZeroDust source chain). This is what bridges advertise; `getQuote()` confirms a route live.

```ts
const destinations = await zerodust.getDestinations(42161);
const hyperEvm = destinations.find((d) => d.chainId === 999); // receives HYPE
```

## Balances

### getBalances(address, testnet?)

`GET /balances/:address`. Returns `{ address, chains: ChainBalance[] }` for every enabled chain. `ChainBalance` has `chainId`, `name`, `nativeToken`, `balance`, `balanceFormatted`, `canSweep` and `minBalance`.

`canSweep` is `true` for any balance above 0. There is no fixed minimum: the quote decides whether the balance covers the fees.

### getBalance(address, chainId)

`GET /balances/:address/:chainId`. Returns one `ChainBalance`.

## Quotes

### getQuote(params)

`GET /quote`. `QuoteRequest` has `fromChainId`, `toChainId`, `userAddress` (the wallet to empty) and `destination`.

```ts
const quote = await zerodust.getQuote({
  fromChainId: 42161,
  toChainId: 8453,
  userAddress: '0xWallet',
  destination: '0xDestination',
});
```

`QuoteResponse` fields: `quoteId`, `version`, `userBalance`, `estimatedReceive`, `mode` (0 transfer, 1 bridge call), `fees` (`overheadGasUnits`, `protocolFeeGasUnits`, `extraFeeWei`, `reimbGasPriceCapWei`, `maxTotalFeeWei`, `revokeGasUnits`), `autoRevoke`, `intent` (`mode`, `destination`, `destinationChainId`, `callTarget`, `routeHash`, `minReceive`, and `callData` for cross-chain), `deadline`, `nonce`, `authNonce` and `validForSeconds`.

A quote is valid for 55 seconds. The API also returns a `bridge` object for cross-chain quotes (see [REST API](/docs/api)); it is not part of the `QuoteResponse` type.

### createAuthorization(quoteId)

`POST /authorization`. Returns `AuthorizationResponse`: `sweepType` (`'same-chain'` or `'cross-chain'`), `typedData` (the API's EIP-712 `SweepIntent`), `contractAddress` and `version`.

Do not sign this typed data as received. Build your own with `verifySweepQuote()` and compare with `assertAuthorizationMatches()`, as shown below.

## Sweeps

### submitSweep(request)

`POST /sweep`. `SweepRequest`:

| Field | Notes |
|---|---|
| `quoteId` | From `getQuote()` |
| `signature` | EIP-712 signature of the `SweepIntent` |
| `eip7702Authorization` | `EIP7702Authorization` delegating to the ZeroDust contract on the source chain |
| `revokeAuthorization` | Optional `EIP7702Authorization` delegating to address 0 with nonce + 1. Without it the wallet stays delegated after the sweep. |

`EIP7702Authorization` is `{ chainId, contractAddress, nonce, yParity, r, s }`.

Returns `SweepResponse`: `sweepId`, `status`, `sweepType`, `isExisting` and `version`. Submitting the same `quoteId` again returns the existing sweep with `isExisting: true`.

### getSweepStatus(sweepId)

`GET /sweep/:sweepId`. Returns `SweepStatusResponse`:

| Field | Notes |
|---|---|
| `status` | `pending`, `simulating`, `executing`, `broadcasted`, `bridging`, `completed` or `failed` |
| `sweepType`, `mode` | |
| `txHash` | Sweep transaction on the source chain |
| `destinationTxHash` | Delivery transaction, cross-chain |
| `amountSent` | Wei |
| `destination`, `fromChainId`, `toChainId` | |
| `errorMessage` | When failed |
| `bridgeTrackingUrl` | Cross-chain, once there is a transaction |
| `revokeStatus` | `not_requested`, `pending`, `executing`, `completed` or `failed` |
| `revokeTxHash`, `revokeError` | |
| `createdAt`, `updatedAt`, `version` | |

### waitForSweep(sweepId, options?)

Polls `getSweepStatus()` until `completed` or `failed` and returns the final status.

| Option | Default |
|---|---|
| `intervalMs` | `2000` |
| `timeoutMs` | `120000` (then throws `TimeoutError`) |
| `onStatusChange` | Called each time the status changes |

Status reads are limited to 200 per minute per IP. A 429 is retried after `Retry-After`, and `waitForSweep()` keeps polling through retryable errors until `timeoutMs`.

### getSweeps(address, options?)

`GET /sweeps/:address`. Options: `limit` (1 to 100, API default 20), `offset`, `status`. Returns `{ sweeps: SweepSummary[], total }`, newest first. `SweepSummary` has `sweepId`, `status`, `sweepType`, `mode`, `fromChainId`, `toChainId`, `amountSent`, `txHash`, `version` and `createdAt`.

## Signing yourself

`ZeroDustAgent` does all of this for you. If you sign somewhere else, run the same checks the agent runs. This example sweeps Base to another address on Base with viem.

```ts
import {
  ZeroDust,
  ZERODUST_CONTRACT_ADDRESS,
  ZERO_ADDRESS,
  verifySweepQuote,
  assertAuthorizationMatches,
  createGasZipChainShortResolver,
  type EIP7702Authorization,
} from '@zerodust/sdk';
import { createPublicClient, createWalletClient, http, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

const account = privateKeyToAccount(process.env.ZERODUST_PRIVATE_KEY as `0x${string}`);
const destination: Address = '0xYourDestination';
const chainId = base.id;

const zerodust = new ZeroDust({ environment: 'mainnet' });
const publicClient = createPublicClient({ chain: base, transport: http() });
const walletClient = createWalletClient({ account, chain: base, transport: http() });

// 1. Quote
const quote = await zerodust.getQuote({
  fromChainId: chainId,
  toChainId: chainId,
  userAddress: account.address,
  destination,
});

// 2. Verify it against your request and your own RPC, and build the typed data.
//    Throws ZeroDustError('UNSAFE_QUOTE') on any mismatch.
const { typedData } = await verifySweepQuote(quote, {
  signer: account.address,
  fromChainId: chainId,
  toChainId: chainId,
  destination,
  balanceWei: await publicClient.getBalance({ address: account.address }),
  gasPriceWei: await publicClient.getGasPrice(),
  nowSeconds: Math.floor(Date.now() / 1000),
  resolveGasZipChainShort: createGasZipChainShortResolver(),
});

// 3. The API's typed data must describe the same intent. It is compared, never signed.
assertAuthorizationMatches(await zerodust.createAuthorization(quote.quoteId), typedData);

// 4. Sign the intent you built
const signature = await walletClient.signTypedData({
  domain: typedData.domain,
  types: typedData.types,
  primaryType: typedData.primaryType,
  message: { ...typedData.message },
});

// 5. Delegate to the ZeroDust contract, then sign the revoke (nonce + 1)
const delegation = await walletClient.signAuthorization({ contractAddress: ZERODUST_CONTRACT_ADDRESS });
if (Number(delegation.nonce) !== quote.authNonce) throw new Error('Nonce changed: get a new quote');
const revoke = await walletClient.signAuthorization({
  contractAddress: ZERO_ADDRESS,
  nonce: Number(delegation.nonce) + 1,
});

const toZeroDust = (a: typeof delegation, contractAddress: Address): EIP7702Authorization => ({
  chainId: a.chainId,
  contractAddress,
  nonce: Number(a.nonce),
  yParity: (a.yParity ?? 0) as 0 | 1,
  r: a.r,
  s: a.s,
});

// 6. Submit and wait
const sweep = await zerodust.submitSweep({
  quoteId: quote.quoteId,
  signature,
  eip7702Authorization: toZeroDust(delegation, ZERODUST_CONTRACT_ADDRESS),
  revokeAuthorization: toZeroDust(revoke, ZERO_ADDRESS),
});
const final = await zerodust.waitForSweep(sweep.sweepId);
console.log(final.status, final.txHash);
```

Notes:

- The quote's deadline is under a minute away, so sign and submit promptly. If the deadline passes, get a new quote.
- For cross-chain sweeps pass the requested `toChainId`. `verifySweepQuote` needs `resolveGasZipChainShort` to verify Gas.zip routes and accepts `requireVerifiedRoute: true` (see [Agent](/docs/sdk-agent)).
- `verifySweepQuote` returns `route.bridge` (`'gaszip'`, `'relay'`, `'across'` or `null` for same-chain) and `route.recipientVerified`.
