// Can the site sweep a direct chain from the browser? Per public RPC candidate:
// CORS for the site's origin, chain ID, eth_sendRawTransaction present, and
// eth_simulateV1 with validation simulating an exact transfer of a whole
// (overridden) balance and reading the balance afterwards: it must be 0.
// Needs no funds: a throwaway address gets its balance from a state override.
// Dev tool; the result decides which direct chains the site offers.
//
//   node scripts/probe-simulate.mjs
import * as viemChains from 'viem/chains';

const ORIGIN = 'https://www.zerodust.xyz';
const API = 'https://api.zerodust.xyz';
const FROM = '0x00000000000000000000000000000000000ba1a0';
const BURN = '0x000000000000000000000000000000000000dEaD';
const READER = '0x00000000000000000000000000000000000b0b0b';
const TIMEOUT_MS = 10_000;

/** Bytecode returning BALANCE(addr): PUSH20 addr BALANCE PUSH1 0 MSTORE PUSH1 32 PUSH1 0 RETURN */
const balanceReader = (addr) => `0x73${addr.slice(2).toLowerCase()}3160005260206000f3`;
const hex = (n) => `0x${BigInt(n).toString(16)}`;

async function rpc(url, method, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return { allow: res.headers.get('access-control-allow-origin'), body: await res.json() };
}

async function probe(url, chainId) {
  const out = { url };
  try {
    const pre = await fetch(url, {
      method: 'OPTIONS',
      headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const preAllow = pre.headers.get('access-control-allow-origin');
    out.cors = preAllow === '*' || preAllow === ORIGIN;
    const id = await rpc(url, 'eth_chainId', []);
    out.cors = out.cors && (id.allow === '*' || id.allow === ORIGIN);
    out.chainId = Number(id.body.result) === chainId;
    const send = await rpc(url, 'eth_sendRawTransaction', ['0x00']);
    out.send = send.body.error?.code !== -32601 && !/not (found|available|supported)/i.test(send.body.error?.message ?? '');

    const price = BigInt((await rpc(url, 'eth_gasPrice', [])).body.result) * 2n;
    const balance = 10n ** 18n;
    const gas = 21_000n;
    const sim = await rpc(url, 'eth_simulateV1', [{
      validation: true,
      blockStateCalls: [
        {
          stateOverrides: { [FROM]: { balance: hex(balance) } },
          calls: [{ from: FROM, to: BURN, value: hex(balance - gas * price), gas: hex(gas), gasPrice: hex(price), nonce: '0x0' }],
        },
        { stateOverrides: { [READER]: { code: balanceReader(FROM) }, [BURN]: { balance: hex(balance) } }, calls: [{ from: BURN, to: READER, gas: hex(100_000), gasPrice: hex(price), nonce: '0x0' }] },
      ],
    }, 'latest']);
    if (sim.body.error) {
      out.simulate = `error: ${sim.body.error.message.slice(0, 70)}`;
    } else {
      const [first, second] = sim.body.result;
      const call = first.calls[0];
      const after = BigInt(second.calls[0].returnData);
      out.simulate = call.status === '0x1' && BigInt(call.gasUsed) === gas && after === 0n ? 'exact zero' : `status ${call.status}, gasUsed ${BigInt(call.gasUsed)}, after ${after}`;
    }
  } catch (error) {
    out.error = String(error?.message ?? error).slice(0, 70);
  }
  return out;
}

const chains = (await (await fetch(`${API}/direct/chains`)).json()).chains;
const chainlist = await (await fetch('https://chainid.network/chains.json')).json();
for (const c of chains) {
  const urls = new Set([c.rpcUrl]);
  for (const chain of Object.values(viemChains)) if (chain?.id === c.chainId) chain.rpcUrls?.default?.http?.forEach((u) => urls.add(u));
  for (const r of chainlist.find((x) => x.chainId === c.chainId)?.rpc ?? []) {
    const u = typeof r === 'string' ? r : r.url;
    if (u?.startsWith('https://') && !u.includes('${') && !/api[-_]?key/i.test(u)) urls.add(u);
  }
  const results = await Promise.all([...urls].map((u) => probe(u, c.chainId)));
  const usable = results.filter((r) => r.cors && r.chainId && r.send && r.simulate === 'exact zero');
  console.log(`\n${c.chainId} ${c.name}: ${usable.length}/${results.length} usable`);
  for (const r of results) console.log(`  ${r.simulate === 'exact zero' && r.cors && r.chainId && r.send ? 'OK ' : '   '} ${r.url} cors=${r.cors} id=${r.chainId} send=${r.send} sim=${r.simulate ?? r.error}`);
}
