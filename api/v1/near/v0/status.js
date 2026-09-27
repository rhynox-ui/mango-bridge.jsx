// api/v1/near/v0/status.js
//
// GET /api/v1/near/v0/status?depositAddress=... — proxies 1Click's
// GET /v0/status. Polled while a NEAR Intents swap is in flight.

import { checkRateLimit } from "../../../rateLimit.js";
import { applyCors } from "../../../cors.js";
import { forwardToOneClick, isValidDepositAddress } from "../../../oneClickProxy.js";

export default async function handler(request, response) {
  if (applyCors(request, response, { methods: "GET" })) return;
  if (request.method !== "GET") {
    return response.status(405).json({ error: "Method not allowed. This endpoint only supports GET." });
  }
  if (!(await checkRateLimit(request, response, { name: "near-status", limit: 120 }))) return;

  const { depositAddress } = request.query;
  if (!isValidDepositAddress(depositAddress)) {
    return response.status(400).json({ error: "depositAddress is missing or malformed." });
  }
  return forwardToOneClick(response, `/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`, { method: "GET" });
}
