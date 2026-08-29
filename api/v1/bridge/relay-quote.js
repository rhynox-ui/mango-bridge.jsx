// api/v1/bridge/relay-quote.js
//
// POST /api/v1/bridge/relay-quote
// Thin server-side proxy for Relay's own POST /quote/v2 — passes the
// request body straight through and returns Relay's response straight
// through, unwrapped, so src/relaybridge.js's getRelayQuote (the app's
// OWN internal quote path, distinct from the public api/v1/bridge/quote.js
// endpoint documented for third-party API consumers) needs no change
// beyond the URL it posts to.
//
// Real bug fix, not a style choice — see api/v1/bridge/relay-chains.js's
// own header for the full explanation (same root cause, same fix):
// a browser fetch() straight to api.relay.link does not appear to get a
// permissive Access-Control-Allow-Origin back, so this was silently
// failing at the browser level from mangoprotocol.site's own origin —
// every quote request, the actual core of Bridge and Swap. Routing
// through this app's own backend sidesteps it: server-to-server has no
// CORS concept, and this endpoint sets its own
// Access-Control-Allow-Origin for the browser's request to it.
//
// Deliberately NOT the same endpoint as api/v1/bridge/quote.js: that one
// is a documented, GET-based public API (query params, hand-verified
// currencyAddress() only, no appFees) — a drop-in swap would have
// silently dropped this app's own protocol-fee collection. This proxy
// exists purely to unblock the browser; it doesn't reshape the request
// at all, so the client keeps building the exact same body (including
// appFees) it always has.

import { checkRateLimit } from "../../rateLimit.js";

const RELAY_QUOTE_URL = "https://api.relay.link/quote/v2";

export default async function handler(request, response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "POST");

  if (request.method !== "POST") {
    return response.status(405).json({ error: "Method not allowed. This endpoint only supports POST." });
  }

  if (!(await checkRateLimit(request, response, { name: "bridge-relay-quote", limit: 30 }))) return;

  try {
    const upstream = await fetch(RELAY_QUOTE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request.body || {}),
    });
    const text = await upstream.text();
    response.status(upstream.status);
    response.setHeader("Content-Type", upstream.headers.get("content-type") || "application/json");
    return response.send(text);
  } catch (err) {
    return response.status(502).json({ error: err?.message || "Could not reach Relay's quote endpoint." });
  }
}
