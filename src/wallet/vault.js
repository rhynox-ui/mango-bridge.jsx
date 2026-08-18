// src/wallet/vault.js
//
// Password-based local encryption for the wallet's recovery phrase.
// Everything here runs through the browser's native Web Crypto
// (SubtleCrypto) — no server contact, no third-party library implementing
// its own crypto primitives. The mnemonic never leaves this device in any
// form; only the encrypted blob below is ever written to localStorage.
//
// PBKDF2-SHA256 (600,000 iterations — OWASP's 2023 minimum recommendation
// for PBKDF2-HMAC-SHA256) turns the user's password into an AES-256-GCM
// key. GCM's authentication tag is what makes a wrong password fail loudly
// (decrypt throws) instead of silently returning garbage bytes.
//
// This module only ever handles ciphertext and public addresses. The
// plaintext mnemonic/private keys that pass through encryptMnemonic's
// input and decryptMnemonic's output are the caller's responsibility to
// discard from memory (and never log) once used.

const STORAGE_KEY = "mango_wallet_vault_v1";
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

/** Encrypts a mnemonic under a password. Returns the record to persist — does not write to storage itself. */
export async function encryptMnemonic(mnemonic, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveAesKey(password, salt, PBKDF2_ITERATIONS);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(mnemonic));
  return {
    version: 1,
    iterations: PBKDF2_ITERATIONS,
    salt: toBase64(salt),
    iv: toBase64(iv),
    ciphertext: toBase64(new Uint8Array(ciphertext)),
  };
}

/** Decrypts a stored record with a password. Throws (via GCM's auth tag) if the password is wrong or the record is corrupt. */
export async function decryptMnemonic(record, password) {
  const key = await deriveAesKey(password, fromBase64(record.salt), record.iterations);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(record.iv) }, key, fromBase64(record.ciphertext));
  return new TextDecoder().decode(plaintext);
}

/** Persists an encrypted vault record plus the (non-secret) derived addresses, so the UI can show "you have a wallet at 0x..." before unlocking. */
export function saveVault(encryptedRecord, addresses) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...encryptedRecord, addresses }));
}

export function loadVault() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
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
