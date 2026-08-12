// src/appkit.js
//
// Real Reown AppKit wiring. Gives the EVM side a full, searchable 500+
// wallet directory (Trust Wallet, Binance Wallet, SafePal, MetaMask, and
// everything else in Reown's WalletConnect registry) instead of the old
// hand-rolled "injected + WalletConnect QR" list, and gives the Solana
// side Phantom, Solflare, Coinbase, and Trust via the real
// @solana/wallet-adapter-wallets adapters AppKit's own SolanaAdapter
// accepts directly.
//
// GENUINE, NAMED GAP: @solana/wallet-adapter-wallets (verified against
// the actual installed package, not assumed) does NOT export adapters for
// Backpack or Glow — those packages were deprecated in favor of both
// wallets self-registering via the Solana Wallet Standard instead.
// SolanaAdapter's registerWalletStandard option (on by default) auto-
// discovers Wallet-Standard wallets the same way EIP-6963 auto-discovers
// EVM ones, so Backpack and Glow still appear in the connect view when
// actually installed — just via that path, not an explicit adapter here.
//
// OKX Wallet for Solana is deliberately kept OUT of this, on its own,
// already-proven SolanaWalletContext.jsx / OKX Connect path. Two real
// reasons: (1) OKX's extension likely also announces itself via the
// Solana Wallet Standard, which SolanaAdapter auto-discovers — routing
// OKX through both paths risks two divergent "OKX" entries; (2) the
// actual Solana-sourced execution path (relaySdkSolanaExecution.js) has
// only ever been exercised against OKX's specific provider shape.
//
// Layered on top of the existing wagmi setup, not replacing it: the
// WagmiAdapter here (from wagmi.js) is built from the exact same chain
// list (ALL_CHAINS) and the exact same WalletConnect project ID this
// project already had — see wagmi.js for why AppKit still has to be the
// one constructing the wagmi Config itself.

import { PhantomWalletAdapter, SolflareWalletAdapter, CoinbaseWalletAdapter, TrustWalletAdapter } from "@solana/wallet-adapter-wallets";
import { createAppKit } from "@reown/appkit/react";
import { solana } from "@reown/appkit/networks";
import { SolanaAdapter } from "@reown/appkit-adapter-solana";
import { wagmiAdapter, CHAIN_KEY_TO_WAGMI_MAINNET, WALLETCONNECT_PROJECT_ID } from "./wagmi.js";

// Real, mainnet-only network list — deliberately NOT the same ALL_CHAINS
// wagmi.js hands to WagmiAdapter (which includes sepolia / baseSepolia /
// bscTestnet / robinhoodTestnet, kept there only for possible future
// testnet development per networkMode.js's own comment, and reachable by
// nothing else in this app: getWagmiChain()/getChainKeyMap() only ever
// resolve through CHAIN_KEY_TO_WAGMI_MAINNET). Advertising those same
// testnets to AppKit as connectable networks was a real bug: AppKit picks
// networks[0] as an implicit default even with no explicit
// `defaultNetwork` set, and ALL_CHAINS[0] is sepolia — so AppKit was
// silently issuing its own switchChain(to Sepolia) on every fresh wallet
// connection, racing whatever chain the app itself actually wants. That's
// what was really behind the "network switch prompted multiple times"
// bug reported from a real wallet connection — not a Launchpad-only bug.
const MAINNET_EVM_CHAINS = Object.values(CHAIN_KEY_TO_WAGMI_MAINNET);

// Real, official Solana mainnet CaipNetwork from Reown's own package —
// its id ("5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp") is the same genesis hash
// already used as SOLANA_MAINNET across this codebase, confirmed by
// reading the installed package source, not assumed.
export { solana as solanaNetwork };

// Real bug, found live: metadata.url below used to be hardcoded to
// "https://mangoprotocol.site". The site is actually served at
// "https://www.mangoprotocol.site" (confirmed both from a real browser
// console warning — Reown's own SDK flags this exact mismatch as
// "probably unintended and can lead to issues" — and from live
// wallet-connect logs showing repeated failed session-restore attempts
// and a growing EventEmitter listener count, consistent with
// WalletConnect session verification failing against the wrong origin
// and retrying). Deriving this from window.location.origin at runtime
// means it always matches whatever domain actually served the page,
// instead of this file having to guess or hardcode one.
const SITE_URL = typeof window !== "undefined" ? window.location.origin : "https://mangoprotocol.site";

export const solanaAdapter = new SolanaAdapter({
  wallets: [
    new PhantomWalletAdapter(),
    new SolflareWalletAdapter(),
    new CoinbaseWalletAdapter(),
    new TrustWalletAdapter(),
  ],
});

export const appKit = createAppKit({
  adapters: [wagmiAdapter, solanaAdapter],
  networks: [...MAINNET_EVM_CHAINS, solana],
  // No defaultNetwork set on purpose — nothing here should force a
  // network switch on connect at all. Each part of the app (Bridge,
  // Launchpad) already handles its own wrong-network guidance
  // contextually; AppKit forcing its own choice (see MAINNET_EVM_CHAINS
  // comment above) is exactly the bug this file is fixing.
  projectId: WALLETCONNECT_PROJECT_ID,
  metadata: {
    name: "Mango Protocol",
    description: "Cross-chain bridge and Uniswap v4 launchpad",
    url: SITE_URL,
    icons: [`${SITE_URL}/logo.png`],
  },
  // Deliberately narrowed down from AppKit's defaults to just wallet
  // connection — this app is strictly non-custodial (see CLAUDE.md /
  // SAS.md), so email/social embedded-wallet login, swaps, and on-ramp
  // (all on by default) are explicitly turned off rather than silently
  // shipped.
  features: {
    email: false,
    socials: false,
    swaps: false,
    onramp: false,
    receive: false,
    send: false,
    history: false,
    analytics: false,
  },
  // Real behavior preservation: AppKit's own default for EVM accounts is
  // 'smartAccount' (ERC-4337), not a plain EOA. Pinning this to 'eoa'
  // keeps every existing signing/sending assumption elsewhere in this
  // app (wagmi's sendTransaction, switchChain, etc.) exactly as it was
  // before this change.
  defaultAccountTypes: { eip155: "eoa" },
});
