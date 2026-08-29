// api/v1/referral/admin-export.js
//
// GET /api/v1/referral/admin-export
// GET /api/v1/referral/admin-export?format=csv
// Header: Authorization: Bearer <ADMIN_API_SECRET>
//
// Operator-only export of every referral record this app has ever
// created — the concrete answer to "how do we pull the points ledger
// for a reward distribution": nothing else in this API lists records
// across addresses, every other referral endpoint only ever operates
// on one address the caller already proved ownership of via a wallet
// signature. This is deliberately gated differently — a single shared
// secret set in Vercel's own environment variables (ADMIN_API_SECRET),
// not a wallet signature, since there's no "operator wallet" concept
// anywhere else in this codebase to reuse for that.
//
// Fails CLOSED if the secret was never configured — an unset
// ADMIN_API_SECRET rejects every request, including one with no
// Authorization header at all — the safer failure direction for an
// endpoint that would otherwise hand out every user's wallet address
// and points balance to anyone who asks. The comparison itself is
// timing-safe (crypto.timingSafeEqual): worth the two extra lines for
// a secret that gates a bulk PII export, even though nothing else in
// this codebase's simpler per-request secrets bothers with it.
//
// ?format=csv returns address,points,referralCount,referredBy,createdAt
// as a downloadable CSV, ready to paste into a spreadsheet for a reward
// run; the default JSON response is the same data machine-readable.
//
// IMPORTANT for callers: use https://www.mangoprotocol.site/... (not
// the bare mangoprotocol.site apex) if calling with curl -L or any
// client that follows redirects by stripping Authorization on a
// cross-host hop — the apex domain redirects to www, and that redirect
// silently drops the header, producing an Unauthorized that has
// nothing to do with the secret's actual value. Confirmed live: the
// exact same secret worked immediately once called against www
// directly.

import { timingSafeEqual } from "node:crypto";
import { listAllReferralRecords } from "../../referralStore.js";

function safeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function toCsv(records) {
  const header = "address,points,referralCount,referredBy,createdAt\n";
  const rows = records
    .map((r) => [r.address, r.points, r.referralCount, r.referredBy ?? "", r.createdAt ?? ""].join(","))
    .join("\n");
  return header + rows + (records.length > 0 ? "\n" : "");
}

// AdminReferralsPage.jsx now calls this from the browser (real, in-app
// use, not just curl/scripts anymore) — a cross-origin fetch with a
// custom Authorization header triggers a CORS preflight (an OPTIONS
// request) first, and this handler used to only ever answer GET,
// rejecting that preflight with a 405. The browser reports a failed
// preflight to JS as a generic "Failed to fetch", not a real error
// message, which is exactly what that bug looked like live. Scoped to
// this project's own two real domains, not a wildcard "*" — the
// ADMIN_API_SECRET is still the actual gate either way, this is just
// not inviting a third-party page to attempt the call at all.
const ALLOWED_ORIGINS = new Set(["https://mangoprotocol.site", "https://www.mangoprotocol.site"]);

export default async function handler(request, response) {
  const origin = request.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  }

  if (request.method === "OPTIONS") {
    return response.status(204).end();
  }

  if (request.method !== "GET") {
    return response.status(405).json({ error: "Method not allowed. This endpoint only supports GET." });
  }

  const secret = process.env.ADMIN_API_SECRET;
  const provided = (request.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!secret || !provided || !safeEqual(provided, secret)) {
    return response.status(401).json({ error: "Unauthorized." });
  }

  try {
    const records = await listAllReferralRecords();
    if (request.query?.format === "csv") {
      response.setHeader("Content-Type", "text/csv");
      response.setHeader("Content-Disposition", `attachment; filename="mango-referrals-${new Date().toISOString().slice(0, 10)}.csv"`);
      return response.status(200).send(toCsv(records));
    }
    return response.status(200).json({ data: { records, count: records.length } });
  } catch (err) {
    return response.status(500).json({ error: err?.message || "Failed to export referral records." });
  }
}
