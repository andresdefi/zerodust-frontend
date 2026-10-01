import { RPC_URLS } from '../chains/rpcs';

/** One read-only JSON-RPC call to the chain's public RPC */
export async function rpcCall<T>(chainId: number, method: string, params: unknown[]): Promise<T> {
  const url = RPC_URLS[chainId];
  if (!url) throw new Error(`No RPC for chain ${chainId}`);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error || body.result === undefined) throw new Error(body.error?.message ?? 'RPC error');
  return body.result;
}

export interface OnChainState {
  balance: bigint;
  /** The account's code: "0x" once the EIP-7702 delegation is revoked */
  code: string;
}

export async function readState(chainId: number, address: string): Promise<OnChainState> {
  const [balance, code] = await Promise.all([
    rpcCall<string>(chainId, 'eth_getBalance', [address, 'latest']),
    rpcCall<string>(chainId, 'eth_getCode', [address, 'latest']),
  ]);
  return { balance: BigInt(balance), code };
}
