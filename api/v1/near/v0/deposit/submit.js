// api/v1/near/v0/deposit/submit.js
//
// POST /api/v1/near/v0/deposit/submit — proxies 1Click's
// POST /v0/deposit/submit, which tells 1Click about a deposit tx so it
// starts processing without waiting to notice it on-chain. Optional for
// correctness; only { txHash, depositAddress } are forwarded.

import { checkRateLimit } from "../../../../rateLimit.js";
import { applyCors } from "../../../../cors.js";
import { OneClickRequestError, forwardToOneClick, sanitizeDepositSubmit } from "../../../../oneClickProxy.js";

export default async function handler(request, response) {
  if (applyCors(request, response, { methods: "POST" })) return;
  if (request.method !== "POST") {
    return response.status(405).json({ error: "Method not allowed. This endpoint only supports POST." });
  }
  if (!(await checkRateLimit(request, response, { name: "near-deposit-submit", limit: 30 }))) return;

  let body;
  try {
    body = sanitizeDepositSubmit(request.body);
  } catch (err) {
    if (err instanceof OneClickRequestError) return response.status(400).json({ error: err.message });
    throw err;
  }
  return forwardToOneClick(response, "/v0/deposit/submit", { method: "POST", body: JSON.stringify(body) });
}
