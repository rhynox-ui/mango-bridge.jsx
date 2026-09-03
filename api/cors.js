// api/cors.js
//
// One place for the CORS decision, added for the security audit's
// finding #4: "the relay quote endpoint sets Access-Control-Allow-
// Origin: *. This is not automatically exploitable, but unnecessarily
// exposes a production API to arbitrary origins."
//
// WHAT A WILDCARD ACTUALLY COSTS HERE. None of these endpoints use
// cookies or set Access-Control-Allow-Credentials, so a wildcard is not
// a session-theft vector — the audit says as much. What it does allow is
// any page anywhere using this backend as its own: a cloned Mango
// frontend quoting through our infrastructure and our paid 1inch/0x/OKX
// keys, on our rate limits. That is the thing worth closing.
//
// WHAT IS DELIBERATELY LEFT WILDCARD. api/v1/bridge/quote.js and
// api/v1/bridge/chains.js are a DOCUMENTED public API — API.md tells
// third parties to call them, with example curl commands. Locking those
// down would break the integration this project published on purpose.
// The endpoints this helper is applied to are the app's own internal
// plumbing, which nothing outside this app was ever invited to call.
//
// WHY NOTHING BREAKS. CORS is a browser mechanism and only applies to
// cross-origin browser requests:
//   - The site's own calls are same-origin — never subject to a CORS
//     check at all, whatever this returns.
//   - The mobile app and any server-to-server caller send no Origin
//     header; they are unaffected by design.
//   - The browser extension does not call /api/v1 at all (checked: it
//     talks to public RPCs and DexScreener directly).
//   - localhost and Vercel preview deployments are allowlisted below so
//     development and preview branches keep working.
//
// Preflights are answered here too. These endpoints previously set
// Access-Control-Allow-Methods but had no OPTIONS handler, so a genuine
// cross-origin POST would have failed its preflight with a 405 anyway —
// this makes the allowed case actually work rather than merely appear to.

const ALLOWED_ORIGINS = new Set([
  "https://mangoprotocol.site",
  "https://www.mangoprotocol.site",
]);

// Vercel gives every preview deployment its own generated hostname, so
// these cannot be enumerated — matched by shape instead. Anchored at
// both ends: "https://evil.com/?x=.vercel.app" must not match.
const PREVIEW_ORIGIN = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.vercel\.app$/i;
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

export function isAllowedOrigin(origin) {
  if (typeof origin !== "string" || origin === "") return false;
  return ALLOWED_ORIGINS.has(origin) || PREVIEW_ORIGIN.test(origin) || LOCAL_ORIGIN.test(origin);
}

/**
 * Applies the CORS headers for this request and answers a preflight.
 *
 * Returns true when the handler should stop (the request was an OPTIONS
 * preflight and has been answered), false when it should carry on.
 *
 * A request with no Origin header gets no CORS headers and is NOT
 * rejected: it isn't a browser cross-origin request, so there is
 * nothing for CORS to decide. Rejecting those would break the mobile
 * app and every curl.
 */
export function applyCors(request, response, { methods = "POST" } = {}) {
  const origin = request.headers?.origin;
  if (isAllowedOrigin(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    // Tells caches that the response body depends on the request's
    // Origin — without it a shared cache can serve one origin's
    // allowed response to another origin.
    response.setHeader("Vary", "Origin");
    response.setHeader("Access-Control-Allow-Methods", `${methods}, OPTIONS`);
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
    response.setHeader("Access-Control-Max-Age", "86400");
  }
  if (request.method === "OPTIONS") {
    response.status(204).end();
    return true;
  }
  return false;
}
