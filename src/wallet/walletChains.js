// src/wallet/walletChains.js
//
// EVM chains available in Mango Wallet but NOT (yet) in the Bridge's own
// chain list (chainData.js / wagmi.js's CHAIN_KEY_TO_WAGMI_MAINNET). The
// wallet's single EVM address (m/44'/60'/0'/0/0, see keys.js) is valid on
// every EVM chain by construction — adding a chain here costs zero new
// cryptography, only a verified chain id / native currency / RPC entry.
// That's NOT true for the Bridge, which also needs real routing/fee logic
// per chain (Relay support, canonical-bridge addresses, CCTP domains,
// etc.) — so this list deliberately stays wallet-only rather than
// silently also expanding what the Bridge tab offers, which is a much
// bigger, separate decision.
//
// Every chain below comes directly from wagmi/chains' own maintained
// definitions (id, nativeCurrency, default RPC) — same verification
// standard already used for every chain in this app, nothing hand-typed
// or guessed. Picked for real usage/relevance (top L1s/L2s by TVL or
// active addresses), not padding to hit a number — Monad in particular
// matches this project's own earlier research on where to expand next
// (live mainnet since Nov 2025, EVM-compatible, real CCTP bridge).
//
// Every default RPC below was independently checked against this
// project's existing "no Thirdweb defaults" policy (see wagmi.js).
// Fantom's wagmi/chains default IS Thirdweb-operated — rather than
// exclude it again now that mango-mobile's own chain list treats Fantom
// and Sonic as two genuinely separate chains (not an either/or), its
// Thirdweb default is overridden via wagmi.js/chainRegistry.js's own
// RPC_FALLBACKS map (keyed by chain id 250), the same mechanism already
// used to replace BNB Chain's Thirdweb default elsewhere in this project.
//
// Batch 2 (celo through fraxtal below): ported from mango-mobile's own
// already-shipped chain list (docs/CHAINS.md) — ids and native-currency
// symbols cross-checked directly against this repo's own installed
// wagmi/chains package, not copied blind. Their default RPCs are each
// chain's own official/foundation endpoint (confirmed non-Thirdweb via
// the same installed-package check), so — like Monad and Sei above —
// none has a WALLET_ONLY_RPC_FALLBACK entry: a real, verified single
// endpoint rather than a guessed second one.

import {
  polygon, optimism, zksync, linea, scroll, gnosis,
  monad, sonic, mantle, blast, berachain, worldchain, sei,
  celo, fantom, moonbeam, cronos, metis, mode, zora, manta, opBNB, taiko, polygonZkEvm, fraxtal,
} from "wagmi/chains";

export const WALLET_ONLY_EVM_CHAINS = {
  polygon, optimism, zksync, linea, scroll, gnosis,
  monad, sonic, mantle, blast, berachain, worldchain, sei,
  celo, fantom, moonbeam, cronos, metis, mode, zora, manta, opbnb: opBNB, taiko, polygonzkevm: polygonZkEvm, fraxtal,
};

export const WALLET_ONLY_CHAIN_ORDER = [
  "polygon", "optimism", "zksync", "linea", "scroll", "gnosis",
  "monad", "sonic", "mantle", "blast", "berachain", "worldchain", "sei",
  "celo", "fantom", "moonbeam", "cronos", "metis", "mode", "zora", "manta", "opbnb", "taiko", "polygonzkevm", "fraxtal",
];

export const WALLET_ONLY_CHAIN_LABEL = {
  polygon: "Polygon", optimism: "OP Mainnet", zksync: "ZKsync Era", linea: "Linea",
  scroll: "Scroll", gnosis: "Gnosis", monad: "Monad", sonic: "Sonic",
  mantle: "Mantle", blast: "Blast", berachain: "Berachain", worldchain: "World Chain", sei: "Sei",
  celo: "Celo", fantom: "Fantom", moonbeam: "Moonbeam", cronos: "Cronos", metis: "Metis",
  mode: "Mode", zora: "Zora", manta: "Manta Pacific", opbnb: "opBNB", taiko: "Taiko",
  polygonzkevm: "Polygon zkEVM", fraxtal: "Fraxtal",
};

export const WALLET_ONLY_NATIVE_SYMBOL = {
  polygon: "POL", optimism: "ETH", zksync: "ETH", linea: "ETH",
  scroll: "ETH", gnosis: "XDAI", monad: "MON", sonic: "S",
  mantle: "MNT", blast: "ETH", berachain: "BERA", worldchain: "ETH", sei: "SEI",
  celo: "CELO", fantom: "FTM", moonbeam: "GLMR", cronos: "CRO", metis: "METIS",
  mode: "ETH", zora: "ETH", manta: "ETH", opbnb: "BNB", taiko: "ETH",
  polygonzkevm: "ETH", fraxtal: "FRAX",
};

// A second, real RPC endpoint per chain, keyed by chain id (matching
// wagmi.js's RPC_FALLBACKS convention) — every URL here was pulled
// directly from ethereum-lists/chains (the same chain registry wagmi/chains
// itself is built from, fetched via raw.githubusercontent.com), not
// guessed, and cross-checked against wagmi.js's own "no Thirdweb" policy.
// Monad and Sei genuinely have no second documented public HTTP endpoint
// in that registry — left single-endpoint rather than inventing one.
export const WALLET_ONLY_RPC_FALLBACK = {
  [polygon.id]: "https://polygon-bor-rpc.publicnode.com",
  [optimism.id]: "https://optimism-rpc.publicnode.com",
  [zksync.id]: "https://zksync.drpc.org",
  [linea.id]: "https://linea-rpc.publicnode.com",
  [scroll.id]: "https://scroll-rpc.publicnode.com",
  [gnosis.id]: "https://rpc.ankr.com/gnosis",
  [sonic.id]: "https://sonic-rpc.publicnode.com",
  [mantle.id]: "https://mantle-rpc.publicnode.com",
  [blast.id]: "https://rpc.ankr.com/blast",
  [berachain.id]: "https://berachain-rpc.publicnode.com",
  [worldchain.id]: "https://worldchain-mainnet.gateway.tenderly.co",
};

// The @web3icons/react "Network*" icon for each chain is imported and
// mapped directly in MangoWallet.jsx (WALLET_ONLY_ICON), not here — as
// static, named imports, so bundlers can tree-shake them, rather than a
// string keyed into a dynamic lookup. Worth knowing when adding a chain
// here: several real export names don't follow the
// "NetworkPascalCaseChainName" pattern you'd guess (zkSync Era is
// NetworkZksync, World Chain is NetworkWorld, Sei is NetworkSeiNetwork) —
// confirmed via a live server-render check of the installed package, not
// assumed from the chain name.
