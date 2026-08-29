// api/v1/bridge/relay-status.js
//
// GET /api/v1/bridge/relay-status?requestId=...
// Thin server-side proxy for Relay's own GET /intents/status/v3 — same
// CORS fix as relay-quote.js and relay-chains.js, same reasoning (see
// relay-chains.js's own header for the full explanation). Without this,
// a submitted bridge/swap could broadcast successfully and then never
// resolve to "confirmed" in the UI, stuck polling a request that was
// silently failing at the browser level the whole time.

import { checkRateLimit } from "../../rateLimit.js";

const RELAY_STATUS_URL = "https://api.relay.link/intents/status/v3";

export default async function handler(request, response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET");

  if (request.method !== "GET") {
    return response.status(405).json({ error: "Method not allowed. This endpoint only supports GET." });
  }

  if (!(await checkRateLimit(request, response, { name: "bridge-relay-status", limit: 120 }))) return;

  const { requestId } = request.query;
  if (typeof requestId !== "string" || !requestId) {
    return response.status(400).json({ error: "requestId is required." });
  }

  try {
    const upstream = await fetch(`${RELAY_STATUS_URL}?requestId=${encodeURIComponent(requestId)}`);
    const text = await upstream.text();
    response.status(upstream.status);
    response.setHeader("Content-Type", upstream.headers.get("content-type") || "application/json");
    return response.send(text);
  } catch (err) {
    return response.status(502).json({ error: err?.message || "Could not reach Relay's status endpoint." });
  }
}
