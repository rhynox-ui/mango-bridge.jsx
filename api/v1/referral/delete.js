// api/v1/referral/delete.js
//
// POST /api/v1/referral/delete
// Body: { address, message, signature }
//
// Real, automated version of the manual email-request flow
// (app-delete-data.html, still linked from Settings for anyone who'd
// rather not sign a message) — same signature-ownership requirement as
// claim.js/daily.js, so only the wallet's own owner can request
// deletion of their own record. Removes referralStore.js's
// deleteReferralRecord — the complete set of server-side data this app
// stores about a wallet address (see that function's own comment for
// exactly which keys, and referralStore.js's module header for why any
// of it exists server-side at all).

import { verifyMessage } from "viem";
import { deleteReferralRecord, isValidAddress } from "../../referralStore.js";
import { checkRateLimit } from "../../rateLimit.js";

export function buildDeleteMessage(address) {
  return `Mango Wallet delete my data\naddress: ${address.toLowerCase()}`;
}

export default async function handler(request, response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "POST");

  if (request.method !== "POST") {
    return response.status(405).json({ error: "Method not allowed. This endpoint only supports POST." });
  }

  if (!(await checkRateLimit(request, response, { name: "referral-delete", limit: 5 }))) return;

  const { address, message, signature } = request.body || {};

  if (!isValidAddress(address)) {
    return response.status(400).json({ error: "address must be a valid EVM address." });
  }
  if (!signature) {
    return response.status(400).json({ error: "Missing signature." });
  }

  const expectedMessage = buildDeleteMessage(address);
  if (message !== expectedMessage) {
    return response.status(400).json({ error: "Message does not match the expected delete-data message." });
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
    const result = await deleteReferralRecord(address);
    return response.status(200).json({ data: result });
  } catch (err) {
    return response.status(500).json({ error: err?.message || "Failed to delete this record." });
  }
}
