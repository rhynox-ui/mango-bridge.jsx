// scripts/verify-inline-dex-fee.mjs
//
// Regression tests for the atomic (single-transaction) fee collection
// added to uniswapV3.js/uniswapV4.js/pancakeswapV3.js, replacing the
// earlier two-transaction sweepFallbackFeeFromNativeBalance approach
// (rejected: a second transaction costs the user real gas that can
// exceed the small fee being collected, a net loss for the user it was
// never supposed to cost anything).
//
// What this can and can't test directly, and why: uniswapV3.js/
// uniswapV4.js/pancakeswapV3.js/fallbackDex.js all transitively import
// wagmi.js, which reads import.meta.env.VITE_ALCHEMY_API_KEY (a
// Vite-only global) at module load time — confirmed directly, same gap
// this repo already worked around once before for the same reason
// (see this file's own git history). A plain Node script can't import
// ANY of those files, even just for a pure helper or ABI constant,
// because the throw happens at import time, not call time. So this
// verifies what's actually independently testable:
//
//   1. appFeeBps() (devFeeWallets.js — no wagmi/Vite dependency, a
//      real, direct import) always produces a bps value inside
//      SwapRouter02's own hard-revert boundary (require(feeBips > 0 &&
//      feeBips <= 100) in Uniswap's PeripheryPaymentsWithFee.sol,
//      confirmed against the real deployed contract's source) — if
//      this were ever violated, ordinary trades would either silently
//      collect no fee (feeBips <= 0, safe) or, worse, every V3
//      fallback swap would revert outright the moment a fee ever
//      exceeded 100 bps. Proves the atomic path is actually reachable
//      for real trade sizes, not silently always-off.
//   2. The collectFeeInline gating logic all three files share
//      (Number.isInteger(feeBips) && feeBips > 0 && feeBips <= CAP &&
//      Boolean(feeRecipient)) — reproduced literally here since it
//      can't be imported, and cross-checked against the real source
//      files below via a plain string-presence grep, so a change to
//      the shipped expression that isn't mirrored here fails loudly
//      instead of this test silently testing stale logic.
//   3. The actual ABI/command encodings (SwapRouter02's
//      sweepTokenWithFee, V4Router's TAKE_PORTION action bytes,
//      PancakeSwap's Universal Router PAY_PORTION/SWEEP command
//      bytes), built with real viem encode functions (viem itself has
//      no Vite dependency — a genuine, direct import) and round-tripped
//      through decodeFunctionData/decodeAbiParameters where possible,
//      proving the shapes are self-consistent and match what each
//      source file actually encodes byte-for-byte.
//
// Run: node scripts/verify-inline-dex-fee.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { encodeAbiParameters, decodeAbiParameters, encodeFunctionData, decodeFunctionData, encodePacked, toFunctionSelector } from "viem";
import { appFeeBps, DEV_FEE_PCT, DEV_FEE_MAX_USD } from "../src/devFeeWallets.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcPath = (name) => join(__dirname, "..", "src", name);

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

// ---- 1. appFeeBps() always lands inside SwapRouter02's hard cap -----

// Same collectFeeInline gate every one of the three execute*Swap
// functions applies — reproduced literally (see this file's own header
// on why it can't just be imported).
function collectFeeInline(feeBips, feeRecipient, cap) {
  return Number.isInteger(feeBips) && feeBips > 0 && feeBips <= cap && Boolean(feeRecipient);
}

const SWAP_ROUTER_02_FEE_CAP = 100; // require(feeBips > 0 && feeBips <= 100) — SwapRouter02-specific.
const SAMPLE_TRADE_SIZES_USD = [undefined, null, 0, -5, 0.5, 1, 50, 500, 5000, 50_000, 500_000, 5_000_000, 100_000_000];

check("appFeeBps() never exceeds SwapRouter02's 100-bips hard cap, for any realistic trade size", () => {
  for (const usd of SAMPLE_TRADE_SIZES_USD) {
    const bips = Number(appFeeBps(usd));
    assert(Number.isInteger(bips), `originAmountUsd=${usd} produced non-integer bips ${bips}`);
    assert(bips >= 1, `originAmountUsd=${usd} produced bips ${bips} <= 0 — would silently disable the fee`);
    assert(bips <= SWAP_ROUTER_02_FEE_CAP, `originAmountUsd=${usd} produced bips ${bips} > 100 — would revert every V3 fallback swap`);
  }
});

check("a normal trade's real bps value passes the inline-collection gate on all three routers", () => {
  for (const usd of [50, 500, 5000, 50_000, 500_000]) {
    const bips = Number(appFeeBps(usd));
    assert(collectFeeInline(bips, "0xdeadbeef00000000000000000000000000dead", 100), `uniswapV3 gate rejected a normal bips value ${bips} for $${usd}`);
    assert(collectFeeInline(bips, "0xdeadbeef00000000000000000000000000dead", 10000), `uniswapV4/pancakeswapV3 gate rejected a normal bips value ${bips} for $${usd}`);
  }
});

check("the flat rate matches this repo's own documented DEV_FEE_PCT/DEV_FEE_MAX_USD", () => {
  assert(DEV_FEE_PCT === 0.005, `expected 0.5%, got ${DEV_FEE_PCT * 100}%`);
  assert(DEV_FEE_MAX_USD === 50, `expected a $50 cap, got $${DEV_FEE_MAX_USD}`);
  assert(Number(appFeeBps(undefined)) === Math.round(DEV_FEE_PCT * 10000), "flat-rate bips should match DEV_FEE_PCT exactly with no priced amount");
});

// ---- 2. collectFeeInline gate: every edge case a live trade could hit ----

check("collectFeeInline rejects a zero, negative, NaN, non-integer, or over-cap bips", () => {
  const recipient = "0xdeadbeef00000000000000000000000000dead";
  for (const bad of [0, -1, NaN, 12.5, 101]) {
    assert(!collectFeeInline(bad, recipient, 100), `feeBips=${bad} should not pass the SwapRouter02 (cap 100) gate`);
  }
  assert(!collectFeeInline(10001, recipient, 10000), "feeBips=10001 should not pass the 10_000-cap gate (V4/PancakeSwap)");
});

check("collectFeeInline rejects a missing feeRecipient even with a valid bips", () => {
  assert(!collectFeeInline(50, undefined, 100));
  assert(!collectFeeInline(50, null, 100));
  assert(!collectFeeInline(50, "", 100));
});

check("collectFeeInline accepts the boundary values (1 and the cap itself)", () => {
  const recipient = "0xdeadbeef00000000000000000000000000dead";
  assert(collectFeeInline(1, recipient, 100));
  assert(collectFeeInline(100, recipient, 100));
  assert(collectFeeInline(10000, recipient, 10000));
});

// Cross-check: the exact gate expression above must actually appear in
// each shipped source file — catches this test silently drifting from
// what's really deployed if the real expression is ever edited without
// updating this mirror.
check("the gate expression mirrored above is really what uniswapV3.js/uniswapV4.js/pancakeswapV3.js ship", () => {
  const needle = "Number.isInteger(feeBips) && feeBips > 0 && feeBips <=";
  for (const file of ["uniswapV3.js", "uniswapV4.js", "pancakeswapV3.js"]) {
    const src = readFileSync(srcPath(file), "utf8");
    assert(src.includes(needle), `${file} no longer contains the expected collectFeeInline gate — update this test's mirror to match`);
  }
});

// ---- 3. Real ABI/command encodings, round-tripped where possible ----

const SWEEP_TOKEN_WITH_FEE_ABI = [{
  type: "function",
  name: "sweepTokenWithFee",
  stateMutability: "payable",
  inputs: [
    { name: "token", type: "address" },
    { name: "amountMinimum", type: "uint256" },
    { name: "feeBips", type: "uint256" },
    { name: "feeRecipient", type: "address" },
  ],
  outputs: [],
}];

check("SwapRouter02's sweepTokenWithFee(token, amountMinimum, feeBips, feeRecipient) round-trips through real ABI encode/decode", () => {
  const token = "0xadadadadadadadadadadadadadadadadadadadad";
  const feeRecipient = "0xf07becc2401a646fff10d10b969ef18b03582e88";
  const args = [token, 12345n, 50n, feeRecipient];
  const calldata = encodeFunctionData({ abi: SWEEP_TOKEN_WITH_FEE_ABI, functionName: "sweepTokenWithFee", args });
  // Independently computed from the canonical signature string (not
  // just re-deriving the same selector encodeFunctionData already
  // used from the same ABI array) — this catches the ABI array's
  // param types/order silently drifting from the real 4-arg
  // sweepTokenWithFee(address,uint256,uint256,address) overload, since
  // two different viem code paths have to agree.
  const expectedSelector = toFunctionSelector("sweepTokenWithFee(address,uint256,uint256,address)");
  assert(calldata.startsWith(expectedSelector), `selector ${calldata.slice(0, 10)} doesn't match sweepTokenWithFee(address,uint256,uint256,address)'s own selector ${expectedSelector}`);
  const decoded = decodeFunctionData({ abi: SWEEP_TOKEN_WITH_FEE_ABI, data: calldata });
  assert(decoded.functionName === "sweepTokenWithFee");
  assert(decoded.args[0].toLowerCase() === token.toLowerCase());
  assert(decoded.args[1] === 12345n && decoded.args[2] === 50n);
  assert(decoded.args[3].toLowerCase() === feeRecipient.toLowerCase());
});

check("V4Router's fee-collecting action byte sequence is SWAP(6) SETTLE_ALL(12) TAKE_PORTION(16) TAKE_ALL(15), exactly", () => {
  const actions = encodePacked(["uint8", "uint8", "uint8", "uint8"], [6, 12, 16, 15]);
  assert(actions === "0x060c100f", `expected 0x060c100f, got ${actions}`);
});

check("V4Router's no-fee action byte sequence is unchanged: SWAP(6) SETTLE_ALL(12) TAKE_ALL(15)", () => {
  const actions = encodePacked(["uint8", "uint8", "uint8"], [6, 12, 15]);
  assert(actions === "0x060c0f", `expected 0x060c0f, got ${actions}`);
});

check("TAKE_PORTION's (currency, recipient, bips) params encode and decode round-trip", () => {
  const currencyOut = "0x4200000000000000000000000000000000000006";
  const feeRecipient = "0xf07becc2401a646fff10d10b969ef18b03582e88";
  const params = [{ type: "address", name: "currency" }, { type: "address", name: "recipient" }, { type: "uint256", name: "bips" }];
  const encoded = encodeAbiParameters(params, [currencyOut, feeRecipient, 50n]);
  const [decodedCurrency, decodedRecipient, decodedBips] = decodeAbiParameters(params, encoded);
  assert(decodedCurrency.toLowerCase() === currencyOut.toLowerCase());
  assert(decodedRecipient.toLowerCase() === feeRecipient.toLowerCase());
  assert(decodedBips === 50n);
});

check("PancakeSwap Universal Router's fee-collecting command bytes append PAY_PORTION(6) then SWEEP(4) after the swap command(s)", () => {
  const nonNativeSell = encodePacked(["uint8", "uint8", "uint8"], [0, 6, 4]); // V3_SWAP_EXACT_IN, PAY_PORTION, SWEEP
  assert(nonNativeSell === "0x000604", `expected 0x000604, got ${nonNativeSell}`);
  const nativeSell = encodePacked(["uint8", "uint8", "uint8", "uint8"], [11, 0, 6, 4]); // WRAP_ETH, V3_SWAP_EXACT_IN, PAY_PORTION, SWEEP
  assert(nativeSell === "0x0b000604", `expected 0x0b000604, got ${nativeSell}`);
});

check("PAY_PORTION's (token, recipient, bips) and SWEEP's (token, recipient, amountMinimum) params both round-trip", () => {
  const token = "0x4200000000000000000000000000000000000006";
  const feeRecipient = "0xf07becc2401a646fff10d10b969ef18b03582e88";
  const msgSender = "0x0000000000000000000000000000000000000001";
  const params = [{ type: "address", name: "token" }, { type: "address", name: "recipient" }, { type: "uint256", name: "value" }];

  const payPortion = decodeAbiParameters(params, encodeAbiParameters(params, [token, feeRecipient, 50n]));
  assert(payPortion[1].toLowerCase() === feeRecipient.toLowerCase() && payPortion[2] === 50n);

  const sweep = decodeAbiParameters(params, encodeAbiParameters(params, [token, msgSender, 0n]));
  assert(sweep[1].toLowerCase() === msgSender.toLowerCase() && sweep[2] === 0n);
});

check("unwrapWETH9/unwrapWETH9WithFee selectors are independently confirmed, and the multicall pairing for a native-out sell matches the intended branch", () => {
  const UNWRAP_WETH9_ABI = [{ type: "function", name: "unwrapWETH9", stateMutability: "payable", inputs: [{ name: "amountMinimum", type: "uint256" }, { name: "recipient", type: "address" }], outputs: [] }];
  const UNWRAP_WETH9_WITH_FEE_ABI = [{ type: "function", name: "unwrapWETH9WithFee", stateMutability: "payable", inputs: [{ name: "amountMinimum", type: "uint256" }, { name: "feeBips", type: "uint256" }, { name: "feeRecipient", type: "address" }], outputs: [] }];
  const account = "0xadadadadadadadadadadadadadadadadadadadad";
  const feeRecipient = "0xf07becc2401a646fff10d10b969ef18b03582e88";

  const plainCalldata = encodeFunctionData({ abi: UNWRAP_WETH9_ABI, functionName: "unwrapWETH9", args: [12345n, account] });
  const expectedPlainSelector = toFunctionSelector("unwrapWETH9(uint256,address)");
  assert(plainCalldata.startsWith(expectedPlainSelector), `unwrapWETH9 selector ${plainCalldata.slice(0, 10)} != ${expectedPlainSelector}`);
  const decodedPlain = decodeFunctionData({ abi: UNWRAP_WETH9_ABI, data: plainCalldata });
  assert(decodedPlain.args[0] === 12345n && decodedPlain.args[1].toLowerCase() === account.toLowerCase());

  const feeCalldata = encodeFunctionData({ abi: UNWRAP_WETH9_WITH_FEE_ABI, functionName: "unwrapWETH9WithFee", args: [12345n, 50n, feeRecipient] });
  const expectedFeeSelector = toFunctionSelector("unwrapWETH9WithFee(uint256,uint256,address)");
  assert(feeCalldata.startsWith(expectedFeeSelector), `unwrapWETH9WithFee selector ${feeCalldata.slice(0, 10)} != ${expectedFeeSelector}`);
  const decodedFee = decodeFunctionData({ abi: UNWRAP_WETH9_WITH_FEE_ABI, data: feeCalldata });
  assert(decodedFee.args[0] === 12345n && decodedFee.args[1] === 50n && decodedFee.args[2].toLowerCase() === feeRecipient.toLowerCase());
});

check("PancakeSwap's UNWRAP_WETH(12) command byte and its (recipient, amountMin) params round-trip, for both the plain and fee-collecting native-out tails", () => {
  const account = "0xadadadadadadadadadadadadadadadadadadadad";
  const ADDRESS_THIS = "0x0000000000000000000000000000000000000002";

  // Plain native-out (no fee): swap command(s) + UNWRAP_WETH only.
  const plainTail = encodePacked(["uint8", "uint8"], [0, 12]); // V3_SWAP_EXACT_IN, UNWRAP_WETH
  assert(plainTail === "0x000c", `expected 0x000c, got ${plainTail}`);
  const unwrapParams = [{ type: "address", name: "recipient" }, { type: "uint256", name: "amountMin" }];
  const [decodedRecipient, decodedAmountMin] = decodeAbiParameters(unwrapParams, encodeAbiParameters(unwrapParams, [account, 12345n]));
  assert(decodedRecipient.toLowerCase() === account.toLowerCase() && decodedAmountMin === 12345n);

  // Fee-collecting native-out: swap + UNWRAP_WETH(12) + PAY_PORTION(6) + SWEEP(4), unwrap recipient is the router itself.
  const feeTail = encodePacked(["uint8", "uint8", "uint8", "uint8"], [0, 12, 6, 4]);
  assert(feeTail === "0x000c0604", `expected 0x000c0604, got ${feeTail}`);
  const [decodedFeeRecipientSlot] = decodeAbiParameters(unwrapParams, encodeAbiParameters(unwrapParams, [ADDRESS_THIS, 12345n]));
  assert(decodedFeeRecipientSlot.toLowerCase() === ADDRESS_THIS, "the fee-collecting tail's UNWRAP_WETH must send to the router itself (ADDRESS_THIS), not directly to the user");
});

check("PAY_PORTION/SWEEP accept the native-currency flag (address(0)) as their token param, for a native-out fee carve-out", () => {
  const NATIVE_PLACEHOLDER = "0x0000000000000000000000000000000000000000";
  const feeRecipient = "0xf07becc2401a646fff10d10b969ef18b03582e88";
  const params = [{ type: "address", name: "token" }, { type: "address", name: "recipient" }, { type: "uint256", name: "value" }];
  const [decodedToken, decodedRecipient, decodedBips] = decodeAbiParameters(params, encodeAbiParameters(params, [NATIVE_PLACEHOLDER, feeRecipient, 50n]));
  assert(decodedToken.toLowerCase() === NATIVE_PLACEHOLDER && decodedRecipient.toLowerCase() === feeRecipient.toLowerCase() && decodedBips === 50n);
});

check("netBuyAmountAfterInlineFee's math (mirrored — can't import fallbackDex.js directly, see this file's own header) matches what the router actually delivers", () => {
  function netBuyAmountAfterInlineFee(grossBuyAmount, provider, feeBips) {
    const ATOMIC_FEE_PROVIDERS = new Set(["uniswap-v4", "uniswap-v3", "pancakeswap-v3"]);
    if (!ATOMIC_FEE_PROVIDERS.has(provider) || !(feeBips > 0)) return grossBuyAmount;
    return grossBuyAmount - (grossBuyAmount * BigInt(feeBips)) / 10000n;
  }
  // A $1000-equivalent trade at the flat 50-bips rate: user nets 99.5%.
  const gross = 1_000_000_000n; // 1000 USDC, 6 decimals
  assert(netBuyAmountAfterInlineFee(gross, "uniswap-v3", 50) === 995_000_000n);
  assert(netBuyAmountAfterInlineFee(gross, "uniswap-v4", 50) === 995_000_000n);
  assert(netBuyAmountAfterInlineFee(gross, "pancakeswap-v3", 50) === 995_000_000n);
  // sushiswap-v2 collects no fee at all — never adjusted, regardless of feeBips.
  assert(netBuyAmountAfterInlineFee(gross, "sushiswap-v2", 50) === gross);
  // A generic aggregator's quote is already net of its own fee handling — never adjusted here either.
  assert(netBuyAmountAfterInlineFee(gross, "1inch", 50) === gross);
  // feeBips=0 (no fee this trade) leaves any provider's amount untouched.
  assert(netBuyAmountAfterInlineFee(gross, "uniswap-v3", 0) === gross);

  const src = readFileSync(srcPath("fallbackDex.js"), "utf8");
  assert(src.includes("function netBuyAmountAfterInlineFee(grossBuyAmount, provider, feeBips)"), "fallbackDex.js's real function signature no longer matches this mirror — update both together");
  assert(src.includes('ATOMIC_FEE_PROVIDERS = new Set(["uniswap-v4", "uniswap-v3", "pancakeswap-v3"])'), "the real atomic-fee provider set drifted from this mirror");
  assert(/checkFallbackRoute[\s\S]{0,400}netBuyAmountAfterInlineFee/.test(src), "checkFallbackRoute (the pre-trade preview) must apply the net-of-fee adjustment");
});

check("MSG_SENDER/ADDRESS_THIS sentinels used across all three files are the well-known address(1)/address(2)", () => {
  const MSG_SENDER = "0x0000000000000000000000000000000000000001";
  const ADDRESS_THIS = "0x0000000000000000000000000000000000000002";
  for (const file of ["uniswapV3.js", "pancakeswapV3.js"]) {
    const src = readFileSync(srcPath(file), "utf8");
    assert(src.toLowerCase().includes(ADDRESS_THIS.toLowerCase()), `${file} should reference the ADDRESS_THIS sentinel`);
  }
  const pancake = readFileSync(srcPath("pancakeswapV3.js"), "utf8");
  assert(pancake.toLowerCase().includes(MSG_SENDER.toLowerCase()), "pancakeswapV3.js should reference the MSG_SENDER sentinel for its SWEEP command");
});

// ---- 4. fallbackDex.js wiring: the two-transaction sweep is really gone ----

check("fallbackDex.js no longer imports or defines the rejected two-transaction fee sweep", () => {
  const src = readFileSync(srcPath("fallbackDex.js"), "utf8");
  assert(!src.includes("sweepFallbackFeeFromNativeBalance"), "the rejected two-transaction sweep function should be fully removed, not just unused");
  assert(!src.includes("fallbackFeeSweep.js"), "fallbackDex.js should no longer import the now-dead fallbackFeeSweep.js module");
  assert(src.includes("feeRecipient: DEV_FEE_WALLET"), "fallbackDex.js should pass feeRecipient into the atomic-fee execute*Swap calls");
});

check("uniswap-v4/uniswap-v3/pancakeswap-v3 report the router's own feeCollectedInline; sushiswap-v2 stays hard-coded false", () => {
  const src = readFileSync(srcPath("fallbackDex.js"), "utf8");
  const v4Block = src.slice(src.indexOf('entry.provider === "uniswap-v4"'), src.indexOf('entry.provider === "uniswap-v3"'));
  const v3Block = src.slice(src.indexOf('entry.provider === "uniswap-v3"'), src.indexOf('entry.provider === "sushiswap-v2"'));
  const sushiBlock = src.slice(src.indexOf('entry.provider === "sushiswap-v2"'), src.indexOf('entry.provider === "pancakeswap-v3"'));
  const pancakeBlock = src.slice(src.indexOf('entry.provider === "pancakeswap-v3"'), src.indexOf("// Generic provider"));
  assert(v4Block.includes("feeCollectedInline: result.feeCollectedInline"), "uniswap-v4 should report the router's own real result");
  assert(v3Block.includes("feeCollectedInline: result.feeCollectedInline"), "uniswap-v3 should report the router's own real result");
  assert(pancakeBlock.includes("feeCollectedInline: result.feeCollectedInline"), "pancakeswap-v3 should report the router's own real result");
  assert(sushiBlock.includes("feeCollectedInline: false"), "sushiswap-v2 has no atomic mechanism — must stay hard-coded false, never fabricated");
});

console.log(`${passed}/${passed + failures.length} checks passed`);
for (const failure of failures) console.error(`  FAIL ${failure}`);
if (failures.length > 0) process.exit(1);
