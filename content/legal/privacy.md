# Privacy

ZeroDust collects as little as it can. There are no accounts, no cookies, no analytics and no ads. Your private key never leaves your browser tab.

## Who runs ZeroDust

ZeroDust is a community tool built and run by [andresdefi](https://x.com/andresdefi), an independent member of the crypto community. It is not a company. For questions or requests about your data, reach out on X: [@andresdefi](https://x.com/andresdefi).

## What happens on this website

- **Your private key** stays in your browser tab's memory. It is never sent to us or anyone else, never stored, and never logged. Only signatures and signed transactions leave the tab.
- **No cookies, no analytics, no tracking.** The site stores one thing in your browser, and only if you choose a theme: your light or dark preference (local storage).
- **Hosting.** The site is served by Vercel, which processes the connection data any web server needs to deliver a page (such as your IP address). We do not add analytics to it.

## What the ZeroDust API receives and keeps

To quote and run a sweep, the API (api.zerodust.xyz) receives your wallet address, the chains, the destination address and the amounts. It keeps:

| Data | Why | How long |
| --- | --- | --- |
| Quotes: wallet address, chains, destination, amounts, fees | To run the sweep you sign | Deleted after 7 days, unless a sweep used the quote |
| Sweeps: wallet address, destination, chains, amounts, transaction hashes, status | The record of each sweep, to deliver it, answer questions and keep accounts | Kept |
| Your signatures for a sweep | To execute it | Deleted 7 days after the sweep ends (once its delegation is revoked) |
| Daily counts of quotes per chain pair | Capacity and usage, no addresses | Kept |

- **The API stores no IP addresses.** Its request logs record only the method, the route (for example `/balances/:address`, never the address itself), the status and the time taken. It uses your IP address in memory to apply rate limits and does not write it anywhere. (Cloudflare and Render, in front of the API, process connection data to deliver requests; see below.)
- For chains without a sponsor, the API only plans transactions. It does not store those plans, and it never receives the signed transactions: your browser sends them to the chain itself.
- **API keys** (optional, for software agents): if you register one, we keep its hash, a name, and a contact email if you give one.

## Who else sees your data

- **Blockchains.** Every sweep is a public, permanent blockchain transaction. Anyone can see the addresses and amounts involved. This cannot be deleted by anyone.
- **Chain RPC providers.** Your browser reads balances and sends transactions through each chain's public RPC endpoint. Those providers see your IP address and the requests you make.
- **Bridges** (Gas.zip, Relay, Across, LI.FI). To quote and deliver a cross-chain sweep, the API sends them your wallet address, the destination address, the chains and the amount.
- **Our providers.** The API runs on Render, its database on Supabase, and it sits behind Cloudflare. They process data only to run the service.

## Your rights

You can ask what data ZeroDust holds about your wallet address, and ask for it to be corrected or deleted: reach out on X, [@andresdefi](https://x.com/andresdefi). Data on a blockchain cannot be deleted by anyone. If you are in the EEA, you can also contact your data protection authority.

## Changes

We will update this page when what we collect changes, and change the date below.

Last updated: 1 October 2026.
