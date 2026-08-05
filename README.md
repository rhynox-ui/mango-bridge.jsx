# Mango Protocol

Mango Protocol is a permissionless infrastructure suite for moving assets across chains and launching new tokens. Anyone can bridge, anyone can launch a token, anyone can trade — there's no gatekeeping, no approval process, no account to register. You connect a wallet and use it.

**Status:** Bridge is live on mainnet. Launchpad contracts are deployed and verified on Robinhood Chain mainnet; the launch and trading interface is still in development.

---

## Supported chains

- Ethereum
- Base
- BNB Chain
- Robinhood Chain
- Stable — Tether's own L1, native gas token USDT0

## Supported assets

ETH, BNB, USDC, USDT, USDG, WBTC, USDT0 — coverage varies by chain pair depending on which protocol handles that route (see below). Cross-*asset* swaps (e.g. BNB in, USDC out) are supported via Relay wherever both sides have a verified contract address. The app checks for a live route before you're ever asked to confirm — an unsupported pair is never silently faked as a success.

---

## How routing works

For each transfer, the app picks the safest available mechanism for that specific chain pair and asset:

| Route | Protocol | Mechanism |
|---|---|---|
| Ethereum ↔ Base, USDC | [Circle CCTP](https://developers.circle.com/cctp) | Native burn-and-mint. Audited by ChainSecurity and OtterSec. |
| Ethereum ↔ Base, ETH | [OP Stack canonical bridge](https://docs.base.org/base-chain/differences/eth-bridging) | Deposits are fast; withdrawals require Base's 7-day fraud-proof challenge period unless routed through Relay instead (see below). |
| Ethereum ↔ Robinhood Chain, ETH/USDC | [Arbitrum canonical bridge](https://docs.arbitrum.io/) | Same deposit/withdrawal pattern as Base — Robinhood Chain is built on Arbitrum Orbit. |
| Ethereum ↔ BNB Chain, ETH | [Wormhole Token Bridge](https://wormhole.com/docs) | Lock-and-mint via guardian attestation, both directions. Destination asset is Wormhole-wrapped ETH, not native BNB. |
| Base/Robinhood Chain → Ethereum, ETH; cross-asset swaps; everything else with a verified contract address on both sides (BNB, USDT, USDC, USDG, USDT0 across chains; Base↔Robinhood Chain direct; Stable) | [Relay Protocol](https://docs.relay.link) | Solver network — different trust model than the routes above (you're trusting Relay's solvers to fulfill, not a canonical audited bridge), but non-custodial and typically settles in under a minute. Preferred over the 7-day canonical withdrawal path where available. |

**A pair only routes through Relay if this app has an independently verified contract address for the asset on both chains.** No addresses are ever guessed — an unverified combination has no route offered, and the app checks live before you confirm rather than risk sending funds to the wrong contract.

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

**Creator tools:** the Profile page tracks your launches, holdings, unrealized PnL, and total creator fees earned over time, all in one place.

Contracts (`MangoLaunchHook.sol`, `MangoLaunchRegistry.sol`) are deployed and verified on Robinhood Chain mainnet — see `contracts/` for source and `contracts/Deploy*.s.sol` for the deployment scripts. Real Uniswap v4 addresses, confirmed against actual `forge build` output, not assumed from documentation.

| Contract | Address |
|---|---|
| MangoLaunchHook (v2, current) | [`0x01aC474F17E4d8b29f9f212757953C5E505ad040`](https://robinhoodchain.blockscout.com/address/0x01aC474F17E4d8b29f9f212757953C5E505ad040) |
| MangoLaunchHook (v1, superseded) | [`0x86a8899A5836fBf68F722f260E5106Cb03739040`](https://robinhoodchain.blockscout.com/address/0x86a8899A5836fBf68F722f260E5106Cb03739040) |
| MangoLaunchRegistry | [`0x3441E02E7e9C83EcA78d090Ef279faA7dd719023`](https://robinhoodchain.blockscout.com/address/0x3441E02E7e9C83EcA78d090Ef279faA7dd719023) |

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
- **wagmi / viem** for wallet connection and most on-chain calls
- **ethers v5** specifically for the Arbitrum integration (`@arbitrum/sdk` expects ethers v5 objects internally, not v6 — different chain-ID representations between the two versions caused a real bug during development, documented in `src/arbbridge.js`)
- **@wormhole-foundation/sdk** for the Wormhole integration
- **@web3icons/react** for real, official chain/token logos — static imports only, confirmed against the library's own documented examples one at a time (its dynamic lookup entry point requires a `<Suspense>` boundary this app doesn't have, and caused a real production crash before this was caught)

## Local development

```bash
npm install
npm run dev
```

## Project structure

```
src/
  App.jsx             — main UI, routing logic, transaction flow
  wagmi.js             — chain definitions and wallet config
  networkMode.js       — network mode (mainnet-only)
  cctp.js              — Circle CCTP integration
  opbridge.js          — Base (OP Stack) bridge integration
  arbbridge.js         — Robinhood Chain (Arbitrum) bridge integration
  wormholebridge.js    — Wormhole integration (both directions)
  relaybridge.js       — Relay Protocol integration
```

---

## Security notes

- This app is **non-custodial** — it never holds, pools, or has custody of user funds at any point. Every transfer moves directly from the user's wallet through the underlying protocol's own contracts.
- Different routes carry genuinely different trust models. Canonical bridges (CCTP, OP Stack, Arbitrum) rely on audited contracts with no operator discretion. Wormhole relies on a guardian validator set. Relay relies on a solver network. The app discloses which applies to a given route before confirming a transfer.
- No formal third-party security audit of this app's own integration code has been performed. Contract addresses have been independently verified against official sources for every route in production, but that is not a substitute for an audit.
- If you find a security issue, please report it responsibly rather than exploiting it.

## License

No license has been chosen yet — all rights reserved by default until one is added.

