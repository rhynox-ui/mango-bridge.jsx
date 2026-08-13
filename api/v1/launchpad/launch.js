// api/v1/launchpad/launch.js
//
// GET /api/v1/launchpad/launch?name=...&symbol=...&creator=0x...&devBuyEth=0
//
// Returns real, unsigned transaction data for launching a token on the
// deployed Factory — the exact same call the app's own launch flow
// makes. This endpoint does NOT deploy anything itself; it can't, since
// that would mean holding a private key. You take the returned `to`,
// `data`, and `value`, and send it through your own wallet.

import { encodeFunctionData, isAddress } from "viem";
import { checkRateLimit } from "../../rateLimit.js";

const LAUNCHPAD_FACTORY_ADDRESS = "0x8aD6607EbBAd5F4A088EDC25e98B3B454F9E912A"; // points at Hook v4
const ROBINHOOD_CHAIN_ID = 4663;

const FACTORY_ABI = [
  {
    type: "function",
    name: "launch",
    inputs: [
      { name: "name", type: "string" },
      { name: "symbol", type: "string" },
      { name: "creator", type: "address" },
    ],
    outputs: [{ name: "token", type: "address" }],
    stateMutability: "payable",
  },
];

export default async function handler(request, response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET");

  if (request.method !== "GET") {
    return response.status(405).json({ error: "Method not allowed. This endpoint only supports GET." });
  }

  if (!(await checkRateLimit(request, response, { name: "launchpad-launch", limit: 20 }))) return;

  const { name, symbol, creator, devBuyEth } = request.query;

  if (!name || !symbol || !creator) {
    return response.status(400).json({ error: "Missing required query parameters.", required: ["name", "symbol", "creator"], optional: ["devBuyEth — ETH amount to buy at launch, default 0"] });
  }
  if (!isAddress(creator)) {
    return response.status(400).json({ error: `Invalid creator address: ${creator}` });
  }

  try {
    const data = encodeFunctionData({
      abi: FACTORY_ABI,
      functionName: "launch",
      args: [name, symbol, creator],
    });

    const devBuyEthNum = parseFloat(devBuyEth) || 0;
    const valueWei = BigInt(Math.round(devBuyEthNum * 1e18));

    return response.status(200).json({
      data: {
        to: LAUNCHPAD_FACTORY_ADDRESS,
        data,
        value: valueWei.toString(),
        chainId: ROBINHOOD_CHAIN_ID,
      },
      note: "Unsigned transaction data. Send this through your own wallet on Robinhood Chain (chainId 4663) — this API does not and cannot sign or submit it for you. This has not yet been tested end to end via this specific API path; the same encoded call has compiled cleanly in the app itself but real launches so far have only gone through the app's own UI.",
    });
  } catch (err) {
    return response.status(500).json({ error: err?.message || "Failed to encode launch transaction." });
  }
}
