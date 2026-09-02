// src/fallbackDex.js
//
// Second-source same-chain swap execution — tried only when Relay
// itself has no route at all, even at 0% fee (see App.jsx's own
// BridgeModal execute-call comment on that retry). Requested directly
// ("add these provider... All if possible unless there is a
// problem"): 0x and 1inch both call Uniswap/PancakeSwap/Balancer/
// Curve/etc. directly in one on-chain transaction they build — real,
// additional liquidity Relay's own solver network might not have
// indexed yet, not a re-hosted version of the same routing. Custodial
// exchanges and cross-chain messaging protocols from that same request
// were left out on request — see api/v1/bridge/fallback-quote.js's own
// header for the full reasoning; this file only ever executes a
// same-chain EVM swap, the one case those don't cover.
//
// Quoting goes through this app's own backend proxy
// (api/v1/bridge/fallback-quote.js) — same real reason relaybridge.js's
// own postRelayQuote already routes through api/v1/bridge/relay-quote.js:
// a browser fetch() straight to api.1inch.dev/api.0x.org may not return
// a permissive CORS header for this app's own origin, and either way
// both providers need a real developer API key that must never ship
// inside this app's own client bundle.
//
// Execution signs through the user's CONNECTED wallet (wagmi), same as
// every other transaction this app sends — never this app's own key,
// there isn't one. Approve-then-swap for anything but the native asset
// (allowanceTarget from the quote — null for a native sell, no
// approval ever needed there), approving EXACTLY the amount this one
// swap needs rather than an unlimited allowance: this is a rare
// fallback path, not a repeated integration, so there's no UX case for
// leaving a standing approval on a router this app doesn't otherwise
// touch.

import { formatUnits } from "viem";
import { readContract, writeContract, sendTransaction, waitForTransactionReceipt } from "wagmi/actions";
import { config } from "./wagmi.js";
import { appFeeBps, DEV_FEE_WALLET } from "./devFeeWallets.js";
import { uniswapV3SupportsChain, quoteUniswapV3, executeUniswapV3Swap } from "./uniswapV3.js";
import { uniswapV4SupportsChain, quoteUniswapV4, executeUniswapV4Swap } from "./uniswapV4.js";
import { sushiswapV2SupportsChain, quoteSushiSwapV2, executeSushiSwapV2Swap } from "./sushiswapV2.js";
import { pancakeswapV3SupportsChain, quotePancakeSwapV3, executePancakeSwapV3Swap } from "./pancakeswapV3.js";

const FALLBACK_QUOTE_URL = "/api/v1/bridge/fallback-quote";

// Tried in this order — ported from mango-mobile's own fallbackDex.js
// per this repo's own SAS.md durable instruction ("every treatment
// applies to both repos"): uniswap-v4/uniswap-v3/sushiswap-v2 lead,
// same priority mobile settled on (Uniswap first, not just a
// Robinhood-only last resort — none of the three depend on a
// third-party API/key, so none can fail from an outage, rate limit, or
// a bad key the way the four aggregators below genuinely can, and
// they're the only providers here that support Robinhood Chain (4663)
// at all). v4 before v3 since most Robinhood Chain tokens now launch
// there (live-confirmed on mobile, 2026-08-31); sushiswap-v2 right
// after both, same no-key shape. pancakeswap-v3 right after that —
// Robinhood Chain ONLY (see pancakeswapV3.js's own header on why: the
// one chain with a confirmed, chain-specific Permit2 address), the
// fourth and last no-key provider. 1inch and 0x next, both verified
// against a real account/live docs and needing their own API key. okx
// after that — live-confirmed working for the exact real-world case
// this fallback chain exists for (a thin Base token Relay couldn't
// route) and aggregates the broadest set of underlying DEX sources of
// any provider here, but its own service fee (0.5% on the trade that
// live-confirmed it, per its own UI) runs higher than the others, so
// it's a later resort rather than the first one tried. kyberswap last
// since it needs no key but its exact shape is only verified against
// public docs, not a live account. Odos/ParaSwap are still NOT listed
// — see fallback-quote.js's own header for the real, specific reason
// each is still deliberately unwired.
export const FALLBACK_PROVIDERS = ["uniswap-v4", "uniswap-v3", "sushiswap-v2", "pancakeswap-v3", "1inch", "0x", "okx", "kyberswap"];

const ERC20_ALLOWANCE_ABI = [
  { type: "function", name: "allowance", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "approve", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "nonpayable" },
];

async function fetchFallbackQuote({ provider, chainId, sellToken, buyToken, sellAmount, takerAddress, originAmountUsd }) {
  // Same appFeeBps() every other quote path already uses (Relay's own,
  // via relaybridge.js) — the backend proxy doesn't compute the rate
  // itself, it only forwards whatever this client already decided (see
  // fallback-quote.js's own header). Sent as basis points, the same
  // unit Relay's own appFees already use — fallback-quote.js converts
  // to whatever unit each provider's own API actually expects.
  const feeBps = appFeeBps(originAmountUsd);
  const res = await fetch(FALLBACK_QUOTE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider, chainId, sellToken, buyToken, sellAmount, takerAddress, feeBps, feeWallet: DEV_FEE_WALLET }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json?.error || `${provider} fallback quote failed (${res.status}).`);
  }
  return json.data;
}

async function executeFallbackQuote({ chainId, account, sellTokenAddress, quote, onSwapHashKnown }) {
  if (quote.allowanceTarget) {
    const currentAllowance = await readContract(config, {
      address: sellTokenAddress,
      abi: ERC20_ALLOWANCE_ABI,
      functionName: "allowance",
      args: [account, quote.allowanceTarget],
      chainId,
    });
    const requiredAmount = BigInt(quote.sellAmount ?? 0n);
    if (currentAllowance < requiredAmount) {
      const approveHash = await writeContract(config, {
        address: sellTokenAddress,
        abi: ERC20_ALLOWANCE_ABI,
        functionName: "approve",
        args: [quote.allowanceTarget, requiredAmount],
        chainId,
      });
      await waitForTransactionReceipt(config, { hash: approveHash, chainId });
    }
  }

  const swapHash = await sendTransaction(config, {
    to: quote.to,
    data: quote.data,
    value: BigInt(quote.value ?? "0"),
    ...(quote.gas ? { gas: BigInt(quote.gas) } : {}),
    chainId,
  });
  // Real gap this closes: the caller previously only ever learned this
  // hash once waitForTransactionReceipt below had ALREADY resolved —
  // meaning if the tab closed, or the RPC was slow to see the receipt,
  // during that wait, the app had zero record anywhere that a real
  // swap transaction had already broadcast. Same category of fix as
  // App.jsx's own onPendingHash (BridgeModal) for the Relay path —
  // reports the hash the moment it's actually known, not just once
  // everything's confirmed.
  onSwapHashKnown?.(swapHash);
  await waitForTransactionReceipt(config, { hash: swapHash, chainId });
  return { hash: swapHash };
}

/**
 * Quote-only version of the same provider loop — real bug fix, live-
 * confirmed: App.jsx's own pre-confirm routeCheck preview only ever
 * tried a single normal-fee Relay quote, and disabled the Swap button
 * entirely the moment that one failed ("No route available for this
 * trade"), before the user could ever tap Confirm — meaning the WHOLE
 * fallback chain below (tryFallbackProviders, 0%-fee retry) was
 * unreachable from the actual UI regardless of whether a fallback
 * route genuinely existed. This lets that preview check the SAME real
 * providers without executing anything (no approve, no swap
 * transaction) — just whether any of them can actually quote this
 * pair — so the button only stays disabled when NO route exists
 * anywhere, not just when Relay's own normal-fee quote happens to fail
 * first.
 *
 * Returns the winning quote's own {provider, buyAmount}, not just a
 * boolean — real gap this closes, live-reported: the preview's own
 * "You receive" number stayed blank ("No price estimate yet") even
 * when this exact check found a real, working fallback route, because
 * the quote it found was being discarded right after confirming it
 * existed. buyAmount is real, provider-quoted data (raw base units in
 * the buy token's own decimals) — the caller formats it, never
 * fabricates it.
 */
// Real bug fix, live-reported: every no-key DEX branch below
// (uniswap-v4/uniswap-v3/sushiswap-v2/pancakeswap-v3) in BOTH this
// function and tryFallbackProviders used to return the FIRST provider
// that came back with ANY non-null quote — even a technically-real
// but functionally-worthless one from a stale/near-empty pool — and
// never tried the REMAINING providers, which might have the token's
// actual liquid pool. A custom Robinhood Chain token failing on every
// provider identically looked like "no route anywhere" when the real
// cause was Uniswap V4 finding a dead pool first and locking in that
// answer before V3/SushiSwap/PancakeSwap ever got a chance to run —
// the exact same "accept a technically-successful quote too early"
// bug this file's own generic-provider branch below was already fixed
// for, just one layer shallower. Shared here so both functions apply
// the same check the same way.
function quoteRoundsToZero(amountOut, buyDecimals) {
  if (buyDecimals === undefined || buyDecimals === null) return false;
  try {
    return Number(Number(formatUnits(amountOut, buyDecimals)).toFixed(4)) === 0;
  } catch {
    return false;
  }
}

// Real bug fix, live-reported: both checkFallbackRoute and
// tryFallbackProviders used to return the FIRST provider (in fixed
// FALLBACK_PROVIDERS order) whose quote merely passed the rounds-to-
// zero check — never comparing it against any of the OTHER providers,
// even when one of them had a dramatically better price. uniswap-v4
// finding ANY real (even thin, high-price-impact) hookless pool for a
// pair used to lock in that answer immediately, even when uniswap-v3/
// sushiswap-v2/pancakeswap-v3/1inch/0x/okx/kyberswap had the pair's
// actual deep liquidity — live-reported on a Robinhood Chain token
// (PONS) whose quoted rate was ~11x worse than its real, live market
// price shown on DexScreener. Quoting every eligible provider is cheap
// (reads/backend calls, no wallet interaction) and safe to run in
// parallel, so both functions now gather every provider's quote first
// and pick whichever gives the MOST output, not whichever answered
// first.
async function quoteAllProviders({ chainId, sellToken, buyToken, sellAmount, takerAddress, originAmountUsd, buyDecimals }) {
  const sellAmountBig = BigInt(sellAmount);

  const attempts = FALLBACK_PROVIDERS.map(async (provider) => {
    if (provider === "uniswap-v4") {
      if (!uniswapV4SupportsChain(chainId)) return null;
      const best = await quoteUniswapV4({ chainId, tokenIn: sellToken, tokenOut: buyToken, amountIn: sellAmountBig });
      if (!best || quoteRoundsToZero(best.amountOut, buyDecimals)) return null;
      return { provider, kind: "onchain", buyAmount: best.amountOut, execData: { poolKey: best.poolKey, zeroForOne: best.zeroForOne } };
    }
    if (provider === "uniswap-v3") {
      if (!uniswapV3SupportsChain(chainId)) return null;
      const best = await quoteUniswapV3({ chainId, tokenIn: sellToken, tokenOut: buyToken, amountIn: sellAmountBig });
      if (!best || quoteRoundsToZero(best.amountOut, buyDecimals)) return null;
      return { provider, kind: "onchain", buyAmount: best.amountOut, execData: { fee: best.fee } };
    }
    if (provider === "sushiswap-v2") {
      if (!sushiswapV2SupportsChain(chainId)) return null;
      const best = await quoteSushiSwapV2({ chainId, tokenIn: sellToken, tokenOut: buyToken, amountIn: sellAmountBig });
      if (!best || quoteRoundsToZero(best.amountOut, buyDecimals)) return null;
      return { provider, kind: "onchain", buyAmount: best.amountOut, execData: {} };
    }
    if (provider === "pancakeswap-v3") {
      if (!pancakeswapV3SupportsChain(chainId)) return null;
      const best = await quotePancakeSwapV3({ chainId, tokenIn: sellToken, tokenOut: buyToken, amountIn: sellAmountBig });
      if (!best || quoteRoundsToZero(best.amountOut, buyDecimals)) return null;
      return { provider, kind: "onchain", buyAmount: best.amountOut, execData: { fee: best.fee } };
    }
    const quote = await fetchFallbackQuote({ provider, chainId, sellToken, buyToken, sellAmount, takerAddress, originAmountUsd });
    const buyAmount = BigInt(quote.buyAmount ?? "0");
    if (quoteRoundsToZero(buyAmount, buyDecimals)) return null;
    return { provider, kind: "generic", buyAmount, quote };
  });

  const settled = await Promise.allSettled(attempts);
  const entries = [];
  const failures = [];
  settled.forEach((result, i) => {
    const provider = FALLBACK_PROVIDERS[i];
    if (result.status === "fulfilled" && result.value) {
      entries.push(result.value);
    } else if (result.status === "rejected") {
      failures.push(`${provider}: ${result.reason?.message ?? String(result.reason)}`);
    }
  });
  // Highest buyAmount first — FALLBACK_PROVIDERS' own priority order
  // only matters as a tiebreaker now (Array.prototype.sort is stable,
  // and entries were pushed in that order), not as the deciding factor.
  entries.sort((a, b) => (b.buyAmount > a.buyAmount ? 1 : b.buyAmount < a.buyAmount ? -1 : 0));
  return { entries, failures };
}

export async function checkFallbackRoute({ chainId, sellToken, buyToken, sellAmount, takerAddress, originAmountUsd, buyDecimals }) {
  const { entries } = await quoteAllProviders({ chainId, sellToken, buyToken, sellAmount, takerAddress, originAmountUsd, buyDecimals });
  if (entries.length === 0) return null;
  const winner = entries[0];
  return { provider: winner.provider, buyAmount: winner.buyAmount.toString() };
}

// 1% — same default tolerance the rest of this app applies elsewhere
// when nothing more specific is available. Protects a Uniswap/
// SushiSwap swap from landing far worse than quoted between the quote
// call and the swap call below, without being so tight a normal price
// move between those two calls fails it.
const UNISWAP_SLIPPAGE_BPS = 100n;

/**
 * Quotes every fallback provider (see quoteAllProviders above), then
 * executes against whichever gave the best price, falling through to
 * the next-best only if that execution itself fails. Throws an
 * aggregate error (every provider's own failure reason) only once all
 * of them have failed — the caller's own catch already has the
 * ORIGINAL Relay error to show instead, since this whole path only
 * ever runs after that one failed first.
 */
export async function tryFallbackProviders({ chainId, sellToken, buyToken, sellAmount, takerAddress, originAmountUsd, onSwapHashKnown, buyDecimals }) {
  const { entries, failures } = await quoteAllProviders({ chainId, sellToken, buyToken, sellAmount, takerAddress, originAmountUsd, buyDecimals });
  const sellAmountBig = BigInt(sellAmount);

  // Real bug fix, live-reported: uniswap-v4/uniswap-v3/sushiswap-v2/
  // pancakeswap-v3 each require their own on-chain approval before the
  // swap itself (v4 and pancakeswap-v3 even need two, via their own
  // separate Permit2 deployments). If the best-priced provider's quote
  // succeeded and we move into executing the swap, but that execution
  // then throws, the wallet approval very likely already went through —
  // falling through to the NEXT no-key DEX provider used to ask for yet
  // another approval on top of that, which is how one failed sell could
  // prompt the user to approve up to 6 times in a row. Once that's
  // happened, skip the remaining no-key DEX providers entirely and fall
  // straight through to the generic quote-provider aggregators (1inch/
  // 0x/okx/kyberswap), which are gated through their own backend
  // quote+execute flow and aren't part of this approval cascade.
  let noKeyDexApprovalSpent = false;

  for (const entry of entries) {
    if (entry.kind === "onchain" && noKeyDexApprovalSpent) continue;
    // Real bug fix, live-reported (screenshot): every executeXSwap
    // below broadcasts a REAL transaction before it can possibly throw
    // (the swap itself, not an approval step) — but a failure in the
    // receipt wait AFTER that used to be indistinguishable here from
    // "this provider's quote never got anywhere," so the loop moved on
    // to the NEXT provider and tried ANOTHER swap of the same
    // sellAmount against a wallet whose real balance/allowance had
    // already changed. That's exactly what produced the reported
    // screen: a real hash shown as "likely succeeded on-chain," right
    // next to a brand-new revert from a second, doomed attempt. Each
    // executeXSwap now tags err.broadcastHash when its own swap step
    // broadcast before failing; reportHash below catches the same
    // signal from executeFallbackQuote's onSwapHashKnown (which already
    // fires pre-receipt-wait). Either one means: stop, don't retry.
    let broadcastHashThisEntry = null;
    const reportHash = hash => {
      broadcastHashThisEntry = hash;
      onSwapHashKnown?.(hash);
    };
    try {
      if (entry.provider === "uniswap-v4") {
        const minAmountOut = entry.buyAmount - (entry.buyAmount * UNISWAP_SLIPPAGE_BPS) / 10000n;
        noKeyDexApprovalSpent = true;
        const result = await executeUniswapV4Swap({
          chainId,
          account: takerAddress,
          tokenIn: sellToken,
          tokenOut: buyToken,
          amountIn: sellAmountBig,
          poolKey: entry.execData.poolKey,
          zeroForOne: entry.execData.zeroForOne,
          minAmountOut,
        });
        reportHash(result.hash);
        // No inline fee collection — same as this provider having no
        // backend quote to carry a fee field on at all.
        return { provider: entry.provider, hash: result.hash, buyAmount: entry.buyAmount.toString(), feeCollectedInline: false };
      }
      if (entry.provider === "uniswap-v3") {
        const minAmountOut = entry.buyAmount - (entry.buyAmount * UNISWAP_SLIPPAGE_BPS) / 10000n;
        noKeyDexApprovalSpent = true;
        const result = await executeUniswapV3Swap({
          chainId,
          account: takerAddress,
          tokenIn: sellToken,
          tokenOut: buyToken,
          amountIn: sellAmountBig,
          fee: entry.execData.fee,
          minAmountOut,
        });
        reportHash(result.hash);
        return { provider: entry.provider, hash: result.hash, buyAmount: entry.buyAmount.toString(), feeCollectedInline: false };
      }
      if (entry.provider === "sushiswap-v2") {
        const minAmountOut = entry.buyAmount - (entry.buyAmount * UNISWAP_SLIPPAGE_BPS) / 10000n;
        noKeyDexApprovalSpent = true;
        const result = await executeSushiSwapV2Swap({
          chainId,
          account: takerAddress,
          tokenIn: sellToken,
          tokenOut: buyToken,
          amountIn: sellAmountBig,
          minAmountOut,
        });
        reportHash(result.hash);
        return { provider: entry.provider, hash: result.hash, buyAmount: entry.buyAmount.toString(), feeCollectedInline: false };
      }
      if (entry.provider === "pancakeswap-v3") {
        const minAmountOut = entry.buyAmount - (entry.buyAmount * UNISWAP_SLIPPAGE_BPS) / 10000n;
        noKeyDexApprovalSpent = true;
        const result = await executePancakeSwapV3Swap({
          chainId,
          account: takerAddress,
          tokenIn: sellToken,
          tokenOut: buyToken,
          amountIn: sellAmountBig,
          fee: entry.execData.fee,
          minAmountOut,
        });
        reportHash(result.hash);
        return { provider: entry.provider, hash: result.hash, buyAmount: entry.buyAmount.toString(), feeCollectedInline: false };
      }
      // Generic provider (1inch/0x/okx/kyberswap) — quote was already
      // fetched by quoteAllProviders above, re-executed against as-is.
      const result = await executeFallbackQuote({
        chainId,
        account: takerAddress,
        sellTokenAddress: sellToken,
        quote: { ...entry.quote, sellAmount },
        onSwapHashKnown: reportHash,
      });
      return { provider: entry.provider, hash: result.hash, buyAmount: entry.quote.buyAmount, feeCollectedInline: !!entry.quote.feeCollectedInline };
    } catch (err) {
      const broadcastHash = err?.broadcastHash || broadcastHashThisEntry;
      if (broadcastHash) {
        // A real transaction already broadcast for this entry — make
        // sure the caller has the hash (executeXSwap's own err.broadcastHash
        // path never called reportHash itself) and stop here instead of
        // risking a second swap against balance/allowance state this
        // failure may have already changed.
        if (!broadcastHashThisEntry) {
          onSwapHashKnown?.(broadcastHash);
        }
        const err2 = new Error(`${entry.provider} broadcast a real transaction (${broadcastHash}) that then failed to confirm: ${err?.message ?? String(err)}. Not retrying with another provider — check the transaction on-chain before trying again.`);
        err2.broadcastHash = broadcastHash;
        throw err2;
      }
      failures.push(`${entry.provider}: ${err?.message ?? String(err)}`);
    }
  }
  throw new Error(`No fallback route available. ${failures.join(" | ")}`);
}
