// src/nearIntents.js
//
// NEAR Intents (1Click) for the Bridge tab's "Receive on NEAR" option —
// the pure, testable half. Wallet execution lives in
// NearIntentsSection.jsx; this file has no wagmi or browser-only
// imports, so scripts/verify-near-intents.mjs runs it under plain Node.
//
// Same rules as mango-pro's src/core/oneClick.ts + oneClickDeposits.ts,
// ported to JS. Why each exists is documented there; in short:
//   - 1Click signs every quote. Its production key is pinned below, and a
//     quote whose deposit address, recipient, refund address or amounts
//     don't match that signature is never paid.
//   - The signed request must echo what the user asked for, the fee must
//     be exactly Mango's (appFees are NOT signed), no deposit memo, and
//     there must be real time left before the deposit deadline — after
//     it, 1Click says funds sent "may be lost".
//   - The signed quote is saved before paying (1Click asks integrators to
//     keep it for disputes), and one quote is never paid twice.
//
// Calls go through Mango's own proxy (mango-api Worker,
// /api/v1/near/v0/*), which pins the fee account server-side too.
//
// Fees: Mango's 0.5% (appFeeBps, same $50 cap as every other route) is
// paid by 1Click to NEAR_FEE_ACCOUNT. No 1Click partner JWT is used, so
// 1Click adds its own small fee on top; the user pays it, like gas.

import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha2";
import bs58 from "bs58";
import { appFeeBps } from "./devFeeWallets.js";

export const ONE_CLICK_MANAGER_PUB_KEY = "ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc";
export const NEAR_API_BASE = "/api/v1/near";
export const NEAR_FEE_ACCOUNT = "widekingdom6862.near";
export const NEAR_MIN_DEADLINE_MARGIN_MS = 10 * 60 * 1000;
// Asked of 1Click as the refund deadline; EVM deposits confirm in
// seconds to minutes, so an hour leaves plenty of room.
export const NEAR_QUOTE_DEADLINE_MS = 60 * 60 * 1000;
export const NEAR_POLL_GRACE_MS = 2 * 60 * 60 * 1000;
const ED25519_PREFIX = "ed25519:";

// 1Click's blockchain ids for the EVM chains this app can pay from.
// Robinhood Chain and HyperEVM are left out until their 1Click ids are
// confirmed; Arc and Stable aren't on 1Click.
export const NEAR_ORIGIN_BLOCKCHAIN = {
  ethereum: "eth",
  base: "base",
  arbitrum: "arb",
  bnb: "bsc",
  avalanche: "avax",
};

// What can be received on NEAR, matched in 1Click's live token list by
// exact contract id — never by symbol alone, since several bridged
// "USDC"s exist on NEAR.
export const NEAR_DESTINATION_ASSETS = [
  { symbol: "USDC", label: "USDC", contract: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", decimals: 6 },
  { symbol: "wNEAR", label: "wNEAR (wrapped NEAR)", contract: "wrap.near", decimals: 24 },
];

export class NearQuoteError extends Error {}

/**
 * Thrown by a send() when the wallet itself refused before broadcasting
 * (the user pressed Reject). The only failure that is provably "nothing
 * was sent" — every other one is treated as possibly broadcast.
 */
export class NearSendRejectedError extends Error {}

// ---------------------------------------------------------------------
// Accounts

const NEAR_NAMED = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

/** Any NEAR Intents account id: 64-hex implicit, lowercase 0x address, or named. */
export function isNearIntentsAccountId(value) {
  if (typeof value !== "string") return false;
  if (/^[0-9a-f]{64}$/.test(value) || /^0x[0-9a-f]{40}$/.test(value)) return true;
  return value.length >= 2 && value.length <= 64 && NEAR_NAMED.test(value);
}

/**
 * A NEAR address a user may receive at: a named account (alice.near) or a
 * 64-hex implicit account. A pasted 0x address is refused on purpose —
 * it is technically a NEAR account id too, but far more likely to be an
 * EVM address pasted into the wrong box.
 */
export function isUserNearAddress(value) {
  if (typeof value !== "string") return false;
  const v = value.trim();
  if (v.startsWith("0x")) return false;
  return isNearIntentsAccountId(v);
}

export function isImplicitNearAccount(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

// ---------------------------------------------------------------------
// Assets

/** 1Click asset id for a token by contract, or a native coin by symbol (contract null). Null when nothing matches exactly. */
export function findOneClickAssetId(tokens, blockchain, contract, nativeSymbol) {
  const match = (Array.isArray(tokens) ? tokens : []).find((t) => {
    if (t?.blockchain !== blockchain) return false;
    if (contract === null) return !t.contractAddress && t.symbol === nativeSymbol;
    return typeof t.contractAddress === "string" && t.contractAddress.toLowerCase() === String(contract).toLowerCase();
  });
  return match ?? null;
}

// ---------------------------------------------------------------------
// Quote signature — port of the 1Click SDK's quote-signature.ts

export function stableStringify(value) {
  if (value === undefined || typeof value === "function") return undefined;
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v) ?? "null").join(",")}]`;
  const parts = [];
  for (const key of Object.keys(value).sort()) {
    const encoded = stableStringify(value[key]);
    if (encoded !== undefined) parts.push(`${JSON.stringify(key)}:${encoded}`);
  }
  return `{${parts.join(",")}}`;
}

function signedQuoteRequest(r) {
  return {
    dry: r.dry,
    swapType: r.swapType,
    slippageTolerance: r.slippageTolerance,
    originAsset: r.originAsset,
    depositType: r.depositType,
    destinationAsset: r.destinationAsset,
    amount: r.amount,
    refundTo: r.refundTo,
    refundType: r.refundType,
    recipient: r.recipient,
    recipientType: r.recipientType,
    deadline: r.deadline,
    quoteWaitingTimeMs: r.quoteWaitingTimeMs ? r.quoteWaitingTimeMs : undefined,
    referral: r.referral ? r.referral : undefined,
    virtualChainRecipient: r.virtualChainRecipient ? r.virtualChainRecipient : undefined,
    virtualChainRefundRecipient: r.virtualChainRefundRecipient ? r.virtualChainRefundRecipient : undefined,
    customRecipientMsg: r.customRecipientMsg ? r.customRecipientMsg : undefined,
  };
}

function signedQuote(q, dry) {
  const amounts = {
    amountIn: q.amountIn,
    amountInFormatted: q.amountInFormatted,
    amountInUsd: q.amountInUsd,
    minAmountIn: q.minAmountIn,
    amountOut: q.amountOut,
    amountOutFormatted: q.amountOutFormatted,
    amountOutUsd: q.amountOutUsd,
    minAmountOut: q.minAmountOut,
  };
  if (dry) return amounts;
  return {
    ...amounts,
    depositAddress: q.depositAddress || undefined,
    depositMemo: q.depositMemo || undefined,
    deadline: q.deadline || undefined,
    timeWhenInactive: q.timeWhenInactive || undefined,
    timeEstimate: q.timeEstimate || undefined,
    refundFee: q.refundFee || undefined,
    withdrawFee: q.withdrawFee || undefined,
  };
}

export function oneClickQuoteHash(response) {
  const payload = { ...signedQuoteRequest(response.quoteRequest), ...signedQuote(response.quote, response.quoteRequest.dry), timestamp: response.timestamp };
  return bs58.encode(sha256(new TextEncoder().encode(stableStringify(payload) ?? "")));
}

function decodeEd25519(value) {
  return bs58.decode(value.startsWith(ED25519_PREFIX) ? value.slice(ED25519_PREFIX.length) : value);
}

export function verifyOneClickQuoteSignature(response, managerPublicKey = ONE_CLICK_MANAGER_PUB_KEY) {
  try {
    return ed25519.verify(decodeEd25519(response.signature), new TextEncoder().encode(oneClickQuoteHash(response)), decodeEd25519(managerPublicKey));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------
// Fees

export function nearAppFees(originAmountUsd, feeAccount = NEAR_FEE_ACCOUNT) {
  if (!isNearIntentsAccountId(feeAccount)) throw new NearQuoteError("NEAR routes aren't available yet.");
  return [{ recipient: feeAccount, fee: Number(appFeeBps(originAmountUsd)) }];
}

// ---------------------------------------------------------------------
// Pre-deposit firewall

function fail(message) {
  throw new NearQuoteError(`${message} Nothing was sent — get a fresh quote and try again.`);
}

function sameAddress(a, b) {
  const evm = /^0x[0-9a-fA-F]{40}$/;
  return evm.test(a) && evm.test(b) ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function toBigInt(value, field) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) fail(`The quote's ${field} isn't a valid amount.`);
  return BigInt(value);
}

export function assertDepositWindowOpen(quote, now = Date.now(), marginMs = NEAR_MIN_DEADLINE_MARGIN_MS) {
  const deadline = quote?.deadline ? Date.parse(quote.deadline) : NaN;
  if (!Number.isFinite(deadline)) fail("The quote has no deposit deadline.");
  if (deadline - now < marginMs) fail("This quote is too close to its deposit deadline to send safely.");
}

/** Throws NearQuoteError unless this quote is safe to pay. */
export function assertQuoteSafeToFund(response, expected) {
  if (!response?.quote || !response.quoteRequest) fail("The quote response was incomplete.");
  if (!verifyOneClickQuoteSignature(response, expected.managerPublicKey)) {
    fail("The quote's signature doesn't match NEAR Intents' signing key, so its deposit address can't be trusted.");
  }
  const r = response.quoteRequest;
  const q = response.quote;
  if (r.dry) fail("A preview-only quote has no deposit address.");
  if (r.swapType !== "EXACT_INPUT") fail("Unexpected swap type in the quote.");
  if (r.depositType !== "ORIGIN_CHAIN" || r.refundType !== "ORIGIN_CHAIN") fail("Unexpected deposit or refund type in the quote.");
  if (r.originAsset !== expected.originAsset || r.destinationAsset !== expected.destinationAsset) fail("The quote is for different assets than the ones you chose.");
  if (r.amount !== expected.amount) fail("The quote is for a different amount than you entered.");
  if (r.recipientType !== expected.recipientType || !sameAddress(r.recipient, expected.recipient)) fail("The quote would deliver to a different address than yours.");
  if (!sameAddress(r.refundTo, expected.refundTo)) fail("The quote would refund to a different address than yours.");
  if (!(r.slippageTolerance >= 0 && r.slippageTolerance <= expected.maxSlippageBps)) fail("The quote allows more slippage than you set.");
  if (r.customRecipientMsg) fail("The quote carries a custom recipient message this app never requests.");
  if (stableStringify(expected.appFees ?? []) !== stableStringify(r.appFees ?? [])) fail("The quote's fees don't match what this app requested.");
  if (!q.depositAddress) fail("The quote has no deposit address.");
  if (q.depositMemo) fail("This route needs a deposit memo, which this app does not support.");
  const amountIn = toBigInt(q.amountIn, "input amount");
  const amountOut = toBigInt(q.amountOut, "output amount");
  const minAmountOut = toBigInt(q.minAmountOut, "minimum output");
  if (amountIn !== BigInt(expected.amount)) fail("The quote would take a different amount than you entered.");
  if (minAmountOut <= 0n || amountOut < minAmountOut) fail("The quote's output amounts don't add up.");
  assertDepositWindowOpen(q, expected.now ?? Date.now(), expected.minDeadlineMarginMs ?? NEAR_MIN_DEADLINE_MARGIN_MS);
}

// ---------------------------------------------------------------------
// Paying a quote

export function isFinalStatus(status) {
  return status === "SUCCESS" || status === "REFUNDED" || status === "FAILED";
}

/**
 * Pays a quote: firewall, one-payment-per-address check, save the signed
 * quote, re-check the deadline, send exactly amountIn, record the hash,
 * tell 1Click. `send(depositAddress)` performs the wallet transfer and
 * resolves to the tx hash.
 */
export async function fundNearQuote({ response, expected, fromChain, fromSymbol, fromAddress, payAmount, send, store, submitDepositTx, now = Date.now }) {
  assertQuoteSafeToFund(response, { ...expected, now: now() });
  const depositAddress = response.quote.depositAddress;
  const existing = store.get(depositAddress);
  if (existing && (existing.broadcastAttempted || existing.depositTxHash)) {
    throw new NearQuoteError("A payment for this quote was already sent or attempted. Check its status instead of sending again.");
  }
  let record = {
    depositAddress,
    quoteResponse: response,
    fromChain,
    fromSymbol,
    fromAddress,
    payAmount,
    recipient: response.quoteRequest.recipient,
    depositTxHash: null,
    broadcastAttempted: false,
    status: "SENDING",
    createdAt: now(),
    updatedAt: now(),
  };
  store.put(record);
  try {
    assertDepositWindowOpen(response.quote, now());
  } catch (err) {
    store.put({ ...record, status: "SEND_FAILED", updatedAt: now(), lastError: err.message });
    throw err;
  }
  record = { ...record, broadcastAttempted: true, updatedAt: now() };
  store.put(record);
  let txHash;
  try {
    txHash = await send(depositAddress);
  } catch (err) {
    const rejected = err instanceof NearSendRejectedError;
    store.put({ ...record, broadcastAttempted: !rejected, status: "SEND_FAILED", updatedAt: now(), lastError: err?.shortMessage || err?.message || String(err) });
    throw err;
  }
  record = { ...record, depositTxHash: txHash, status: "PENDING_DEPOSIT", updatedAt: now() };
  store.put(record);
  if (submitDepositTx) await submitDepositTx(txHash, depositAddress).catch(() => {});
  return record;
}

export function shouldPollNearSwap(record, now = Date.now()) {
  if (["SENDING", "SEND_FAILED", "PENDING_DEPOSIT"].includes(record.status)) {
    if (!record.broadcastAttempted) return false;
    const deadline = Date.parse(record.quoteResponse?.quote?.deadline);
    return !Number.isFinite(deadline) || now < deadline + NEAR_POLL_GRACE_MS;
  }
  return !isFinalStatus(record.status);
}

/** Applies a /v0/status answer to a record; ignores answers about a different quote. */
export function applyStatus(record, status, now = Date.now()) {
  const sig = status?.quoteResponse?.signature;
  if (sig && sig !== record.quoteResponse.signature) throw new NearQuoteError("NEAR Intents returned status for a different quote than the one you paid.");
  const d = status?.swapDetails ?? {};
  return {
    ...record,
    status: status.status,
    updatedAt: now,
    lastError: undefined,
    amountOutFormatted: d.amountOutFormatted ?? record.amountOutFormatted,
    refundedAmountFormatted: d.refundedAmountFormatted ?? record.refundedAmountFormatted,
    refundReason: d.refundReason ?? record.refundReason,
    destinationTxHashes: d.destinationChainTxHashes?.map((t) => t.hash) ?? record.destinationTxHashes,
  };
}

// ---------------------------------------------------------------------
// Local store (per browser). Never drops an unfinished swap.

const STORE_KEY = "mango:near-swaps:v1";

export function createLocalNearSwapStore(storage = globalThis.localStorage) {
  const read = () => {
    try {
      const parsed = JSON.parse(storage?.getItem(STORE_KEY) || "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };
  return {
    list: read,
    get(depositAddress) {
      return read().find((r) => r.depositAddress === depositAddress) ?? null;
    },
    put(record) {
      const others = read().filter((r) => r.depositAddress !== record.depositAddress);
      const all = [record, ...others].sort((a, b) => b.createdAt - a.createdAt);
      const keep = [...all.filter((r) => shouldPollNearSwap(r)), ...all.filter((r) => !shouldPollNearSwap(r)).slice(0, 50)];
      // Throws if storage is unavailable, which stops the payment before
      // it is sent — the signed quote must be saved first.
      storage.setItem(STORE_KEY, JSON.stringify(keep));
    },
  };
}

// ---------------------------------------------------------------------
// HTTP (through Mango's proxy)

async function nearFetch(path, init = {}, base = NEAR_API_BASE) {
  const res = await fetch(`${base}${path}`, { ...init, headers: { Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}) } });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const msg = body?.message || body?.error;
    throw new Error(typeof msg === "string" && msg ? msg : `NEAR Intents request failed (${res.status}).`);
  }
  return body;
}

export const fetchNearTokens = () => nearFetch("/v0/tokens");
export const requestNearQuote = (request) => nearFetch("/v0/quote", { method: "POST", body: JSON.stringify(request) });
export const fetchNearStatus = (depositAddress) => nearFetch(`/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`);
export const submitNearDepositTx = (txHash, depositAddress) => nearFetch("/v0/deposit/submit", { method: "POST", body: JSON.stringify({ txHash, depositAddress }) });

// Named NEAR accounts must exist before anything is sent to them. Two
// independent public RPCs; implicit (64-hex) accounts always exist.
const NEAR_RPCS = ["https://rpc.mainnet.fastnear.com", "https://near.lava.build"];

/** true = exists, false = definitely doesn't, null = couldn't check. */
export async function nearAccountExists(accountId, rpcs = NEAR_RPCS) {
  if (isImplicitNearAccount(accountId)) return true;
  for (const url of rpcs) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "mango", method: "query", params: { request_type: "view_account", finality: "final", account_id: accountId } }),
      });
      const body = await res.json();
      if (body?.result) return true;
      const cause = body?.error?.cause?.name || body?.error?.data || "";
      if (/UNKNOWN_ACCOUNT|does not exist/i.test(JSON.stringify(cause))) return false;
    } catch {
      // try the next RPC
    }
  }
  return null;
}
