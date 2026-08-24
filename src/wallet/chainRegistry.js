// src/wallet/chainRegistry.js
//
// Pure chain data — RPC fallback endpoints and viem chain definitions —
// for consumers that can't import src/wagmi.js: its `import.meta.env.
// VITE_ALCHEMY_API_KEY` top-level read only resolves under a real Vite
// build, and its Reown AppKit/WagmiAdapter wiring has real runtime side
// effects (creating a WalletConnect modal singleton) with no business
// running inside a browser-extension popup. extension/src/rpc.js is the
// intended consumer.
//
// Deliberately NOT wired into wagmi.js or src/wallet/walletRpc.js — both
// keep their own existing RPC_FALLBACKS (which layers in an optional
// Alchemy third tier wagmi.js's own env access provides) completely
// unchanged, so this file adds a new capability without touching
// anything the live site already depends on. The two fallback lists
// below are the same first two tiers as wagmi.js's own, independently
// sourced from each chain's official docs or a chain registry, just
// without that optional third tier — the extension never had an Alchemy
// key configured anyway, so this isn't a regression from anything it
// previously had.

import { http, fallback, defineChain } from "viem";
import { mainnet, base, bsc, arbitrum, avalanche, abstract, hyperEvm, ink, plasma, unichain, xLayer } from "viem/chains";

export const RPC_FALLBACKS = {
  1: ["https://ethereum.reth.rs/rpc", "https://ethereum.publicnode.com"],
  8453: ["https://mainnet.base.org", "https://base.publicnode.com"],
  56: ["https://bsc-dataseed.bnbchain.org", "https://bsc-dataseed1.defibit.io"],
  42161: ["https://arb1.arbitrum.io/rpc", "https://arbitrum.publicnode.com"],
  43114: ["https://api.avax.network/ext/bc/C/rpc", "https://avalanche.publicnode.com"],
  2741: ["https://api.mainnet.abs.xyz"],
  999: ["https://rpc.hyperliquid.xyz/evm"],
  57073: ["https://rpc-gel.inkonchain.com", "https://rpc-qnd.inkonchain.com"],
  9745: ["https://rpc.plasma.to"],
  130: ["https://mainnet.unichain.org", "https://unichain.publicnode.com"],
  196: ["https://xlayerrpc.okx.com", "https://rpc.xlayer.tech"],
  4663: ["https://rpc.mainnet.chain.robinhood.com", "https://robinhood-rpc.publicnode.com"],
  988: ["https://rpc.stable.xyz"],
  // Fantom — see wagmi.js's own copy of this entry for the full reasoning
  // (Thirdweb-default override, added for walletChains.js's wallet-only
  // chain list, not live-checked from this sandbox).
  250: ["https://rpcapi.fantom.network", "https://fantom-rpc.publicnode.com"],
};

export function transportFor(chainId) {
  const urls = (RPC_FALLBACKS[chainId] || []).filter(Boolean);
  if (urls.length === 0) return http();
  return fallback(urls.map((url) => http(url)), { rank: true });
}

// Robinhood Chain and Stable aren't in viem's own maintained chain list —
// defined manually, values independently verified from each chain's own
// docs (docs.robinhood.com/chain, docs.stable.xyz).
export const robinhoodMainnet = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
  blockExplorers: { default: { name: "Robinhood Chain Explorer", url: "https://robinhoodchain.blockscout.com" } },
  testnet: false,
});

export const stableMainnet = defineChain({
  id: 988,
  name: "Stable",
  nativeCurrency: { name: "USDT0", symbol: "USDT0", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.stable.xyz"] } },
  blockExplorers: { default: { name: "StableScan", url: "https://stablescan.xyz" } },
  testnet: false,
});

export const CHAIN_KEY_TO_WAGMI_MAINNET = {
  ethereum: mainnet,
  base: base,
  bnb: bsc,
  robinhood: robinhoodMainnet,
  stable: stableMainnet,
  arbitrum: arbitrum,
  avalanche: avalanche,
  abstract: abstract,
  hyperevm: hyperEvm,
  ink: ink,
  plasma: plasma,
  unichain: unichain,
  xlayer: xLayer,
};
