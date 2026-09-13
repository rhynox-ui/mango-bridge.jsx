// api/v1/referral/me.js
//
// GET /api/v1/referral/me?address=0x...
// Read-only, unauthenticated — a wallet's referral points/count is no
// more sensitive than its on-chain balance (already fully public), so
// this doesn't need the signature check claim.js requires for writes.

import { getReferralStats, isValidAddress } from "../../referralStore.js";
import { checkRateLimit } from "../../rateLimit.js";

export default async function handler(request, response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET");

  if (request.method !== "GET") {
    return response.status(405).json({ error: "Method not allowed. This endpoint only supports GET." });
  }

  if (!(await checkRateLimit(request, response, { name: "referral-me", limit: 30 }))) return;

  const { address } = request.query;
  if (!isValidAddress(address)) {
    return response.status(400).json({ error: "Missing or invalid required query parameter: address" });
  }

  try {
    const stats = await getReferralStats(address);
    return response.status(200).json({ data: stats });
  } catch (err) {
    return response.status(500).json({ error: err?.message || "Failed to fetch referral stats." });
  }
}
