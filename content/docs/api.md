# REST API

Base URL: `https://api.zerodust.xyz`

- JSON in and out. Amounts are strings in wei, chain IDs are numbers.
- No key is needed. An [API key](#api-keys) raises your rate limits.
- Browsers may only call the API from the ZeroDust site (CORS). Call it from a server, a script or an agent.
- Send only signatures. No endpoint takes a private key.

The [SDK](/docs/sdk) wraps the chain, balance, quote and sweep endpoints. Chains without EIP-7702 use separate planning endpoints, documented on [Direct chains](/docs/direct-chains).

## Rate limits

Limits are per client IP and per minute unless noted. With an [API key](#api-keys), the read, quote and sweep routes the SDK uses count against the key instead.

| Group | Limit | Routes |
|---|---|---|
| Reads | 200 | `/chains`, `/chains/:chainId`, `/destinations`, `/balances/*`, `/prices`, `/prices/:symbol`, `GET /sweep/:sweepId`, `/sweeps/:address`, `/direct/chains`, `/direct/balances/:address`, `/direct/status` |
| Quotes | 60 | `/quote`, `POST /authorization`, `/direct/route`, `/direct/prepare`, `/direct/exit` |
| Sweep submission | 60, and 60 per wallet address | `POST /sweep` |
| Key registration | 5 per hour | `POST /agent/register` |
| Everything else | 100 | |

Responses carry `x-ratelimit-limit`, `x-ratelimit-remaining` and `x-ratelimit-reset`. Over the limit, the API returns 429:

```json
{ "error": "Too Many Requests", "message": "You are requesting quotes too quickly. Maximum 60 quotes per minute.", "statusCode": 429 }
```

A wallet address over its sweep limit gets 429 with code `RATE_LIMITED`.

## Errors

Errors are JSON with an `error` message and, in most cases, a machine-readable `code`:

```json
{ "error": "Source chain not supported", "code": "INVALID_FROM_CHAIN" }
```

- 400 with code `FST_ERR_VALIDATION`: a parameter failed validation.
- 404 "Quote not found", "Sweep not found" and "Chain not found" have no code.
- 500 responses are generic and carry no detail.

## Sweep flow

1. `GET /quote`: price the sweep and get a `quoteId`.
2. `POST /authorization`: get the EIP-712 `SweepIntent` for that quote.
3. Sign the intent, an EIP-7702 delegation to `0x3732398281d0606aCB7EC1D490dFB0591BE4c4f2`, and a revoke authorization (delegation to address 0, nonce + 1).
4. `POST /sweep`: submit the signatures.
5. `GET /sweep/:sweepId`: poll until `completed` or `failed`.

Check the quote before signing it. The SDK's `ZeroDustAgent` and `verifySweepQuote()` do this; see [Agent](/docs/sdk-agent).

## Chains

### GET /chains

Chains ZeroDust sweeps with EIP-7702.

Query: `testnet` (boolean, default `false`). There are no testnet chains at the moment.

Response:

```json
{
  "chains": [
    {
      "chainId": 8453,
      "name": "Base",
      "nativeToken": "ETH",
      "nativeTokenDecimals": 18,
      "minBalance": "100000000000000",
      "contractAddress": "0x3732398281d0606aCB7EC1D490dFB0591BE4c4f2",
      "explorerUrl": "https://basescan.org",
      "enabled": true,
      "crossChain": { "available": true, "bridges": ["gaszip", "relay", "across"], "checkedAt": "2026-10-01T16:01:01.302Z" },
      "simulation": { "reliable": true, "mode": "authorizationList", "checkedAt": "2026-10-01T16:00:51.180Z" }
    }
  ]
}
```

| Field | Notes |
|---|---|
| `minBalance` | Informational. Quotes do not enforce a fixed minimum; the fee reserve decides. |
| `crossChain` | Whether any bridge currently accepts this chain as a cross-chain source, and which. Checked every 10 minutes; `null` values until the first check. Advisory: `/quote` always asks the bridges live. |
| `simulation` | Whether this chain's RPC can simulate an EIP-7702 sweep (checked hourly). `mode` is `authorizationList` or `stateOverride`. Quotes from a chain with `reliable: false` are refused. |

### GET /chains/:chainId

One chain, same fields as above. 404 `{ "error": "Chain not found" }` for an unknown ID.

### GET /destinations

Chains a cross-chain sweep from `fromChainId` can deliver native gas to. Any EVM chain a routing bridge serves qualifies, not only ZeroDust chains. This is what bridges advertise; `/quote` confirms a route live.

Query: `fromChainId` (required, must be a ZeroDust chain).

```json
{
  "fromChainId": 8453,
  "destinations": [
    { "chainId": 16661, "name": "0G", "nativeSymbol": "0G", "nativeDecimals": 18, "bridges": ["gaszip"], "zerodustChain": false }
  ]
}
```

`zerodustChain` is `true` when the destination is also a ZeroDust source chain. Errors: 400 `INVALID_FROM_CHAIN`.

## Balances

### GET /balances/:address

Native balance on every enabled chain.

Query: `testnet` (boolean, default `false`).

```json
{
  "address": "0x...",
  "chains": [
    { "chainId": 8453, "name": "Base", "nativeToken": "ETH", "balance": "1200000000000000", "balanceFormatted": "0.0012", "canSweep": true, "minBalance": "100000000000000" }
  ]
}
```

`canSweep` is `true` for any balance above 0. Whether it covers the fees is decided by the quote.

### GET /balances/:address/:chainId

One chain, same fields as an entry above. 404 `{ "error": "Chain not supported" }` for an unknown chain.

## Prices

### GET /prices

USD prices of native tokens, cached for 10 minutes. For display.

```json
{ "prices": { "ETH": 2681.24, "BNB": 765.75 }, "cachedAt": "2026-10-01T16:00:41.686Z", "ttlSeconds": 115 }
```

### GET /prices/:symbol

`{ "symbol": "ETH", "priceUsd": 2681.24 }`. 404 when no price is available.

## Quotes

### GET /quote

Prices a sweep and stores the quote. Nothing is signed or sent.

| Query | Notes |
|---|---|
| `fromChainId` | Required. A ZeroDust chain. |
| `toChainId` | Required. Equal to `fromChainId` for a same-chain sweep, or any chain from `/destinations`. |
| `userAddress` | Required. The wallet to empty. |
| `destination` | Required. Where the funds go. |

ZeroDust always chooses the route. For a cross-chain sweep it asks Gas.zip, Relay and Across and keeps the highest expected output. Passing `callTarget` or `callData` is refused with `CUSTOM_ROUTE_UNSUPPORTED`.

Response:

| Field | Notes |
|---|---|
| `quoteId` | UUID, used by `/authorization` and `/sweep` |
| `version` | `3` |
| `userBalance` | Balance at quote time |
| `estimatedReceive` | Same-chain: exactly `userBalance - fees.maxTotalFeeWei`. Cross-chain: the bridge's expected output less 0.5%. |
| `mode` | `0` transfer (same-chain), `1` bridge call (cross-chain) |
| `fees` | See below |
| `autoRevoke` | Always `true` |
| `bridge` | Cross-chain only: `name`, `displayName`, `inputAmount` (wei sent to the bridge), `expectedOutput` (wei the bridge expects to deliver) |
| `intent` | Fields that go into the signed `SweepIntent`: `mode`, `destination`, `destinationChainId` (string), `callTarget` (zero address for same-chain), `routeHash`, `minReceive`, and `callData` for cross-chain. `keccak256(callData) == routeHash`, so the route can be decoded and checked before signing. |
| `deadline` | Unix seconds. The contract accepts at most 60 seconds ahead. |
| `nonce` | The wallet's ZeroDust intent nonce |
| `authNonce` | The wallet's transaction count, which the EIP-7702 delegation must use |
| `validForSeconds` | `55` |

`intent.minReceive` is the least the contract will accept: equal to `estimatedReceive` for a same-chain sweep, 95% of it for a cross-chain sweep.

#### Fees in a quote

| Field | Notes |
|---|---|
| `maxTotalFeeWei` | The fee reserve. The whole reserve leaves the wallet: the contract reimburses the sponsor's gas from it and sends the unused part to the sponsor. |
| `extraFeeWei` | Fixed part of the reserve: the service fee, the L1 data fee on rollups, and per-chain surcharges |
| `overheadGasUnits` | Gas the contract cannot measure itself (intrinsic cost, authorization, signature checks) |
| `protocolFeeGasUnits` | Always `0` (deprecated) |
| `reimbGasPriceCapWei` | Highest gas price the sponsor can be reimbursed at: 1.2 times the gas price at quote time |
| `revokeGasUnits` | Gas reserved for the revoke transaction |

The service fee in `extraFeeWei` is 5% of the balance's USD value under $1, and 1% from $1 with a minimum of $0.05 and a maximum of $0.50.

Errors (400 unless noted):

| Code | Meaning |
|---|---|
| `INVALID_FROM_CHAIN` | Source chain not supported |
| `INVALID_TO_CHAIN` | No bridge delivers from the source to this chain |
| `BALANCE_TOO_LOW` | The balance is 0 |
| `INSUFFICIENT_FOR_FEES` | The balance does not cover the fee reserve |
| `SOURCE_CHAIN_DISABLED`, `DEST_CHAIN_DISABLED`, `BRIDGE_UNAVAILABLE` | No cross-chain route right now |
| `SIMULATION_UNAVAILABLE` | The chain's RPC cannot simulate the sweep right now |
| `CHAIN_PAUSED` | Sweeps from this chain are paused for now |
| `SPONSOR_UNAVAILABLE` | The sponsor cannot pay for this sweep on this chain right now |
| `L1_FEE_UNAVAILABLE` | The rollup's L1 data fee could not be priced; try again shortly |
| `CHAIN_CLOCK_LAG` | The chain's latest block is too far behind to leave time to sign |
| `ADDRESS_TEMPORARILY_BLOCKED` | Two or more sweeps from this address failed for wallet-side reasons; try again later |
| `CUSTOM_ROUTE_UNSUPPORTED` | `callTarget` or `callData` was passed |
| `INTERNAL_ERROR` (500) | The quote could not be stored |

### POST /authorization

Returns the EIP-712 typed data for a quote.

Body: `{ "quoteId": "<uuid>" }`

| Field | Notes |
|---|---|
| `sweepType` | `same-chain` or `cross-chain` |
| `typedData` | EIP-712 `SweepIntent`. Domain: name `ZeroDust`, version `3`, `chainId` = source chain, `verifyingContract` = the wallet's own address. |
| `contractAddress` | The ZeroDust contract to delegate to |
| `version` | `3` |

Errors: 404 "Quote not found", 400 `QUOTE_EXPIRED`, 400 `CONTRACT_NOT_DEPLOYED`.

The `SweepIntent` type is `mode uint8, user address, destination address, destinationChainId uint256, callTarget address, routeHash bytes32, minReceive uint256, maxTotalFeeWei uint256, overheadGasUnits uint256, protocolFeeGasUnits uint256, extraFeeWei uint256, reimbGasPriceCapWei uint256, deadline uint256, nonce uint256`. Build it from the verified quote and compare it with this response rather than signing the response as received.

## Sweeps

### POST /sweep

Submits a signed sweep. The relayer simulates it, sends it, then sends the revoke.

Body:

| Field | Notes |
|---|---|
| `quoteId` | Required |
| `signature` | Required. EIP-712 signature of the `SweepIntent` (64 or 65 bytes, hex). |
| `eip7702Authorization` | Required. `{ chainId, contractAddress, nonce, yParity, r, s }`, delegating to the ZeroDust contract on the source chain. |
| `revokeAuthorization` | Optional. Same shape, delegating to `0x0000000000000000000000000000000000000000` on the same chain with nonce = delegation nonce + 1. Without it the wallet stays delegated after the sweep. |

```json
{ "sweepId": "6f1c...", "status": "pending", "sweepType": "cross-chain", "isExisting": false, "version": 3 }
```

Idempotent per quote: submitting a `quoteId` that already has a sweep returns that sweep with `isExisting: true`.

Errors (400 unless noted):

| Code | Meaning |
|---|---|
| `QUOTE_EXPIRED` | Past the quote's deadline |
| `INVALID_SIGNATURE` | The `SweepIntent` signature does not verify for this wallet |
| `CHAIN_ID_MISMATCH` | The delegation is for another chain |
| `CONTRACT_ADDRESS_MISMATCH` | The delegation targets another contract |
| `EIP7702_INVALID_SIGNATURE` | The delegation was not signed by the wallet |
| `INVALID_REVOKE_TARGET` | The revoke does not delegate to address 0 |
| `REVOKE_CHAIN_ID_MISMATCH` | The revoke is for another chain |
| `REVOKE_NONCE_MISMATCH` | The revoke nonce is not delegation nonce + 1 |
| `REVOKE_INVALID_SIGNATURE` | The revoke was not signed by the wallet |
| `ADDRESS_TEMPORARILY_BLOCKED`, `CHAIN_PAUSED` | As for `/quote` |
| `RATE_LIMITED` (429) | More than 60 sweeps a minute from this address |
| 404 | Quote not found |

### GET /sweep/:sweepId

| Field | Notes |
|---|---|
| `sweepId`, `status`, `sweepType`, `mode` | `status` is `pending`, `simulating`, `executing`, `broadcasted`, `bridging`, `completed` or `failed` |
| `txHash` | Sweep transaction on the source chain |
| `destinationTxHash` | Delivery transaction (cross-chain) |
| `amountSent` | Wei |
| `destination`, `fromChainId`, `toChainId` | |
| `errorMessage` | When failed |
| `bridgeTrackingUrl` | Cross-chain, once there is a transaction |
| `revokeStatus` | `not_requested`, `pending`, `executing`, `completed` or `failed` |
| `revokeTxHash`, `revokeError` | |
| `createdAt`, `updatedAt`, `version` | |

`completed` and `failed` are final. Confirm the result on-chain: the source balance is 0, the wallet has no code once the revoke lands, and the funds arrived.

### GET /sweeps/:address

Sweeps for a wallet, newest first.

Query: `limit` (1 to 100, default 20), `offset` (default 0), `status` (one of the statuses above).

```json
{ "sweeps": [{ "sweepId": "...", "status": "completed", "sweepType": "same-chain", "mode": 0, "fromChainId": 8453, "toChainId": 8453, "amountSent": "...", "txHash": "0x...", "version": 3, "createdAt": "..." }], "total": 1 }
```

## API keys

A key gives you your own rate limit, separate from your IP's. Send it as `X-API-Key: <key>` (what the SDK and MCP server send) or `Authorization: Bearer <key>`. Treat a key as a secret; it cannot move funds.

- **Where it applies:** the reads `/chains`, `/chains/:chainId`, `/destinations`, `/balances/*`, `GET /sweep/:sweepId` and `/sweeps/:address`, plus `/quote`, `POST /authorization` and `POST /sweep`. Each route has its own per-minute bucket for the key, at the key's limit (300 for agent keys) and never below the anonymous limit. The 60 sweeps per minute per wallet address still apply.
- **Where it does not:** `/prices` and the `/direct/*` routes keep the per-IP limits.
- **One IP, at most two keys an hour.** Further keys used from the same IP get that IP's anonymous limits.
- **An invalid, revoked or expired key** is treated as no key: the request gets the anonymous limits, not an error. Check a key with `GET /agent/me`.
- A revoked key can keep its higher limits for up to a minute.

### POST /agent/register

Issues a key. Limited to 5 per IP per hour.

| Body | Notes |
|---|---|
| `name` | Required, 3 to 100 characters |
| `agentId` | Optional, up to 255 characters |
| `contactEmail` | Optional |
| `webhookUrl` | Optional URL, stored with the key |
| `metadata` | Optional object, up to 20 properties |

Response (201): `apiKey` (shown once, not retrievable later), `keyPrefix`, `keyId`, `keyType` (`agent`), `rateLimits` (`perMinute` 300, `daily` 1000) and `message`.

### GET /agent/me

Requires a key. Returns `keyId`, `keyType`, `agentId`, `rateLimits` (`perMinute`, `daily`, `dailyUsed`, `dailyRemaining`) and `stats` for the last 7 days (`totalRequests`, `successfulRequests`, `failedRequests`, `avgResponseTimeMs`).

### DELETE /agent/key

Requires a key. Revokes it permanently.

Requests to these routes count against the key's own per-minute limit (300 for agent keys) as well as the IP limit. Missing or invalid key: 401.

## MCP and discovery

| Route | Notes |
|---|---|
| `POST /mcp` | Hosted MCP server, JSON-RPC 2.0. See [MCP server](/docs/mcp). |
| `GET /mcp` | Server info and tool list |
| `GET /mcp/tools` | Tool definitions as plain JSON |
| `GET /.well-known/agent-card.json` | A2A agent card |
| `GET /erc8004/agent.json` | ERC-8004 registration metadata |

## Health

- `GET /health`: `{ "status": "ok", "timestamp": "..." }`.
- `GET /ready`: also checks the database. 200 `{ "status": "ok", "database": "connected", "timestamp": "..." }`, or 503 with `database: "disconnected"`.
