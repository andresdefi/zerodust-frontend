# Getting started

This page sweeps one chain with the SDK's `ZeroDustAgent`, which signs locally with a key you control. Run a dry run first: it does everything except submit, so nothing moves.

## Before you start

- Node.js 18 or later.
- A wallet with a balance on a [supported chain](/docs/api) (`GET /chains`).
- The wallet's private key, kept in a secrets store or an environment variable. Never put a key in source code or commit it.

## 1. Install

```bash
npm install @zerodust/sdk viem
```

`viem` is a peer dependency.

## 2. Create an agent

```ts
import { ZeroDustAgent } from '@zerodust/sdk';
import { privateKeyToAccount } from 'viem/accounts';

const agent = new ZeroDustAgent({
  account: privateKeyToAccount(process.env.ZERODUST_PRIVATE_KEY as `0x${string}`),
  environment: 'mainnet',
});

console.log('Sweeping from', agent.address);
```

The key never leaves the process. The agent sends only signatures to the API.

## 3. Find what can be swept

```ts
const sweepable = await agent.getSweepableBalances();
for (const b of sweepable) {
  console.log(b.chainId, b.name, b.balanceFormatted, b.nativeToken);
}
```

A balance shows as sweepable when it is above 0. Whether it covers the fees is decided by the quote.

## 4. Dry run

```ts
const check = await agent.sweep(
  { fromChainId: 42161, toChainId: 8453, destination: '0xYourDestination' },
  { dryRun: true },
);

if (!check.success) throw new Error(check.error);
console.log('Would receive (wei):', check.quote?.estimatedReceive);
```

A dry run fetches a real quote, verifies it, and produces all three signatures with your key, then stops before `POST /sweep`. Nothing is broadcast. If the quote fails a safety check, `success` is `false` and nothing was signed.

`destination` defaults to the agent's own address. Here the balance on Arbitrum (42161) is bridged to Base (8453). For a same-chain sweep, set `toChainId` to `fromChainId` and use a different destination address.

## 5. Sweep

```ts
const result = await agent.sweep({
  fromChainId: 42161,
  toChainId: 8453,
  destination: '0xYourDestination',
});

if (result.success) {
  console.log('Sweep', result.sweepId, 'tx', result.txHash);
} else {
  console.error('Sweep failed:', result.error);
}
```

By default `sweep()` waits up to 120 seconds for the sweep to reach `completed` or `failed`.

## 6. Check the result on-chain

The API reports status, but the chain is the source of truth. A sweep is done when:

- the source balance is 0,
- the wallet has no code again (the delegation was revoked), and
- the funds arrived at the destination.

```ts
import { createPublicClient, http } from 'viem';
import { arbitrum } from 'viem/chains';

const source = createPublicClient({ chain: arbitrum, transport: http() });
console.log('Balance:', await source.getBalance({ address: agent.address })); // 0n
console.log('Code:', await source.getCode({ address: agent.address }));       // undefined once revoked
```

The revoke is a separate transaction sent after the sweep, so the code can still be set for a short time after the sweep completes. `getSweepStatus()` reports it as `revokeStatus`.

## Next

- [Agent](/docs/sdk-agent): batch sweeps, `sweepAll()`, custom RPC URLs, and the checks the agent runs before signing.
- [API client](/docs/sdk-client): call each endpoint yourself.
- [MCP server](/docs/mcp): give an AI client the same abilities.
