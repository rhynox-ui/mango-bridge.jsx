// src/multiAssetBalances.js
//
// Real, live balance fetching for every asset relevant to a given chain —
// powers the "which assets do I actually hold, and how much" display in
// the asset selector dropdown. Reuses TOKEN_ADDRESSES from relaybridge.js
// directly, rather than duplicating those already-verified addresses.
//
// Uses imperative wagmi/actions calls (getBalance, readContract), not the
// useBalance hook — hooks can't be called in a loop over a dynamic list
// of assets, and the number of relevant assets genuinely differs per
// chain (Ethereum has USDC/USDT/WBTC, Stable only has USDT0, etc).

import { getBalance, readContract } from "wagmi/actions";
import { config } from "./wagmi.js";
import { getWagmiChain } from "./networkMode.js";
import { TOKEN_ADDRESSES } from "./relaybridge.js";

const ERC20_BALANCE_ABI = [
  { type: "function", name: "balanceOf", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "decimals", inputs: [], outputs: [{ type: "uint8" }], stateMutability: "view" },
];

// Every asset symbol our app knows about, and which chains actually have
// a real, verified address for it — driven directly from
// TOKEN_ADDRESSES, so this never silently drifts out of sync with what's
// actually been verified elsewhere in the app.
function tokenAssetsForChain(chainKey) {
  return Object.entries(TOKEN_ADDRESSES)
    .filter(([, byChain]) => byChain[chainKey])
    .map(([symbol, byChain]) => ({ symbol, address: byChain[chainKey] }));
}

/**
 * Fetches real balances for every asset relevant to a given EVM chain —
 * the native asset plus every ERC-20 with a verified address there.
 * Returns { SYMBOL: balanceAsNumber }. Assets with no real address on
 * this chain simply aren't included, rather than showing a misleading 0
 * for something that doesn't actually exist there.
 */
export async function fetchAllEvmBalances({ chainKey, nativeSymbol, address }) {
  if (!address) return {};
  const wagmiChain = getWagmiChain(chainKey);
  if (!wagmiChain?.id) return {}; // Solana or otherwise non-EVM — handled separately

  const results = {};

  // Native balance first — always real, always relevant.
  try {
    const native = await getBalance(config, { address, chainId: wagmiChain.id });
    results[nativeSymbol] = Number(native.formatted);
  } catch {
    // Real RPC failures shouldn't crash the whole dropdown — just omit
    // this one entry, same principle as the token loop below.
  }

  // Every ERC-20 with a real, verified address on this specific chain.
  const tokens = tokenAssetsForChain(chainKey);
  await Promise.all(
    tokens.map(async ({ symbol, address: tokenAddress }) => {
      try {
        const [rawBalance, decimals] = await Promise.all([
          readContract(config, { address: tokenAddress, abi: ERC20_BALANCE_ABI, functionName: "balanceOf", args: [address], chainId: wagmiChain.id }),
          readContract(config, { address: tokenAddress, abi: ERC20_BALANCE_ABI, functionName: "decimals", chainId: wagmiChain.id }),
        ]);
        results[symbol] = Number(rawBalance) / 10 ** decimals;
      } catch {
        // One token's RPC hiccup shouldn't block the others — omit just this entry.
      }
    })
  );

  return results;
}

/**
 * Real SOL balance for a connected Solana address — genuinely separate
 * mechanism from the EVM path above, since Solana isn't EVM at all.
 */
export async function fetchSolanaBalance({ solanaAddress }) {
  if (!solanaAddress) return {};
  try {
    const { Connection, PublicKey } = await import("@solana/web3.js");
    const connection = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
    const lamports = await connection.getBalance(new PublicKey(solanaAddress));
    return { SOL: lamports / 1e9 };
  } catch {
    return {};
  }
}
