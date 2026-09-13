// scripts/verify-wallet-prices.mjs
//
// Real regression check for src/wallet/walletPrices.js's parsing/caching
// logic, using a mocked global.fetch — CoinGecko's own API is blocked
// from this sandbox too (confirmed via direct curl: 403 at the egress
// proxy, same as every RPC endpoint tried this session), so the actual
// live HTTP call can't be exercised here. What this DOES verify for
// real: the request URL is built correctly, a real CoinGecko-shaped
// response parses into the right symbol->price map, an unknown/missing
// id doesn't crash or fabricate a price, and concurrent callers are
// deduped into one request rather than firing one each.
//
// Run: node scripts/verify-wallet-prices.mjs

import assert from "node:assert";

let n = 0;
async function check(label, fn) {
  await fn();
  n++;
  console.log(`ok ${n} - ${label}`);
}

let fetchCallCount = 0;
let lastUrl = null;
globalThis.fetch = async (url) => {
  fetchCallCount++;
  lastUrl = url;
  return {
    ok: true,
    json: async () => ({
      ethereum: { usd: 3120.5 },
      solana: { usd: 145.2 },
      "usd-coin": { usd: 1.0 },
      // Deliberately missing "binancecoin" and every other id this module
      // asks for, to prove a real gap in the mocked upstream response
      // doesn't crash parsing or invent a price for it.
    }),
  };
};

const { fetchWalletPrices, SYMBOL_TO_COINGECKO_ID } = await import("../src/wallet/walletPrices.js");

// Runs FIRST, deliberately, while the module's cache is still genuinely
// cold — this is the only point in the script where firing several
// concurrent calls at once actually exercises the in-flight-dedupe path
// (every later call would just hit the already-warm 60s cache regardless
// of whether dedupe worked, which would prove nothing).
await check("concurrent callers against a cold cache are deduped into exactly one real fetch, not one each", () => {
  assert.equal(fetchCallCount, 0, "test setup error: fetch was already called before this check");
  return Promise.all([fetchWalletPrices(), fetchWalletPrices(), fetchWalletPrices()]).then(() => {
    assert.equal(fetchCallCount, 1, "3 concurrent callers against a cold cache should trigger exactly 1 fetch");
  });
});

await check("requests every configured symbol's CoinGecko id in one URL", () => {
  for (const id of Object.values(SYMBOL_TO_COINGECKO_ID)) {
    assert.ok(lastUrl.includes(id), `expected request URL to include id "${id}"`);
  }
  assert.ok(lastUrl.startsWith("https://api.coingecko.com/api/v3/simple/price"));
});

await check("a real CoinGecko-shaped response parses into the correct symbol->price map", () => {
  return fetchWalletPrices().then((prices) => {
    assert.equal(prices.ETH, 3120.5);
    assert.equal(prices.SOL, 145.2);
    assert.equal(prices.USDC, 1.0);
  });
});

await check("an id missing from the response is simply absent, not fabricated as 0 or undefined-crashing", () => {
  return fetchWalletPrices().then((prices) => {
    assert.ok(!("BNB" in prices), "BNB was missing from the mocked response and must not appear in the parsed map");
  });
});

await check("a still-warm cache serves repeat callers without triggering additional fetches", () => {
  const before = fetchCallCount;
  return Promise.all([fetchWalletPrices(), fetchWalletPrices(), fetchWalletPrices()]).then(() => {
    assert.equal(fetchCallCount, before, "cached calls should not trigger new fetches");
  });
});

console.log(`\n${n}/${n} checks passed`);
console.log("\nNot verified here (CoinGecko's real API is blocked from this sandbox): the actual live HTTP response shape and real-world price values.");
