import { createConfig, http } from "wagmi";
import { sepolia, baseSepolia, bscTestnet } from "wagmi/chains";
import { injected, walletConnect } from "wagmi/connectors";
import { defineChain } from "viem";

// This is a WalletConnect/Reown *Project ID* — a public identifier used to
// register the app with WalletConnect's relay network, not a secret.
// It's safe to have in client-side code and committed to the repo.
const WALLETCONNECT_PROJECT_ID = "90386e6d00c461cd50f7e8a82e76d4b5";

// Robinhood Chain Testnet isn't in wagmi's built-in chain list yet, so it's
// defined manually here using the official values from docs.robinhood.com/chain
export const robinhoodTestnet = defineChain({
  id: 46630,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.testnet.chain.robinhood.com"] },
  },
  blockExplorers: {
    default: {
      name: "Robinhood Chain Explorer",
      url: "https://explorer.testnet.chain.robinhood.com",
    },
  },
  testnet: true,
});

// Maps this app's internal chain keys (used throughout the UI) to the
// actual wagmi/viem chain objects used for real RPC calls.
export const CHAIN_KEY_TO_WAGMI = {
  ethereum: sepolia,
  base: baseSepolia,
  bnb: bscTestnet,
  robinhood: robinhoodTestnet,
};

export const config = createConfig({
  chains: [sepolia, baseSepolia, bscTestnet, robinhoodTestnet],
  connectors: [
    injected(),
    walletConnect({
      projectId: WALLETCONNECT_PROJECT_ID,
      metadata: {
        name: "Mango Bridge",
        description: "Cross-chain testnet bridge prototype",
        url: "https://mango-bridge-jsx.vercel.app",
        icons: ["https://avatars.githubusercontent.com/u/37784886"],
      },
      showQrModal: true,
    }),
  ],
  transports: {
    [sepolia.id]: http(),
    [baseSepolia.id]: http(),
    [bscTestnet.id]: http(),
    [robinhoodTestnet.id]: http(),
  },
});
