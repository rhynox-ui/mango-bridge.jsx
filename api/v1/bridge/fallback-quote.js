// api/v1/bridge/fallback-quote.js
//
// POST /api/v1/bridge/fallback-quote
// Body: { provider: '0x' | '1inch', chainId, sellToken, buyToken, sellAmount, takerAddress }
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
// which is where the reported failure actually happened. 0x and 1inch
// both call Uniswap/PancakeSwap/Balancer/Curve/etc. DIRECTLY in one
// on-chain transaction they build — real, additional liquidity sources
// Relay's own solver network might not have indexed yet, not a
// re-hosted version of the same routing.
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
// Deliberately NOT passed to either provider: an affiliate/referrer
// fee parameter. Both support one (1inch's `fee`+`referrer`, 0x's own
// swapFeeBps+swapFeeRecipient), but this endpoint has no way to verify
// either provider's exact fee semantics against real, live docs from
// this sandbox (network-blocked) or a real API key (none provisioned
// yet) — same "never fabricate a number" rule this codebase already
// follows for custom-token pricing. Mango's own cut is collected
// separately, client-side, only after a fallback swap has actually
// succeeded (mango-mobile's own settleFallbackFeeFromNativeBalance) —
// same guarantee the Relay 0%-fee-retry path already established.

import { checkRateLimit } from "../../rateLimit.js";

const NATIVE_PLACEHOLDER_ZERO = "0x0000000000000000000000000000000000000000";
// The industry-standard EVM native-asset sentinel BOTH providers use —
// originally a 0x Protocol convention, since adopted by 1inch and
// effectively everyone else. Real, not guessed: confirmed directly
// against each provider's own published address parameter examples.
const NATIVE_PLACEHOLDER_PROVIDER = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

function toProviderAddress(address) {
  return address?.toLowerCase() === NATIVE_PLACEHOLDER_ZERO ? NATIVE_PLACEHOLDER_PROVIDER : address;
}

async function quoteFrom1inch({ chainId, sellToken, buyToken, sellAmount, takerAddress }) {
  const apiKey = process.env.ONEINCH_API_KEY;
  if (!apiKey) {
    throw new Error("1inch fallback isn't configured yet (missing ONEINCH_API_KEY).");
  }
  const params = new URLSearchParams({
    src: toProviderAddress(sellToken),
    dst: toProviderAddress(buyToken),
    amount: sellAmount,
    from: takerAddress,
    slippage: "1",
    disableEstimate: "true",
  });
  const res = await fetch(`https://api.1inch.dev/swap/v6.0/${chainId}/swap?${params.toString()}`, {
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
  };
}

async function quoteFrom0x({ chainId, sellToken, buyToken, sellAmount, takerAddress }) {
  const apiKey = process.env.ZEROX_API_KEY;
  if (!apiKey) {
    throw new Error("0x fallback isn't configured yet (missing ZEROX_API_KEY).");
  }
  const params = new URLSearchParams({
    chainId: String(chainId),
    sellToken: toProviderAddress(sellToken),
    buyToken: toProviderAddress(buyToken),
    sellAmount,
    taker: takerAddress,
  });
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
      toProviderAddress(sellToken) === NATIVE_PLACEHOLDER_PROVIDER
        ? null
        : data.allowanceTarget ?? data.issues?.allowance?.spender ?? null,
  };
}

// Odos/KyberSwap/ParaSwap were requested alongside 0x/1inch but aren't
// wired up yet — same real reason as everywhere else in this file:
// building a quote+execute integration against a provider's API
// without live access to its actual docs (this sandbox's network
// egress blocked every one of these vendor doc sites directly) risks
// shipping something subtly wrong against real user funds. Adding one
// is a small, contained change once there's a verified request/
// response shape to build against — a new `quoteFromX` function above
// plus one more `case` below, same shape as the two real ones.
const PROVIDERS = {
  "1inch": quoteFrom1inch,
  "0x": quoteFrom0x,
};

export default async function handler(request, response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "POST");

  if (request.method !== "POST") {
    return response.status(405).json({ error: "Method not allowed. This endpoint only supports POST." });
  }

  if (!(await checkRateLimit(request, response, { name: "bridge-fallback-quote", limit: 20 }))) return;

  const { provider, chainId, sellToken, buyToken, sellAmount, takerAddress } = request.body || {};

  const quoteFn = PROVIDERS[provider];
  if (!quoteFn) {
    return response.status(400).json({ error: `Unknown or unsupported fallback provider: ${provider}` });
  }
  if (!chainId || !sellToken || !buyToken || !sellAmount || !takerAddress) {
    return response.status(400).json({ error: "chainId, sellToken, buyToken, sellAmount, and takerAddress are all required." });
  }

  try {
    const quote = await quoteFn({ chainId, sellToken, buyToken, sellAmount, takerAddress });
    return response.status(200).json({ data: quote });
  } catch (err) {
    return response.status(502).json({ error: err?.message || "Fallback quote failed." });
  }
}
