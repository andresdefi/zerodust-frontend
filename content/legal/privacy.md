# Privacy

ZeroDust collects as little as it can. There are no accounts, no cookies, no analytics and no ads. With MetaMask, this site never sees your key; when you load a wallet with its key instead, the key never leaves your browser tab.

## Who runs ZeroDust

ZeroDust is a community tool built and run by [andresdefi](https://x.com/andresdefi), an independent member of the crypto community. It is not a company. For questions or requests about your data, reach out on X: [@andresdefi](https://x.com/andresdefi).

## What happens on this website

- **With MetaMask**, the site receives your address, the permissions you grant and the message you sign. Your key stays in MetaMask.
- **Your private key**, when you load a wallet with it, stays in your browser tab's memory. It is never sent to us or anyone else, never stored, and never logged. Only signatures and signed transactions leave the tab.
- **No cookies, no analytics, no tracking.** The site stores one thing in your browser, and only if you choose a theme: your light or dark preference (local storage).
- **Hosting.** The site is served by Vercel, which processes the connection data any web server needs to deliver a page (such as your IP address). We do not add analytics to it.

## What the ZeroDust API receives and keeps

To quote and run a sweep, the API (api.zerodust.xyz) receives your wallet address, the chains, the destination address and the amounts. It keeps:

| Data | Why | How long |
| --- | --- | --- |
| Quotes: wallet address, chains, destination, amounts, fees | To run the sweep you sign | Deleted after 7 days, unless a sweep used the quote |
| Sweeps: wallet address, destination, chains, amounts, transaction hashes, status | The record of each sweep, to deliver it, answer questions and keep accounts | Kept |
| Your signatures for a sweep, and with MetaMask the permission you granted | To execute it | Deleted 7 days after the sweep ends (once its delegation is revoked) |
| Sweep reports: wallet address, chains, route, transaction hashes, the result and its message, the site version | Sent by the page when a direct-chain sweep ends or a sweep fails, so we can look into it from the reference shown on the page. Never your key | Deleted after 400 days |
| Daily counts of quotes per chain pair | Capacity and usage, no addresses | Kept |
| Delivery accuracy per bridge route: amount quoted vs delivered, how long delivery took, the chains and the bridge | To keep the amounts we show at or below what arrives. No addresses, no transaction hashes | Deleted after 400 days |

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

Last updated: 6 October 2026.
