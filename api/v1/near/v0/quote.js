// api/v1/near/v0/quote.js
//
// POST /api/v1/near/v0/quote — proxies 1Click's POST /v0/quote. The body
// is rebuilt from an allowlist with Mango's fee account pinned (see
// api/oneClickProxy.js for what that closes and why the proxy still
// can't redirect funds).

import { checkRateLimit } from "../../../rateLimit.js";
import { applyCors } from "../../../cors.js";
import { OneClickRequestError, forwardToOneClick, sanitizeOneClickQuoteRequest } from "../../../oneClickProxy.js";

export default async function handler(request, response) {
  if (applyCors(request, response, { methods: "POST" })) return;
  if (request.method !== "POST") {
    return response.status(405).json({ error: "Method not allowed. This endpoint only supports POST." });
  }
  if (!(await checkRateLimit(request, response, { name: "near-quote", limit: 30 }))) return;

  let body;
  try {
    body = sanitizeOneClickQuoteRequest(request.body, process.env.NEAR_FEE_ACCOUNT);
  } catch (err) {
    if (err instanceof OneClickRequestError) return response.status(400).json({ error: err.message });
    throw err;
  }
  return forwardToOneClick(response, "/v0/quote", { method: "POST", body: JSON.stringify(body) });
}
