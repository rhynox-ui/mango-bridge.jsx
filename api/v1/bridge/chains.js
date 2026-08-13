// api/v1/bridge/chains.js
//
// GET /api/v1/bridge/chains
// Real, live list of every chain and asset combination this app has an
// independently verified contract address for — reuses chainData.js
// directly, so this can never drift out of sync with what the actual
// bridge itself supports.

import { MAINNET_CHAIN_IDS, NATIVE_SYMBOL, TOKEN_ADDRESSES } from "../../../src/chainData.js";
import { checkRateLimit } from "../../rateLimit.js";

export default async function handler(request, response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET");

  if (request.method !== "GET") {
    return response.status(405).json({ error: "Method not allowed. This endpoint only supports GET." });
  }

  if (!(await checkRateLimit(request, response, { name: "bridge-chains", limit: 60 }))) return;

  const chains = Object.keys(MAINNET_CHAIN_IDS).map((chainKey) => {
    const assets = [NATIVE_SYMBOL[chainKey]];
    for (const [symbol, byChain] of Object.entries(TOKEN_ADDRESSES)) {
      if (byChain[chainKey]) assets.push(symbol);
    }
    return {
      chain: chainKey,
      chainId: MAINNET_CHAIN_IDS[chainKey],
      nativeAsset: NATIVE_SYMBOL[chainKey],
      supportedAssets: assets,
      isSolana: chainKey === "solana",
    };
  });

  return response.status(200).json({ data: chains });
}
