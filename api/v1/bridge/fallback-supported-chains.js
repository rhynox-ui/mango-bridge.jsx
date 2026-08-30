// api/v1/bridge/fallback-supported-chains.js
//
// GET /api/v1/bridge/fallback-supported-chains
// Which chains OKX's own DEX aggregator currently supports — real,
// live data, not a hand-maintained guess. Added to answer a genuine
// gap found while auditing Swap coverage for the 69 wallet-only
// chains: Relay's own /chains list (relay-chains.js) only covers 27 of
// them, and OKX is the one fallback provider in this app's own
// FALLBACK_PROVIDERS order (fallbackDex.js) with a real chance of
// covering many of the rest — but unlike 1inch/0x (queried directly
// with no allowlist, since a wrong chain id there just 404s) and
// KyberSwap (whose own chain list is small and hand-verified inline in
// fallback-quote.js), OKX's chain coverage isn't something safe to
// guess at for deciding which chains to even OFFER in the Swap chain
// picker — an unsupported chain shown as selectable is exactly the "I
// can't trade this" complaint this endpoint exists to prevent.
//
// Same server-side-proxy reasoning as relay-chains.js: OKX's endpoint
// needs the same signed (OK-ACCESS-KEY/SIGN/PASSPHRASE/TIMESTAMP)
// request fallback-quote.js's own quoteFromOKX already sends, and
// those three credentials must never reach a browser or the mobile
// app's own bundle — this is the one place they're used for a
// read-only capability check instead of an actual quote.
//
// Reuses okxSignRequest from fallback-quote.js rather than
// re-implementing the same HMAC scheme a second time.
//
// Endpoint path/shape (GET /api/v5/dex/aggregator/supported/chain,
// {code, data: [{chainId, chainName, ...}]}) matches OKX's own
// current developer-portal docs and their official okx-dex-sdk /
// dex-api-library repos on GitHub — not the same base path as
// quoteFromOKX's own v6 swap endpoint (OKX versions this specific
// endpoint separately; confirmed against their own docs, not assumed
// to match just because the swap endpoint is v6).
//
// Fails closed, same as relay-chains.js: any fetch/auth/shape failure
// returns an empty chainIds list rather than a 500 — a caller that
// can't get a real answer here should treat every wallet-only chain as
// "not confirmed via OKX," not crash the whole live-chain check that
// also depends on Relay's own list succeeding independently.

import { checkRateLimit } from "../../rateLimit.js";
import { okxSignRequest } from "./fallback-quote.js";

const OKX_CHAINS_PATH = "/api/v5/dex/aggregator/supported/chain";
const CACHE_TTL_MS = 30 * 60_000; // real chain support changes rarely — longer TTL than relay-chains.js's own 5min is fine here

let cachedChainIds = null;
let cachedAt = 0;

export default async function handler(request, response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET");

  if (request.method !== "GET") {
    return response.status(405).json({ error: "Method not allowed. This endpoint only supports GET." });
  }

  if (!(await checkRateLimit(request, response, { name: "bridge-fallback-supported-chains", limit: 60 }))) return;

  if (cachedChainIds && Date.now() - cachedAt < CACHE_TTL_MS) {
    return response.status(200).json({ okx: cachedChainIds });
  }

  const apiKey = process.env.OKX_API_KEY;
  const secretKey = process.env.OKX_SECRET_KEY;
  const passphrase = process.env.OKX_PASSPHRASE;
  if (!apiKey || !secretKey || !passphrase) {
    // Not configured — same "fail closed, not fail loud" choice as a
    // fetch failure below. This endpoint's only job is to ADD chains
    // to what Relay already offers, never to be a hard dependency.
    return response.status(200).json({ okx: [] });
  }

  try {
    const timestamp = new Date().toISOString();
    const upstream = await fetch(`https://web3.okx.com${OKX_CHAINS_PATH}`, {
      headers: {
        "OK-ACCESS-KEY": apiKey,
        "OK-ACCESS-SIGN": okxSignRequest({ method: "GET", requestPath: OKX_CHAINS_PATH, timestamp, secretKey }),
        "OK-ACCESS-PASSPHRASE": passphrase,
        "OK-ACCESS-TIMESTAMP": timestamp,
        "Content-Type": "application/json",
      },
    });
    if (!upstream.ok) {
      return response.status(200).json({ okx: [] });
    }
    const json = await upstream.json();
    if (json?.code !== "0" || !Array.isArray(json?.data)) {
      return response.status(200).json({ okx: [] });
    }
    const chainIds = json.data
      .map((c) => Number(c?.chainId))
      .filter((id) => Number.isFinite(id));
    cachedChainIds = chainIds;
    cachedAt = Date.now();
    return response.status(200).json({ okx: chainIds });
  } catch {
    return response.status(200).json({ okx: [] });
  }
}
