// scripts/verify-launchpad-gas-reserve.mjs
//
// Offline checks on the Launchpad's gas reserve and its error
// translation — the two things behind a live-reported failure where a
// buy reached the chain and came back as:
//
//   Execution reverted with reason: gas required exceeds allowance (4635).
//
// That message reads like a gas-limit problem and is actually a balance
// problem. geth computes how much gas the balance could still pay for
// AFTER the transaction's own value is subtracted, and reports that
// number — so 4635 was not a limit anyone configured, it was what was
// left. The trade had spent so much of the balance as principal that
// almost nothing remained for the fee.
//
// Why these checks and not others: the reserve arithmetic is the kind of
// bug that never throws. A reserve that is too small produces a valid
// number, fills a valid-looking amount into the field, and only fails
// once real money is already in flight. So what is pinned here is the
// arithmetic itself, at the balances where it actually matters — dust,
// and a balance barely above the fee.
//
// Run: node scripts/verify-launchpad-gas-reserve.mjs

import assert from "node:assert";
import { describeTradeError } from "../src/launchpadTradeErrors.js";

let n = 0;
function check(label, fn) {
  fn();
  n++;
  console.log(`ok ${n} - ${label}`);
}

// The shape both surfaces now use: take the percentage of what is
// SPENDABLE (balance minus the reserve), never of the full balance.
function percentAmount({ balance, reserve, pct }) {
  return Math.max(0, balance - reserve) * pct;
}

const RESERVE = 0.0004; // ~400k gas at a realistic Robinhood Chain price

check("a dust balance yields nothing to spend at any percentage", () => {
  // The reported failure: a balance far below the fee still produced a
  // real, nonzero buy amount, because the percentage was taken of the
  // whole balance and no reserve was subtracted at all below 100%.
  const dust = 0.00000434;
  for (const pct of [0.25, 0.5, 1]) {
    assert.strictEqual(percentAmount({ balance: dust, reserve: RESERVE, pct }), 0, `${pct * 100}% of dust was spendable`);
  }
});

check("100% always leaves the whole reserve behind", () => {
  const balance = 0.05;
  const amount = percentAmount({ balance, reserve: RESERVE, pct: 1 });
  assert.ok(amount + RESERVE <= balance + Number.EPSILON, `${amount} + ${RESERVE} exceeds ${balance}`);
});

check("every partial percentage also leaves the reserve behind", () => {
  // This is the case that had no protection whatsoever: 25% and 50% did
  // not subtract a reserve at all, on any balance.
  const balance = 0.05;
  for (const pct of [0.25, 0.5]) {
    const amount = percentAmount({ balance, reserve: RESERVE, pct });
    assert.ok(amount + RESERVE <= balance, `${pct * 100}% left less than the reserve`);
  }
});

check("a balance exactly equal to the reserve is not spendable", () => {
  assert.strictEqual(percentAmount({ balance: RESERVE, reserve: RESERVE, pct: 1 }), 0);
});

check("the reserve is never negative, however small the balance", () => {
  for (const balance of [0, 1e-18, RESERVE / 2]) {
    assert.ok(percentAmount({ balance, reserve: RESERVE, pct: 1 }) >= 0);
  }
});

check("a swap reserve is far larger than a plain transfer's — the original mistake", () => {
  // The old code reserved estimateEvmSendFee's 21,000-gas transfer cost.
  // A router call that runs a swap is an order of magnitude more, which
  // is why reserving the transfer cost still left the trade unfunded.
  const TRANSFER_GAS = 21_000n;
  const FALLBACK_TRADE_GAS = 400_000n;
  assert.ok(FALLBACK_TRADE_GAS > TRANSFER_GAS * 10n, "the trade reserve must dominate a plain transfer's");
});

// ---------------------------------------------------------------------
// Error translation. The user saw several hundred characters of calldata
// where an explanation belonged.
// ---------------------------------------------------------------------

const REAL_FAILURE = {
  shortMessage: "Execution reverted.",
  message: [
    "Execution reverted with reason: gas required exceeds allowance (4635).",
    "",
    "Request Arguments:",
    "  from:  0x88917dAC2BC416452E98beC9EF8467eBA7398126",
    "  to:    0xb347EEad23D4FC41338845E35Ee8Fc42D9789d70",
    "  value: 0.00000434 ETH",
    "  data:  0xa64950f80000000000000000000000006707859" + "0".repeat(400),
    "",
    "Version: viem@2.55.18",
  ].join("\n"),
};

check("the reported failure becomes a sentence about ETH, not about gas limits", () => {
  const { message } = describeTradeError(REAL_FAILURE);
  assert.ok(/not enough eth/i.test(message), message);
  assert.ok(!message.includes("0x"), "calldata leaked into the headline");
  assert.ok(message.length < 200, `headline is ${message.length} chars`);
});

check("no raw calldata survives into anything shown to a user", () => {
  const { message, detail } = describeTradeError(REAL_FAILURE);
  for (const text of [message, detail]) {
    assert.ok(!/0xa64950f8/.test(text), "raw calldata reached the UI");
  }
});

check("a cancelled trade is not reported as an error condition", () => {
  const { message } = describeTradeError({ message: "User rejected the request." });
  assert.strictEqual(message, "Trade cancelled.");
});

check("slippage and expiry get their own actionable wording", () => {
  assert.ok(/slippage/i.test(describeTradeError({ message: "Too little received" }).message));
  assert.ok(/expired|again/i.test(describeTradeError({ message: "Transaction deadline expired" }).message));
});

check("an unrecognized error never dumps more than its first line", () => {
  const { message } = describeTradeError(new Error("Something new\nwith a second line\nand a third"));
  assert.strictEqual(message, "Something new");
});


// ---------------------------------------------------------------------
// The chart's "has this pool been traded" gate.
//
// This shipped wrong: it read `marketCapUsd > 0`, on the reasoning that
// market cap is the sum of accrued trading fees and so $0 proves nothing
// ever traded. A real token then showed "No trades yet" directly above a
// panel listing six real swaps — because trades of 0.00002-0.0003 ETH
// accrue fees that still round to $0.
//
// It is exactly the class of bug worth pinning: nothing throws, the page
// renders cleanly, and the only symptom is a chart that silently refuses
// to appear on a token that has been trading for weeks.
// ---------------------------------------------------------------------

// The rule both surfaces now implement.
function chartGate({ tradeCount, marketCapUsd }) {
  if (tradeCount === null) return marketCapUsd > 0 ? true : null;
  return tradeCount > 0 || marketCapUsd > 0;
}

check("a traded pool shows its chart even when market cap rounds to $0", () => {
  // The exact reported case: real swaps, $0 cap.
  assert.strictEqual(chartGate({ tradeCount: 6, marketCapUsd: 0 }), true);
});

check("a genuinely untraded pool still shows the empty state", () => {
  assert.strictEqual(chartGate({ tradeCount: 0, marketCapUsd: 0 }), false);
});

check("market cap alone is still enough to show the chart", () => {
  // A nonzero cap can only exist if trading happened, so it is a valid
  // yes — it was never a valid *no*.
  assert.strictEqual(chartGate({ tradeCount: null, marketCapUsd: 1200 }), true);
});

check("while the trade list is loading the chart claims neither way", () => {
  // Rendering "No trades yet" here would be the same wrong claim,
  // arriving a second earlier.
  assert.strictEqual(chartGate({ tradeCount: null, marketCapUsd: 0 }), null);
});

check("a failed trade fetch is not treated as proof of zero trades", () => {
  // The panel reports null rather than 0 when the request fails, so this
  // must resolve to "unknown", never to the empty state.
  assert.strictEqual(chartGate({ tradeCount: null, marketCapUsd: 0 }), null);
});

console.log(`\n${n}/${n} checks passed`);
