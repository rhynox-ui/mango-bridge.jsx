// api/v1/referral/claim.js
//
// POST /api/v1/referral/claim
// Body: { address, referrer, message, signature }
//
// The only write in the referral system, so it's the only endpoint
// that needs real proof of wallet ownership: without the signature
// check below, anyone could POST any address and credit it points, or
// repeatedly farm the referrer reward. `message` must be exactly
// `buildReferralClaimMessage(address, referrer)` — binding the address
// AND referrer into the signed message means a signature captured for
// one referral can't be replayed to claim a different one.

import { verifyMessage } from "viem";
import { claimReferral, isValidAddress } from "../../referralStore.js";
import { checkRateLimit } from "../../rateLimit.js";

export function buildReferralClaimMessage(address, referrer) {
  return `Mango Wallet referral claim\naddress: ${address.toLowerCase()}\nreferrer: ${referrer.toLowerCase()}`;
}

export default async function handler(request, response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "POST");

  if (request.method !== "POST") {
    return response.status(405).json({ error: "Method not allowed. This endpoint only supports POST." });
  }

  if (!(await checkRateLimit(request, response, { name: "referral-claim", limit: 10 }))) return;

  const { address, referrer, message, signature } = request.body || {};

  if (!isValidAddress(address) || !isValidAddress(referrer)) {
    return response.status(400).json({ error: "address and referrer must both be valid EVM addresses." });
  }
  if (address.toLowerCase() === referrer.toLowerCase()) {
    return response.status(400).json({ error: "A wallet cannot refer itself." });
  }
  if (!signature) {
    return response.status(400).json({ error: "Missing signature." });
  }

  const expectedMessage = buildReferralClaimMessage(address, referrer);
  if (message !== expectedMessage) {
    return response.status(400).json({ error: "Message does not match the expected referral claim message." });
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
    const result = await claimReferral({ address, referrer });
    if (result.alreadyClaimed) {
      return response.status(409).json({ error: "This wallet has already claimed its signup bonus." });
    }
    return response.status(200).json({ data: result });
  } catch (err) {
    return response.status(500).json({ error: err?.message || "Failed to record referral claim." });
  }
}
