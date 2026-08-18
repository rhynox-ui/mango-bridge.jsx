// extension/src/signing.js
//
// The only place in the extension that turns a decrypted private key into
// an actual signature or broadcast transaction — called exclusively from
// popup.js, after the user has explicitly approved one specific request.
// Deliberately separate from src/wallet/sendTransaction.js: that module
// is opinionated about Mango Wallet's own native/token-transfer UI (an
// amount + a recipient it already knows the asset for); a dApp's
// eth_sendTransaction can be an arbitrary contract call with arbitrary
// calldata, which needs a more general signer.

import { createWalletClient, http, isHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Connection, Keypair, Transaction, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { viemChainForId, SOLANA_RPC_ENDPOINTS } from "./chains.js";

export class UnsupportedChainError extends Error {}

function toBigIntOrUndefined(v) {
  if (v === undefined || v === null) return undefined;
  return typeof v === "bigint" ? v : BigInt(v);
}

/** Signs and broadcasts an arbitrary EVM transaction (a dApp's eth_sendTransaction) on the given chainId. Returns the tx hash. */
export async function signAndSendEvmTx({ chainId, privateKeyHex, txParams }) {
  const chain = viemChainForId(chainId);
  if (!chain) throw new UnsupportedChainError(`Mango Wallet doesn't recognize chain id ${chainId}.`);
  const account = privateKeyToAccount(privateKeyHex);
  const client = createWalletClient({ account, chain, transport: http() });
  return client.sendTransaction({
    to: txParams.to,
    value: toBigIntOrUndefined(txParams.value),
    data: txParams.data,
    gas: toBigIntOrUndefined(txParams.gas),
    gasPrice: toBigIntOrUndefined(txParams.gasPrice),
    maxFeePerGas: toBigIntOrUndefined(txParams.maxFeePerGas),
    maxPriorityFeePerGas: toBigIntOrUndefined(txParams.maxPriorityFeePerGas),
  });
}

/** personal_sign — signs a message's raw bytes if given as 0x-hex (the EIP-1193 convention), or the literal text otherwise (some dApps send plain text). */
export async function signEvmPersonalMessage({ privateKeyHex, message }) {
  const account = privateKeyToAccount(privateKeyHex);
  return account.signMessage({ message: isHex(message) ? { raw: message } : message });
}

/** eth_signTypedData_v4 — typedDataJson is the raw JSON string a dApp sends; parsing it here (not in the caller) keeps a malformed payload's error attributable to this step. */
export async function signEvmTypedData({ privateKeyHex, typedDataJson }) {
  const account = privateKeyToAccount(privateKeyHex);
  const typedData = JSON.parse(typedDataJson);
  return account.signTypedData(typedData);
}

function keypairFromSecret(secretKeyBase58) {
  return Keypair.fromSecretKey(bs58.decode(secretKeyBase58));
}

function deserializeSolanaTx(serializedBase64) {
  const bytes = Buffer.from(serializedBase64, "base64");
  try {
    return { tx: VersionedTransaction.deserialize(bytes), versioned: true };
  } catch {
    return { tx: Transaction.from(bytes), versioned: false };
  }
}

/** Signs a Solana transaction without broadcasting it — the dApp's own code sends it (Phantom/Wallet-Standard's signTransaction contract). Returns base64. */
export async function signSolanaTransaction({ secretKeyBase58, serializedTxBase64 }) {
  const keypair = keypairFromSecret(secretKeyBase58);
  const { tx, versioned } = deserializeSolanaTx(serializedTxBase64);
  if (versioned) tx.sign([keypair]);
  else tx.partialSign(keypair);
  return Buffer.from(tx.serialize()).toString("base64");
}

/** Signs AND broadcasts — Phantom/Wallet-Standard's signAndSendTransaction contract. Returns the signature. */
export async function signAndSendSolanaTransaction({ secretKeyBase58, serializedTxBase64 }) {
  const keypair = keypairFromSecret(secretKeyBase58);
  const { tx, versioned } = deserializeSolanaTx(serializedTxBase64);
  if (versioned) tx.sign([keypair]);
  else tx.partialSign(keypair);
  const raw = tx.serialize();
  let lastError;
  for (const endpoint of SOLANA_RPC_ENDPOINTS) {
    try {
      const connection = new Connection(endpoint, "confirmed");
      return await connection.sendRawTransaction(raw, { skipPreflight: false });
    } catch (err) {
      lastError = err; // deliberately no retry-on-the-next-endpoint-after-a-real-broadcast — see sendTransaction.js's own module doc for why a signed broadcast is never retried across transports
      break;
    }
  }
  throw lastError;
}

/** Off-chain message signing (Phantom/Wallet-Standard's signMessage contract) — plain Ed25519 over the raw bytes, no transaction involved. */
export function signSolanaMessage({ secretKeyBase58, messageBytes }) {
  const keypair = keypairFromSecret(secretKeyBase58);
  const signature = nacl.sign.detached(new Uint8Array(messageBytes), keypair.secretKey);
  return Array.from(signature);
}
