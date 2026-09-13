// src/devFeeWallets.js
//
// Single source of truth for Mango's protocol fee wallets and rate —
// previously declared independently in THREE places (relaybridge.js,
// cctp.js, and implicitly needed in relaySdkSolanaExecution.js), the
// exact kind of hand-duplicated constant this codebase's own
// conventions elsewhere (chainData.js's own header, for one) warn
// against: nothing enforced the three copies staying in sync, and a
// future change to one wallet address updating only one or two of them
// would silently fee some transfers to the old address forever.
//
// Deliberately its own tiny file rather than folded into chainData.js
// (which is about chain/currency data, not fee configuration) or into
// relaybridge.js (which relaySdkSolanaExecution.js needs to import
// from for DEV_FEE_WALLET, while relaybridge.js itself needs
// DEV_FEE_WALLET_SOLANA from relaySdkSolanaExecution.js — importing
// directly between those two files either direction would be a real
// circular import).

export const DEV_FEE_WALLET = "0xf07becc2401a646fff10d10b969ef18b03582e88";
export const DEV_FEE_WALLET_SOLANA = "CFqNwTuTkqkaVoNZmNE6q5TeV6CcNwGRns2NSEY72Fu2";
// Was 0.01 (1%), then 0.0025 (0.25%) to match where non-custodial DEX
// aggregators sit (Li.Fi/Socket/Matcha's 0.10-0.30% route-fee range,
// not MetaMask/Phantom's ~0.85% convenience-premium tier a wallet with
// their existing distribution can charge). Raised to 0.005 (0.5%)
// 2026-08-31 on request — still well under Phantom/MetaMask's own
// rate, and matches mango-mobile's own relayBridge.js DEV_FEE_PCT
// exactly (kept in sync deliberately across both repos — a fee that
// differs between the site and the app is the kind of inconsistency
// users notice fast).
export const DEV_FEE_PCT = 0.005;
// A flat DEV_FEE_PCT on a large trade turns into real money fast — a
// $50 cap keeps a $20k+ swap from paying a $50+ fee that would push a
// high-value user toward a native interface instead. Only ever applied
// when the caller actually knows originAmountUsd (a real, verified
// price for the asset being sent) — appFeeBps below falls back to the
// flat rate with no cap for anything unpriced, same "never fabricate a
// number" rule this codebase already follows for custom-token pricing.
export const DEV_FEE_MAX_USD = 50;

/**
 * The real bps value to send Relay (or any bps-shaped fee API) as this
 * request's fee — DEV_FEE_PCT normally, reduced only far enough that
 * the resulting DOLLAR fee never exceeds DEV_FEE_MAX_USD once
 * originAmountUsd is large enough to hit it. originAmountUsd is
 * optional and only ever a real price-derived estimate; omitting it
 * (or passing something non-positive) just returns the flat rate —
 * there is nothing to cap without a real number to cap against.
 */
export function appFeeBps(originAmountUsd) {
  const flatBps = Math.round(DEV_FEE_PCT * 10000);
  if (!(originAmountUsd > 0)) {
    return String(flatBps);
  }
  const flatFeeUsd = originAmountUsd * DEV_FEE_PCT;
  if (flatFeeUsd <= DEV_FEE_MAX_USD) {
    return String(flatBps);
  }
  const cappedBps = Math.round((DEV_FEE_MAX_USD / originAmountUsd) * 10000);
  return String(Math.max(1, Math.min(flatBps, cappedBps)));
}
