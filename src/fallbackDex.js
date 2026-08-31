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
// after both, same no-key shape. 1inch and 0x next, both verified
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
export const FALLBACK_PROVIDERS = ["uniswap-v4", "uniswap-v3", "sushiswap-v2", "1inch", "0x", "okx", "kyberswap"];

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
export async function checkFallbackRoute({ chainId, sellToken, buyToken, sellAmount, takerAddress, originAmountUsd }) {
  for (const provider of FALLBACK_PROVIDERS) {
    try {
      if (provider === "uniswap-v4") {
        if (!uniswapV4SupportsChain(chainId)) continue;
        const best = await quoteUniswapV4({ chainId, tokenIn: sellToken, tokenOut: buyToken, amountIn: BigInt(sellAmount) });
        if (!best) continue;
        return { provider, buyAmount: best.amountOut.toString() };
      }
      if (provider === "uniswap-v3") {
        if (!uniswapV3SupportsChain(chainId)) continue;
        const best = await quoteUniswapV3({ chainId, tokenIn: sellToken, tokenOut: buyToken, amountIn: BigInt(sellAmount) });
        if (!best) continue;
        return { provider, buyAmount: best.amountOut.toString() };
      }
      if (provider === "sushiswap-v2") {
        if (!sushiswapV2SupportsChain(chainId)) continue;
        const best = await quoteSushiSwapV2({ chainId, tokenIn: sellToken, tokenOut: buyToken, amountIn: BigInt(sellAmount) });
        if (!best) continue;
        return { provider, buyAmount: best.amountOut.toString() };
      }
      const quote = await fetchFallbackQuote({ provider, chainId, sellToken, buyToken, sellAmount, takerAddress, originAmountUsd });
      return { provider, buyAmount: quote.buyAmount ?? null };
    } catch {
      // Try the next provider — same "no route from this one, not
      // necessarily no route at all" reasoning tryFallbackProviders
      // itself already uses.
    }
  }
  return null;
}

// 1% — same default tolerance the rest of this app applies elsewhere
// when nothing more specific is available. Protects a Uniswap/
// SushiSwap swap from landing far worse than quoted between the quote
// call and the swap call below, without being so tight a normal price
// move between those two calls fails it.
const UNISWAP_SLIPPAGE_BPS = 100n;

/**
 * Tries each fallback provider in FALLBACK_PROVIDERS order, returning
 * the first one that actually quotes AND executes successfully. Throws
 * an aggregate error (every provider's own failure reason) only once
 * all of them have failed — the caller's own catch already has the
 * ORIGINAL Relay error to show instead, since this whole path only
 * ever runs after that one failed first.
 */
export async function tryFallbackProviders({ chainId, sellToken, buyToken, sellAmount, takerAddress, originAmountUsd, onSwapHashKnown, buyDecimals }) {
  const failures = [];
  for (const provider of FALLBACK_PROVIDERS) {
    try {
      if (provider === "uniswap-v4") {
        if (!uniswapV4SupportsChain(chainId)) continue;
        const sellAmountBig = BigInt(sellAmount);
        const best = await quoteUniswapV4({ chainId, tokenIn: sellToken, tokenOut: buyToken, amountIn: sellAmountBig });
        if (!best) continue;
        const minAmountOut = best.amountOut - (best.amountOut * UNISWAP_SLIPPAGE_BPS) / 10000n;
        const result = await executeUniswapV4Swap({
          chainId,
          account: takerAddress,
          tokenIn: sellToken,
          tokenOut: buyToken,
          amountIn: sellAmountBig,
          poolKey: best.poolKey,
          zeroForOne: best.zeroForOne,
          minAmountOut,
        });
        onSwapHashKnown?.(result.hash);
        // No inline fee collection — same as this provider having no
        // backend quote to carry a fee field on at all.
        return { provider, hash: result.hash, buyAmount: best.amountOut.toString(), feeCollectedInline: false };
      }
      if (provider === "uniswap-v3") {
        if (!uniswapV3SupportsChain(chainId)) continue;
        const sellAmountBig = BigInt(sellAmount);
        const best = await quoteUniswapV3({ chainId, tokenIn: sellToken, tokenOut: buyToken, amountIn: sellAmountBig });
        if (!best) continue;
        const minAmountOut = best.amountOut - (best.amountOut * UNISWAP_SLIPPAGE_BPS) / 10000n;
        const result = await executeUniswapV3Swap({
          chainId,
          account: takerAddress,
          tokenIn: sellToken,
          tokenOut: buyToken,
          amountIn: sellAmountBig,
          fee: best.fee,
          minAmountOut,
        });
        onSwapHashKnown?.(result.hash);
        return { provider, hash: result.hash, buyAmount: best.amountOut.toString(), feeCollectedInline: false };
      }
      if (provider === "sushiswap-v2") {
        if (!sushiswapV2SupportsChain(chainId)) continue;
        const sellAmountBig = BigInt(sellAmount);
        const best = await quoteSushiSwapV2({ chainId, tokenIn: sellToken, tokenOut: buyToken, amountIn: sellAmountBig });
        if (!best) continue;
        const minAmountOut = best.amountOut - (best.amountOut * UNISWAP_SLIPPAGE_BPS) / 10000n;
        const result = await executeSushiSwapV2Swap({
          chainId,
          account: takerAddress,
          tokenIn: sellToken,
          tokenOut: buyToken,
          amountIn: sellAmountBig,
          minAmountOut,
        });
        onSwapHashKnown?.(result.hash);
        return { provider, hash: result.hash, buyAmount: best.amountOut.toString(), feeCollectedInline: false };
      }
      const quote = await fetchFallbackQuote({ provider, chainId, sellToken, buyToken, sellAmount, takerAddress, originAmountUsd });
      // Real bug fix, live-reported: a fallback provider quoting a
      // thin/mispriced pair can return a technically-valid quote whose
      // buyAmount rounds to zero — this used to execute unconditionally,
      // meaning a real transaction could send the user's tokens away
      // and return next to nothing, burning gas on a trade nobody would
      // knowingly confirm. Only checked when buyDecimals is actually
      // known (the caller's own onchainDecimalsForAsset can return
      // undefined for an asset it doesn't recognize) — same "don't
      // block on what we can't verify" rule this file already follows
      // elsewhere, not a reason to silently accept a real zero though.
      if (buyDecimals !== undefined && buyDecimals !== null) {
        try {
          const buyAmountHuman = Number(formatUnits(BigInt(quote.buyAmount ?? "0"), buyDecimals));
          if (Number(buyAmountHuman.toFixed(4)) === 0) {
            failures.push(`${provider}: quoted output rounds to zero at the current rate — skipped.`);
            continue;
          }
        } catch {
          // Unparseable buyAmount — fall through and let execution
          // itself be the real check, same as before this fix.
        }
      }
      const result = await executeFallbackQuote({
        chainId,
        account: takerAddress,
        sellTokenAddress: sellToken,
        quote: { ...quote, sellAmount },
        onSwapHashKnown,
      });
      return { provider, hash: result.hash, buyAmount: quote.buyAmount, feeCollectedInline: !!quote.feeCollectedInline };
    } catch (err) {
      failures.push(`${provider}: ${err?.message ?? String(err)}`);
    }
  }
  throw new Error(`No fallback route available. ${failures.join(" | ")}`);
}
