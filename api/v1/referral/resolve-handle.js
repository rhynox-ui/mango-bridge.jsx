// api/v1/referral/resolve-handle.js
//
// GET /api/v1/referral/resolve-handle?handle=mangoli
// Read-only, unauthenticated — same reasoning as me.js: which address
// claimed a given handle is no more sensitive than the address itself
// (already fully public on-chain), so this doesn't need a signature.
//
// Used by the client to preview/validate a typed referral handle
// before submitting it (onboarding's "Referral address (optional)"
// field, the Referral & Points screen's own claim form) — claim.js
// itself does its own, independent server-side resolution before
// crediting, so this endpoint is a UX convenience, never the source of
// truth for what actually gets credited.

import { resolveHandle, isValidHandle } from "../../referralStore.js";
import { checkRateLimit } from "../../rateLimit.js";

export default async function handler(request, response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET");

  if (request.method !== "GET") {
    return response.status(405).json({ error: "Method not allowed. This endpoint only supports GET." });
  }

  if (!(await checkRateLimit(request, response, { name: "referral-resolve-handle", limit: 30 }))) return;

  const { handle } = request.query;
  if (!isValidHandle(handle)) {
    return response.status(400).json({ error: "Missing or invalid required query parameter: handle" });
  }

  try {
    const address = await resolveHandle(handle);
    if (!address) {
      return response.status(404).json({ error: "No wallet has claimed this handle." });
    }
    return response.status(200).json({ data: { handle, address } });
  } catch (err) {
    return response.status(500).json({ error: err?.message || "Failed to resolve referral handle." });
  }
}
