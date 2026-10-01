# Errors

Every error the SDK throws is a `ZeroDustError` (or a subclass). `ZeroDustAgent.sweep()`, `batchSweep()` and `sweepAll()` do not throw: they return `success: false` with the message in `error`.

## ZeroDustError

| Member | Notes |
|---|---|
| `code` | Machine-readable code (see below) |
| `message` | What went wrong. For API errors, the API's `error` text. |
| `details` | Extra context. For API errors, `details.rawError` is the API's response body. |
| `statusCode` | HTTP status, when the error came from an API response |
| `getUserMessage()` | A short message fit to show an end user |
| `isRetryable()` | `true` for `NETWORK_ERROR`, `TIMEOUT`, `RPC_ERROR`, `SERVICE_UNAVAILABLE`, `RATE_LIMITED` and `INTERNAL_ERROR` |
| `toJSON()` | Plain object for logging |

```ts
import { ZeroDust, isZeroDustError } from '@zerodust/sdk';

const zerodust = new ZeroDust({ environment: 'mainnet' });

try {
  await zerodust.getQuote({
    fromChainId: 8453,
    toChainId: 8453,
    userAddress: '0xWallet',
    destination: '0xDestination',
  });
} catch (error) {
  if (!isZeroDustError(error)) throw error;
  switch (error.code) {
    case 'BALANCE_TOO_LOW':
    case 'INSUFFICIENT_FOR_FEES':
      console.log('Nothing worth sweeping on this chain');
      break;
    default:
      console.error(error.code, error.statusCode, error.message);
  }
}
```

## Where codes come from

- **API errors.** When the API answers with an error body, `code` is the API's `code` field as sent. The API uses more codes than the `ZeroDustErrorCode` type lists (for example `INVALID_FROM_CHAIN`, `SPONSOR_UNAVAILABLE` or `CHAIN_CLOCK_LAG`); compare `error.code` as a string. The [REST API](/docs/api) page lists the codes per endpoint.
- **Request validation.** A parameter that fails the API's schema returns 400 with code `FST_ERR_VALIDATION`.
- **API errors without a code.** Some responses have no `code`, for example "Quote not found", "Sweep not found" and "Chain not found". From SDK 0.5.0 the code comes from the HTTP status: 404 is `NOT_FOUND`, 429 is `RATE_LIMITED`, 401 and 403 are `UNAUTHORIZED`, 503 is `SERVICE_UNAVAILABLE`, any other 4xx is `INVALID_REQUEST` and a 5xx is `INTERNAL_ERROR`. (Before 0.5.0 they all arrived as a retryable `INTERNAL_ERROR`.)
- **Transport.** A network failure is a `NetworkError` (`NETWORK_ERROR`) after the configured retries. A 429 is retried within the same `retries` budget, after the `Retry-After` time (at most 30 s) or the usual backoff; a 502, 503 or 504 on a GET is retried the same way. A request that exceeds `timeout` is a `TimeoutError` (`TIMEOUT`) and is not retried. A non-JSON error response gets its code from the status as above.
- **Local validation.** Bad input is rejected before any request: an invalid address throws `InvalidAddressError` (`INVALID_ADDRESS`), an invalid chain ID throws `INVALID_CHAIN_ID`, a malformed signature or authorization throws `INVALID_SIGNATURE`, and a quote or sweep ID that is not a UUID throws `QUOTE_NOT_FOUND`.
- **Local safety checks.** `verifySweepQuote()`, `assertAuthorizationMatches()` and `assertSignedAuthorization()` throw `UNSAFE_QUOTE`. Nothing has been signed when this happens. See [Agent](/docs/sdk-agent).

## Codes in ZeroDustErrorCode

| Code | Meaning | Retryable |
|---|---|---|
| `BALANCE_TOO_LOW` | The balance is 0 | No |
| `INSUFFICIENT_FOR_FEES` | The balance does not cover the fee reserve | No |
| `QUOTE_EXPIRED` | The quote's deadline passed; get a new quote | No |
| `QUOTE_NOT_FOUND` | Unknown quote, or the ID is not a UUID | No |
| `SIGNATURE_REJECTED` | The signer refused to sign | No |
| `INVALID_ADDRESS` | Not a valid address | No |
| `INVALID_CHAIN_ID` | Not a positive integer chain ID | No |
| `CHAIN_NOT_SUPPORTED` | Chain not supported, or the agent has no RPC for it | No |
| `NOT_FOUND` | The API has no such quote, sweep or chain (404) | No |
| `INVALID_REQUEST` | The API rejected the request (a 4xx without a more specific code) | No |
| `UNAUTHORIZED` | Missing or invalid API key (401, 403) | No |
| `CHAIN_PAUSED` | ZeroDust paused sweeps from this chain for now | No |
| `SOURCE_CHAIN_DISABLED` | No bridge currently accepts this source chain | No |
| `DEST_CHAIN_DISABLED` | No bridge currently delivers to this destination chain | No |
| `BRIDGE_UNAVAILABLE` | No bridge route right now | No |
| `CONTRACT_NOT_DEPLOYED` | No ZeroDust contract on this chain | No |
| `INVALID_SIGNATURE` | The `SweepIntent` signature does not verify | No |
| `EIP7702_INVALID_SIGNATURE` | The delegation authorization does not verify | No |
| `CHAIN_ID_MISMATCH` | The authorization is for another chain | No |
| `NONCE_MISMATCH` | The signed delegation nonce differs from the quote's `authNonce` | No |
| `MISSING_CALL_DATA` | A cross-chain quote has no route calldata | No |
| `UNSAFE_QUOTE` | The quote failed a local safety check; nothing was signed | No |
| `NETWORK_ERROR` | The request could not be sent or answered | Yes |
| `TIMEOUT` | The request or `waitForSweep()` timed out | Yes |
| `RPC_ERROR` | A chain RPC failed | Yes |
| `SERVICE_UNAVAILABLE` | The service is temporarily unavailable | Yes |
| `RATE_LIMITED` | Too many requests (429), after the SDK's own retries | Yes |
| `INTERNAL_ERROR` | Any other error, including a 5xx without a code | Yes |

`isRetryable()` only looks at the code. A retry that needs a new quote (for example after `QUOTE_EXPIRED` or `NONCE_MISMATCH`) must start again from `getQuote()`.

## Subclasses

`NetworkError`, `TimeoutError` and `InvalidAddressError` are thrown by the SDK. `BalanceTooLowError`, `QuoteExpiredError`, `ChainNotSupportedError`, `SignatureError` and `BridgeError` are exported for your own use, but API errors arrive as plain `ZeroDustError` with the matching `code`. Branch on `error.code`, not on `instanceof`.

## Helpers

- `isZeroDustError(error)`: type guard.
- `wrapError(error, context?)`: turns any thrown value into a `ZeroDustError`.
- `createErrorFromResponse(statusCode, body)`: builds a `ZeroDustError` from an API error body `{ error, code? }`.
