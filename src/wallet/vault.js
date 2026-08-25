// src/wallet/vault.js
//
// Password-based local encryption for everything secret Mango Wallet
// stores: the recovery phrase, and any raw private keys imported directly
// (not derived from that phrase — see walletKeyImport.js). Everything
// here runs through the browser's native Web Crypto (SubtleCrypto) — no
// server contact, no third-party library implementing its own crypto
// primitives. Nothing plaintext ever leaves this device; only encrypted
// blobs are ever written to localStorage.
//
// PBKDF2-SHA256 (600,000 iterations — OWASP's 2023 minimum recommendation
// for PBKDF2-HMAC-SHA256) turns the user's password into an AES-256-GCM
// key. GCM's authentication tag is what makes a wrong password fail loudly
// (decrypt throws) instead of silently returning garbage bytes.
//
// This module only ever handles ciphertext and public addresses. Whatever
// plaintext passes through encryptSecret's input and decryptSecret's
// output is the caller's responsibility to discard from memory (and never
// log) once used.
//
// Schema v3 — multiple independent seed-phrase WALLETS (OKX's "Add
// wallet": a different seed entirely, each with its own unlimited set of
// HD-derived accounts) plus standalone imported keys, which stay a flat,
// non-nested list (matching OKX's own treatment: an imported key is its
// own single-account, single-chain entry, not nested under any wallet).
// All wallets share the one password set at onboarding — re-entering it
// is how "add wallet" and "add account" both prove they're not a
// stranger with browser access. v2 (a single implicit wallet, no
// multi-wallet support) and v1 before it are treated as absent rather
// than migrated — this wallet has been gated behind WALLET_LIVE=false for
// its entire pre-v3 lifetime, so there's no real user data to preserve.

const STORAGE_KEY = "mango_wallet_vault_v1"; // key name is legacy; the JSON payload itself is versioned (see below)
const VAULT_SCHEMA_VERSION = 3;
const PBKDF2_ITERATIONS = 600_000;

function toBase64(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}
function fromBase64(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function deriveAesKey(password, saltBytes, iterations) {
  const passwordKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: saltBytes, iterations, hash: "SHA-256" },
    passwordKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/** Encrypts any secret string (mnemonic, or one imported private key) under a password. Returns the record to persist — does not write to storage itself. */
export async function encryptSecret(secret, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveAesKey(password, salt, PBKDF2_ITERATIONS);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(secret));
  return {
    iterations: PBKDF2_ITERATIONS,
    salt: toBase64(salt),
    iv: toBase64(iv),
    ciphertext: toBase64(new Uint8Array(ciphertext)),
  };
}

/** Decrypts a stored record with a password. Throws (via GCM's auth tag) if the password is wrong or the record is corrupt. */
export async function decryptSecret(record, password) {
  const key = await deriveAesKey(password, fromBase64(record.salt), record.iterations);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(record.iv) }, key, fromBase64(record.ciphertext));
  return new TextDecoder().decode(plaintext);
}

/**
 * Persists the full vault: every seed-phrase wallet (each independently
 * encrypted, though all under the same password — see module doc) with
 * its own account count and account labels, plus any standalone imported
 * keys (each independently encrypted too).
 *
 * wallets: [{ id, label, mnemonicRecord, accountCount, accountLabels }]
 */
export function saveVault({ wallets, importedKeys }) {
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      version: VAULT_SCHEMA_VERSION,
      wallets: wallets ?? [],
      importedKeys: importedKeys ?? [],
    })
  );
}

export function loadVault() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed.version !== VAULT_SCHEMA_VERSION) return null; // pre-multi-wallet v1/v2 record — see module doc
    return parsed;
  } catch {
    return null;
  }
}

export function hasVault() {
  return loadVault() !== null;
}

/**
 * Decrypts the ENTIRE vault into the same { wallets, importedKeys,
 * activeKey } shape MangoWalletInner keeps in memory once unlocked —
 * every wallet's every HD account, and every imported key's private key.
 * Exported specifically so popup.js's separate dApp-approval unlock flow
 * (a plain-DOM screen, not the React MangoWalletTab component) can derive
 * the exact same full session MangoWalletInner's own handleUnlock does,
 * rather than a second, drifted copy of this same decryption loop. Throws
 * on a wrong password (via decryptSecret's GCM auth tag), same as
 * decryptSecret itself.
 */
export async function deriveFullVaultSession(vault, password, deriveAccountAtIndex) {
  const decryptedWallets = [];
  for (const w of vault.wallets) {
    const mnemonic = await decryptSecret(w.mnemonicRecord, password);
    const accounts = [];
    for (let i = 0; i < w.accountCount; i++) accounts.push(deriveAccountAtIndex(mnemonic, i));
    decryptedWallets.push({ id: w.id, label: w.label, accounts, accountLabels: w.accountLabels ?? {} });
  }
  const decryptedImports = await Promise.all(
    (vault.importedKeys ?? []).map(async (entry) => ({
      id: entry.id, chain: entry.chain, address: entry.address, label: entry.label,
      privateKey: await decryptSecret(entry.record, password),
    }))
  );
  return {
    wallets: decryptedWallets,
    importedKeys: decryptedImports,
    activeKey: { type: "hd", walletId: decryptedWallets[0].id, index: 0 },
  };
}

/** Permanently deletes the local encrypted vault. Callers MUST have already made the user confirm they've backed up their recovery phrase — this cannot be undone. */
export function clearVault() {
  window.localStorage.removeItem(STORAGE_KEY);
}
