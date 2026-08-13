# Mango Protocol

Mango Protocol is a permissionless infrastructure suite for moving assets across chains and launching new tokens. Anyone can bridge, anyone can launch a token, anyone can trade — there's no gatekeeping, no approval process, no account to register. You connect a wallet and use it.

**Live:** [mangoprotocol.site](https://mangoprotocol.site)

**Status:** Bridge is live on mainnet across Ethereum, Base, BNB Chain, Robinhood Chain, Stable, Solana, Arbitrum One, Avalanche, Abstract, HyperEVM, Ink, Plasma, Unichain, and X Layer. Launchpad contracts are deployed and verified on Robinhood Chain mainnet; the launch and trading interface is still in development.

---

## Supported chains

- Ethereum
- Base
- BNB Chain
- Robinhood Chain
- Stable — Tether's own L1, native gas token USDT0
- Solana — not EVM-compatible; see "Solana support" below for what that actually requires
- Arbitrum One
- Avalanche
- Abstract
- HyperEVM
- Ink
- Plasma
- Unichain
- X Layer

The last eight are native-asset-only for now (ETH, AVAX, HYPE, XPL, and OKB respectively) — every route touching one of them goes through Relay, since no canonical bridge or CCTP integration has been verified for them yet. Chain id / native currency / block explorer for each came directly from `wagmi/chains`' own maintained definitions, not hand-typed.

## Supported assets

ETH, BNB, USDC, USDT, USDG, WBTC, USDT0, SOL, AVAX, HYPE, XPL, OKB — coverage varies by chain pair depending on which protocol handles that route (see below). Cross-*asset* swaps (e.g. BNB in, USDC out) are supported via Relay wherever both sides have a verified contract address. The app checks for a live route before you're ever asked to confirm — an unsupported pair is never silently faked as a success.

---

## How routing works

For each transfer, the app picks the safest available mechanism for that specific chain pair and asset:

| Route | Protocol | Mechanism |
|---|---|---|
| Ethereum ↔ Base, USDC | [Circle CCTP](https://developers.circle.com/cctp) | Native burn-and-mint. Audited by ChainSecurity and OtterSec. |
| Ethereum ↔ Base, ETH | [OP Stack canonical bridge](https://docs.base.org/base-chain/differences/eth-bridging) | Deposits are fast; withdrawals require Base's 7-day fraud-proof challenge period unless routed through Relay instead (see below). |
| Ethereum ↔ Robinhood Chain, ETH/USDC | [Arbitrum canonical bridge](https://docs.arbitrum.io/) | Same deposit/withdrawal pattern as Base — Robinhood Chain is built on Arbitrum Orbit. |
| Ethereum ↔ BNB Chain, ETH | [Wormhole Token Bridge](https://wormhole.com/docs) | Lock-and-mint via guardian attestation, both directions. Destination asset is Wormhole-wrapped ETH, not native BNB. |
| Base/Robinhood Chain → Ethereum, ETH; cross-asset swaps; everything else with a verified contract address on both sides (BNB, USDT, USDC, USDG, USDT0 across chains; Base↔Robinhood Chain direct; Stable); every Solana-involving route, both directions; every route touching Arbitrum One, Avalanche, Abstract, HyperEVM, Ink, Plasma, Unichain, or X Layer (native asset only) | [Relay Protocol](https://docs.relay.link) | Solver network — different trust model than the routes above (you're trusting Relay's solvers to fulfill, not a canonical audited bridge), but non-custodial and typically settles in under a minute. Preferred over the 7-day canonical withdrawal path where available. Solana-sourced transfers execute through Relay's own SDK, using Solana's native transaction format — a genuinely separate code path from the EVM-to-EVM routes above. |

**A pair only routes through Relay if this app has an independently verified contract address for the asset on both chains.** No addresses are ever guessed — an unverified combination has no route offered, and the app checks live before you confirm rather than risk sending funds to the wrong contract.

## Solana support

Solana isn't EVM-compatible — a genuinely different blockchain architecture, not just another chain in the same list as the rest. Two real, concrete consequences:

- **Two separate wallets, not one.** Any route touching Solana — as source or destination — needs both an EVM wallet (connected via Reown AppKit — MetaMask, Coinbase Wallet, Trust Wallet, WalletConnect, and hundreds more) and a separate Solana wallet (OKX Connect, or Phantom/Solflare/Coinbase/Trust via AppKit's own Solana adapter). The app prompts directly for whichever one is still missing, right in the bridge form.
- **A different execution path.** Solana-sourced transfers sign and submit through Relay's own official SDK (`@relayprotocol/relay-sdk` + `@relayprotocol/relay-svm-wallet-adapter`), using Solana's real transaction format — not the wagmi-based signing used for every EVM-to-EVM route. Both directions are supported: Solana → EVM and EVM → Solana.

## Fees

A 1% protocol fee is collected on every real transfer, across every protocol above — sent as its own separate, visible on-chain transaction — never bundled invisibly into another transfer.

---

## The Launchpad

Every token launches directly into a live Uniswap v4 pool, trading on real, audited Uniswap infrastructure from the first buy. Prices move on genuine market activity from block one.

**Launching a token:**
1. Connect your wallet
2. Set a name, ticker, and description
3. Upload artwork (stored on public IPFS)
4. Optionally link an X profile and Telegram
5. Optionally make a developer buy — purchasing some of your own supply at launch
6. Confirm — your token is live in a real trading pool immediately

**Trading fees:** 1% per trade, split 70% to the token's creator and 30% to the Mango Protocol treasury — paid automatically inside the same transaction as the trade. Nothing to claim, ever.

**Creator tools:** the Profile page tracks your real launches and real holdings, read directly from the Registry and each token's on-chain balance — no fake data, no placeholder numbers. Creator fees earned isn't tracked yet; see Security notes below.

Contracts (`MangoLaunchHook.sol`, `MangoLaunchRegistry.sol`, `MangoLaunchFactory.sol`, `MangoLaunchRouter.sol`, `MangoLaunchToken.sol`) are deployed and verified on Robinhood Chain mainnet — see `contracts/` for source and `contracts/Deploy*.s.sol` for the deployment scripts. Real addresses, confirmed against actual `forge build` output and real mainnet transactions, not assumed from documentation.

**Current (live now):**

| Contract | Address |
|---|---|
| MangoLaunchFactory | [`0x8aD6607EbBAd5F4A088EDC25e98B3B454F9E912A`](https://robinhoodchain.blockscout.com/address/0x8aD6607EbBAd5F4A088EDC25e98B3B454F9E912A) |
| MangoLaunchHook (v4) | [`0x6df44617b8C13AB961dCe5097F9375AE6BE09044`](https://robinhoodchain.blockscout.com/address/0x6df44617b8C13AB961dCe5097F9375AE6BE09044) |
| MangoLaunchRegistry (v3) | [`0xb4D9c0928d0bf15ACa8D698cb83703752CfdF785`](https://robinhoodchain.blockscout.com/address/0xb4D9c0928d0bf15ACa8D698cb83703752CfdF785) |
| MangoLaunchRouter (v4) | [`0xb347EEad23D4FC41338845E35Ee8Fc42D9789d70`](https://robinhoodchain.blockscout.com/address/0xb347EEad23D4FC41338845E35Ee8Fc42D9789d70) |

**Version history — why each version exists, not just a changelog:**

- **Hook v1 → v2:** redesigned the fee structure — flat 3% became 1% buy, 4% sell pre-graduation (real anti-dump protection), 1% both ways after graduation.
- **Hook/Registry v2 → v3:** added a permanent, separate admin role. The original design let only the current operator reassign itself — once that role moved to a contract with no forwarding function, it got permanently stuck (`NotLaunchOperator()`, confirmed on real mainnet, not caught in testing).
- **Hook v3 → v4:** fixed a missing permission bit (`AFTER_SWAP_RETURNS_DELTA_FLAG`). The hook computed trading fees correctly the whole time but was never granted permission to actually apply them — every real trade with a registered creator reverted until this was found and fixed.
- **Factory v1 → v2:** fixed a real over-settlement bug. The original transferred a token's *entire* supply to seed liquidity; Uniswap's own tick-rounding math meant slightly less was actually owed, leaving an unclaimed credit that reverted every launch attempt with `CurrencyNotSettled()`. Root-caused and fixed via a local Foundry fork test reproducing the exact mainnet failure.
- **Router v1 → v2 → v3:** updated to point at each new Hook version as it shipped.
- **Router v3 → v4:** fixed a settlement-ordering bug in the sell path specifically — `sync()` was being called after the token transfer instead of before it. Buys worked correctly before this fix; sells didn't.

## How Uniswap v4 Hooks Work

Every version of Uniswap before v4 deployed a separate contract per trading pair. V4 replaced that with a **singleton** — one contract, `PoolManager`, holding every pool's state internally. Creating a pool isn't a deployment anymore; it's a cheap state update in a contract that already exists.

A **hook** is a separate contract attached to a specific pool, which `PoolManager` calls automatically at defined moments — before or after a swap, before or after liquidity changes, and so on. This is where custom logic lives. Mango's hook uses exactly two of these: `afterInitialize` (registers the token's creator when the pool is created) and `afterSwap` (splits and pays out the trading fee).

The distinctive part: a hook's permissions are encoded directly into its own contract address. Developers use `CREATE2` with a specifically-mined salt to produce an address whose lowest bits spell out exactly which hook functions it's allowed to use. `PoolManager` reads those bits straight off the address — no permissions can be added after deployment, and a hook can never claim capabilities it wasn't deployed with. Mango's hook address is mined to expose only those two functions, nothing else.

This is also why fees never need claiming: v4's "flash accounting" tracks running balance changes within a single transaction and only settles the net result at the very end. That's the exact mechanism the hook uses to split a trade's fee and send both shares to their destination wallets — inside the swap itself, not as a separate step afterward.

## Powered by Uniswap v4 Hooks

Every token launched on Mango deploys onto a real Uniswap v4 hook — the same permission-mined, singleton-native architecture live on Robinhood Chain since day one. No custom AMM, no forked contracts, no bolted-on middleware — just Uniswap's actual `PoolManager`, doing what it was built to do.

That's what makes the 70/30 fee split real instead of a promise: the hook redirects each trade's fee split inside the same transaction as the swap itself, the moment it settles. One click to launch, and the token is trading against genuine, audited, first-party Uniswap infrastructure — not a clone, not a wrapper, the real thing.

## Custody

Mango never takes custody of user funds at any point, on either the bridge or the launchpad. Bridge transfers move directly through the underlying protocol's own contracts — Circle's, Optimism's, Arbitrum's, Wormhole's, or Relay's. Launchpad trades settle through Uniswap's own PoolManager. Your wallet signs every transaction directly with that infrastructure; Mango's role is routing and fee collection, not holding.

## Tech stack

- **React + Vite**, Tailwind CSS
- **wagmi / viem** for EVM wallet connection and most on-chain calls
- **Reown AppKit** (`@reown/appkit` + `@reown/appkit-adapter-wagmi` + `@reown/appkit-adapter-solana`) for the actual wallet-connect modal — a full, searchable directory of EVM wallets, layered on top of the same wagmi config above rather than replacing it, plus most of the non-OKX Solana wallet options (Phantom, Solflare, Coinbase, Trust)
- **ethers v5** specifically for the Arbitrum integration (`@arbitrum/sdk` expects ethers v5 objects internally, not v6 — different chain-ID representations between the two versions caused a real bug during development, documented in `src/arbbridge.js`)
- **@wormhole-foundation/sdk** for the Wormhole integration
- **@web3icons/react** for real, official chain/token logos — static imports only, confirmed against the library's own documented examples one at a time (its dynamic lookup entry point requires a `<Suspense>` boundary this app doesn't have, and caused a real production crash before this was caught)
- **@okxconnect/universal-provider + @okxconnect/solana-provider** for OKX's own Solana wallet connection — genuinely separate from both wagmi and AppKit's Solana adapter, since Solana isn't EVM and OKX's execution path is the only one proven against a real Solana-sourced transfer so far (see `src/SolanaWalletContext.jsx`)
- **@solana/wallet-adapter-wallets** for the other Solana wallet adapters AppKit's SolanaAdapter connects through
- **@relayprotocol/relay-sdk + @relayprotocol/relay-svm-wallet-adapter** for Solana-sourced transfer execution specifically — Solana transactions can't go through the same wagmi-based signing used for every EVM route
- **vite-plugin-node-polyfills** — `@solana/web3.js` expects Node's `Buffer` global, which browsers don't provide natively

## Local development

```bash
npm install
npm run dev
```

## Project structure

```
src/
  App.jsx                     — main UI, routing logic, transaction flow
  wagmi.js                    — chain definitions and wallet config (builds the wagmi Config via AppKit's WagmiAdapter)
  appkit.js                   — Reown AppKit wiring: the wallet-connect modal, mainnet-only network list, Solana adapter
  chainData.js                 — pure, platform-agnostic chain/currency data shared by the frontend and api/v1's serverless functions
  networkMode.js               — network mode (mainnet-only)
  cctp.js                      — Circle CCTP integration
  opbridge.js                  — Base (OP Stack) bridge integration
  arbbridge.js                 — Robinhood Chain (Arbitrum) bridge integration
  wormholebridge.js            — Wormhole integration (both directions)
  relaybridge.js                — Relay Protocol integration (EVM routes + recipient/currency resolution shared with the Solana path)
  relaySdkSolanaExecution.js   — Solana-sourced transfer execution via Relay's own SDK
  SolanaWalletContext.jsx      — shared Solana connection state (OKX Connect specifically), used across the app
  SolanaConnect.jsx            — isolated Solana connection test page, reachable at ?test=solana
  multiAssetBalances.js        — real, live balance fetching for every asset on the current chain, EVM + Solana
  Launchpad.jsx                — token launch and trading UI
  launchpad-contracts.js       — client-side launchpad contract calls

api/
  token-activity.js            — server-side, cached launch/trade/holder data, filtered to only Hook-verified launches
  blob-upload.js                — logo upload handling
  logo-registry.js              — logo URL registry
  v1/
    launchpad/tokens.js, token.js, quote.js, launch.js  — public REST endpoints; see API.md
    bridge/chains.js, quote.js                          — public REST endpoints; see API.md

sdk/
  mango-sdk.js                 — thin JS client for the api/v1 endpoints above

contracts/
  MangoLaunchFactory.sol, MangoLaunchHook.sol, MangoLaunchRegistry.sol, MangoLaunchRouter.sol, MangoLaunchToken.sol — see "The Launchpad" above for live addresses and version history
```

See `API.md` for the full public REST API reference and `sdk/mango-sdk.js` for the accompanying JS client.

---

## Security notes

- This app is **non-custodial** — it never holds, pools, or has custody of user funds at any point. Every transfer moves directly from the user's wallet through the underlying protocol's own contracts.
- Different routes carry genuinely different trust models. Canonical bridges (CCTP, OP Stack, Arbitrum) rely on audited contracts with no operator discretion. Wormhole relies on a guardian validator set. Relay relies on a solver network. The app discloses which applies to a given route before confirming a transfer.
- No formal third-party security audit of this app's own integration code has been performed. Contract addresses have been independently verified against official sources for every route in production, but that is not a substitute for an audit.
- If you find a security issue, please report it responsibly rather than exploiting it.

## License

No license has been chosen yet — all rights reserved by default until one is added.
