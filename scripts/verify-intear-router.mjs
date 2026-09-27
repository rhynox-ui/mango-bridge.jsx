// scripts/verify-intear-router.mjs
//
// Tests for src/intearRouter.js — routing NEAR swaps across every NEAR
// DEX through Intear's aggregator. The route fixtures mirror the
// aggregator's own serde shapes (src/types.rs: externally tagged
// Amount, NearTransaction instructions, FunctionCall with base64 args).
// The point is the gatekeeping: a tampered or unexpected route must
// never reach the user's wallet.
//
// Run: node scripts/verify-intear-router.mjs

import {
  IntearRouteError,
  assertIntearRouteSafe,
  feeTransaction,
  fetchIntearRoutes,
  pickSafeRoute,
  toWalletTransactions,
} from "../src/intearRouter.js";
import { NATIVE_NEAR, WRAP_NEAR } from "../src/rheaSwap.js";

let passed = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    passed++;
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
  }
}
function assert(c, m) {
  if (!c) throw new Error(m ?? "assertion failed");
}
function rejects(fn, m) {
  try {
    fn();
  } catch (e) {
    if (e instanceof IntearRouteError) return;
    throw e;
  }
  throw new Error(m ?? "expected IntearRouteError");
}

const USER = "alice.near";
const MEME = "rust-334.meme-cooking.near";
const E24 = 10n ** 24n;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const fc = (method_name, args, deposit = "0", gas = 30_000_000_000_000) => ({ FunctionCall: { method_name, args: b64(args), gas, deposit } });
const tx = (receiver_id, ...actions) => ({ NearTransaction: { receiver_id, actions } });

// Rhea's swap message exactly as src/providers/rhea.rs builds it.
const rheaMsg = (amountIn, min = "4950000", extra = {}) =>
  JSON.stringify({
    force: 0,
    actions: [{ pool_id: 1234, token_in: WRAP_NEAR, token_out: MEME, amount_in: amountIn.toString(), min_amount_out: min }],
    skip_degen_price_sync: true,
    skip_unwrap_near: true,
    referral_id: "dex-aggregator.intear.near",
    ...extra,
  });

// NEAR → MEME on Rhea: register MEME for the user, wrap + ft_transfer_call.
function rheaRoute(amountIn = 10n * E24, overrides = {}) {
  return {
    deadline: null,
    has_slippage: true,
    estimated_amount: { amount_out: "5000000" },
    worst_case_amount: { amount_out: "4950000" },
    dex_id: "Rhea",
    execution_instructions: [
      tx(MEME, fc("storage_deposit", { account_id: USER, registration_only: true }, "1250000000000000000000")),
      tx(
        WRAP_NEAR,
        fc("near_deposit", {}, amountIn.toString()),
        fc("ft_transfer_call", { receiver_id: "v2.ref-finance.near", amount: amountIn.toString(), msg: rheaMsg(amountIn) }, "1"),
      ),
    ],
    needs_unwrap: false,
    token_output: `nep141:${MEME}`,
    ...overrides,
  };
}

const ctx = { accountId: USER, tokenIn: NATIVE_NEAR, tokenOut: MEME, amountIn: 10n * E24 };

await check("converts Intear's NearTransaction/FunctionCall (base64 args) into wallet transactions", () => {
  const txs = toWalletTransactions(rheaRoute());
  assert(txs.length === 2 && txs[1].receiverId === WRAP_NEAR);
  const p = txs[1].actions[1].params;
  assert(p.methodName === "ft_transfer_call" && p.args.receiver_id === "v2.ref-finance.near" && p.gas === "30000000000000" && p.deposit === "1", JSON.stringify(p));
});

await check("a genuine route passes and is picked", () => {
  const picked = pickSafeRoute([rheaRoute()], ctx);
  assert(picked && picked.dexId === "Rhea" && picked.label === "Rhea" && picked.minOut === 4950000n && picked.amountOut === 5000000n);
});

await check("the best SAFE route wins: a tampered first route is skipped for the next venue", () => {
  const evil = rheaRoute(10n * E24, { dex_id: "Plach", estimated_amount: { amount_out: "9000000" }, worst_case_amount: { amount_out: "8900000" } });
  evil.execution_instructions[1].NearTransaction.actions[1] = fc("ft_transfer_call", { receiver_id: "attacker.near", amount: (10n * E24).toString(), msg: "" }, "1");
  const picked = pickSafeRoute([evil, rheaRoute()], ctx);
  assert(picked?.dexId === "Rhea", `picked ${picked?.dexId}`);
});

const cases = {
  "unknown receiver contract": (r) => (r.execution_instructions[0].NearTransaction.receiver_id = "evil.near"),
  "tokens sent to a stranger": (r) => (r.execution_instructions[1].NearTransaction.actions[1] = fc("ft_transfer_call", { receiver_id: "attacker.near", amount: "1", msg: "" }, "1")),
  "plain ft_transfer": (r) => r.execution_instructions[1].NearTransaction.actions.push(fc("ft_transfer", { receiver_id: "attacker.near", amount: "1" }, "1")),
  "native Transfer action": (r) => r.execution_instructions[1].NearTransaction.actions.push({ Transfer: { deposit: "1" } }),
  "AddKey action": (r) => r.execution_instructions[1].NearTransaction.actions.push({ AddKey: { public_key: "ed25519:x", access_key: {} } }),
  "spends more than entered": (r) => (r.execution_instructions[1].NearTransaction.actions[1] = fc("ft_transfer_call", { receiver_id: "v2.ref-finance.near", amount: (11n * E24).toString(), msg: "" }, "1")),
  "attaches too much NEAR": (r) => (r.execution_instructions[1].NearTransaction.actions[0] = fc("near_deposit", {}, (12n * E24).toString())),
  "registers storage for someone else": (r) => (r.execution_instructions[0].NearTransaction.actions[0] = fc("storage_deposit", { account_id: "attacker.near" }, "1")),
  "unwraps NEAR on a swap that doesn't end in NEAR": (r) => r.execution_instructions.push(tx(WRAP_NEAR, fc("near_withdraw", { amount: "1" }, "1"))),
  "non-JSON args": (r) => (r.execution_instructions[1].NearTransaction.actions[1] = { FunctionCall: { method_name: "ft_transfer_call", args: Buffer.from([0xff, 0x00]).toString("base64"), gas: 1, deposit: "1" } }),
  "Rhea output redirected (swap_out_recipient)": (r) => (r.execution_instructions[1].NearTransaction.actions[1] = fc("ft_transfer_call", { receiver_id: "v2.ref-finance.near", amount: (10n * E24).toString(), msg: rheaMsg(10n * E24, "4950000", { swap_out_recipient: "attacker.near" }) }, "1")),
  "Rhea client_echo": (r) => (r.execution_instructions[1].NearTransaction.actions[1] = fc("ft_transfer_call", { receiver_id: "v2.ref-finance.near", amount: (10n * E24).toString(), msg: rheaMsg(10n * E24, "4950000", { client_echo: "x" }) }, "1")),
  "on-chain minimum zeroed (sandwichable)": (r) => (r.execution_instructions[1].NearTransaction.actions[1] = fc("ft_transfer_call", { receiver_id: "v2.ref-finance.near", amount: (10n * E24).toString(), msg: rheaMsg(10n * E24, "0") }, "1")),
  "unwraps output when MEME was asked for": (r) => (r.execution_instructions[1].NearTransaction.actions[1] = fc("ft_transfer_call", { receiver_id: "v2.ref-finance.near", amount: (10n * E24).toString(), msg: rheaMsg(10n * E24, "4950000", { skip_unwrap_near: false }) }, "1")),
  "empty msg (deposit into a DEX, no swap)": (r) => (r.execution_instructions[1].NearTransaction.actions[1] = fc("ft_transfer_call", { receiver_id: "v2.ref-finance.near", amount: (10n * E24).toString(), msg: "" }, "1")),
  "moves the user's existing output tokens": (r) => r.execution_instructions.push(tx(MEME, fc("ft_transfer_call", { receiver_id: "v2.ref-finance.near", amount: "1", msg: rheaMsg(1n) }, "1"))),
  "Rhea internal-balance swap": (r) => r.execution_instructions.push(tx("v2.ref-finance.near", fc("swap", { actions: [] }, "1"))),
  "Rhea internal-balance withdraw": (r) => r.execution_instructions.push(tx("v2.ref-finance.near", fc("withdraw", { token_id: MEME, amount: "1" }, "1"))),
  "Intear DEX execute_operations": (r) => r.execution_instructions.push(tx("dex.intear.near", fc("execute_operations", { operations: [], referrer: "x" }, "1"))),
  "method on the wrong contract (near_deposit on a DEX)": (r) => (r.execution_instructions[1].NearTransaction.receiver_id = "v2.ref-finance.near"),
  "liquid_unstake of a token not being paid": (r) => r.execution_instructions.push(tx("meta-pool.near", fc("liquid_unstake", { st_near_to_burn: "1", min_expected_near: "0" }))),
};
await check(`every tampering is refused (${Object.keys(cases).length} cases)`, () => {
  for (const [name, mutate] of Object.entries(cases)) {
    const r = rheaRoute();
    mutate(r);
    assert(pickSafeRoute([r], ctx) === null, `accepted: ${name}`);
  }
});

await check("worst case above estimate, zero, or wrong output token → skipped", () => {
  assert(pickSafeRoute([rheaRoute(10n * E24, { worst_case_amount: { amount_out: "6000000" } })], ctx) === null);
  assert(pickSafeRoute([rheaRoute(10n * E24, { worst_case_amount: { amount_out: "0" } })], ctx) === null);
  assert(pickSafeRoute([rheaRoute(10n * E24, { token_output: "rhea-nep141:" + MEME })], ctx) === null);
});

await check("MEME → NEAR ending in wNEAR: the guaranteed minimum is unwrapped afterwards", () => {
  const route = {
    estimated_amount: { amount_out: "2000000000000000000000000" },
    worst_case_amount: { amount_out: "1980000000000000000000000" },
    dex_id: "RheaDcl",
    execution_instructions: [tx(MEME, fc("ft_transfer_call", { receiver_id: "dclv2.ref-labs.near", amount: "1000", msg: JSON.stringify({ Swap: { pool_ids: [`${MEME}|${WRAP_NEAR}|2000`], output_token: WRAP_NEAR, min_output_amount: "1980000000000000000000000", skip_unwrap_near: true } }) }, "1"))],
    token_output: `nep141:${WRAP_NEAR}`,
  };
  const picked = pickSafeRoute([route], { accountId: USER, tokenIn: MEME, tokenOut: NATIVE_NEAR, amountIn: 1000n });
  const last = picked.txs[picked.txs.length - 1];
  assert(picked.label === "Rhea DCL" && last.receiverId === WRAP_NEAR && last.actions[0].params.methodName === "near_withdraw" && last.actions[0].params.args.amount === "1980000000000000000000000");
});

await check("staking venues pass: NEAR → stNEAR via Meta Pool deposit_and_stake", () => {
  const route = {
    estimated_amount: { amount_out: "900" },
    worst_case_amount: { amount_out: "900" },
    dex_id: "MetaPool",
    execution_instructions: [tx("meta-pool.near", fc("deposit_and_stake", {}, (10n * E24).toString()))],
    token_output: "nep141:meta-pool.near",
  };
  assert(pickSafeRoute([route], { accountId: USER, tokenIn: NATIVE_NEAR, tokenOut: "meta-pool.near", amountIn: 10n * E24 })?.label === "Meta Pool");
});

// Intear DEX (Plach) NEAR → MEME, as src/providers/intear_plach.rs builds it.
function plachRoute(ops) {
  return {
    estimated_amount: { amount_out: "5000000" },
    worst_case_amount: { amount_out: "4950000" },
    dex_id: "Plach",
    execution_instructions: [
      tx("dex.intear.near", fc("storage_deposit", {}, "5000000000000000000000"), fc("register_assets", { asset_ids: ["near", `nep141:${MEME}`] }, "1")),
      tx("dex.intear.near", fc("deposit_near", { operations: { operations: ops, referrer: "dex-aggregator.intear.near" } }, (10n * E24).toString())),
    ],
    token_output: `nep141:${MEME}`,
  };
}
const plachSwap = { SwapSimple: { dex_id: "slimedragon.near/xyk", message: "AQAAAAAAAAA=", asset_in: "near", asset_out: `nep141:${MEME}`, amount: { Amount: { ExactIn: (10n * E24).toString() } }, constraint: "4950000" } };
const plachWithdraw = (extra = {}) => ({ Withdraw: { asset_id: `nep141:${MEME}`, amount: { Full: { at_least: "4950000" } }, to: null, rescue_address: null, ...extra } });

await check("Intear DEX: a genuine route passes; withdrawing to someone else or transferring out is refused", () => {
  assert(pickSafeRoute([plachRoute([plachSwap, plachWithdraw()])], ctx)?.label === "Intear DEX", "genuine rejected");
  assert(pickSafeRoute([plachRoute([plachSwap, plachWithdraw({ to: "attacker.near" })])], ctx) === null, "withdraw to attacker accepted");
  assert(pickSafeRoute([plachRoute([plachSwap, plachWithdraw({ rescue_address: "attacker.near" })])], ctx) === null, "rescue to attacker accepted");
  assert(pickSafeRoute([plachRoute([plachSwap, { TransferAsset: { to: "account:attacker.near", asset_id: `nep141:${MEME}`, amount: "1" } }])], ctx) === null, "TransferAsset accepted");
  assert(pickSafeRoute([plachRoute([plachSwap, plachWithdraw({ amount: { Full: { at_least: "1" } } })])], ctx) === null, "low on-chain minimum accepted");
  assert(pickSafeRoute([plachRoute([{ SwapSimple: { ...plachSwap.SwapSimple, amount: "EntireBalanceIn" } }, plachWithdraw()])], ctx) === null, "EntireBalanceIn accepted");
});

await check("Aidols and Meta Pool: genuine routes pass, a lowered minimum doesn't", () => {
  const AID = "cat.aidols.near";
  const aidols = (min) => ({
    estimated_amount: { amount_out: "1000" },
    worst_case_amount: { amount_out: "990" },
    dex_id: "Aidols",
    execution_instructions: [tx(WRAP_NEAR, fc("near_deposit", {}, (10n * E24).toString()), fc("ft_transfer_call", { receiver_id: "aidols.near", amount: (10n * E24).toString(), msg: JSON.stringify({ token: AID, min_swap_amount: min, referral: "dex-aggregator.intear.near" }) }, "1"))],
    token_output: `nep141:${AID}`,
  });
  const actx = { accountId: USER, tokenIn: NATIVE_NEAR, tokenOut: AID, amountIn: 10n * E24 };
  assert(pickSafeRoute([aidols("990")], actx)?.label === "Aidols", "genuine Aidols rejected");
  assert(pickSafeRoute([aidols("1")], actx) === null, "low Aidols minimum accepted");
  const unstake = (burn, min) => ({
    estimated_amount: { amount_out: "2000" },
    worst_case_amount: { amount_out: "1980" },
    dex_id: "MetaPool",
    execution_instructions: [tx("meta-pool.near", fc("liquid_unstake", { st_near_to_burn: burn, min_expected_near: min }, "0"))],
    token_output: "near",
  });
  const mctx = { accountId: USER, tokenIn: "meta-pool.near", tokenOut: NATIVE_NEAR, amountIn: 1000n };
  assert(pickSafeRoute([unstake("1000", "1980")], mctx)?.label === "Meta Pool", "genuine unstake rejected");
  assert(pickSafeRoute([unstake("5000", "1980")], mctx) === null, "unstaking more than entered accepted");
  assert(pickSafeRoute([unstake("1000", "0")], mctx) === null, "zero unstake minimum accepted");
});

await check("Mango's fee is a separate final transaction in the input token", () => {
  const near = feeTransaction({ tokenIn: NATIVE_NEAR, fee: 5n, feeAccount: "widekingdom6862.near" });
  assert(near.receiverId === "widekingdom6862.near" && near.actions[0].type === "Transfer" && near.actions[0].params.deposit === "5");
  const ft = feeTransaction({ tokenIn: MEME, fee: 7n, feeAccount: "widekingdom6862.near", feeRegistration: { needed: true, deposit: 1250n } });
  assert(ft.receiverId === MEME && ft.actions.length === 2 && ft.actions[1].params.args.receiver_id === "widekingdom6862.near" && ft.actions[1].params.args.amount === "7");
  assert(feeTransaction({ tokenIn: MEME, fee: 0n, feeAccount: "x.near" }) === null);
});

await check("the /route request uses the aggregator's own parameter names", async () => {
  let seen = null;
  const routes = await fetchIntearRoutes({
    tokenIn: NATIVE_NEAR, tokenOut: MEME, amountIn: 10n * E24, slippageBps: 100, accountId: USER,
    fetchImpl: async (url) => ((seen = new URL(url)), { ok: true, json: async () => [rheaRoute()] }),
  });
  const q = seen.searchParams;
  assert(seen.origin + seen.pathname === "https://router.intear.tech/route");
  assert(q.get("token_in") === "near" && q.get("token_out") === `nep141:${MEME}` && q.get("amount_in") === (10n * E24).toString());
  assert(q.get("slippage_type") === "Fixed" && q.get("slippage") === "0.01" && q.get("trader_account_id") === USER && q.get("max_wait_ms") === "2500");
  assert(routes.length === 1);
});

await check("direct safety check also rejects a route built for a different input token", () => {
  const txs = toWalletTransactions(rheaRoute());
  rejects(() => assertIntearRouteSafe(txs, { accountId: USER, tokenIn: "usdt.tether-token.near", tokenOut: "other.near", amountIn: 1n }));
});

console.log(`${passed}/${passed + failures.length} checks passed`);
for (const f of failures) console.error(`  FAIL ${f}`);
if (failures.length > 0) process.exit(1);
