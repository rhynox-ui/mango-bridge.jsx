import { http } from "wagmi";
import { fallback } from "viem";
import {
  sepolia, baseSepolia, bscTestnet, mainnet, base, bsc,
  // Real, verified chain definitions from wagmi/viem's own maintained chain
  // list — checked against a live Node.js script confirming each id/native
  // currency/RPC matches independent research, rather than hand-defining
  // these via defineChain and risking a typo'd chain ID for a live chain.
  arbitrum, avalanche, abstract, hyperEvm, ink, plasma, unichain, xLayer,
} from "wagmi/chains";
import { defineChain } from "viem";
import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";

// ---------------------------------------------------------------------------
// Real fallback RPC endpoints, per chain — this app previously had NO
// fallback at all (one RPC per chain, no redundancy), and worse: wagmi's
// own built-in BNB Chain definition defaults to a Thirdweb-operated
// endpoint (56.rpc.thirdweb.com) — silently in use here by accident, not
// something anyone chose. Fixed below with BNB's own real, team-run
// endpoints as both primary and fallback. No chain in this list uses
// Thirdweb for anything.
//
// Every URL researched against each chain's own official docs or an
// authoritative chain registry (ethereum-lists/chains, DefiLlama's
// chainlist data) — not guessed. See the per-line comments for specifics
// worth knowing (rate limits, shared operators, etc).
//
// Third tier (Alchemy) is opt-in via VITE_ALCHEMY_API_KEY, never
// hardcoded — this repo is PUBLIC, and a raw API key committed to a
// public repo gets found and abused by scanning bots within hours, not
// weeks. Set VITE_ALCHEMY_API_KEY in .env.local for local dev, and as a
// real environment variable in your deploy platform (Vercel project
// settings) for production — see .env.example. If it's unset, every
// chain below just runs on its first two (free, no-key) tiers; nothing
// breaks, the app simply has one fewer fallback layer.
const ALCHEMY_API_KEY = import.meta.env.VITE_ALCHEMY_API_KEY;
function alchemyUrl(slug) {
  return ALCHEMY_API_KEY ? `https://${slug}.g.alchemy.com/v2/${ALCHEMY_API_KEY}` : null;
}

const RPC_FALLBACKS = {
  1: ["https://ethereum.reth.rs/rpc", "https://ethereum.publicnode.com"], // Ethereum — no Ethereum Foundation-run public RPC exists; viem's own current default (Paradigm's Reth node) plus PublicNode
  8453: ["https://mainnet.base.org", "https://base.publicnode.com"], // Base — official (Coinbase-run) + PublicNode
  56: ["https://bsc-dataseed.bnbchain.org", "https://bsc-dataseed1.defibit.io"], // BNB Chain — both real, team-run endpoints (the second is one of BNB Chain's own community-validator mirrors), replacing the Thirdweb default entirely
  42161: ["https://arb1.arbitrum.io/rpc", "https://arbitrum.publicnode.com"], // Arbitrum One — official (Offchain Labs) + PublicNode
  43114: ["https://api.avax.network/ext/bc/C/rpc", "https://avalanche.publicnode.com"], // Avalanche C-Chain — official (Ava Labs) + PublicNode
  2741: ["https://api.mainnet.abs.xyz", alchemyUrl("abstract-mainnet")], // Abstract — official + Alchemy (verified real endpoint)
  999: ["https://rpc.hyperliquid.xyz/evm", alchemyUrl("hyperliquid-mainnet")], // HyperEVM — official endpoint is rate-limited to 100 req/min per IP, so this fallback matters more here than anywhere else in this list
  57073: ["https://rpc-gel.inkonchain.com", "https://rpc-qnd.inkonchain.com"], // Ink — two genuinely different official operators (Gelato, QuickNode), both documented by Ink itself
  9745: ["https://rpc.plasma.to", alchemyUrl("plasma-mainnet")], // Plasma — official + Alchemy (verified real endpoint)
  130: ["https://mainnet.unichain.org", "https://unichain.publicnode.com"], // Unichain — official (Uniswap Labs) + PublicNode
  196: ["https://xlayerrpc.okx.com", "https://rpc.xlayer.tech"], // X Layer — both OKX-operated (no independent 3rd-party endpoint is documented), but genuinely two separate documented URLs
  4663: ["https://rpc.mainnet.chain.robinhood.com", "https://robinhood-rpc.publicnode.com"], // Robinhood Chain — official + PublicNode (third-party; Robinhood's own docs only list the one URL)
  988: ["https://rpc.stable.xyz", alchemyUrl("stable-mainnet")], // Stable — official (the only one Stable's own docs list) + Alchemy (verified real endpoint)
};

function transportFor(chainId) {
  const urls = (RPC_FALLBACKS[chainId] || []).filter(Boolean);
  if (urls.length === 0) return http(); // no override configured for this chain — fall back to its own chain-definition default
  // rank:true actively probes each endpoint's latency and block height and
  // prefers the healthiest one, rather than only advancing to the next
  // endpoint on a hard error — real protection against a "successful but
  // stale" response, not just a dead endpoint.
  return fallback(urls.map((url) => http(url)), { rank: true });
}

// This is a WalletConnect/Reown *Project ID* — a public identifier used to
// register the app with WalletConnect's relay network, not a secret.
// It's safe to have in client-side code and committed to the repo.
export const WALLETCONNECT_PROJECT_ID = "90386e6d00c461cd50f7e8a82e76d4b5";

// ---------------------------------------------------------------------------
// Robinhood Chain — both networks defined manually, since neither is in
// wagmi's built-in chain list. Values independently verified from
// docs.robinhood.com/chain — testnet and mainnet contract addresses are
// DIFFERENT despite both being "Robinhood Chain"; never assume one from
// the other (this exact mistake is why Arc needed its own careful check
// earlier in this project too).
// ---------------------------------------------------------------------------

export const robinhoodTestnet = defineChain({
  id: 46630,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.chain.robinhood.com"] } },
  blockExplorers: {
    default: { name: "Robinhood Chain Explorer", url: "https://explorer.testnet.chain.robinhood.com" },
  },
  testnet: true,
});

export const robinhoodMainnet = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
  blockExplorers: {
    default: { name: "Robinhood Chain Explorer", url: "https://robinhoodchain.blockscout.com" },
  },
  testnet: false,
});

// Stable — Tether's own L1, launched Dec 2025. Chain ID, RPC, and explorer
// all verified directly against Stable's own official docs
// (docs.stable.xyz/en/reference/connect/), cross-checked against
// chainlist.org and chainlist.wtf, which all agree.
export const stableMainnet = defineChain({
  id: 988,
  name: "Stable",
  nativeCurrency: { name: "USDT0", symbol: "USDT0", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.stable.xyz"] } },
  blockExplorers: {
    default: { name: "StableScan", url: "https://stablescan.xyz" },
  },
  testnet: false,
});

// ---------------------------------------------------------------------------
// Two complete, separate chain maps — deliberately not a single map with an
// "if mainnet" branch buried inside. Keeping testnet and mainnet definitions
// physically separate makes it much harder to accidentally cross-wire a
// mainnet chain key to a testnet contract address (or vice versa) somewhere
// downstream in cctp.js / arbbridge.js / wormholebridge.js.
// ---------------------------------------------------------------------------

export const CHAIN_KEY_TO_WAGMI_TESTNET = {
  ethereum: sepolia,
  base: baseSepolia,
  bnb: bscTestnet,
  robinhood: robinhoodTestnet,
};

export const CHAIN_KEY_TO_WAGMI_MAINNET = {
  ethereum: mainnet,
  base: base,
  bnb: bsc,
  robinhood: robinhoodMainnet,
  stable: stableMainnet,
  // Native-asset-only additions — each routes exclusively through Relay
  // (see chainData.js / getTransferKind()), not through CCTP or any other
  // native bridge integration. No canonical-bridge or CCTP contract
  // addresses were verified for these this session, so none are wired in;
  // only the chain id / native currency / RPC needed for wallet connect +
  // Relay routing, all sourced from wagmi's own maintained chain list.
  arbitrum: arbitrum,
  avalanche: avalanche,
  abstract: abstract,
  hyperevm: hyperEvm,
  ink: ink,
  plasma: plasma,
  unichain: unichain,
  xlayer: xLayer,
};

export const ALL_CHAINS = [
  sepolia, baseSepolia, bscTestnet, robinhoodTestnet,
  mainnet, base, bsc, robinhoodMainnet, stableMainnet,
  arbitrum, avalanche, abstract, hyperEvm, ink, plasma, unichain, xLayer,
];

// Real Reown AppKit wiring, layered on top of this exact chain list and
// project ID rather than replacing them — see src/appkit.js for the
// createAppKit() call that actually registers the wallet-connect modal.
// AppKit's WagmiAdapter is what builds the wagmi Config now (that's the
// only way its adapter model works — it owns config construction, it
// can't wrap an already-built Config instance), but every chain, RPC, and
// the WalletConnect project ID it uses are exactly the ones this project
// already had; nothing about ALL_CHAINS above changed for this.
export const wagmiAdapter = new WagmiAdapter({
  networks: ALL_CHAINS,
  projectId: WALLETCONNECT_PROJECT_ID,
  transports: Object.fromEntries(ALL_CHAINS.map((c) => [c.id, transportFor(c.id)])),
});

export const config = wagmiAdapter.wagmiConfig;
