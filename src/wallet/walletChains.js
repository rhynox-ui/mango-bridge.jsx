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
// project's existing "no Thirdweb defaults" policy (see wagmi.js) —
// wagmi/chains' default for Fantom is Thirdweb-operated, which is why
// Fantom isn't in this list (Sonic, its de facto successor, is).

import {
  polygon, optimism, zksync, linea, scroll, gnosis,
  monad, sonic, mantle, blast, berachain, worldchain, sei,
} from "wagmi/chains";

export const WALLET_ONLY_EVM_CHAINS = {
  polygon, optimism, zksync, linea, scroll, gnosis,
  monad, sonic, mantle, blast, berachain, worldchain, sei,
};

export const WALLET_ONLY_CHAIN_ORDER = [
  "polygon", "optimism", "zksync", "linea", "scroll", "gnosis",
  "monad", "sonic", "mantle", "blast", "berachain", "worldchain", "sei",
];

export const WALLET_ONLY_CHAIN_LABEL = {
  polygon: "Polygon", optimism: "OP Mainnet", zksync: "ZKsync Era", linea: "Linea",
  scroll: "Scroll", gnosis: "Gnosis", monad: "Monad", sonic: "Sonic",
  mantle: "Mantle", blast: "Blast", berachain: "Berachain", worldchain: "World Chain", sei: "Sei",
};

export const WALLET_ONLY_NATIVE_SYMBOL = {
  polygon: "POL", optimism: "ETH", zksync: "ETH", linea: "ETH",
  scroll: "ETH", gnosis: "XDAI", monad: "MON", sonic: "S",
  mantle: "MNT", blast: "ETH", berachain: "BERA", worldchain: "ETH", sei: "SEI",
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
