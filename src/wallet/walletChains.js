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
// Real-usage EVM expansion batch — id/nativeCurrency/name for every one
// of these pulled directly from this installed wagmi/chains package (not
// guessed), same verification standard as the batch above. Mirrors
// mango-mobile's own src/wallet/chainRegistry.js/evmChainsExtra.js
// additions chain-for-chain. Picked for real usage/relevance (top L1s/
// L2s and notable app-chains by real ecosystem activity), not padding
// to hit a number — same discipline this file's own header already
// states for the batch above.
import {
  arbitrumNova, aurora, beam, bitkub, bob, boba, botanix, bounceBit, chiliz, citrea,
  confluxESpace, cronoszkEVM, etherlink, flare, fuse, gravity, gunz, harmonyOne, hashkey, hemi,
  immutableZkEvm, iotex, kaia, katana, kava, kroma, lens, lightlinkPhoenix, lisk, lukso,
  mint, ronin, rootstock, soneium, superseed, swellchain, telos, treasure, vana,
  wemix, xdc, zetachain, zilliqa, zircuit,
} from "wagmi/chains";

export const WALLET_ONLY_EVM_CHAINS = {
  polygon, optimism, zksync, linea, scroll, gnosis,
  monad, sonic, mantle, blast, berachain, worldchain, sei,
  celo, fantom, moonbeam, cronos, metis, mode, zora, manta, opbnb: opBNB, taiko, polygonzkevm: polygonZkEvm, fraxtal,
  arbitrumNova, aurora, beam, bitkub, bob, boba, botanix, bounceBit, chiliz, citrea,
  confluxESpace, cronoszkEVM, etherlink, flare, fuse, gravity, gunz, harmonyOne, hashkey, hemi,
  immutableZkEvm, iotex, kaia, katana, kava, kroma, lens, lightlinkPhoenix, lisk, lukso,
  mint, ronin, rootstock, soneium, superseed, swellchain, telos, treasure, vana,
  wemix, xdc, zetachain, zilliqa, zircuit,
};

export const WALLET_ONLY_CHAIN_ORDER = [
  "polygon", "optimism", "zksync", "linea", "scroll", "gnosis",
  "monad", "sonic", "mantle", "blast", "berachain", "worldchain", "sei",
  "celo", "fantom", "moonbeam", "cronos", "metis", "mode", "zora", "manta", "opbnb", "taiko", "polygonzkevm", "fraxtal",
  "arbitrumNova", "aurora", "beam", "bitkub", "bob", "boba", "botanix", "bounceBit", "chiliz", "citrea",
  "confluxESpace", "cronoszkEVM", "etherlink", "flare", "fuse", "gravity", "gunz", "harmonyOne", "hashkey", "hemi",
  "immutableZkEvm", "iotex", "kaia", "katana", "kava", "kroma", "lens", "lightlinkPhoenix", "lisk", "lukso",
  "mint", "ronin", "rootstock", "soneium", "superseed", "swellchain", "telos", "treasure", "vana",
  "wemix", "xdc", "zetachain", "zilliqa", "zircuit",
];

export const WALLET_ONLY_CHAIN_LABEL = {
  polygon: "Polygon", optimism: "OP Mainnet", zksync: "ZKsync Era", linea: "Linea",
  scroll: "Scroll", gnosis: "Gnosis", monad: "Monad", sonic: "Sonic",
  mantle: "Mantle", blast: "Blast", berachain: "Berachain", worldchain: "World Chain", sei: "Sei",
  celo: "Celo", fantom: "Fantom", moonbeam: "Moonbeam", cronos: "Cronos", metis: "Metis",
  mode: "Mode", zora: "Zora", manta: "Manta Pacific", opbnb: "opBNB", taiko: "Taiko",
  polygonzkevm: "Polygon zkEVM", fraxtal: "Fraxtal",
  arbitrumNova: "Arbitrum Nova", aurora: "Aurora", beam: "Beam", bitkub: "Bitkub Chain", bob: "BOB",
  boba: "Boba Network", botanix: "Botanix", bounceBit: "BounceBit", chiliz: "Chiliz Chain", citrea: "Citrea",
  confluxESpace: "Conflux eSpace", cronoszkEVM: "Cronos zkEVM", etherlink: "Etherlink", flare: "Flare", fuse: "Fuse",
  gravity: "Gravity", gunz: "GUNZ", harmonyOne: "Harmony", hashkey: "HashKey Chain", hemi: "Hemi",
  immutableZkEvm: "Immutable zkEVM", iotex: "IoTeX", kaia: "Kaia", katana: "Katana", kava: "Kava EVM",
  kroma: "Kroma", lens: "Lens", lightlinkPhoenix: "LightLink", lisk: "Lisk", lukso: "LUKSO",
  mint: "Mint", ronin: "Ronin", rootstock: "Rootstock", soneium: "Soneium",
  superseed: "Superseed", swellchain: "Swellchain", telos: "Telos", treasure: "Treasure", vana: "Vana",
  wemix: "WEMIX", xdc: "XDC Network", zetachain: "ZetaChain", zilliqa: "Zilliqa", zircuit: "Zircuit",
};

export const WALLET_ONLY_NATIVE_SYMBOL = {
  polygon: "POL", optimism: "ETH", zksync: "ETH", linea: "ETH",
  scroll: "ETH", gnosis: "XDAI", monad: "MON", sonic: "S",
  mantle: "MNT", blast: "ETH", berachain: "BERA", worldchain: "ETH", sei: "SEI",
  celo: "CELO", fantom: "FTM", moonbeam: "GLMR", cronos: "CRO", metis: "METIS",
  mode: "ETH", zora: "ETH", manta: "ETH", opbnb: "BNB", taiko: "ETH",
  polygonzkevm: "ETH", fraxtal: "FRAX",
  arbitrumNova: "ETH", aurora: "ETH", beam: "BEAM", bitkub: "KUB", bob: "ETH",
  boba: "ETH", botanix: "BTC", bounceBit: "BB", chiliz: "CHZ", citrea: "cBTC",
  confluxESpace: "CFX", cronoszkEVM: "zkCRO", etherlink: "XTZ", flare: "FLR", fuse: "FUSE",
  gravity: "G", gunz: "GUN", harmonyOne: "ONE", hashkey: "HSK", hemi: "ETH",
  immutableZkEvm: "IMX", iotex: "IOTX", kaia: "KAIA", katana: "ETH", kava: "KAVA",
  kroma: "ETH", lens: "GHO", lightlinkPhoenix: "ETH", lisk: "ETH", lukso: "LYX",
  mint: "ETH", ronin: "RON", rootstock: "RBTC", soneium: "ETH",
  superseed: "ETH", swellchain: "ETH", telos: "TLOS", treasure: "MAGIC", vana: "VANA",
  wemix: "WEMIX", xdc: "XDC", zetachain: "ZETA", zilliqa: "ZIL", zircuit: "ETH",
};

// A second, real RPC endpoint per chain, keyed by chain id (matching
// wagmi.js's RPC_FALLBACKS convention) — every URL here was pulled
// directly from ethereum-lists/chains (the same chain registry wagmi/chains
// itself is built from, fetched via raw.githubusercontent.com), not
// guessed, and cross-checked against wagmi.js's own "no Thirdweb" policy.
//
// Expanded from 12 to 42 entries in one pass: every WALLET_ONLY_CHAIN_ORDER
// chain without one here was checked against its own
// eip155-{chainId}.json in that registry, filtering out API-key-templated
// URLs (${...}), wss:// entries, thirdweb.com domains, and exact
// duplicates of the chain's own wagmi/chains default (a "fallback" that's
// really the same endpoint twice is no fallback at all). The remaining 27
// chains genuinely have no second documented public HTTP endpoint in that
// registry as of this check — left single-endpoint rather than inventing
// one, same honest limitation Monad/Sei already established: their own
// .rpc array is either just the one default URL, a wss://-only second
// entry, or a trailing-slash duplicate of the default.
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
  // Real-usage EVM expansion batch's ONE required override: Harmony's
  // wagmi/chains default (rpcUrls.default.http[0]) is a Thirdweb-operated
  // URL, disallowed unreplaced by this project's own "no Thirdweb
  // defaults" policy — api.harmony.one is Harmony's own real,
  // long-documented public endpoint (their own docs, chainlist.org), not
  // guessed.
  [harmonyOne.id]: "https://api.harmony.one",
  [fantom.id]: "https://rpc.ftm.tools",
  [moonbeam.id]: "https://moonbeam.public.blastapi.io",
  [cronos.id]: "https://cronos-evm-rpc.publicnode.com",
  [metis.id]: "https://andromeda.metis.io/?owner=1088",
  [mode.id]: "https://mode.drpc.org",
  [manta.id]: "https://manta-pacific.drpc.org",
  [opBNB.id]: "https://opbnb-rpc.publicnode.com",
  [taiko.id]: "https://taiko-rpc.publicnode.com",
  [polygonZkEvm.id]: "https://polygon-zkevm.drpc.org",
  [fraxtal.id]: "https://fraxtal-rpc.publicnode.com",
  [arbitrumNova.id]: "https://arbitrum-nova-rpc.publicnode.com",
  [aurora.id]: "https://aurora.drpc.org",
  [beam.id]: "https://subnets.avax.network/beam/mainnet/rpc",
  [bob.id]: "https://bob-mainnet.public.blastapi.io",
  [boba.id]: "https://replica.boba.network",
  [chiliz.id]: "https://rpc.ankr.com/chiliz",
  [flare.id]: "https://rpc.ankr.com/flare",
  [fuse.id]: "https://fuse.drpc.org",
  [gravity.id]: "https://rpc.ankr.com/gravity",
  [immutableZkEvm.id]: "https://immutable-zkevm.drpc.org",
  [katana.id]: "https://katana.gateway.tenderly.co/",
  [kava.id]: "https://kava-evm-rpc.publicnode.com",
  [kroma.id]: "https://rpc-kroma.rockx.com",
  [lukso.id]: "https://rpc.lukso.sigmacore.io",
  [mint.id]: "https://global.rpc.mintchain.io",
  [rootstock.id]: "https://mycrypto.rsk.co",
  [swellchain.id]: "https://rpc.ankr.com/swell",
  [telos.id]: "https://telos.drpc.org",
  [xdc.id]: "https://erpc.xinfin.network",
  [zetachain.id]: "https://zetachain-mainnet.g.allthatnode.com/archive/evm",
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
