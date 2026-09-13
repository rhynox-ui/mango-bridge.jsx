// src/relayChains.js
//
// Live chain support, sourced from Relay's own GET /chains endpoint —
// the exact same endpoint Relay's own official SDK calls internally
// (@relayprotocol/relay-sdk's configureDynamicChains(), confirmed by
// reading that package's shipped source — there's no bundled static
// chain list even in Relay's own SDK). Response shape
// (chains[].id/disabled/depositEnabled) confirmed against
// @relayprotocol/relay-sdk's shipped api.d.ts, not fabricated.
//
// Fetched through this app's OWN backend (api/v1/bridge/relay-chains.js)
// rather than hitting api.relay.link directly from the browser — a real
// bug fix, not a style choice. mango-mobile's own src/bridge/
// relayChains.js (this file's original source — same cache-with-TTL +
// in-flight-dedup pattern, same response handling) calls Relay directly
// and that's fine there: React Native has no browser CORS sandboxing.
// This is a browser, and Relay's API does not appear to send permissive
// CORS headers on that response, so a direct `fetch()` from
// mangoprotocol.site's own origin was silently failing at the browser
// level in production — every wallet-only chain's live availability
// check failing closed, with nothing more specific than a generic
// network error to show for it. Routing through our own backend
// endpoint (which sets its own Access-Control-Allow-Origin) sidesteps
// that entirely; see that file's own header for the full explanation.
//
// Fails closed: any fetch failure (network, bad response shape) just
// throws — App.jsx's own caller treats that identically to "no live
// data yet," which means the Bridge's wallet-only chain pickers fall
// back to exactly the hand-verified 14-chain list that existed before
// this file, never a guess.

const RELAY_CHAINS_URL = "/api/v1/bridge/relay-chains";
const CHAINS_CACHE_TTL_MS = 5 * 60_000;

let cachedChains = null;
let cachedAt = 0;
let inFlight = null;

export async function fetchRelayChains() {
  if (cachedChains && Date.now() - cachedAt < CHAINS_CACHE_TTL_MS) {
    return cachedChains;
  }
  if (inFlight) {
    return inFlight;
  }

  const promise = fetch(RELAY_CHAINS_URL)
    .then((res) => {
      if (!res.ok) {
        throw new Error(`Relay chains fetch failed: ${res.status}`);
      }
      return res.json();
    })
    .then((data) => {
      const chains = Array.isArray(data?.chains) ? data.chains : [];
      cachedChains = chains;
      cachedAt = Date.now();
      return chains;
    })
    .finally(() => {
      inFlight = null;
    });

  inFlight = promise;
  return promise;
}
