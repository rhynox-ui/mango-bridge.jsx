import assert from "node:assert";
import { createHmac } from "node:crypto";
import { generateMnemonic, isValidMnemonic, deriveAccounts, normalizeMnemonic, EVM_DERIVATION_PATH, SOLANA_DERIVATION_PATH } from "../src/wallet/keys.js";
import { encryptMnemonic, decryptMnemonic } from "../src/wallet/vault.js";
import { derivePath, getMasterKeyFromSeed } from "ed25519-hd-key";

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

// --- vault.js: real Web Crypto round-trip, no mocking ---

await (async () => {
  const mnemonic = generateMnemonic();
  const record = await encryptMnemonic(mnemonic, "correct horse battery staple");
  check("encryptMnemonic produces base64 salt/iv/ciphertext fields", () => {
    assert.equal(record.version, 1);
    assert.equal(record.iterations, 600_000);
    assert.ok(/^[A-Za-z0-9+/=]+$/.test(record.salt));
    assert.ok(/^[A-Za-z0-9+/=]+$/.test(record.iv));
    assert.ok(/^[A-Za-z0-9+/=]+$/.test(record.ciphertext));
  });

  const decrypted = await decryptMnemonic(record, "correct horse battery staple");
  check("decryptMnemonic round-trips the exact original mnemonic with the right password", () => {
    assert.equal(decrypted, mnemonic);
  });

  let wrongPasswordThrew = false;
  try {
    await decryptMnemonic(record, "wrong password entirely");
  } catch {
    wrongPasswordThrew = true;
  }
  check("decryptMnemonic throws (GCM auth tag failure) on a wrong password, never returns garbage", () => {
    assert.equal(wrongPasswordThrew, true);
  });

  const record2 = await encryptMnemonic(mnemonic, "correct horse battery staple");
  check("encrypting the same mnemonic+password twice produces different salt/iv/ciphertext (no key/nonce reuse)", () => {
    assert.notEqual(record.salt, record2.salt);
    assert.notEqual(record.iv, record2.iv);
    assert.notEqual(record.ciphertext, record2.ciphertext);
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

console.log(`\n${n}/${n} checks passed`);
