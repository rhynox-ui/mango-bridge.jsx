// api/v1/bridge/fallback-quote.js
//
// POST /api/v1/bridge/fallback-quote
// Body: { provider: 'okx' | '0x' | '1inch' | 'kyberswap', chainId, sellToken, buyToken, sellAmount, takerAddress, feeBps?, feeWallet? }
//
// Second-source same-chain swap quoting, tried only when Relay itself
// has no route at all (relaybridge.js's own getRelayQuote, even at 0%
// fee — see BridgeModal's execute call in App.jsx). Requested directly
// ("add these provider... All if possible unless there is a problem"):
// custodial exchanges (Changelly, ChangeNOW) and cross-chain messaging
// protocols (LayerZero, Wormhole, Stargate, Synapse, Celer, Connext,
// deBridge, Jupiter) were left out on request — the first conflicts
// with this app's own non-custodial-only design (see README's "Never
// in custody"), the second doesn't apply to same-chain Swap at all,
// which is where the reported failure actually happened. 0x, 1inch,
// and KyberSwap each call Uniswap/PancakeSwap/Balancer/Curve/etc.
// DIRECTLY in one on-chain transaction they build — real, additional
// liquidity sources Relay's own solver network might not have indexed
// yet, not a re-hosted version of the same routing.
//
// Server-side proxy for the SAME two real reasons relay-quote.js
// already documents: (1) a browser fetch() straight to api.1inch.dev/
// api.0x.org may not return a permissive CORS header for this app's
// own origin, and (2) — the reason this endpoint exists even for
// mobile, which has no CORS concept at all — both providers require a
// real developer API key in the request header, and that key must
// never ship inside a browser bundle or a decompilable mobile APK.
// ONEINCH_API_KEY/ZEROX_API_KEY live ONLY in this server's own env
// vars (see .env.example), never in client code either repo ships.
//
// Response is normalized to ONE shape regardless of which provider
// answered — { to, data, value, gas, buyAmount, allowanceTarget } —
// so neither client needs its own provider-specific parsing:
//   to/data/value/gas: the real, ready-to-sign EVM transaction fields
//     (both providers return exactly this shape already, just nested
//     differently — 1inch's own `tx` object, 0x's own `transaction`
//     object under its v2 API).
//   buyAmount: the quoted raw output amount, purely informational here
//     (neither client currently displays a fallback-provider preview,
//     this is for future use / debugging, not load-bearing).
//   allowanceTarget: the spender address the client must have already
//     approved (standard ERC-20 approve-then-swap — neither provider's
//     AllowanceHolder/router model skips this the way Relay's own
//     appFees-inclusive same-chain self-execution does), null when
//     selling the chain's native asset (no approval ever needed there).
//
// Both providers now collect Mango's own cut atomically inside the
// swap transaction itself, via each one's own real, documented
// partner-fee mechanism (verified against live docs, not guessed):
//   1inch Classic Swap — `fee` (percent, min 0 max 3) + `referrer`,
//     confirmed directly against the real account's own reference page.
//   0x Swap API v2 (allowance-holder/quote) — `swapFeeBps` (0-1000) +
//     `swapFeeRecipient` + `swapFeeToken` (must be the sell or buy
//     token address), confirmed against 0x's own published docs.
// feeBps/feeWallet below come from the SAME client-side appFeeBps()
// every other quote path already uses (see devFeeWallets.js), passed
// straight through here exactly like relay-quote.js already passes
// Relay's own appFees through — this endpoint doesn't compute the
// rate itself, it only forwards it (1inch's own param is a PERCENT,
// not bps, so quoteFrom1inch converts; 0x's is bps already, passed
// straight through). Both report back feeCollectedInline: true so
// callers know NOT to also run their own post-success fee sweep for
// that swap — see mango-mobile's own settleFallbackFeeFromNativeBalance.

import crypto from "node:crypto";
import { checkRateLimit } from "../../rateLimit.js";
import { DEV_FEE_WALLET, DEV_FEE_PCT } from "../../../src/devFeeWallets.js";
import { applyCors } from "../../cors.js";

// Real vulnerability, closed here: feeBps/feeWallet came straight from
// the request body and went unmodified into whichever provider's own
// partner-fee params (1inch's referrer, 0x's swapFeeRecipient, OKX's
// fromTokenReferrerWalletAddress, KyberSwap's feeReceiver) — this
// endpoint is a public URL with wildcard CORS, callable directly by
// anyone, not just this app's own client. A raw request (or a
// malicious clone of this site's frontend hitting this SAME real
// backend) could set feeWallet to an attacker's own address —
// redirecting Mango's rightful protocol fee — and/or inflate feeBps
// past what a real user should ever be charged. MAX_FEE_BPS mirrors
// relay-quote.js's own reasoning: DEV_FEE_PCT's flat rate is provably
// the true upper bound of anything devFeeWallets.js's own appFeeBps()
// could legitimately produce.
const MAX_FEE_BPS = Math.round(DEV_FEE_PCT * 10000);

const NATIVE_PLACEHOLDER_ZERO = "0x0000000000000000000000000000000000000000";
// The industry-standard EVM native-asset sentinel BOTH providers use —
// originally a 0x Protocol convention, since adopted by 1inch and
// effectively everyone else. Real, not guessed: confirmed directly
// against each provider's own published address parameter examples.
const NATIVE_PLACEHOLDER_PROVIDER = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

function toProviderAddress(address) {
  return address?.toLowerCase() === NATIVE_PLACEHOLDER_ZERO ? NATIVE_PLACEHOLDER_PROVIDER : address;
}

async function quoteFrom1inch({ chainId, sellToken, buyToken, sellAmount, takerAddress, feeBps, feeWallet }) {
  const apiKey = process.env.ONEINCH_API_KEY;
  if (!apiKey) {
    throw new Error("1inch fallback isn't configured yet (missing ONEINCH_API_KEY).");
  }
  // 1inch's own `fee` param is a PERCENT (min 0, max 3) — feeBps is
  // basis points (1/100 of a percent), same unit Relay's own appFees
  // already uses, so convert here rather than push the conversion onto
  // every caller.
  const feePct = feeBps ? Number(feeBps) / 100 : 0;
  const params = new URLSearchParams({
    src: toProviderAddress(sellToken),
    dst: toProviderAddress(buyToken),
    amount: sellAmount,
    from: takerAddress,
    // Required — "An EOA address that initiates the transaction."
    // Confirmed directly against the real Classic Swap reference page;
    // omitting it (this endpoint's original state) would 400 on every
    // real call. Same address as `from` for this app: there's no
    // separate relayer/router account initiating on the user's behalf.
    origin: takerAddress,
    slippage: "1",
    disableEstimate: "true",
  });
  // Partner fee — confirmed directly against the real Classic Swap
  // reference page ("Partner fee in percent. min: 0; max: 3"). Only
  // sent when the caller actually computed a positive rate; feeWallet
  // ("referrer") is required by 1inch whenever fee is set, so both or
  // neither.
  if (feePct > 0 && feeWallet) {
    params.set("fee", String(feePct));
    params.set("referrer", feeWallet);
  }
  // api.1inch.com, not api.1inch.dev, and v6.1, not v6.0 — both
  // confirmed directly against the real 1inch Business portal's own
  // Classic Swap reference page (GET https://api.1inch.com/swap/v6.1/{chain}/swap),
  // not a search snippet.
  const res = await fetch(`https://api.1inch.com/swap/v6.1/${chainId}/swap?${params.toString()}`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`1inch quote failed (${res.status}): ${text || res.statusText}`);
  }
  const data = await res.json();
  if (!data?.tx?.to || !data?.tx?.data) {
    throw new Error("1inch returned no executable transaction for this pair.");
  }
  return {
    to: data.tx.to,
    data: data.tx.data,
    value: data.tx.value ?? "0",
    gas: data.tx.gas ?? null,
    buyAmount: data.dstAmount ?? null,
    // 1inch's own router (data.tx.to) is the spender it expects an
    // allowance for — confirmed directly against its own swap-flow
    // docs, no separate allowance-target field in the /swap response.
    allowanceTarget: toProviderAddress(sellToken) === NATIVE_PLACEHOLDER_PROVIDER ? null : data.tx.to,
    // Tells the caller Mango's cut already rode along inside this same
    // transaction (1inch's own partner-fee mechanism) — a caller that
    // also runs its own post-success fee sweep must skip it here, or
    // the user gets billed twice for one swap.
    feeCollectedInline: feePct > 0 && !!feeWallet,
  };
}

async function quoteFrom0x({ chainId, sellToken, buyToken, sellAmount, takerAddress, feeBps, feeWallet }) {
  const apiKey = process.env.ZEROX_API_KEY;
  if (!apiKey) {
    throw new Error("0x fallback isn't configured yet (missing ZEROX_API_KEY).");
  }
  const sellTokenAddress = toProviderAddress(sellToken);
  const params = new URLSearchParams({
    chainId: String(chainId),
    sellToken: sellTokenAddress,
    buyToken: toProviderAddress(buyToken),
    sellAmount,
    taker: takerAddress,
  });
  // Partner fee — confirmed against 0x's own published Swap API v2
  // docs: swapFeeBps (0-1000, already the same basis-point unit
  // appFeeBps returns — no conversion needed, unlike 1inch's percent
  // param), swapFeeRecipient, and swapFeeToken (must be either the
  // sell or buy token address — using the sell side, consistent with
  // Relay's own appFees, which accrue "in the currency sent to the
  // solver"). All three or none.
  if (feeBps > 0 && feeWallet) {
    params.set("swapFeeBps", String(feeBps));
    params.set("swapFeeRecipient", feeWallet);
    params.set("swapFeeToken", sellTokenAddress);
  }
  // allowance-holder, not permit2: a standard single-signature
  // approve-then-swap flow (same shape as every other DEX this app
  // already interacts with), not 0x's newer double-signature Permit2
  // flow — see this file's own header for why that one was skipped.
  const res = await fetch(`https://api.0x.org/swap/allowance-holder/quote?${params.toString()}`, {
    headers: { "0x-api-key": apiKey, "0x-version": "v2", Accept: "application/json" },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`0x quote failed (${res.status}): ${text || res.statusText}`);
  }
  const data = await res.json();
  if (!data?.transaction?.to || !data?.transaction?.data) {
    throw new Error("0x returned no executable transaction for this pair.");
  }
  return {
    to: data.transaction.to,
    data: data.transaction.data,
    value: data.transaction.value ?? "0",
    gas: data.transaction.gas ?? null,
    buyAmount: data.buyAmount ?? null,
    allowanceTarget:
      sellTokenAddress === NATIVE_PLACEHOLDER_PROVIDER ? null : data.allowanceTarget ?? data.issues?.allowance?.spender ?? null,
    // Tells the caller Mango's cut already rode along inside this same
    // transaction (0x's own swapFeeBps mechanism) — a caller that also
    // runs its own post-success fee sweep must skip it here, or the
    // user gets billed twice for one swap.
    feeCollectedInline: feeBps > 0 && !!feeWallet,
  };
}

// KyberSwap Aggregator API — no API key needed for the free tier (just
// an X-Client-Id header identifying the caller), verified against
// KyberSwap's own current docs. Two-step like the others: GET /routes
// for a routeSummary, POST /route/build to turn it into a ready-to-sign
// transaction. Fee params (feeAmount/isInBps/chargeFeeBy/feeReceiver)
// go on the GET /routes request, which echoes them into
// routeSummary.extraFee — that same routeSummary is then passed
// straight through to /route/build unmodified, so the fee rides along
// automatically, same idea as 1inch/0x's own inline fee params.
//
// Only wired for chains independently confirmed in KyberSwap's own
// chain list (KYBERSWAP_CHAIN_SLUG below) — same "never fabricate a
// number" rule as everywhere else in this file: a wrong slug 404s
// instead of quietly routing to the wrong chain, so an unconfirmed
// chain throws a clear error instead of guessing one.
const KYBERSWAP_CHAIN_SLUG = {
  1: "ethereum",
  56: "bsc",
  137: "polygon",
  10: "optimism",
  42161: "arbitrum",
  43114: "avalanche",
  8453: "base",
  59144: "linea",
  // Real gap found during a broader same-chain-Swap audit ("buy works,
  // sell doesn't" across chains): this app already lists unichain/
  // hyperevm/plasma as source chains (chainData.js's own
  // MAINNET_CHAIN_IDS), but this allowlist never had them, so KyberSwap
  // — otherwise the widest-reaching provider needing no API key — was
  // silently skipped on all three, live-confirmed as an active gap
  // (KyberSwap's own current chain list + aggregator-api.kyberswap.com
  // routes-endpoint slugs, not guessed).
  130: "unichain",
  999: "hyperevm",
  9745: "plasma",
};

async function quoteFromKyberSwap({ chainId, sellToken, buyToken, sellAmount, takerAddress, feeBps, feeWallet }) {
  const chainSlug = KYBERSWAP_CHAIN_SLUG[Number(chainId)];
  if (!chainSlug) {
    throw new Error(`KyberSwap fallback doesn't support chain ${chainId} yet.`);
  }
  const clientId = "MangoProtocol";
  const sellTokenAddress = toProviderAddress(sellToken);
  const routeParams = new URLSearchParams({
    tokenIn: sellTokenAddress,
    tokenOut: toProviderAddress(buyToken),
    amountIn: sellAmount,
  });
  if (feeBps > 0 && feeWallet) {
    routeParams.set("feeAmount", String(feeBps));
    routeParams.set("isInBps", "true");
    routeParams.set("chargeFeeBy", "currency_in");
    routeParams.set("feeReceiver", feeWallet);
  }
  const routeRes = await fetch(`https://aggregator-api.kyberswap.com/${chainSlug}/api/v1/routes?${routeParams.toString()}`, {
    headers: { "X-Client-Id": clientId, Accept: "application/json" },
  });
  if (!routeRes.ok) {
    const text = await routeRes.text().catch(() => "");
    throw new Error(`KyberSwap route failed (${routeRes.status}): ${text || routeRes.statusText}`);
  }
  const routeData = await routeRes.json();
  const routeSummary = routeData?.data?.routeSummary;
  if (!routeSummary) {
    throw new Error("KyberSwap returned no route for this pair.");
  }
  const buildRes = await fetch(`https://aggregator-api.kyberswap.com/${chainSlug}/api/v1/route/build`, {
    method: "POST",
    headers: { "X-Client-Id": clientId, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      routeSummary,
      sender: takerAddress,
      recipient: takerAddress,
      // 1% — same convention as 1inch's own slippage: "1" elsewhere in
      // this file, expressed here in KyberSwap's own bps unit (100bps).
      slippageTolerance: 100,
      deadline: Math.floor(Date.now() / 1000) + 20 * 60,
    }),
  });
  if (!buildRes.ok) {
    const text = await buildRes.text().catch(() => "");
    throw new Error(`KyberSwap build failed (${buildRes.status}): ${text || buildRes.statusText}`);
  }
  const buildData = await buildRes.json();
  const built = buildData?.data;
  if (!built?.routerAddress || !built?.callData) {
    throw new Error("KyberSwap returned no executable transaction for this pair.");
  }
  return {
    to: built.routerAddress,
    data: built.callData,
    value: built.value ?? (sellTokenAddress === NATIVE_PLACEHOLDER_PROVIDER ? sellAmount : "0"),
    gas: built.gas ?? null,
    buyAmount: built.amountOut ?? routeSummary.amountOut ?? null,
    allowanceTarget: sellTokenAddress === NATIVE_PLACEHOLDER_PROVIDER ? null : built.routerAddress,
    feeCollectedInline: feeBps > 0 && !!feeWallet,
  };
}

// OKX DEX Aggregator — live-confirmed working for the exact real-world
// case this whole fallback chain exists for: the user successfully
// sold a thin, newly-launched Base token through OKX Wallet's own
// "Swap via OKX DEX" (screenshotted mid-session) on a pair Relay
// itself couldn't route. Endpoint shapes below are verified directly
// against OKX's own current Onchain OS docs (Get Quotes/Approve
// Transactions/Swap reference pages, not search snippets). One real
// structural difference from every other provider here: the request
// needs OKX's own HMAC-SHA256 signature (OK-ACCESS-KEY/SIGN/
// PASSPHRASE/TIMESTAMP headers, three credentials instead of one bare
// API key) — okxSignRequest below implements OKX's own long-standing,
// platform-wide signing convention (unchanged across their whole API
// surface for years, the same scheme their trading API uses), not
// independently re-verified against a dedicated auth page this session
// since their Swap API docs only showed masked example headers. A
// signature mismatch here fails loudly and safely (every call 401s
// cleanly) rather than silently misrouting funds, so this is a lower-
// risk unknown than the SHAPE mistakes elsewhere in this file (like
// 1inch's own endpoint version) would have been.
// Exported so fallback-supported-chains.js can sign its own read-only
// GET /supported/chain request with the exact same scheme, instead of
// re-deriving (and risking drifting from) this HMAC logic a second time.
export function okxSignRequest({ method, requestPath, timestamp, secretKey }) {
  const prehash = `${timestamp}${method}${requestPath}`;
  return crypto.createHmac("sha256", secretKey).update(prehash).digest("base64");
}

async function quoteFromOKX({ chainId, sellToken, buyToken, sellAmount, takerAddress, feeBps, feeWallet }) {
  const apiKey = process.env.OKX_API_KEY;
  const secretKey = process.env.OKX_SECRET_KEY;
  const passphrase = process.env.OKX_PASSPHRASE;
  if (!apiKey || !secretKey || !passphrase) {
    throw new Error("OKX fallback isn't configured yet (missing OKX_API_KEY/OKX_SECRET_KEY/OKX_PASSPHRASE).");
  }
  const sellTokenAddress = toProviderAddress(sellToken);
  const params = new URLSearchParams({
    // chainIndex is the same numeric chain id used everywhere else in
    // this file — confirmed directly against OKX's own docs (chainIndex=1
    // for Ethereum in their examples; a separate response example shows
    // chainIndex=130 for a Unichain-native token, matching Unichain's
    // real chain id).
    chainIndex: String(chainId),
    amount: sellAmount,
    fromTokenAddress: sellTokenAddress,
    toTokenAddress: toProviderAddress(buyToken),
    slippagePercent: "1",
    userWalletAddress: takerAddress,
    // Generates the approval calldata inline (signatureData below) —
    // confirmed against OKX's own Swap reference page: the APPROVAL
    // spender is a DIFFERENT contract from the swap router itself
    // (tx.to) for OKX specifically, unlike every other provider in
    // this file, where the router IS the approval spender. Missing
    // this would approve the wrong contract entirely.
    approveTransaction: "true",
    approveAmount: sellAmount,
  });
  if (feeBps > 0 && feeWallet) {
    // Partner fee — confirmed against OKX's own Swap reference page:
    // feePercent (percent, not bps — same conversion 1inch's own fee
    // param needs; max 3% on non-Solana chains, well above anything
    // appFeeBps ever produces) + fromTokenReferrerWalletAddress
    // (charged on the sell side, consistent with every other
    // provider's own fee placement in this file).
    params.set("feePercent", String(feeBps / 100));
    params.set("fromTokenReferrerWalletAddress", feeWallet);
  }
  const requestPath = `/api/v6/dex/aggregator/swap?${params.toString()}`;
  const timestamp = new Date().toISOString();
  const res = await fetch(`https://web3.okx.com${requestPath}`, {
    headers: {
      "OK-ACCESS-KEY": apiKey,
      "OK-ACCESS-SIGN": okxSignRequest({ method: "GET", requestPath, timestamp, secretKey }),
      "OK-ACCESS-PASSPHRASE": passphrase,
      "OK-ACCESS-TIMESTAMP": timestamp,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OKX quote failed (${res.status}): ${text || res.statusText}`);
  }
  const json = await res.json();
  if (json?.code !== "0") {
    throw new Error(`OKX quote failed: ${json?.msg || `code ${json?.code}`}`);
  }
  const result = json?.data?.[0];
  const tx = result?.tx;
  if (!tx?.to || !tx?.data) {
    throw new Error("OKX returned no executable transaction for this pair.");
  }
  let allowanceTarget = null;
  if (sellTokenAddress !== NATIVE_PLACEHOLDER_PROVIDER) {
    // signatureData is an array of JSON-encoded STRINGS (confirmed in
    // OKX's own response example), not objects — approveContract is
    // the real spender; tx.to is a fallback only if that's somehow
    // missing, never the primary source (see this function's own
    // comment above on why they differ).
    try {
      allowanceTarget = JSON.parse(tx.signatureData?.[0] ?? "{}").approveContract ?? tx.to;
    } catch {
      allowanceTarget = tx.to;
    }
  }
  return {
    to: tx.to,
    data: tx.data,
    value: tx.value ?? "0",
    // OKX's own docs note on this exact field: "estimated amount of
    // the gas limit, increase this value by 50%" — applied here rather
    // than left to the caller, since every other provider's own `gas`
    // field is already meant to be used as-is.
    gas: tx.gas ? String(Math.ceil(Number(tx.gas) * 1.5)) : null,
    buyAmount: tx.minReceiveAmount ?? result?.routerResult?.toTokenAmount ?? null,
    allowanceTarget,
    feeCollectedInline: feeBps > 0 && !!feeWallet,
  };
}

// Odos and ParaSwap were requested alongside 0x/1inch/KyberSwap but
// are deliberately still NOT wired — for real, specific reasons found
// once actually researched, not just "no live docs access":
//   Odos: its own docs say API v2 (the /sor/quote/v2 + /sor/assemble
//     shape originally researched for this) is being RETIRED — every
//     partner must migrate to v3, which also has a different fee model
//     (v3's free tier bakes in its own 3bps protocol fee on top of
//     whatever Mango's own fee would add). Building against v2 now
//     would ship something already scheduled to break; v3's exact
//     request/response shape hasn't been independently confirmed.
//   ParaSwap: rebranded to Velora in 2025 — new token (VLR), and a
//     genuinely different intents-based execution model ("Delta v2.5",
//     multiple agents competing for price execution) replacing the
//     simple REST quote-then-build flow this file's other providers
//     use. Whether apiv5.paraswap.io still serves the classic flow, or
//     what Velora's own current endpoint looks like, isn't confirmed.
// Both are a small, contained addition once each has a verified
// request/response shape to build against — same shape as the
// providers above.
const PROVIDERS = {
  okx: quoteFromOKX,
  "1inch": quoteFrom1inch,
  "0x": quoteFrom0x,
  kyberswap: quoteFromKyberSwap,
};

// The fee clamp, lifted out of the handler so scripts/verify-fee-
// tampering.mjs can prove it directly — a later security audit asked
// for exactly that by name. Same behaviour as before, plus Math.round:
// a fractional bps is not a unit any provider here accepts, and
// String(12.7) would previously have been forwarded verbatim.
export function sanitizeFeeParams({ feeBps, feeWallet }) {
  return {
    feeBps: feeBps ? String(Math.round(Math.max(0, Math.min(Number(feeBps) || 0, MAX_FEE_BPS)))) : feeBps,
    feeWallet: feeWallet ? DEV_FEE_WALLET : feeWallet,
  };
}

export default async function handler(request, response) {
  // Allowlisted rather than wildcard — see api/cors.js for what
  // that closes, what is deliberately left public, and why no
  // existing caller breaks. Also answers the preflight this
  // endpoint never had a handler for.
  if (applyCors(request, response, { methods: "POST" })) return;

  if (request.method !== "POST") {
    return response.status(405).json({ error: "Method not allowed. This endpoint only supports POST." });
  }

  if (!(await checkRateLimit(request, response, { name: "bridge-fallback-quote", limit: 20 }))) return;

  const { provider, chainId, sellToken, buyToken, sellAmount, takerAddress, feeBps, feeWallet } = request.body || {};

  const quoteFn = PROVIDERS[provider];
  if (!quoteFn) {
    return response.status(400).json({ error: `Unknown or unsupported fallback provider: ${provider}` });
  }
  if (!chainId || !sellToken || !buyToken || !sellAmount || !takerAddress) {
    return response.status(400).json({ error: "chainId, sellToken, buyToken, sellAmount, and takerAddress are all required." });
  }

  // feeBps/feeWallet are optional — both real providers now use them
  // (see each quoteFn's own comment for how each interprets feeBps).
  // Never trusted as-is: feeWallet is always overwritten to the real
  // DEV_FEE_WALLET, and feeBps is clamped to MAX_FEE_BPS — see this
  // file's own header above for why.
  const { feeBps: safeFeeBps, feeWallet: safeFeeWallet } = sanitizeFeeParams({ feeBps, feeWallet });

  try {
    const quote = await quoteFn({ chainId, sellToken, buyToken, sellAmount, takerAddress, feeBps: safeFeeBps, feeWallet: safeFeeWallet });
    return response.status(200).json({ data: quote });
  } catch (err) {
    return response.status(502).json({ error: err?.message || "Fallback quote failed." });
  }
}
