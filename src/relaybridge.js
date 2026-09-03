import { switchChain, sendTransaction, waitForTransactionReceipt } from "wagmi/actions";
import { config } from "./wagmi.js";
export { MAINNET_CHAIN_IDS, NATIVE_SYMBOL, TOKEN_ADDRESSES, currencyAddress, canRelayHandle, ASSET_ONCHAIN_DECIMALS, assetDecimalsForChain } from "./chainData.js";
import { MAINNET_CHAIN_IDS, currencyAddress } from "./chainData.js";
import { DEV_FEE_WALLET, DEV_FEE_PCT, appFeeBps } from "./devFeeWallets.js";
import { buildTransactionIntent, assertQuoteSafeToSign } from "./txIntentFirewall.js";
export { DEV_FEE_WALLET, DEV_FEE_PCT };

// The user's request, recorded at the moment we ask for a quote and
// carried on the quote object itself so that executeRelayQuote can
// check the response against it without every call site having to
// thread an extra argument through (and without a call site being able
// to forget to). A WeakMap rather than a property on the quote so
// nothing that serializes, logs or clones the quote can carry the
// intent with it — and so a quote object that did not come from
// getRelayQuote has no intent at all, which executeRelayQuote treats as
// a refusal rather than as permission.
const quoteIntents = new WeakMap();

function feeRecipientForChainId() {
  return DEV_FEE_WALLET;
}

const RELAY_QUOTE_URL = "/api/v1/bridge/relay-quote";
const RELAY_STATUS_URL = "/api/v1/bridge/relay-status";
const RELAY_QUOTE_RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const RELAY_QUOTE_MAX_ATTEMPTS = 4;
const RELAY_QUOTE_BACKOFF_MS = 500;

async function postRelayQuote(body) {
  let lastNetworkError = null;
  for (let attempt = 0; attempt < RELAY_QUOTE_MAX_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await fetch(RELAY_QUOTE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      lastNetworkError = err;
      if (attempt === RELAY_QUOTE_MAX_ATTEMPTS - 1) throw err;
      await new Promise((r) => setTimeout(r, RELAY_QUOTE_BACKOFF_MS * 2 ** attempt));
      continue;
    }
    if (res.ok || !RELAY_QUOTE_RETRYABLE_STATUS.has(res.status) || attempt === RELAY_QUOTE_MAX_ATTEMPTS - 1) return res;
    await new Promise((r) => setTimeout(r, RELAY_QUOTE_BACKOFF_MS * 2 ** attempt));
  }
  throw lastNetworkError ?? new Error("Relay quote request failed without a response.");
}

export async function getRelayQuote({ fromChainKey, toChainKey, fromAsset, toAsset, amountBaseUnits, userAddress, recipientAddress, originChainId, originCurrency, destinationChainId, destinationCurrency, originAmountUsd, feeBpsOverride }) {
  const resolvedDestinationChainId = destinationChainId ?? MAINNET_CHAIN_IDS[toChainKey];
  const body = {
    user: userAddress,
    recipient: recipientAddress || userAddress,
    originChainId: originChainId ?? MAINNET_CHAIN_IDS[fromChainKey],
    destinationChainId: resolvedDestinationChainId,
    originCurrency: originCurrency ?? currencyAddress(fromChainKey, fromAsset),
    destinationCurrency: destinationCurrency ?? currencyAddress(toChainKey, toAsset),
    amount: amountBaseUnits,
    tradeType: "EXACT_INPUT",
    appFees: [{ recipient: feeRecipientForChainId(), fee: feeBpsOverride ?? appFeeBps(originAmountUsd) }],
  };
  const res = await postRelayQuote(body);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Relay quote failed (${res.status}): ${text || res.statusText}`);
  }
  const quote = await res.json();
  // Built from `body` — what we asked for — never from the response.
  // Reading the intent back out of the answer would make the check
  // circular and worthless.
  if (quote && typeof quote === "object") {
    quoteIntents.set(
      quote,
      buildTransactionIntent({
        originChainId: body.originChainId,
        destinationChainId: body.destinationChainId,
        originCurrency: body.originCurrency,
        destinationCurrency: body.destinationCurrency,
        amountBaseUnits: body.amount,
        userAddress: body.user,
        recipientAddress: body.recipient,
      }),
    );
  }
  return quote;
}

async function pollRelayStatus(requestId, { intervalMs = 2000, timeoutMs = 10 * 60 * 1000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`${RELAY_STATUS_URL}?requestId=${requestId}`);
    if (res.ok) {
      const data = await res.json();
      if (data.status === "success") return data;
      if (data.status === "failure") throw new Error("Relay reported this transfer failed — check the requestId on relay.link for details.");
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("Timed out waiting for Relay to confirm completion. Your deposit transaction succeeded — check status manually using the requestId before retrying.");
}

export async function executeRelayQuote({ quote, onStep }) {
  onStep?.("build");
  let requestId = null;
  const txHashes = [];

  // Pre-sign intent check — the audit's P0 control. Everything the
  // wallet is about to sign is compared against what the user asked
  // for, all of it before the first signature rather than per-step, so
  // a quote whose LAST transaction is the hostile one is refused before
  // the first one is broadcast. See txIntentFirewall.js for exactly
  // what is and isn't provable here.
  const intent = quoteIntents.get(quote);
  const pendingItems = [];
  for (const step of quote.steps) {
    if (step.kind !== "transaction") {
      throw new Error(`Unsupported Relay step kind "${step.kind}" — only transaction steps are handled by this app.`);
    }
    for (const item of step.items) {
      if (item.status !== "complete") pendingItems.push(item);
    }
  }
  const intentWarnings = assertQuoteSafeToSign(quote, intent, pendingItems);
  for (const warning of intentWarnings) {
    // Not fatal by design (see txIntentFirewall.js's header on what
    // blocks versus what warns), but never silent either — this is the
    // record if one of these ever turns out to be a real attack rather
    // than a router quirk.
    console.warn(`[txIntentFirewall] ${warning}`);
  }

  for (const step of quote.steps) {
    if (step.kind !== "transaction") {
      throw new Error(`Unsupported Relay step kind "${step.kind}" — only transaction steps are handled by this app.`);
    }
    requestId = requestId || step.requestId;

    for (const item of step.items) {
      if (item.status === "complete") continue;
      const { to, data, value, chainId } = item.data;
      onStep?.("deposit");
      if (chainId) await switchChain(config, { chainId });
      const hash = await sendTransaction(config, {
        to,
        data,
        value: value ? BigInt(value) : 0n,
        chainId,
      });
      txHashes.push(hash);
      onStep?.({ key: "hash-known", txHash: hash });
      await waitForTransactionReceipt(config, { hash, chainId });
    }
  }

  onStep?.("fill");
  await pollRelayStatus(requestId);
  onStep?.("done");
  return { txHashes, requestId };
}

// Compatibility export for the existing App.jsx call site. This must not
// inspect or close the user's WSOL ATA: doing so could unwrap WSOL that was
// already in the wallet before the bridge. Native SOL is now requested from
// Relay directly using Solana's native currency identifier, so there is no
// post-bridge wallet mutation to perform here.
export async function unwrapWsolIfPresent() {
  return null;
}
