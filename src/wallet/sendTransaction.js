// src/wallet/sendTransaction.js
//
// Real signing + broadcast for Mango Wallet — native-asset and verified
// ERC-20/SPL token sends, one chain family at a time. Everything here signs
// with the private key already held in memory from the unlocked session
// (see MangoWallet.jsx's session state) — nothing here ever persists or
// transmits that key anywhere except as a locally-computed signature.
//
// EVM sends reuse walletRpc.js's fallback transport (safe here — retrying
// an identical already-signed raw transaction against a second RPC node is
// idempotent; Ethereum nodes dedupe by tx hash, so a duplicate submission
// is a no-op, not a double-send). Solana sends deliberately do NOT use a
// fallback transport for the broadcast itself — see
// getWalletSolanaConnection's own comment for why that one case is
// different.

import { parseEther, parseUnits, encodeFunctionData } from "viem";
import { getWalletPublicClient, getWalletClientFor, getWalletSolanaConnection } from "./walletRpc.js";

const ERC20_TRANSFER_ABI = [
  { type: "function", name: "transfer", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "nonpayable" },
];

const EVM_NATIVE_TRANSFER_GAS_LIMIT = 21_000n; // protocol-fixed cost of a plain native transfer, same on every EVM chain

/**
 * Real fee estimate for a native EVM transfer — the actual EIP-1559
 * formula (gasLimit x (baseFee + priorityFee)), not a guess: baseFee and
 * priorityFee come from a live call to the chain's own RPC
 * (estimateFeesPerGas), gasLimit is the protocol constant above. Returns
 * both the wei breakdown (for building the transaction) and the
 * human-readable native-currency amount (for display before the user
 * confirms) — same "show the real fee before you confirm" principle the
 * Bridge tab already follows.
 */
export async function estimateEvmSendFee(chainKey) {
  const client = getWalletPublicClient(chainKey);
  const { maxFeePerGas, maxPriorityFeePerGas } = await client.estimateFeesPerGas();
  const feeWei = EVM_NATIVE_TRANSFER_GAS_LIMIT * maxFeePerGas;
  return {
    gasLimit: EVM_NATIVE_TRANSFER_GAS_LIMIT,
    maxFeePerGas,
    maxPriorityFeePerGas,
    feeNative: Number(feeWei) / 1e18,
  };
}

/**
 * Sends native currency (ETH/AVAX/POL/etc.) from the wallet's derived EVM
 * account. Caller is responsible for having already shown the user the
 * real fee (estimateEvmSendFee) and gotten explicit confirmation — this
 * function broadcasts immediately once called, no further confirmation
 * gate inside it.
 */
export async function sendEvmNative({ chainKey, privateKeyHex, toAddress, amountEth }) {
  const walletClient = await getWalletClientFor(chainKey, privateKeyHex);
  const { maxFeePerGas, maxPriorityFeePerGas } = await estimateEvmSendFee(chainKey);
  const hash = await walletClient.sendTransaction({
    to: toAddress,
    value: parseEther(String(amountEth)),
    gas: EVM_NATIVE_TRANSFER_GAS_LIMIT,
    maxFeePerGas,
    maxPriorityFeePerGas,
  });
  return { hash };
}

/**
 * Real fee estimate for an ERC-20 transfer. Unlike a plain native
 * transfer, an ERC-20 transfer's gas cost is NOT a fixed protocol
 * constant — it depends on the token contract's own logic (some tokens
 * do more than a bare balance update) — so gasLimit here comes from a
 * live estimateGas call against the real encoded transfer, not a guess.
 */
export async function estimateEvmTokenSendFee({ chainKey, tokenAddress, fromAddress, toAddress, amountRaw }) {
  const client = getWalletPublicClient(chainKey);
  const data = encodeFunctionData({ abi: ERC20_TRANSFER_ABI, functionName: "transfer", args: [toAddress, amountRaw] });
  const [gasLimit, { maxFeePerGas, maxPriorityFeePerGas }] = await Promise.all([
    client.estimateGas({ account: fromAddress, to: tokenAddress, data }),
    client.estimateFeesPerGas(),
  ]);
  const feeWei = gasLimit * maxFeePerGas;
  return { gasLimit, maxFeePerGas, maxPriorityFeePerGas, feeNative: Number(feeWei) / 1e18 };
}

/**
 * Sends an ERC-20 token from the wallet's derived EVM account. amountToken
 * is the human-readable amount (e.g. "12.5"); parsed against the token's
 * own real decimals, never assumed to be 18 like a native asset.
 */
export async function sendEvmToken({ chainKey, privateKeyHex, tokenAddress, tokenDecimals, toAddress, amountToken }) {
  const walletClient = await getWalletClientFor(chainKey, privateKeyHex);
  const amountRaw = parseUnits(String(amountToken), tokenDecimals);
  const { gasLimit, maxFeePerGas, maxPriorityFeePerGas } = await estimateEvmTokenSendFee({
    chainKey, tokenAddress, fromAddress: walletClient.account.address, toAddress, amountRaw,
  });
  const hash = await walletClient.writeContract({
    address: tokenAddress,
    abi: ERC20_TRANSFER_ABI,
    functionName: "transfer",
    args: [toAddress, amountRaw],
    gas: gasLimit,
    maxFeePerGas,
    maxPriorityFeePerGas,
  });
  return { hash };
}

// Solana's per-signature base fee — a real, fixed, protocol-defined
// constant (5000 lamports), not fetched from RPC because it doesn't need
// to be: this has been Solana's documented base fee since mainnet launch
// and a plain SOL transfer needs exactly one signature. Doesn't include an
// optional priority fee (skipped for this first version — see this file's
// module doc for what's not built yet).
export const SOLANA_BASE_FEE_LAMPORTS = 5000;

export function estimateSolanaSendFee() {
  return { feeLamports: SOLANA_BASE_FEE_LAMPORTS, feeSol: SOLANA_BASE_FEE_LAMPORTS / 1e9 };
}

/** Sends SOL from the wallet's derived Solana account. Same "caller confirms first" contract as sendEvmNative. */
export async function sendSolanaNative({ secretKeyBase58, toAddress, amountSol }) {
  const [{ Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction }, bs58Module, connection] = await Promise.all([
    import("@solana/web3.js"),
    import("bs58"),
    getWalletSolanaConnection(),
  ]);
  const bs58 = bs58Module.default;
  const fromKeypair = Keypair.fromSecretKey(bs58.decode(secretKeyBase58));
  const toPublicKey = new PublicKey(toAddress);

  const transaction = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: fromKeypair.publicKey,
      toPubkey: toPublicKey,
      lamports: Math.round(amountSol * 1e9),
    })
  );

  const signature = await sendAndConfirmTransaction(connection, transaction, [fromKeypair]);
  return { signature };
}

/**
 * Real fee estimate for an SPL token transfer. Always includes the base
 * signature fee; ALSO includes real rent-exemption cost for the
 * recipient's associated token account (ATA) when it doesn't exist yet —
 * checked live against the connection, not assumed either way, since the
 * sender pays that rent only if account creation is actually needed.
 */
export async function estimateSplSendFee({ mintAddress, toAddress }) {
  const [{ PublicKey }, { getAssociatedTokenAddress, ACCOUNT_SIZE }, connection] = await Promise.all([
    import("@solana/web3.js"),
    import("@solana/spl-token"),
    getWalletSolanaConnection(),
  ]);
  const toAta = await getAssociatedTokenAddress(new PublicKey(mintAddress), new PublicKey(toAddress));
  const ataInfo = await connection.getAccountInfo(toAta);
  const needsAtaCreation = ataInfo === null;
  const ataRentLamports = needsAtaCreation ? await connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE) : 0;
  const feeLamports = SOLANA_BASE_FEE_LAMPORTS + ataRentLamports;
  return { feeLamports, feeSol: feeLamports / 1e9, needsAtaCreation };
}

/**
 * Sends an SPL token from the wallet's derived Solana account, creating
 * the recipient's associated token account first if it doesn't exist yet
 * (paid for by the sender, same as every other Solana wallet's behavior —
 * there's no way to send an SPL token into an account that can't hold it).
 */
export async function sendSplToken({ secretKeyBase58, mintAddress, mintDecimals, toAddress, amountToken }) {
  const [
    { Keypair, PublicKey, Transaction, sendAndConfirmTransaction },
    { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, createTransferInstruction },
    bs58Module,
    connection,
  ] = await Promise.all([
    import("@solana/web3.js"),
    import("@solana/spl-token"),
    import("bs58"),
    getWalletSolanaConnection(),
  ]);
  const bs58 = bs58Module.default;
  const fromKeypair = Keypair.fromSecretKey(bs58.decode(secretKeyBase58));
  const mintPublicKey = new PublicKey(mintAddress);
  const toPublicKey = new PublicKey(toAddress);

  const fromAta = await getAssociatedTokenAddress(mintPublicKey, fromKeypair.publicKey);
  const toAta = await getAssociatedTokenAddress(mintPublicKey, toPublicKey);
  const toAtaInfo = await connection.getAccountInfo(toAta);

  const transaction = new Transaction();
  if (toAtaInfo === null) {
    transaction.add(createAssociatedTokenAccountInstruction(fromKeypair.publicKey, toAta, toPublicKey, mintPublicKey));
  }
  const amountRaw = BigInt(Math.round(amountToken * 10 ** mintDecimals));
  transaction.add(createTransferInstruction(fromAta, toAta, fromKeypair.publicKey, amountRaw));

  const signature = await sendAndConfirmTransaction(connection, transaction, [fromKeypair]);
  return { signature };
}
