# Mango Protocol

A cross-chain bridge that routes transfers through the most secure protocol available for each chain pair and asset — rather than relying on one bridge mechanism for everything.


**Status:** Live on mainnet. Non-custodial — this app never holds user funds. Every route either calls an audited canonical bridge directly, or routes through Relay Protocol's solver network for pairs with no canonical bridge available.

---

## Supported chains

- Ethereum
- Base
- BNB Chain
- Robinhood Chain

## Supported assets

ETH, BNB, USDC, USDT, USDG, WBTC — coverage varies by chain pair depending on which protocol handles that route (see below). The app clearly labels which specific pairs are real vs. simulated; nothing is silently faked.

---

## How routing works

For each transfer, the app picks the safest available mechanism for that specific chain pair and asset:

| Route | Protocol | Mechanism |
|---|---|---|
| Ethereum ↔ Base, USDC | [Circle CCTP](https://developers.circle.com/cctp) | Native burn-and-mint. Audited by ChainSecurity and OtterSec. |
| Ethereum ↔ Base, ETH | [OP Stack canonical bridge](https://docs.base.org/base-chain/differences/eth-bridging) | Deposits are fast; withdrawals require Base's 7-day fraud-proof challenge period unless routed through Relay instead (see below). |
| Ethereum ↔ Robinhood Chain, ETH/USDC | [Arbitrum canonical bridge](https://docs.arbitrum.io/) | Same deposit/withdrawal pattern as Base — Robinhood Chain is built on Arbitrum Orbit. |
| Ethereum ↔ BNB Chain, ETH | [Wormhole Token Bridge](https://wormhole.com/docs) | Lock-and-mint via guardian attestation. Destination asset is Wormhole-wrapped ETH, not native BNB. |
| Base/Robinhood Chain → Ethereum, ETH; everything else with a verified contract address (BNB, USDT, USDC, USDG across chains; Base↔Robinhood Chain direct) | [Relay Protocol](https://docs.relay.link) | Solver network — different trust model than the routes above (you're trusting Relay's solvers to fulfill, not a canonical audited bridge), but non-custodial and typically settles in under a minute. Preferred over the 7-day canonical withdrawal path where available. |

**A pair only routes through Relay if this app has an independently verified contract address for the asset on both chains.** No addresses are ever guessed — an unverified combination stays labeled as simulated rather than risk sending funds to the wrong contract.

## Fees

A 1% protocol fee is collected on real transfers, sent as its own separate, visible on-chain transaction — never bundled invisibly into another transfer.

---

## Tech stack

- **React + Vite**, Tailwind CSS
- **wagmi / viem** for wallet connection and most on-chain calls
- **ethers v5** specifically for the Arbitrum integration (`@arbitrum/sdk` expects ethers v5 objects internally, not v6 — different chain-ID representations between the two versions caused a real bug during development, documented in `src/arbbridge.js`)
- **@wormhole-foundation/sdk** for the Wormhole integration

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
