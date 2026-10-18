# ZeroDust website

The public site at [zerodust.xyz](https://zerodust.xyz): look up any address, see its native gas on
78 chains, and empty them to exactly 0 to one destination, with MetaMask (no key, 16 chains) or the
wallet's key (every chain). Also a downloadable offline file (key only) and the developer docs.

The page handles private keys, so the build is held to strict rules (checked on every build):

- No third-party scripts, fonts, analytics or wallet SDKs. Fonts and chain logos are self-hosted.
- A Content-Security-Policy with `default-src 'none'` and `script-src 'self'` (`vercel.json`); no
  inline scripts, styles or event handlers in any page (`scripts/check-dist.mjs`).
- Subresource Integrity on every script and stylesheet (`build/sri.ts`).
- Dependencies pinned exactly (`.npmrc`, `package-lock.json`).
- A reproducible build: `npm run build` prints one SHA-256 over every file in `dist/`
  (`scripts/hash-dist.mjs`). Rebuild the same commit and compare.

## Stack

Vite, React, TypeScript. No server code: `dist/` is static and deployed to Vercel.

## Develop

```sh
npm ci
npm run dev        # http://localhost:5173
npm run build      # typecheck; offline file, site and static pages; CSP and integrity checks; hashes
npm run preview    # serves dist/ with the production security headers
npm run lint
npm test           # unit tests
npm run e2e        # end-to-end, against the built site with an offline API and RPCs
```

The end-to-end tests (`e2e/`) prove the key never reaches the DOM, storage, a request or the
console, that pasting wipes the clipboard, and run a full sweep (check, confirm, sweep, "0 left")
against recorded API responses. They use the production CSP and contact nothing outside the
machine.

## Layout

- `src/` the page (`App.tsx`, `home/`, `address/` (the address page and sweep dialog), `sweep/` (sweep flows, MetaMask), `components/`, `styles/`)
- `build/` Vite plugins (SRI)
- `scripts/` build checks and the build hash
- `content/docs/` developer docs and `content/legal/` terms and privacy, Markdown rendered at build time
- `public/` static files served as is (`llms.txt`, `openapi.json`, `.well-known/`)
- `src/direct/` direct chains: plan client, independent plan checks, in-page fork replay
  (ethereumjs), signing and broadcast to the chain's RPC
- `src/chains/rpcs.ts` the public RPC per chain the page reads from. Each passed
  `scripts/probe-rpcs.mjs` (CORS for the site, right chain ID, the read calls answer); every host
  must also be in the CSP's `connect-src` (`tests/csp-hosts.test.ts` fails otherwise).
- `public/chains/` chain logos from [web3icons](https://github.com/0xa3k5/web3icons) (MIT,
  `public/chains/LICENSE.txt`), copied by `scripts/copy-chain-logos.mjs`
