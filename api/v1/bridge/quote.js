// api/v1/bridge/quote.js
//
// GET /api/v1/bridge/quote?from=base&to=solana&fromAsset=ETH&toAsset=SOL&amount=0.1&userAddress=0x...&recipient=...
//
// Real, live Relay quote — fee, ETA, and the actual unsigned transaction
// steps needed to execute the transfer. This endpoint NEVER signs or
// submits anything — Mango Protocol is non-custodial, and an API that
// could move funds on someone's behalf would break that. The caller's
// own wallet signs whatever this returns; this just builds the real
// quote and hands back what a wallet would need to execute it.
//
// Deliberately does NOT import relaybridge.js directly — that file also
// imports wagmi/actions, which expects a browser-connected wallet client
// and shouldn't be pulled into a Node.js serverless function even
// unused. This reuses only the pure, platform-agnostic pieces from
// chainData.js instead.

import { MAINNET_CHAIN_IDS, currencyAddress, ASSET_ONCHAIN_DECIMALS } from "../../../src/chainData.js";

const RELAY_QUOTE_URL = "https://api.relay.link/quote/v2";

export default async function handler(request, response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET");

  if (request.method !== "GET") {
    return response.status(405).json({ error: "Method not allowed. This endpoint only supports GET." });
  }

  const { from, to, fromAsset, toAsset, amount, userAddress, recipient } = request.query;

  if (!from || !to || !fromAsset || !toAsset || !amount || !userAddress) {
    return response.status(400).json({
      error: "Missing required query parameters.",
      required: ["from", "to", "fromAsset", "toAsset", "amount", "userAddress"],
      optional: ["recipient — defaults to userAddress if omitted"],
    });
  }

  try {
    const decimals = ASSET_ONCHAIN_DECIMALS[fromAsset];
    if (!decimals) {
      return response.status(400).json({ error: `Unknown asset symbol: ${fromAsset}` });
    }

    // Real, exact base-unit conversion — matches parseUnits' own logic
    // (integer arithmetic, not floating point, since floating point loses
    // precision on real token amounts).
    const [whole, frac = ""] = String(amount).split(".");
    const paddedFrac = (frac + "0".repeat(decimals)).slice(0, decimals);
    const amountBaseUnits = (BigInt(whole || "0") * (10n ** BigInt(decimals)) + BigInt(paddedFrac || "0")).toString();

    const body = {
      user: userAddress,
      recipient: recipient || userAddress,
      originChainId: MAINNET_CHAIN_IDS[from],
      destinationChainId: MAINNET_CHAIN_IDS[to],
      originCurrency: currencyAddress(from, fromAsset),
      destinationCurrency: currencyAddress(to, toAsset),
      amount: amountBaseUnits,
      tradeType: "EXACT_INPUT",
    };

    const relayResponse = await fetch(RELAY_QUOTE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!relayResponse.ok) {
      const errText = await relayResponse.text();
      return response.status(relayResponse.status).json({ error: `Relay quote failed: ${errText}` });
    }

    const quote = await relayResponse.json();
    return response.status(200).json({ data: quote, note: "This is an unsigned quote. Sign and submit the returned transaction steps with your own wallet — this API never signs on your behalf." });
  } catch (err) {
    return response.status(500).json({ error: err?.message || "Failed to fetch bridge quote." });
  }
}
