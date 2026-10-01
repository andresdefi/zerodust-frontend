# Direct chains

Some chains cannot be swept with EIP-7702 in ZeroDust. On these "direct chains" the wallet sweeps itself, with ordinary legacy transactions whose value is set so that value plus gas spends the balance to the wei. The API plans those transactions; your code signs and broadcasts them.

The planning endpoints are quote-only. They return unsigned transactions and never receive a signed transaction or a key.

## Chains

As of 1 October 2026, `GET /direct/chains` lists 10 chains:

| Chain | ID | Token |
|---|---|---|
| Cronos | 25 | CRO |
| XDC | 50 | XDC |
| Fuse | 122 | FUSE |
| Flow EVM | 747 | FLOW |
| HyperEVM | 999 | HYPE |
| Metis | 1088 | METIS |
| Gravity | 1625 | G |
| Immutable zkEVM | 13371 | IMX |
| Etherlink | 42793 | XTZ |
| Avalanche | 43114 | AVAX |

Read the list from the API rather than hardcoding it. Chains that charge an L1 data fee cannot be swept to exactly 0 this way and are not listed.

## How exact zero works

A legacy transaction costs exactly `gas x gasPrice` on these chains, so `value = balance - gas x gasPrice` leaves 0. That needs the exact gas, never an estimate:

- The planner finds the smallest gas limit `eth_call` accepts for the call, by bisection.
- Gas price: the chain's `eth_gasPrice` plus 10%. Gravity charges the base fee whatever the transaction says, so it is only planned while the base fee is at its floor. Etherlink adds its inclusion fee as gas and is only planned while its base fee is 1 gwei. Otherwise the planner answers `TRY_LATER`.
- A same-chain sweep must go to a plain address (no contract code), because only then is the transfer's gas fixed.

## Fees

The standard [service fee](/docs) applies, paid as a separate exact transfer to ZeroDust (`0x01eD5c94DE39E73C986b98B85C2c0A3d1BEDff7D`) before the sweep:

- It is priced from Gas.zip's token price. With no price, no fee is charged.
- It is left out when it would be less than twice the gas of its own transfer.
- Burn and donate plans have no fee.
- A fee already paid is not charged twice: pass the fee transaction's hash as `feePaidTx` and the planner waives the fee if that transaction is on-chain, from this wallet, to ZeroDust, successful and less than an hour old.

## Endpoints

Rate limits: `/direct/chains`, `/direct/balances` and `/direct/status` are reads (200 per minute per IP); `/direct/route`, `/direct/prepare` and `/direct/exit` count as quotes (60 per minute per IP).

### GET /direct/chains

```json
{
  "chains": [
    { "chainId": 43114, "name": "Avalanche", "token": "AVAX", "decimals": 18, "explorerUrl": "https://snowtrace.io", "rpcUrl": "https://api.avax.network/ext/bc/C/rpc" }
  ],
  "prices": { "AVAX": 10.92 }
}
```

`prices` is USD per token, for display.

### GET /direct/balances/:address

An array of `{ chainId, name, token, decimals, explorerUrl, balance }`. A chain whose RPC fails is left out.

### GET /direct/route

Whether a bridge can take the balance to a destination right now. Quotes only.

| Query | Notes |
|---|---|
| `chainId` | Direct chain to sweep |
| `toChainId` | Destination chain |
| `from` | The wallet |
| `recipient` | Destination address |

Response:

- `{ "available": true }`: Gas.zip or Relay has a route.
- `{ "available": false, "exit": true, "reason": "..." }`: no direct route, but a swap-then-bridge exit (`/direct/exit`) exists. `exit: false` means neither exists.
- `{ "available": null, "reason": "..." }`: a bridge did not answer; try again. Also `{ "available": null }` when the balance is 0.

### GET /direct/prepare

The unsigned transactions that take the chain to exactly 0.

| Query | Notes |
|---|---|
| `chainId`, `toChainId`, `from`, `recipient` | As above |
| `mode` | `route` (default), `burn` or `donate` |
| `feePaidTx` | Optional hash of an earlier fee transaction |

- `route`: an optional fee transaction, then the sweep. Same chain (`toChainId` = `chainId`) is a plain transfer to `recipient`, which must not be `from`. Cross-chain asks Gas.zip and Relay and keeps the larger output.
- `burn`: one transfer of everything to `0x000000000000000000000000000000000000dEaD`. `toChainId` and `recipient` are still required but not used.
- `donate`: one transfer of everything to ZeroDust.

Response:

| Field | Notes |
|---|---|
| `chainId` | |
| `route` | `gaszip`, `relay`, `transfer`, `burn` or `donate` |
| `requestId` | Relay's request ID, needed by `/direct/status`; otherwise `null` |
| `txs` | Unsigned legacy transactions, in order, with consecutive nonces: `kind` (`fee`, `sweep` or `swap`), `to`, `data`, `value`, `gas`, `gasPrice`, `nonce` |
| `receive` | What arrives: the bridge's quote, the exact value for a same-chain transfer, `0` for burn or donate |
| `fee` | ZeroDust's fee in wei, `0` when none |
| `balance` | The balance this plan spends |

Before signing, check that the plan is what you asked for and that the sum of `value + gas x gasPrice` over `txs` equals `balance` and the wallet's current balance. Then sign and broadcast the transactions in order to the chain's RPC. If the balance changed, request a new plan.

### GET /direct/exit

For a chain with no direct route but a swap-then-bridge one (LI.FI). Takes `chainId`, `toChainId` (must differ from `chainId`), `from`, `recipient` and optional `feePaidTx`.

The response has the same shape as `/direct/prepare`, with `route: "lifi"`, a `swap` transaction, `tool` (the LI.FI tool used) and `leftoverMax`. A swap cannot use its gas limit exactly, so it leaves a small remainder. After the swap lands, sweep that remainder with `/direct/prepare` in `burn` or `donate` mode. If the balance is then above `leftoverMax`, the swap failed: stop.

### GET /direct/status

Delivery status of a direct sweep.

| Query | Notes |
|---|---|
| `route` | `gaszip`, `relay`, `lifi`, `transfer`, `burn` or `donate` |
| `hash` | The sweep or swap transaction hash |
| `requestId` | Required for `relay` |

Response: `{ "state": "pending" | "delivered" | "failed", "destTx": "0x..." }`. For `transfer`, `burn` and `donate` the state is `delivered`; confirm the transaction landed and the balance is 0 on the chain itself.

## Errors

| Code | Status | Meaning |
|---|---|---|
| `NOT_DIRECT_CHAIN` | 400 | `chainId` is not a direct chain |
| `NOTHING_TO_SWEEP` | 400 | The balance is 0 |
| `INSUFFICIENT_FOR_GAS` | 400 | The balance does not cover the gas or the fee |
| `INVALID_REQUEST` | 400 | For example a same-chain sweep to the same address, or to a contract |
| `NO_ROUTE` | 409 | No bridge route; try `/direct/route` for an exit |
| `TRY_LATER` | 503 | Exact zero is not possible right now (gas price conditions, unsettled quotes) |
| `UPSTREAM` | 503 | A bridge failed for another reason |
