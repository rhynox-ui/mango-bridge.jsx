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

import { readContract, writeContract, sendTransaction, waitForTransactionReceipt } from "wagmi/actions";
import { config } from "./wagmi.js";
import { appFeeBps, DEV_FEE_WALLET } from "./devFeeWallets.js";

const FALLBACK_QUOTE_URL = "/api/v1/bridge/fallback-quote";

// Tried in this order — all three real, all fully wired; 1inch and 0x
// first since both are verified against a real account/live docs and
// need their own API key, kyberswap last since it needs no key but its
// exact shape is only verified against public docs, not a live
// account. Odos/ParaSwap are still NOT listed — see
// fallback-quote.js's own header for the real, specific reason each is
// still deliberately unwired.
export const FALLBACK_PROVIDERS = ["1inch", "0x", "kyberswap"];

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

async function executeFallbackQuote({ chainId, account, sellTokenAddress, quote }) {
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
 */
export async function hasFallbackRoute({ chainId, sellToken, buyToken, sellAmount, takerAddress, originAmountUsd }) {
  for (const provider of FALLBACK_PROVIDERS) {
    try {
      await fetchFallbackQuote({ provider, chainId, sellToken, buyToken, sellAmount, takerAddress, originAmountUsd });
      return true;
    } catch {
      // Try the next provider — same "no route from this one, not
      // necessarily no route at all" reasoning tryFallbackProviders
      // itself already uses.
    }
  }
  return false;
}

/**
 * Tries each fallback provider in FALLBACK_PROVIDERS order, returning
 * the first one that actually quotes AND executes successfully. Throws
 * an aggregate error (every provider's own failure reason) only once
 * all of them have failed — the caller's own catch already has the
 * ORIGINAL Relay error to show instead, since this whole path only
 * ever runs after that one failed first.
 */
export async function tryFallbackProviders({ chainId, sellToken, buyToken, sellAmount, takerAddress, originAmountUsd }) {
  const failures = [];
  for (const provider of FALLBACK_PROVIDERS) {
    try {
      const quote = await fetchFallbackQuote({ provider, chainId, sellToken, buyToken, sellAmount, takerAddress, originAmountUsd });
      const result = await executeFallbackQuote({
        chainId,
        account: takerAddress,
        sellTokenAddress: sellToken,
        quote: { ...quote, sellAmount },
      });
      return { provider, hash: result.hash, buyAmount: quote.buyAmount, feeCollectedInline: !!quote.feeCollectedInline };
    } catch (err) {
      failures.push(`${provider}: ${err?.message ?? String(err)}`);
    }
  }
  throw new Error(`No fallback route available. ${failures.join(" | ")}`);
}
