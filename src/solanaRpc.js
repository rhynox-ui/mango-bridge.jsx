// src/solanaRpc.js
//
// Real fallback for Solana RPC calls — @solana/web3.js's Connection class
// is single-endpoint by design (no built-in multi-provider fallback the
// way ethers' FallbackProvider or viem's fallback() transport have), so
// this wraps that gap with a small, explicit retry-the-next-endpoint
// helper instead of leaving every call site pinned to one provider.
//
// Primary stays Solana Tracker's public endpoint — already proven
// reliable in this app (see the original comment this replaces: "free and
// reliable, rather than Solana's own heavily rate-limited default public
// endpoint"). Alchemy is the fallback, gated on VITE_ALCHEMY_API_KEY being
// set — see wagmi.js for why that's an env var instead of a hardcoded key
// (this repo is public; a real API key must never be committed to it).

export const SOLANA_RPC_PRIMARY = "https://rpc.solanatracker.io/public";

export function solanaRpcUrls() {
  const alchemyKey = import.meta.env.VITE_ALCHEMY_API_KEY;
  const urls = [SOLANA_RPC_PRIMARY];
  if (alchemyKey) urls.push(`https://solana-mainnet.g.alchemy.com/v2/${alchemyKey}`);
  return urls;
}

/**
 * Runs `fn(connection)` against each configured Solana RPC URL in order,
 * returning the first success. Only advances to the next URL on a genuine
 * failure (network error, RPC error) — never silently swallows a real
 * result. Throws whatever the LAST attempt threw if every URL fails, so
 * callers see a real, current error rather than a stale one from an
 * earlier attempt.
 */
export async function withSolanaFallback(fn) {
  const urls = solanaRpcUrls();
  let lastError;
  for (const url of urls) {
    try {
      const { Connection } = await import("@solana/web3.js");
      const connection = new Connection(url, "confirmed");
      return await fn(connection);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}
