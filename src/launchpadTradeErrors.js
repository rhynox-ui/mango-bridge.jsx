// src/launchpadTradeErrors.js
//
// Turns a thrown trade error into one sentence a person can act on.
//
// This exists because the Launchpad used to render `err.message`
// straight onto the screen, and viem's message is a full diagnostic
// dump: the reason, then the from/to/value, then the entire calldata as
// one unbroken hex string, then the decoded call, then a docs link and a
// version banner. A real user hit this and saw several hundred
// characters of hex where an explanation should have been.
//
// The dump is not useless — it is exactly what you want when filing a
// bug — so it is returned as `detail` rather than thrown away. What
// changes is which of the two is the headline.
//
// Deliberately matched on the node's own wording rather than on error
// classes: these strings come from the RPC (geth and its forks), so they
// survive viem upgrades that reshape the error hierarchy, and they are
// the same strings whether the call was made from this app, the site, or
// curl.

/**
 * "gas required exceeds allowance (N)" is the one worth naming
 * precisely. It reads like a gas-limit problem and is actually a balance
 * problem: geth computes how much gas the remaining balance could pay
 * for after the transaction's own value is subtracted, and reports that
 * number. So N is not a limit anyone configured — it is what was left.
 * Saying "not enough ETH to cover gas" is the accurate reading.
 */
const PATTERNS = [
  {
    match: /gas required exceeds allowance/i,
    message: "Not enough ETH left to pay for gas. Lower the amount — the trade needs to leave enough behind to cover the transaction fee.",
  },
  {
    match: /insufficient funds/i,
    message: "Not enough ETH in this wallet for the amount plus the transaction fee.",
  },
  {
    match: /user rejected|user denied|rejected the request/i,
    message: "Trade cancelled.",
  },
  {
    match: /deadline|expired/i,
    message: "The trade took too long to confirm and expired. Try again.",
  },
  {
    match: /slippage|too little received|amountoutmin|price impact/i,
    message: "The price moved more than the slippage tolerance allowed. Raise the slippage or try a smaller amount.",
  },
  {
    match: /nonce/i,
    message: "Another transaction from this wallet is still pending. Wait for it to confirm, then try again.",
  },
  {
    match: /replacement transaction underpriced/i,
    message: "A pending transaction from this wallet is blocking this one. Wait for it to confirm, then try again.",
  },
];

/**
 * @param {unknown} err
 * @returns {{message: string, detail: string}} `message` is safe to show
 *   as the headline; `detail` is the original text, for a collapsed
 *   "details" affordance or a bug report. `detail` is empty when it
 *   would only repeat `message`.
 */
export function describeTradeError(err) {
  const raw =
    (err && typeof err === "object" && typeof (/** @type {any} */ (err).message) === "string"
      ? /** @type {any} */ (err).message
      : String(err ?? "")) || "";
  // viem's own one-line summary, when present, is already far closer to
  // readable than the full dump — worth preferring over `message` for the
  // detail text so the hex blob is not the first thing in it.
  const short =
    err && typeof err === "object" && typeof (/** @type {any} */ (err).shortMessage) === "string"
      ? /** @type {any} */ (err).shortMessage
      : "";

  for (const {match, message} of PATTERNS) {
    if (match.test(raw)) {
      return {message, detail: short || firstLine(raw)};
    }
  }
  // Unrecognized: fall back to viem's short message if it has one, and
  // only then to the first line of the dump — never the whole thing.
  return {message: short || firstLine(raw) || "The trade could not be completed.", detail: ""};
}

function firstLine(text) {
  const line = String(text).split("\n").find(l => l.trim().length > 0);
  return line ? line.trim() : "";
}
