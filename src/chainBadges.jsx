// src/chainBadges.jsx
//
// Chain icon rendering — ChainBadge (icon + optional tinted-circle
// background) and its ChainIcon helper — extracted from App.jsx so it
// can be imported by anything that can't pull in the rest of that file
// (wagmi, Reown AppKit, Relay SDK, and their real runtime side effects).
// The extension's popup is the reason this exists: it needs the exact
// same chain badges the main site renders, without any of that.
//
// Deliberately self-contained: just @web3icons/react's real, verified
// icon exports (see App.jsx's own import comment for how those were
// confirmed) plus a per-chain accent color for the tinted-circle
// background — not the full CHAINS_MAINNET/CHAINS_TESTNET data App.jsx
// still owns for its own Bridge-specific UI (fee estimates, explorer
// URLs, etc.), which this file has no need for and doesn't touch.

import {
  NetworkEthereum, NetworkBase, NetworkBinanceSmartChain,
  NetworkArbitrumOne, NetworkAvalanche, NetworkAbstract, NetworkHyperEvm, NetworkInk, NetworkPlasma, NetworkUnichain, NetworkXLayer,
  NetworkStable, NetworkRobinhood,
  // Wallet-only chains (walletChains.js's own 25-chain list, now also
  // offered as Bridge routes — see App.jsx) — the exact same icon exports
  // already verified working in MangoWallet.jsx's own WALLET_ONLY_ICON map
  // (that file's own comment documents the live server-render check these
  // names were confirmed against, including the non-obvious ones: zkSync
  // Era is NetworkZksync, World Chain is NetworkWorld, Sei is
  // NetworkSeiNetwork). opBNB has no matching icon anywhere in
  // @web3icons/react (checked directly, same as that file found) — handled
  // as its own tinted-circle special case below, not listed here.
  NetworkPolygon, NetworkOptimism, NetworkZksync, NetworkLinea, NetworkScroll, NetworkGnosis,
  NetworkMonad, NetworkSonic, NetworkMantle, NetworkBlast, NetworkBerachain, NetworkWorld, NetworkSeiNetwork,
  NetworkCelo, NetworkFantom, NetworkMoonbeam, NetworkCronos, NetworkMetisAndromeda, NetworkMode,
  NetworkZora, NetworkMantaPacific, NetworkTaiko, NetworkPolygonZkevm, NetworkFraxtal,
} from "@web3icons/react";
import { useState } from "react";

// Same accent colors CHAINS_MAINNET in App.jsx defines per chain — kept
// as a separate, minimal copy here rather than importing that object,
// since pulling in App.jsx at all is exactly what this file exists to
// avoid (see module doc above). Wallet-only chain colors are each
// chain's own real, public brand color (same standard as every color
// above) — cosmetic only, this file's colors aren't fund-critical data.
const CHAIN_COLOR = {
  ethereum: "#8C9BAE", base: "#3D6BFF", bnb: "#F0B90B", robinhood: "#00C805", stable: "#26A17B", solana: "#9945FF",
  arbitrum: "#28A0F0", avalanche: "#E84142", abstract: "#00E599", hyperevm: "#97FCE4",
  ink: "#7132F5", plasma: "#0FDD8D", unichain: "#FF007A", xlayer: "#00D2B5",
  polygon: "#8247E5", optimism: "#FF0420", zksync: "#8C8DFC", linea: "#61DFFF", scroll: "#FFEEDA",
  gnosis: "#04795B", monad: "#836EF9", sonic: "#FE9A4D", mantle: "#000000", blast: "#FCFC03",
  berachain: "#814625", worldchain: "#191919", sei: "#9E1F19", celo: "#FCFF52", fantom: "#1969FF",
  moonbeam: "#53CBC9", cronos: "#002D74", metis: "#00DACC", mode: "#DFFE00", zora: "#000000",
  manta: "#8358FF", opbnb: "#F0B90B", taiko: "#E81899", polygonzkevm: "#8247E5", fraxtal: "#000000",
};

const SELF_CONTAINED_BADGE_CHAINS = [
  "ethereum", "base", "bnb", "solana", "stable", "robinhood",
  "arbitrum", "avalanche", "abstract", "hyperevm", "ink", "plasma", "unichain", "xlayer",
  "polygon", "optimism", "zksync", "linea", "scroll", "gnosis",
  "monad", "sonic", "mantle", "blast", "berachain", "worldchain", "sei",
  "celo", "fantom", "moonbeam", "cronos", "metis", "mode", "zora", "manta", "taiko", "polygonzkevm", "fraxtal",
];

// opBNB icon gap — see the import comment above. A plain tinted circle in
// BNB's real brand yellow, same fix MangoWallet.jsx's own WalletChainBadge
// already applies for the wallet dashboard, rather than a generic "?"
// fallback that would incorrectly imply an unrecognized chain.
const WALLET_ONLY_ICON = {
  polygon: NetworkPolygon, optimism: NetworkOptimism, zksync: NetworkZksync,
  linea: NetworkLinea, scroll: NetworkScroll, gnosis: NetworkGnosis,
  monad: NetworkMonad, sonic: NetworkSonic, mantle: NetworkMantle,
  blast: NetworkBlast, berachain: NetworkBerachain, worldchain: NetworkWorld, sei: NetworkSeiNetwork,
  celo: NetworkCelo, fantom: NetworkFantom, moonbeam: NetworkMoonbeam, cronos: NetworkCronos,
  metis: NetworkMetisAndromeda, mode: NetworkMode, zora: NetworkZora, manta: NetworkMantaPacific,
  taiko: NetworkTaiko, polygonzkevm: NetworkPolygonZkevm, fraxtal: NetworkFraxtal,
};

function SolanaLogoIcon({ size, fallback }) {
  const [failed, setFailed] = useState(false);
  if (failed) return fallback;
  return (
    // icons.sol.new — an open-source (MIT licensed) icon library built
    // specifically for the Solana ecosystem, explicitly designed for
    // third-party embedding like this (see App.jsx's own longer comment
    // on why this was chosen over hotlinking solana.com's own assets).
    <img
      src="https://icons.sol.new/svg/platforms/solana.svg"
      alt="Solana"
      width={size}
      height={size}
      style={{ width: size, height: size, objectFit: "contain" }}
      onError={() => setFailed(true)}
    />
  );
}

function ChainIcon({ id, size }) {
  const s = size * 0.8;
  if (id === "ethereum") return <NetworkEthereum variant="branded" size={s} />;
  if (id === "base") return <NetworkBase variant="branded" size={s} />;
  if (id === "bnb") return <NetworkBinanceSmartChain variant="branded" size={s} />;
  if (id === "stable") return <NetworkStable variant="branded" size={s} />;
  if (id === "robinhood") return <NetworkRobinhood variant="branded" size={s} />;
  if (id === "arbitrum") return <NetworkArbitrumOne variant="branded" size={s} />;
  if (id === "avalanche") return <NetworkAvalanche variant="branded" size={s} />;
  if (id === "abstract") return <NetworkAbstract variant="branded" size={s} />;
  if (id === "hyperevm") return <NetworkHyperEvm variant="branded" size={s} />;
  if (id === "ink") return <NetworkInk variant="branded" size={s} />;
  if (id === "plasma") return <NetworkPlasma variant="branded" size={s} />;
  if (id === "unichain") return <NetworkUnichain variant="branded" size={s} />;
  if (id === "xlayer") return <NetworkXLayer variant="branded" size={s} />;
  const WalletOnlyIcon = WALLET_ONLY_ICON[id];
  if (WalletOnlyIcon) return <WalletOnlyIcon variant="branded" size={s} />;
  const sHand = size * 0.56;
  if (id === "solana") {
    const solanaFallback = (
      <svg width={sHand} height={sHand} viewBox="0 0 24 24" fill="none">
        <path d="M4 6.5L7 4h13l-3 2.5H4z" fill="currentColor" opacity="0.9" />
        <path d="M4 17.5L7 20h13l-3-2.5H4z" fill="currentColor" opacity="0.9" />
        <path d="M4 12L7 9.5h13L17 12H4z" fill="currentColor" />
      </svg>
    );
    return <SolanaLogoIcon size={s} fallback={solanaFallback} />;
  }
  return (
    <svg width={sHand} height={sHand} viewBox="0 0 24 24" fill="none">
      <path d="M12 3l7 6-7 12-7-12 7-6z" fill="currentColor" opacity="0.85" />
      <path d="M12 3l7 6h-14l7-6z" fill="currentColor" />
    </svg>
  );
}

export function ChainBadge({ id, size = 18 }) {
  if (id === "opbnb") {
    return (
      <span className="flex items-center justify-center rounded-full shrink-0" style={{ width: size, height: size, background: "#F0B90B22", border: "1px solid #F0B90B55" }}>
        <span style={{ fontSize: size * 0.42, fontWeight: 700, color: "#F0B90B" }}>BNB</span>
      </span>
    );
  }
  const color = CHAIN_COLOR[id];
  if (!color) {
    // Defensive fallback: id could be a chain neither the site nor the
    // extension knows about (e.g. a stale persisted reference). Never
    // crash rendering over this.
    return (
      <span className="flex items-center justify-center rounded-full shrink-0" style={{ width: size, height: size, background: "#8C9BAE22", color: "#8C9BAE", border: "1px solid #8C9BAE55" }}>
        <span style={{ fontSize: size * 0.5, fontWeight: 700 }}>?</span>
      </span>
    );
  }
  // Every chain below renders via @web3icons/react's "branded" variant
  // (or, for Solana, its own official logomark) — all complete, self-
  // contained badge icons with their own color/shape already baked in.
  // Wrapping any of them in another background circle creates a visible
  // double-circle effect (see App.jsx's own longer comment on this).
  if (SELF_CONTAINED_BADGE_CHAINS.includes(id)) {
    return (
      <span className="flex items-center justify-center rounded-full shrink-0 overflow-hidden" style={{ width: size, height: size }}>
        <ChainIcon id={id} size={size} />
      </span>
    );
  }
  return (
    <span className="flex items-center justify-center rounded-full shrink-0" style={{ width: size, height: size, background: `${color}22`, color, border: `1px solid ${color}55` }}>
      <ChainIcon id={id} size={size} />
    </span>
  );
}
