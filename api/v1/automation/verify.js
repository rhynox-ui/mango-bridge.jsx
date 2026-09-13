// api/v1/automation/verify.js
//
// POST /api/v1/automation/verify
// Body: { address, message, signature }
// -> { data: { token, expiresIn } }
//
// Completes the challenge started by challenge.js — the ONLY thing
// this backend ever learns about the wallet is that it can produce a
// valid signature for its own address. The returned token is an
// opaque, server-generated, 256-bit random string (not a JWT — no
// signing secret to manage or leak; see automationStore.js's own
// requireSession for how it's checked), stored server-side so it can
// be revoked, unlike a self-contained signed token.

import { verifyMessage } from "viem";
import { verifyChallenge, isValidAddress } from "../../automationStore.js";
import { checkRateLimit } from "../../rateLimit.js";

export default async function handler(request, response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "POST");

  if (request.method !== "POST") {
    return response.status(405).json({ error: "Method not allowed. This endpoint only supports POST." });
  }
  if (!(await checkRateLimit(request, response, { name: "automation-verify", limit: 20 }))) return;

  const { address, message, signature } = request.body || {};
  if (!isValidAddress(address) || typeof message !== "string" || typeof signature !== "string") {
    return response.status(400).json({ error: "address, message, and signature are all required." });
  }

  try {
    const result = await verifyChallenge({ address, message, signature, verifyMessageFn: verifyMessage });
    if (!result.ok) {
      return response.status(401).json({ error: result.error });
    }
    return response.status(200).json({ data: { token: result.token, expiresIn: result.expiresIn } });
  } catch (err) {
    return response.status(500).json({ error: err?.message || "Could not verify automation login." });
  }
}
