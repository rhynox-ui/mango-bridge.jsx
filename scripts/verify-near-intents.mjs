// scripts/verify-near-intents.mjs
//
// Tests for src/nearIntents.js — the Bridge tab's "Receive on NEAR"
// safety rules. The signature fixtures are real quotes signed by 1Click's
// STAGING manager key, copied from the official SDK's own test suite
// (defuse-protocol/one-click-sdk-typescript, ISC license), so a pass here
// means this port hashes exactly what 1Click signs. Payment-flow cases
// use quotes signed with a throwaway key so the real firewall runs.
//
// Run: node scripts/verify-near-intents.mjs

import { createRequire } from "node:module";
import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";
import {
  NEAR_FEE_ACCOUNT,
  NearQuoteError,
  NearSendRejectedError,
  NEAR_POLL_GRACE_MS,
  ONE_CLICK_MANAGER_PUB_KEY,
  applyStatus,
  assertQuoteSafeToFund,
  createLocalNearSwapStore,
  findOneClickAssetId,
  fundNearQuote,
  isUserNearAddress,
  nearAppFees,
  oneClickQuoteHash,
  shouldPollNearSwap,
  stableStringify,
  verifyOneClickQuoteSignature,
} from "../src/nearIntents.js";

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
async function rejects(fn, type = NearQuoteError, m) {
  try {
    await fn();
  } catch (err) {
    if (err instanceof type) return;
    throw new Error(`${m ?? "wrong error"}: ${err?.message}`);
  }
  throw new Error(m ?? "expected a rejection");
}

// ---- real staging-signed fixtures (1Click SDK test suite)

const STAGING_KEY = "ed25519:5J5tkaxyPoR3Q9S8LXfo5bWnXK5Z2bctJ4mB9gENh7co";
const SDK_REQUEST = {
  dry: false, depositMode: "SIMPLE", swapType: "EXACT_INPUT", slippageTolerance: 100,
  originAsset: "1cs_v1:btc:native:coin", depositType: "ORIGIN_CHAIN",
  destinationAsset: "nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.stft.near",
  amount: "10000", refundTo: "bc1q6mte80265ghwq4vsrpm9lnaz46uvdreu9z8wly", refundType: "ORIGIN_CHAIN",
  recipient: "0xcac3C41676deF4FE375E57118f3eB83A99105577", recipientType: "DESTINATION_CHAIN",
  deadline: "2026-06-23T19:00:00.000Z", confidentiality: "public", quoteWaitingTimeMs: 0,
  appFees: [{ recipient: "5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd", fee: 10 }],
};
const SDK_NON_DRY = {
  correlationId: "d4f1b110-46cc-4682-aa3f-44d81ffe4b80",
  timestamp: "2026-06-23T17:10:41.104Z",
  signature: "ed25519:53wcpim7FDNLbBHVezUpakthWq2TR9Lag3PwW3e8Cxmz4bFEodcc4rui5BiVHRRaHocYE9URVapzJD8JxLNDs8K9",
  quoteRequest: SDK_REQUEST,
  quote: {
    amountIn: "10000", amountInFormatted: "0.0001", amountInUsd: "6.237600000000", minAmountIn: "10000",
    amountOut: "5931560", amountOutFormatted: "5.93156", amountOutUsd: "5.925171709880", minAmountOut: "5872244",
    timeEstimate: 812, refundFee: "1900", withdrawFee: "300000",
    deadline: "2026-06-26T19:00:00.000Z", timeWhenInactive: "2026-06-26T19:00:00.000Z",
    depositAddress: "bc1q873cxltdc560dth6tpwqpehq9uvhxxcdgwnmnw",
  },
};
const SDK_DRY = {
  correlationId: "7d6d78f0-601f-4022-9735-854a22ed9dcb",
  timestamp: "2026-06-23T17:10:55.616Z",
  signature: "ed25519:3yVRcYGXRVj2YqrUng4Ne2yiWgh9YQfer46KW6sXiWzoyRHgsifwDp1HSZW7VLRTdKXoMgxJce22LQ9dcoihyfu5",
  quoteRequest: { ...SDK_REQUEST, dry: true },
  quote: {
    amountIn: "10000", amountInFormatted: "0.0001", amountInUsd: "6.237600000000", minAmountIn: "10000",
    amountOut: "5935024", amountOutFormatted: "5.935024", amountOutUsd: "5.928631979152", minAmountOut: "5875673",
    timeEstimate: 812, refundFee: "1900", withdrawFee: "300000",
  },
};

await check("stableStringify matches json-stable-stringify byte for byte", () => {
  const require = createRequire(import.meta.url);
  let lib;
  try {
    lib = require("json-stable-stringify");
  } catch {
    return; // not installed in this repo; the signature fixtures below cover it
  }
  for (const s of [SDK_NON_DRY, SDK_DRY, { b: [1, undefined, { z: null, a: "x" }], a: undefined }]) assert(stableStringify(s) === lib(s));
});

await check("real 1Click-signed quotes (dry, full, and as /v0/status returns them) verify", () => {
  assert(verifyOneClickQuoteSignature(SDK_NON_DRY, STAGING_KEY), "non-dry");
  assert(verifyOneClickQuoteSignature(SDK_DRY, STAGING_KEY), "dry");
  const fromStatus = { ...SDK_NON_DRY, quoteRequest: { ...SDK_REQUEST, quoteWaitingTimeMs: undefined, referral: null, virtualChainRecipient: null } };
  assert(verifyOneClickQuoteSignature(fromStatus, STAGING_KEY), "status shape");
});

await check("the pinned production key is the SDK's, and a staging signature fails against it", () => {
  assert(ONE_CLICK_MANAGER_PUB_KEY === "ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc");
  assert(!verifyOneClickQuoteSignature(SDK_NON_DRY));
});

await check("tampering with any signed field fails", () => {
  const tampered = [
    { ...SDK_NON_DRY, quote: { ...SDK_NON_DRY.quote, depositAddress: "bc1q0000000000000000000000000000000000000000" } },
    { ...SDK_NON_DRY, quoteRequest: { ...SDK_REQUEST, recipient: "0x000000000000000000000000000000000000dEaD" } },
    { ...SDK_NON_DRY, quoteRequest: { ...SDK_REQUEST, refundTo: "bc1qattacker" } },
    { ...SDK_NON_DRY, quote: { ...SDK_NON_DRY.quote, minAmountOut: "1" } },
    { ...SDK_NON_DRY, signature: "" },
    { ...SDK_NON_DRY, signature: "not-a-signature" },
  ];
  for (const t of tampered) assert(!verifyOneClickQuoteSignature(t, STAGING_KEY), JSON.stringify(t).slice(0, 80));
  // appFees are not signed — the firewall must compare them itself.
  assert(verifyOneClickQuoteSignature({ ...SDK_NON_DRY, quoteRequest: { ...SDK_REQUEST, appFees: [{ recipient: "attacker.near", fee: 500 }] } }, STAGING_KEY));
});

// ---- self-signed quotes for the payment rules

const secret = ed25519.utils.randomPrivateKey();
const KEY = `ed25519:${bs58.encode(ed25519.getPublicKey(secret))}`;
const sign = (r) => ({ ...r, signature: `ed25519:${bs58.encode(ed25519.sign(new TextEncoder().encode(oneClickQuoteHash(r)), secret))}` });
const T0 = Date.parse("2026-09-27T12:00:00.000Z");
const USER = "0x1111111111111111111111111111111111111111";
const DEPOSIT = "0x2222222222222222222222222222222222222222";
const FEES = nearAppFees(25.5);

function makeQuote({ amount = "25500000", deadline = "2026-09-27T13:00:00.000Z", recipient = "alice.near", fees = FEES } = {}) {
  return sign({
    timestamp: "2026-09-27T11:59:58.000Z",
    signature: "",
    quoteRequest: {
      dry: false, swapType: "EXACT_INPUT", slippageTolerance: 100,
      originAsset: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", depositType: "ORIGIN_CHAIN",
      destinationAsset: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
      amount, refundTo: USER, refundType: "ORIGIN_CHAIN", recipient, recipientType: "DESTINATION_CHAIN", deadline, appFees: fees,
    },
    quote: {
      depositAddress: DEPOSIT, amountIn: amount, amountInFormatted: "25.5", amountInUsd: "25.5", minAmountIn: amount,
      amountOut: "25300000", amountOutFormatted: "25.3", amountOutUsd: "25.3", minAmountOut: "25047000", deadline, timeEstimate: 30,
    },
  });
}
const expectedFor = (q) => ({
  originAsset: q.quoteRequest.originAsset, destinationAsset: q.quoteRequest.destinationAsset, amount: q.quoteRequest.amount,
  recipient: "alice.near", recipientType: "DESTINATION_CHAIN", refundTo: USER, maxSlippageBps: 100, appFees: FEES, managerPublicKey: KEY,
});
function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
}
const payArgs = (quote, store, extra = {}) => ({
  response: quote, expected: expectedFor(quote), fromChain: "base", fromSymbol: "USDC", fromAddress: USER, payAmount: "25.5",
  store, now: () => T0, send: async () => "0xdeposit", ...extra,
});

await check("fees: 0.5% to widekingdom6862.near, same $50 cap", () => {
  assert(NEAR_FEE_ACCOUNT === "widekingdom6862.near");
  assert(stableStringify(nearAppFees(100)) === stableStringify([{ recipient: "widekingdom6862.near", fee: 50 }]));
  assert(nearAppFees(20000)[0].fee === 25 && nearAppFees(100000)[0].fee === 5);
});

await check("user NEAR addresses: named or implicit only, never a pasted 0x address", () => {
  for (const good of ["alice.near", "sub.alice.near", "5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd", " alice.near "]) assert(isUserNearAddress(good), good);
  for (const bad of [USER, "Alice.near", "a", "bad..near", "", null, "0xf07becc2401a646fff10d10b969ef18b03582e88"]) assert(!isUserNearAddress(bad), String(bad));
});

await check("a genuine quote passes; every mismatch is refused", async () => {
  const q = makeQuote();
  assertQuoteSafeToFund(q, { ...expectedFor(q), now: T0 });
  const bad = [
    [q, { managerPublicKey: undefined }],
    [{ ...q, quote: { ...q.quote, depositAddress: "0x3333333333333333333333333333333333333333" } }, {}],
    [q, { amount: "1" }],
    [q, { recipient: "bob.near" }],
    [q, { refundTo: "0x000000000000000000000000000000000000dEaD" }],
    [q, { maxSlippageBps: 50 }],
    [makeQuote({ fees: [{ recipient: "attacker.near", fee: 50 }] }), {}],
    [makeQuote({ fees: [] }), {}],
    [q, { now: Date.parse(q.quote.deadline) - 60_000 }],
  ];
  for (const [resp, over] of bad) await rejects(() => assertQuoteSafeToFund(resp, { ...expectedFor(q), now: T0, ...over }));
});

await check("paying: quote saved before sending, exact amount, hash recorded", async () => {
  const store = createLocalNearSwapStore(memoryStorage());
  const q = makeQuote();
  const submitted = [];
  const rec = await fundNearQuote(payArgs(q, store, {
    send: async (to) => {
      const saved = store.get(DEPOSIT);
      assert(saved && saved.broadcastAttempted && saved.quoteResponse.signature === q.signature, "not saved before send");
      assert(to === DEPOSIT, to);
      return "0xdeposit";
    },
    submitDepositTx: async (h, a) => { submitted.push([h, a]); throw new Error("down"); },
  }));
  assert(rec.status === "PENDING_DEPOSIT" && rec.depositTxHash === "0xdeposit");
  assert(store.get(DEPOSIT).depositTxHash === "0xdeposit");
  assert(submitted.length === 1, "deposit tx not reported");
  await rejects(() => fundNearQuote(payArgs(q, store)), NearQuoteError, "paid twice");
});

await check("a failed send is kept, blocks retries, and is polled until past the deadline", async () => {
  const store = createLocalNearSwapStore(memoryStorage());
  const q = makeQuote();
  await rejects(() => fundNearQuote(payArgs(q, store, { send: async () => { throw new Error("user rejected"); } })), Error);
  const rec = store.get(DEPOSIT);
  assert(rec.status === "SEND_FAILED" && rec.broadcastAttempted, JSON.stringify(rec));
  await rejects(() => fundNearQuote(payArgs(q, store)), NearQuoteError, "retry allowed");
  const deadline = Date.parse(q.quote.deadline);
  assert(shouldPollNearSwap(rec, deadline + NEAR_POLL_GRACE_MS - 1) && !shouldPollNearSwap(rec, deadline + NEAR_POLL_GRACE_MS + 1));
});

await check("a wallet Reject is the one failure that allows a retry", async () => {
  const store = createLocalNearSwapStore(memoryStorage());
  const q = makeQuote();
  await rejects(() => fundNearQuote(payArgs(q, store, { send: async () => { throw new NearSendRejectedError("declined"); } })), NearSendRejectedError);
  const rec = store.get(DEPOSIT);
  assert(rec.status === "SEND_FAILED" && rec.broadcastAttempted === false, JSON.stringify(rec));
  assert(!shouldPollNearSwap(rec, T0), "polling a never-sent deposit");
  const paid = await fundNearQuote(payArgs(q, store));
  assert(paid.depositTxHash === "0xdeposit", "retry after reject failed");
});

await check("the deadline is re-checked right before sending", async () => {
  const store = createLocalNearSwapStore(memoryStorage());
  const q = makeQuote();
  const times = [T0, T0, T0, Date.parse(q.quote.deadline) - 60_000];
  let sent = false;
  await rejects(() => fundNearQuote(payArgs(q, store, { now: () => times.shift() ?? T0, send: async () => ((sent = true), "x") })));
  assert(!sent, "sent on a stale quote");
  assert(store.get(DEPOSIT).broadcastAttempted === false);
});

await check("status: success recorded, answers about a different quote ignored", async () => {
  const q = makeQuote();
  const rec = { depositAddress: DEPOSIT, quoteResponse: q, status: "PENDING_DEPOSIT", broadcastAttempted: true, depositTxHash: "0x1" };
  const done = applyStatus(rec, { status: "SUCCESS", quoteResponse: q, swapDetails: { amountOutFormatted: "25.31", destinationChainTxHashes: [{ hash: "nearTx" }] } }, T0);
  assert(done.status === "SUCCESS" && done.amountOutFormatted === "25.31" && done.destinationTxHashes[0] === "nearTx");
  assert(!shouldPollNearSwap(done, T0));
  await rejects(() => applyStatus(rec, { status: "REFUNDED", quoteResponse: makeQuote({ amount: "99000000" }) }));
});

await check("destination assets resolve only by exact chain + contract", () => {
  const tokens = [
    { assetId: "nep141:usdc", blockchain: "near", symbol: "USDC", contractAddress: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", decimals: 6 },
    { assetId: "nep141:usdc.e", blockchain: "near", symbol: "USDC", contractAddress: "a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.factory.bridge.near", decimals: 6 },
    { assetId: "nep141:eth", blockchain: "eth", symbol: "ETH", decimals: 18 },
  ];
  assert(findOneClickAssetId(tokens, "near", "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1")?.assetId === "nep141:usdc");
  assert(findOneClickAssetId(tokens, "eth", null, "ETH")?.assetId === "nep141:eth");
  assert(findOneClickAssetId(tokens, "near", "wrap.near") === null);
  assert(findOneClickAssetId(tokens, "base", null, "ETH") === null);
});

console.log(`${passed}/${passed + failures.length} checks passed`);
for (const f of failures) console.error(`  FAIL ${f}`);
if (failures.length > 0) process.exit(1);
