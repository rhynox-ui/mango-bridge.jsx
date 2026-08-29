// api/v1/automation/cancel.js
//
// POST /api/v1/automation/cancel
// Body: { id }
// -> { data: automation }

import { cancelAutomation, requireSession } from "../../automationStore.js";
import { checkRateLimit } from "../../rateLimit.js";

export default async function handler(request, response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "POST");

  if (request.method !== "POST") {
    return response.status(405).json({ error: "Method not allowed. This endpoint only supports POST." });
  }
  if (!(await checkRateLimit(request, response, { name: "automation-cancel", limit: 30 }))) return;

  let owner;
  try {
    owner = await requireSession(request);
  } catch (err) {
    return response.status(401).json({ error: err?.message || "Not signed in." });
  }

  const { id } = request.body || {};
  if (typeof id !== "string" || !id) {
    return response.status(400).json({ error: "id is required." });
  }

  try {
    const record = await cancelAutomation(owner, id);
    return response.status(200).json({ data: record });
  } catch (err) {
    return response.status(404).json({ error: err?.message || "Automation not found." });
  }
}
