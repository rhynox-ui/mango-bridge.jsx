// api/v1/client-error.js
//
// POST /api/v1/client-error
// Real, minimal client-side crash reporting — wired into main.jsx's
// top-level ErrorBoundary (componentDidCatch), which previously only
// did `console.error` in the USER'S OWN browser console: invisible to
// anyone who isn't the person hitting the crash, sitting right there
// with devtools open. Live-reported crash (a Solana same-chain Swap
// hitting the full-page "Something went wrong" screen) had to be
// root-caused by manual code audit with zero stack trace to go on —
// this closes that gap for any FUTURE crash: the real error message,
// stack, and component stack now land in this endpoint's own server
// logs (visible via Vercel's runtime logs), not just the reporting
// user's local console.
//
// Deliberately NOT a full Sentry-style service — no dashboard, no
// alerting, no persistence beyond Vercel's own log retention. Just
// console.error on the server side, which is enough to actually SEE
// the next crash instead of guessing at it, without provisioning any
// new third-party account/credential for it.
//
// Fire-and-forget from the client (main.jsx never awaits this, never
// blocks the crash screen on it) — this endpoint failing is never
// itself a reason to make the user's already-bad moment worse.

import { checkRateLimit } from "../rateLimit.js";

export default async function handler(request, response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "POST");

  if (request.method !== "POST") {
    return response.status(405).json({ error: "Method not allowed. This endpoint only supports POST." });
  }

  // Generous limit — a real crash storm (the same bug hitting many
  // users at once) is exactly the case where seeing every report
  // matters most, not the case to throttle hardest.
  if (!(await checkRateLimit(request, response, { name: "client-error", limit: 120 }))) return;

  const { message, stack, componentStack, url, userAgent } = request.body || {};
  if (!message) {
    return response.status(400).json({ error: "message is required." });
  }

  // Bounded so one pathological report (a stack trace generator gone
  // wrong, or someone deliberately spamming this endpoint) can't fill
  // Vercel's log storage — same "never trust client input's size"
  // principle this app's other public endpoints already follow.
  const clamp = (s, max) => (typeof s === "string" ? s.slice(0, max) : undefined);
  console.error("[client-error]", JSON.stringify({
    message: clamp(message, 2000),
    stack: clamp(stack, 8000),
    componentStack: clamp(componentStack, 8000),
    url: clamp(url, 500),
    userAgent: clamp(userAgent, 300),
    at: new Date().toISOString(),
  }));

  return response.status(204).end();
}
