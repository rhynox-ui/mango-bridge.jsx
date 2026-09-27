// scripts/verify-near-proxy.mjs
//
// Regression tests for the NEAR Intents 1Click proxy (api/oneClickProxy.js
// behind api/v1/near/v0/*). Same concern as verify-fee-tampering.mjs: a
// public quote endpoint must not let a caller redirect or inflate
// Mango's fee — and 1Click's quote signature does NOT cover appFees, so
// nothing downstream would catch it. Also pins the request allowlist
// and that the partner JWT is attached server-side only.
//
// Run: node scripts/verify-near-proxy.mjs

import {
  MAX_ONE_CLICK_FEE_BPS,
  OneClickRequestError,
  forwardToOneClick,
  isNearIntentsAccountId,
  sanitizeDepositSubmit,
  sanitizeOneClickQuoteRequest,
} from "../api/oneClickProxy.js";

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
function assert(condition, message) {
  if (!condition) throw new Error(message ?? "assertion failed");
}
function rejects(fn, message) {
  try {
    fn();
  } catch (err) {
    if (err instanceof OneClickRequestError) return;
    throw err;
  }
  throw new Error(message ?? "expected OneClickRequestError");
}

const FEE_ACCOUNT = "5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd";
const USER = "0x1111111111111111111111111111111111111111";
const VALID = {
  dry: false,
  swapType: "EXACT_INPUT",
  slippageTolerance: 100,
  originAsset: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
  depositType: "ORIGIN_CHAIN",
  destinationAsset: "nep141:wrap.near",
  amount: "25500000",
  refundTo: USER,
  refundType: "ORIGIN_CHAIN",
  recipient: USER,
  recipientType: "INTENTS",
  deadline: "2026-09-27T13:00:00.000Z",
  appFees: [{ recipient: FEE_ACCOUNT, fee: 50 }],
};

await check("MAX_ONE_CLICK_FEE_BPS is the site-wide 0.5%", () => {
  assert(MAX_ONE_CLICK_FEE_BPS === 50, `got ${MAX_ONE_CLICK_FEE_BPS}`);
});

await check("a normal request passes through with the fee account pinned", () => {
  const clean = sanitizeOneClickQuoteRequest(VALID, FEE_ACCOUNT);
  assert(JSON.stringify(clean.appFees) === JSON.stringify([{ recipient: FEE_ACCOUNT, fee: 50 }]), JSON.stringify(clean.appFees));
  assert(clean.amount === "25500000" && clean.recipient === USER && clean.refundTo === USER, JSON.stringify(clean));
});

await check("an attacker-supplied fee recipient is always replaced", () => {
  const clean = sanitizeOneClickQuoteRequest({ ...VALID, appFees: [{ recipient: "attacker.near", fee: 50 }, { recipient: "second.near", fee: 400 }] }, FEE_ACCOUNT);
  assert(clean.appFees.length === 1 && clean.appFees[0].recipient === FEE_ACCOUNT, JSON.stringify(clean.appFees));
});

await check("the fee can never exceed 0.5%, whatever the caller sends", () => {
  for (const fee of [51, 500, 1e9, "9999", Infinity]) {
    const clean = sanitizeOneClickQuoteRequest({ ...VALID, appFees: [{ recipient: FEE_ACCOUNT, fee }] }, FEE_ACCOUNT);
    assert(clean.appFees[0].fee === 50, `${fee} -> ${clean.appFees[0].fee}`);
  }
});

await check("a lower fee (the $50 cap) is kept; zero means no fee entry", () => {
  assert(sanitizeOneClickQuoteRequest({ ...VALID, appFees: [{ recipient: FEE_ACCOUNT, fee: 25 }] }, FEE_ACCOUNT).appFees[0].fee === 25);
  assert(sanitizeOneClickQuoteRequest({ ...VALID, appFees: [{ recipient: FEE_ACCOUNT, fee: -5 }] }, FEE_ACCOUNT).appFees.length === 0);
  assert(sanitizeOneClickQuoteRequest({ ...VALID, appFees: [{ recipient: FEE_ACCOUNT, fee: 0 }] }, FEE_ACCOUNT).appFees.length === 0);
});

await check("with no fee account configured, nothing is quoted", () => {
  for (const account of [undefined, "", "Not A Valid Account"]) {
    rejects(() => sanitizeOneClickQuoteRequest(VALID, account), `accepted fee account ${account}`);
  }
});

await check("fields the apps never send are dropped (incl. customRecipientMsg)", () => {
  const clean = sanitizeOneClickQuoteRequest({ ...VALID, customRecipientMsg: "{}", referral: "x", virtualChainRecipient: USER, confidentiality: "advanced", insured: true }, FEE_ACCOUNT);
  for (const key of ["customRecipientMsg", "referral", "virtualChainRecipient", "confidentiality", "insured"]) {
    assert(!(key in clean), `${key} was forwarded`);
  }
});

await check("only EXACT_INPUT with origin-chain deposit and refund is accepted", () => {
  rejects(() => sanitizeOneClickQuoteRequest({ ...VALID, swapType: "FLEX_INPUT" }, FEE_ACCOUNT));
  rejects(() => sanitizeOneClickQuoteRequest({ ...VALID, depositType: "INTENTS" }, FEE_ACCOUNT));
  rejects(() => sanitizeOneClickQuoteRequest({ ...VALID, refundType: "INTENTS" }, FEE_ACCOUNT));
  rejects(() => sanitizeOneClickQuoteRequest({ ...VALID, recipientType: "CONFIDENTIAL_INTENTS" }, FEE_ACCOUNT));
});

await check("malformed amounts, slippage, deadlines and ids are rejected", () => {
  for (const amount of ["0", "1.5", "-1", "", "1e18", 100]) rejects(() => sanitizeOneClickQuoteRequest({ ...VALID, amount }, FEE_ACCOUNT), `amount ${amount}`);
  for (const slippageTolerance of [-1, 501, 1.5, "x"]) rejects(() => sanitizeOneClickQuoteRequest({ ...VALID, slippageTolerance }, FEE_ACCOUNT), `slippage ${slippageTolerance}`);
  for (const deadline of ["tomorrow", "2026-13-45T99:00:00Z", ""]) rejects(() => sanitizeOneClickQuoteRequest({ ...VALID, deadline }, FEE_ACCOUNT), `deadline ${deadline}`);
  rejects(() => sanitizeOneClickQuoteRequest({ ...VALID, recipient: "a b" }, FEE_ACCOUNT));
  rejects(() => sanitizeOneClickQuoteRequest(null, FEE_ACCOUNT));
});

await check("deposit submit forwards only txHash and depositAddress", () => {
  const clean = sanitizeDepositSubmit({ txHash: "0xabc", depositAddress: USER, extra: "x", nearSenderAccount: "a.near" });
  assert(JSON.stringify(clean) === JSON.stringify({ txHash: "0xabc", depositAddress: USER }), JSON.stringify(clean));
  rejects(() => sanitizeDepositSubmit({ txHash: "", depositAddress: USER }));
});

await check("NEAR account id shapes match mango-pro's", () => {
  for (const good of [FEE_ACCOUNT, "mango.near", "fees.mango-protocol.near", "0xf07becc2401a646fff10d10b969ef18b03582e88"]) assert(isNearIntentsAccountId(good), good);
  for (const bad of ["", "Mango.near", "bad..near", "x".repeat(65), null]) assert(!isNearIntentsAccountId(bad), String(bad));
});

function mockResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: null,
    status(code) { this.statusCode = code; return this; },
    setHeader(k, v) { this.headers[k] = v; },
    send(body) { this.body = body; return this; },
    json(body) { this.body = JSON.stringify(body); return this; },
  };
}

await check("the partner JWT is attached server-side, and upstream answers are relayed as-is", async () => {
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url, init });
    return new Response('{"status":"SUCCESS"}', { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    process.env.ONE_CLICK_JWT = "test-jwt";
    const res = mockResponse();
    await forwardToOneClick(res, "/v0/status?depositAddress=abc", { method: "GET" });
    assert(seen[0].url === "https://1click.chaindefuser.com/v0/status?depositAddress=abc", seen[0].url);
    assert(seen[0].init.headers.Authorization === "Bearer test-jwt", JSON.stringify(seen[0].init.headers));
    assert(res.statusCode === 200 && res.body === '{"status":"SUCCESS"}', `${res.statusCode} ${res.body}`);

    delete process.env.ONE_CLICK_JWT;
    await forwardToOneClick(mockResponse(), "/v0/tokens", { method: "GET" });
    assert(!("Authorization" in seen[1].init.headers), "sent an Authorization header with no JWT configured");
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.ONE_CLICK_JWT;
  }
});

await check("an unreachable upstream is a 502, not a crash", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("ECONNRESET"); };
  try {
    const res = mockResponse();
    await forwardToOneClick(res, "/v0/tokens", { method: "GET" });
    assert(res.statusCode === 502, String(res.statusCode));
  } finally {
    globalThis.fetch = realFetch;
  }
});

console.log(`${passed}/${passed + failures.length} checks passed`);
for (const f of failures) console.error(`  FAIL ${f}`);
if (failures.length > 0) process.exit(1);
