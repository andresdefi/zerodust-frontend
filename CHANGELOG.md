# Changelog

All notable changes to the ZeroDust frontend will be documented in this file.

## [Unreleased]

### Direct chains (2026-10-01)

- Avalanche, Cronos, Metis, Immutable zkEVM, Fuse, XDC, HyperEVM, Flow EVM, Gravity and Etherlink
  (no EIP-7702 in ZeroDust) are swept by the wallet itself with exact legacy transactions, planned
  by the API (`/direct/*`, quote-only) and checked here before signing: the plan against the
  request and the chain's own balance and nonce (`src/direct/verify.ts`), then replayed on a fork
  of the chain in an in-page EVM (ethereumjs, `src/direct/replay.ts`). Signed transactions go
  straight to the chain's RPC; the API never sees them.
- Swap out (LI.FI) for a direct chain with no bridge route, the cents left donated or burned.
- A fee transfer that landed before its sweep failed is passed back so a retry is not charged twice.

### Sweep flow for sponsored chains (2026-10-01)

- Key entry ported from the local sweeper: the key never enters the DOM; pasting wipes the clipboard.
- Balances, destination picker (no default chain), "Receive at" with a check-it warning, burn or
  donate for a chain with no route, check (real quotes, SDK-verified, nothing sent), confirm
  dialog, sweep with progress, and an on-chain check per chain (balance 0, delegation revoked).
- Public RPCs for all 45 sponsored chains, probed for browser access and listed in the CSP.
- Chain logos self-hosted (web3icons, MIT).
- Subresource Integrity is now computed from the files as written, and the build re-verifies every
  hash (a chunk rewritten after hashing had shipped a wrong one in testing).
- End-to-end tests in CI (Playwright, offline).

### Rebuild (2026-10-01)

- Replaced the Next.js app with a static Vite + React site: the home page is the sweep app, with
  the approved "Saffron" design (light and dark).
- Removed RainbowKit, wagmi, ethers, framer-motion, Tailwind and Vercel Analytics.
- Security headers in `vercel.json` (CSP without inline code, HSTS, frame denial, no referrer),
  Subresource Integrity on scripts and styles, build checks for both, and a reproducible build hash.
- CI: typecheck, lint, tests, build.
- The old developer docs are kept in `content/docs/` until the docs pages are rebuilt.

## Previous site

### Added

#### Design & UI Overhaul
- Premium glassmorphism design inspired by Jumper, Uniswap, and Superbridge
- Animated gradient background with floating orbs
- Grid pattern overlay for visual depth
- New color system with brand violet/cyan gradients
- Glassmorphism cards with backdrop blur effects
- Smooth micro-interactions and hover states

#### Chain Icons
- Official chain logos from LI.FI repository (same as Jumper exchange)
- Round icon display for consistent styling
- Support for all mainnet and testnet chains:
  - Ethereum / Sepolia
  - Base / Base Sepolia
  - Optimism / OP Sepolia
  - Arbitrum / Arbitrum Sepolia
  - Polygon / Polygon Amoy
  - BNB Chain / BSC Testnet
  - Gnosis

#### Network Mode Toggle
- Mainnet/Testnet toggle in sweep card header
- Dynamic chain list filtering based on network mode
- Network-aware banner (amber for mainnet "coming soon", violet for testnet)
- Chains section updates based on selected network

#### Fee System Enhancements
- Preview mode: Fee estimation without wallet connection
- Fee breakdown shows gas fees and service fees
- USD value display for amounts and fees
- Warning system:
  - "Amount too low" error when fees exceed balance
  - "High fee" warning when fees > 30% of amount (configurable threshold)
- Confirmation step required for high fee transactions
- Percentage display of fees relative to amount

#### Components
- `ChainIcon` component for consistent chain logo display
- Updated `BalanceList` with network mode support
- Enhanced `FeeBreakdown` with warning system
- Premium `SweepButton` with state feedback

### Changed
- Header logo now uses gradient icon with Zap symbol
- Sweep card uses `overflow-visible` to allow dropdown to extend
- Chain selection dropdown shows full list without clipping
- Improved responsive design for mobile devices

### Technical
- Chain configuration split into `testnetChainIds` and `mainnetChainIds`
- Token price fetching per chain for accurate USD conversion
- React hooks ordering fixed in FeeBreakdown component
- Next.js Image optimization disabled for external SVGs

## [0.1.0] - Initial Release

### Added
- Basic sweep interface
- Wallet connection via RainbowKit
- Chain selection and balance display
- Destination address input
- EIP-7702 sweep transaction execution
