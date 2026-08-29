// api/v1/automation/orders.js
//
// GET  /api/v1/automation/orders  -> { data: { automations, ready } }
// POST /api/v1/automation/orders  Body: { type, config } -> { data: automation }
//
// Both require a valid session (automationStore.js's requireSession) —
// this endpoint only ever reads/writes the CALLING wallet's own
// automations, never accepts an address in the body for this part
// (unlike challenge/verify, which are the login flow itself).

import { createAutomation, listAutomations, listReadyJobs, requireSession } from "../../automationStore.js";
import { checkRateLimit } from "../../rateLimit.js";

export default async function handler(request, response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST");

  let owner;
  try {
    owner = await requireSession(request);
  } catch (err) {
    return response.status(401).json({ error: err?.message || "Not signed in." });
  }

  if (request.method === "GET") {
    if (!(await checkRateLimit(request, response, { name: "automation-list", limit: 60 }))) return;
    try {
      const [automations, ready] = await Promise.all([listAutomations(owner), listReadyJobs(owner)]);
      return response.status(200).json({ data: { automations, ready } });
    } catch (err) {
      return response.status(500).json({ error: err?.message || "Could not load automations." });
    }
  }

  if (request.method === "POST") {
    if (!(await checkRateLimit(request, response, { name: "automation-create", limit: 20 }))) return;
    const { type, config } = request.body || {};
    if (type !== "dca" && type !== "limit") {
      return response.status(400).json({ error: "type must be 'dca' or 'limit'." });
    }
    try {
      const record = await createAutomation(owner, type, config || {});
      return response.status(201).json({ data: record });
    } catch (err) {
      return response.status(400).json({ error: err?.message || "Could not create this automation." });
    }
  }

  return response.status(405).json({ error: "Method not allowed. This endpoint supports GET and POST." });
}
