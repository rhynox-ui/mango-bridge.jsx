// src/pumpswap.js
//
// Direct PumpSwap integration — real fix for a live-reported, root-
// caused bug, not a speculative addition. A same-chain Solana trade of
// JIMOTHY (a real, graduated pump.fun token) failed on-chain with
// "Transfer: insufficient lamports 36723514, need 72323388" when
// routed through Relay's own SDK (which routes Solana same-chain swaps
// through Jupiter under the hood, per relaySdkSolanaExecution.js's own
// header). Real research (not assumed): JIMOTHY filled its pump.fun
// bonding curve and migrated to PumpSwap — pump.fun's own AMM,
// launched 2025 — where it now trades against SOL
// (dexscreener.com/solana/2eyx5shemkhnr7uije9iyugbc1k7cytgkkebzvyppump
// confirms this independently). Jupiter's own routing math for this
// specific, newer, non-standard AMM appears to badly mis-cost the
// trade — the "insufficient lamports" figure has nothing to do with
// real network fees (a few thousand lamports) or ATA rent (~0.002
// SOL); it's roughly the full USD value of the trade itself, meaning
// something in that route is trying to reserve SOL proportional to
// trade size, not actual overhead. Rather than keep routing through a
// path that mis-prices this pool, this trades against PumpSwap
// directly — the same real liquidity source, without Jupiter's
// route-construction in between.
//
// Every address/instruction/account-layout detail below came from
// PumpSwap's own official npm package (@pump-fun/pump-swap-sdk,
// v1.19.0 at verification time), pulled via `npm pack` and read from
// the installed source (same verification path every other DEX
// integration in this repo already documents):
//   - Program IDs (PUMP_AMM_PROGRAM_ID, PUMP_PROGRAM_ID,
//     PUMP_FEE_PROGRAM_ID) and every PDA seed (pool/global-config/
//     pool-authority/etc): src/sdk/pda.ts. PUMP_AMM_PROGRAM_ID
//     independently cross-checked against Solana Tracker's own public
//     PumpSwap docs (docs.solanatracker.io/guides/pumpfun-amm) —
//     identical.
//   - buy/sell instruction account lists and args (base_amount_in,
//     min_quote_amount_out, etc): src/idl/pump_amm.json, the program's
//     own real IDL.
//   - Constant-product quote math (reserves, LP/protocol/creator
//     fees, slippage): src/sdk/buy.ts and src/sdk/sell.ts's own
//     buyQuoteInput/sellBaseInput pure functions.
//   - Full instruction assembly (WSOL wrap/unwrap, ATA creation,
//     every PDA account) — genuinely non-trivial (20 accounts,
//     several PDAs) and NOT hand-derived here, unlike this repo's EVM
//     integrations: PumpAmmSdk's own sellBaseInput/buyQuoteInput
//     methods (src/sdk/offlinePumpAmm.ts) build the complete,
//     ready-to-sign instruction list directly. Reusing the SDK's own
//     verified assembly for this one is a deliberately different,
//     safer choice than re-deriving 20 accounts by hand the way this
//     repo's uniswapV4.js does for its own action-list encoding —
//     that repo-wide pattern exists because the EVM SDKs used
//     elsewhere don't expose an equivalent "just build the whole
//     instruction for me" method; PumpSwap's own SDK does, so this
//     uses it rather than re-implementing what's already correct.
//
// Deliberately scoped to the CANONICAL pool only (index 0, quote =
// native SOL via the WSOL mint) — every graduated pump.fun token's
// pool. A creator-configured custom-quote pool (a different token
// entirely as the quote side) is a real but much rarer shape this
// doesn't cover; extend canonicalPumpPoolPda's own poolPda call the
// same way once that's a real, confirmed need, rather than guessing
// at a quote mint. Also does not cover a PRE-graduation bonding-curve
// token (a different program, PUMP_PROGRAM_ID, with its own separate
// buy/sell mechanism) — only PumpSwap, the post-graduation AMM.

import { PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import BN from "bn.js";
import {
  canonicalPumpPoolPda,
  OnlinePumpAmmSdk,
  PUMP_AMM_SDK,
  sellBaseInput as sellBaseInputMath,
  buyQuoteInput as buyQuoteInputMath,
} from "@pump-fun/pump-swap-sdk";

// 1% — same default tolerance this repo's own Uniswap/SushiSwap
// integrations apply when nothing more specific is available.
const DEFAULT_SLIPPAGE_PCT = 1;

/**
 * Returns the canonical PumpSwap pool address for a token mint if one
 * actually exists on-chain, or null if this token has no PumpSwap
 * pool (never graduated, or isn't a pump.fun token at all). The PDA
 * itself derives with zero network calls — only confirming it's a
 * real, initialized account needs one.
 */
export async function pumpSwapPoolForMint(connection, mintAddress) {
  try {
    const mint = new PublicKey(mintAddress);
    const poolKey = canonicalPumpPoolPda(mint);
    const info = await connection.getAccountInfo(poolKey);
    return info ? poolKey : null;
  } catch {
    return null;
  }
}

async function loadSwapState(connection, poolKey, userAddress) {
  const onlineSdk = new OnlinePumpAmmSdk(connection);
  return onlineSdk.swapSolanaState(poolKey, new PublicKey(userAddress));
}

function commonMathFields(state) {
  return {
    baseReserve: state.poolBaseAmount,
    quoteReserve: state.poolQuoteAmount,
    virtualQuoteReserves: state.pool.virtualQuoteReserves,
    globalConfig: state.globalConfig,
    baseMintAccount: state.baseMintAccount,
    baseMint: state.baseMint,
    coinCreator: state.pool.coinCreator,
    creator: state.pool.creator,
    feeConfig: state.feeConfig,
  };
}

/**
 * Quotes selling `amountBaseUnits` of the token (raw base units, its
 * own on-chain decimals) for native SOL. Returns null when this token
 * has no PumpSwap pool at all — same "not this provider, try the next
 * one" contract every other fallback provider in this app follows.
 */
export async function quotePumpSwapSell({ connection, mintAddress, amountBaseUnits, userAddress }) {
  const poolKey = await pumpSwapPoolForMint(connection, mintAddress);
  if (!poolKey) return null;
  const state = await loadSwapState(connection, poolKey, userAddress);
  const { uiQuote } = sellBaseInputMath({ ...commonMathFields(state), base: new BN(amountBaseUnits.toString()), slippage: 0 });
  return { poolKey, amountOut: BigInt(uiQuote.toString()) };
}

/**
 * Quotes spending `quoteBaseUnits` of native SOL (lamports) to buy the
 * token. Returns null when this token has no PumpSwap pool.
 */
export async function quotePumpSwapBuy({ connection, mintAddress, quoteBaseUnits, userAddress }) {
  const poolKey = await pumpSwapPoolForMint(connection, mintAddress);
  if (!poolKey) return null;
  const state = await loadSwapState(connection, poolKey, userAddress);
  const { base } = buyQuoteInputMath({ ...commonMathFields(state), quote: new BN(quoteBaseUnits.toString()), slippage: 0 });
  return { poolKey, amountOut: BigInt(base.toString()) };
}

/**
 * Builds the real, ready-to-sign sell instructions (token -> native
 * SOL) — WSOL wrap/unwrap and every PDA account handled by PumpSwap's
 * own SDK (see this file's own header on why that's reused rather
 * than hand-derived).
 */
export async function buildPumpSwapSellInstructions({ connection, mintAddress, amountBaseUnits, userAddress, slippagePct = DEFAULT_SLIPPAGE_PCT }) {
  const poolKey = await pumpSwapPoolForMint(connection, mintAddress);
  if (!poolKey) {
    throw new Error("This token has no PumpSwap pool.");
  }
  const state = await loadSwapState(connection, poolKey, userAddress);
  return PUMP_AMM_SDK.sellBaseInput(state, new BN(amountBaseUnits.toString()), slippagePct);
}

/**
 * Builds the real, ready-to-sign buy instructions (native SOL ->
 * token).
 */
export async function buildPumpSwapBuyInstructions({ connection, mintAddress, quoteBaseUnits, userAddress, slippagePct = DEFAULT_SLIPPAGE_PCT }) {
  const poolKey = await pumpSwapPoolForMint(connection, mintAddress);
  if (!poolKey) {
    throw new Error("This token has no PumpSwap pool.");
  }
  const state = await loadSwapState(connection, poolKey, userAddress);
  return PUMP_AMM_SDK.buyQuoteInput(state, new BN(quoteBaseUnits.toString()), slippagePct);
}

/**
 * Full build-sign-send for a direct PumpSwap trade: `side: "sell"`
 * spends `amountBaseUnits` of the token for native SOL, `side: "buy"`
 * spends `amountBaseUnits` lamports of native SOL for the token.
 * `solanaProvider` is the connected wallet's own signer (same shape
 * this repo's relaySdkSolanaExecution.js already uses — has
 * signTransaction). Throws (never silently no-ops) when this mint has
 * no PumpSwap pool — the caller's own try/catch is what falls through
 * to the normal Relay/Jupiter path for that case, same "not this
 * provider, try the next one" contract this file's other exports use.
 */
export async function executePumpSwapTrade({ connection, solanaAddress, solanaProvider, mintAddress, side, amountBaseUnits, slippagePct = DEFAULT_SLIPPAGE_PCT }) {
  const instructions = side === "sell"
    ? await buildPumpSwapSellInstructions({ connection, mintAddress, amountBaseUnits, userAddress: solanaAddress, slippagePct })
    : await buildPumpSwapBuyInstructions({ connection, mintAddress, quoteBaseUnits: amountBaseUnits, userAddress: solanaAddress, slippagePct });

  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: new PublicKey(solanaAddress),
    instructions,
    recentBlockhash: blockhash,
  }).compileToV0Message();
  const transaction = new VersionedTransaction(message);

  // Same real fix as this repo's relaySdkSolanaExecution.js — simulate
  // before asking for a signature, so a doomed transaction (this
  // pool's own reserves genuinely too thin for this size, real
  // slippage exceeded, etc) never even reaches the wallet prompt.
  const sim = await connection.simulateTransaction(transaction, { commitment: "confirmed" });
  if (sim.value.err) {
    throw new Error(`PumpSwap simulation failed: ${JSON.stringify(sim.value.err)}`);
  }

  const signed = await solanaProvider.signTransaction(transaction, "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp");
  const signature = await connection.sendRawTransaction(signed.serialize());
  await connection.confirmTransaction(signature, "confirmed");
  return { signature };
}
