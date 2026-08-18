// src/wallet/keys.js
//
// Pure key-derivation logic for Mango Wallet — no storage, no UI, no
// server contact of any kind. Everything here runs entirely client-side:
// generate/validate a BIP-39 mnemonic, then derive one EVM account and one
// Solana account from it, using the exact same derivation paths MetaMask
// and Phantom/Solflare use, so a Mango Wallet seed phrase imports cleanly
// into those wallets too (and vice versa) — this is a real interop
// property, not an incidental one.
//
// EVM:    m/44'/60'/0'/0/0   (ethers.js's own default path)
// Solana: m/44'/501'/0'/0'   (Phantom/Solflare's default "account 0" path)

import * as bip39 from "bip39";
import { HDNodeWallet } from "ethers";
import { derivePath } from "ed25519-hd-key";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

export const EVM_DERIVATION_PATH = "m/44'/60'/0'/0/0";
export const SOLANA_DERIVATION_PATH = "m/44'/501'/0'/0'";

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
 * Derives both chains' accounts from one mnemonic. Returns raw private
 * keys — callers must never log, persist, or transmit the return value;
 * it belongs in memory only, for the duration of a signing operation or a
 * user-initiated export.
 */
export function deriveAccounts(mnemonic) {
  const normalized = normalizeMnemonic(mnemonic);
  if (!bip39.validateMnemonic(normalized)) {
    throw new Error("Invalid recovery phrase — check the word order and spelling.");
  }

  const evmWallet = HDNodeWallet.fromPhrase(normalized, undefined, EVM_DERIVATION_PATH);

  const seed = bip39.mnemonicToSeedSync(normalized);
  const seedHex = Buffer.from(seed).toString("hex");
  const { key } = derivePath(SOLANA_DERIVATION_PATH, seedHex);
  const solanaKeypair = Keypair.fromSeed(key);

  return {
    evm: { address: evmWallet.address, privateKey: evmWallet.privateKey },
    solana: { address: solanaKeypair.publicKey.toBase58(), privateKey: bs58.encode(solanaKeypair.secretKey) },
  };
}
