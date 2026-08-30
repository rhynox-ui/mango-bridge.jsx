// api/v1/history/list.js
//
// GET /api/v1/history/list?address=0x...
//
// Called once per active address on app startup (after a fresh
// install/reinstall re-imports a wallet, or a returning user just
// opens the app) — merged into the on-device list rather than
// replacing it, so a slow/failed fetch here never loses anything the
// device already has. See txHistoryStore.js's own header for why this
// is address-keyed with no signature required.

import { listHistoryEntries, isValidHistoryAddress } from "../../txHistoryStore.js";
import { checkRateLimit } from "../../rateLimit.js";

export default async function handler(request, response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET");

  if (request.method !== "GET") {
    return response.status(405).json({ error: "Method not allowed. This endpoint only supports GET." });
  }

  if (!(await checkRateLimit(request, response, { name: "history-list", limit: 30 }))) return;

  const { address } = request.query || {};
  if (!isValidHistoryAddress(address)) {
    return response.status(400).json({ error: "address must be a valid EVM or Solana address." });
  }

  try {
    const entries = await listHistoryEntries(address);
    return response.status(200).json({ data: { entries } });
  } catch (err) {
    return response.status(500).json({ error: err?.message || "Could not load synced history." });
  }
}
