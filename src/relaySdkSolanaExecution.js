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

// Real, one-time setup — creates Relay's global client instance, exactly
// as their own docs specify. Called lazily on first use rather than at
// module load, so it doesn't run before the rest of the app is ready.
function ensureClientInitialized() {
  if (clientInitialized) return;
  createClient({
    baseApiUrl: MAINNET_RELAY_API,
    source: "mangoprotocol.site",
    chains: [
      convertViemChainToRelayChain(mainnet),
      convertViemChainToRelayChain(base),
      convertViemChainToRelayChain(bsc),
      convertViemChainToRelayChain(robinhoodMainnet),
      convertViemChainToRelayChain(stableMainnet),
    ],
  });
  clientInitialized = true;
}

// Real Solana chain ID Relay uses internally — confirmed directly from
// their own SDK documentation, same value already verified and used in
// relaybridge.js tonight.
const RELAY_SOLANA_CHAIN_ID = 792703809;

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
  ensureClientInitialized();

  // GENUINE, NAMED GAP: adaptSolanaWallet's documented signature expects a
  // Solana web3.js Connection object's sendTransaction method, not OKX
  // Connect's own signTransaction method directly — these are NOT the
  // same shape. A real Connection (from @solana/web3.js) genuinely needs
  // to be constructed here, and OKX's signed transaction needs to be
  // submitted through it. This adapter function bridges that gap, but
  // has NOT been tested against a real transaction yet — this is the
  // next real thing to verify once this is live.
  const { Connection } = await import("@solana/web3.js");
  const connection = new Connection("https://api.mainnet-beta.solana.com", "confirmed");

  const adaptedWallet = adaptSolanaWallet(
    solanaAddress,
    RELAY_SOLANA_CHAIN_ID,
    connection,
    async (transaction) => {
      // Real bridge between OKX's signing method and what Relay's
      // adapter expects — sign via OKX, then submit via the Connection.
      const signed = await solanaProvider.signTransaction(transaction, `solana:mainnet`);
      return connection.sendRawTransaction(signed.serialize());
    }
  );

  const quote = await getClient().actions.getQuote({
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

  const result = await getClient().actions.execute({
    quote,
    wallet: adaptedWallet,
    onProgress,
  });

  return result;
}
