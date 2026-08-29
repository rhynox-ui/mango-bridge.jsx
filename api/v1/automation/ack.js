// api/v1/automation/ack.js
//
// POST /api/v1/automation/ack
// Body: { jobId, status: 'success'|'failed'|'pending', hashes?, error? }
// -> { data: { ok, automation? } }
//
// Reports the REAL outcome of executing a claimed job — status must be
// exactly one of the three mango-mobile's own txHistory.js already
// uses (see that file's own doc on why 'pending' is a distinct, real
// outcome, not just a flavor of 'failed'). See automationStore.js's
// ackJob for exactly how each outcome advances (or halts) the parent
// automation's own schedule.

import { ackJob, requireSession } from "../../automationStore.js";
import { checkRateLimit } from "../../rateLimit.js";

const VALID_STATUSES = new Set(["success", "failed", "pending"]);

export default async function handler(request, response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "POST");

  if (request.method !== "POST") {
    return response.status(405).json({ error: "Method not allowed. This endpoint only supports POST." });
  }
  if (!(await checkRateLimit(request, response, { name: "automation-ack", limit: 60 }))) return;

  let owner;
  try {
    owner = await requireSession(request);
  } catch (err) {
    return response.status(401).json({ error: err?.message || "Not signed in." });
  }

  const { jobId, status, hashes, error } = request.body || {};
  if (typeof jobId !== "string" || !jobId || !VALID_STATUSES.has(status)) {
    return response.status(400).json({ error: "jobId is required, and status must be 'success', 'failed', or 'pending'." });
  }

  try {
    const result = await ackJob(owner, jobId, { status, hashes: Array.isArray(hashes) ? hashes : [], error: typeof error === "string" ? error : null });
    return response.status(200).json({ data: result });
  } catch (err) {
    return response.status(409).json({ error: err?.message || "Could not acknowledge this job." });
  }
}
