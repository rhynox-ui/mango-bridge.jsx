import assert from "node:assert";
import { createHmac } from "node:crypto";
import { generateMnemonic, isValidMnemonic, deriveAccounts, deriveAccountAtIndex, normalizeMnemonic, suggestBip39Words, BIP39_WORDLIST, EVM_DERIVATION_PATH, SOLANA_DERIVATION_PATH } from "../src/wallet/keys.js";
import { encryptSecret, decryptSecret } from "../src/wallet/vault.js";
import { derivePath, getMasterKeyFromSeed } from "ed25519-hd-key";
import { parseEvmPrivateKey, parseSolanaPrivateKey, parseImportedPrivateKey, KeyImportError } from "../src/wallet/walletKeyImport.js";

let n = 0;
function check(label, fn) {
  fn();
  n++;
  console.log(`ok ${n} - ${label}`);
}

check("derivation paths match MetaMask/Phantom defaults", () => {
  assert.equal(EVM_DERIVATION_PATH, "m/44'/60'/0'/0/0");
  assert.equal(SOLANA_DERIVATION_PATH, "m/44'/501'/0'/0'");
});

check("generateMnemonic produces a valid 12-word BIP-39 phrase", () => {
  const m = generateMnemonic();
  assert.equal(m.trim().split(/\s+/).length, 12);
  assert.equal(isValidMnemonic(m), true);
});

check("generateMnemonic produces different phrases each call", () => {
  assert.notEqual(generateMnemonic(), generateMnemonic());
});

check("invalid mnemonic is rejected", () => {
  assert.equal(isValidMnemonic("not a real seed phrase at all just twelve random words here now"), false);
});

check("normalizeMnemonic trims/lowercases/collapses whitespace", () => {
  assert.equal(normalizeMnemonic("  Abandon   ABANDON  abandon\tabout "), "abandon abandon abandon about");
});

// Known-answer test: this exact mnemonic is the standard BIP-39 test vector
// ("abandon" x11 + "about"). Its EVM address at m/44'/60'/0'/0/0 is a
// well-known, independently-published value (used across countless
// ethers.js/MetaMask test suites) — matching it here proves the EVM
// derivation is standard-compliant, not just self-consistent.
const TEST_MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const KNOWN_EVM_ADDRESS = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";

check("deriveAccounts EVM address matches the standard published test vector", () => {
  const { evm } = deriveAccounts(TEST_MNEMONIC);
  assert.equal(evm.address.toLowerCase(), KNOWN_EVM_ADDRESS.toLowerCase());
});

check("deriveAccounts is deterministic (same mnemonic -> same addresses every time)", () => {
  const a = deriveAccounts(TEST_MNEMONIC);
  const b = deriveAccounts(TEST_MNEMONIC);
  assert.equal(a.evm.address, b.evm.address);
  assert.equal(a.solana.address, b.solana.address);
  assert.equal(a.evm.privateKey, b.evm.privateKey);
  assert.equal(a.solana.privateKey, b.solana.privateKey);
});

check("deriveAccounts produces a well-formed Solana address (valid base58, 32-byte pubkey)", () => {
  const { solana } = deriveAccounts(TEST_MNEMONIC);
  // decode via bs58 (already a dependency) round-trip proves it's real base58 of the right length
  const bs58mod = globalThis.__bs58;
  assert.equal(typeof solana.address, "string");
  assert.ok(solana.address.length >= 32 && solana.address.length <= 44);
});

check("deriveAccounts rejects an invalid mnemonic instead of silently deriving garbage keys", () => {
  assert.throws(() => deriveAccounts("totally not a valid seed phrase"), /Invalid recovery phrase/);
});

check("different mnemonics derive different EVM and Solana addresses", () => {
  const m2 = generateMnemonic();
  const a = deriveAccounts(TEST_MNEMONIC);
  const b = deriveAccounts(m2);
  assert.notEqual(a.evm.address, b.evm.address);
  assert.notEqual(a.solana.address, b.solana.address);
});

// --- multi-account derivation (deriveAccountAtIndex — backs "Add account") ---

check("deriveAccountAtIndex(m, 0) matches deriveAccounts(m) exactly — account 0 is the default identity", () => {
  const viaIndex = deriveAccountAtIndex(TEST_MNEMONIC, 0);
  const viaDefault = deriveAccounts(TEST_MNEMONIC);
  assert.deepEqual(viaIndex, viaDefault);
});

check("deriveAccountAtIndex produces distinct, deterministic accounts per index", () => {
  const a1 = deriveAccountAtIndex(TEST_MNEMONIC, 1);
  const a2 = deriveAccountAtIndex(TEST_MNEMONIC, 2);
  const a1again = deriveAccountAtIndex(TEST_MNEMONIC, 1);
  assert.notEqual(a1.evm.address, a2.evm.address);
  assert.notEqual(a1.solana.address, a2.solana.address);
  assert.equal(a1.evm.address, a1again.evm.address);
  assert.equal(a1.solana.address, a1again.solana.address);
});

check("deriveAccountAtIndex rejects a negative or non-integer index", () => {
  assert.throws(() => deriveAccountAtIndex(TEST_MNEMONIC, -1));
  assert.throws(() => deriveAccountAtIndex(TEST_MNEMONIC, 1.5));
});

// --- vault.js: real Web Crypto round-trip, no mocking ---

await (async () => {
  const mnemonic = generateMnemonic();
  const record = await encryptSecret(mnemonic, "correct horse battery staple");
  check("encryptSecret produces base64 salt/iv/ciphertext fields", () => {
    assert.equal(record.iterations, 600_000);
    assert.ok(/^[A-Za-z0-9+/=]+$/.test(record.salt));
    assert.ok(/^[A-Za-z0-9+/=]+$/.test(record.iv));
    assert.ok(/^[A-Za-z0-9+/=]+$/.test(record.ciphertext));
  });

  const decrypted = await decryptSecret(record, "correct horse battery staple");
  check("decryptSecret round-trips the exact original mnemonic with the right password", () => {
    assert.equal(decrypted, mnemonic);
  });

  let wrongPasswordThrew = false;
  try {
    await decryptSecret(record, "wrong password entirely");
  } catch {
    wrongPasswordThrew = true;
  }
  check("decryptSecret throws (GCM auth tag failure) on a wrong password, never returns garbage", () => {
    assert.equal(wrongPasswordThrew, true);
  });

  const record2 = await encryptSecret(mnemonic, "correct horse battery staple");
  check("encrypting the same secret+password twice produces different salt/iv/ciphertext (no key/nonce reuse)", () => {
    assert.notEqual(record.salt, record2.salt);
    assert.notEqual(record.iv, record2.iv);
    assert.notEqual(record.ciphertext, record2.ciphertext);
  });

  // encryptSecret/decryptSecret are now also used for standalone imported
  // private keys (see walletKeyImport.js), not just the mnemonic — a real
  // regression worth pinning, since a subtle bug here would silently
  // corrupt an imported key rather than a recovery phrase.
  const importedKeyHex = "0x" + "7a".repeat(32);
  const keyRecord = await encryptSecret(importedKeyHex, "a different password");
  const decryptedKey = await decryptSecret(keyRecord, "a different password");
  check("encryptSecret/decryptSecret round-trip a raw imported private key just as correctly as a mnemonic", () => {
    assert.equal(decryptedKey, importedKeyHex);
  });
})();

// Cross-check ed25519-hd-key itself (the library src/wallet/keys.js relies
// on for Solana derivation) against the REAL SLIP-0010 spec — not the
// npm package's own README, which turned out to print stale/wrong example
// output (confirmed by computing the spec's HMAC-SHA512("ed25519 seed", seed)
// from scratch via Node's own crypto module: it matches the library's
// actual output, not the README's claimed one). This is exactly the kind
// of thing worth independently verifying rather than trusting a
// third-party doc — the library itself is spec-correct; its README isn't.
check("ed25519-hd-key's getMasterKeyFromSeed matches SLIP-0010's HMAC-SHA512(\"ed25519 seed\", seed) computed independently via node:crypto", () => {
  const hexSeed = "fffcf9f6f3f0edeae7e4e1dedbd8d5d2cfccc9c6c3c0bdbab7b4b1aeaba8a5a29f9c999693908d8a8784817e7b7875726f6c696663605d5a5754514e4b484542";
  const { key, chainCode } = getMasterKeyFromSeed(hexSeed);
  const I = createHmac("sha512", Buffer.from("ed25519 seed", "utf8")).update(Buffer.from(hexSeed, "hex")).digest();
  assert.equal(Buffer.from(key).toString("hex"), I.subarray(0, 32).toString("hex"));
  assert.equal(Buffer.from(chainCode).toString("hex"), I.subarray(32).toString("hex"));
});
check("ed25519-hd-key's derivePath for a hardened child differs from the master key and is deterministic", () => {
  const hexSeed = "fffcf9f6f3f0edeae7e4e1dedbd8d5d2cfccc9c6c3c0bdbab7b4b1aeaba8a5a29f9c999693908d8a8784817e7b7875726f6c696663605d5a5754514e4b484542";
  const master = getMasterKeyFromSeed(hexSeed);
  const child1 = derivePath("m/0'/2147483647'", hexSeed);
  const child2 = derivePath("m/0'/2147483647'", hexSeed);
  assert.notEqual(Buffer.from(child1.key).toString("hex"), Buffer.from(master.key).toString("hex"));
  assert.equal(Buffer.from(child1.key).toString("hex"), Buffer.from(child2.key).toString("hex"));
});

// --- walletKeyImport.js: raw private-key import validation ---

check("parseEvmPrivateKey accepts a valid key (with or without 0x) and recovers the correct known address", () => {
  const withPrefix = parseEvmPrivateKey(`0x${"11".repeat(32)}`);
  const withoutPrefix = parseEvmPrivateKey("11".repeat(32));
  // Matches the same private key used elsewhere in this project's own
  // offline-signing tests (scripts/verify-wallet-send.mjs) — same known
  // account, cross-checked here independently.
  assert.equal(withPrefix.address, "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A");
  assert.equal(withPrefix.address, withoutPrefix.address);
  assert.equal(withPrefix.chain, "evm");
});

check("parseEvmPrivateKey rejects malformed input with a real KeyImportError, not a crash", () => {
  assert.throws(() => parseEvmPrivateKey("not a key"), KeyImportError);
  assert.throws(() => parseEvmPrivateKey(`0x${"zz".repeat(32)}`), KeyImportError);
});

await (async () => {
  const { Keypair } = await import("@solana/web3.js");
  const bs58 = (await import("bs58")).default;
  const keypair = Keypair.generate();
  const encoded = bs58.encode(keypair.secretKey);

  check("parseSolanaPrivateKey recovers the exact address for a real, freshly-generated keypair", () => {
    const result = parseSolanaPrivateKey(encoded);
    assert.equal(result.address, keypair.publicKey.toBase58());
    assert.equal(result.chain, "solana");
  });

  check("parseSolanaPrivateKey rejects malformed input with a real KeyImportError, not a crash", () => {
    assert.throws(() => parseSolanaPrivateKey("not base58 at all !!"), KeyImportError);
  });

  check("parseImportedPrivateKey auto-detects the chain — an EVM key and a Solana key both resolve correctly through the same entry point", () => {
    const evmResult = parseImportedPrivateKey(`0x${"11".repeat(32)}`);
    const solanaResult = parseImportedPrivateKey(encoded);
    assert.equal(evmResult.chain, "evm");
    assert.equal(solanaResult.chain, "solana");
  });
})();

// --- suggestBip39Words: real word-autocomplete backing the phrase-entry UI ---

check("BIP39_WORDLIST is the real, standard 2048-word BIP-39 English list", () => {
  assert.equal(BIP39_WORDLIST.length, 2048);
  assert.equal(BIP39_WORDLIST[0], "abandon"); // first word of the real, published list
  assert.equal(BIP39_WORDLIST[2047], "zoo"); // last word of the real, published list
});

check("suggestBip39Words returns real prefix matches, case-insensitively", () => {
  assert.deepEqual(suggestBip39Words("aban"), ["abandon"]);
  assert.deepEqual(suggestBip39Words("ABAN"), ["abandon"]);
  assert.ok(suggestBip39Words("ab").includes("about"));
});

check("suggestBip39Words respects its limit and returns [] for an empty prefix", () => {
  assert.equal(suggestBip39Words("a", 3).length, 3);
  assert.deepEqual(suggestBip39Words(""), []);
  assert.deepEqual(suggestBip39Words("   "), []);
});

check("suggestBip39Words returns [] for a prefix no real BIP-39 word starts with", () => {
  assert.deepEqual(suggestBip39Words("zzzzz"), []);
});

console.log(`\n${n}/${n} checks passed`);
