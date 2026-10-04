// api/v1/bridge/cross-chain-status.js
//
// Server-side proxy for 0x Cross-Chain status. API credentials stay server-side.

import { checkRateLimit } from "../../rateLimit.js";
import { applyCors } from "../../cors.js";

export default async function handler(request, response) {
  if (applyCors(request, response, { methods: "GET" })) return;

  if (request.method !== "GET") {
    return response.status(405).json({ error: "Method not allowed. This endpoint only supports GET." });
  }

  if (!(await checkRateLimit(request, response, { name: "bridge-cross-chain-status", limit: 30 }))) return;

  const { originChain, originTxHash, quoteId } = request.query || {};
  if (!originChain || !originTxHash) {
    return response.status(400).json({ error: "originChain and originTxHash are required." });
  }

  const apiKey = process.env.ZEROX_API_KEY;
  if (!apiKey) {
    return response.status(503).json({ error: "Cross-chain routing is not configured yet (missing ZEROX_API_KEY)." });
  }

  const params = new URLSearchParams({
    originChain: String(originChain),
    originTxHash: String(originTxHash),
  });
  if (quoteId) params.set("quoteId", String(quoteId));

  try {
    const upstream = await fetch(`https://api.0x.org/cross-chain/status?${params.toString()}`, {
      headers: {"0x-api-key": apiKey, Accept: "application/json"},
    });
    const text = await upstream.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}

    if (!upstream.ok) {
      return response.status(upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502).json({
        error: data?.message || data?.reason || data?.error || "0x cross-chain status failed.",
      });
    }

    return response.status(200).json({
      data: {
        status: data?.status ?? null,
        bridge: data?.bridge ?? null,
        transactions: Array.isArray(data?.transactions) ? data.transactions : [],
        failure: data?.failure ?? null,
        steps: Array.isArray(data?.steps) ? data.steps : [],
      },
    });
  } catch (err) {
    return response.status(502).json({
      error: err instanceof Error ? err.message : "Cross-chain status failed.",
    });
  }
}
