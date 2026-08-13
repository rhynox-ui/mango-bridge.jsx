// src/relaySdkSolanaExecution.js
//
// Real execution path for Solana-SOURCED transfers, using Relay's own
// official SDK — not our hand-rolled REST integration in relaybridge.js.
//
// WHY THIS IS SEPARATE FROM relaybridge.js:
// Our existing executeRelayQuote() calls wagmi's switchChain/sendTransaction
// unconditionally, which only understands EVM chains. A Solana-sourced
// quote step needs genuinely different signing (a serialized Solana
// transaction, not EVM call data), which wagmi has no concept of.
//
// Confirmed directly from Relay's own official docs
// (docs.relay.link/references/relay-kit/sdk/adapters) that they provide
// a purpose-built helper for exactly this — adaptSolanaWallet — rather
// than us reverse-engineering the raw step format ourselves.
//
// GENUINE, NAMED UNCERTAINTY: two different package names appeared
// across sources during research — an older doc snippet referenced
// "@relayprotocol/relay-solana-wallet-adapter", while Relay's own GitHub
// releases page (a more current, direct source) shows
// "@relayprotocol/relay-svm-wallet-adapter" at a recent version (18.0.1).
// This file uses the GitHub-confirmed name as the more current one, but
// this genuinely needs a real, live test to confirm — not yet proven
// working the way the EVM path has been tonight.

import { createClient, getClient, convertViemChainToRelayChain, MAINNET_RELAY_API } from "@relayprotocol/relay-sdk";
import { adaptSolanaWallet } from "@relayprotocol/relay-svm-wallet-adapter";
import { mainnet, base, bsc } from "wagmi/chains";
import { robinhoodMainnet, stableMainnet } from "./wagmi.js";

let clientInitialized = false;
let initPromise = null;

// Real fix for a real, confirmed bug: configureDynamicChains() itself
// crashes internally ("Cannot read properties of undefined (reading
// 'log')") before createClient ever runs — confirmed via our own
// step-by-step error tracking, not guessed. Rather than keep chasing a
// bug inside that specific utility, this constructs the chain list
// explicitly instead, including a hand-built Solana entry using the
// real, confirmed RelayChain shape (verified against the actual
// installed type definition) and Solana's real, confirmed chain ID.
function ensureClientInitialized() {
  if (clientInitialized) return;
  if (initPromise) return initPromise;

  const solanaChain = {
    id: RELAY_SOLANA_CHAIN_ID,
    name: "solana",
    displayName: "Solana",
    vmType: "svm",
    currency: {
      id: "sol",
      symbol: "SOL",
      name: "Solana",
      address: "11111111111111111111111111111111",
      decimals: 9,
    },
  };

  createClient({
    baseApiUrl: MAINNET_RELAY_API,
    source: "mangoprotocol.site",
    chains: [
      convertViemChainToRelayChain(mainnet),
      convertViemChainToRelayChain(base),
      convertViemChainToRelayChain(bsc),
      convertViemChainToRelayChain(robinhoodMainnet),
      convertViemChainToRelayChain(stableMainnet),
      solanaChain,
    ],
    logger: (message) => console.log("[relay-sdk]", message),
  });
  clientInitialized = true;
  initPromise = Promise.resolve();
  return initPromise;
}

// Real Solana chain ID Relay uses internally — confirmed directly from
// their own SDK documentation, same value already verified and used in
// relaybridge.js tonight.
const RELAY_SOLANA_CHAIN_ID = 792703809;

// Protocol fee wallet for Solana-SOURCED transfers — a real Solana address,
// separate from DEV_FEE_WALLET in relaybridge.js (that one is EVM-only and
// cannot receive SOL). Same 1% rate as the EVM side, kept as its own visible
// on-chain transfer rather than bundled into the Relay deposit, matching the
// pattern sendRelayProtocolFee already uses for EVM-sourced transfers.
export const DEV_FEE_WALLET_SOLANA = "CFqNwTuTkqkaVoNZmNE6q5TeV6CcNwGRns2NSEY72Fu2";

/**
 * Sends the 1% protocol fee as a native SOL transfer, signed by the same
 * connected Solana wallet (OKX Connect) used for the transfer itself. Must
 * be called BEFORE executeSolanaSourcedTransfer with the reduced remainder,
 * same two-step pattern as sendRelayProtocolFee + getRelayQuote on the EVM
 * side.
 */
export async function sendSolanaProtocolFee({ solanaAddress, solanaProvider, feeBaseUnits }) {
  if (feeBaseUnits <= 0n) return null;

  const { Connection, PublicKey, SystemProgram, Transaction } = await import("@solana/web3.js");
  // Same public RPC endpoint used for the transfer execution below — the
  // default public Solana RPC disables sendTransaction for most callers,
  // confirmed as a real 403 earlier in this project.
  const connection = new Connection("https://rpc.solanatracker.io/public", "confirmed");

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const fromPubkey = new PublicKey(solanaAddress);
  const transaction = new Transaction({
    feePayer: fromPubkey,
    recentBlockhash: blockhash,
  }).add(
    SystemProgram.transfer({
      fromPubkey,
      toPubkey: new PublicKey(DEV_FEE_WALLET_SOLANA),
      lamports: feeBaseUnits,
    })
  );

  // Same CAIP-2 identifier and signing call already confirmed working
  // against OKX's installed solana-provider source, immediately below in
  // executeSolanaSourcedTransfer.
  const signed = await solanaProvider.signTransaction(transaction, `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`);
  const signature = await connection.sendRawTransaction(signed.serialize());
  await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  return signature;
}

/**
 * Executes a Solana-SOURCED transfer using Relay's official SDK and the
 * real, connected Solana wallet's actual sign-and-send capability (from
 * OKX Connect, via SolanaWalletContext).
 *
 * @param {string} solanaAddress - the real, connected Solana address
 * @param {object} solanaProvider - the OKX Solana provider instance (has signTransaction)
 * @param {object} quoteParams - { toChainKey wagmi chain id, toCurrency, amount, recipient }
 * @param {function} onProgress - real progress callback, same shape as Relay's own onProgress
 */
export async function executeSolanaSourcedTransfer({ solanaAddress, solanaProvider, toChainId, toCurrency, amountBaseUnits, recipient, onProgress }) {
  try {
    await ensureClientInitialized();
  } catch (err) {
    throw new Error(`[client init step] ${err?.message || String(err)}`);
  }

  let connection, adaptedWallet;
  try {
    const { Connection } = await import("@solana/web3.js");
    // Real fix for a real, confirmed limitation: Solana's own default
    // public endpoint explicitly disables sendTransaction for most
    // callers (confirmed via research, and hit directly as a real 403
    // tonight) — it's meant for light reads, not submitting real
    // transactions. Solana Tracker's public endpoint is confirmed as a
    // genuinely free, no-signup alternative that does support
    // sendTransaction.
    connection = new Connection("https://rpc.solanatracker.io/public", "confirmed");

    adaptedWallet = adaptSolanaWallet(
      solanaAddress,
      RELAY_SOLANA_CHAIN_ID,
      connection,
      async (transaction) => {
        // Real bug fix, confirmed against OKX's own installed source code
        // (solana-provider's getRealChainId function): it only accepts
        // strings starting with "svm" or ones in its own hardcoded caip
        // list, which includes Solana's real CAIP-2 identifier using its
        // genesis hash - "solana:mainnet" was never valid, matching
        // neither condition, which is exactly what threw "wrong chainId".
        const signed = await solanaProvider.signTransaction(transaction, `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`);
        const signature = await connection.sendRawTransaction(signed.serialize());
        return { signature };
      }
    );
  } catch (err) {
    throw new Error(`[wallet adapt step] ${err?.message || String(err)}`);
  }

  let quote;
  try {
    quote = await getClient().actions.getQuote({
      chainId: RELAY_SOLANA_CHAIN_ID,
      toChainId,
      currency: "11111111111111111111111111111111", // native SOL, confirmed placeholder
      toCurrency,
      amount: amountBaseUnits,
      tradeType: "EXACT_INPUT",
      wallet: adaptedWallet,
      user: solanaAddress,
      recipient: recipient || solanaAddress,
    });
  } catch (err) {
    throw new Error(`[getQuote step] ${err?.message || String(err)}`);
  }

  let result;
  try {
    result = await getClient().actions.execute({
      quote,
      wallet: adaptedWallet,
      onProgress,
    });
  } catch (err) {
    throw new Error(`[execute step] ${err?.message || String(err)}`);
  }

  return result;
}
