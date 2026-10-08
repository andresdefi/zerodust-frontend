// Checks src/direct/l1fee.ts against real receipts: for recent user transactions on each
// 'opguard' chain, the fee computed from the raw signed bytes must equal the receipt's l1Fee.
// Usage: npx tsx scripts/check-l1fee.ts
import { formatTransaction, serializeTransaction, type RpcTransaction } from 'viem';
import { l1FeeOf, hexToBytes, OP_GAS_PRICE_ORACLE, type L1Formula } from '../src/direct/l1fee';

const CHAINS: Array<{ name: string; rpc: string; formula: L1Formula }> = [
  { name: 'Blast', rpc: 'https://rpc.blast.io', formula: 'ecotone' },
  { name: 'Boba', rpc: 'https://mainnet.boba.network', formula: 'fjord' },
];
const SEL = { l1BaseFee: '0x519b4bd3', blobBaseFee: '0xf8206140', baseFeeScalar: '0xc5985918', blobBaseFeeScalar: '0x68d5dca6' } as const;

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result as T;
}

let checked = 0;
let wrong = 0;
for (const c of CHAINS) {
  const head = BigInt(await rpc<string>(c.rpc, 'eth_blockNumber', []));
  const start = checked;
  // Boba is quiet: walk back until 20 transactions or 3,000 blocks
  for (let n = head; n > head - 3000n && checked - start < 20; n--) {
    const block = await rpc<{ transactions: Array<{ hash: string; type: string }> }>(c.rpc, 'eth_getBlockByNumber', [`0x${n.toString(16)}`, true]);
    const user = block.transactions.filter((t) => t.type !== '0x7e').slice(0, 3);
    if (user.length === 0) continue;
    const tag = `0x${n.toString(16)}`;
    const read = async (sel: string) => BigInt(await rpc<string>(c.rpc, 'eth_call', [{ to: OP_GAS_PRICE_ORACLE, data: sel }, tag]));
    const p = { l1BaseFee: await read(SEL.l1BaseFee), blobBaseFee: await read(SEL.blobBaseFee), baseFeeScalar: await read(SEL.baseFeeScalar), blobBaseFeeScalar: await read(SEL.blobBaseFeeScalar) };
    for (const t of user) {
      // The signed bytes, rebuilt from the transaction's fields (Boba's RPC refuses eth_getRawTransactionByHash)
      const [tx, receipt] = await Promise.all([
        rpc<RpcTransaction>(c.rpc, 'eth_getTransactionByHash', [t.hash]),
        rpc<{ l1Fee?: string }>(c.rpc, 'eth_getTransactionReceipt', [t.hash]),
      ]);
      const f = formatTransaction(tx);
      const raw = serializeTransaction({ ...f, data: f.input }, { r: f.r!, s: f.s!, ...(f.type === 'legacy' ? { v: f.v! } : { yParity: f.yParity! }) });
      const mine = l1FeeOf(hexToBytes(raw), c.formula, p);
      const theirs = BigInt(receipt.l1Fee ?? '0x0');
      checked++;
      if (mine !== theirs) { wrong++; console.log(`${c.name} ${t.hash} type ${t.type} ${raw.length / 2 - 1} bytes: computed ${mine}, receipt ${theirs}`); }
    }
  }
  console.log(`${c.name}: ${checked - start} transactions checked; ${wrong} wrong in all so far`);
}
if (wrong > 0 || checked === 0) process.exit(1);
