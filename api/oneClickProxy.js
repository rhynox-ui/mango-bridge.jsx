// api/oneClickProxy.js
//
// Shared plumbing for api/v1/near/v0/* — a server-side proxy for NEAR
// Intents' 1Click API (https://1click.chaindefuser.com). Routes mirror
// 1Click's own /v0 paths, so a client switches between calling 1Click
// directly and calling through here by changing only its base URL.
//
// WHY A PROXY. 1Click partner JWTs must never ship inside a browser
// bundle or a decompilable mobile APK; ONE_CLICK_JWT lives only in this
// server's env. Without a JWT, 1Click still answers (and adds its own
// fee on top), so the proxy works before one is issued.
//
// WHAT THE PROXY CANNOT DO: redirect funds. Every quote is signed by
// 1Click's manager key over the deposit address, recipient, refund
// address and amounts, and the clients verify that signature against a
// key pinned in their own code (mango-pro src/core/oneClick.ts). A
// compromised proxy can refuse service; it cannot make a user pay a
// deposit address 1Click didn't issue.
//
// WHAT IT ENFORCES. Like relay-quote.js, this is a public URL, so the
// request body is rebuilt from an allowlist rather than forwarded:
//   - appFees: recipient is ALWAYS NEAR_FEE_ACCOUNT, fee clamped to
//     DEV_FEE_PCT in bps. appFees are not covered by 1Click's signature,
//     so this is the only place a caller-supplied fee could be stopped.
//     With no NEAR_FEE_ACCOUNT configured, quoting is refused outright
//     rather than quoting without Mango's fee.
//   - Only the shape the apps use: EXACT_INPUT, deposit and refund on
//     the origin chain. customRecipientMsg (1Click: "funds will be
//     lost" if misused) and every other field are dropped.

import { DEV_FEE_PCT } from "../src/devFeeWallets.js";

export const ONE_CLICK_UPSTREAM = "https://1click.chaindefuser.com";
export const MAX_ONE_CLICK_FEE_BPS = Math.round(DEV_FEE_PCT * 10000);
const MAX_SLIPPAGE_BPS = 500;

export class OneClickRequestError extends Error {}

const NEAR_ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

/** Same account-id shapes as mango-pro's isNearIntentsAccountId. */
export function isNearIntentsAccountId(value) {
  if (typeof value !== "string") return false;
  if (/^[0-9a-f]{64}$/.test(value) || /^0x[0-9a-f]{40}$/.test(value)) return true;
  return value.length >= 2 && value.length <= 64 && NEAR_ACCOUNT.test(value);
}

// Asset ids ("nep141:...", "1cs_v1:btc:native:coin"), addresses on any
// chain 1Click serves, and tx hashes all fit this; anything else is not
// something the apps send.
const TOKENISH = /^[A-Za-z0-9:._\-]{1,256}$/;

function requireString(body, key, pattern = TOKENISH) {
  const value = body?.[key];
  if (typeof value !== "string" || !pattern.test(value)) throw new OneClickRequestError(`${key} is missing or malformed.`);
  return value;
}

/**
 * Rebuilds a /v0/quote body from an allowlist and pins the fee. Throws
 * OneClickRequestError for anything the apps would never send.
 */
export function sanitizeOneClickQuoteRequest(body, feeAccount) {
  if (!isNearIntentsAccountId(feeAccount)) throw new OneClickRequestError("NEAR routes aren't enabled yet.");
  if (!body || typeof body !== "object") throw new OneClickRequestError("A JSON body is required.");

  if (body.swapType !== "EXACT_INPUT") throw new OneClickRequestError("Only EXACT_INPUT quotes are supported.");
  if (body.depositType !== "ORIGIN_CHAIN" || body.refundType !== "ORIGIN_CHAIN") {
    throw new OneClickRequestError("Only origin-chain deposits and refunds are supported.");
  }
  if (body.recipientType !== "DESTINATION_CHAIN" && body.recipientType !== "INTENTS") {
    throw new OneClickRequestError("recipientType must be DESTINATION_CHAIN or INTENTS.");
  }
  const amount = requireString(body, "amount", /^[1-9]\d{0,77}$/);
  const slippage = Number(body.slippageTolerance);
  if (!Number.isInteger(slippage) || slippage < 0 || slippage > MAX_SLIPPAGE_BPS) {
    throw new OneClickRequestError(`slippageTolerance must be a whole number of bps between 0 and ${MAX_SLIPPAGE_BPS}.`);
  }
  const deadline = requireString(body, "deadline", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
  if (!Number.isFinite(Date.parse(deadline))) throw new OneClickRequestError("deadline is not a valid time.");

  // The app's fee rate, clamped. The recipient is never the caller's.
  const requestedFee = Array.isArray(body.appFees) ? Number(body.appFees[0]?.fee) : MAX_ONE_CLICK_FEE_BPS;
  const fee = Math.round(Math.max(0, Math.min(Number.isFinite(requestedFee) ? requestedFee : MAX_ONE_CLICK_FEE_BPS, MAX_ONE_CLICK_FEE_BPS)));

  const clean = {
    dry: body.dry === true,
    swapType: "EXACT_INPUT",
    slippageTolerance: slippage,
    originAsset: requireString(body, "originAsset"),
    depositType: "ORIGIN_CHAIN",
    destinationAsset: requireString(body, "destinationAsset"),
    amount,
    refundTo: requireString(body, "refundTo"),
    refundType: "ORIGIN_CHAIN",
    recipient: requireString(body, "recipient"),
    recipientType: body.recipientType,
    deadline,
    appFees: fee > 0 ? [{ recipient: feeAccount, fee }] : [],
  };
  if (Number.isInteger(body.quoteWaitingTimeMs) && body.quoteWaitingTimeMs >= 0 && body.quoteWaitingTimeMs <= 5000) {
    clean.quoteWaitingTimeMs = body.quoteWaitingTimeMs;
  }
  return clean;
}

export function sanitizeDepositSubmit(body) {
  return {
    txHash: requireString(body, "txHash"),
    depositAddress: requireString(body, "depositAddress"),
  };
}

export function isValidDepositAddress(value) {
  return typeof value === "string" && TOKENISH.test(value);
}

/** Forwards to 1Click with the JWT (if configured) and relays status + body as-is. */
export async function forwardToOneClick(response, path, init = {}) {
  const jwt = process.env.ONE_CLICK_JWT;
  try {
    const upstream = await fetch(`${ONE_CLICK_UPSTREAM}${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
      },
    });
    const text = await upstream.text();
    response.status(upstream.status);
    response.setHeader("Content-Type", upstream.headers.get("content-type") || "application/json");
    return response.send(text);
  } catch (err) {
    return response.status(502).json({ error: err?.message || "Could not reach NEAR Intents." });
  }
}
