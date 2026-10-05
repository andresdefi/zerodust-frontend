# SDK overview

`@zerodust/sdk` is the TypeScript SDK for ZeroDust. The current version is 0.5.4 (MIT licensed, source at [github.com/andresdefi/zerodust](https://github.com/andresdefi/zerodust/tree/main/sdk)).

## Install

```bash
npm install @zerodust/sdk viem
```

- `viem` `^2.0.0` is a peer dependency.
- Node.js 18 or later.
- The package ships ESM and CommonJS builds with type definitions.

## Two classes

| Class | What it does | Page |
|---|---|---|
| `ZeroDustAgent` | Holds a viem `LocalAccount` and runs the whole sweep: quote, local checks, three signatures, submit, wait. Supports dry runs and multi-chain batches. | [Agent](/docs/sdk-agent) |
| `ZeroDust` | A thin client with one method per API call. It does not sign. Use it to read balances and quotes, or to build your own signing flow. | [API client](/docs/sdk-client) |

Use `ZeroDustAgent` unless you need to sign somewhere the agent cannot run. It is the only path that applies every pre-signing check for you.

## Configuration

Both classes accept the same options (`ZeroDustConfig`). `ZeroDustAgent` adds `account`, `rpcUrls` and `requireVerifiedRoute`.

```ts
import { ZeroDust } from '@zerodust/sdk';

const zerodust = new ZeroDust({
  environment: 'mainnet',
  timeout: 30000,
  retries: 3,
});
```

| Option | Type | Default | Notes |
|---|---|---|---|
| `environment` | `'mainnet' \| 'testnet'` | `'testnet'` | Both values currently point at `https://api.zerodust.xyz`, which serves mainnet chains only. Pass `'mainnet'` so your code states what it does. |
| `baseUrl` | `string` | from `environment` | Overrides the API URL. |
| `apiKey` | `string` | none | Sent as the `X-API-Key` header. Gives the SDK's routes their own rate limit instead of your IP's; see [API keys](/docs/api#api-keys). |
| `timeout` | `number` (ms) | `30000` | Per request. A timed-out request is not retried. |
| `retries` | `number` | `3` | Retries after a network failure, a 429, or a 502/503/504 on a GET, with exponential backoff (1 s, 2 s, 4 s, capped at 10 s) or the 429's `Retry-After` (at most 30 s). Other HTTP errors are not retried. |

## Where it runs

The SDK works in Node.js. The API only allows browser requests from the ZeroDust site itself (CORS), so a browser page on another origin cannot read its responses. Run the SDK on a server, in a script or in an agent process.

## Exports

Classes and factories:

- `ZeroDust`, `ZeroDustAgent`, `createAgentFromPrivateKey`

Errors (see [Errors](/docs/sdk-errors)):

- `ZeroDustError`, `BalanceTooLowError`, `QuoteExpiredError`, `NetworkError`, `TimeoutError`, `ChainNotSupportedError`, `InvalidAddressError`, `SignatureError`, `BridgeError`, `createErrorFromResponse`, `isZeroDustError`, `wrapError`

Pre-signing checks, for integrations that sign themselves (see [API client](/docs/sdk-client)):

- `verifySweepQuote`, `assertAuthorizationMatches`, `assertSignedAuthorization`, `maxAcceptableFeeWei`
- Bridge allowlist helpers: `bridgeForCallTarget`, `allowedCallTargets`, `buildGasZipDepositCalldata`, `createGasZipChainShortResolver`, `ZERODUST_MAINNET_CHAIN_IDS`
- Bounds: `MAX_DEADLINE_WINDOW_SECS` (60), `DEADLINE_CLOCK_SKEW_SECS` (10), `MAX_GAS_PRICE_CAP_MULTIPLIER` (3), `FEE_GAS_BUDGET_UNITS` (1,500,000), `MAX_SERVICE_FEE_BPS` (500)

Signing constants and helpers:

- `ZERODUST_CONTRACT_ADDRESS` (`0x3732398281d0606aCB7EC1D490dFB0591BE4c4f2`), `DOMAIN_NAME` (`'ZeroDust'`), `DOMAIN_VERSION` (`'3'`), `SWEEP_INTENT_TYPES`, `MODE_TRANSFER` (0), `MODE_CALL` (1), `ZERO_ADDRESS`, `ZERO_ROUTE_HASH`
- `computeRouteHash`, `buildSweepIntentTypedData`, `buildSweepIntentFromQuote`, `validateSweepIntentParams`

Input validation:

- `validateAddress`, `validateChainId`, `validateSignature`, `validateUuid`, `validateAmount`, `validateQuoteRequest`, `validateEIP7702Authorization`, `validateSupportedChain`, `validateHex`

Types:

- `Environment`, `ZeroDustConfig`, `Chain`, `ChainsResponse`, `Destination`, `DestinationsResponse`, `ChainBalance`, `BalancesResponse`, `QuoteRequest`, `QuoteResponse`, `FeeBreakdown`, `SweepIntentFields`, `AuthorizationResponse`, `EIP712TypedData`, `EIP7702Authorization`, `SweepRequest`, `SweepResponse`, `SweepStatus`, `RevokeStatus`, `SweepStatusResponse`, `SweepSummary`, `ListSweepsOptions`, `SweepsListResponse`, `ZeroDustErrorCode`, `ApiErrorResponse`
- Agent types: `ZeroDustAgentConfig`, `AgentSweepRequest`, `AgentBatchSweepRequest`, `AgentSweepResult`, `AgentBatchSweepResult`, `AgentSweepOptions`
- Check types: `QuoteCheckContext`, `VerifiedSweep`, `SweepTypedData`, `SweepIntentMessage`, `SweepIntentParams`, `BridgeName`

## Changes in 0.5

0.5.4 requires the revoke authorization on `submitSweep`, as the API does, so every swept wallet ends as a plain account (`ZeroDustAgent` always signed it). 0.5.2 and 0.5.3 added token delivery for chains whose coin has no gas bridge (Mitosis: MITO on BNB Chain via Hyperlane; Endurance: ACE on BNB Chain, to the same wallet only), with `deliveredToken()` and `deliversOnlyToSender()` to tell users.

## Changes in 0.4.0

0.4.0 stopped trusting the API with what the agent signs. Earlier versions signed the typed data the API returned and delegated to whatever contract it named. If you use an older version, upgrade. The full list is in the [changelog](https://github.com/andresdefi/zerodust/blob/main/sdk/CHANGELOG.md).
