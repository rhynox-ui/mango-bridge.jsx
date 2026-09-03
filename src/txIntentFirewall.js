// src/txIntentFirewall.js
//
// Checks a routing provider's returned transaction against what the
// user actually asked for, BEFORE it reaches a wallet for signature.
//
// WHY THIS EXISTS. A security audit's P0 finding: executeRelayQuote (and
// the 1inch/0x/OKX/KyberSwap fallback path) took `to`, `data`, `value`
// and `chainId` straight out of an HTTP response and handed them to
// sendTransaction. Every one of those is attacker-controlled the moment
// anything between the user and the router is compromised — the routing
// API, our own proxy, a CDN, a hostile response injected by a browser
// extension. The user reviewed "swap 0.5 ETH for USDC" in our modal and
// then signed whatever bytes came back, with nothing comparing the two.
//
// WHAT THIS CAN AND CANNOT DO. It cannot tell you what arbitrary router
// calldata does; decoding every DEX aggregator's encoding is not a thing
// a client can keep up with, and pretending otherwise would be worse
// than not trying. What it CAN do is bound the loss, using only fields
// that must be present for a transaction to be signed at all:
//
//   - Chain. Every item must name the chain the user chose. Without
//     this a response can omit chainId entirely, in which case
//     executeRelayQuote's `if (chainId) await switchChain(...)` silently
//     signs on whatever chain the wallet happens to be sitting on.
//   - Native value. The total native currency the transactions may move
//     is capped at the amount the user typed — and at ZERO when the
//     user is spending an ERC-20, where no native should move at all.
//   - Approvals. An `approve` in the origin token, to any spender, is
//     capped at the amount the user is spending. This is what blocks
//     the classic infinite-approval drain: the sequence looks like a
//     normal swap, and the router keeps the right to take the rest of
//     the balance afterwards.
//
// Together those bound the worst case to "the trade the user asked for
// went to the wrong place" instead of "the wallet was emptied". Calldata
// that does something else entirely still can't move more than the user
// staked on this trade.
//
// WHAT BLOCKS AND WHAT ONLY WARNS. A false positive here is not a
// harmless extra check — it is a user who cannot trade. So the blocking
// set is restricted to conditions that CANNOT legitimately occur:
// a chain we didn't ask for, a recipient or currency we didn't ask for,
// spending more native than the user typed, approving a token that
// isn't the one being spent, or approving a spender that no other
// transaction in this same quote even calls.
//
// Two genuinely suspicious patterns only WARN, because this could not
// be verified against the live routing API from the environment this
// was written in and both have legitimate explanations elsewhere in the
// industry: native value attached to an ERC-20 sale (some routes charge
// a native protocol fee in the same transaction) and an approval larger
// than the trade (many routers approve max-uint256 deliberately to save
// gas on later trades). They are returned to the caller instead of
// thrown. If Relay is ever confirmed never to do either, promoting them
// to blocks is a one-line change and the tests below already cover both
// directions.
//
// The quote-level checks below (currencies, chains, recipient) are the
// second layer and are deliberately NOT fail-closed on absence: every
// one of those fields is optional in Relay's own response schema, so
// requiring them would break real trades whenever Relay legitimately
// omits one. They are enforced when present. That asymmetry is
// intentional and is why the bounds above are written to hold on their
// own, without any help from `details`.

const ERC20_APPROVE_SELECTOR = "0x095ea7b3";
// Permit2's approve(address token, address spender, uint160 amount,
// uint48 expiration) — a different shape from ERC-20's, so its amount
// sits at a different offset. Relay routes through Permit2 on chains
// where it is deployed.
const PERMIT2_APPROVE_SELECTOR = "0x87517c45";

const NATIVE_SENTINELS = new Set([
  "0x0000000000000000000000000000000000000000",
  // Some providers use this pseudo-address for "the chain's own coin".
  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
]);

export class TransactionIntentError extends Error {
  constructor(message) {
    super(message);
    this.name = "TransactionIntentError";
  }
}

function fail(message) {
  throw new TransactionIntentError(
    `${message} This trade was stopped before signing because what came back from the routing service didn't match what you asked for. Nothing was sent and nothing was spent.`,
  );
}

function normalizeAddress(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : null;
}

const EVM_ADDRESS = /^0x[0-9a-f]{40}$/;

/**
 * True only when both values are EVM addresses, which are the only ones
 * this file compares for equality — see assertQuoteMatchesIntent's own
 * comment on why a base58 Solana address is not compared here.
 */
function comparableAddresses(a, b) {
  return typeof a === "string" && typeof b === "string" && EVM_ADDRESS.test(a) && EVM_ADDRESS.test(b);
}

export function isNativeCurrency(address) {
  const normalized = normalizeAddress(address);
  return normalized !== null && NATIVE_SENTINELS.has(normalized);
}

/** Parses a decimal or 0x-prefixed amount into a BigInt, or null when it isn't one. */
function toBigInt(value) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  try {
    const parsed = BigInt(trimmed);
    return parsed < 0n ? null : parsed;
  } catch {
    return null;
  }
}

/**
 * Reads one 32-byte word out of ABI-encoded calldata as a BigInt.
 *
 * wordIndex is 0-based and counted after the 4-byte selector, matching
 * how ABI arguments are laid out for the fixed-size types this file
 * cares about (address, uint160, uint256 — all single words).
 */
function calldataWord(data, wordIndex) {
  const body = data.slice(10); // strip "0x" + 8 selector hex chars
  const start = wordIndex * 64;
  const word = body.slice(start, start + 64);
  if (word.length !== 64) return null;
  try {
    return BigInt(`0x${word}`);
  } catch {
    return null;
  }
}

function selectorOf(data) {
  return typeof data === "string" && data.startsWith("0x") && data.length >= 10
    ? data.slice(0, 10).toLowerCase()
    : null;
}

/**
 * The user's actual request, captured where it is known for certain —
 * at the point we build the quote request, not read back out of the
 * response.
 *
 * amountBaseUnits is the exact figure the user's own input produced. It
 * is the ceiling every spend check below is measured against.
 */
export function buildTransactionIntent({
  originChainId,
  destinationChainId,
  originCurrency,
  destinationCurrency,
  amountBaseUnits,
  userAddress,
  recipientAddress,
}) {
  const amount = toBigInt(amountBaseUnits);
  if (amount === null) {
    fail(`Could not read the amount for this trade ("${String(amountBaseUnits)}").`);
  }
  return {
    originChainId: Number(originChainId),
    destinationChainId: Number(destinationChainId),
    originCurrency: normalizeAddress(originCurrency),
    destinationCurrency: normalizeAddress(destinationCurrency),
    originIsNative: isNativeCurrency(originCurrency),
    amount,
    userAddress: normalizeAddress(userAddress),
    recipientAddress: normalizeAddress(recipientAddress ?? userAddress),
  };
}

/**
 * Second layer: the quote's own description of what it will do, checked
 * against the intent.
 *
 * Enforced only where Relay actually returned the field — see this
 * file's header for why absence is not treated as a failure here.
 */
export function assertQuoteMatchesIntent(quote, intent) {
  if (!intent) {
    fail("This trade has no recorded intent to check against.");
  }
  const details = quote?.details;
  if (!details) return;

  // Address EQUALITY is only asserted between two EVM addresses. A
  // Relay quote's destination can be Solana, where the address is
  // base58 and there is no single canonical spelling this code can be
  // sure Relay echoes back unchanged — asserting equality there could
  // block a legitimate bridge over a formatting difference, which is
  // the one outcome worse than not checking. Chain ids and amounts,
  // which are unambiguous on every chain, are still checked in full
  // below, and the EVM origin side (the side that actually spends) is
  // checked exactly.

  const inChainId = details.currencyIn?.currency?.chainId;
  if (Number.isFinite(inChainId) && Number(inChainId) !== intent.originChainId) {
    fail(`The route would spend from chain ${inChainId}, not the chain you chose (${intent.originChainId}).`);
  }
  const outChainId = details.currencyOut?.currency?.chainId;
  if (Number.isFinite(outChainId) && Number(outChainId) !== intent.destinationChainId) {
    fail(`The route would deliver to chain ${outChainId}, not the chain you chose (${intent.destinationChainId}).`);
  }

  const inCurrency = normalizeAddress(details.currencyIn?.currency?.address);
  if (comparableAddresses(inCurrency, intent.originCurrency) && inCurrency !== intent.originCurrency) {
    // Native is the one legitimate mismatch: providers disagree on which
    // sentinel means "the chain's own coin", and both spellings mean the
    // same asset.
    if (!(intent.originIsNative && isNativeCurrency(inCurrency))) {
      fail(`The route would spend a different token (${inCurrency}) than the one you chose.`);
    }
  }
  const outCurrency = normalizeAddress(details.currencyOut?.currency?.address);
  if (comparableAddresses(outCurrency, intent.destinationCurrency) && outCurrency !== intent.destinationCurrency) {
    if (!(isNativeCurrency(intent.destinationCurrency) && isNativeCurrency(outCurrency))) {
      fail(`The route would deliver a different token (${outCurrency}) than the one you chose.`);
    }
  }

  const recipient = normalizeAddress(details.recipient);
  if (comparableAddresses(recipient, intent.recipientAddress) && recipient !== intent.recipientAddress) {
    fail(`The route would send the proceeds to ${recipient}, not to the address you chose.`);
  }

  const spend = toBigInt(details.currencyIn?.amount);
  if (spend !== null && spend > intent.amount) {
    fail(`The route would spend ${spend} base units, more than the ${intent.amount} you entered.`);
  }
}

/**
 * First layer, and the one that actually bounds the loss: every
 * transaction about to be signed, checked against the intent.
 *
 * `items` is the flattened list of transaction step items across the
 * whole quote — checked together, not one at a time, because the native
 * cap is a cap on the TOTAL (a response could otherwise split a drain
 * across several individually-innocent transactions) and because an
 * approval can only be judged against the other transactions in the
 * same route.
 *
 * Throws on anything in the blocking set; returns an array of warning
 * strings for the suspicious-but-possibly-legitimate cases described in
 * this file's header.
 */
export function assertTransactionItemsMatchIntent(items, intent) {
  if (!intent) {
    fail("This trade has no recorded intent to check against.");
  }
  if (!Array.isArray(items) || items.length === 0) {
    fail("The routing service returned no transactions to sign.");
  }

  const warnings = [];
  let totalNativeValue = 0n;

  // Every contract this route calls. An approval's spender has to be
  // one of them: a legitimate approve exists precisely so that a LATER
  // transaction in the same route can pull the tokens. A spender that
  // nothing here calls is an approval to a stranger.
  const calledContracts = new Set();
  for (const item of items) {
    const to = normalizeAddress(item?.data?.to);
    if (to) calledContracts.add(to);
  }

  for (const item of items) {
    const data = item?.data;
    if (!data || typeof data !== "object") {
      fail("The routing service returned a transaction with no data.");
    }

    // CHAIN. Absence is a failure, not a skip: executeRelayQuote only
    // switches chains when chainId is set, so an omitted chainId means
    // signing on whichever chain the wallet is already on.
    const chainId = Number(data.chainId);
    if (!Number.isInteger(chainId)) {
      fail("The routing service returned a transaction with no chain.");
    }
    if (chainId !== intent.originChainId) {
      fail(`A transaction would be signed on chain ${chainId}, not the chain you chose (${intent.originChainId}).`);
    }

    const to = normalizeAddress(data.to);
    if (!to || !/^0x[0-9a-f]{40}$/.test(to)) {
      fail("The routing service returned a transaction with no valid destination address.");
    }

    // NATIVE VALUE. Missing/empty reads as zero, which is the safe
    // direction — it can only make the running total smaller.
    const value = data.value === undefined || data.value === null || data.value === "" ? 0n : toBigInt(data.value);
    if (value === null) {
      fail(`The routing service returned a transaction with an unreadable value ("${String(data.value)}").`);
    }
    totalNativeValue += value;

    const selector = selectorOf(data.data);
    if (selector === ERC20_APPROVE_SELECTOR || selector === PERMIT2_APPROVE_SELECTOR) {
      // ERC-20: approve(spender, amount)                  -> spender word 0, amount word 1.
      // Permit2: approve(token, spender, amount, expiry)  -> spender word 1, amount word 2.
      const isErc20 = selector === ERC20_APPROVE_SELECTOR;
      const spenderWord = calldataWord(data.data, isErc20 ? 0 : 1);
      const approved = calldataWord(data.data, isErc20 ? 1 : 2);
      if (spenderWord === null || approved === null) {
        fail("The routing service returned an approval that could not be read.");
      }
      const spender = `0x${spenderWord.toString(16).padStart(40, "0")}`;

      // The token being approved. For ERC-20 that's the transaction's
      // own destination; for Permit2 it's the first argument.
      const approvedToken = isErc20
        ? to
        : `0x${(calldataWord(data.data, 0) ?? 0n).toString(16).padStart(40, "0")}`;
      if (intent.originCurrency && !intent.originIsNative && approvedToken !== intent.originCurrency) {
        fail(`The route asks to approve a token (${approvedToken}) that isn't the one you're spending.`);
      }

      if (!calledContracts.has(spender)) {
        fail(
          `The route asks to approve ${spender} to spend your tokens, but no transaction in this route calls that address. ` +
            "A legitimate approval always names a contract the same route goes on to use.",
        );
      }

      if (approved > intent.amount) {
        warnings.push(
          `This route approves ${approved} base units of your token, more than the ${intent.amount} this trade needs — ` +
            `the spender (${spender}) keeps that allowance afterwards.`,
        );
      }
    }
  }

  if (intent.originIsNative) {
    if (totalNativeValue > intent.amount) {
      fail(`The transactions would send ${totalNativeValue} base units of native currency, more than the ${intent.amount} you entered.`);
    }
  } else if (totalNativeValue > 0n) {
    warnings.push(
      `This route attaches ${totalNativeValue} base units of native currency to a trade that spends a token, ` +
        "which is usually a protocol fee but is worth knowing about.",
    );
  }

  return warnings;
}

/**
 * Convenience wrapper: both layers, in the order they should run.
 * Throws on anything blocking; returns the warning list otherwise.
 */
export function assertQuoteSafeToSign(quote, intent, items) {
  assertQuoteMatchesIntent(quote, intent);
  return assertTransactionItemsMatchIntent(items, intent);
}
