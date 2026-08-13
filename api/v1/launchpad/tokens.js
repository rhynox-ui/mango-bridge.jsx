// api/v1/launchpad/tokens.js
//
// GET /api/v1/launchpad/tokens
// Real, live launchpad token list — reuses the exact same shared Blob
// cache and cache key as the app's own Explore page (api/token-activity.js
// with type=launches), so this endpoint and the app itself never trigger
// redundant, expensive on-chain scans of each other's requests. Vercel
// functions are stateless between cold starts, so an in-memory cache here
// wouldn't reliably persist — the shared Blob store is the real cache.

import { fetchRealLaunches, readCache, writeCache, LAUNCHES_CACHE_TTL_MS } from "../../token-activity.js";
import { checkRateLimit } from "../../rateLimit.js";

export default async function handler(request, response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET");

  if (request.method !== "GET") {
    return response.status(405).json({ error: "Method not allowed. This endpoint only supports GET." });
  }

  if (!(await checkRateLimit(request, response, { name: "launchpad-tokens", limit: 30 }))) return;

  try {
    const cacheKey = "cache-launches.json";
    const cached = await readCache(cacheKey, LAUNCHES_CACHE_TTL_MS);
    if (cached) return response.status(200).json({ data: cached, cached: true });

    const fresh = await fetchRealLaunches();
    await writeCache(cacheKey, fresh);
    return response.status(200).json({ data: fresh, cached: false });
  } catch (err) {
    return response.status(500).json({ error: err?.message || "Failed to fetch launchpad tokens." });
  }
}
