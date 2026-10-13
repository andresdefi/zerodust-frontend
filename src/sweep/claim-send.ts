// Sending a prove or claim transaction (sweep/claims.ts) on the withdrawal's parent chain (Ethereum,
// or BNB Chain for opBNB): from MetaMask (any account,
// no Advanced Permissions needed) or from a key typed into the page. Either way it is a plain
// transaction to the pinned bridge contract with no value; the funds go to the withdrawal's
// recipient whoever sends it.
import { toHex, type Address, type Hex, type LocalAccount } from 'viem';
import { parent, parentChainId, type L1Call } from './claims';
import type { Eip1193Provider } from './metamask';

export type Payer =
  | { kind: 'metamask'; provider: Eip1193Provider; address: Address }
  | { kind: 'key'; account: LocalAccount };

export const payerAddress = (p: Payer): Address => (p.kind === 'key' ? p.account.address : p.address);

export interface CallQuote {
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  /** The most it can cost: gas at the max fee */
  maxCostWei: bigint;
  /** What it should cost at today's base fee */
  costWei: bigint;
  balance: bigint;
}

/** Gas (estimated from the payer, so a call that would fail fails here) and what the payer has; `chainId` is the withdrawal's chain */
export async function quoteCall(chainId: number, call: L1Call, from: Address): Promise<CallQuote> {
  const l1 = () => parent(chainId);
  const [estimate, fees, block, balance] = await Promise.all([
    l1().estimateGas({ account: from, to: call.to, data: call.data }),
    l1().estimateFeesPerGas(),
    l1().getBlock(),
    l1().getBalance({ address: from }),
  ]);
  const gas = (estimate * 12n) / 10n;
  const base = block.baseFeePerGas ?? fees.maxFeePerGas;
  return {
    gas, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    maxCostWei: gas * fees.maxFeePerGas, costWei: estimate * (base + fees.maxPriorityFeePerGas), balance,
  };
}

/** Signs and sends it on the parent chain of `chainId` (the withdrawal's chain); the transaction's hash */
export async function sendCall(chainId: number, payer: Payer, call: L1Call, q: CallQuote): Promise<Hex> {
  const l1 = () => parent(chainId);
  const parentId = parentChainId(chainId);
  if (payer.kind === 'metamask') {
    await payer.provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: toHex(parentId) }] });
    return (await payer.provider.request({
      method: 'eth_sendTransaction',
      params: [{ from: payer.address, to: call.to, data: call.data, value: '0x0', gas: toHex(q.gas) }],
    })) as Hex;
  }
  const nonce = await l1().getTransactionCount({ address: payer.account.address, blockTag: 'pending' });
  const raw = await payer.account.signTransaction({
    type: 'eip1559', chainId: parentId, nonce, to: call.to, data: call.data, value: 0n,
    gas: q.gas, maxFeePerGas: q.maxFeePerGas, maxPriorityFeePerGas: q.maxPriorityFeePerGas,
  });
  return l1().sendRawTransaction({ serializedTransaction: raw });
}

/** Waits for it on the parent chain (up to 10 minutes) */
export async function waitMined(chainId: number, hash: Hex): Promise<boolean> {
  const r = await parent(chainId).waitForTransactionReceipt({ hash, timeout: 600_000, pollingInterval: 4_000 });
  return r.status === 'success';
}
