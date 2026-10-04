// api/v1/bridge/cross-chain-quote.js
//
// Server-side proxy for 0x Cross-Chain API. The mobile wallet never receives
// the 0x API key. This endpoint is deliberately quote-only: it returns the
// signed/ready-to-sign origin transaction and the exact route metadata so
// Mango Pro can run its own intent firewall before signing.
//
// POST body:
// {
//   originChain, destinationChain, sellToken, buyToken, sellAmount,
//   originAddress, recipient?, slippageBps?
// }
//
// 0x Cross-Chain supports EVM + Solana origins/destinations. Robinhood Chain
// (4663) and Solana are both currently supported. The caller still decides
// whether the returned route is safe; this proxy never signs for the user.

import { checkRateLimit } from "../../rateLimit.js";
import { DEV_FEE_WALLET, DEV_FEE_PCT } from "../../../src/devFeeWallets.js";
import { applyCors } from "../../cors.js";

const MAX_FEE_BPS = Math.round(DEV_FEE_PCT * 10000);
const MAX_SLIPPAGE_BPS = 5000;

function clampInteger(value, max) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) return null;
  return Math.min(n, max);
}

export default async function handler(request, response) {
  if (applyCors(request, response, { methods: "POST" })) return;

  if (request.method !== "POST") {
    return response.status(405).json({ error: "Method not allowed. This endpoint only supports POST." });
  }

  if (!(await checkRateLimit(request, response, { name: "bridge-cross-chain-quote", limit: 12 }))) return;

  const {
    originChain,
    destinationChain,
    sellToken,
    buyToken,
    sellAmount,
    originAddress,
    recipient,
    slippageBps,
  } = request.body || {};

  if (!originChain || !destinationChain || !sellToken || !buyToken || !sellAmount || !originAddress) {
    return response.status(400).json({
      error: "originChain, destinationChain, sellToken, buyToken, sellAmount, and originAddress are all required.",
    });
  }

  const amount = String(sellAmount);
  if (!/^\d+$/.test(amount) || BigInt(amount) <= 0n) {
    return response.status(400).json({ error: "sellAmount must be a positive integer string." });
  }

  const safeSlippage = clampInteger(slippageBps, MAX_SLIPPAGE_BPS);
  const safeFeeBps = Math.max(0, Math.min(MAX_FEE_BPS, MAX_FEE_BPS));

  const params = new URLSearchParams({
    originChain: String(originChain),
    destinationChain: String(destinationChain),
    sellToken: String(sellToken),
    buyToken: String(buyToken),
    sellAmount: amount,
    originAddress: String(originAddress),
    sortQuotesBy: "price",
    maxNumQuotes: "1",
    feeBps: String(safeFeeBps),
    feeRecipient: DEV_FEE_WALLET,
  });

  if (recipient) params.set("recipient", String(recipient));
  if (safeSlippage !== null) params.set("slippageBps", String(safeSlippage));

  const apiKey = process.env.ZEROX_API_KEY;
  if (!apiKey) {
    return response.status(503).json({ error: "Cross-chain routing is not configured yet (missing ZEROX_API_KEY)." });
  }

  try {
    const upstream = await fetch(`https://api.0x.org/cross-chain/quotes?${params.toString()}`, {
      headers: {
        "0x-api-key": apiKey,
        "Accept": "application/json",
      },
    });

    const text = await upstream.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}

    if (!upstream.ok) {
      return response.status(upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502).json({
        error: data?.message || data?.reason || data?.error || "0x cross-chain quote failed.",
        upstreamStatus: upstream.status,
      });
    }

    if (!data?.liquidityAvailable || !Array.isArray(data.quotes) || data.quotes.length === 0) {
      return response.status(404).json({ error: "No cross-chain liquidity is available for this route." });
    }

    const quote = data.quotes[0];
    if (!quote?.quoteId || !quote?.transaction?.details) {
      return response.status(502).json({ error: "0x returned an incomplete executable cross-chain quote." });
    }

    // Return only the data Mango needs. Do not forward the API key or
    // unrelated upstream metadata.
    return response.status(200).json({
      data: {
        liquidityAvailable: true,
        originChainId: data.originChainId,
        originChain: data.originChain,
        destinationChainId: data.destinationChainId,
        destinationChain: data.destinationChain,
        sellToken: data.sellToken,
        buyToken: data.buyToken,
        allowanceTarget: data.allowanceTarget ?? null,
        issues: {
          allowance: data.issues?.allowance ?? quote.issues?.allowance ?? null,
          simulationIncomplete: Boolean(data.issues?.simulationIncomplete ?? quote.issues?.simulationIncomplete),
        },
        quote: {
          sellAmount: quote.sellAmount,
          buyAmount: quote.buyAmount,
          minBuyAmount: quote.minBuyAmount,
          quoteId: quote.quoteId,
          fees: quote.fees ?? null,
          gasCosts: quote.gasCosts ?? null,
          steps: quote.steps ?? [],
          transaction: quote.transaction,
          estimatedTimeSeconds: quote.estimatedTimeSeconds ?? null,
        },
      },
    });
  } catch (err) {
    return response.status(502).json({
      error: err instanceof Error ? err.message : "Cross-chain quote failed.",
    });
  }
}
