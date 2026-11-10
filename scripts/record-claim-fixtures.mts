// Records the RPC answers sweep/claims.ts reads for real withdrawals, one at each stage, so
// tests/claims.test.ts replays them offline. Read-only: nothing is signed or sent. Each prove or
// claim call it records was also estimated on Ethereum from a random address (estimateGas passing
// means the call would succeed); the estimates go into the fixture.
//   npx tsx scripts/record-claim-fixtures.mts
// With a name prefix (`... metal`), records only those cases and adds them to the file, each with its
// own `now`: the other cases' stages have moved on since they were recorded.
import { readFileSync, writeFileSync } from 'node:fs';
import { keccak256, type Hex } from 'viem';
import { claimCall, claimState, l1, proveCall, readWithdrawal } from '../src/sweep/claims';

const CASES: Array<{ name: string; chainId: number; txHash: Hex }> = [
  // ZeroDust's own test withdrawals (2026-10-10/12)
  { name: 'abstract claimed', chainId: 2741, txHash: '0xcd00ec6951cd7de4d0c4ff054f39934031193361f94866b456193e23a6856382' },
  { name: 'nova waiting', chainId: 42170, txHash: '0xb7c4317ef1b8eb218be459e2d4301c63b44152ebcbfd527fd49b1ae65862c2a8' },
  // Other people's open withdrawals, for the prove and claim calls
  { name: 'nova ready to claim', chainId: 42170, txHash: '0x5005738cf3298408f5df57983f37db4c9796187ec04ab58c8331ceb0703070c3' },
  { name: 'abstract ready to claim', chainId: 2741, txHash: '0x29c765a0c4bb0746abd4c5c20579f42f8458696e5b0f2f7ec80e6e866e8445fd' },
  { name: 'fraxtal ready to prove', chainId: 252, txHash: '0xfd31580dbff577c68ba9ad1ccbb2242b2ec53c50590a248d67ccbbcaf22d58b1' },
  { name: 'fraxtal ready to claim', chainId: 252, txHash: '0x6f6375bd500c72a5291c48005f5efbb89494ff248113be3c51ce7c61c6c88148' },
  // Taiko: delivered by its relayer (a withdrawal of 2026-10-12, someone else's)
  { name: 'taiko delivered', chainId: 167000, txHash: '0x6c81f53469d6e8dc1a8d7847f725238b6f89c3dc2c557d78a8dae56da07a3cda' },
  // Metal L2: dispute games, the portal RISE and Codex also use (recorded 2026-11-10, other people's)
  { name: 'metal proved, waiting', chainId: 1750, txHash: '0x6315305d2d705387279bb0c470c23049d22ff1475dd4a252214c7f47fecf9f9f' },
  { name: 'metal ready to prove', chainId: 1750, txHash: '0x27f2ed6466c068cb68650d8317dc76ed6cf433b1686580212bf79af04fe0d6c5' },
  { name: 'metal ready to claim', chainId: 1750, txHash: '0x4b4e013bb6c69688cfc348696ff8e5b739c4f86f1c6f91e6d464f2f46dac3ca1' },
];
const only = process.argv[2];
const FILE = 'tests/fixtures/claims-2026-10-12.json';

const FROM = '0x000000000000000000000000000000000000dEaD';
const responses: Record<string, unknown> = {};
const realFetch = globalThis.fetch;
/** Off while estimating: the estimate is evidence, not something the test replays */
let recording = true;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const res = await realFetch(input, init);
  if (!recording) return res;
  const url = String(input instanceof Request ? input.url : input);
  const body = JSON.parse(String(init?.body ?? 'null')) as { method: string; params?: unknown[] };
  const json = await res.clone().json() as { result?: unknown; error?: unknown };
  responses[`${new URL(url).origin} ${body.method} ${JSON.stringify(body.params ?? [])}`] = json.error ? { error: json.error } : { result: json.result };
  return res;
}) as typeof fetch;

const now = Date.now();
const out = [];
for (const c of CASES.filter((x) => !only || x.name.startsWith(only))) {
  const w = await readWithdrawal(c.chainId, c.txHash);
  if (!w) throw new Error(`${c.name}: no withdrawal`);
  const state = await claimState(w, now);
  let call: { step: string; to: string; dataHash: Hex; gas: string } | undefined;
  if (state.stage === 'prove' || state.stage === 'claim') {
    const built = state.stage === 'prove' ? await proveCall(w) : await claimCall(w);
    recording = false;
    const gas = await l1().estimateGas({ account: FROM, to: built.to, data: built.data });
    recording = true;
    call = { step: state.stage, to: built.to, dataHash: keccak256(built.data), gas: gas.toString() };
  }
  console.log(c.name, state.stage, call?.gas ?? '');
  out.push({ ...c, ...(only ? { now } : {}), recipient: w.recipient, amount: w.amount.toString(), state, call });
}

let file: unknown = { recordedAt: new Date(now).toISOString(), now, cases: out, responses };
if (only) {
  const old = JSON.parse(readFileSync(FILE, 'utf8')) as { cases: Array<{ name: string }>; responses: Record<string, unknown> };
  // The older answers stay: the cases recorded with them replay them
  file = { ...old, cases: [...old.cases.filter((x) => !x.name.startsWith(only)), ...out], responses: { ...responses, ...old.responses } };
}
writeFileSync(FILE, `${JSON.stringify(file, null, 1)}\n`);
