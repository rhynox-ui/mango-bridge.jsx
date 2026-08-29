import { getAccount, switchChain, sendTransaction, waitForTransactionReceipt } from "wagmi/actions";
import { config } from "./wagmi.js";
export { MAINNET_CHAIN_IDS, NATIVE_SYMBOL, TOKEN_ADDRESSES, currencyAddress, canRelayHandle, ASSET_ONCHAIN_DECIMALS } from "./chainData.js";
import { MAINNET_CHAIN_IDS, currencyAddress } from "./chainData.js";
import { DEV_FEE_WALLET, DEV_FEE_WALLET_SOLANA, DEV_FEE_PCT } from "./devFeeWallets.js";
export { DEV_FEE_WALLET, DEV_FEE_PCT };

// Real fix for a real problem the previous "send a standalone fee
// transfer, then quote/execute the transfer" design had:
// (1) a failed/reverted transfer could still have already collected
//     the fee, since that transfer landed BEFORE the real transfer even
//     started — sendRelayProtocolFee (removed) was awaited first, with
//     no way to reverse it if what followed then failed;
// (2) the user's requested amount had to be shrunk by 1% up front to
//     leave room for that separate fee transfer, so a MAX-balance
//     transfer could never actually move the user's full balance.
//
// Relay's own quote request accepts an `appFees` array — confirmed
// directly against @relayprotocol/relay-sdk's own shipped type
// definitions (node_modules/@relayprotocol/relay-sdk/_types/src/types/api.d.ts):
// "App fees to be charged for execution in basis points, e.g. 100 = 1%".
// Attaching it here means the fee is deducted by Relay's own solver as
// part of the SAME settlement the transfer itself is — atomically, only
// if the transfer actually succeeds, and the full requested amount goes
// into the quote with nothing carved out beforehand.
//
// Fee recipient depends on the quote's DESTINATION chain — an EVM
// destination pays DEV_FEE_WALLET, a Solana destination pays
// DEV_FEE_WALLET_SOLANA (an EVM address can't receive SOL) — matching
// how Relay's own appFees settle: out of what's actually delivered on
// the destination side, not what's deposited on the origin side.
function feeRecipientForChainId(chainId) {
  return chainId === MAINNET_CHAIN_IDS.solana ? DEV_FEE_WALLET_SOLANA : DEV_FEE_WALLET;
}

// Relay Protocol — confirmed independently across three sources: Relay's own
// docs, Robinhood's own bridging documentation (which recommends Relay
// directly), and live in OKX Wallet's bridge feature. Chosen specifically
// because it's non-custodial (a solver network, not a liquidity pool we'd
// have to trust operationally) and supports genuine any-asset, any-chain
// routing — including pairs with no canonical bridge, like BNB<->ETH or
// direct L2-to-L2 transfers.
//
// IMPORTANT — read this before trusting this module:
// This is a fundamentally different trust model than CCTP, the OP Stack
// bridge, or the Arbitrum bridge. Those move funds through immutable,
// audited contracts with no discretion. Relay works via solvers who front
// liquidity on the destination chain and get repaid on the source — you are
// trusting Relay's solver network to fulfill correctly, not just contract
// math. Relay's docs state failed steps auto-refund rather than getting
// stuck, which is a meaningful safety property, but it's still a different
// category of trust than the other three integrations in this app.
//
// This module has NOT been proven live yet — it's built directly against
// Relay's own documented request/response schema (verified from two
// independent sources agreeing on the exact same shape), but "correctly
// built" and "proven in production" are different things until it's
// actually run. Test with the smallest possible real amount first.
//
// Real bug fix: both URLs below used to point straight at api.relay.link
// and were called with a plain browser fetch() — Relay's API does not
// appear to send a permissive Access-Control-Allow-Origin on either
// response, so both calls were silently failing at the browser level
// from this site's own origin (this is very likely what "not proven
// live yet" above was actually hitting). mango-mobile's own equivalent
// code calls Relay directly too, and that's fine there — React Native
// has no browser CORS sandboxing. Routed through this app's own backend
// instead (api/v1/bridge/relay-quote.js / relay-status.js — thin
// passthrough proxies, same fix already shipped for relayChains.js's
// /chains call), which sidesteps it: server-to-server has no CORS
// concept.
const RELAY_QUOTE_URL = "/api/v1/bridge/relay-quote";
const RELAY_STATUS_URL = "/api/v1/bridge/relay-status";

// Real resilience gap this file didn't have: mango-mobile's own
// getRelayQuote already retries a quote request with backoff — this
// didn't. Retried status codes are exactly the ones that mean "try
// again later, this wasn't a request-shape problem" (rate limiting,
// transient server-side failures); anything else (400 bad request,
// etc.) is a real rejection and surfaces immediately, same distinction
// that file's own comment makes.
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
    if (res.ok || !RELAY_QUOTE_RETRYABLE_STATUS.has(res.status) || attempt === RELAY_QUOTE_MAX_ATTEMPTS - 1) {
      return res;
    }
    await new Promise((r) => setTimeout(r, RELAY_QUOTE_BACKOFF_MS * 2 ** attempt));
  }
  // Unreachable in practice (the loop always returns or throws), but
  // keeps this function's return type honest if RELAY_QUOTE_MAX_ATTEMPTS
  // is ever set to 0.
  throw lastNetworkError ?? new Error("Relay quote request failed without a response.");
}

/**
 * Fetches a Relay quote for moving `amountBaseUnits` of `fromAsset` on
 * `fromChainKey` into `toAsset` on `toChainKey`. Amount must already be in
 * base units (wei/smallest denomination) as a string, matching the asset's
 * actual decimals — this function does not do decimal conversion itself.
 *
 * originChainId/originCurrency/destinationChainId/destinationCurrency are
 * optional and additive — same pattern mango-mobile's own relayBridge.js
 * already uses: every existing call site that only passes
 * fromChainKey/toChainKey/fromAsset/toAsset resolves through
 * MAINNET_CHAIN_IDS/currencyAddress() exactly as before. They exist so a
 * chain chainData.js doesn't have verified data for (walletChains.js's
 * broader wallet-only chain list, wired into App.jsx's Bridge tab) can
 * still get a real quote: App.jsx resolves the chain id from
 * wagmi/chains' own chain objects and passes the universal native
 * placeholder address directly, rather than asking currencyAddress() to
 * resolve a chainKey it has no verified data for.
 */
export async function getRelayQuote({ fromChainKey, toChainKey, fromAsset, toAsset, amountBaseUnits, userAddress, recipientAddress, originChainId, originCurrency, destinationChainId, destinationCurrency }) {
  const resolvedDestinationChainId = destinationChainId ?? MAINNET_CHAIN_IDS[toChainKey];
  const body = {
    user: userAddress,
    // Real fix for a real gap: previously this always used userAddress as
    // the implicit recipient too, meaning a custom destination address
    // typed into the UI was silently ignored for every Relay-routed
    // transfer — funds always landed back in the connected wallet
    // regardless of what was entered. recipient is Relay's own documented
    // field for this exact case (their own product supports sending to a
    // different wallet, including a different chain type entirely, like
    // EVM-to-Solana). Falls back to userAddress when no override is
    // given, preserving the original behavior exactly for the common case.
    recipient: recipientAddress || userAddress,
    originChainId: originChainId ?? MAINNET_CHAIN_IDS[fromChainKey],
    destinationChainId: resolvedDestinationChainId,
    originCurrency: originCurrency ?? currencyAddress(fromChainKey, fromAsset),
    destinationCurrency: destinationCurrency ?? currencyAddress(toChainKey, toAsset),
    amount: amountBaseUnits,
    tradeType: "EXACT_INPUT",
    appFees: [{ recipient: feeRecipientForChainId(resolvedDestinationChainId), fee: String(Math.round(DEV_FEE_PCT * 10000)) }],
  };
  const res = await postRelayQuote(body);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Relay quote failed (${res.status}): ${text || res.statusText}`);
  }
  return res.json();
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

/**
 * Executes a quote obtained from getRelayQuote: signs and sends every
 * pending transaction step in order, on whichever chain each step requires,
 * then polls until Relay confirms the destination side is complete.
 */
export async function executeRelayQuote({ quote, onStep }) {
  onStep?.("build");
  let requestId = null;
  const txHashes = [];

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

// ASSET_ONCHAIN_DECIMALS now lives in chainData.js — re-exported at the top of this file.
