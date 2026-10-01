// Finds, per chain, public RPC endpoints a browser on the site can use:
// the CORS preflight and response allow the site's origin, eth_chainId
// matches, and the read calls the sweep needs answer. Candidates come from
// viem's chain registry and chainlist. Dev tool (talks to the network);
// its output is reviewed and copied into src/chains/rpcs.ts.
//
//   node scripts/probe-rpcs.mjs 1 10 8453      # chosen chains
//   node scripts/probe-rpcs.mjs --api          # every chain the API serves
import * as viemChains from 'viem/chains';

const ORIGIN = 'https://www.zerodust.xyz';
const PROBE_ADDRESS = '0x000000000000000000000000000000000000dEaD';
const TIMEOUT_MS = 8000;

// Public endpoints neither registry lists (from the backend's chain config)
const EXTRA = {
  42018: ['https://mythos-mainnet.g.alchemy.com/public'],
};

async function chainIds() {
  if (!process.argv.includes('--api')) return process.argv.slice(2).map(Number);
  const res = await fetch('https://api.zerodust.xyz/chains');
  const body = await res.json();
  return (body.chains ?? body).map((c) => c.chainId);
}

async function candidates(chainId, chainlist) {
  const urls = new Set(EXTRA[chainId] ?? []);
  for (const chain of Object.values(viemChains)) {
    if (chain?.id === chainId) chain.rpcUrls?.default?.http?.forEach((u) => urls.add(u));
  }
  const entry = chainlist.find((c) => c.chainId === chainId);
  for (const rpc of entry?.rpc ?? []) {
    const url = typeof rpc === 'string' ? rpc : rpc.url;
    // Keyed or templated URLs ("${INFURA_API_KEY}") are not public endpoints
    if (url?.startsWith('https://') && !url.includes('${') && !/api[-_]?key/i.test(url)) urls.add(url);
  }
  return [...urls];
}

async function rpc(url, method, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const allow = res.headers.get('access-control-allow-origin');
  const body = await res.json();
  return { allow, body };
}

async function probe(url, chainId) {
  const started = Date.now();
  try {
    const pre = await fetch(url, {
      method: 'OPTIONS',
      headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const preAllow = pre.headers.get('access-control-allow-origin');
    if (preAllow !== '*' && preAllow !== ORIGIN) return { url, ok: false, why: `preflight: ${preAllow ?? 'no allow-origin'}` };
    const id = await rpc(url, 'eth_chainId', []);
    if (id.allow !== '*' && id.allow !== ORIGIN) return { url, ok: false, why: `response: ${id.allow ?? 'no allow-origin'}` };
    if (Number(id.body.result) !== chainId) return { url, ok: false, why: `chainId ${id.body.result ?? JSON.stringify(id.body.error)}` };
    for (const [method, params] of [
      ['eth_getBalance', [PROBE_ADDRESS, 'latest']],
      ['eth_getTransactionCount', [PROBE_ADDRESS, 'latest']],
      ['eth_getCode', [PROBE_ADDRESS, 'latest']],
    ]) {
      const r = await rpc(url, method, params);
      if (r.body.result === undefined) return { url, ok: false, why: `${method}: ${JSON.stringify(r.body.error ?? r.body).slice(0, 80)}` };
    }
    return { url, ok: true, ms: Date.now() - started };
  } catch (error) {
    return { url, ok: false, why: String(error?.message ?? error).slice(0, 80) };
  }
}

const chainlist = await (await fetch('https://chainid.network/chains.json')).json();
const results = {};
for (const chainId of await chainIds()) {
  const urls = await candidates(chainId, chainlist);
  const probed = await Promise.all(urls.map((u) => probe(u, chainId)));
  results[chainId] = probed.sort((a, b) => Number(b.ok) - Number(a.ok) || (a.ms ?? 1e9) - (b.ms ?? 1e9));
  const ok = results[chainId].filter((r) => r.ok);
  console.error(`${chainId}: ${ok.length}/${urls.length} usable${ok[0] ? `, best ${ok[0].url} (${ok[0].ms} ms)` : ''}`);
}
console.log(JSON.stringify(results, null, 2));
