// src/fallbackChains.js
//
// Which chains a same-chain-swap fallback DEX aggregator supports,
// independent of Relay's own /chains list (relayChains.js) — added for
// the Swap chain picker specifically, since a wallet-only chain Relay
// doesn't route can still have a real, working "paste any CA and
// swap it" path through fallbackDex.js's own provider chain, and
// App.jsx's own swapChainOrder was previously gating purely on Relay's
// own live-chain data, hiding every one of those otherwise-workable
// chains from the picker entirely.
//
// Live-fetched through this app's own backend
// (api/v1/bridge/fallback-supported-chains.js) for OKX specifically —
// same server-side-proxy reasoning as relayChains.js's own header:
// OKX's signed request needs credentials that must never reach the
// browser. 1inch and 0x aren't fetched live here (see
// CONFIRMED_FALLBACK_ONLY_CHAINS below) since neither exposes its own
// supported-chains list as a callable endpoint the way OKX and Relay
// both do.

const FALLBACK_SUPPORTED_CHAINS_URL = "/api/v1/bridge/fallback-supported-chains";
const CACHE_TTL_MS = 30 * 60_000;

let cachedOkxChainIds = null;
let cachedAt = 0;
let inFlight = null;

export async function fetchOkxSupportedChainIds() {
  if (cachedOkxChainIds && Date.now() - cachedAt < CACHE_TTL_MS) {
    return cachedOkxChainIds;
  }
  if (inFlight) {
    return inFlight;
  }

  const promise = fetch(FALLBACK_SUPPORTED_CHAINS_URL)
    .then((res) => {
      if (!res.ok) {
        throw new Error(`Fallback supported-chains fetch failed: ${res.status}`);
      }
      return res.json();
    })
    .then((data) => {
      const ids = Array.isArray(data?.okx) ? data.okx : [];
      cachedOkxChainIds = ids;
      cachedAt = Date.now();
      return ids;
    })
    .finally(() => {
      inFlight = null;
    });

  inFlight = promise;
  return promise;
}

// A wallet-only chain 1inch or 0x are confirmed to support for a real
// same-chain swap, even where OKX (checked live above) and Relay
// (relayChains.js) both have no route at all. Static rather than
// live-checked — neither 1inch nor 0x exposes a callable
// supported-chains endpoint the way OKX and Relay both do — so this is
// a real, dated finding, not a guess: confirmed 2026-08-30 against
// 1inch's own maintained chain-id allowlist
// (github.com/1inch/1inch-sdk-go, constants/chains.go) and 0x's own
// published supported-chains docs (0x.org/docs/developer-resources/
// supported-chains). Re-verify against those same sources if either
// provider's coverage is ever suspected to have changed — chain id,
// not app chain key, is what fallbackDex.js's own providers actually
// key off of.
export const CONFIRMED_FALLBACK_ONLY_CHAIN_IDS = [
  250, // fantom — 1inch
  1313161554, // aurora — 1inch
  8217, // kaia — 1inch
];
