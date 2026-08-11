// api/v1/launchpad/token.js
//
// GET /api/v1/launchpad/token?address=0x...
// Real token detail — market data (from the same launches list), plus
// real trades and holders for that specific token, each using the same
// shared Blob cache as the app's own token detail page.

import { fetchRealLaunches, fetchRealTrades, fetchRealHolders, readCache, writeCache, LAUNCHES_CACHE_TTL_MS } from "../../token-activity.js";

const CACHE_TTL_MS = 30_000;

export default async function handler(request, response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET");

  if (request.method !== "GET") {
    return response.status(405).json({ error: "Method not allowed. This endpoint only supports GET." });
  }

  const { address } = request.query;
  if (!address) {
    return response.status(400).json({ error: "Missing required query parameter: address" });
  }

  try {
    const launchesCacheKey = "cache-launches.json";
    let launches = await readCache(launchesCacheKey, LAUNCHES_CACHE_TTL_MS);
    if (!launches) {
      launches = await fetchRealLaunches();
      await writeCache(launchesCacheKey, launches);
    }

    const token = launches.find((t) => t.tokenAddress?.toLowerCase() === address.toLowerCase());
    if (!token) {
      return response.status(404).json({ error: `No launch found for token address ${address}. It may not exist, or may be on an older, unverified Hook version.` });
    }

    const tradesCacheKey = `cache-trades-${token.poolId}.json`;
    let trades = await readCache(tradesCacheKey, CACHE_TTL_MS);
    if (!trades) {
      trades = await fetchRealTrades(token.poolId);
      await writeCache(tradesCacheKey, trades);
    }

    const holdersCacheKey = `cache-holders-${address}.json`;
    let holders = await readCache(holdersCacheKey, CACHE_TTL_MS);
    if (!holders) {
      holders = await fetchRealHolders(address);
      await writeCache(holdersCacheKey, holders);
    }

    return response.status(200).json({ data: { token, trades, holders } });
  } catch (err) {
    return response.status(500).json({ error: err?.message || "Failed to fetch token detail." });
  }
}
