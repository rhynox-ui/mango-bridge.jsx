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

import { getBalance, readContract, readContracts } from "wagmi/actions";
import { config } from "./wagmi.js";
import { getWagmiChain } from "./networkMode.js";
import { TOKEN_ADDRESSES, ASSET_ONCHAIN_DECIMALS, assetDecimalsForChain } from "./relaybridge.js";
import { withSolanaFallback } from "./solanaRpc.js";
import { fetchWalletSplTokenBalance } from "./wallet/walletRpc.js";

const ERC20_BALANCE_ABI = [
  { type: "function", name: "balanceOf", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "decimals", inputs: [], outputs: [{ type: "uint8" }], stateMutability: "view" },
];

// Real, short-lived, in-memory cache — keyed by chain+address, cleared on
// page reload (module-scoped, not persisted). Cuts redundant RPC round
// trips when someone flips back and forth between chains in the asset
// dropdown within a few seconds, without risking a stale balance sticking
// around for long. Callers that need a guaranteed-fresh read (right after
// a transaction completes) pass forceFresh to bypass it entirely.
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
export async function fetchAllEvmBalances({ chainKey, nativeSymbol, address, forceFresh = false }) {
  if (!address) return {};
  const wagmiChain = getWagmiChain(chainKey);
  if (!wagmiChain?.id) return {}; // Solana or otherwise non-EVM — handled separately

  const key = `evm:${chainKey}:${address}`;
  if (!forceFresh) {
    const cached = getCached(key);
    if (cached) return cached;
  }

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
  if (tokens.length > 0) {
    // Real multicall batching — combines what would otherwise be up to
    // 2*N separate RPC calls (balanceOf + decimals per token) into ONE
    // request via Multicall3. Works automatically on every chain pulled
    // from wagmi/chains (arbitrum, avalanche, abstract, etc. — all carry a
    // maintained multicall3 address). robinhood and stable are hand-
    // defined chains in wagmi.js with no multicall3 address configured,
    // so this throws for those specifically — caught below, falling back
    // to the exact original per-token approach, which still works
    // correctly there, just without the batching win. Never a hard
    // failure either way.
    let batched = false;
    try {
      const contracts = tokens.flatMap(({ address: tokenAddress }) => [
        { address: tokenAddress, abi: ERC20_BALANCE_ABI, functionName: "balanceOf", args: [address], chainId: wagmiChain.id },
        { address: tokenAddress, abi: ERC20_BALANCE_ABI, functionName: "decimals", chainId: wagmiChain.id },
      ]);
      const multicallResults = await readContracts(config, { contracts, allowFailure: true });
      tokens.forEach(({ symbol }, i) => {
        const balanceResult = multicallResults[i * 2];
        const decimalsResult = multicallResults[i * 2 + 1];
        // allowFailure:true means a single reverting token doesn't throw
        // the whole batch — same "omit just this entry" principle as the
        // sequential fallback below.
        if (balanceResult?.status === "success" && decimalsResult?.status === "success") {
          results[symbol] = Number(balanceResult.result) / 10 ** decimalsResult.result;
        }
      });
      batched = true;
    } catch {
      // Multicall3 not available on this chain, or some other batch-level
      // failure — fall through to the sequential path below.
    }

    if (!batched) {
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
    }
  }

  setCached(key, results);
  return results;
}

/**
 * Real SOL balance for a connected Solana address — genuinely separate
 * mechanism from the EVM path above, since Solana isn't EVM at all.
 */
export async function fetchSolanaBalance({ solanaAddress, forceFresh = false }) {
  if (!solanaAddress) return {};
  const key = `solana:${solanaAddress}`;
  if (!forceFresh) {
    const cached = getCached(key);
    if (cached) return cached;
  }
  const result = {};
  try {
    const { PublicKey } = await import("@solana/web3.js");
    const lamports = await withSolanaFallback((connection) => connection.getBalance(new PublicKey(solanaAddress)));
    result.SOL = lamports / 1e9;
  } catch {
    // Native balance genuinely unreachable — token balances below can
    // still succeed independently, so don't bail out of the whole
    // function over this one failure.
  }
  // Real bug fix, live-confirmed while auditing mango-mobile's own
  // identical gap: this used to return ONLY the native SOL balance,
  // with no branch at all for a Solana SPL token — even after USDC
  // (and later USDT) got real, verified TOKEN_ADDRESSES.*.solana
  // entries and became selectable as the Bridge's Solana-source asset.
  // Selecting one of them showed no balance for it at all (a symbol
  // this object never had a key for), which could read as "you have
  // zero" for someone who actually held real funds. Mirrors
  // fetchAllEvmBalances' own "every verified token on this chain, not
  // just native" pattern above, reusing the same
  // fetchWalletSplTokenBalance the Mango Wallet dashboard already relies
  // on for this exact read.
  const tokens = Object.entries(TOKEN_ADDRESSES)
    .filter(([, byChain]) => byChain.solana)
    .map(([symbol, byChain]) => ({ symbol, mint: byChain.solana }));
  await Promise.all(
    tokens.map(async ({ symbol, mint }) => {
      try {
        const decimals = assetDecimalsForChain("solana", symbol) ?? ASSET_ONCHAIN_DECIMALS[symbol];
        result[symbol] = await fetchWalletSplTokenBalance(mint, decimals, solanaAddress, { forceFresh });
      } catch {
        // One token's RPC hiccup shouldn't block the others — omit just this entry.
      }
    })
  );
  setCached(key, result);
  return result;
}
