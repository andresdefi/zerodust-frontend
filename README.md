# ZeroDust website

The public site at [zerodust.xyz](https://zerodust.xyz): empty a wallet's native gas balances to
exactly 0, across many chains at once, to one destination. The home page is the app.

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
npm run build      # typecheck, build, CSP and integrity checks, build hash
npm run preview    # serves dist/ with the production security headers
npm run lint
npm test
```

## Layout

- `src/` the page (`App.tsx`, `components/`, `styles/tokens.css` for the palette)
- `build/` Vite plugins (SRI)
- `scripts/` build checks and the build hash
- `content/docs/` developer docs from the previous site, to be carried over
- `public/` static files served as is (`llms.txt`, `openapi.json`, `.well-known/`)
