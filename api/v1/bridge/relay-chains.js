// api/v1/bridge/relay-chains.js
//
// GET /api/v1/bridge/relay-chains
// Thin server-side proxy for Relay's own GET /chains — passes the raw
// response straight through, unwrapped (unlike this app's other api/v1
// endpoints), so src/relayChains.js's existing client-side parsing
// (`data.chains`) needs no change beyond the URL it fetches.
//
// Real bug fix, not a style choice: src/relayChains.js was calling
// https://api.relay.link/chains directly from the browser. That works
// from a server or from React Native (mango-mobile's own copy of this
// same file, no browser sandboxing), but Relay's API does not appear to
// send permissive CORS headers on that response, so a browser `fetch()`
// from mangoprotocol.site's own origin silently fails at the browser
// level — the request never even reaches this app's own error handling
// with anything more specific than a generic network error. That
// silently kept every wallet-only chain's live availability check
// failing closed in production, while mango-mobile's identical-looking
// code worked fine (no browser, no CORS). Routing through this app's
// own backend sidesteps it entirely: server-to-server has no CORS
// concept, and this endpoint sets its own Access-Control-Allow-Origin
// for the browser's request to it.
//
// A short in-memory cache, same TTL as the client's own — this endpoint
// can be hit by many users' browsers in the same minute, and there's no
// reason to re-fetch Relay's own list that often; a cold serverless
// instance just fetches fresh, same as before this file existed.

import { checkRateLimit } from "../../rateLimit.js";
import { applyCors } from "../../cors.js";

const RELAY_CHAINS_URL = "https://api.relay.link/chains";
const CACHE_TTL_MS = 5 * 60_000;

let cachedBody = null;
let cachedAt = 0;

export default async function handler(request, response) {
  // Allowlisted rather than wildcard — see api/cors.js for what
  // that closes, what is deliberately left public, and why no
  // existing caller breaks. Also answers the preflight this
  // endpoint never had a handler for.
  if (applyCors(request, response, { methods: "GET" })) return;

  if (request.method !== "GET") {
    return response.status(405).json({ error: "Method not allowed. This endpoint only supports GET." });
  }

  if (!(await checkRateLimit(request, response, { name: "bridge-relay-chains", limit: 60 }))) return;

  if (cachedBody && Date.now() - cachedAt < CACHE_TTL_MS) {
    return response.status(200).json(cachedBody);
  }

  try {
    const upstream = await fetch(RELAY_CHAINS_URL);
    if (!upstream.ok) {
      return response.status(502).json({ error: `Relay chains fetch failed: ${upstream.status}` });
    }
    const body = await upstream.json();
    cachedBody = body;
    cachedAt = Date.now();
    return response.status(200).json(body);
  } catch (err) {
    return response.status(502).json({ error: err?.message || "Could not reach Relay's chains endpoint." });
  }
}
