// src/fallbackFeeSweep.js
//
// Pure fee-sizing math for fallbackDex.js's own
// sweepFallbackFeeFromNativeBalance — split out for the same reason
// chainData.js's own header gives for existing separately from
// relaybridge.js: fallbackDex.js transitively imports wagmi.js, which
// reads import.meta.env.VITE_ALCHEMY_API_KEY (a Vite-only global) at
// module load time, so a plain Node script — scripts/verify-fallback-
// fee-sweep.mjs among them — cannot import fallbackDex.js at all,
// confirmed directly (`node -e "import('./src/fallbackDex.js')"`
// throws on that exact property read). This one function has no such
// dependency, so it lives here instead, and fallbackDex.js imports it
// back.

import { DEV_FEE_PCT, DEV_FEE_MAX_USD } from "./devFeeWallets.js";

// Dust floor — under this, the gas cost of a second, separate
// transaction would rival or exceed the fee itself, not worth sending.
// Same value mango-pro's own fallbackDex.ts uses for the identical gap
// (its sweepFallbackFeeFromNativeBalance).
export const MIN_FALLBACK_FEE_USD = 0.05;

// Flat, chain-agnostic gas headroom kept aside before any of the
// wallet's native balance is considered "spare" enough to skim a fee
// from — deliberately a plain USD amount rather than a per-chain table
// of native-unit constants (App.jsx's own GAS_RESERVE), so this never
// needs its own per-chain tuning and never risks drifting out of sync
// with that one. Doubled below for the same reason mango-pro's own
// port of this doubles its own reserve: this transfer is itself a
// second transaction after the swap, so it needs its own gas headroom
// kept aside too, never eating into what the user needs to transact
// with again. Deliberately generous — skipping the sweep costs Mango a
// few cents of fee revenue; sending it anyway and leaving the wallet
// unable to afford its next transaction costs the user far more.
export const NATIVE_RESERVE_USD = 3;

/**
 * Returns the amount of native currency to send (a plain number, in
 * whole native units — e.g. ETH, not wei), or 0 when nothing should be
 * sent. originAmountUsd/nativePriceUsd/freshBalanceNative are all
 * "unknown" (null/undefined/non-numeric) rather than merely absent
 * whenever the caller couldn't get a real number — never guessed, per
 * this file's own DEV_FEE_MAX_USD comment on the same rule elsewhere.
 */
export function computeFallbackFeeNativeAmount({ originAmountUsd, nativePriceUsd, freshBalanceNative }) {
  if (!(originAmountUsd > 0) || !(nativePriceUsd > 0) || typeof freshBalanceNative !== "number" || Number.isNaN(freshBalanceNative)) return 0;
  const targetFeeUsd = Math.min(originAmountUsd * DEV_FEE_PCT, DEV_FEE_MAX_USD);
  if (!(targetFeeUsd >= MIN_FALLBACK_FEE_USD)) return 0;

  const targetFeeNative = targetFeeUsd / nativePriceUsd;
  const reserveNative = (NATIVE_RESERVE_USD * 2) / nativePriceUsd;
  const feeToSend = Math.min(targetFeeNative, freshBalanceNative - reserveNative);
  return feeToSend > 0 ? feeToSend : 0;
}
