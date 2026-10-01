# ZeroDust developer docs

ZeroDust moves the entire native gas balance (ETH, BNB, POL and so on) off an EVM chain and leaves the wallet at exactly 0. A normal transfer cannot do this, because paying for the transfer uses the token being sent. ZeroDust sends the funds to any address on the same chain or bridges them to another chain.

## How it works

On chains with EIP-7702, the wallet signs three things and a ZeroDust sponsor executes the sweep and pays the gas up front:

1. An EIP-712 `SweepIntent`: destination, destination chain, route, minimum amount received, fee limits, deadline and nonce.
2. An EIP-7702 authorization that delegates the wallet to the ZeroDust contract `0x3732398281d0606aCB7EC1D490dFB0591BE4c4f2`. The contract is immutable and has the same address on every supported chain.
3. A second EIP-7702 authorization that delegates the wallet to address 0. The sponsor sends it after the sweep, so the wallet does not stay delegated.

The contract runs as the wallet, checks the signed intent, takes the fee reserve, sends the rest to the destination (directly or through a bridge) and requires the final balance to be exactly 0. If it is not 0, the transaction reverts.

What this means for an integration:

- The API never receives a private key. Keys sign locally and only signatures are sent.
- The SDK treats the API as untrusted. `ZeroDustAgent` builds the typed data itself, delegates only to the ZeroDust contract, and checks the destination, route, fees and deadline of every quote before it signs anything. See [Agent](/docs/sdk-agent).
- Chains without EIP-7702 support ("direct chains") are swept by the wallet itself with exact legacy transactions that the API plans but never signs. See [Direct chains](/docs/direct-chains).

## Ways to use ZeroDust

| Option | Use it for |
|---|---|
| Website, [zerodust.xyz](https://zerodust.xyz) | Sweeping a wallet without writing code |
| [TypeScript SDK](/docs/sdk), `@zerodust/sdk` | Apps, scripts and agents that hold their own key |
| [MCP server](/docs/mcp), `@zerodust/mcp-server` | AI clients that speak the Model Context Protocol; a read-only hosted server needs no install |
| [Vercel AI SDK tools](/docs/ai-sdk), `@zerodust/ai-sdk` | Read-only tools for `generateText` and `streamText` |
| [LangChain tools](/docs/langchain), `@zerodust/langchain` | Read-only tools for LangChain agents |
| [REST API](/docs/api), `https://api.zerodust.xyz` | Any language |

## Supported chains

As of 1 October 2026 the live API lists:

- 45 EIP-7702 chains, swept by the sponsor (`GET /chains`). Each entry's `crossChain.available` says whether a bridge currently accepts it as a cross-chain source.
- 10 direct chains, swept by the wallet itself (`GET /direct/chains`).
- Cross-chain destinations are not limited to ZeroDust chains: any EVM chain a bridge delivers native gas to qualifies. From Base there are 109 (`GET /destinations?fromChainId=8453`).

These numbers change. Read them from the API rather than hardcoding them.

## Fees

The service fee depends on the USD value of the balance being swept:

| Balance | Service fee |
|---|---|
| Under $1 | 5% of the balance, no minimum |
| $1 and above | 1% of the balance, at least $0.05 and at most $0.50 |

On top of the service fee the sweep pays its gas (including the revoke transaction and, on rollups, the L1 data fee) and, for cross-chain sweeps, the bridge's fee. Every quote shows the total before anything is signed. The [REST API](/docs/api) page explains the fee fields of a quote.

## Pages

- [Getting started](/docs/getting-started): first sweep with the SDK, dry run first.
- [SDK overview](/docs/sdk): install, configuration, what the package exports.
- [Agent](/docs/sdk-agent): `ZeroDustAgent`, sweeps, dry runs, batches and the checks before signing.
- [API client](/docs/sdk-client): the `ZeroDust` class, one method per API call.
- [Errors](/docs/sdk-errors): `ZeroDustError` and error codes.
- [REST API](/docs/api): every public endpoint, parameters, responses and rate limits.
- [Direct chains](/docs/direct-chains): planning endpoints for chains without EIP-7702.
- [MCP server](/docs/mcp): stdio package and hosted server.
- [Vercel AI SDK](/docs/ai-sdk): `@zerodust/ai-sdk`.
- [LangChain](/docs/langchain): `@zerodust/langchain`.
