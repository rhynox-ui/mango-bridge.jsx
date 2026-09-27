// scripts/verify-near-outcome.mjs
//
// Tests for src/nearOutcome.js — telling a completed NEAR swap from one
// the exchange cancelled and refunded (which NEAR reports as a
// successful transaction whose ft_transfer_call returned "0").
//
// Run: node scripts/verify-near-outcome.mjs

import { classifySwapOutcomes } from "../src/nearOutcome.js";

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
function assert(c, m) {
  if (!c) throw new Error(m ?? "assertion failed");
}

const b64 = (v) => Buffer.from(JSON.stringify(v)).toString("base64");
const ok = (hash, value) => ({ status: { SuccessValue: value === undefined ? "" : b64(value) }, transaction: { hash } });
const fc = (methodName, args = {}) => ({ type: "FunctionCall", params: { methodName, args, gas: "1", deposit: "1" } });
const register = { receiverId: "meme.near", actions: [fc("storage_deposit", { account_id: "alice.near" })] };
const swap = { receiverId: "wrap.near", actions: [fc("near_deposit"), fc("ft_transfer_call", { receiver_id: "v2.ref-finance.near", amount: "1000", msg: "{}" })] };
const fee = { receiverId: "widekingdom6862.near", actions: [{ type: "Transfer", params: { deposit: "5" } }] };

check("the exchange kept everything → ok, with every hash", () => {
  const r = classifySwapOutcomes([register, swap, fee], [ok("a", null), ok("b", "1000"), ok("c")], { skip: [2] });
  assert(r.status === "ok" && r.hashes.join() === "a,b,c", JSON.stringify(r));
});
check('ft_transfer_call returned "0" → refunded, even though the transaction succeeded', () => {
  assert(classifySwapOutcomes([swap], [ok("b", "0")]).status === "refunded");
});
check("kept part of it → partial", () => {
  assert(classifySwapOutcomes([swap], [ok("b", "400")]).status === "partial");
});
check("a failed swap transaction → failed", () => {
  assert(classifySwapOutcomes([register, swap], [ok("a", null), { status: { Failure: {} }, transaction: { hash: "b" } }]).status === "failed");
});
check("a failed fee transaction doesn't mislabel a completed swap", () => {
  assert(classifySwapOutcomes([swap, fee], [ok("b", "1000"), { status: { Failure: {} } }], { skip: [1] }).status === "ok");
});
check("missing or unreadable outcomes → unknown, never a false 'Swapped'", () => {
  assert(classifySwapOutcomes([register, swap], [ok("a", null)]).status === "unknown");
  assert(classifySwapOutcomes([swap], undefined).status === "unknown");
  assert(classifySwapOutcomes([swap], [{ status: { SuccessValue: "!!" } }]).status === "unknown");
  assert(classifySwapOutcomes([swap], [{ transaction: { hash: "b" } }]).status === "unknown");
});

console.log(`${passed}/${passed + failures.length} checks passed`);
for (const f of failures) console.error(`  FAIL ${f}`);
if (failures.length > 0) process.exit(1);
