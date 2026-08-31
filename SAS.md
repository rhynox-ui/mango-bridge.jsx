# Mango Protocol — Project Context for Claude Code

This file exists because Claude Code has no access to prior claude.ai chat history — this is the persistent bridge. Read this before making changes — it reflects real, tested decisions, not aspirational plans.

## What this project is

Mango Protocol: a non-custodial cross-chain bridge + Uniswap v4 hook-based launchpad, live on mainnet at mangoprotocol.site. Built entirely through a mobile-only, GitHub Codespaces workflow — no local dev machine. See README.md and API.md for the full, current public-facing picture; this file covers the *why* behind decisions that aren't obvious from the code alone.

## Non-negotiable principles, established across many real bugs tonight

- **Never fabricate contract addresses, API endpoints, or technical claims.** Every address in this repo was independently verified against a real source (block explorer, official docs, or a real test transaction) before use. If you don't have a verified value, say so — don't guess.
- **This project is strictly non-custodial.** No code path should ever hold, sign, or submit a transaction on a user's behalf. The API (api/v1/) returns unsigned transaction data for real transactions — the caller's own wallet always signs.
- **Verify before claiming something works.** Tonight's biggest recurring failure mode was assuming an upload/edit succeeded without checking. Always verify file content, run structural checks, or hit a live endpoint before saying something is done.

## Real architecture decisions worth knowing

- **Solana is NOT EVM-compatible** — it required a genuinely separate wallet connection (OKX Connect via `SolanaWalletContext.jsx`), separate execution path (`relaySdkSolanaExecution.js`, using Relay's own SDK), and careful handling everywhere an EVM assumption could silently break something (chain IDs, address formats, native-asset placeholders).
- **`chainData.js` is the single source of truth** for chain IDs, native symbols, and verified token addresses — both the frontend (`relaybridge.js`) and the serverless API endpoints import from here. Don't duplicate this data; extend this file instead.
- **`api/token-activity.js` exports its core functions** (`fetchRealLaunches`, `fetchRealTrades`, `fetchRealHolders`, `readCache`, `writeCache`) specifically so the newer `api/v1/` endpoints can reuse them without duplicating logic or bypassing the shared Blob cache.
- **The launchpad's Explore page filters out tokens from old, broken Hook versions** — a real bug (missing `AFTER_SWAP_RETURNS_DELTA_FLAG` permission) meant some early test tokens are permanently unsellable. The filter recomputes each token's poolId against the *current* Hook address and only shows matches — this is automatic and doesn't need maintaining as Hooks are upgraded.

## Genuine, open gaps — don't assume these are done

- RWA-paired launches (Stock Token pairs like TSLA) are architecturally drafted (`contracts/MangoLaunchFactoryRWA.sol`) but NOT deployed — still needs a real Chainlink feed address and independent fork-test verification.
- The SDK (`sdk/mango-sdk.js`) is real and working but not published as an npm package.
- No formal third-party security audit has been done on this app's own integration code.
- Solana-destination swaps settle as Wrapped SOL (WSOL), not native SOL — disclosed in the UI (BridgeModal's own "Send to another address" section), but there's no auto-unwrap. Building that is a real feature (a second on-chain transaction, the WSOL close-account instruction, after every SOL-destination swap) — hasn't been started, needs an explicit decision first, not a silent build.
- mango-mobile's Bridge has none of this site's native protocols (CCTP, OP Stack canonical bridge, Arbitrum-Orbit, Wormhole) — it only ever routes through Relay/the same-chain fallback DEXs. A real capability gap vs. this site, not yet decided whether to close it.

## Recurring bug patterns worth checking for BEFORE writing new code

Found by re-deriving these from scratch multiple times before finally
writing them down — check for these first when a "swap/bridge doesn't
work" report comes in, before assuming it's a new bug:

- **Decimals mismatch**: a call site reading `ASSET_ONCHAIN_DECIMALS[symbol]` directly instead of the chain-aware `assetDecimalsForChain(chainKey, symbol)` silently applies the wrong decimals on a chain with a non-standard deployment (BNB's USDC/USDT at 18 decimals; Plasma/HyperEVM/Ink's USDT0 at 6, not the global 18 correct only for Stable's own USDT0). Symptom: a wildly wrong (often near-zero or absurdly large) displayed amount.
- **Missing DEFAULT_BALANCES entry** (`src/App.jsx`): every chain in `CHAIN_ORDER` needs its own entry — a missing one crashes `handleComplete` (`Cannot read properties of undefined`) the instant a transaction into that chain completes, escaping past `BridgeModal`'s own try/catch into the top-level `ErrorBoundary`. `solana` was missing this and crashed every same-chain Solana swap until fixed (2026-08-30).
- **Pasted CA is actually a pool/pair address, not the token.** DexScreener/GeckoTerminal chart-page URLs put the *pool* contract address in the URL (`geckoterminal.com/{chain}/pools/0x...`), not the token's own address — an extremely easy copy-paste mistake. Symptom: a real, plausible-looking balance for a *custom* token (some pool contracts respond to ERC-20-shaped reads) but every quote returns 0 or next to nothing, on every provider, regardless of chain. Confirmed live for PONS on Robinhood Chain (2026-08-30): the saved address `0x10CC6BD3...` is the PONS/WETH pool; the real token is `0x39dbed3a2bd333467115de45665cc57f813c4571`. Not fixable in code — it's the *user's* saved custom-token entry — but worth checking FIRST against the token's own real contract address (not the pool/pair page) before assuming a routing bug.
- **A token not on Mango's own Launchpad still gets the generic route.** `api/v1/launchpad/token.js?address=...` (404 = "no launch found") is the fast way to confirm whether a given Robinhood Chain token is one of Mango's own MangoLaunchHook launches (gets the fast, correct `buyTokenReal`/`sellTokenReal` path) or an independent/third-party-platform token (e.g. a "Pons" launchpad token — a *different*, unrelated platform on the same chain) that has to route through Relay/the fallback DEXs like anything else.
- **Robinhood Chain (4663) has thin fallback-provider coverage.** As of 2026-08-30: 1inch and 0x both confirmed NOT supporting it (their own maintained chain lists); KyberSwap's own hand-verified `KYBERSWAP_CHAIN_SLUG` map doesn't include it either. OKX's own coverage is unconfirmed either way — `api/v1/bridge/fallback-supported-chains.js`'s live OKX check kept returning `{"okx":[]}` for a mundane reason: it was calling OKX's now-deprecated v5 chain-list endpoint (`{code:"50050", msg:"V5 API is being deprecated..."}`), fixed to v6. Net effect: for now, a non-Launchpad Robinhood Chain token's ONLY real route is Relay's own solver network — if Relay hasn't indexed it, there is currently no working fallback at all, independent of whether the token's own address is correct.

## Working style established across tonight's sessions

- Small, verified, incremental changes — not large untested rewrites.
- Real error messages surfaced to the user, not swallowed or generic.
- When something breaks, root-cause it with real evidence (actual installed type definitions, actual API responses)
 rather than guessing at a fix.
