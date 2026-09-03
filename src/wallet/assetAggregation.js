// src/wallet/assetAggregation.js
//
// Groups the wallet's flat per-chain balance list into ONE row per asset
// that actually exists on more than one chain — "ETH" as a single row
// with a real summed total and "N networks", instead of N near-identical
// rows. Ported from mango-mobile's src/wallet/assetAggregation.ts, and
// split into its own module for the same reason that file is: it is pure
// logic, so it can be exercised under plain Node
// (scripts/verify-asset-aggregation.mjs) without React, a browser, or a
// wallet.
//
// The two lookups it needs are INJECTED rather than imported, which is
// what keeps it pure — MangoWallet.jsx passes its own
// NATIVE_SYMBOL_BY_CHAIN and allTokensForChain, and a test passes
// fixtures.
//
// An asset on only ONE chain is returned as its original per-chain row,
// never as an aggregate of one, so nothing about a single-chain asset's
// row or behaviour changes.
//
// Custom tokens are deliberately NEVER grouped. A token a user added
// themselves is not assumed to be "the same asset" as a same-named token
// on another chain just because the symbols match — unlike a verified
// registry entry, nothing here confirms that, and silently summing two
// unrelated tokens into one total would be a wrong number presented as a
// confident one. Solana stays ungrouped for a related reason: it is a
// different address space with different verification.

export function buildAggregatedRows(chainOrder, { nativeSymbolFor, tokensFor }) {
  const groups = new Map();
  const singles = [];

  function add(symbol, source) {
    if (!symbol) return;
    if (!groups.has(symbol)) groups.set(symbol, []);
    groups.get(symbol).push(source);
  }

  for (const chainKey of chainOrder) {
    if (chainKey === "solana") {
      singles.push({ kind: "solana-native", chainKey });
      for (const token of tokensFor("solana")) {
        singles.push({ kind: "spl-token", chainKey, token });
      }
      continue;
    }
    const nativeSymbol = nativeSymbolFor(chainKey);
    add(nativeSymbol, { kind: "evm-native", chainKey, symbol: nativeSymbol });
    for (const token of tokensFor(chainKey)) {
      if (token.isCustom) {
        singles.push({ kind: "evm-token", chainKey, token });
      } else {
        add(token.symbol, { kind: "evm-token", chainKey, token, symbol: token.symbol });
      }
    }
  }

  const rows = [];
  for (const [symbol, sources] of groups) {
    rows.push(sources.length > 1 ? { kind: "aggregate", symbol, sources } : sources[0]);
  }
  return [...rows, ...singles];
}
