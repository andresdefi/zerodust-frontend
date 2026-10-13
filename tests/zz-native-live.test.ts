// TEMPORARY, never committed: real-funds native-exit test of the throwaway wallet through the page's own signing code.
import { readFileSync, appendFileSync } from 'node:fs';
import { decodeFunctionData, parseAbi, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { it } from 'vitest';
import { API_URL } from '../src/sweep/constants';
import { broadcast, settledBalance, signPlan } from '../src/direct/run';
import type { DirectPlan } from '../src/direct/plan';

const DIR = process.env.NATIVE_DIR!;
const CHAIN = Number(process.env.NATIVE_CHAIN);
const SEND = process.env.NATIVE_SEND === '1';

it.skipIf(!process.env.NATIVE_DIR)('native exit', async () => {
  const account = privateKeyToAccount(readFileSync(`${DIR}/test-key`, 'utf8').trim() as Hex);
  const q = new URLSearchParams({ chainId: String(CHAIN), toChainId: '1', from: account.address, recipient: account.address, bridge: 'native' });
  const res = await fetch(`${API_URL}/direct/prepare?${q}`);
  const plan = (await res.json()) as DirectPlan & { error?: string };
  if (!res.ok) throw new Error(`prepare: ${res.status} ${JSON.stringify(plan)}`);
  console.log('route', plan.route, 'balance', plan.balance, 'fee', plan.fee, 'receive', plan.receive, 'txs', plan.txs.map((t) => `${t.kind}->${t.to} value ${t.value} gas ${t.gas}`));
  // Own checks: the native call names this wallet as the recipient on Ethereum
  const last = plan.txs.at(-1)!;
  if (plan.guard) {
    const inner = decodeFunctionData({ abi: parseAbi(['function bridgeETHTo(address _to, uint32 _minGasLimit, bytes _extraData) payable']), data: plan.guard.data as Hex });
    if (plan.guard.target.toLowerCase() !== '0x4200000000000000000000000000000000000010' || inner.args[0].toLowerCase() !== account.address.toLowerCase()) throw new Error('guard target or recipient wrong');
  } else if (last.to.toLowerCase() === '0x0000000000000000000000000000000000000064') {
    const inner = decodeFunctionData({ abi: parseAbi(['function withdrawEth(address destination) payable returns (uint256)']), data: last.data as Hex });
    if (inner.args[0].toLowerCase() !== account.address.toLowerCase()) throw new Error('arb recipient wrong');
  } else {
    const inner = decodeFunctionData({ abi: parseAbi(['function withdraw(address _l1Receiver) payable']), data: last.data as Hex });
    if (last.to.toLowerCase() !== '0x000000000000000000000000000000000000800a' || inner.args[0].toLowerCase() !== account.address.toLowerCase()) throw new Error('zk target or recipient wrong');
  }
  const raws = await signPlan(account, plan);
  console.log('signed', raws.length, 'transaction(s)');
  if (!SEND) { console.log('dry run: not sent'); return; }
  const sent = await broadcast(plan, raws, (hash, i) => console.log('sent', i, hash));
  console.log('broadcast', JSON.stringify(sent).slice(0, 400));
  appendFileSync(`${DIR}/native-runs.log`, `${new Date().toISOString()} chain ${CHAIN} ${JSON.stringify(sent)}\n`);
  const after = await settledBalance(CHAIN, account.address, true);
  console.log('balance after', after.toString());
}, 600_000);
