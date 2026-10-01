# MCP server

ZeroDust has two Model Context Protocol servers:

| | Hosted | Package |
|---|---|---|
| Where | `https://api.zerodust.xyz/mcp` | `@zerodust/mcp-server` (0.4.1), run locally over stdio |
| Install | None | `npx @zerodust/mcp-server` |
| Read tools | Yes | Yes |
| Sweeping | No (it holds no keys) | Yes, when enabled with a key you configure |

## Package setup

Requires Node.js 18 or later. Add the server to your MCP client's configuration. For Claude Desktop this is `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS:

```json
{
  "mcpServers": {
    "zerodust": {
      "command": "npx",
      "args": ["@zerodust/mcp-server"]
    }
  }
}
```

Without further settings the server is read-only. It is also listed in the MCP registry as `io.github.andresdefi/zerodust`.

### Environment variables

| Variable | Default | Notes |
|---|---|---|
| `ZERODUST_API_URL` | `https://api.zerodust.xyz` | |
| `ZERODUST_API_KEY` | none | Sent as `x-api-key`. Raises the API's rate limits; see [API keys](/docs/api#api-keys). |
| `ZERODUST_ALLOW_EXECUTE` | unset | Set to `true` to allow sweeps. Needs exactly one signing key below. |
| `ZERODUST_ALLOWED_DESTINATIONS` | unset | Comma-separated addresses the agent may sweep to, besides its own |
| `ZERODUST_RPC_URLS` | unset | Your own RPCs for the sweep tools, as `chainId=url` pairs separated by commas (package 0.5.0 and later) |

Signing key, exactly one of:

| Variable | Notes |
|---|---|
| `ZERODUST_SIGNER_MODULE` | Path or package name of a module that returns a viem `LocalAccount` (see below) |
| `ZERODUST_KEYSTORE_FILE` | Encrypted V3 keystore (as written by `cast wallet import` or geth), with `ZERODUST_KEYSTORE_PASSWORD_FILE` (preferred) or `ZERODUST_KEYSTORE_PASSWORD` |
| `ZERODUST_PRIVATE_KEY_FILE` | File containing a hex private key |
| `ZERODUST_PRIVATE_KEY` | Hex private key inline. The key then sits in your MCP config file; use it only for a throwaway wallet. |

The server refuses to start when a key is set without `ZERODUST_ALLOW_EXECUTE=true`, when `ZERODUST_ALLOW_EXECUTE=true` is set without a key, when more than one key is set, or when an allowlist entry is not an address.

The key is used locally to sign the EIP-712 intent and the two EIP-7702 authorizations. It is never sent; only signatures reach the API. Sweeps use `ZeroDustAgent` from `@zerodust/sdk`, so every quote passes the [pre-signing checks](/docs/sdk-agent) first.

### Enabling sweeps

```json
{
  "mcpServers": {
    "zerodust": {
      "command": "npx",
      "args": ["@zerodust/mcp-server"],
      "env": {
        "ZERODUST_ALLOW_EXECUTE": "true",
        "ZERODUST_KEYSTORE_FILE": "/path/to/agent-keystore.json",
        "ZERODUST_KEYSTORE_PASSWORD_FILE": "/path/to/agent-keystore.pass"
      }
    }
  }
}
```

Relative paths resolve against the server's working directory, which the MCP client decides. Absolute paths are safer.

### Signer module

The way to use a custody provider (Turnkey, Privy, a KMS) without a raw key anywhere. The module's default export may be a function (sync or async) that returns the account, or the account itself; a named `createAccount` function also works.

```ts
// my-signer.ts, compiled to my-signer.js
import type { LocalAccount } from 'viem';

// Stands in for your custody provider's SDK
declare const myProvider: { toViemAccount(): Promise<LocalAccount> };

export default async function createAccount(): Promise<LocalAccount> {
  // Build a viem LocalAccount with your provider's SDK.
  return await myProvider.toViemAccount();
}
```

The account must have `address`, `signTypedData` and `signAuthorization`. It is loaded on first use, and the server reports a clear error if any of these is missing.

### Destination allowlist

By default the agent can only sweep to its own address. This limits what a prompt-injected agent can do: it cannot send funds to an address the operator never approved. Every address in `ZERODUST_ALLOWED_DESTINATIONS` can receive the agent's entire balance on every chain, so list only addresses you control.

## Tools

| Tool | Hosted | Package | Inputs |
|---|---|---|---|
| `zerodust_info` | Yes | Yes | none |
| `zerodust_get_chains` | Yes | Yes | none |
| `zerodust_get_destinations` | Yes | Yes | `fromChainId` |
| `zerodust_get_balances` | Yes | Yes | `address` |
| `zerodust_get_quote` | Yes | Yes | `fromChainId`, `toChainId`, `userAddress`, `destination` |
| `zerodust_get_sweep_status` | Yes | Yes | `sweepId` |
| `zerodust_list_sweeps` | Yes | Yes | `address`, optional `limit` (1 to 100) |
| `zerodust_register_api_key` | Yes | Yes | `name`, optional `agentId`, `contactEmail` |
| `zerodust_get_agent_address` | No | Yes | none |
| `zerodust_sweep` | No | Yes | `fromChainId`, `toChainId`, optional `destination`, `dryRun` |
| `zerodust_sweep_all` | No | Yes | `toChainId`, optional `destination`, `dryRun` |

The package always lists the three sweep tools. Without `ZERODUST_ALLOW_EXECUTE` and a key they return an error that explains how to enable them, and move nothing.

- `zerodust_get_agent_address`: the signing address, where the key comes from, and the permitted destinations. Call it before a sweep to confirm which wallet will be emptied.
- `zerodust_sweep`: empties one chain. `destination` defaults to the agent's own address and must pass the allowlist.
- `zerodust_sweep_all`: empties every chain with a balance onto `toChainId`.
- `dryRun: true` on either sweep tool runs the whole flow, including the three signatures, and stops before submitting. Nothing moves. Use it first.

The sweep tools use the SDK's public RPC for each chain. To use your own, set `ZERODUST_RPC_URLS` to `chainId=url` pairs, for example `8453=https://base.example/rpc,42161=https://arb.example/rpc`. A malformed entry stops the server at startup rather than falling back silently.

## Hosted server

`POST https://api.zerodust.xyz/mcp` takes JSON-RPC 2.0 (`initialize`, `ping`, `tools/list`, `tools/call`). It supports protocol versions `2025-06-18`, `2025-03-26` and `2024-11-05`.

```bash
curl -s https://api.zerodust.xyz/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

`GET /mcp` returns server info and the tool list; `GET /mcp/tools` returns the full tool definitions. Requests count against the API's per-IP rate limits.

## Example prompts

- "Which chains does ZeroDust support?"
- "Check my balances on 0x..."
- "Quote sweeping my Arbitrum balance to Base"
- "Do a dry run of sweeping my Arbitrum balance to Base" (moves nothing)
- "Sweep my Arbitrum balance to Base"
