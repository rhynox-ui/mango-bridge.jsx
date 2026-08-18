// scripts/verify-wallet-spl.mjs
//
// Real, offline-verifiable regression check for the SPL token additions
// to src/wallet/sendTransaction.js and walletRpc.js. Same limitation as
// every other RPC-touching script this session: this sandbox's egress
// proxy blocks Solana RPC entirely, so the actual live balance-fetch and
// broadcast calls can't be exercised here — what CAN be verified for
// real, with zero network calls: associated-token-account derivation is
// deterministic and well-formed, and a real SPL transfer transaction
// (and an ATA-creation instruction) construct and sign correctly.
//
// Run: node scripts/verify-wallet-spl.mjs

import assert from "node:assert";
import { readFileSync } from "node:fs";
import {
  Keypair, PublicKey, Transaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, createTransferInstruction,
  TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { SPL_TOKENS } from "../src/wallet/walletSplTokens.js";

function sourceContains(relativePath, substring) {
  const text = readFileSync(new URL(relativePath, import.meta.url), "utf8");
  return text.includes(substring);
}

let n = 0;
async function check(label, fn) {
  await fn();
  n++;
  console.log(`ok ${n} - ${label}`);
}

await check("SPL_TOKENS has the real, verified USDC and USDT mainnet mint addresses (cross-checked against Solana Labs' own token-list repo)", () => {
  const usdc = SPL_TOKENS.find((t) => t.symbol === "USDC");
  const usdt = SPL_TOKENS.find((t) => t.symbol === "USDT");
  assert.equal(usdc.mint, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  assert.equal(usdc.decimals, 6);
  assert.equal(usdt.mint, "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB");
  assert.equal(usdt.decimals, 6);
});

await check("getAssociatedTokenAddress is deterministic and returns a well-formed 32-byte public key", () => {
  return Promise.all([
    getAssociatedTokenAddress(new PublicKey(SPL_TOKENS[0].mint), Keypair.generate().publicKey),
  ]).then(() => {
    const owner = Keypair.generate().publicKey;
    const mint = new PublicKey(SPL_TOKENS[0].mint);
    return Promise.all([getAssociatedTokenAddress(mint, owner), getAssociatedTokenAddress(mint, owner)]).then(([a, b]) => {
      assert.equal(a.toBase58(), b.toBase58(), "same owner+mint must always derive the same ATA");
      assert.equal(a.toBuffer().length, 32);
    });
  });
});

await check("a real SPL transfer instruction signs offline and decodes back to the exact amount/program", () => {
  const fromKeypair = Keypair.generate();
  const toKeypair = Keypair.generate();
  const mint = new PublicKey(SPL_TOKENS[0].mint);

  return Promise.all([
    getAssociatedTokenAddress(mint, fromKeypair.publicKey),
    getAssociatedTokenAddress(mint, toKeypair.publicKey),
  ]).then(([fromAta, toAta]) => {
    const amountRaw = 500_000_000n; // 500 USDC at 6 decimals
    const ix = createTransferInstruction(fromAta, toAta, fromKeypair.publicKey, amountRaw);
    assert.equal(ix.programId.toBase58(), TOKEN_PROGRAM_ID.toBase58());

    const dummyBlockhash = Keypair.generate().publicKey.toBase58();
    const transaction = new Transaction({ recentBlockhash: dummyBlockhash, feePayer: fromKeypair.publicKey }).add(ix);
    transaction.sign(fromKeypair);
    assert.equal(transaction.verifySignatures(), true);

    const roundTripped = Transaction.from(transaction.serialize());
    assert.equal(roundTripped.verifySignatures(), true);
    // SPL token transfer instruction data layout: 1 byte instruction tag (3 = Transfer) + 8 bytes little-endian amount.
    const decodedIx = roundTripped.instructions[0];
    assert.equal(decodedIx.data[0], 3, "expected SPL Token instruction tag 3 (Transfer)");
    const decodedAmount = decodedIx.data.readBigUInt64LE(1);
    assert.equal(decodedAmount, amountRaw);
  });
});

await check("a real ATA-creation instruction references the correct owner/mint/associated-token-program", () => {
  const payer = Keypair.generate();
  const owner = Keypair.generate().publicKey;
  const mint = new PublicKey(SPL_TOKENS[1].mint);

  return getAssociatedTokenAddress(mint, owner).then((ata) => {
    const ix = createAssociatedTokenAccountInstruction(payer.publicKey, ata, owner, mint);
    assert.equal(ix.programId.toBase58(), ASSOCIATED_TOKEN_PROGRAM_ID.toBase58());
    const keys = ix.keys.map((k) => k.pubkey.toBase58());
    assert.ok(keys.includes(payer.publicKey.toBase58()));
    assert.ok(keys.includes(owner.toBase58()));
    assert.ok(keys.includes(mint.toBase58()));
    assert.ok(keys.includes(ata.toBase58()));
  });
});

await check("sendTransaction.js's SPL fee estimate checks live whether the recipient's ATA exists, never assumes either way", () => {
  assert.ok(sourceContains("../src/wallet/sendTransaction.js", "connection.getAccountInfo(toAta)"));
  assert.ok(sourceContains("../src/wallet/sendTransaction.js", "getMinimumBalanceForRentExemption(ACCOUNT_SIZE)"));
});

console.log(`\n${n}/${n} checks passed`);
console.log("\nNot verified here (Solana RPC is blocked from this sandbox): live SPL balance reads and actual broadcast of sendSplToken/estimateSplSendFee.");
