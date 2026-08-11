import { createConfig, http } from "wagmi";
import { sepolia, baseSepolia, bscTestnet, mainnet, base, bsc } from "wagmi/chains";
import { injected, walletConnect } from "wagmi/connectors";
import { defineChain } from "viem";

// This is a WalletConnect/Reown *Project ID* — a public identifier used to
// register the app with WalletConnect's relay network, not a secret.
// It's safe to have in client-side code and committed to the repo.
const WALLETCONNECT_PROJECT_ID = "90386e6d00c461cd50f7e8a82e76d4b5";

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
};

const ALL_CHAINS = [sepolia, baseSepolia, bscTestnet, robinhoodTestnet, mainnet, base, bsc, robinhoodMainnet, stableMainnet];

export const config = createConfig({
  chains: ALL_CHAINS,
  connectors: [
    injected(),
    walletConnect({
      projectId: WALLETCONNECT_PROJECT_ID,
      metadata: {
        name: "Mango Protocol",
        description: "Cross-chain bridge",
        url: "https://mangoprotocol.site",
        icons: ["https://avatars.githubusercontent.com/u/37784886"],
      },
      showQrModal: true,
    }),
  ],
  transports: Object.fromEntries(ALL_CHAINS.map((c) => [c.id, http()])),
});
