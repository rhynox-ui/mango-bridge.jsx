// extension/src/chains.js
//
// EVM chain lookup for the extension popup, deliberately NOT reusing
// src/wagmi.js's CHAIN_KEY_TO_WAGMI_MAINNET — that file reads
// import.meta.env.VITE_ALCHEMY_API_KEY at module top level and pulls in
// wagmi's full AppKit/connector dependency tree, neither of which
// resolves outside a real Vite build (confirmed while writing this
// project's offline verification scripts — see scripts/verify-wallet-
// send.mjs's module doc). The extension is bundled with plain esbuild,
// no Vite, so it needs its own dependency-light path instead.
//
// viem/chains already ships a real chain definition — including a real
// public default RPC endpoint — for every EVM chain it knows about, keyed
// by chainId. Indexing all of them by numeric chainId, rather than
// hand-maintaining a second copy of Mango's own chain list, means this
// stays correct for any chain a dApp asks to switch to, not just the 27
// the main site's Wallet tab knows by name.

import * as viemChains from "viem/chains";

const CHAIN_ID_TO_VIEM_CHAIN = {};
for (const value of Object.values(viemChains)) {
  if (value && typeof value === "object" && typeof value.id === "number" && !CHAIN_ID_TO_VIEM_CHAIN[value.id]) {
    CHAIN_ID_TO_VIEM_CHAIN[value.id] = value;
  }
}

export function viemChainForId(chainId) {
  return CHAIN_ID_TO_VIEM_CHAIN[chainId] ?? null;
}

export const DEFAULT_EVM_CHAIN_ID = 1; // Ethereum mainnet — matches every other wallet's default before a dApp asks to switch

// Real, publicly documented Solana mainnet endpoints — the same primary
// this project already uses elsewhere (src/solanaRpc.js), plus Solana
// Labs' own public RPC as a fallback. Not fetched or guessed.
export const SOLANA_RPC_ENDPOINTS = ["https://rpc.solanatracker.io/public", "https://api.mainnet-beta.solana.com"];
