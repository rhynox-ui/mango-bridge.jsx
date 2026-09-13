// src/pumpfun.js
//
// Direct pump.fun BONDING CURVE integration — the pre-graduation
// mechanism, sitting alongside pumpswap.js's own post-graduation
// PumpSwap integration. Requested explicitly, with priority: most
// tokens traded on Solana through this app are pump.fun tokens, and
// most of THOSE haven't graduated to PumpSwap yet — a token still on
// the bonding curve has no PumpSwap pool at all (pumpswap.js's own
// pumpSwapPoolForMint correctly returns null for one), so closing this
// gap covers real volume pumpswap.js alone doesn't reach.
//
// Every address/instruction/state detail below came from pump.fun's
// own official npm package (@pump-fun/pump-sdk, v1.36.0 at
// verification time — the newer, unified package that itself depends
// on @pump-fun/pump-swap-sdk, confirming it's the current, maintained
// one), pulled via `npm pack` and read from the installed source (same
// verification path this app's other DEX integrations already
// document):
//   - Bonding-curve account fields (virtualTokenReserves,
//     virtualQuoteReserves, complete, creator, quoteMint): src/state.ts.
//   - Full instruction assembly (buyInstructions/sellInstructions —
//     every PDA account, fee recipient, creator vault): src/sdk.ts's
//     own PumpSdk class (PUMP_SDK singleton). Reused directly rather
//     than hand-derived, same reasoning as pumpswap.js's own header —
//     the SDK exposes a complete, correct builder.
//   - State fetching (fetchBuyState/fetchSellState/fetchGlobal):
//     src/onlineSdk.ts's own OnlinePumpSdk class.
//
// Real, disclosed gap: neither this file nor the installed SDK expose
// a standalone quote/pricing function — buyInstructions/sellInstructions
// take an ALREADY-computed amount+solAmount and apply the given
// slippage% themselves (confirmed directly from their own source:
// sellInstructions reduces solAmount by slippage%, buyInstruction
// increases it — so the caller supplies the expected value, not a
// pre-adjusted one). The quote math below is the standard, publicly
// documented pump.fun constant-product bonding-curve formula
// (virtualTokenReserves/virtualQuoteReserves), verified against the
// real field names above — it does NOT model the protocol/creator fee
// (no fee-computation helper is exposed the way pumpswap.js's
// sellBaseInput/buyQuoteInput math functions are), so this uses a
// wider default slippage than pumpswap.js's (5% vs 1%) specifically to
// absorb that unmodeled fee component. This only affects the DISPLAYED
// estimate and how much buffer the trade tolerates — fund safety
// itself is enforced by the on-chain program's own slippage check on
// the final instruction, not by how precise this estimate is.
//
// Deliberately scoped to SOL-quoted bonding curves only (the classic,
// overwhelming majority of pump.fun tokens) — the newer
// isLegacyQuoteMint/quoteMint fields in state.ts show pump.fun added
// support for non-SOL quote tokens, which this doesn't cover.
//
// Verification note: `npm run build` (Vite) succeeds with this module
// wired in — confirmed twice, with the dependency actually present in
// the built bundle (its size grows accordingly), not silently
// tree-shaken out. A plain `node -e "import('./pumpfun.js')"` smoke
// test does NOT work here, unlike pumpswap.js's own — @pump-fun/pump-
// sdk pulls in @pump-fun/agent-payments-sdk (an unrelated AI-agent-
// tipping feature this file never calls, but which still loads at
// import time), whose own compiled output does `import{BN}from
// "@coral-xyz/anchor"` — a named import Node's native ESM loader
// can't resolve from Anchor's CJS build ("SyntaxError: Named export
// 'BN' not found"), while Vite's own bundler handles the same CJS/ESM
// boundary fine. Same "Node can't run it, the real bundler can" gap
// this repo's own wagmi.js already has (see uniswapV3.js's own header)
// — the build result is what's trustworthy here, not the Node script.
// Real, useful data point for mango-mobile's own open question before
// porting this: a genuine CJS-interop failure already reproduced in
// this exact dependency tree under one JS runtime is real evidence
// worth checking against Metro specifically, not just a re-assertion
// of the same unconfirmed worry.

import { PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import BN from "bn.js";
import { OnlinePumpSdk, PUMP_SDK } from "@pump-fun/pump-sdk";
import { NATIVE_MINT } from "@solana/spl-token";
import { resolveWalletStandardSigner } from "./solanaWalletStandard.js";

// Wider than pumpswap.js's 1% default — see this file's own header on
// why (no fee model for this side, unlike PumpSwap's).
const DEFAULT_SLIPPAGE_PCT = 5;

/**
 * Returns the token's bonding-curve state if it's a real, still-
 * trading (not yet graduated) pump.fun token, or null otherwise — no
 * bonding curve account at all (never a pump.fun token, or one whose
 * curve account was already closed on migration), or one that exists
 * but is marked complete (graduated — pumpswap.js is the right module
 * for it now). Same "not this provider, try the next one" contract
 * every other fallback provider in this app follows.
 */
export async function pumpFunCurveForMint(connection, mintAddress) {
  try {
    const onlineSdk = new OnlinePumpSdk(connection);
    const mint = new PublicKey(mintAddress);
    const bondingCurve = await onlineSdk.fetchBondingCurve(mint);
    if (bondingCurve.complete) return null;
    // SOL-quoted only — see this file's own header.
    if (bondingCurve.quoteMint && !bondingCurve.quoteMint.equals(NATIVE_MINT) && !bondingCurve.quoteMint.equals(PublicKey.default)) return null;
    return bondingCurve;
  } catch {
    return null;
  }
}

// Standard pump.fun constant-product bonding-curve formula — see this
// file's own header on why fees aren't modeled here.
function quoteBuyFromReserves(bondingCurve, solIn) {
  const { virtualTokenReserves, virtualQuoteReserves } = bondingCurve;
  const newVirtualQuoteReserves = virtualQuoteReserves.add(solIn);
  const newVirtualTokenReserves = virtualQuoteReserves.mul(virtualTokenReserves).div(newVirtualQuoteReserves);
  const tokensOut = virtualTokenReserves.sub(newVirtualTokenReserves);
  return tokensOut.lt(new BN(0)) ? new BN(0) : tokensOut;
}

function quoteSellFromReserves(bondingCurve, tokensIn) {
  const { virtualTokenReserves, virtualQuoteReserves } = bondingCurve;
  const newVirtualTokenReserves = virtualTokenReserves.add(tokensIn);
  const newVirtualQuoteReserves = virtualQuoteReserves.mul(virtualTokenReserves).div(newVirtualTokenReserves);
  const solOut = virtualQuoteReserves.sub(newVirtualQuoteReserves);
  return solOut.lt(new BN(0)) ? new BN(0) : solOut;
}

/** Quotes buying the token by spending `quoteBaseUnits` lamports of native SOL. Returns null when this mint has no active bonding curve. */
export async function quotePumpFunBuy({ connection, mintAddress, quoteBaseUnits }) {
  const bondingCurve = await pumpFunCurveForMint(connection, mintAddress);
  if (!bondingCurve) return null;
  const amountOut = quoteBuyFromReserves(bondingCurve, new BN(quoteBaseUnits.toString()));
  return { amountOut: BigInt(amountOut.toString()), bondingCurve };
}

/** Quotes selling `amountBaseUnits` of the token for native SOL. Returns null when this mint has no active bonding curve. */
export async function quotePumpFunSell({ connection, mintAddress, amountBaseUnits }) {
  const bondingCurve = await pumpFunCurveForMint(connection, mintAddress);
  if (!bondingCurve) return null;
  const amountOut = quoteSellFromReserves(bondingCurve, new BN(amountBaseUnits.toString()));
  return { amountOut: BigInt(amountOut.toString()), bondingCurve };
}

/**
 * Full build-sign-send for a direct pump.fun bonding-curve trade.
 * `side: "buy"` spends `amountBaseUnits` lamports of native SOL for
 * the token; `side: "sell"` spends `amountBaseUnits` of the token for
 * native SOL. `solanaProvider` is the connected wallet's own signer
 * (same shape this app's relaySdkSolanaExecution.js/pumpswap.js
 * already use). Throws when this mint has no active bonding curve —
 * the caller's own try/catch is what falls through to PumpSwap or
 * Relay for that case.
 */
export async function executePumpFunTrade({ connection, solanaAddress, solanaProvider, mintAddress, side, amountBaseUnits, slippagePct = DEFAULT_SLIPPAGE_PCT }) {
  // Same real fix as relaySdkSolanaExecution.js's own resolveWalletStandardSigner
  // fallback (see that shared module's header for the full story) — a
  // non-OKX Wallet Standard wallet (this app's own Mango Wallet
  // extension included) can leave solanaProvider null here even when
  // genuinely connected, silently losing this direct pump.fun route
  // (the caller's own try/catch just falls through to Relay/Jupiter)
  // instead of actually using it.
  const resolvedProvider = solanaProvider || (await resolveWalletStandardSigner(solanaAddress));
  if (!resolvedProvider) {
    throw new Error("No usable Solana signer for this wallet.");
  }
  const onlineSdk = new OnlinePumpSdk(connection);
  const mint = new PublicKey(mintAddress);
  const user = new PublicKey(solanaAddress);
  const global = await onlineSdk.fetchGlobal();

  let instructions;
  if (side === "buy") {
    const { bondingCurveAccountInfo, bondingCurve, associatedUserAccountInfo } = await onlineSdk.fetchBuyState(mint, user);
    if (bondingCurve.complete) {
      throw new Error("This token has already graduated off the bonding curve.");
    }
    const quoteAmount = new BN(amountBaseUnits.toString());
    const tokenAmount = quoteBuyFromReserves(bondingCurve, quoteAmount);
    instructions = await PUMP_SDK.buyInstructions({
      global,
      bondingCurveAccountInfo,
      bondingCurve,
      associatedUserAccountInfo,
      mint,
      user,
      amount: tokenAmount,
      solAmount: quoteAmount,
      slippage: slippagePct,
    });
  } else {
    const { bondingCurveAccountInfo, bondingCurve } = await onlineSdk.fetchSellState(mint, user);
    if (bondingCurve.complete) {
      throw new Error("This token has already graduated off the bonding curve.");
    }
    const tokenAmount = new BN(amountBaseUnits.toString());
    const quoteAmount = quoteSellFromReserves(bondingCurve, tokenAmount);
    instructions = await PUMP_SDK.sellInstructions({
      global,
      bondingCurveAccountInfo,
      bondingCurve,
      mint,
      user,
      amount: tokenAmount,
      solAmount: quoteAmount,
      slippage: slippagePct,
      mayhemMode: bondingCurve.isMayhemMode,
    });
  }

  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: user,
    instructions,
    recentBlockhash: blockhash,
  }).compileToV0Message();
  const transaction = new VersionedTransaction(message);

  // Same real fix as pumpswap.js/relaySdkSolanaExecution.js — simulate
  // before asking for a signature.
  const sim = await connection.simulateTransaction(transaction, { commitment: "confirmed" });
  if (sim.value.err) {
    throw new Error(`pump.fun simulation failed: ${JSON.stringify(sim.value.err)}`);
  }

  const signed = await resolvedProvider.signTransaction(transaction, "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp");
  const signature = await connection.sendRawTransaction(signed.serialize());
  await connection.confirmTransaction(signature, "confirmed");
  return { signature };
}
