# Terms

These terms apply when you use ZeroDust: this website, the offline page, the API, the SDK and the MCP server. ZeroDust is a community tool built and run by [andresdefi](https://x.com/andresdefi), an independent member of the crypto community. It is not a company.

## What ZeroDust does

ZeroDust moves the native gas token left in a wallet on one or more chains to one destination you choose, and leaves each chain at a balance of exactly 0. On chains with a sponsor, your wallet delegates once to the ZeroDust contract (EIP-7702), the sponsor pays the gas and is repaid from the balance, and the delegation is revoked afterwards. With MetaMask, your wallet instead grants ZeroDust's router a one-time permission per chain (ERC-7715) and signs one message for every chain; the sponsor pays the gas through the router and is repaid the same way. The smart-account upgrade MetaMask runs the first time on a chain is MetaMask's, and stays. On chains without a sponsor, your wallet sends exact transactions itself, which this website prepares and checks.

## Not a financial service

ZeroDust is a software tool. It is not a broker, exchange, bank, custodian or financial advisor, and nothing on this site is financial, tax or legal advice.

## You keep control

- ZeroDust never holds your funds. They move from your wallet to the destination in the sweep itself.
- With MetaMask, your key stays in MetaMask. When you load a wallet with its key instead, the key stays on your device. We never ask for it anywhere else (not by email, chat or support), and you should never give it to anyone.
- You are responsible for the wallet and key you use, for what you approve in MetaMask, for the destination chain and address you choose, and for checking them before you confirm.

## Before you sweep

- **A sweep cannot be undone.** Funds sent to a wrong address cannot be recovered.
- **What arrives is native gas.** ZeroDust only uses routes that deliver the destination chain's own gas token, but the bridge does the delivery. If a bridge fails it may refund instead, usually to your wallet on the source chain, which then is not at 0. Two chains are the exception and the site says so before you confirm: Mitosis arrives as MITO and Endurance as ACE, both as tokens on BNB Chain (Endurance only to your own wallet).
- **Burning destroys funds.** If you choose to burn a balance that no route can move, nobody receives it.
- **Donating** sends a balance to ZeroDust. You receive nothing for it.
- **Estimates can change.** Amounts shown before you confirm are estimates; each chain is quoted again when it is swept, and you receive what the route delivers.
- **Bridges are run by others.** Cross-chain sweeps go through third-party bridges (Gas.zip, Relay, Across, LI.FI). A bridge can be slow, fail, or refund to your wallet instead of delivering. We do not control them.
- **Removing the delegation.** On chains with a sponsor, ZeroDust removes its delegation from your wallet after the sweep, in a separate transaction it pays for, and retries if that fails. This is best effort: it can be delayed or fail. A delegation left in place can only run sweeps you sign yourself; nobody else can use it.
- **Software can have bugs** and blockchains can behave unexpectedly. Use a wallet you are emptying, not one that holds funds you cannot afford to lose to a mistake.

## Fees

ZeroDust charges a service fee per chain swept: 5% of the balance under $1 (no minimum), and from $1, 1% with a $0.05 minimum and a $0.50 maximum. Gas and bridge costs are added at cost. The amount you receive is shown before you confirm. On chains without a sponsor, burning or donating a balance carries no service fee; on sponsored chains it is a sweep like any other and pays the fee.

**Fees are final.** The service fee is taken on-chain, in the sweep itself, and only when the sweep runs. A sweep that does not run pays no service fee. Once a sweep has run, its fee, gas and bridge costs are not refunded, including when a bridge returns funds instead of delivering them. This does not affect rights you have under consumer law that cannot be waived.

## Acceptable use

Do not use ZeroDust with funds you do not own or are not allowed to move, to break sanctions or other laws, or to attack, overload or misuse the service. We can refuse quotes, block addresses or limit requests to keep the service working and lawful.

## The service as it is

ZeroDust is provided as it is, without promises that it will always be available or free of errors. To the extent the law allows, we are not liable for losses from using it, including losses from mistakes in the destination you set, from bridges or chains, or from the loss of your key. To the extent the law allows, ZeroDust's total liability for any claim about a sweep is limited to the service fee ZeroDust received for that sweep. Gas and bridge costs are paid to others, not to ZeroDust, and are not included. This does not limit liability for intent or gross negligence, or rights that the law does not allow to be limited.

We are not responsible for failures or delays caused by events we cannot control, such as a chain halting, reorganizing or changing its rules; a bridge or other third-party service being hacked, paused or shut down; outages at hosting or RPC providers; or new laws and regulations.

## Changes and contact

These terms may be updated; the version on this page applies from the date below. Questions: reach out on X, [@andresdefi](https://x.com/andresdefi).

Last updated: 8 October 2026.
