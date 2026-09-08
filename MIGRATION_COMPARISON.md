# Mango API Migration Comparison

## Purpose
Map the legacy Vercel `api/` structure in `mango-bridge.jsx` against the Cloudflare `mango-api` backend before removing legacy code.

## Current mapping

| Legacy Vercel area | Cloudflare equivalent | Status |
|---|---|---|
| `/api/v1/bridge/chains.js` | `router.js` → `bridge.js` | MIGRATED |
| `/api/v1/bridge/quote.js` | `router.js` → `bridge.js` | MIGRATED |
| `/api/v1/bridge/relay-chains.js` | `router.js` → `relay-chains.js` | MIGRATED |
| `/api/v1/bridge/relay-quote.js` | `router.js` → `relay-quote.js` | MIGRATED |
| `/api/v1/bridge/relay-status.js` | `router.js` → `relay-status.js` | MIGRATED |
| `/api/v1/bridge/fallback-quote.js` | `router.js` → `fallback.js` | MIGRATED |
| `/api/v1/bridge/fallback-supported-chains.js` | `router.js` → `fallback-chains.js` | MIGRATED |
| `/api/v1/history/list.js` | `router.js` → `history.js` | MIGRATED |
| `/api/v1/history/sync.js` | `router.js` → `history.js` | MIGRATED |
| `/api/v1/client-error.js` | `router.js` → `client-error.js` | MIGRATED |
| `/api/v1/referral/*` | `router.js` → `referral.js` | MIGRATED |
| `/api/automation-worker.js` | `router.js` → `automation-worker.js` | MIGRATED |
| `/api/blob-upload.js` | `worker.js` → R2 / `blob-upload.js` | MIGRATED |
| `/api/logo-registry.js` | `worker.js` → R2 / `logo-registry.js` | MIGRATED |
| `/api/token-activity.js` | `worker.js` native token activity | MIGRATED + LIVE VERIFIED |
| `/api/automationStore.js` | `router.js` → automation handlers | REVIEW |
| `/api/txHistoryStore.js` | Cloudflare history/R2 path | REVIEW |
| `/api/rateLimit.js` | Cloudflare equivalent not yet confirmed | MISSING / REVIEW |
| `/blog/api/create-post.js` | No Cloudflare equivalent confirmed | MISSING |

## Important finding

The frontend can continue using `/api/...` URLs. The migration does not require rewriting every browser call if Cloudflare owns the production `/api/*` routes.

The old Vercel functions should not be deleted until the REVIEW/MISSING rows are resolved and the production domain is confirmed to route `/api/*` to Cloudflare.

## Vercel configuration

`vercel.json` currently contains temporary rewrites for:
- `/api/token-activity`
- `/api/logo-registry`
- `/api/blob-upload`

These are migration compatibility rules, not the desired final architecture.

## Final target

`mangoprotocol.site` → Cloudflare → frontend + `mango-api` Worker → R2 / Robinhood RPC / Relay / providers.

Vercel should have no required role in the production API request path.

## Next audit

1. Confirm every legacy Vercel API file.
2. Confirm every Cloudflare handler's request/response compatibility.
3. Resolve `rateLimit.js`, `automationStore.js`, `txHistoryStore.js`, and blog admin API.
4. Remove Cloudflare's legacy Vercel fallback only after equivalent paths are verified.
5. Remove temporary Vercel rewrites when Cloudflare production routing is live.
