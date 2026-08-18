// src/wallet/walletKeyImport.js
//
// Validates and normalizes a raw, user-supplied private key for import as
// a standalone account — NOT derived from the wallet's seed phrase, and
// (matching OKX Wallet's own real behavior, confirmed via research before
// building this) tied to exactly one chain: importing an EVM key doesn't
// give you a Solana address and vice versa, since there's no seed to
// derive a sibling chain's key from. An account created this way also
// can't have further accounts added under it later — only seed-phrase
// wallets support "add account".

import { Wallet as EthersWallet } from "ethers";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

export class KeyImportError extends Error {}

/** Parses+validates a raw EVM private key (hex, with or without 0x prefix). Throws KeyImportError with a user-safe message. */
export function parseEvmPrivateKey(rawInput) {
  const trimmed = rawInput.trim();
  const hex = trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) {
    throw new KeyImportError("That doesn't look like a valid EVM private key (expected 64 hex characters).");
  }
  try {
    const wallet = new EthersWallet(hex);
    return { chain: "evm", address: wallet.address, privateKey: wallet.privateKey };
  } catch {
    throw new KeyImportError("That EVM private key couldn't be parsed.");
  }
}

/** Parses+validates a raw Solana private key (base58-encoded 64-byte secret key — the standard export format). Throws KeyImportError with a user-safe message. */
export function parseSolanaPrivateKey(rawInput) {
  const trimmed = rawInput.trim();
  let secretKey;
  try {
    secretKey = bs58.decode(trimmed);
  } catch {
    throw new KeyImportError("That doesn't look like a valid Solana private key (expected a base58-encoded 64-byte secret key).");
  }
  if (secretKey.length !== 64) {
    throw new KeyImportError("That doesn't look like a valid Solana private key (expected a base58-encoded 64-byte secret key).");
  }
  try {
    const keypair = Keypair.fromSecretKey(secretKey);
    return { chain: "solana", address: keypair.publicKey.toBase58(), privateKey: bs58.encode(keypair.secretKey) };
  } catch {
    throw new KeyImportError("That Solana private key couldn't be parsed.");
  }
}

/** Tries EVM first, then Solana — lets the UI offer one input field rather than making the user pick a chain before they've even pasted anything. */
export function parseImportedPrivateKey(rawInput) {
  try {
    return parseEvmPrivateKey(rawInput);
  } catch {
    return parseSolanaPrivateKey(rawInput); // lets this one's real error surface if both fail
  }
}
