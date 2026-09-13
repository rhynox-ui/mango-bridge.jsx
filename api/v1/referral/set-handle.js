// api/v1/referral/set-handle.js
//
// POST /api/v1/referral/set-handle
// Body: { address, handle, message, signature }
//
// Same signature-ownership requirement as claim.js/daily.js — without
// it, anyone could POST any address and claim a handle for a wallet
// they don't control. The actual uniqueness/immutability guarantee is
// setHandle()'s own atomic Redis NX claim, not anything in this
// handler — see that function's own comment.

import { verifyMessage } from "viem";
import { setHandle, isValidAddress, isValidHandle } from "../../referralStore.js";
import { checkRateLimit } from "../../rateLimit.js";

export function buildSetHandleMessage(address, handle) {
  return `Mango Wallet set referral handle\naddress: ${address.toLowerCase()}\nhandle: ${handle.toLowerCase()}`;
}

export default async function handler(request, response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "POST");

  if (request.method !== "POST") {
    return response.status(405).json({ error: "Method not allowed. This endpoint only supports POST." });
  }

  if (!(await checkRateLimit(request, response, { name: "referral-set-handle", limit: 10 }))) return;

  const { address, handle, message, signature } = request.body || {};

  if (!isValidAddress(address)) {
    return response.status(400).json({ error: "address must be a valid EVM address." });
  }
  if (!isValidHandle(handle)) {
    return response.status(400).json({ error: "handle must be 3-20 characters, letters/numbers/underscore only." });
  }
  if (!signature) {
    return response.status(400).json({ error: "Missing signature." });
  }

  const expectedMessage = buildSetHandleMessage(address, handle);
  if (message !== expectedMessage) {
    return response.status(400).json({ error: "Message does not match the expected set-handle message." });
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
    const result = await setHandle(address, handle);
    if (!result.ok && result.reason === "already-set") {
      return response.status(409).json({ error: `This wallet already has a referral handle: ${result.handle}` });
    }
    if (!result.ok && result.reason === "taken") {
      return response.status(409).json({ error: "That handle is already taken." });
    }
    return response.status(200).json({ data: result });
  } catch (err) {
    return response.status(500).json({ error: err?.message || "Failed to set referral handle." });
  }
}
