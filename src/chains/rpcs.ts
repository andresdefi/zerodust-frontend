// Public RPC per chain, read from the browser: nonces for signing, and the
// on-chain check that a swept chain reads exactly 0. Each one passed
// scripts/probe-rpcs.mjs (CORS for the site's origin, right chain ID, the
// read calls answer) on 2026-10-01. Ronin moved to Tenderly's gateway: api.roninchain.com
// refuses Origin: null, which the offline page sends. Every host here must also be in the
// CSP's connect-src in vercel.json (tests/csp-hosts.test.ts).
export const RPC_URLS: Record<number, string> = {
  1: 'https://mainnet.gateway.tenderly.co',
  10: 'https://optimism-rpc.publicnode.com',
  56: 'https://bsc-dataseed4.bnbchain.org',
  100: 'https://gnosis-rpc.publicnode.com',
  130: 'https://unichain-rpc.publicnode.com',
  137: 'https://polygon.gateway.tenderly.co',
  146: 'https://rpc.soniclabs.com',
  169: 'https://pacific-rpc.manta.network/http',
  196: 'https://xlayerrpc.okx.com',
  252: 'https://rpc.frax.com',
  360: 'https://shape-mainnet.g.alchemy.com/public',
  480: 'https://worldchain-mainnet.g.alchemy.com/public',
  988: 'https://rpc.stable.xyz',
  1135: 'https://rpc.api.lisk.com',
  1329: 'https://evm-rpc.sei-apis.com',
  1514: 'https://mainnet.datarpc.io',
  1672: 'https://rpc.pharos.xyz',
  1868: 'https://rpc.soneium.org',
  2020: 'https://ronin.gateway.tenderly.co',
  2818: 'https://rpc-quicknode.morphl2.io',
  4326: 'https://mainnet.megaeth.com/rpc',
  4663: 'https://robinhood-rpc.publicnode.com',
  5000: 'https://mantle-rpc.publicnode.com',
  5031: 'https://api.infra.mainnet.somnia.network',
  5042: 'https://rpc.blockdaemon.mainnet.arc.io',
  5330: 'https://mainnet.superseed.xyz',
  8453: 'https://base-rpc.publicnode.com',
  9745: 'https://rpc.plasma.to',
  33139: 'https://rpc.apechain.com',
  34443: 'https://mainnet.mode.network',
  42018: 'https://mythos-mainnet.g.alchemy.com/public',
  42161: 'https://arbitrum-one-rpc.publicnode.com',
  42220: 'https://forno.celo.org',
  43111: 'https://rpc.hemi.network/rpc',
  48900: 'https://mainnet.zircuit.com',
  57073: 'https://rpc-qnd.inkonchain.com',
  59144: 'https://linea-rpc.publicnode.com',
  60808: 'https://rpc.gobob.xyz',
  80094: 'https://rpc.berachain.com',
  98866: 'https://rpc.plume.org',
  167000: 'https://taiko-rpc.publicnode.com',
  534352: 'https://scroll-rpc.publicnode.com',
  685689: 'https://gensyn-mainnet.g.alchemy.com/public',
  747474: 'https://rpc.katana.network',
  7777777: 'https://rpc.zora.energy/',
};

// Direct chains (no EIP-7702 in ZeroDust): the page reads balances, replays
// the planned set on a fork, and broadcasts its signed transactions here. The
// same endpoints the API plans with (/direct/chains); each answered CORS for
// the site and the reads the replay needs on 2026-10-01.
export const DIRECT_RPC_URLS: Record<number, string> = {
  43114: 'https://api.avax.network/ext/bc/C/rpc',
  25: 'https://evm.cronos.org',
  1088: 'https://andromeda.metis.io/?owner=1088',
  13371: 'https://rpc.immutable.com',
  122: 'https://rpc.fuse.io',
  50: 'https://rpc.xdcrpc.com',
  999: 'https://rpc.hyperliquid.xyz/evm',
  747: 'https://mainnet.evm.nodes.onflow.org',
  1625: 'https://rpc.gravity.xyz',
  42793: 'https://node.mainnet.etherlink.com',
  // Added 2026-10-02 (probe-rpcs: CORS for the site and Origin: null, reads answer)
  14: 'https://flare-api.flare.network/ext/C/rpc',
  30: 'https://public-node.rsk.co',
  5064014: 'https://rpc.ethereal.trade',
  // Monad: passed probe-rpcs on 2026-10-02
  143: 'https://rpc.monad.xyz',
};
