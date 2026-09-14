// scripts/verify-fallback-fee-sweep.mjs
//
// Regression tests for a real, confirmed gap: fallbackDex.js's four
// no-key DEX providers (uniswap-v4/uniswap-v3/sushiswap-v2/
// pancakeswap-v3) call their router directly with no fee mechanism of
// any kind, so feeCollectedInline is always false there — Mango
// collected nothing on those routes. sweepFallbackFeeFromNativeBalance
// closes that by skimming the fee from the wallet's spare native
// balance in a second transaction, ported from mango-pro's own
// already-shipped fix for the identical gap.
//
// This only tests computeFallbackFeeNativeAmount, the pure sizing math
// — see fallbackFeeSweep.js's own header for why that lives in its own
// module rather than fallbackDex.js itself (which cannot be imported
// under plain Node at all: it transitively pulls in wagmi.js, which
// reads a Vite-only global at load time). The live network calls
// (price feed, balance read, the transfer itself) are exercised by
// hand against testnet/mainnet, same as every other execution path in
// this repo that needs a real wallet and RPC.
//
// Run: node scripts/verify-fallback-fee-sweep.mjs

import { computeFallbackFeeNativeAmount, MIN_FALLBACK_FEE_USD, NATIVE_RESERVE_USD } from "../src/fallbackFeeSweep.js";
import { DEV_FEE_PCT, DEV_FEE_MAX_USD } from "../src/devFeeWallets.js";

let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message ?? "assertion failed");
}

// A real, unremarkable trade: $200 at $3,000/ETH, plenty of ETH sitting
// in the wallet already.
check("a normal trade sizes the fee at DEV_FEE_PCT of the trade, converted to native units", () => {
  const feeUsd = 200 * DEV_FEE_PCT;
  const expectedNative = feeUsd / 3000;
  const got = computeFallbackFeeNativeAmount({ originAmountUsd: 200, nativePriceUsd: 3000, freshBalanceNative: 1 });
  assert(Math.abs(got - expectedNative) < 1e-12, `expected ~${expectedNative}, got ${got}`);
});

check("a large trade caps the fee at DEV_FEE_MAX_USD, not a bigger bps cut", () => {
  const got = computeFallbackFeeNativeAmount({ originAmountUsd: 1_000_000, nativePriceUsd: 3000, freshBalanceNative: 100 });
  const expectedNative = DEV_FEE_MAX_USD / 3000;
  assert(Math.abs(got - expectedNative) < 1e-12, `expected the $${DEV_FEE_MAX_USD} cap (~${expectedNative}), got ${got}`);
});

check("a fee below MIN_FALLBACK_FEE_USD is skipped entirely, not sent as dust", () => {
  // $1 trade at 0.5% is $0.005 — well under the nickel floor.
  const got = computeFallbackFeeNativeAmount({ originAmountUsd: 1, nativePriceUsd: 3000, freshBalanceNative: 100 });
  assert(got === 0, `expected 0 for a sub-floor fee, got ${got}`);
});

check("the dust floor itself is a real, sane constant", () => {
  assert(MIN_FALLBACK_FEE_USD > 0 && MIN_FALLBACK_FEE_USD < 1, `implausible floor ${MIN_FALLBACK_FEE_USD}`);
});

check("insufficient spare balance skips the sweep rather than draining the gas reserve", () => {
  // Fee would want ~0.033 ETH ($100 capped fee / $3000), but the
  // wallet barely has more than the doubled reserve set aside.
  const reserveNative = (NATIVE_RESERVE_USD * 2) / 3000;
  const got = computeFallbackFeeNativeAmount({ originAmountUsd: 1_000_000, nativePriceUsd: 3000, freshBalanceNative: reserveNative + 0.0001 });
  assert(got > 0 && got <= 0.0001 + 1e-12, `expected a tiny clamped amount, got ${got}`);
});

check("a balance that doesn't even cover the reserve sends nothing, never a negative amount", () => {
  const got = computeFallbackFeeNativeAmount({ originAmountUsd: 200, nativePriceUsd: 3000, freshBalanceNative: 0 });
  assert(got === 0, `expected 0, got ${got}`);
});

check("zero balance is a real, known number — not treated the same as an unknown one", () => {
  // Both should safely return 0, but for different reasons: a real
  // zero balance genuinely has nothing spare; an unknown balance
  // (below) is refused because there's nothing real to compare
  // against. Neither should throw or fabricate a value.
  const zero = computeFallbackFeeNativeAmount({ originAmountUsd: 200, nativePriceUsd: 3000, freshBalanceNative: 0 });
  assert(zero === 0);
});

// ---- "unknown" inputs never fabricate a number, per this file's own
// DEV_FEE_MAX_USD-style rule elsewhere in the codebase -----------------
check("no originAmountUsd (nothing to size the fee against) sends nothing", () => {
  for (const bad of [null, undefined, 0, -5, NaN]) {
    const got = computeFallbackFeeNativeAmount({ originAmountUsd: bad, nativePriceUsd: 3000, freshBalanceNative: 100 });
    assert(got === 0, `originAmountUsd=${bad} produced ${got}`);
  }
});

check("no live native price sends nothing rather than guessing one", () => {
  for (const bad of [null, undefined, 0, -1, NaN]) {
    const got = computeFallbackFeeNativeAmount({ originAmountUsd: 200, nativePriceUsd: bad, freshBalanceNative: 100 });
    assert(got === 0, `nativePriceUsd=${bad} produced ${got}`);
  }
});

check("no fresh balance reading sends nothing rather than assuming the wallet has spare funds", () => {
  for (const bad of [null, undefined, NaN, "1", {}]) {
    const got = computeFallbackFeeNativeAmount({ originAmountUsd: 200, nativePriceUsd: 3000, freshBalanceNative: bad });
    assert(got === 0, `freshBalanceNative=${JSON.stringify(bad)} produced ${got}`);
  }
});

check("the result never exceeds what the trade itself would owe at the flat rate", () => {
  // Across a spread of trade sizes and prices, the fee-only portion
  // (before the reserve/balance clamp) never implies a rate above
  // DEV_FEE_PCT — sanity check that the math isn't overcharging.
  for (const [usd, price] of [[50, 1], [500, 100], [5000, 4000], [50000, 2500]]) {
    const got = computeFallbackFeeNativeAmount({ originAmountUsd: usd, nativePriceUsd: price, freshBalanceNative: 1_000_000 });
    const impliedUsd = got * price;
    assert(impliedUsd <= usd * DEV_FEE_PCT + 1e-9, `usd=${usd} price=${price} implied ${impliedUsd} > flat rate`);
  }
});

console.log(`${passed}/${passed + failures.length} checks passed`);
for (const failure of failures) console.error(`  FAIL ${failure}`);
if (failures.length > 0) process.exit(1);
