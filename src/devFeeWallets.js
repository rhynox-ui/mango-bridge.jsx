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
export const DEV_FEE_PCT = 0.01;
