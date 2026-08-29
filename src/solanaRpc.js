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
// endpoint"). Alchemy is an optional extra fallback, gated on
// VITE_ALCHEMY_API_KEY being set — see wagmi.js for why that's an env var
// instead of a hardcoded key (this repo is public; a real API key must
// never be committed to it).
//
// Real gap fix: without an Alchemy key configured, this list used to
// have exactly ONE entry — meaning every "fallback" in this file
// (withSolanaFallback, and every read that reverses this array) was
// retrying the same single endpoint, providing zero real redundancy.
// PublicNode is already this codebase's own established, trusted RPC
// provider — wagmi.js/walletChains.js already use it for every EVM
// chain's fallback endpoint (real ethereum-lists/chains-sourced URLs,
// "no Thirdweb" policy) — their Solana endpoint follows the exact
// same {chain}-rpc.publicnode.com naming convention, so this is the
// same trusted source, not a new one, and it's always available
// (keyless), unlike Alchemy.
export const SOLANA_RPC_PRIMARY = "https://rpc.solanatracker.io/public";
const SOLANA_RPC_PUBLICNODE = "https://solana-rpc.publicnode.com";

export function solanaRpcUrls() {
  const alchemyKey = import.meta.env.VITE_ALCHEMY_API_KEY;
  const urls = [SOLANA_RPC_PRIMARY, SOLANA_RPC_PUBLICNODE];
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
