# Direct chains

Some chains cannot be swept with EIP-7702 in ZeroDust. On these "direct chains" the wallet sweeps itself, with ordinary legacy transactions whose value is set so that value plus gas spends the balance to the wei. The API plans those transactions; your code signs and broadcasts them.

The planning endpoints are quote-only. They return unsigned transactions and never receive a signed transaction or a key.

## Chains

As of 2 October 2026, `GET /direct/chains` lists 14 chains:

| Chain | ID | Token |
|---|---|---|
| Flare | 14 | FLR |
| Cronos | 25 | CRO |
| Rootstock | 30 | RBTC |
| XDC | 50 | XDC |
| Fuse | 122 | FUSE |
| Monad | 143 | MON |
| Flow EVM | 747 | FLOW |
| HyperEVM | 999 | HYPE |
| Metis | 1088 | METIS |
| Gravity | 1625 | G |
| Immutable zkEVM | 13371 | IMX |
| Etherlink | 42793 | XTZ |
| Avalanche | 43114 | AVAX |
| Ethereal | 5064014 | USDe |

Read the list from the API rather than hardcoding it. Chains that charge an L1 data fee cannot be swept to exactly 0 this way and are not listed.

## How exact zero works

A legacy transaction costs exactly `gas x gasPrice` on these chains, so `value = balance - gas x gasPrice` leaves 0. That needs the exact gas, never an estimate:

- The planner finds the smallest gas limit `eth_call` accepts for the call, by bisection.
- Gas price: the chain's `eth_gasPrice` plus 10%. Gravity charges the base fee whatever the transaction says, so it is only planned while the base fee is at its floor. Etherlink adds its inclusion fee as gas and is only planned while its base fee is 1 gwei. Otherwise the planner answers `TRY_LATER`.
- A same-chain sweep must go to a plain address (no contract code), because only then is the transfer's gas fixed.

### Gas-limit chains

Some chains charge the whole gas limit (`gasLimit x gasPrice`) and refund nothing, whatever the transaction used. `GET /direct/chains` marks them with `kind: "gaslimit"` (Monad today). There any sufficient limit leaves exactly 0, so the planner never bisects: plain transfers use 21,000 and contract calls use the chain's `eth_estimateGas` plus 25%. When you check such a plan, require `sum(value) + sum(gas x gasPrice) == balance` exactly; a simulator that refunds unused gas will show a little left over, and that is expected.

Monad also keeps a 10 MON reserve: a transaction that takes a wallet below it reverts (and still pays its gas) unless it is the wallet's only transaction in the last 3 blocks and the wallet is not EIP-7702 delegated. So:

- A delegated wallet cannot be emptied there; the planner answers `INVALID_REQUEST`.
- Plans carry `txGapBlocks` (also on the chain in `/direct/chains`): after a transaction lands in block `n`, wait until the chain's block number is at least `n + txGapBlocks` before sending the next one.

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
    { "chainId": 43114, "name": "Avalanche", "token": "AVAX", "decimals": 18, "explorerUrl": "https://snowtrace.io", "rpcUrl": "https://api.avax.network/ext/bc/C/rpc", "kind": "evm" },
    { "chainId": 143, "name": "Monad", "token": "MON", "decimals": 18, "explorerUrl": "https://monadvision.com", "rpcUrl": "https://rpc.monad.xyz", "kind": "gaslimit", "txGapBlocks": 4 }
  ],
  "prices": { "AVAX": 10.92 }
}
```

`kind` is the chain's gas rule: `evm`, `arbitrum` (price must equal the base fee), `etherlink` (inclusion fee charged as gas) or `gaslimit` (the whole limit is charged). `prices` is USD per token, for display.

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
| `route` | `gaszip`, `relay`, `across`, `transfer`, `burn` or `donate` |
| `requestId` | Relay's request ID, needed by `/direct/status`; otherwise `null` |
| `txs` | Unsigned legacy transactions, in order, with consecutive nonces: `kind` (`fee`, `sweep` or `swap`), `to`, `data`, `value`, `gas`, `gasPrice`, `nonce` |
| `receive` | The least that arrives: the bridge's quote less 3% (bridges settle at their own price on delivery), the exact value for a same-chain transfer, `0` for burn or donate |
| `quoted` | Bridge and swap routes: the bridge's raw quote, before the 3%. Pass it back to `/direct/status` |
| `fee` | ZeroDust's fee in wei, `0` when none |
| `balance` | The balance this plan spends |
| `txGapBlocks` | Gas-limit chains with a reserve rule (Monad): blocks to wait after each transaction's block before sending the next |
| `expiresAt` | Across only: unix seconds after which the deposit reverts on-chain. Across quotes live about 30 seconds; never send the sweep after this |

#### Across (not offered at the moment)

The API does not currently plan Across routes: Across moves these tokens through swaps on both ends, and a failed destination swap refunds USDC rather than the native token. If it is turned on, it is used only on gas-limit chains: its deposit runs a swap that would refund gas elsewhere. The sweep is one `swapAndBridge` call to Across's SpokePoolPeriphery (`0x97CCDBea4632140639aD5eA9b944aa034eb15fD4`): the native token is swapped and bridged, and on the destination Across's MulticallHandler swaps into the native gas token and sends it to `recipient`. Before signing, decode it and check at least: the SpokePool is Across's for the source chain, the depositor is `from`, the destination chain is `toChainId`, there is no submission fee, the deposit goes to Across's handler for the destination, the message's fallback recipient and every drain is `recipient`, no destination call carries value or moves a token except approving 0x's AllowanceHolder, the 0x swap pays the handler at least `receive`, and its Settler is 0x's registered one (`ownerOf(2)` or `prev(2)` on `0x00000000000004533Fe15556B1E086BB1A72cEae`). If the destination swap fails, Across refunds the deposit to `from` on the source chain (as USDC, not the native token).

Before signing, check that the plan is what you asked for and that the sum of `value + gas x gasPrice` over `txs` equals `balance` and the wallet's current balance. Then sign and broadcast the transactions in order to the chain's RPC. If the balance changed, request a new plan.

### GET /direct/exit

For a chain with no direct route but a swap-then-bridge one (LI.FI). Takes `chainId`, `toChainId` (must differ from `chainId`), `from`, `recipient` and optional `feePaidTx`.

The response has the same shape as `/direct/prepare`, with `route: "lifi"`, a `swap` transaction, `tool` (the LI.FI tool used) and `leftoverMax`. A swap cannot use its gas limit exactly, so it leaves a small remainder. After the swap lands, sweep that remainder with `/direct/prepare` in `burn` or `donate` mode. If the balance is then above `leftoverMax`, the swap failed: stop.

### GET /direct/status

Delivery status of a direct sweep.

| Query | Notes |
|---|---|
| `route` | `gaszip`, `relay`, `across`, `lifi`, `transfer`, `burn` or `donate` |
| `hash` | The sweep or swap transaction hash |
| `requestId` | Required for `relay` |
| `fromChainId` | Required for `across` (Across looks deposits up by origin chain) |
| `quoted`, `toChainId` | Optional: the plan's `quoted` and the destination (with `fromChainId`). With them, the API records how much the bridge delivered against its quote, with no address or hash, to keep the 3% margin honest |

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
