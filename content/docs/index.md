# ZeroDust developer docs

ZeroDust moves the entire native gas balance (ETH, BNB, POL and so on) off an EVM chain and leaves the wallet at exactly 0. A normal transfer cannot do this, because paying for the transfer uses the token being sent. ZeroDust sends the funds to any address on the same chain or bridges them to another chain.

## How it works

There are two ways to sign a sweep on a sponsored chain: with the wallet's key (EIP-7702, below), or through MetaMask without the key ([with MetaMask](#with-metamask)). Either way a ZeroDust sponsor executes the sweep and pays the gas, reimbursed from the swept balance, and the transaction reverts unless the wallet ends at exactly 0.

### With the key

On chains with EIP-7702, the wallet signs three things and a ZeroDust sponsor executes the sweep and pays the gas up front:

1. An EIP-712 `SweepIntent`: destination, destination chain, route, minimum amount received, fee limits, deadline and nonce.
2. An EIP-7702 authorization that delegates the wallet to the ZeroDust contract `0x3732398281d0606aCB7EC1D490dFB0591BE4c4f2`. The contract is immutable and has the same address on every supported chain.
3. A second EIP-7702 authorization that delegates the wallet to address 0. The sponsor sends it after the sweep, so the wallet does not stay delegated.

The contract runs as the wallet, checks the signed intent, takes the fee reserve, sends the rest to the destination (directly or through a bridge) and requires the final balance to be exactly 0. If it is not 0, the transaction reverts.

### With MetaMask

The website's main flow. MetaMask's Advanced Permissions (ERC-7715, MetaMask 13.23 or later) let the wallet grant a narrow permission instead of handing over a key:

1. **One permission request for every chain.** The page asks `wallet_requestExecutionPermissions` for a one-time `native-token-allowance` per chain, equal to that chain's balance, valid 10 minutes. The ZeroDust permission router `0x369A97dd256F7eb37fF7116C4EcBd50318eBb286` is the delegate, the only redeemer and the only payee.
2. **What MetaMask shows**, chain by chain: the first time on a chain, "switch to smart account" (MetaMask's own EIP-7702 upgrade, a little gas paid from that chain's balance); then Grant and Confirm for the permission.
3. **One signature for every chain.** An EIP-712 `SweepBatch` holding one `SweepIntent` per chain, with no chain id in the domain, so MetaMask signs it without switching networks.
4. **The sponsor sweeps each chain** through the router: it redeems the permission through MetaMask's DelegationManager (`0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3`), requires the wallet to end at exactly 0, then pays out exactly as the ZeroDust contract does.

How it differs from the key flow:

- No revoke. The wallet keeps MetaMask's smart-account delegation, which is MetaMask's normal state. The allowance is used up by the sweep and expires anyway.
- Cross-chain only through bridges that take the refund address and recipient as explicit parameters (Relay, Across for ETH to ETH, Hyperlane). The router is the bridge's caller, so Gas.zip, which refunds to its caller, is never used here.
- The router is on 16 chains: Ethereum, OP Mainnet, BNB Chain, Gnosis, Unichain, Polygon, Sonic, Robinhood Chain, Mantle, Arc, Base, Arbitrum, Celo, Linea, Berachain and Katana. Other chains need the key.
- The SDK does not support this flow yet. The [REST API](/docs/api#with-metamask) does.

### What this means for an integration

- The API never receives a private key. Keys sign locally and only signatures are sent.
- The SDK treats the API as untrusted. `ZeroDustAgent` builds the typed data itself, delegates only to the ZeroDust contract, and checks the destination, route, fees and deadline of every quote before it signs anything. See [Agent](/docs/sdk-agent).
- Chains without EIP-7702 support ("direct chains") are swept by the wallet itself with exact legacy transactions that the API plans but never signs. See [Direct chains](/docs/direct-chains).

## What arrives

A sweep delivers the destination chain's own gas token, never a wrapped token or a stablecoin: Avalanche to Base is AVAX in, ETH out; Base to BNB Chain is ETH in, BNB out.

- Bridges that deliver native gas directly carry every pair: Gas.zip, Relay, and Across where both chains' gas is ETH.
- Across is used only for ETH to ETH, as a plain deposit (no swap) to a wallet with no contract code or an EIP-7702 delegation. On other routes Across converts through USDC, USDT or WETH, and if that conversion fails or leaves a remainder it pays the remainder in that token; it also pays WETH instead of ETH to a contract. ZeroDust does not use it there.

ZeroDust picks the route; the bridge does the delivery. If a bridge fails, it refunds under its own rules, usually to the sweeping wallet on the source chain, so that chain is no longer at 0.

Two chains are the exception, because no bridge carries their gas token as gas:

| Source | Arrives as | Bridge | Recipient |
|---|---|---|---|
| Mitosis (124816), MITO | MITO, an ERC-20 token on BNB Chain | Hyperlane | Any address |
| Endurance (648), ACE | ACE, an ERC-20 token on BNB Chain | Endurance's bridge | The sweeping wallet only (`OWN_WALLET_ONLY` otherwise) |

A quote for these routes carries `receiveToken` (symbol, address, decimals), and `estimatedReceive` is in that token. The site says plainly that a token arrives, before you confirm.

## Ways to use ZeroDust

| Option | Use it for |
|---|---|
| Website, [zerodust.xyz](https://zerodust.xyz) | Sweeping a wallet without writing code, with MetaMask or the wallet's key |
| [TypeScript SDK](/docs/sdk), `@zerodust/sdk` | Apps, scripts and agents that hold their own key |
| [MCP server](/docs/mcp), `@zerodust/mcp-server` | AI clients that speak the Model Context Protocol; a read-only hosted server needs no install |
| [Vercel AI SDK tools](/docs/ai-sdk), `@zerodust/ai-sdk` | Read-only tools for `generateText` and `streamText` |
| [LangChain tools](/docs/langchain), `@zerodust/langchain` | Read-only tools for LangChain agents |
| [REST API](/docs/api), `https://api.zerodust.xyz` | Any language |

## Supported chains

As of 8 October 2026 ZeroDust sweeps 73 chains:

- 52 EIP-7702 chains, swept by the sponsor (`GET /chains`). Each entry's `crossChain.available` says whether a bridge currently accepts it as a cross-chain source.
- 21 direct chains, swept by the wallet itself (`GET /direct/chains`).
- 16 of the EIP-7702 chains can also be swept with MetaMask, without the key.
- Cross-chain destinations are not limited to ZeroDust chains: any EVM chain a bridge delivers native gas to qualifies. From Base there are 107 (`GET /destinations?fromChainId=8453`).

These numbers change. Read them from the API rather than hardcoding them.

## Fees

The service fee depends on the USD value of the balance being swept:

| Balance | Service fee |
|---|---|
| Under $1 | 5% of the balance, no minimum |
| $1 and above | 1% of the balance, at least $0.05 and at most $0.50 |

On top of the service fee the sweep pays its gas (including the revoke transaction with the key, the permission redemption with MetaMask, and on rollups the L1 data fee) and, for cross-chain sweeps, the bridge's fee. Every quote shows the total before anything is signed. The [REST API](/docs/api) page explains the fee fields of a quote.

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
