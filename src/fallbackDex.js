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

// Tried in this order — both real, both fully wired; anything else
// requested alongside these (Odos/KyberSwap/ParaSwap) is a stub on the
// backend only, not listed here, so this list only ever tries a
// provider that can actually return a real quote.
export const FALLBACK_PROVIDERS = ["1inch", "0x"];

const ERC20_ALLOWANCE_ABI = [
  { type: "function", name: "allowance", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "approve", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "nonpayable" },
];

async function fetchFallbackQuote({ provider, chainId, sellToken, buyToken, sellAmount, takerAddress, originAmountUsd }) {
  // Same appFeeBps() every other quote path already uses (Relay's own,
  // via relaybridge.js) — the backend proxy doesn't compute the rate
  // itself, it only forwards whatever this client already decided (see
  // fallback-quote.js's own header). bps -> percent: 1inch's `fee`
  // param is "in percent" (min 0, max 3), appFeeBps returns basis
  // points (1/100 of a percent).
  const feePct = Number(appFeeBps(originAmountUsd)) / 100;
  const res = await fetch(FALLBACK_QUOTE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider, chainId, sellToken, buyToken, sellAmount, takerAddress, feePct, feeWallet: DEV_FEE_WALLET }),
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
