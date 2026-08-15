#!/usr/bin/env node
// scripts/verify-solana-launchpad-program.mjs
//
// Permanent, dependency-free regression check for
// src/solanaLaunchpadProgram.js — the client-side instruction builder for
// solana-program/'s (untracked, unpushed) Anchor program. No test
// framework is installed in this project, so this is a plain Node script
// (uses only node:assert and the already-installed @solana/web3.js) —
// consistent with the rest of this codebase's "don't add a dependency for
// something this small" style.
//
// Run: node scripts/verify-solana-launchpad-program.mjs
//
// What this checks, and why each one matters:
//   1. PDA addresses/bumps match a known-good cross-check against the
//      actual Rust program (solana-program's lib.rs has the mirror-image
//      test — js_client_cross_check::pda_derivation_matches_solana_launchpad_program_js
//      — pinning the exact same values from the Rust side). If either
//      side's seeds ever change without the other being updated, one of
//      these two tests catches it.
//   2. Every well-known constant (SPL Token program, Associated Token
//      program, Rent sysvar) actually parses as a valid Pubkey — this
//      exact check caught a real bug during development: the Rent sysvar
//      address was missing several trailing "1"s and threw at runtime
//      despite `npm run build` passing clean (build succeeded because
//      this file wasn't imported by anything yet, so Rollup never
//      evaluated it — a reminder that "the app builds" says nothing about
//      an unwired module).
//   3. Each instruction builder produces the right number of account
//      metas (matching the Rust Accounts struct's field count exactly)
//      and correctly Borsh-encoded instruction data (8-byte discriminator
//      + little-endian u64 args, verified byte-for-byte for buy/sell).

import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import * as program from "../src/solanaLaunchpadProgram.js";

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`ok — ${name}`);
}

check("well-known constants parse as valid pubkeys", () => {
  assert.ok(program.PROGRAM_ID instanceof PublicKey);
  assert.ok(program.TOKEN_PROGRAM_ID instanceof PublicKey);
  assert.ok(program.ASSOCIATED_TOKEN_PROGRAM_ID instanceof PublicKey);
  assert.ok(program.SYSVAR_RENT_ID instanceof PublicKey);
  assert.ok(program.DEFAULT_PROTOCOL_FEE_WALLET instanceof PublicKey);
});

check("PROGRAM_ID matches declare_id!() in solana-program's lib.rs", () => {
  assert.equal(program.PROGRAM_ID.toBase58(), "GoNqEH59tn8q8ogHJjPmF9TRPei9DgYDnXFdm6yEY3RR");
});

check("global PDA matches the Rust-side cross-check test", () => {
  const [pda, bump] = program.deriveGlobalPda();
  assert.equal(pda.toBase58(), "BhT73GwJjXb7BBsfifjT4uder3fjeosCDuz7sxqmHyQi");
  assert.equal(bump, 254);
});

check("bonding_curve PDA (fixed WSOL mint) matches the Rust-side cross-check test", () => {
  const wsolMint = new PublicKey("So11111111111111111111111111111111111111112");
  const [pda, bump] = program.deriveBondingCurvePda(wsolMint);
  assert.equal(pda.toBase58(), "FYdqv844DskpoEf6eYPRbFi2V2bbZmgxB6G626hui3TB");
  assert.equal(bump, 255);
});

check("create_launch instruction has the right accounts and both required signers", () => {
  const creator = Keypair.generate().publicKey;
  const mintKeypair = Keypair.generate();
  const ix = program.buildCreateLaunchInstruction({ creator, mintKeypair });
  assert.equal(ix.programId.toBase58(), program.PROGRAM_ID.toBase58());
  assert.equal(ix.keys.length, 9); // creator, global, bonding_curve, mint, token_vault, token_program, ata_program, system_program, rent
  const signers = ix.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58());
  assert.deepEqual(new Set(signers), new Set([creator.toBase58(), mintKeypair.publicKey.toBase58()]));
  assert.equal(ix.data.length, 8); // discriminator only, no args
});

check("buy instruction encodes discriminator + two u64 LE args correctly", () => {
  const buyer = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const ix = program.buildBuyInstruction({ buyer, mint, solInLamports: 1_000_000_000n, minTokenOutBaseUnits: 42n });
  assert.equal(ix.keys.length, 9);
  assert.equal(ix.data.length, 24); // 8 (discriminator) + 8 (sol_in) + 8 (min_token_out)
  const discriminator = [...ix.data.subarray(0, 8)];
  assert.deepEqual(discriminator, [102, 6, 61, 18, 1, 218, 235, 234]); // sha256("global:buy")[0:8]
  assert.equal(ix.data.readBigUInt64LE(8), 1_000_000_000n);
  assert.equal(ix.data.readBigUInt64LE(16), 42n);
});

check("sell instruction has 7 accounts (no ATA/system programs — pre-existing token account only)", () => {
  const seller = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const ix = program.buildSellInstruction({ seller, mint, tokenInBaseUnits: 5000n, minSolOutLamports: 1n });
  assert.equal(ix.keys.length, 7);
  const discriminator = [...ix.data.subarray(0, 8)];
  assert.deepEqual(discriminator, [51, 230, 133, 164, 1, 127, 131, 173]); // sha256("global:sell")[0:8]
});

check("claim_creator_fees and claim_protocol_fees have the right account counts", () => {
  const creator = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const ixCreator = program.buildClaimCreatorFeesInstruction({ creator, mint });
  assert.equal(ixCreator.keys.length, 8);

  const payer = Keypair.generate().publicKey;
  const ixProtocol = program.buildClaimProtocolFeesInstruction({ payer, mint, protocolFeeWallet: program.DEFAULT_PROTOCOL_FEE_WALLET });
  assert.equal(ixProtocol.keys.length, 10);
});

check("update_global has the right account writability and Option<T> Borsh encoding", () => {
  const authority = Keypair.generate().publicKey;

  // global must be writable (handler mutates it) and authority must NOT be
  // (plain Signer, no #[account(mut)] on it in update_global.rs) — this
  // exact check caught a real bug during development: the Rust side was
  // originally missing `mut` on `global`, which compiles fine (Anchor's
  // Account<> allows &mut access regardless) but would fail every real
  // call at runtime, since Solana rejects writes to accounts not marked
  // writable in the transaction — a "compiles clean, wrong on-chain"
  // class of bug that only a check like this one catches.
  const ixNoop = program.buildUpdateGlobalInstruction({ authority });
  assert.equal(ixNoop.keys.length, 2);
  assert.equal(ixNoop.keys[0].isWritable, true); // global
  assert.equal(ixNoop.keys[1].isSigner, true); // authority
  assert.equal(ixNoop.keys[1].isWritable, false); // authority

  const discriminator = [...ixNoop.data.subarray(0, 8)];
  assert.deepEqual(discriminator, [90, 152, 240, 21, 199, 38, 72, 20]); // sha256("global:update_global")[0:8]

  // Every field omitted -> seven None tags (1 byte each), nothing else.
  assert.equal(ixNoop.data.length, 8 + 7);
  assert.ok(ixNoop.data.subarray(8).every((byte) => byte === 0));

  // One Pubkey-typed field set -> its Some tag + 32 bytes, others still None.
  const newAuthority = Keypair.generate().publicKey;
  const ixAuth = program.buildUpdateGlobalInstruction({ authority, newAuthority });
  assert.equal(ixAuth.data.length, 8 + 1 + 32 + 6);
  assert.equal(ixAuth.data[8], 1); // Some tag
  assert.ok(newAuthority.toBuffer().equals(ixAuth.data.subarray(9, 41)));

  // One u64-typed field set, at a real production-scale value (90 SOL) —
  // byte-for-byte checked against Python's own little-endian encoding of
  // the same number, not just "looks right".
  const ixGrad = program.buildUpdateGlobalInstruction({ authority, newGraduationRealSolLamports: 90_000_000_000n });
  assert.equal(ixGrad.data.length, 8 + 6 + 1 + 8);
  const tail = ixGrad.data.subarray(-8);
  assert.deepEqual([...tail], [0, 4, 107, 244, 20, 0, 0, 0]);
});

check("Associated Token Address derivation is deterministic and owner/mint-sensitive", () => {
  const owner = Keypair.generate().publicKey;
  const mintA = Keypair.generate().publicKey;
  const mintB = Keypair.generate().publicKey;
  const ataA1 = program.deriveAssociatedTokenAddress(owner, mintA);
  const ataA2 = program.deriveAssociatedTokenAddress(owner, mintA);
  const ataB = program.deriveAssociatedTokenAddress(owner, mintB);
  assert.equal(ataA1.toBase58(), ataA2.toBase58());
  assert.notEqual(ataA1.toBase58(), ataB.toBase58());
});

console.log(`\n${passed} checks passed.`);
