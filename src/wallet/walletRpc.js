// src/wallet/walletRpc.js
//
// Independent RPC path for Mango Wallet's own balance reads — deliberately
// NOT routed through wagmi's shared Config/React Query client, which is
// what the Bridge tab's connected-wallet calls (useBalance, getBalance,
// readContracts in multiAssetBalances.js) all use. Wallet balance polling
// covers 13 EVM chains at once every time the tab renders; if that shared
// the exact same RPC endpoints as a live bridge transaction in progress,
// the two could contend for the same provider's rate limit right when the
// bridge needs it most.
//
// Both features already have a verified, two-endpoint fallback list per
// chain (wagmi.js's RPC_FALLBACKS — every URL there is independently
// sourced from each chain's own docs or a chain registry, not guessed).
// This reuses those exact endpoints rather than introducing unverified new
// ones, but reverses which endpoint each feature tries FIRST, and builds a
// genuinely separate viem client per chain (its own connection, its own
// cache) — so a burst of wallet reads and a burst of bridge activity don't
// both open with the same provider at the same moment.

import { createPublicClient, http, fallback } from "viem";
import { RPC_FALLBACKS, CHAIN_KEY_TO_WAGMI_MAINNET } from "../wagmi.js";
import { solanaRpcUrls } from "../solanaRpc.js";

const clientCache = new Map();

// Short-lived, in-memory balance cache — same TTL and same reasoning as
// multiAssetBalances.js's own cache: cuts redundant RPC round trips when
// this tab re-renders (switching away and back, an unrelated state
// update remounting a row) within a few seconds, without letting a
// balance go stale for long. The explicit refresh button bypasses this
// via forceFresh, same contract as multiAssetBalances.js.
const BALANCE_CACHE_TTL_MS = 15_000;
const balanceCache = new Map();
function getCached(key) {
  const entry = balanceCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt >= BALANCE_CACHE_TTL_MS) return null;
  return entry.data;
}
function setCached(key, data) {
  balanceCache.set(key, { data, fetchedAt: Date.now() });
}

export function getWalletPublicClient(chainKey) {
  if (clientCache.has(chainKey)) return clientCache.get(chainKey);
  const chain = CHAIN_KEY_TO_WAGMI_MAINNET[chainKey];
  if (!chain) throw new Error(`No mainnet chain configured for key "${chainKey}"`);

  const urls = (RPC_FALLBACKS[chain.id] || []).filter(Boolean);
  const reversedPriority = [...urls].reverse(); // opposite of wagmi.js's transportFor()
  const transport = reversedPriority.length > 0
    ? fallback(reversedPriority.map((url) => http(url)), { rank: true })
    : http(); // no override configured for this chain — chain's own default RPC

  const client = createPublicClient({ chain, transport });
  clientCache.set(chainKey, client);
  return client;
}

/** Native-asset balance for one EVM chain, as a human-readable number. Every native asset this app supports uses 18 decimals. */
export async function fetchWalletNativeBalance(chainKey, address, { forceFresh = false } = {}) {
  const key = `evm:${chainKey}:${address}`;
  if (!forceFresh) {
    const cached = getCached(key);
    if (cached !== null) return cached;
  }
  const client = getWalletPublicClient(chainKey);
  const wei = await client.getBalance({ address });
  const balance = Number(wei) / 1e18;
  setCached(key, balance);
  return balance;
}

/**
 * SOL balance via a reversed-priority endpoint list vs. solanaRpc.js's
 * withSolanaFallback. Honest limit: with no VITE_ALCHEMY_API_KEY set,
 * solanaRpcUrls() only has ONE verified public endpoint (SolanaTracker) —
 * there's no second free, verified Solana RPC in this codebase to genuinely
 * separate from, so in that case this still lands on the same endpoint as
 * every other Solana call. Real separation only kicks in once an Alchemy
 * key is configured (two real endpoints to reorder between); rather than
 * fabricate an unverified second public URL to force separation, this
 * stays honest about that gap.
 */
export async function fetchWalletSolanaBalance(address, { forceFresh = false } = {}) {
  const key = `solana:${address}`;
  if (!forceFresh) {
    const cached = getCached(key);
    if (cached !== null) return cached;
  }
  const urls = [...solanaRpcUrls()].reverse();
  let lastError;
  for (const url of urls) {
    try {
      const { Connection, PublicKey } = await import("@solana/web3.js");
      const connection = new Connection(url, "confirmed");
      const lamports = await connection.getBalance(new PublicKey(address));
      const balance = lamports / 1e9;
      setCached(key, balance);
      return balance;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}
