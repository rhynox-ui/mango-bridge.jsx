// scripts/verify-tx-intent-firewall.mjs
//
// Offline test vectors for src/txIntentFirewall.js — the pre-sign
// intent check added for the security audit's P0 finding.
//
// Runs under plain Node with no network and no wallet: the firewall is
// deliberately a pure function of (quote, intent, items) so that it can
// be tested exactly like this, including the attacks it exists to stop.
// Every "attack" case below is a real drain pattern, not a synthetic
// one — a redirected recipient, a chain switch, a value inflation, an
// approval to a stranger.
//
// Run: node scripts/verify-tx-intent-firewall.mjs

import {
  TransactionIntentError,
  buildTransactionIntent,
  assertQuoteMatchesIntent,
  assertTransactionItemsMatchIntent,
  isNativeCurrency,
} from "../src/txIntentFirewall.js";

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
/** Asserts the firewall BLOCKS, and that it blocked for the expected reason. */
function blocks(fn, expectedFragment) {
  let threw = null;
  try {
    fn();
  } catch (err) {
    threw = err;
  }
  assert(threw !== null, "expected a block, but the trade was allowed");
  assert(threw instanceof TransactionIntentError, `expected TransactionIntentError, got ${threw?.name}: ${threw?.message}`);
  assert(
    threw.message.toLowerCase().includes(expectedFragment.toLowerCase()),
    `blocked for the wrong reason — wanted "${expectedFragment}", got "${threw.message}"`,
  );
}
function allows(fn) {
  return fn();
}

const USER = "0x1111111111111111111111111111111111111111";
const ROUTER = "0x2222222222222222222222222222222222222222";
const ATTACKER = "0x3333333333333333333333333333333333333333";
const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const NATIVE = "0x0000000000000000000000000000000000000000";
const ONE_ETH = 10n ** 18n;

const nativeIntent = buildTransactionIntent({
  originChainId: 8453,
  destinationChainId: 8453,
  originCurrency: NATIVE,
  destinationCurrency: USDC_BASE,
  amountBaseUnits: ONE_ETH.toString(),
  userAddress: USER,
  recipientAddress: USER,
});
const tokenIntent = buildTransactionIntent({
  originChainId: 8453,
  destinationChainId: 1,
  originCurrency: USDC_BASE,
  destinationCurrency: NATIVE,
  amountBaseUnits: "1000000",
  userAddress: USER,
  recipientAddress: USER,
});

const word = (value) => BigInt(value).toString(16).padStart(64, "0");
const addrWord = (address) => address.slice(2).toLowerCase().padStart(64, "0");
const erc20Approve = (spender, amount) => `0x095ea7b3${addrWord(spender)}${word(amount)}`;
const permit2Approve = (token, spender, amount) => `0x87517c45${addrWord(token)}${addrWord(spender)}${word(amount)}${word(0)}`;

const swapItem = (overrides = {}) => ({
  data: { chainId: 8453, to: ROUTER, data: "0xdeadbeef", value: ONE_ETH.toString(), ...overrides },
});

// ---- the honest path is not blocked -------------------------------
check("a normal native swap is allowed", () => {
  const warnings = allows(() => assertTransactionItemsMatchIntent([swapItem()], nativeIntent));
  assert(warnings.length === 0, `expected no warnings, got ${JSON.stringify(warnings)}`);
});
check("a normal ERC-20 swap (approve + swap, value 0) is allowed", () => {
  const warnings = assertTransactionItemsMatchIntent(
    [
      { data: { chainId: 8453, to: USDC_BASE, data: erc20Approve(ROUTER, 1000000n), value: "0" } },
      { data: { chainId: 8453, to: ROUTER, data: "0xdeadbeef", value: "0" } },
    ],
    tokenIntent,
  );
  assert(warnings.length === 0, `expected no warnings, got ${JSON.stringify(warnings)}`);
});
check("spending LESS native than entered is allowed", () => {
  assertTransactionItemsMatchIntent([swapItem({ value: (ONE_ETH / 2n).toString() })], nativeIntent);
});
check("a missing value reads as zero, not as an error", () => {
  assertTransactionItemsMatchIntent([swapItem({ value: undefined })], nativeIntent);
});
check("a Permit2 approval naming a called contract is allowed", () => {
  assertTransactionItemsMatchIntent(
    [
      { data: { chainId: 8453, to: ROUTER, data: permit2Approve(USDC_BASE, ROUTER, 1000000n), value: "0" } },
      { data: { chainId: 8453, to: ROUTER, data: "0xdeadbeef", value: "0" } },
    ],
    tokenIntent,
  );
});

// ---- the attacks it exists to stop --------------------------------
check("BLOCKS a transaction on a chain the user didn't choose", () => {
  blocks(() => assertTransactionItemsMatchIntent([swapItem({ chainId: 1 })], nativeIntent), "chain 1");
});
check("BLOCKS a transaction with no chain at all (would sign on whatever chain is connected)", () => {
  blocks(() => assertTransactionItemsMatchIntent([swapItem({ chainId: undefined })], nativeIntent), "no chain");
});
check("BLOCKS spending more native than the user entered", () => {
  blocks(() => assertTransactionItemsMatchIntent([swapItem({ value: (ONE_ETH * 5n).toString() })], nativeIntent), "more than");
});
check("BLOCKS a drain split across several transactions", () => {
  // Each one alone is under the cap; together they are five times it.
  const items = Array.from({ length: 5 }, () => swapItem({ value: ONE_ETH.toString() }));
  blocks(() => assertTransactionItemsMatchIntent(items, nativeIntent), "more than");
});
check("BLOCKS approving a token that isn't the one being spent", () => {
  blocks(
    () =>
      assertTransactionItemsMatchIntent(
        [
          { data: { chainId: 8453, to: ATTACKER, data: erc20Approve(ROUTER, 1000000n), value: "0" } },
          { data: { chainId: 8453, to: ROUTER, data: "0xdeadbeef", value: "0" } },
        ],
        tokenIntent,
      ),
    "isn't the one you're spending",
  );
});
check("BLOCKS approving a spender no transaction in the route calls", () => {
  blocks(
    () =>
      assertTransactionItemsMatchIntent(
        [
          { data: { chainId: 8453, to: USDC_BASE, data: erc20Approve(ATTACKER, 1000000n), value: "0" } },
          { data: { chainId: 8453, to: ROUTER, data: "0xdeadbeef", value: "0" } },
        ],
        tokenIntent,
      ),
    "no transaction in this route calls that address",
  );
});
check("BLOCKS an unlimited approval to a stranger (the classic drain)", () => {
  const MAX_UINT256 = 2n ** 256n - 1n;
  blocks(
    () =>
      assertTransactionItemsMatchIntent(
        [
          { data: { chainId: 8453, to: USDC_BASE, data: erc20Approve(ATTACKER, MAX_UINT256), value: "0" } },
          { data: { chainId: 8453, to: ROUTER, data: "0xdeadbeef", value: "0" } },
        ],
        tokenIntent,
      ),
    "no transaction in this route calls that address",
  );
});
check("BLOCKS a malformed destination address", () => {
  blocks(() => assertTransactionItemsMatchIntent([swapItem({ to: "0xnope" })], nativeIntent), "no valid destination");
});
check("BLOCKS an empty transaction list", () => {
  blocks(() => assertTransactionItemsMatchIntent([], nativeIntent), "no transactions to sign");
});
check("BLOCKS a quote with no recorded intent (a quote we didn't request)", () => {
  blocks(() => assertTransactionItemsMatchIntent([swapItem()], undefined), "no recorded intent");
});

// ---- warnings, not blocks (see the module header on why) ----------
check("WARNS on an approval larger than the trade, without blocking it", () => {
  const warnings = assertTransactionItemsMatchIntent(
    [
      { data: { chainId: 8453, to: USDC_BASE, data: erc20Approve(ROUTER, 999999999999n), value: "0" } },
      { data: { chainId: 8453, to: ROUTER, data: "0xdeadbeef", value: "0" } },
    ],
    tokenIntent,
  );
  assert(warnings.length === 1, `expected exactly one warning, got ${JSON.stringify(warnings)}`);
  assert(warnings[0].includes("keeps that allowance"), warnings[0]);
});
check("WARNS on native value attached to a token sale, without blocking it", () => {
  const warnings = assertTransactionItemsMatchIntent(
    [{ data: { chainId: 8453, to: ROUTER, data: "0xdeadbeef", value: "12345" } }],
    tokenIntent,
  );
  assert(warnings.length === 1, `expected exactly one warning, got ${JSON.stringify(warnings)}`);
  assert(warnings[0].includes("protocol fee"), warnings[0]);
});

// ---- quote-level checks -------------------------------------------
const goodDetails = {
  details: {
    recipient: USER,
    currencyIn: { currency: { chainId: 8453, address: NATIVE }, amount: ONE_ETH.toString() },
    currencyOut: { currency: { chainId: 8453, address: USDC_BASE } },
  },
};
check("a matching quote passes", () => {
  assertQuoteMatchesIntent(goodDetails, nativeIntent);
});
check("BLOCKS a quote that redirects the proceeds to another address", () => {
  blocks(
    () => assertQuoteMatchesIntent({ details: { ...goodDetails.details, recipient: ATTACKER } }, nativeIntent),
    "not to the address you chose",
  );
});
check("BLOCKS a quote that swaps a different token in", () => {
  blocks(
    () =>
      assertQuoteMatchesIntent(
        { details: { ...goodDetails.details, currencyIn: { currency: { chainId: 8453, address: USDC_BASE } } } },
        nativeIntent,
      ),
    "spend a different token",
  );
});
check("BLOCKS a quote that delivers on a different chain", () => {
  blocks(
    () =>
      assertQuoteMatchesIntent(
        { details: { ...goodDetails.details, currencyOut: { currency: { chainId: 137, address: USDC_BASE } } } },
        nativeIntent,
      ),
    "deliver to chain 137",
  );
});
check("BLOCKS a quote claiming to spend more than entered", () => {
  blocks(
    () =>
      assertQuoteMatchesIntent(
        { details: { ...goodDetails.details, currencyIn: { currency: { chainId: 8453, address: NATIVE }, amount: (ONE_ETH * 3n).toString() } } },
        nativeIntent,
      ),
    "more than the",
  );
});
check("a quote with no details at all is not blocked (Relay may omit them)", () => {
  assertQuoteMatchesIntent({}, nativeIntent);
});
check("both native sentinels are recognised as the same asset", () => {
  assert(isNativeCurrency(NATIVE));
  assert(isNativeCurrency("0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE"));
  assert(!isNativeCurrency(USDC_BASE));
  assertQuoteMatchesIntent(
    { details: { currencyIn: { currency: { chainId: 8453, address: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" } } } },
    nativeIntent,
  );
});
check("address comparison is case-insensitive (checksummed vs lowercase)", () => {
  assertQuoteMatchesIntent(
    { details: { recipient: USER.toUpperCase().replace("0X", "0x"), currencyIn: { currency: { chainId: 8453, address: NATIVE } } } },
    nativeIntent,
  );
});

// ---- Solana destinations: chains and amounts still checked, base58
// ---- addresses deliberately not compared for equality --------------
const solanaIntent = buildTransactionIntent({
  originChainId: 8453,
  destinationChainId: 792703809,
  originCurrency: NATIVE,
  destinationCurrency: "11111111111111111111111111111111",
  amountBaseUnits: ONE_ETH.toString(),
  userAddress: USER,
  recipientAddress: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
});
check("a base58 destination is not blocked over a spelling difference", () => {
  // A different-cased mint would be a different account, but this code
  // cannot know Relay's canonical echo, so it must not block on it.
  assertQuoteMatchesIntent(
    {
      details: {
        recipient: "9wzdxwbbmkg8ztbnmquxvqrayrzzdsgydlvl9zytawwm",
        currencyIn: { currency: { chainId: 8453, address: NATIVE } },
        currencyOut: { currency: { chainId: 792703809, address: "So11111111111111111111111111111111111111112" } },
      },
    },
    solanaIntent,
  );
});
check("a Solana-destination route on the WRONG chain is still blocked", () => {
  blocks(
    () =>
      assertQuoteMatchesIntent(
        { details: { currencyOut: { currency: { chainId: 137, address: "So11111111111111111111111111111111111111112" } } } },
        solanaIntent,
      ),
    "deliver to chain 137",
  );
});
check("the EVM origin side is still compared exactly on a Solana-destination route", () => {
  blocks(
    () => assertQuoteMatchesIntent({ details: { currencyIn: { currency: { chainId: 8453, address: USDC_BASE } } } }, solanaIntent),
    "spend a different token",
  );
});

console.log(`${passed}/${passed + failures.length} checks passed`);
for (const failure of failures) console.error(`  FAIL ${failure}`);
if (failures.length > 0) process.exit(1);
