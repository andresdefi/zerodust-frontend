# Agent

`ZeroDustAgent` runs a complete sweep with a key it holds: quote, local checks, signatures, submission and waiting. It is meant for scripts, bots and AI agents that control their own wallet.

## Create an agent

```ts
import { ZeroDustAgent } from '@zerodust/sdk';
import { privateKeyToAccount } from 'viem/accounts';

const agent = new ZeroDustAgent({
  account: privateKeyToAccount(process.env.ZERODUST_PRIVATE_KEY as `0x${string}`),
  environment: 'mainnet',
});
```

Keep the key in a secrets store or environment variable, never in code. Any viem `LocalAccount` works, including accounts from custody providers, as long as it can sign EIP-712 typed data and EIP-7702 authorizations. Browser wallets and JSON-RPC accounts do not work.

`createAgentFromPrivateKey(privateKey, config?)` does the same from a hex key. It is async:

```ts
import { createAgentFromPrivateKey } from '@zerodust/sdk';

const agent = await createAgentFromPrivateKey(
  process.env.ZERODUST_PRIVATE_KEY as `0x${string}`,
  { environment: 'mainnet' },
);
```

### Options

`ZeroDustAgentConfig` takes every [client option](/docs/sdk) plus:

| Option | Type | Default | Notes |
|---|---|---|---|
| `account` | `LocalAccount` | required | Signs everything. Its address is `agent.address`. |
| `rpcUrls` | `Record<number, string>` | `{}` | RPC URL per chain ID, replacing the default for that chain. Used to read the balance, gas price and nonce, and to sign authorizations. |
| `requireVerifiedRoute` | `boolean` | `false` | Refuse cross-chain routes whose recipient cannot be checked locally. See below. |

### RPC URLs

The agent reads chain state from its own RPC, not from the API. Without an entry in `rpcUrls` it uses a public RPC that ships with the SDK for every chain the API serves (exported as `DEFAULT_RPC_URLS`). SDK versions before 0.5.0 knew only 25 chains and failed on the others with `No default RPC for chain ...`.

Public RPCs are rate limited and sometimes slow, so production agents should pass their own for the chains they sweep.

```ts
import { ZeroDustAgent } from '@zerodust/sdk';
import { privateKeyToAccount } from 'viem/accounts';

const agent = new ZeroDustAgent({
  account: privateKeyToAccount(process.env.ZERODUST_PRIVATE_KEY as `0x${string}`),
  environment: 'mainnet',
  rpcUrls: {
    42161: process.env.ARBITRUM_RPC_URL!,
    59144: process.env.LINEA_RPC_URL!,
  },
});
```

## Read balances

| Method | Returns |
|---|---|
| `getBalances()` | `BalancesResponse` for `agent.address` on every chain |
| `getSweepableBalances()` | `ChainBalance[]` with a balance above 0 |
| `getBalance(chainId)` | `ChainBalance` for one chain |

`agent.client` is the underlying [`ZeroDust` client](/docs/sdk-client) if you need other calls.

## sweep(request, options?)

Sweeps one chain.

```ts
const result = await agent.sweep(
  { fromChainId: 42161, toChainId: 8453, destination: '0xYourDestination' },
  { timeoutMs: 180000, onStatusChange: (s) => console.log(s.status) },
);
```

`AgentSweepRequest`:

| Field | Type | Notes |
|---|---|---|
| `fromChainId` | `number` | Chain to empty |
| `toChainId` | `number` | Chain to receive on. Equal to `fromChainId` for a same-chain sweep. |
| `destination` | `Address` | Optional. Defaults to `agent.address`. |

`AgentSweepOptions`:

| Field | Default | Notes |
|---|---|---|
| `waitForCompletion` | `true` | Poll until `completed` or `failed`. When `false`, `sweep()` returns right after submission. |
| `timeoutMs` | `120000` | How long to wait for completion. |
| `onStatusChange` | none | Called with the `SweepStatusResponse` each time the status changes. |
| `dryRun` | `false` | Stop before submitting. See below. |

Steps:

1. Get a quote for `agent.address`.
2. Read the balance and gas price from the agent's RPC and verify the quote against the request (see the next section). The EIP-712 typed data is built locally from the verified fields.
3. Fetch the API's typed data (`POST /authorization`) and require it to match the local one. It is compared, never signed.
4. Sign the `SweepIntent`.
5. Sign the EIP-7702 delegation to `ZERODUST_CONTRACT_ADDRESS` on the source chain. Its nonce must equal the quote's `authNonce`, otherwise the agent stops with `NONCE_MISMATCH`.
6. Sign the revoke authorization (delegate to address 0, nonce + 1).
7. Submit all three (`POST /sweep`) and, unless `waitForCompletion` is `false`, wait.

`sweep()` does not throw. It returns an `AgentSweepResult`:

| Field | Notes |
|---|---|
| `success` | `true` when the sweep completed, was submitted without waiting, or the dry run finished |
| `sweepId` | Set once submitted |
| `status` | Final `SweepStatusResponse` when it waited |
| `txHash` | Sweep transaction hash, when known |
| `error` | Message when `success` is `false` |
| `quote` | The quote used |
| `dryRun` | `true` for a dry run |
| `signatures` | Dry run only: `intent`, `delegation` and `revoke` |

When `success` is `false`, only the message is returned, not the error code. To branch on codes, call the [client](/docs/sdk-client) methods directly.

## What the agent checks before signing

The agent treats the API as untrusted input. It refuses a quote with `UNSAFE_QUOTE`, before anything is signed, unless all of these hold:

- The delegation target is the ZeroDust contract `0x3732398281d0606aCB7EC1D490dFB0591BE4c4f2`, and the revoke targets address 0. Both signed authorizations are checked for target, chain and nonce before they leave the SDK.
- The EIP-712 domain is `ZeroDust`, version `3`, the source chain, with `verifyingContract` set to the signer's own address (the contract runs as the wallet).
- The signed `user` is the signer, and the destination and destination chain are the ones requested.
- A same-chain sweep is a plain transfer: mode 0, no call target, empty route.
- A cross-chain sweep is a bridge call (mode 1) to a Gas.zip, Relay or Across contract on the allowlist for the source chain. For Gas.zip the route calldata is rebuilt locally and must hash to the signed `routeHash`, which binds the recipient. When the API returns `intent.callData`, its hash must match, Across deposits are decoded (recipient, depositor, destination chain), and a Relay deposit must credit the signer.
- The fee reserve (`maxTotalFeeWei`) is below the balance read from the agent's RPC and at most 1,500,000 gas units at the signed gas price cap plus 5% of that balance. The gas price cap is at most 3 times the gas price read locally. The overhead and protocol fee units are within the contract's maximums.
- The deadline is in the future and at most 60 seconds away (plus 10 seconds of clock skew).

Relay binds its recipient off-chain, and Across can only be checked when the API returns its calldata. For those routes the agent can confirm the bridge contract but not always the recipient. Set `requireVerifiedRoute: true` to refuse them and accept only routes whose recipient was verified.

## Dry run

```ts
const check = await agent.sweep(
  { fromChainId: 42161, toChainId: 8453 },
  { dryRun: true },
);

console.log(check.dryRun);                  // true
console.log(check.sweepId);                 // undefined: nothing was submitted
console.log(check.quote?.estimatedReceive); // what would arrive, in wei
console.log(check.signatures?.intent);      // the signature that would have been sent
```

A dry run uses a real quote and your real key, runs every check and produces all three signatures, then stops before `POST /sweep`. No transaction is broadcast and the balance does not change. It works the same way in `batchSweep()` and `sweepAll()`.

A dry run creates a quote, so it counts toward the quote rate limit (60 per minute per IP).

## batchSweep(request, options?)

Sweeps several chains, one after another, to one destination address.

```ts
const result = await agent.batchSweep({
  sweeps: [
    { fromChainId: 42161 },
    { fromChainId: 10 },
    { fromChainId: 137, toChainId: 42161 },
  ],
  consolidateToChainId: 8453,
  destination: '0xYourDestination',
});

console.log(`${result.successful}/${result.total} succeeded`);
```

`AgentBatchSweepRequest`:

| Field | Default | Notes |
|---|---|---|
| `sweeps` | required | `{ fromChainId, toChainId? }[]` |
| `destination` | `agent.address` | Used for every sweep |
| `consolidateToChainId` | `8453` (Base) | Used when an item has no `toChainId` |
| `continueOnError` | `true` | When `false`, stop at the first failure |

The options are the same as for `sweep()` and apply to each item. The result is `AgentBatchSweepResult`: `total`, `successful`, `failed`, and `results`, where each entry is an `AgentSweepResult` plus `fromChainId` and `toChainId`.

## sweepAll(options, sweepOptions?)

Sweeps every chain where `agent.address` has a balance above 0 to one chain.

```ts
const result = await agent.sweepAll(
  { toChainId: 8453, destination: '0xYourDestination' },
  { dryRun: true },
);
```

| Field | Default | Notes |
|---|---|---|
| `toChainId` | required | Chain that receives everything |
| `destination` | `agent.address` | |
| `continueOnError` | `true` | |

It calls `batchSweep()` with every chain from `getSweepableBalances()`, including `toChainId` itself if it has a balance. Run it as a dry run first to see which chains would sweep.
