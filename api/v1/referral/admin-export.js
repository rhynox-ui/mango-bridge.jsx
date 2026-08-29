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

// Deliberately no Access-Control-Allow-Origin header, unlike every
// other endpoint in this API — this is meant to be called from a
// script/curl with the secret, never from a public browser page. The
// secret is the real gate either way; this is just not inviting
// browser-based use of it.
export default async function handler(request, response) {
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
