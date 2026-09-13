// api/v1/automation/claim.js
//
// POST /api/v1/automation/claim
// Body: { jobId }
// -> { data: job }
//
// Marks a ready job as claimed by the calling wallet so it can execute
// it on-device (getRelayQuote/executeRelayQuote in mango-mobile's own
// automationEngine.ts) — see automationStore.js's claimJob for the
// real concurrency guarantee (a Redis SET NX EX lock, not an
// application-level check) that stops two devices from claiming the
// same job.

import { claimJob, requireSession } from "../../automationStore.js";
import { checkRateLimit } from "../../rateLimit.js";

export default async function handler(request, response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "POST");

  if (request.method !== "POST") {
    return response.status(405).json({ error: "Method not allowed. This endpoint only supports POST." });
  }
  if (!(await checkRateLimit(request, response, { name: "automation-claim", limit: 60 }))) return;

  let owner;
  try {
    owner = await requireSession(request);
  } catch (err) {
    return response.status(401).json({ error: err?.message || "Not signed in." });
  }

  const { jobId } = request.body || {};
  if (typeof jobId !== "string" || !jobId) {
    return response.status(400).json({ error: "jobId is required." });
  }

  try {
    const job = await claimJob(owner, jobId);
    return response.status(200).json({ data: job });
  } catch (err) {
    return response.status(409).json({ error: err?.message || "Could not claim this job." });
  }
}
