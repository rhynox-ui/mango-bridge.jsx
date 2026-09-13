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
import { DEV_FEE_WALLET, DEV_FEE_PCT } from "../../../src/devFeeWallets.js";
import { applyCors } from "../../cors.js";

const RELAY_QUOTE_URL = "https://api.relay.link/quote/v2";

// Real vulnerability, closed here: this was a pure passthrough — the
// client's own appFees (which wallet gets Mango's protocol fee, and
// how many basis points) went straight to Relay's real API completely
// unvalidated. That's fine for the real app's own client code (it
// always sends DEV_FEE_WALLET and appFeeBps()'s own capped rate), but
// this endpoint is a public URL with wildcard CORS, callable directly
// by anyone — a raw request, or a malicious clone of this site's own
// frontend hitting this SAME real backend, could set appFees[].recipient
// to an attacker's own wallet (redirecting Mango's rightful fee) and/or
// inflate appFees[].fee well past what a real user should ever be
// charged. Both are now enforced server-side rather than trusted:
// recipient is always overwritten to the real DEV_FEE_WALLET, and fee
// is clamped to DEV_FEE_PCT's own flat rate in bps — provably the true
// upper bound of anything devFeeWallets.js's own appFeeBps() could ever
// legitimately produce (its $50 cap only ever REDUCES the bps from
// that flat rate for a large trade, never raises it).
const MAX_FEE_BPS = Math.round(DEV_FEE_PCT * 10000);

//
// Exported so scripts/verify-fee-tampering.mjs can prove the two
// properties directly, which a later security audit asked for by name:
// an attacker-supplied feeWallet cannot be reached, and an
// attacker-supplied feeBps cannot be inflated. A control with no test
// is a control that can be refactored away by accident.
export function sanitizeAppFees(appFees) {
  // A non-array appFees is not something this app's own client can
  // produce. Dropping it entirely (rather than passing it through
  // unvalidated, as this used to) is the safe direction: the worst
  // outcome is a quote that collects no protocol fee, which costs
  // Mango and never the user.
  if (!Array.isArray(appFees)) return undefined;
  // Rebuilt field by field rather than spread. The old `{ ...entry }`
  // carried every attacker-supplied key straight through to Relay's
  // API alongside the two this function actually controls; nothing
  // needed those keys, and no allowlist is simpler than an allowlist
  // of two.
  return appFees.map((entry) => ({
    recipient: DEV_FEE_WALLET,
    // Math.round, not truncation: a fractional bps is not a thing
    // Relay accepts, and String(12.7) would have been forwarded as-is.
    fee: String(Math.round(Math.max(0, Math.min(Number(entry?.fee) || 0, MAX_FEE_BPS)))),
  }));
}

export default async function handler(request, response) {
  // Allowlisted rather than wildcard — see api/cors.js for what
  // that closes, what is deliberately left public, and why no
  // existing caller breaks. Also answers the preflight this
  // endpoint never had a handler for.
  if (applyCors(request, response, { methods: "POST" })) return;

  if (request.method !== "POST") {
    return response.status(405).json({ error: "Method not allowed. This endpoint only supports POST." });
  }

  if (!(await checkRateLimit(request, response, { name: "bridge-relay-quote", limit: 30 }))) return;

  try {
    const body = { ...(request.body || {}) };
    if (body.appFees) body.appFees = sanitizeAppFees(body.appFees);
    const upstream = await fetch(RELAY_QUOTE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await upstream.text();
    response.status(upstream.status);
    response.setHeader("Content-Type", upstream.headers.get("content-type") || "application/json");
    return response.send(text);
  } catch (err) {
    return response.status(502).json({ error: err?.message || "Could not reach Relay's quote endpoint." });
  }
}
