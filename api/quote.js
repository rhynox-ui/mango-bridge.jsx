// api/v1/launchpad/quote.js
//
// GET /api/v1/launchpad/quote?tokenAddress=0x...&side=buy&slippagePercent=5
//
// Real, live trade quote for a launchpad token — reads the pool's actual
// current price on-chain, same source of truth the app's own buy/sell UI
// uses. Uses viem directly (like token-activity.js already does) rather
// than wagmi/actions, since viem is fully platform-agnostic and safe in
// a Node.js serverless function; wagmi/actions expects a browser-
// connected wallet client.
//
// Same honest limitation as the app's own version of this logic: this is
// the pool's SPOT price, not a full swap simulation — a reasonable
// estimate for small trades relative to pool depth, less precise for
// large ones. Not a substitute for the real, live quote your wallet gets
// at execution time.

import { createPublicClient, http, keccak256, encodeAbiParameters, parseAbiParameters } from "viem";

const LAUNCHPAD_HOOK_ADDRESS = "0x6df44617b8C13AB961dCe5097F9375AE6BE09044";
const STATE_VIEW_ADDRESS = "0xF3334192D15450CdD385c8B70e03f9A6bD9E673b";
const POOL_FEE = 3000;
const TICK_SPACING = 60;

const STATE_VIEW_ABI = [
  {
    type: "function",
    name: "getSlot0",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "protocolFee", type: "uint24" },
      { name: "lpFee", type: "uint24" },
    ],
    stateMutability: "view",
  },
];

const client = createPublicClient({
  transport: http("https://rpc.mainnet.chain.robinhood.com"),
});

function computePoolId(tokenAddress) {
  return keccak256(
    encodeAbiParameters(
      parseAbiParameters("address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks"),
      ["0x0000000000000000000000000000000000000000", tokenAddress, POOL_FEE, TICK_SPACING, LAUNCHPAD_HOOK_ADDRESS]
    )
  );
}

export default async function handler(request, response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET");

  if (request.method !== "GET") {
    return response.status(405).json({ error: "Method not allowed. This endpoint only supports GET." });
  }

  const { tokenAddress, side, slippagePercent } = request.query;

  if (!tokenAddress || !side) {
    return response.status(400).json({ error: "Missing required query parameters.", required: ["tokenAddress", "side (\"buy\" or \"sell\")"], optional: ["slippagePercent — default 5"] });
  }
  if (side !== "buy" && side !== "sell") {
    return response.status(400).json({ error: 'side must be exactly "buy" or "sell".' });
  }

  try {
    const poolId = computePoolId(tokenAddress);
    const slot0 = await client.readContract({
      address: STATE_VIEW_ADDRESS,
      abi: STATE_VIEW_ABI,
      functionName: "getSlot0",
      args: [poolId],
    });

    const currentSqrtPriceX96 = slot0[0];
    const slippageFactor = (Number(slippagePercent) || 5) / 100;

    // Same direction logic as the app itself: buy pushes price down
    // (zeroForOne=true) -> lower bound; sell pushes price up -> upper bound.
    const sqrtPriceLimitX96 = side === "buy"
      ? BigInt(Math.floor(Number(currentSqrtPriceX96) * (1 - slippageFactor)))
      : BigInt(Math.ceil(Number(currentSqrtPriceX96) * (1 + slippageFactor)));

    return response.status(200).json({
      data: {
        poolId,
        currentSqrtPriceX96: currentSqrtPriceX96.toString(),
        sqrtPriceLimitX96: sqrtPriceLimitX96.toString(),
        side,
        slippagePercent: Number(slippagePercent) || 5,
      },
      note: "This is a spot-price estimate, not a full swap simulation. Real price impact at execution may differ, especially for larger trades.",
    });
  } catch (err) {
    return response.status(500).json({ error: err?.message || "Failed to fetch trade quote. The pool may not exist yet, or the token address may be invalid." });
  }
}
