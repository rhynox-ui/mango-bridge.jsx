// api/v1/near/v0/tokens.js
//
// GET /api/v1/near/v0/tokens — proxies 1Click's GET /v0/tokens (the
// supported asset list with asset ids and decimals). Cached at the edge
// for five minutes: it changes rarely and every quote screen needs it.

import { checkRateLimit } from "../../../rateLimit.js";
import { applyCors } from "../../../cors.js";
import { forwardToOneClick } from "../../../oneClickProxy.js";

export default async function handler(request, response) {
  if (applyCors(request, response, { methods: "GET" })) return;
  if (request.method !== "GET") {
    return response.status(405).json({ error: "Method not allowed. This endpoint only supports GET." });
  }
  if (!(await checkRateLimit(request, response, { name: "near-tokens", limit: 60 }))) return;

  response.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=600");
  return forwardToOneClick(response, "/v0/tokens", { method: "GET" });
}
