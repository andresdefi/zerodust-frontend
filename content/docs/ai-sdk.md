# Vercel AI SDK tools

`@zerodust/ai-sdk` (0.1.1) gives a Vercel AI SDK model read-only ZeroDust tools: chains, balances, quotes and sweep status. The tools never sign and cannot move funds. To let an agent sweep, use [`ZeroDustAgent`](/docs/sdk-agent) or the [MCP server](/docs/mcp).

## Install

```bash
npm install @zerodust/ai-sdk ai zod
```

Peer dependencies: `ai` `>=3.0.0` and `zod` `>=3.22.0`. The package is built against `ai` 4: it defines tools with `tool()` and `parameters`, and returns `Record<string, CoreTool>`. It installs its own `@zerodust/sdk` 0.1.x for the API calls.

## Usage

```ts
import { createZeroDustTools } from '@zerodust/ai-sdk';
import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';

const tools = createZeroDustTools({ environment: 'mainnet' });

const result = await generateText({
  model: openai('gpt-4o'),
  tools,
  prompt: 'Which of my chains can be swept? My address is 0x...',
});
```

The same `tools` object works with `streamText`. Any model provider works; `@ai-sdk/openai` is only an example.

`createZeroDustTools(config?)` takes the [SDK client options](/docs/sdk): `environment`, `baseUrl`, `apiKey`, `timeout`, `retries`.

## Tools

Each tool returns a plain object.

| Tool | Input | Returns |
|---|---|---|
| `zerodust_info` | none | Static description of the service, fees and integrations |
| `zerodust_get_chains` | none | `count`, `chains` (`chainId`, `name`, `nativeToken`) for enabled chains |
| `zerodust_get_balances` | `address` | `sweepable` and `tooSmall`, each with `chainId`, `name`, `nativeToken`, `balance` (formatted) |
| `zerodust_get_quote` | `fromChainId`, `toChainId`, `userAddress`, `destination` | `quoteId`, `userBalance`, `estimatedReceive`, `mode` (`'same-chain'` or `'cross-chain'`), `maxTotalFee` (wei), `validForSeconds`, `note` |
| `zerodust_get_sweep_status` | `sweepId` | `sweepId`, `status`, `sweepType`, `fromChainId`, `toChainId`, `destination`, `txHash`, `bridgeTrackingUrl`, `errorMessage` |
| `zerodust_list_sweeps` | `address`, optional `limit` (1 to 100, default 10) | `total`, `sweeps` |

The fee text in `zerodust_info` 0.1.1 predates the current schedule (it says sweeps under $1 have no service fee). The current fees are on the [overview](/docs): 5% under $1, and 1% from $1 with a minimum of $0.05 and a maximum of $0.50.
