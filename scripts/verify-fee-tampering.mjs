// scripts/verify-fee-tampering.mjs
//
// Regression tests for the server-side fee controls, written because a
// security audit asked for them by name: "add regression tests proving
// attacker-supplied feeWallet/feeBps cannot redirect or inflate Mango
// fees."
//
// Both quote proxies are public URLs with wildcard CORS, callable
// directly with curl or by a cloned frontend pointed at this same real
// backend. Neither may trust the fee fields in the request body. These
// two properties are what that means concretely:
//
//   1. The fee recipient is ALWAYS the real DEV_FEE_WALLET, whatever
//      the caller sent.
//   2. The fee rate is ALWAYS between 0 and MAX_FEE_BPS, whatever the
//      caller sent — including through the odd inputs a hand-written
//      request can carry that a real client never would.
//
// Run: node scripts/verify-fee-tampering.mjs

import { sanitizeAppFees } from "../api/v1/bridge/relay-quote.js";
import { sanitizeFeeParams } from "../api/v1/bridge/fallback-quote.js";
import { DEV_FEE_WALLET, DEV_FEE_PCT } from "../src/devFeeWallets.js";

const MAX_FEE_BPS = Math.round(DEV_FEE_PCT * 10000);
const ATTACKER = "0xBAdBaDbAdBADbadbADbadBADbadbadBadbAdbAD0";

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

// ---- Relay proxy: appFees ------------------------------------------
check("a redirected recipient is overwritten with the real fee wallet", () => {
  const out = sanitizeAppFees([{ recipient: ATTACKER, fee: "50" }]);
  assert(out[0].recipient === DEV_FEE_WALLET, `recipient survived as ${out[0].recipient}`);
});
check("an inflated fee is clamped to the maximum", () => {
  const out = sanitizeAppFees([{ recipient: ATTACKER, fee: "9999" }]);
  assert(out[0].fee === String(MAX_FEE_BPS), `fee survived as ${out[0].fee}`);
});
check("a negative fee is floored at zero", () => {
  assert(sanitizeAppFees([{ fee: "-500" }])[0].fee === "0");
});
check("a non-numeric fee becomes zero rather than passing through", () => {
  for (const bad of ["abc", "", null, undefined, {}, [], NaN]) {
    assert(sanitizeAppFees([{ fee: bad }])[0].fee === "0", `"${String(bad)}" produced ${sanitizeAppFees([{ fee: bad }])[0].fee}`);
  }
});
check("Infinity is clamped, not forwarded", () => {
  assert(sanitizeAppFees([{ fee: Infinity }])[0].fee === String(MAX_FEE_BPS));
  assert(sanitizeAppFees([{ fee: "1e400" }])[0].fee === String(MAX_FEE_BPS));
});
check("a fractional fee is rounded to whole basis points", () => {
  assert(sanitizeAppFees([{ fee: "12.7" }])[0].fee === "13", sanitizeAppFees([{ fee: "12.7" }])[0].fee);
});
check("a legitimate in-range fee is preserved exactly", () => {
  const legit = String(Math.max(0, MAX_FEE_BPS - 1));
  assert(sanitizeAppFees([{ fee: legit }])[0].fee === legit);
});
check("extra attacker-supplied keys are dropped, not forwarded to Relay", () => {
  const out = sanitizeAppFees([{ recipient: ATTACKER, fee: "10", chainId: 1, onBehalfOf: ATTACKER, evil: true }]);
  assert(Object.keys(out[0]).sort().join(",") === "fee,recipient", `leaked keys: ${Object.keys(out[0])}`);
});
check("every entry is sanitized, not just the first", () => {
  const out = sanitizeAppFees([{ recipient: ATTACKER, fee: "9999" }, { recipient: ATTACKER, fee: "8888" }]);
  for (const entry of out) {
    assert(entry.recipient === DEV_FEE_WALLET && entry.fee === String(MAX_FEE_BPS), JSON.stringify(entry));
  }
});
check("a non-array appFees is dropped rather than passed through unvalidated", () => {
  for (const bad of [{ recipient: ATTACKER, fee: "9999" }, "9999", 5, true]) {
    assert(sanitizeAppFees(bad) === undefined, `${JSON.stringify(bad)} survived as ${JSON.stringify(sanitizeAppFees(bad))}`);
  }
});

// ---- Fallback proxy: feeBps / feeWallet -----------------------------
check("a redirected fallback feeWallet is overwritten", () => {
  assert(sanitizeFeeParams({ feeBps: "50", feeWallet: ATTACKER }).feeWallet === DEV_FEE_WALLET);
});
check("an inflated fallback feeBps is clamped", () => {
  assert(sanitizeFeeParams({ feeBps: "9999", feeWallet: ATTACKER }).feeBps === String(MAX_FEE_BPS));
});
check("a negative fallback feeBps is floored at zero", () => {
  assert(sanitizeFeeParams({ feeBps: "-1", feeWallet: ATTACKER }).feeBps === "0");
});
check("a fractional fallback feeBps is rounded", () => {
  assert(sanitizeFeeParams({ feeBps: "7.4", feeWallet: ATTACKER }).feeBps === "7");
});
check("omitting the fee fields stays omitted (no fee is charged, nothing is invented)", () => {
  const out = sanitizeFeeParams({});
  assert(out.feeBps === undefined && out.feeWallet === undefined, JSON.stringify(out));
});
check("the clamp ceiling is the real configured rate, not a hardcoded guess", () => {
  assert(MAX_FEE_BPS === Math.round(DEV_FEE_PCT * 10000));
  assert(MAX_FEE_BPS > 0 && MAX_FEE_BPS <= 10000, `implausible ceiling ${MAX_FEE_BPS}`);
});

console.log(`${passed}/${passed + failures.length} checks passed`);
for (const failure of failures) console.error(`  FAIL ${failure}`);
if (failures.length > 0) process.exit(1);
