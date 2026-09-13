// api/v1/automation/challenge.js
//
// POST /api/v1/automation/challenge
// Body: { address }
// -> { data: { message } }
//
// First step of the same non-custodial challenge/sign/verify login
// api/v1/referral/claim.js's own signature check already establishes —
// this just issues the challenge; verify.js checks the signed result.

import { createChallenge, isValidAddress } from "../../automationStore.js";
import { checkRateLimit } from "../../rateLimit.js";

export default async function handler(request, response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "POST");

  if (request.method !== "POST") {
    return response.status(405).json({ error: "Method not allowed. This endpoint only supports POST." });
  }
  if (!(await checkRateLimit(request, response, { name: "automation-challenge", limit: 20 }))) return;

  const { address } = request.body || {};
  if (!isValidAddress(address)) {
    return response.status(400).json({ error: "address must be a valid EVM address." });
  }

  try {
    const message = await createChallenge(address);
    return response.status(200).json({ data: { message } });
  } catch (err) {
    return response.status(500).json({ error: err?.message || "Could not create automation login challenge." });
  }
}
