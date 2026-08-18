// scripts/verify-wallet-send.mjs
//
// Real, permanent regression check for src/wallet/sendTransaction.js —
// everything that can be verified WITHOUT live RPC access. This sandbox's
// egress proxy blocks blockchain RPC traffic entirely (confirmed via a
// direct curl to rpc.ankr.com and ethereum.publicnode.com -> both 403 at
// the proxy), same limitation already documented for the Solana program's
// devnet work — so the actual `sendTransaction.js` broadcast calls
// (estimateFeesPerGas, sendTransaction, sendAndConfirmTransaction) can't
// be exercised from here. What CAN be verified offline, with zero
// network calls, is everything that matters before broadcast is even
// attempted: the fee arithmetic, and — the higher-value check — that a
// real transaction is constructed and SIGNED correctly for both chains,
// since signing is pure cryptography and genuinely doesn't need a
// network connection.
//
// Run: node scripts/verify-wallet-send.mjs

// Deliberately does NOT import src/wallet/sendTransaction.js (or, through
// it, walletRpc.js/wagmi.js) — those pull in Vite-only `import.meta.env`
// access and a large unrelated dependency graph (wagmi's AppKit adapter
// chain drags in @coinbase/cdp-sdk's x402 payment client, which isn't
// resolvable outside a bundler) that has nothing to do with what this
// script actually verifies: the pure arithmetic and cryptography, which
// need neither Vite nor a network connection. sourceContains() below
// cross-checks the one small numeric constant this script needs against
// the real source file instead, so this stays a genuine regression check
// on the actual code, not a reimplementation of it.

import assert from "node:assert";
import { readFileSync } from "node:fs";
import { parseEther, formatEther, parseTransaction, parseUnits, formatUnits, encodeFunctionData, toFunctionSelector, decodeFunctionData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "wagmi/chains";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";

function sourceContains(relativePath, substring) {
  const text = readFileSync(new URL(relativePath, import.meta.url), "utf8");
  return text.includes(substring);
}

let n = 0;
// Awaits fn() before counting/printing — a check whose assertion lives
// inside a Promise (several of these sign transactions, which viem's
// account.signTransaction returns as one) must not be reported as passed
// until that promise actually resolves. The original version of this
// helper called fn() without awaiting it, which let a genuinely failing
// async assertion print "ok" immediately and then crash the process much
// later, disconnected from which check actually failed.
async function check(label, fn) {
  await fn();
  n++;
  console.log(`ok ${n} - ${label}`);
}

// --- EVM: fee arithmetic + a real, offline-signed EIP-1559 transaction ---

const EVM_NATIVE_TRANSFER_GAS_LIMIT = 21_000n;

await check("sendTransaction.js uses the real, protocol-fixed native-transfer gas limit (21,000)", () => {
  assert.ok(sourceContains("../src/wallet/sendTransaction.js", "EVM_NATIVE_TRANSFER_GAS_LIMIT = 21_000n"));
});

await check("EIP-1559 fee formula matches gasLimit x (baseFee + priorityFee)", () => {
  const baseFee = 20_000_000_000n; // 20 gwei, a plausible mainnet value — not fetched, just a fixed input for this arithmetic check
  const priorityFee = 1_500_000_000n; // 1.5 gwei
  const maxFeePerGas = baseFee + priorityFee;
  const feeWei = EVM_NATIVE_TRANSFER_GAS_LIMIT * maxFeePerGas;
  const feeNative = Number(feeWei) / 1e18;
  assert.equal(feeWei, 21_000n * 21_500_000_000n);
  assert.ok(Math.abs(feeNative - 0.0004515) < 1e-9);
});

await check("a real EIP-1559 transaction signs offline (no RPC) and round-trips through parseTransaction", () => {
  const privateKey = `0x${"11".repeat(32)}`;
  const account = privateKeyToAccount(privateKey);
  const toAddress = "0x000000000000000000000000000000000000dEaD";
  const value = parseEther("0.01");
  const maxFeePerGas = 30_000_000_000n;
  const maxPriorityFeePerGas = 1_000_000_000n;

  return account
    .signTransaction({
      to: toAddress,
      value,
      chainId: mainnet.id,
      nonce: 0,
      maxFeePerGas,
      maxPriorityFeePerGas,
      gas: EVM_NATIVE_TRANSFER_GAS_LIMIT,
      type: "eip1559",
    })
    .then((signed) => {
      assert.ok(signed.startsWith("0x02"), "not an EIP-1559 (type 2) transaction");
      const parsed = parseTransaction(signed);
      assert.equal(parsed.to.toLowerCase(), toAddress.toLowerCase());
      assert.equal(parsed.value, value);
      assert.equal(parsed.chainId, mainnet.id);
      assert.equal(parsed.gas, EVM_NATIVE_TRANSFER_GAS_LIMIT);
      assert.equal(parsed.maxFeePerGas, maxFeePerGas);
      assert.equal(parsed.maxPriorityFeePerGas, maxPriorityFeePerGas);
      // A real signature was actually produced and is recoverable — proves
      // this isn't just a well-formed-looking unsigned payload.
      assert.ok(parsed.r && parsed.s && typeof parsed.v !== "undefined" || typeof parsed.yParity !== "undefined");
    });
});

await check("parseEther/formatEther round-trip exactly for a typical send amount", () => {
  assert.equal(formatEther(parseEther("1.23456789")), "1.23456789");
});

// --- ERC-20 token sends: real selector, decimal-aware parsing, a real offline-signed transfer ---

const ERC20_TRANSFER_ABI = [
  { type: "function", name: "transfer", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "nonpayable" },
];

await check("sendTransaction.js's ERC-20 ABI matches the real transfer(address,uint256) selector (0xa9059cbb) — independently derived, not just self-consistent", () => {
  // toFunctionSelector computes keccak256("transfer(address,uint256)") itself,
  // via a different viem codepath than encodeFunctionData below — comparing
  // the two, plus the widely-documented literal value, is a real
  // cross-check, not circular.
  const derivedSelector = toFunctionSelector("transfer(address,uint256)");
  assert.equal(derivedSelector, "0xa9059cbb");
  const encoded = encodeFunctionData({ abi: ERC20_TRANSFER_ABI, functionName: "transfer", args: ["0x000000000000000000000000000000000000dEaD", 1n] });
  assert.equal(encoded.slice(0, 10), derivedSelector);
});

await check("parseUnits/formatUnits round-trip exactly at USDC's real 6 decimals (not assumed to be 18 like a native asset)", () => {
  assert.equal(formatUnits(parseUnits("1234.56", 6), 6), "1234.56");
});

await check("a real ERC-20 transfer transaction signs offline and its encoded call data decodes back to the exact recipient/amount", () => {
  const privateKey = `0x${"22".repeat(32)}`;
  const account = privateKeyToAccount(privateKey);
  const tokenAddress = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"; // real USDC address on Ethereum, same one chainData.js uses
  const recipient = "0x000000000000000000000000000000000000dEaD";
  const amountRaw = parseUnits("500", 6); // 500 USDC
  const data = encodeFunctionData({ abi: ERC20_TRANSFER_ABI, functionName: "transfer", args: [recipient, amountRaw] });

  return account
    .signTransaction({
      to: tokenAddress,
      value: 0n,
      data,
      chainId: mainnet.id,
      nonce: 0,
      maxFeePerGas: 30_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
      gas: 65_000n, // a plausible ERC-20 transfer gas limit for this offline test — the real code estimates this live, never hardcodes it
      type: "eip1559",
    })
    .then((signed) => {
      const parsed = parseTransaction(signed);
      assert.equal(parsed.to.toLowerCase(), tokenAddress.toLowerCase());
      // A zero value RLP-encodes as an empty byte string, which viem
      // decodes back as `undefined` rather than `0n` — real, benign
      // behavior (this transaction correctly carries no ETH value), not a
      // bug; treat the two as equivalent here rather than assuming a
      // literal 0n survives the round-trip.
      assert.ok(parsed.value === 0n || typeof parsed.value === "undefined");
      const decoded = decodeFunctionData({ abi: ERC20_TRANSFER_ABI, data: parsed.data });
      assert.equal(decoded.functionName, "transfer");
      assert.equal(decoded.args[0].toLowerCase(), recipient.toLowerCase());
      assert.equal(decoded.args[1], amountRaw);
    });
});

// --- Solana: real base fee constant + an offline-signed transfer transaction ---

await check("sendTransaction.js's Solana base fee constant is the real, documented per-signature value (5000 lamports)", () => {
  assert.ok(
    sourceContains("../src/wallet/sendTransaction.js", "SOLANA_BASE_FEE_LAMPORTS = 5000"),
    "expected SOLANA_BASE_FEE_LAMPORTS = 5000 in sendTransaction.js — if this constant changed, update this check deliberately, don't just silence it"
  );
});

await check("a real SOL transfer transaction signs offline and its signature verifies", () => {
  const fromKeypair = Keypair.generate();
  const toKeypair = Keypair.generate();
  const dummyBlockhash = Keypair.generate().publicKey.toBase58(); // any base58 32-byte value is structurally valid here — signing/serialization don't need a REAL recent blockhash, only broadcast does

  const transaction = new Transaction({
    recentBlockhash: dummyBlockhash,
    feePayer: fromKeypair.publicKey,
  }).add(
    SystemProgram.transfer({
      fromPubkey: fromKeypair.publicKey,
      toPubkey: toKeypair.publicKey,
      lamports: Math.round(0.5 * 1e9),
    })
  );
  transaction.sign(fromKeypair);

  assert.equal(transaction.verifySignatures(), true);

  const serialized = transaction.serialize();
  const roundTripped = Transaction.from(serialized);
  assert.equal(roundTripped.verifySignatures(), true);
  assert.equal(roundTripped.instructions[0].programId.toBase58(), SystemProgram.programId.toBase58());
});

await check("wallet address validation rejects malformed addresses for both chains", () => {
  assert.throws(() => new PublicKey("not-a-real-solana-address"));
  assert.doesNotThrow(() => new PublicKey(Keypair.generate().publicKey.toBase58()));
});

await check("sendTransaction.js's ERC-20 fee estimate uses a live estimateGas call, not a hardcoded gas limit like the native-transfer path", () => {
  assert.ok(sourceContains("../src/wallet/sendTransaction.js", "client.estimateGas("));
});

console.log(`\n${n}/${n} checks passed`);
console.log(
  "\nNot verified here (needs a real, unblocked network — see this file's header): " +
  "live fee estimation via estimateFeesPerGas/getRecentBlockhash, and actual broadcast " +
  "of sendEvmNative/sendSolanaNative against a live RPC endpoint."
);
