// src/wallet/keys.js
//
// Pure key-derivation logic for Mango Wallet — no storage, no UI, no
// server contact of any kind. Everything here runs entirely client-side:
// generate/validate a BIP-39 mnemonic, then derive EVM + Solana accounts
// from it, using the exact same derivation paths MetaMask and
// Phantom/Solflare use, so a Mango Wallet seed phrase imports cleanly
// into those wallets too (and vice versa) — this is a real interop
// property, not an incidental one.
//
// EVM:    m/44'/60'/0'/0/{index}   (ethers.js's own default path, index 0)
// Solana: m/44'/501'/{index}'/0'   (Phantom/Solflare's own "account N" path)
//
// Account 0 is the wallet's default identity; deriveAccountAtIndex(mnemonic,
// N) for N>0 is what backs "add account" — same real model OKX Wallet
// documents (a seed-phrase wallet supports unlimited HD-derived accounts;
// a private-key-imported one doesn't, since there's no seed to derive
// further from — see walletKeyImport.js for that separate path).

import * as bip39 from "bip39";
import { HDNodeWallet } from "ethers";
import { derivePath } from "ed25519-hd-key";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

export const EVM_DERIVATION_PATH = "m/44'/60'/0'/0/0";
export const SOLANA_DERIVATION_PATH = "m/44'/501'/0'/0'";

// The real, standard BIP-39 English wordlist (2048 words) — the same list
// bip39.generateMnemonic/validateMnemonic already check phrases against
// internally. Exported so the UI can offer real autocomplete while typing
// a recovery phrase, rather than guessing at word completions.
export const BIP39_WORDLIST = bip39.wordlists.english;

/** Up to `limit` real BIP-39 words starting with `prefix` (case-insensitive). Empty prefix returns no suggestions — nothing useful to suggest before the user's typed anything. */
export function suggestBip39Words(prefix, limit = 5) {
  const normalized = prefix.trim().toLowerCase();
  if (!normalized) return [];
  const out = [];
  for (const word of BIP39_WORDLIST) {
    if (word.startsWith(normalized)) {
      out.push(word);
      if (out.length >= limit) break;
    }
  }
  return out;
}

export function evmDerivationPathForIndex(index) {
  return `m/44'/60'/0'/0/${index}`;
}
export function solanaDerivationPathForIndex(index) {
  return `m/44'/501'/${index}'/0'`;
}

/** 12-word mnemonic — 128 bits of entropy, same default word count as MetaMask/Phantom. */
export function generateMnemonic() {
  return bip39.generateMnemonic(128);
}

/** Normalizes whitespace/case the way every major wallet's import field does, then validates against the BIP-39 wordlist + checksum. */
export function normalizeMnemonic(phrase) {
  return phrase.trim().toLowerCase().split(/\s+/).join(" ");
}

export function isValidMnemonic(phrase) {
  return bip39.validateMnemonic(normalizeMnemonic(phrase));
}

/**
 * Derives both chains' accounts at a given HD index from one mnemonic.
 * Returns raw private keys — callers must never log, persist, or
 * transmit the return value; it belongs in memory only, for the duration
 * of a signing operation or a user-initiated export.
 */
export function deriveAccountAtIndex(mnemonic, index) {
  const normalized = normalizeMnemonic(mnemonic);
  if (!bip39.validateMnemonic(normalized)) {
    throw new Error("Invalid recovery phrase — check the word order and spelling.");
  }
  if (!Number.isInteger(index) || index < 0) {
    throw new Error("Account index must be a non-negative integer.");
  }

  const evmWallet = HDNodeWallet.fromPhrase(normalized, undefined, evmDerivationPathForIndex(index));

  const seed = bip39.mnemonicToSeedSync(normalized);
  const seedHex = Buffer.from(seed).toString("hex");
  const { key } = derivePath(solanaDerivationPathForIndex(index), seedHex);
  const solanaKeypair = Keypair.fromSeed(key);

  return {
    evm: { address: evmWallet.address, privateKey: evmWallet.privateKey },
    solana: { address: solanaKeypair.publicKey.toBase58(), privateKey: bs58.encode(solanaKeypair.secretKey) },
  };
}

/** Account 0 — the wallet's default identity. Thin convenience wrapper kept for callers that only ever want the first account. */
export function deriveAccounts(mnemonic) {
  return deriveAccountAtIndex(mnemonic, 0);
}
