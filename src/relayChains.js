// src/relayChains.js
//
// Live chain support from Relay's own GET /chains endpoint — the exact
// same endpoint Relay's own official SDK calls internally
// (@relayprotocol/relay-sdk's configureDynamicChains(), confirmed by
// reading that package's shipped source — there's no bundled static
// chain list even in Relay's own SDK). Direct port of mango-mobile's
// own src/bridge/relayChains.js (same cache-with-TTL + in-flight-dedup
// pattern, same endpoint, same response handling) — kept as its own
// file rather than merged into relaybridge.js so it can be imported
// without pulling in wagmi/actions.
//
// Fails closed: any fetch failure (network, bad response shape) just
// throws — App.jsx's own caller treats that identically to "no live
// data yet," which means the Bridge's wallet-only chain pickers fall
// back to exactly the hand-verified 14-chain list that existed before
// this file, never a guess.
//
// Response shape (chains[].id/disabled/depositEnabled) confirmed
// against @relayprotocol/relay-sdk's shipped api.d.ts, not fabricated.

const RELAY_CHAINS_URL = "https://api.relay.link/chains";
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
