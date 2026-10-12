// Records the RPC answers sweep/claims.ts reads for real withdrawals, one at each stage, so
// tests/claims.test.ts replays them offline. Read-only: nothing is signed or sent. Each prove or
// claim call it records was also estimated on Ethereum from a random address (estimateGas passing
// means the call would succeed); the estimates go into the fixture.
//   npx tsx scripts/record-claim-fixtures.mts
import { writeFileSync } from 'node:fs';
import { keccak256, type Hex } from 'viem';
import { claimCall, claimState, l1, proveCall, readWithdrawal } from '../src/sweep/claims';

const CASES: Array<{ name: string; chainId: number; txHash: Hex }> = [
  // ZeroDust's own test withdrawals (2026-10-10/12)
  { name: 'lisk proved, waiting', chainId: 1135, txHash: '0x3ac5978bc6ab565571c47a02735c219922c84b8ab5e6f77fc7371a287a392ae5' },
  { name: 'blast claimed', chainId: 81457, txHash: '0xb73a80d0c1701adef2d8e979223e384ab448006c329aa6c8f9dd8174e3bf03df' },
  { name: 'abstract claimed', chainId: 2741, txHash: '0xcd00ec6951cd7de4d0c4ff054f39934031193361f94866b456193e23a6856382' },
  { name: 'nova waiting', chainId: 42170, txHash: '0xb7c4317ef1b8eb218be459e2d4301c63b44152ebcbfd527fd49b1ae65862c2a8' },
  { name: 'gravity waiting (G)', chainId: 1625, txHash: '0x44fd4235a20e0aeb6b8a7bfdcb5bf0f98993e4dee29344fc789ba34681b4eae2' },
  // Other people's open withdrawals, for the prove and claim calls
  { name: 'lisk ready to prove', chainId: 1135, txHash: '0x79c1defdafceed9228afdd2cfd4013189a9743a59271b8d6be2cb91f3fe310d6' },
  { name: 'lisk ready to claim', chainId: 1135, txHash: '0xd3fe47043eaa6edfbde3fdc2ed67725460478fac3a1f5939135b338434272317' },
  { name: 'blast ready to prove', chainId: 81457, txHash: '0xf8f87960e44d5cbcbe4d4b053429de61e42c4a8d7bda0dcb8dca5ede4943af6d' },
  { name: 'blast ready to claim', chainId: 81457, txHash: '0x47997fdabe39a3801544c7bd5b1d12927c0af20a5ac37d6a4d052f797de19a63' },
  { name: 'nova ready to claim', chainId: 42170, txHash: '0x5005738cf3298408f5df57983f37db4c9796187ec04ab58c8331ceb0703070c3' },
  { name: 'abstract ready to claim', chainId: 2741, txHash: '0x29c765a0c4bb0746abd4c5c20579f42f8458696e5b0f2f7ec80e6e866e8445fd' },
  { name: 'fraxtal ready to prove', chainId: 252, txHash: '0xfd31580dbff577c68ba9ad1ccbb2242b2ec53c50590a248d67ccbbcaf22d58b1' },
  { name: 'fraxtal ready to claim', chainId: 252, txHash: '0x6f6375bd500c72a5291c48005f5efbb89494ff248113be3c51ce7c61c6c88148' },
  // Taiko: delivered by its relayer (a withdrawal of 2026-10-12, someone else's)
  { name: 'taiko delivered', chainId: 167000, txHash: '0x6c81f53469d6e8dc1a8d7847f725238b6f89c3dc2c557d78a8dae56da07a3cda' },
];

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
for (const c of CASES) {
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
  out.push({ ...c, recipient: w.recipient, amount: w.amount.toString(), state, call });
}

writeFileSync('tests/fixtures/claims-2026-10-12.json', `${JSON.stringify({ recordedAt: new Date(now).toISOString(), now, cases: out, responses }, null, 1)}\n`);
