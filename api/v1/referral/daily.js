// api/v1/referral/daily.js
//
// POST /api/v1/referral/daily
// Body: { address, message, signature }
//
// Daily check-in — same signature-ownership requirement as claim.js
// (without it, anyone could POST any address and farm its daily
// points). The actual anti-farm guarantee is claimDailyPoints()'s
// atomic Redis lock, not anything in this handler — see that
// function's own comment.

import { verifyMessage } from "viem";
import { claimDailyPoints, isValidAddress } from "../../referralStore.js";
import { checkRateLimit } from "../../rateLimit.js";

export function buildDailyClaimMessage(address) {
  return `Mango Wallet daily check-in\naddress: ${address.toLowerCase()}`;
}

export default async function handler(request, response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "POST");

  if (request.method !== "POST") {
    return response.status(405).json({ error: "Method not allowed. This endpoint only supports POST." });
  }

  if (!(await checkRateLimit(request, response, { name: "referral-daily", limit: 10 }))) return;

  const { address, message, signature } = request.body || {};

  if (!isValidAddress(address)) {
    return response.status(400).json({ error: "address must be a valid EVM address." });
  }
  if (!signature) {
    return response.status(400).json({ error: "Missing signature." });
  }

  const expectedMessage = buildDailyClaimMessage(address);
  if (message !== expectedMessage) {
    return response.status(400).json({ error: "Message does not match the expected daily check-in message." });
  }

  let signatureValid = false;
  try {
    signatureValid = await verifyMessage({ address, message, signature });
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) {
    return response.status(401).json({ error: "Signature does not match the claimed address." });
  }

  try {
    const result = await claimDailyPoints(address);
    if (!result.claimed) {
      return response.status(429).json({
        error: "Daily check-in already claimed. Try again later.",
        secondsUntilNextClaim: result.secondsUntilNextClaim,
      });
    }
    return response.status(200).json({ data: result });
  } catch (err) {
    return response.status(500).json({ error: err?.message || "Failed to record daily check-in." });
  }
}
