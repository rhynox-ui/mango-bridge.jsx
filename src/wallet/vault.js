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
// Schema v2 — accounts (unlimited, HD-derived under the one mnemonic,
// same real model OKX Wallet uses: seed-phrase wallets support "add
// account", private-key imports don't) plus standalone imported keys.
// v1 (single mnemonic, no accounts/imports) predates this and is treated
// as absent rather than migrated — this wallet was still gated behind
// WALLET_LIVE=false for its entire v1 lifetime, so there's no real
// user data to preserve.

const STORAGE_KEY = "mango_wallet_vault_v1"; // key name is legacy; the JSON payload itself is versioned (see below)
const VAULT_SCHEMA_VERSION = 2;
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
 * Persists the full vault: the encrypted mnemonic, how many HD accounts
 * exist, their (non-secret) cached addresses per chain/index, and any
 * standalone imported keys (each independently encrypted, same password).
 */
export function saveVault({ mnemonicRecord, accountCount, addresses, importedKeys }) {
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ version: VAULT_SCHEMA_VERSION, mnemonicRecord, accountCount, addresses, importedKeys: importedKeys ?? [] })
  );
}

export function loadVault() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed.version !== VAULT_SCHEMA_VERSION) return null; // pre-accounts v1 record — see module doc
    return parsed;
  } catch {
    return null;
  }
}

export function hasVault() {
  return loadVault() !== null;
}

/** Permanently deletes the local encrypted vault. Callers MUST have already made the user confirm they've backed up their recovery phrase — this cannot be undone. */
export function clearVault() {
  window.localStorage.removeItem(STORAGE_KEY);
}
