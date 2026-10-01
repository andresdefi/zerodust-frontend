# LangChain tools

`@zerodust/langchain` (0.1.1) gives a LangChain agent read-only ZeroDust tools: chains, balances, quotes and sweep status. The tools never sign and cannot move funds. To let an agent sweep, use [`ZeroDustAgent`](/docs/sdk-agent) or the [MCP server](/docs/mcp).

## Install

```bash
npm install @zerodust/langchain @langchain/core zod
```

Peer dependencies: `@langchain/core` `>=0.2.0` and `zod` `>=3.22.0` (built against `@langchain/core` 0.3). It installs its own `@zerodust/sdk` 0.1.x for the API calls.

## Usage

`createZeroDustTools(config?)` returns an array of `DynamicStructuredTool`, usable with any LangChain agent.

```ts
import { createZeroDustTools } from '@zerodust/langchain';
import { ChatOpenAI } from '@langchain/openai';
import { AgentExecutor, createToolCallingAgent } from 'langchain/agents';
import { ChatPromptTemplate } from '@langchain/core/prompts';

const tools = createZeroDustTools({ environment: 'mainnet' });

const llm = new ChatOpenAI({ model: 'gpt-4o' });
const prompt = ChatPromptTemplate.fromMessages([
  ['system', 'You are a helpful blockchain assistant.'],
  ['human', '{input}'],
  ['placeholder', '{agent_scratchpad}'],
]);

const agent = createToolCallingAgent({ llm, tools, prompt });
const executor = new AgentExecutor({ agent, tools });

const result = await executor.invoke({ input: 'Check my balances on 0x...' });
```

Any chat model with tool calling works; `@langchain/openai` is only an example.

The config takes the [SDK client options](/docs/sdk): `environment`, `baseUrl`, `apiKey`, `timeout`, `retries`.

## Tools

Each tool returns a text summary.

| Tool | Input | Returns |
|---|---|---|
| `zerodust_info` | none | Description of the service, fees and integrations |
| `zerodust_get_chains` | none | Enabled chains with chain ID and native token |
| `zerodust_get_balances` | `address` | Sweepable balances, and non-zero balances listed as too small |
| `zerodust_get_quote` | `fromChainId`, `toChainId`, `userAddress`, `destination` | Quote ID, balance, estimated receive, mode, max total fee (wei), validity |
| `zerodust_get_sweep_status` | `sweepId` | Status, type, chains, destination, and transaction hash, tracking URL or error when present |
| `zerodust_list_sweeps` | `address`, optional `limit` (1 to 100, default 10) | Past sweeps with status, amounts and hashes |
