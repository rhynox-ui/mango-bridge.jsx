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
//
// `referrer` accepts EITHER a raw EVM address OR a claimed referral
// handle (set-handle.js) — resolved to the underlying wallet address
// right here, server-side, before crediting. Deliberately NOT resolved
// client-side: the signed message binds whatever raw string the user's
// client sent as `referrer` (a handle stays a handle in the signed
// message, never silently swapped for an address before signing), so
// resolving here — using this server's own authoritative reverse-lookup,
// not anything the client asserts — is what actually satisfies "resolve
// the handle and credit the underlying wallet" without weakening the
// signature's own binding guarantee.

import { verifyMessage } from "viem";
import { claimReferral, isValidAddress, isValidHandle, resolveHandle } from "../../referralStore.js";
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

  if (!isValidAddress(address)) {
    return response.status(400).json({ error: "address must be a valid EVM address." });
  }
  if (!isValidAddress(referrer) && !isValidHandle(referrer)) {
    return response.status(400).json({ error: "referrer must be a valid EVM address or referral handle." });
  }
  if (!signature) {
    return response.status(400).json({ error: "Missing signature." });
  }

  // The signed message binds whatever raw string was typed — a handle
  // stays a handle here, resolved to a real address only after the
  // signature itself is verified against it.
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

  const resolvedReferrer = isValidAddress(referrer) ? referrer : await resolveHandle(referrer);
  if (!resolvedReferrer) {
    return response.status(404).json({ error: "No wallet has claimed this referral handle." });
  }
  if (address.toLowerCase() === resolvedReferrer.toLowerCase()) {
    return response.status(400).json({ error: "A wallet cannot refer itself." });
  }

  try {
    const result = await claimReferral({ address, referrer: resolvedReferrer });
    if (result.alreadyClaimed) {
      return response.status(409).json({ error: "This wallet has already claimed its signup bonus." });
    }
    return response.status(200).json({ data: result });
  } catch (err) {
    return response.status(500).json({ error: err?.message || "Failed to record referral claim." });
  }
}
