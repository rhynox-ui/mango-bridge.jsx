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

import { createClient, getClient, MAINNET_RELAY_API } from "@relayprotocol/relay-sdk";
import { configureDynamicChains } from "@relayprotocol/relay-sdk/chain-utils";
import { adaptSolanaWallet } from "@relayprotocol/relay-svm-wallet-adapter";

let clientInitialized = false;
let initPromise = null;

// Real fix for a real bug: the previous version manually listed only 5
// EVM chains via convertViemChainToRelayChain, which meant Solana was
// never registered in the client's own chain registry at all — hence
// "Unable to find chain: 792703809" the moment a Solana-sourced quote
// tried to use it. configureDynamicChains() is Relay's own documented
// way to fetch EVERY chain they support directly from their API,
// Solana included, rather than us manually enumerating them and
// inevitably missing one.
function ensureClientInitialized() {
  if (clientInitialized) return Promise.resolve();
  if (initPromise) return initPromise;
  initPromise = (async () => {
    let chains;
    try {
      chains = await configureDynamicChains();
    } catch (err) {
      throw new Error(`[configureDynamicChains] ${err?.message || String(err)}`);
    }

    try {
      createClient({
        baseApiUrl: MAINNET_RELAY_API,
        source: "mangoprotocol.site",
        chains,
        // Real, explicit logger — RelayClient has its own internal log()
        // method, and our crash ("reading 'log'") happening specifically
        // during client init suggests something in the default logger
        // setup path isn't completing cleanly. Providing our own simple
        // one bypasses whatever that internal default path is doing.
        logger: (message) => console.log("[relay-sdk]", message),
      });
    } catch (err) {
      throw new Error(`[createClient] ${err?.message || String(err)}`);
    }

    clientInitialized = true;
  })();
  return initPromise;
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
  try {
    await ensureClientInitialized();
  } catch (err) {
    throw new Error(`[client init step] ${err?.message || String(err)}`);
  }

  let connection, adaptedWallet;
  try {
    const { Connection } = await import("@solana/web3.js");
    connection = new Connection("https://api.mainnet-beta.solana.com", "confirmed");

    adaptedWallet = adaptSolanaWallet(
      solanaAddress,
      RELAY_SOLANA_CHAIN_ID,
      connection,
      async (transaction) => {
        const signed = await solanaProvider.signTransaction(transaction, `solana:mainnet`);
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
