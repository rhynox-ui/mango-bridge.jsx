// api/v1/history/sync.js
//
// POST /api/v1/history/sync
// Body: { address, entry }
//
// Mobile's own txHistory.js calls this fire-and-forget right after
// every real addTxHistoryEntry — never awaited by the UI, never
// retried on failure, exactly like a cache write. See
// txHistoryStore.js's own header for the full reasoning on why this
// is deliberately NOT signature-gated the way automationStore.js's own
// writes are.

import { appendHistoryEntry, isValidHistoryAddress } from "../../txHistoryStore.js";
import { checkRateLimit } from "../../rateLimit.js";

export default async function handler(request, response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "POST");

  if (request.method !== "POST") {
    return response.status(405).json({ error: "Method not allowed. This endpoint only supports POST." });
  }

  if (!(await checkRateLimit(request, response, { name: "history-sync", limit: 30 }))) return;

  const { address, entry } = request.body || {};
  if (!isValidHistoryAddress(address)) {
    return response.status(400).json({ error: "address must be a valid EVM or Solana address." });
  }

  try {
    const result = await appendHistoryEntry(address, entry);
    return response.status(200).json({ data: result });
  } catch (err) {
    return response.status(400).json({ error: err?.message || "Could not sync this history entry." });
  }
}
