// src/solanaLaunchpadProgram.js
//
// Real, pure instruction-building for solana-program/'s mango-launchpad
// Anchor program — PDA derivation, Anchor instruction discriminators, and
// TransactionInstruction builders for create_launch / buy / sell / claim.
//
// STATUS — read before wiring this into any UI:
// This targets a program that has NEVER been deployed anywhere (see
// solana-program/programs/mango-launchpad/src/lib.rs's own STATUS block —
// verified via `cargo check` + `cargo test` only, never built to BPF, never
// run on a validator or devnet). Every account layout and instruction
// argument order below is copied directly from that program's own Rust
// source (the actual Accounts structs and handler signatures), not
// guessed — high confidence on "does this match the Rust", zero evidence
// yet on "does the Rust itself behave correctly on a real cluster".
// Deliberately NOT imported by any live UI component yet (Launchpad.jsx's
// Solana tab still shows "Coming soon") — a button that calls a program
// address with no deployed program behind it would fail 100% of the time,
// which is worse UX than an honest placeholder. Wire this in once the
// program is actually deployed to devnet and this module's output has
// been checked against a real transaction there.
//
// Anchor instruction discriminators are sha256("global:<ix_name>")[0:8] —
// Anchor's standard, stable, unchanged convention. Precomputed offline
// (Node's crypto, same sha256) rather than recomputed via async Web
// Crypto on every call; each one below can be independently re-verified
// with `node -e 'console.log([...require("crypto").createHash("sha256").update("global:buy").digest().subarray(0,8)])'`
// against the exact instruction name declared in lib.rs's #[program] mod.

import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";

// declare_id!(...) in solana-program/programs/mango-launchpad/src/lib.rs —
// a real generated program keypair's public half, not a placeholder
// string, but genuinely unused until this program is actually deployed
// under it.
export const PROGRAM_ID = new PublicKey("2iPvVbb64HNmRq1oWW83cgSQ9frgYd8Kv3ShckUafccU");

// Well-known, stable Solana ecosystem constants — unchanged since the SPL
// Token program's original 2020 deployment, not specific to this program.
export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const SYSVAR_RENT_ID = new PublicKey("SysvarRent111111111111111111111111111111111");

// Seeds copied verbatim from constants.rs's GLOBAL_SEED / BONDING_CURVE_SEED.
const GLOBAL_SEED = Buffer.from("global");
const BONDING_CURVE_SEED = Buffer.from("bonding-curve");

export function deriveGlobalPda() {
  return PublicKey.findProgramAddressSync([GLOBAL_SEED], PROGRAM_ID);
}

export function deriveBondingCurvePda(mint) {
  return PublicKey.findProgramAddressSync([BONDING_CURVE_SEED, mint.toBuffer()], PROGRAM_ID);
}

/** Standard Associated Token Account address — same derivation every SPL token wallet/explorer uses. */
export function deriveAssociatedTokenAddress(owner, mint) {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  )[0];
}

const DISCRIMINATORS = {
  initialize: [175, 175, 109, 31, 13, 152, 155, 237],
  create_launch: [239, 223, 255, 134, 39, 121, 127, 62],
  buy: [102, 6, 61, 18, 1, 218, 235, 234],
  sell: [51, 230, 133, 164, 1, 127, 131, 173],
  claim_creator_fees: [0, 23, 125, 234, 156, 118, 134, 89],
  claim_protocol_fees: [34, 142, 219, 112, 109, 54, 133, 23],
};

function discriminator(name) {
  const bytes = DISCRIMINATORS[name];
  if (!bytes) throw new Error(`Unknown instruction "${name}" — no discriminator recorded`);
  return Buffer.from(bytes);
}

/** Borsh encodes a u64 as 8 bytes little-endian — the same encoding Anchor's IDL generates for a Rust u64 arg. */
function u64LeBytes(value) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(value));
  return buf;
}

function accountMeta(pubkey, { signer = false, writable = false } = {}) {
  return { pubkey, isSigner: signer, isWritable: writable };
}

/**
 * Launches a new token — mints its entire fixed supply into a fresh
 * bonding curve and permanently revokes mint/freeze authority (create.rs).
 * `mintKeypair` MUST be a freshly generated Keypair (Keypair.generate()),
 * never reused — the Rust side `init`s this as a brand new mint account,
 * which requires a real signature from the mint's own keypair, the same
 * way creating any new SPL mint does.
 */
export function buildCreateLaunchInstruction({ creator, mintKeypair }) {
  const [global] = deriveGlobalPda();
  const [bondingCurve] = deriveBondingCurvePda(mintKeypair.publicKey);
  const tokenVault = deriveAssociatedTokenAddress(bondingCurve, mintKeypair.publicKey);

  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      accountMeta(creator, { signer: true, writable: true }),
      accountMeta(global),
      accountMeta(bondingCurve, { writable: true }),
      accountMeta(mintKeypair.publicKey, { signer: true, writable: true }),
      accountMeta(tokenVault, { writable: true }),
      accountMeta(TOKEN_PROGRAM_ID),
      accountMeta(ASSOCIATED_TOKEN_PROGRAM_ID),
      accountMeta(SystemProgram.programId),
      accountMeta(SYSVAR_RENT_ID),
    ],
    data: discriminator("create_launch"),
  });
}

/** Buys tokens with SOL — see buy.rs. solInLamports/minTokenOutBaseUnits are u64 (BigInt-safe). */
export function buildBuyInstruction({ buyer, mint, solInLamports, minTokenOutBaseUnits }) {
  const [global] = deriveGlobalPda();
  const [bondingCurve] = deriveBondingCurvePda(mint);
  const tokenVault = deriveAssociatedTokenAddress(bondingCurve, mint);
  const buyerTokenAccount = deriveAssociatedTokenAddress(buyer, mint);

  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      accountMeta(buyer, { signer: true, writable: true }),
      accountMeta(global),
      accountMeta(bondingCurve, { writable: true }),
      accountMeta(mint),
      accountMeta(tokenVault, { writable: true }),
      accountMeta(buyerTokenAccount, { writable: true }),
      accountMeta(TOKEN_PROGRAM_ID),
      accountMeta(ASSOCIATED_TOKEN_PROGRAM_ID),
      accountMeta(SystemProgram.programId),
    ],
    data: Buffer.concat([discriminator("buy"), u64LeBytes(solInLamports), u64LeBytes(minTokenOutBaseUnits)]),
  });
}

/** Sells tokens for SOL — see sell.rs. Requires the seller already hold a token account for `mint` (not init_if_needed on the Rust side). */
export function buildSellInstruction({ seller, mint, tokenInBaseUnits, minSolOutLamports }) {
  const [global] = deriveGlobalPda();
  const [bondingCurve] = deriveBondingCurvePda(mint);
  const tokenVault = deriveAssociatedTokenAddress(bondingCurve, mint);
  const sellerTokenAccount = deriveAssociatedTokenAddress(seller, mint);

  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      accountMeta(seller, { signer: true, writable: true }),
      accountMeta(global),
      accountMeta(bondingCurve, { writable: true }),
      accountMeta(mint),
      accountMeta(tokenVault, { writable: true }),
      accountMeta(sellerTokenAccount, { writable: true }),
      accountMeta(TOKEN_PROGRAM_ID),
    ],
    data: Buffer.concat([discriminator("sell"), u64LeBytes(tokenInBaseUnits), u64LeBytes(minSolOutLamports)]),
  });
}

/** Claims everything the real, registered creator has accrued for one token — see claim_creator_fees.rs. */
export function buildClaimCreatorFeesInstruction({ creator, mint }) {
  const [bondingCurve] = deriveBondingCurvePda(mint);
  const tokenVault = deriveAssociatedTokenAddress(bondingCurve, mint);
  const creatorTokenAccount = deriveAssociatedTokenAddress(creator, mint);

  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      accountMeta(creator, { signer: true, writable: true }),
      accountMeta(bondingCurve, { writable: true }),
      accountMeta(mint),
      accountMeta(tokenVault, { writable: true }),
      accountMeta(creatorTokenAccount, { writable: true }),
      accountMeta(TOKEN_PROGRAM_ID),
      accountMeta(ASSOCIATED_TOKEN_PROGRAM_ID),
      accountMeta(SystemProgram.programId),
    ],
    data: discriminator("claim_creator_fees"),
  });
}

/**
 * Sweeps accrued protocol fees for one token to the configured protocol
 * wallet — see claim_protocol_fees.rs. Permissionless on the Rust side
 * (any payer), but `protocolFeeWallet` MUST exactly equal the real,
 * on-chain Global.protocol_fee_wallet or the Rust constraint rejects it —
 * defaults to constants.rs's DEFAULT_PROTOCOL_FEE_WALLET, but callers
 * should fetch and pass the real current value once Global is actually
 * readable from a live deployment (it's changeable via update_global).
 */
export function buildClaimProtocolFeesInstruction({ payer, mint, protocolFeeWallet }) {
  const [global] = deriveGlobalPda();
  const [bondingCurve] = deriveBondingCurvePda(mint);
  const tokenVault = deriveAssociatedTokenAddress(bondingCurve, mint);
  const protocolTokenAccount = deriveAssociatedTokenAddress(protocolFeeWallet, mint);

  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      accountMeta(payer, { signer: true, writable: true }),
      accountMeta(global),
      accountMeta(bondingCurve, { writable: true }),
      accountMeta(mint),
      accountMeta(tokenVault, { writable: true }),
      accountMeta(protocolFeeWallet, { writable: true }),
      accountMeta(protocolTokenAccount, { writable: true }),
      accountMeta(TOKEN_PROGRAM_ID),
      accountMeta(ASSOCIATED_TOKEN_PROGRAM_ID),
      accountMeta(SystemProgram.programId),
    ],
    data: discriminator("claim_protocol_fees"),
  });
}

// Real, already-deployed Solana address — same constant as constants.rs's
// DEFAULT_PROTOCOL_FEE_WALLET and relaySdkSolanaExecution.js's
// DEV_FEE_WALLET_SOLANA, reused deliberately rather than a third fee
// wallet.
export const DEFAULT_PROTOCOL_FEE_WALLET = new PublicKey("CFqNwTuTkqkaVoNZmNE6q5TeV6CcNwGRns2NSEY72Fu2");
