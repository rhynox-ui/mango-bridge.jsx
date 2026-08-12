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

## Working style established across tonight's sessions

- Small, verified, incremental changes — not large untested rewrites.
- Real error messages surfaced to the user, not swallowed or generic.
- When something breaks, root-cause it with real evidence (actual installed type definitions, actual API responses)
 rather than guessing at a fix.
