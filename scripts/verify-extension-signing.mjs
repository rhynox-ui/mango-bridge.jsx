// scripts/verify-extension-signing.mjs
//
// Real, permanent regression check for extension/src/signing.js and
// extension/src/chains.js — the code that actually turns an approved
// popup request into a signature. Broadcast-dependent paths
// (signAndSendEvmTx, signAndSendSolanaTransaction) can't be exercised
// here for the same reason as scripts/verify-wallet-send.mjs: this
// sandbox's egress proxy blocks RPC traffic entirely. Everything that
// doesn't need a network — which is everything cryptographically
// meaningful — is verified for real: a signature produced by
// signing.js's own exported functions is independently recovered/
// verified via each chain's own real primitives, not just asserted to
// "not throw."
//
// Run: node scripts/verify-extension-signing.mjs

import assert from "node:assert";
import { recoverMessageAddress, recoverTypedDataAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { viemChainForId, DEFAULT_EVM_CHAIN_ID, SOLANA_RPC_ENDPOINTS } from "../extension/src/chains.js";
import { signEvmPersonalMessage, signEvmTypedData, signSolanaTransaction, signSolanaMessage } from "../extension/src/signing.js";

let n = 0;
async function check(label, fn) {
  await fn();
  n++;
  console.log(`ok ${n} - ${label}`);
}

// Same known test private key used elsewhere in this project's own
// offline-signing tests (scripts/verify-wallet-crypto.mjs,
// scripts/verify-wallet-send.mjs) — same known account, cross-checked
// independently every time it's reused.
const TEST_PRIVATE_KEY = `0x${"11".repeat(32)}`;
const TEST_ADDRESS = privateKeyToAccount(TEST_PRIVATE_KEY).address;

await check("chains.js: viemChainForId resolves Ethereum mainnet with a real RPC URL, not a guess", () => {
  const chain = viemChainForId(1);
  assert.equal(chain.name, "Ethereum");
  assert.ok(chain.rpcUrls.default.http[0].startsWith("https://"));
  assert.equal(DEFAULT_EVM_CHAIN_ID, 1);
});

await check("chains.js: viemChainForId returns null for an unrecognized chain id rather than guessing one", () => {
  // 999_999_999 turned out to be a real chain id (Zora Sepolia) — proof
  // this check is exercising viem's real chain table, not a stub. Using
  // an absurdly large id here instead, well past any real chain's range.
  assert.equal(viemChainForId(9_999_999_999_999), null);
});

await check("chains.js: Solana RPC endpoints are real, documented public endpoints", () => {
  assert.deepEqual(SOLANA_RPC_ENDPOINTS, ["https://rpc.solanatracker.io/public", "https://api.mainnet-beta.solana.com"]);
});

await check("signEvmPersonalMessage: a hex-encoded message signs and independently recovers to the signer's real address", async () => {
  const messageHex = "0x48656c6c6f204d616e676f"; // "Hello Mango"
  const signature = await signEvmPersonalMessage({ privateKeyHex: TEST_PRIVATE_KEY, message: messageHex });
  const recovered = await recoverMessageAddress({ message: { raw: messageHex }, signature });
  assert.equal(recovered.toLowerCase(), TEST_ADDRESS.toLowerCase());
});

await check("signEvmPersonalMessage: plain text (not hex) also signs and recovers correctly — some dApps send literal text", async () => {
  const signature = await signEvmPersonalMessage({ privateKeyHex: TEST_PRIVATE_KEY, message: "not hex at all" });
  const recovered = await recoverMessageAddress({ message: "not hex at all", signature });
  assert.equal(recovered.toLowerCase(), TEST_ADDRESS.toLowerCase());
});

await check("signEvmTypedData: a real EIP-712 payload signs and independently recovers to the signer's real address", async () => {
  const typedData = {
    domain: { name: "Mango Wallet Test", version: "1", chainId: 1 },
    types: { Mail: [{ name: "contents", type: "string" }] },
    primaryType: "Mail",
    message: { contents: "hello" },
  };
  const signature = await signEvmTypedData({ privateKeyHex: TEST_PRIVATE_KEY, typedDataJson: JSON.stringify(typedData) });
  const recovered = await recoverTypedDataAddress({ ...typedData, signature });
  assert.equal(recovered.toLowerCase(), TEST_ADDRESS.toLowerCase());
});

await check("signSolanaMessage: signs off-chain bytes with a real Ed25519 signature, independently verified via nacl itself", () => {
  const keypair = Keypair.generate();
  const secretKeyBase58 = bs58.encode(keypair.secretKey);
  const message = new TextEncoder().encode("Hello Mango");
  const signature = signSolanaMessage({ secretKeyBase58, messageBytes: Array.from(message) });
  assert.equal(signature.length, 64); // Ed25519 signatures are always 64 bytes
  const verified = nacl.sign.detached.verify(message, new Uint8Array(signature), keypair.publicKey.toBytes());
  assert.equal(verified, true);
});

await check("signSolanaMessage: a signature does NOT verify against a different keypair's public key (proves this isn't a no-op)", () => {
  const keypair = Keypair.generate();
  const otherKeypair = Keypair.generate();
  const message = new TextEncoder().encode("Hello Mango");
  const signature = signSolanaMessage({ secretKeyBase58: bs58.encode(keypair.secretKey), messageBytes: Array.from(message) });
  const verified = nacl.sign.detached.verify(message, new Uint8Array(signature), otherKeypair.publicKey.toBytes());
  assert.equal(verified, false);
});

await check("signSolanaTransaction: a real unsigned transaction round-trips through sign -> deserialize -> verifySignatures", async () => {
  const keypair = Keypair.generate();
  const recipient = Keypair.generate().publicKey;
  const tx = new Transaction({
    feePayer: keypair.publicKey,
    // A real, syntactically valid (if stale) blockhash — signing/serialization doesn't require a live one, only broadcast does.
    blockhash: "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k",
    lastValidBlockHeight: 1,
  }).add(SystemProgram.transfer({ fromPubkey: keypair.publicKey, toPubkey: recipient, lamports: 1000 }));
  const unsignedBase64 = tx.serialize({ requireAllSignatures: false }).toString("base64");

  const signedBase64 = await signSolanaTransaction({ secretKeyBase58: bs58.encode(keypair.secretKey), serializedTxBase64: unsignedBase64 });
  const signedTx = Transaction.from(Buffer.from(signedBase64, "base64"));
  assert.equal(signedTx.verifySignatures(), true);
  assert.ok(signedTx.signatures.some((s) => s.publicKey.equals(keypair.publicKey) && s.signature !== null));
});

console.log(`\n${n}/${n} checks passed`);
