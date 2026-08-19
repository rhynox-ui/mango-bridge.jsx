#!/usr/bin/env node
// scripts/solana-devnet-smoke-test.mjs
//
// Real, live smoke test for the deployed mango-launchpad program — the
// first time this program's actual on-chain logic (PDA derivation, CPI
// signer seeds, account constraints) has ever executed, as opposed to
// just compiling. Runs the whole real flow against devnet: initialize
// (once, skipped if Global already exists) -> create_launch (fresh test
// token) -> buy -> sell -> claim_creator_fees -> claim_protocol_fees ->
// update_global, using src/solanaLaunchpadProgram.js's real instruction
// builders — same code path any real client would use.
//
// The claim_* and update_global steps matter specifically because they
// were NOT covered by the first real devnet run (init/create_launch/buy/
// sell only) — update_global in particular had a real, confirmed bug
// (missing #[account(mut)] on Global, fixed in commit 1c1a211) that
// `cargo check` couldn't catch and only real execution against a live
// account can actually confirm is fixed.
//
// This must run from an environment with real devnet RPC access — the
// sandbox this program was developed in cannot reach any Solana RPC at
// all (see the STATUS notes in lib.rs / solanaLaunchpadProgram.js), so
// this script has never been run there. It's designed to be run from a
// real dev environment (a Codespace, a local machine) that has one.
//
// Usage: node scripts/solana-devnet-smoke-test.mjs [path-to-payer-keypair.json]
// Defaults to ~/devnet.json if no path given.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import * as program from "../src/solanaLaunchpadProgram.js";

const DEVNET_RPC = "https://api.devnet.solana.com";
const keypairPath = process.argv[2] || resolve(homedir(), "devnet.json");

function loadKeypair(path) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function log(step, msg) {
  console.log(`\n[${step}] ${msg}`);
}

async function sendIx(connection, label, instruction, signers) {
  const tx = new Transaction().add(instruction);
  try {
    const signature = await sendAndConfirmTransaction(connection, tx, signers, {
      commitment: "confirmed",
    });
    log(label, `OK — https://explorer.solana.com/tx/${signature}?cluster=devnet`);
    return signature;
  } catch (err) {
    log(label, `FAILED`);
    // Anchor's require!/error macros log a human-readable message via
    // "Program log:" lines — surface those specifically, they're usually
    // the actual, useful diagnostic, not the generic "Transaction
    // simulation failed" wrapper message.
    const logs = err?.logs || err?.transactionLogs;
    if (logs) {
      console.error("Program logs:");
      for (const line of logs) console.error("  " + line);
    } else {
      console.error(err);
    }
    throw err;
  }
}

async function main() {
  console.log(`Loading payer/authority keypair from ${keypairPath}`);
  const payer = loadKeypair(keypairPath);
  console.log(`Using: ${payer.publicKey.toBase58()}`);
  console.log(`Program: ${program.PROGRAM_ID.toBase58()}`);

  const connection = new Connection(DEVNET_RPC, "confirmed");

  const balanceLamports = await connection.getBalance(payer.publicKey);
  console.log(`Payer balance: ${balanceLamports / 1e9} SOL`);
  if (balanceLamports < 0.5e9) {
    console.warn("WARNING: balance looks low for this test (create_launch alone needs real rent) — proceeding anyway.");
  }

  // --- Step 1: initialize (skip if Global already exists) ---
  const [globalPda] = program.deriveGlobalPda();
  const globalInfo = await connection.getAccountInfo(globalPda);
  if (globalInfo) {
    log("initialize", `Global already exists at ${globalPda.toBase58()} — skipping (this is expected on a second run).`);
  } else {
    const ix = program.buildInitializeInstruction({ authority: payer.publicKey });
    await sendIx(connection, "initialize", ix, [payer]);
  }

  // --- Step 2: create_launch (fresh test token + bonding curve) ---
  const mintKeypair = Keypair.generate();
  console.log(`\nNew test token mint: ${mintKeypair.publicKey.toBase58()}`);
  const createIx = program.buildCreateLaunchInstruction({ creator: payer.publicKey, mintKeypair });
  await sendIx(connection, "create_launch", createIx, [payer, mintKeypair]);

  // --- Step 3: buy (small, fixed amount — 0.01 SOL, no slippage guard
  // since this is a controlled test on a curve nobody else is trading) ---
  const solInLamports = 10_000_000n; // 0.01 SOL
  const buyIx = program.buildBuyInstruction({
    buyer: payer.publicKey,
    mint: mintKeypair.publicKey,
    solInLamports,
    minTokenOutBaseUnits: 0n,
  });
  await sendIx(connection, "buy", buyIx, [payer]);

  const buyerTokenAccount = program.deriveAssociatedTokenAddress(payer.publicKey, mintKeypair.publicKey);
  const tokenBalance = await connection.getTokenAccountBalance(buyerTokenAccount);
  console.log(`Buyer token balance after buy: ${tokenBalance.value.uiAmountString} (${tokenBalance.value.amount} base units)`);
  const tokensReceived = BigInt(tokenBalance.value.amount);
  if (tokensReceived === 0n) {
    throw new Error("buy succeeded but yielded 0 tokens — something is wrong with the curve math or fee application.");
  }

  // --- Step 4: sell (half of what we just bought, back for SOL) ---
  const tokenInBaseUnits = tokensReceived / 2n;
  const sellIx = program.buildSellInstruction({
    seller: payer.publicKey,
    mint: mintKeypair.publicKey,
    tokenInBaseUnits,
    minSolOutLamports: 0n,
  });
  await sendIx(connection, "sell", sellIx, [payer]);

  const finalTokenBalance = await connection.getTokenAccountBalance(buyerTokenAccount);
  const finalSolBalance = await connection.getBalance(payer.publicKey);
  console.log(`\nFinal token balance: ${finalTokenBalance.value.uiAmountString}`);
  console.log(`Final SOL balance: ${finalSolBalance / 1e9} SOL`);

  // --- Step 5: claim_creator_fees — payer was also the creator (create_launch
  // signed by payer above), so there's real accrued SOL (from the sell's 4%
  // fee) and tokens (from the buy's 1% fee) to actually claim, not a no-op. ---
  const claimCreatorIx = program.buildClaimCreatorFeesInstruction({
    creator: payer.publicKey,
    mint: mintKeypair.publicKey,
  });
  await sendIx(connection, "claim_creator_fees", claimCreatorIx, [payer]);

  // --- Step 6: claim_protocol_fees — permissionless (any payer), sweeps to
  // the real, configured protocol_fee_wallet from constants.rs's default. ---
  const claimProtocolIx = program.buildClaimProtocolFeesInstruction({
    payer: payer.publicKey,
    mint: mintKeypair.publicKey,
    protocolFeeWallet: program.DEFAULT_PROTOCOL_FEE_WALLET,
  });
  await sendIx(connection, "claim_protocol_fees", claimProtocolIx, [payer]);

  // --- Step 7: update_global — a real, no-op-content call (every field
  // omitted) specifically to exercise the has_one=authority check and the
  // #[account(mut)] write path for real, since that exact combination was
  // the site of a confirmed compiles-clean-but-wrong-at-runtime bug. ---
  const updateGlobalIx = program.buildUpdateGlobalInstruction({ authority: payer.publicKey });
  await sendIx(connection, "update_global", updateGlobalIx, [payer]);

  console.log(
    "\n=== SMOKE TEST PASSED — initialize, create_launch, buy, sell, claim_creator_fees, claim_protocol_fees, and update_global all executed successfully on devnet. ==="
  );
}

main().catch((err) => {
  console.error("\n=== SMOKE TEST FAILED ===");
  console.error(err?.message || err);
  process.exit(1);
});
