// scripts/verify-asset-aggregation.mjs
//
// Tests for src/wallet/assetAggregation.js — the grouping that turns a
// flat per-chain balance list into one row per multi-chain asset.
//
// This is worth testing rather than eyeballing because the failure mode
// is silent and it is about MONEY: a bug here does not throw, it drops
// an asset off the list or sums two unrelated tokens into one confident
// wrong total. Both look fine on screen.
//
// Run: node scripts/verify-asset-aggregation.mjs

import { buildAggregatedRows } from "../src/wallet/assetAggregation.js";

let passed = 0;
const failures = [];
const check = (name, fn) => { try { fn(); passed++; } catch (e) { failures.push(`${name}: ${e.message}`); } };
const assert = (c, m) => { if (!c) throw new Error(m ?? "assertion failed"); };

const NATIVE = { ethereum: "ETH", base: "ETH", arbitrum: "ETH", bnb: "BNB", avalanche: "AVAX" };
const nativeSymbolFor = (k) => NATIVE[k];
const usdc = (address) => ({ symbol: "USDC", address, decimals: 6, isCustom: false });

check("same-symbol natives across chains collapse into ONE row", () => {
  const rows = buildAggregatedRows(["ethereum", "base", "arbitrum"], { nativeSymbolFor, tokensFor: () => [] });
  assert(rows.length === 1, `expected 1 row, got ${rows.length}`);
  assert(rows[0].kind === "aggregate" && rows[0].symbol === "ETH", JSON.stringify(rows[0]));
  assert(rows[0].sources.length === 3, `expected 3 sources, got ${rows[0].sources.length}`);
});

check("a native on ONE chain stays its original row, not an aggregate of one", () => {
  const rows = buildAggregatedRows(["bnb"], { nativeSymbolFor, tokensFor: () => [] });
  assert(rows.length === 1 && rows[0].kind === "evm-native", JSON.stringify(rows[0]));
  assert(rows[0].chainKey === "bnb");
});

check("different native symbols do NOT get merged", () => {
  const rows = buildAggregatedRows(["ethereum", "bnb", "avalanche"], { nativeSymbolFor, tokensFor: () => [] });
  assert(rows.length === 3, `expected 3 rows, got ${rows.length}`);
  assert(rows.every((r) => r.kind === "evm-native"), JSON.stringify(rows.map((r) => r.kind)));
});

check("a verified token on several chains collapses too", () => {
  const rows = buildAggregatedRows(["ethereum", "base"], {
    nativeSymbolFor,
    tokensFor: (k) => [usdc(`0x${k}`)],
  });
  const agg = rows.filter((r) => r.kind === "aggregate");
  assert(agg.length === 2, `expected ETH + USDC aggregates, got ${agg.map((a) => a.symbol)}`);
  const usdcRow = agg.find((a) => a.symbol === "USDC");
  assert(usdcRow.sources.length === 2 && usdcRow.sources.every((s) => s.kind === "evm-token"));
});

check("CUSTOM tokens are never grouped, even when the symbols match", () => {
  // The whole point: two tokens a user added themselves that happen to
  // share a symbol are not confirmed to be the same asset, and summing
  // them would present a wrong number as a confident one.
  const rows = buildAggregatedRows(["ethereum", "base"], {
    nativeSymbolFor,
    tokensFor: (k) => [{ symbol: "MOON", address: `0x${k}moon`, decimals: 18, isCustom: true }],
  });
  const moons = rows.filter((r) => r.kind === "evm-token" && r.token.symbol === "MOON");
  assert(moons.length === 2, `custom tokens were merged: ${JSON.stringify(rows.filter((r) => r.kind === "aggregate"))}`);
  assert(!rows.some((r) => r.kind === "aggregate" && r.symbol === "MOON"));
});

check("Solana is never folded into an EVM group", () => {
  const rows = buildAggregatedRows(["ethereum", "solana"], {
    nativeSymbolFor,
    tokensFor: (k) => (k === "solana" ? [{ symbol: "USDC", mint: "Es9v", decimals: 6, isCustom: false }] : []),
  });
  assert(rows.some((r) => r.kind === "solana-native"), "solana native row missing");
  assert(rows.some((r) => r.kind === "spl-token"), "spl token row missing");
  assert(!rows.some((r) => r.kind === "aggregate" && r.sources?.some((s) => s.chainKey === "solana")), "solana got folded in");
});

check("NOTHING is dropped: every input asset appears exactly once in the output", () => {
  const chains = ["ethereum", "base", "arbitrum", "bnb", "avalanche", "solana"];
  const tokensFor = (k) => (k === "solana"
    ? [{ symbol: "USDC", mint: "Es9v", decimals: 6, isCustom: false }]
    : [usdc(`0x${k}`), { symbol: "MOON", address: `0x${k}m`, decimals: 18, isCustom: true }]);
  const rows = buildAggregatedRows(chains, { nativeSymbolFor, tokensFor });

  let count = 0;
  for (const r of rows) count += r.kind === "aggregate" ? r.sources.length : 1;
  // 5 EVM natives + 5 verified USDC + 5 custom MOON + 1 SOL native + 1 SPL
  assert(count === 17, `expected 17 underlying assets, counted ${count}`);
});

check("an empty chain list produces an empty list, not a crash", () => {
  assert(buildAggregatedRows([], { nativeSymbolFor, tokensFor: () => [] }).length === 0);
});

check("a chain with no known native symbol is skipped rather than grouped under undefined", () => {
  const rows = buildAggregatedRows(["ethereum", "mystery"], {
    nativeSymbolFor: (k) => NATIVE[k],
    tokensFor: () => [],
  });
  assert(!rows.some((r) => r.symbol === undefined), JSON.stringify(rows));
});

console.log(`${passed}/${passed + failures.length} checks passed`);
for (const f of failures) console.error(`  FAIL ${f}`);
if (failures.length > 0) process.exit(1);
