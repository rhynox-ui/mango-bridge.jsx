import {
  TokenETH, TokenUSDC, TokenUSDT, TokenBNB,
  // Confirmed real, static exports via a live server-render check of this
  // exact installed package version — same verification bar as the
  // original four above, not a search-result guess (see the note further
  // down about why a previous attempt at TokenWBTC/NetworkStablechain was
  // reverted: NetworkStablechain genuinely doesn't exist, but this batch
  // was independently re-checked and every name below does).
  TokenWBTC, TokenAVAX, TokenHYPE, TokenXPL, TokenOKB,
  // Native-asset icons for walletChains.js's wallet-only chains, added
  // for the chain-parity work — the exact same Network* components
  // already verified working for the chain badges themselves
  // (chainBadges.jsx's own WALLET_ONLY_ICON), reused here for the
  // matching native-asset symbol (Polygon's coin IS the same purple
  // mark as its network badge, same for the rest) rather than a
  // separate, unverified Token* import for each.
  NetworkPolygon, NetworkGnosis, NetworkMonad, NetworkSonic, NetworkMantle, NetworkBerachain,
  NetworkSeiNetwork, NetworkCelo, NetworkFantom, NetworkMoonbeam, NetworkCronos, NetworkMetisAndromeda, NetworkFraxtal,
  // Native-asset icons for the real-usage EVM expansion batch — same
  // reuse-the-chain-badge-icon reasoning as the block above.
  NetworkBeam, NetworkBitkubChain, NetworkBotanix, NetworkBouncebit, NetworkChiliz, NetworkCitrea,
  NetworkConflux, NetworkCronosZkevm, NetworkEtherlink, NetworkFlare, NetworkFuse, NetworkGravity,
  NetworkGunz, NetworkHarmony, NetworkHashkey, NetworkImmutable, NetworkIotex, NetworkKaia,
  NetworkKava, NetworkLens, NetworkLukso, NetworkRonin, NetworkRootstock, NetworkTelos,
  NetworkTreasure, NetworkVana, NetworkWemix, NetworkXdcNetwork, NetworkZetaChain, NetworkZilliqa,
} from "@web3icons/react";
import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { ChainBadge } from "./chainBadges.jsx";
import { MangoLogo } from "./MangoLogo.jsx";
import { parseUnits, formatUnits, isAddress } from "viem";
import { fetchAllEvmBalances, fetchSolanaBalance } from "./multiAssetBalances.js";
import { fetchErc20TokenMetadata, fetchSplMintDecimals, fetchSplTokenSymbol, fetchSplTokenMetadataJupiter } from "./wallet/walletRpc.js";
import { loadCustomTokens, addCustomToken } from "./wallet/customTokens.js";
import { getTradeQuote, buyTokenReal, sellTokenReal } from "./launchpad-contracts.js";
import { PublicKey } from "@solana/web3.js";
import { useSolanaWallet } from "./SolanaWalletContext.jsx";
import {
  useAccount,
  useConnect,
  useDisconnect,
  useSwitchChain,
  useBalance,
} from "wagmi";
import { useAppKit, useAppKitAccount, useAppKitProvider, useDisconnect as useAppKitDisconnect } from "@reown/appkit/react";
import {
  ChevronDown,
  ArrowUpDown,
  Repeat,
  Check,
  Loader2,
  ExternalLink,
  X,
  History as HistoryIcon,
  RotateCcw,
  ArrowUpRight,
  ArrowLeft,
  AlertTriangle,
  BookOpen,
  Sun,
  Moon,
  Briefcase,
  Wallet,
  Send,
  Rocket,
  Globe,
  Menu,
  Mail,
  Download,
} from "lucide-react";
import { isCctpSupportedPair, runCctpTransfer, CCTP_CHAINS, DEV_FEE_PCT } from "./cctp.js";
import { appFeeBps } from "./devFeeWallets.js";
/** "0.25" not "0.25000", "1" not "1.00" — used everywhere this file displays the real Bridge/Swap protocol fee rate, so a rate change (devFeeWallets.js) can't leave stale "1%" text behind the way a hardcoded literal already had. Not used for Launchpad's own, separate trading-fee text (a different fee schedule entirely — see hookConfig's own "1% buy, 4% sell" copy). */
function formatFeePct(rate) {
  return (rate * 100).toFixed(2).replace(/\.?0+$/, "");
}
import { runOpDeposit, initiateOpWithdrawal, getOpWithdrawalStatus, proveOpWithdrawal, finalizeOpWithdrawal, trackWithdrawalByHash } from "./opbridge.js";
import { runArbDeposit, initiateArbWithdrawal, getArbWithdrawalStatus, finalizeArbWithdrawal, trackArbWithdrawalByHash, runArbErc20Deposit, initiateArbErc20Withdrawal } from "./arbbridge.js";
import { runWormholeTransfer, runWormholeTransferReverse, resumeWormholeTransfer } from "./wormholebridge.js";
import { getRelayQuote, executeRelayQuote, canRelayHandle, currencyAddress, MAINNET_CHAIN_IDS, ASSET_ONCHAIN_DECIMALS } from "./relaybridge.js";
import { tryFallbackProviders, checkFallbackRoute } from "./fallbackDex.js";
import { executeSolanaSourcedTransfer } from "./relaySdkSolanaExecution.js";
import { fetchRelayChains } from "./relayChains.js";
import { WALLET_ONLY_CHAIN_ORDER, WALLET_ONLY_CHAIN_LABEL, WALLET_ONLY_NATIVE_SYMBOL, WALLET_ONLY_EVM_CHAINS } from "./wallet/walletChains.js";
import { isMainnet, getWagmiChain } from "./networkMode.js";
import { LaunchpadTab } from "./Launchpad.jsx";
import { MangoWalletTab } from "./MangoWallet.jsx";
import { PALETTE, LIME, LIME_DEEP, fmt, timeAgo } from "./theme.js";
import { AdminReferralsPage } from "./AdminReferralsPage.jsx";

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

const CHAINS_TESTNET = {
  ethereum: { id: "ethereum", name: "Ethereum Sepolia", short: "ETH", color: "#8C9BAE", mark: "◆", baseSeconds: 780, baseFee: 4.85, explorer: "https://sepolia.etherscan.io/tx/" },
  base: { id: "base", name: "Base Sepolia", short: "BASE", color: "#3D6BFF", mark: "▲", baseSeconds: 45, baseFee: 0.06, explorer: "https://sepolia.basescan.org/tx/" },
  bnb: { id: "bnb", name: "BNB Testnet", short: "BNB", color: "#F0B90B", mark: "◆", baseSeconds: 25, baseFee: 0.18, explorer: "https://testnet.bscscan.com/tx/" },
  robinhood: { id: "robinhood", name: "Robinhood Chain Testnet", short: "RBH", color: "#00C805", mark: "●", baseSeconds: 20, baseFee: 0.04, explorer: "https://explorer.testnet.chain.robinhood.com/tx/" },
};
const CHAINS_MAINNET = {
  ethereum: { id: "ethereum", name: "Ethereum", short: "ETH", color: "#8C9BAE", mark: "◆", baseSeconds: 780, baseFee: 4.85, explorer: "https://etherscan.io/tx/" },
  base: { id: "base", name: "Base", short: "BASE", color: "#3D6BFF", mark: "▲", baseSeconds: 45, baseFee: 0.06, explorer: "https://basescan.org/tx/" },
  bnb: { id: "bnb", name: "BNB Chain", short: "BNB", color: "#F0B90B", mark: "◆", baseSeconds: 25, baseFee: 0.18, explorer: "https://bscscan.com/tx/" },
  robinhood: { id: "robinhood", name: "Robinhood Chain", short: "RBH", color: "#00C805", mark: "●", baseSeconds: 20, baseFee: 0.04, explorer: "https://robinhoodchain.blockscout.com/tx/" },
  stable: { id: "stable", name: "Stable", short: "STBL", color: "#26A17B", mark: "◆", baseSeconds: 15, baseFee: 0.02, explorer: "https://stablescan.xyz/tx/" },
  // Solana — deliberately NOT an EVM chain, unlike every other entry here.
  // isSolana:true is checked everywhere this matters (wallet connection,
  // address validation, getWagmiChain callers) so nothing accidentally
  // treats it like the rest. baseSeconds/baseFee reflect Relay's own
  // documented real-world performance (median ~2.7s execution, sub-cent
  // network fees), not guessed.
  solana: { id: "solana", name: "Solana", short: "SOL", color: "#9945FF", mark: "◆", baseSeconds: 3, baseFee: 0.001, explorer: "https://solscan.io/tx/", isSolana: true },
  // Native-asset-only additions — chain id, native currency, and explorer
  // URL all sourced from wagmi/chains' own maintained definitions (see
  // src/wagmi.js), not hand-typed. No token contract addresses are
  // verified for these yet, so only each chain's native asset is
  // supported; every transfer involving one of these routes through Relay
  // (see getTransferKind() below — no CCTP/OP-stack/Arbitrum-canonical
  // entry exists for any of them, so they fall through to "relay" safely).
  // baseSeconds/baseFee are rough initial display estimates only, same as
  // every other chain here — replaced by a real Relay quote once one loads.
  arbitrum: { id: "arbitrum", name: "Arbitrum One", short: "ARB", color: "#28A0F0", mark: "◆", baseSeconds: 30, baseFee: 0.05, explorer: "https://arbiscan.io/tx/" },
  avalanche: { id: "avalanche", name: "Avalanche", short: "AVAX", color: "#E84142", mark: "▲", baseSeconds: 20, baseFee: 0.05, explorer: "https://snowtrace.io/tx/" },
  abstract: { id: "abstract", name: "Abstract", short: "ABS", color: "#00E599", mark: "◆", baseSeconds: 30, baseFee: 0.03, explorer: "https://abscan.org/tx/" },
  hyperevm: { id: "hyperevm", name: "HyperEVM", short: "HYPE", color: "#97FCE4", mark: "◆", baseSeconds: 15, baseFee: 0.02, explorer: "https://hyperevmscan.io/tx/" },
  ink: { id: "ink", name: "Ink", short: "INK", color: "#7132F5", mark: "◆", baseSeconds: 30, baseFee: 0.03, explorer: "https://explorer.inkonchain.com/tx/" },
  plasma: { id: "plasma", name: "Plasma", short: "XPL", color: "#0FDD8D", mark: "◆", baseSeconds: 20, baseFee: 0.02, explorer: "https://plasmascan.to/tx/" },
  unichain: { id: "unichain", name: "Unichain", short: "UNI", color: "#FF007A", mark: "◆", baseSeconds: 30, baseFee: 0.03, explorer: "https://uniscan.xyz/tx/" },
  xlayer: { id: "xlayer", name: "X Layer", short: "OKB", color: "#00D2B5", mark: "◆", baseSeconds: 30, baseFee: 0.03, explorer: "https://www.oklink.com/xlayer/tx/" },
};

// Wallet-only chains — the same 25-chain list Mango Wallet's own dashboard
// already supports (walletChains.js), now also offered as Bridge routes.
// Built directly FROM walletChains.js's own already-verified data rather
// than hand-copied: name from WALLET_ONLY_CHAIN_LABEL, explorer from each
// chain's own wagmi/chains blockExplorers.default.url (real, verified —
// same standard chainData.js's own currencyAddress() requires), native
// symbol from WALLET_ONLY_NATIVE_SYMBOL. baseSeconds/baseFee use one
// shared, deliberately rough estimate rather than 25 individually-tuned
// guesses — same "rough initial display estimate only, replaced by a real
// Relay quote once one loads" caveat CHAINS_MAINNET's own comment already
// states for the native-asset-only chains above, just not worth
// fabricating false precision for 25 more entries at once.
//
// IMPORTANT: being in this object only means the app CAN render/quote for
// a chain — it does NOT mean the Bridge tab offers it. That's decided
// separately, live, by liveBridgeOrigins/liveBridgeDestinations below
// (Relay's own GET /chains response) — see bridgeFromChainOrder/
// bridgeToChainOrder inside MangoBridge().
const WALLET_ONLY_CHAINS_MAINNET = Object.fromEntries(
  WALLET_ONLY_CHAIN_ORDER.map((key) => {
    const chain = WALLET_ONLY_EVM_CHAINS[key];
    const explorerUrl = chain.blockExplorers?.default?.url;
    return [
      key,
      {
        id: key,
        name: WALLET_ONLY_CHAIN_LABEL[key],
        short: WALLET_ONLY_NATIVE_SYMBOL[key],
        baseSeconds: 30,
        baseFee: 0.05,
        explorer: explorerUrl ? `${explorerUrl}/tx/` : undefined,
      },
    ];
  })
);
Object.assign(CHAINS_MAINNET, WALLET_ONLY_CHAINS_MAINNET);

function getChains() { return isMainnet() ? CHAINS_MAINNET : CHAINS_TESTNET; }
// Proxy so every existing `CHAINS[key]` reference throughout this file stays
// correct without needing to be rewritten — always reflects the CURRENT mode.
const CHAINS = new Proxy({}, {
  get(_, key) { return getChains()[key]; },
  ownKeys() { return Reflect.ownKeys(getChains()); },
  getOwnPropertyDescriptor(_, key) { return Reflect.getOwnPropertyDescriptor(getChains(), key); },
});
const CHAIN_ORDER = ["ethereum", "base", "bnb", "robinhood", "stable", "solana", "arbitrum", "avalanche", "abstract", "hyperevm", "ink", "plasma", "unichain", "xlayer"];

// Real, network-aware address validation. EVM uses viem's own isAddress
// (proper format + checksum validation, not a hand-rolled regex). Solana
// uses the actual PublicKey constructor from @solana/web3.js — the
// canonical way to validate a Solana address, since it genuinely decodes
// the base58 string and confirms the byte length is correct, not just a
// superficial format check.
function isValidDestinationAddress(address, isSolanaChain) {
  if (!address || !address.trim()) return false;
  if (isSolanaChain) {
    try {
      new PublicKey(address.trim());
      return true;
    } catch {
      return false;
    }
  }
  return isAddress(address.trim());
}
const NATIVE_SYMBOL_BY_CHAIN = {
  ethereum: "ETH", base: "ETH", bnb: "BNB", robinhood: "ETH", stable: "USDT0", solana: "SOL",
  arbitrum: "ETH", avalanche: "AVAX", abstract: "ETH", hyperevm: "HYPE",
  ink: "ETH", plasma: "XPL", unichain: "ETH", xlayer: "OKB",
  ...WALLET_ONLY_NATIVE_SYMBOL,
};

// Every chain key from walletChains.js's wallet-only list — used to gate
// which chains actually need App.jsx's own resolveChainId/resolveCurrency
// branch below (their chain id comes from wagmi/chains' own chain objects,
// not chainData.js's hand-verified MAINNET_CHAIN_IDS) and, in
// MangoBridge(), to compute the live-Relay-support intersection.
const WALLET_ONLY_CHAIN_SET = new Set(WALLET_ONLY_CHAIN_ORDER);
function isWalletOnlyChain(chainKey) {
  return WALLET_ONLY_CHAIN_SET.has(chainKey);
}

// Relay's live chain id -> our own chainKey, restricted to chains we've
// already explicitly reviewed and imported (walletChains.js) — Relay's
// live /chains response can only ever narrow this down (a chain it
// reports disabled just won't match), never add a chain this app hasn't
// already vetted. Same pattern mango-mobile's own BridgeScreen.tsx uses.
const WALLET_ONLY_CHAIN_ID_TO_KEY = Object.fromEntries(
  WALLET_ONLY_CHAIN_ORDER.map((key) => [WALLET_ONLY_EVM_CHAINS[key]?.id, key]).filter(([id]) => id !== undefined)
);

/** Numeric chain id for a Relay quote request — chainData.js's verified MAINNET_CHAIN_IDS for a hand-verified chain, wagmi/chains' own chain id for one of walletChains.js's broader wallet-only chains. */
function resolveChainId(chainKey) {
  if (isWalletOnlyChain(chainKey)) return WALLET_ONLY_EVM_CHAINS[chainKey]?.id;
  return MAINNET_CHAIN_IDS[chainKey];
}

// The universal EVM native-asset placeholder — the exact same constant
// chainData.js's own currencyAddress() returns for every hand-verified
// chain's native asset, so reusing it for walletChains.js's broader
// wallet-only chains needs no per-chain "verified address" at all: unlike
// an ERC-20 contract, this isn't chain-specific data, it's just how every
// EVM chain represents "the native asset" to solvers/bridges.
const NATIVE_TOKEN_ADDRESS = "0x0000000000000000000000000000000000000000";

/** Currency address for a Relay quote request — chainData.js's verified currencyAddress() for a hand-verified chain, or the universal native placeholder for a wallet-only chain (native-asset bridging only there, same as the CHAINS_MAINNET native-asset-only additions above). */
function resolveCurrency(chainKey, assetSymbol) {
  if (isWalletOnlyChain(chainKey)) return NATIVE_TOKEN_ADDRESS;
  return currencyAddress(chainKey, assetSymbol);
}

// User-pasted "paste a contract address" tokens (AssetDropdown below,
// customTokens.js) carry their own real, on-chain-verified address —
// takes priority over both the hand-verified registry and the wallet-
// only-chain fallback above, neither of which has (or could have) an
// entry for a token nobody here independently vetted. assetObj is
// whatever fromAsset/toAsset currently resolves to — either an ASSETS
// entry or the synthetic {symbol, decimals, address, custom:true,
// onchainDecimals} shape built where fromCustomToken/toCustomToken is
// selected (see MangoBridge's own fromAsset/toAsset derivation).
function resolveCurrencyForAsset(chainKey, assetObj) {
  if (assetObj?.custom) return assetObj.address;
  return resolveCurrency(chainKey, assetObj.symbol);
}

// Real on-chain decimals for amount math (parseUnits) — genuinely
// different from ASSETS[].decimals, which is only a display/formatting
// precision (see chainData.js's own ASSET_ONCHAIN_DECIMALS_BY_CHAIN
// comment on why a symbol-only decimals lookup is never safe to reuse
// for this). A custom token's real decimals were read live off its own
// contract (fetchErc20TokenMetadata) when it was added, not guessed.
function onchainDecimalsForAsset(assetObj) {
  return assetObj?.custom ? assetObj.onchainDecimals : ASSET_ONCHAIN_DECIMALS[assetObj.symbol];
}

// Real bug fix: the "You receive"/"Fee"/"ETA" preview below was ALWAYS
// a static formula built from ASSETS[].price and CHAINS[].baseFee/
// baseSeconds — cosmetic, rough constants documented elsewhere in this
// file as "never used to compute an actual transfer amount" — even
// though a real getRelayQuote() call was already being made a few
// lines below (routeCheck) to validate the route. That call's result
// was awaited and then thrown away; only whether it threw fed back
// into the UI (routeUnavailable/routeChecking), never the actual quote
// numbers. So the prominent amount/fee/ETA shown never reflected Relay
// at all, regardless of whether Relay was reachable — a live, working
// quote and a completely broken one rendered identically. This mirrors
// mango-mobile's own BridgeScreen.tsx summarizeQuote exactly — field
// names (fees.gas/relayerGas/relayer/relayerService/app,
// details.currencyOut, details.timeEstimate) confirmed against
// @relayprotocol/relay-sdk's own installed api.d.ts, same as that
// file's own comment states. Every field access stays optional-chained
// with a numeric fallback — a renamed/missing field on Relay's end
// should quietly omit that piece of the display, never crash or show
// NaN/garbage.
function numOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function summarizeQuote(quote, fallbackDecimals) {
  const fees = quote?.fees ?? {};
  const details = quote?.details ?? {};

  const sourceGasUsd = numOrNull(fees?.gas?.amountUsd);
  const destGasUsd = numOrNull(fees?.relayerGas?.amountUsd);
  const relayerUsd = numOrNull(fees?.relayer?.amountUsd);
  const relayerServiceUsd = numOrNull(fees?.relayerService?.amountUsd);
  const relayerTotalUsd = relayerUsd ?? (destGasUsd != null || relayerServiceUsd != null ? (destGasUsd ?? 0) + (relayerServiceUsd ?? 0) : null);
  const appUsd = numOrNull(fees?.app?.amountUsd);
  const feeParts = [sourceGasUsd, relayerTotalUsd, appUsd].filter((v) => v !== null);
  const totalFeeUsd = feeParts.length > 0 ? feeParts.reduce((a, b) => a + b, 0) : null;

  const etaSeconds = numOrNull(details?.timeEstimate);

  const currencyOut = details?.currencyOut;
  let receivedAmount = null;
  if (currencyOut?.amountFormatted) {
    receivedAmount = Number(currencyOut.amountFormatted);
  } else if (currencyOut?.amount) {
    try {
      receivedAmount = Number(formatUnits(BigInt(currencyOut.amount), currencyOut?.currency?.decimals ?? fallbackDecimals));
    } catch {
      receivedAmount = null;
    }
  }

  return { totalFeeUsd, etaSeconds, receivedAmount };
}

// A real logo, straight from Relay's own quote response, for whichever
// symbol(s) this specific quote happened to involve — the only real
// source that exists for a symbol with no curated icon anywhere (see
// AssetIcon's own comment on this: USDT0 has no entry in @web3icons,
// Trust Wallet's assets repo, or Uniswap's token lists, confirmed by
// directly checking each). Returns {} when neither side's currency
// carries a logoURI, so a caller can always spread the result in
// without a null check.
function extractLogoUpdates(quote) {
  const details = quote?.details ?? {};
  const updates = {};
  for (const leg of [details.currencyIn, details.currencyOut]) {
    const symbol = leg?.currency?.symbol;
    const logoURI = leg?.currency?.metadata?.logoURI;
    if (symbol && logoURI) updates[symbol] = logoURI;
  }
  return updates;
}

const ASSETS = [
  { symbol: "USDC", name: "USD Coin", decimals: 2, price: 1, color: "#2775CA" },
  { symbol: "ETH", name: "Ether", decimals: 5, price: 3120, color: "#8C9BAE" },
  { symbol: "USDT", name: "Tether USD", decimals: 2, price: 1, color: "#26A17B" },
  { symbol: "WBTC", name: "Wrapped Bitcoin", decimals: 6, price: 61200, color: "#F09242" },
  { symbol: "BNB", name: "BNB", decimals: 5, price: 590, color: "#F0B90B" },
  { symbol: "USDG", name: "Global Dollar", decimals: 2, price: 1, color: "#00C805" },
  { symbol: "USDT0", name: "USDT0 (Stable native)", decimals: 2, price: 1, color: "#26A17B" },
  // Real gap fix: Solana was added as a selectable chain, but its native
  // asset never existed anywhere in this list — meaning even once a user
  // reached Solana, there was nothing valid to actually send or receive.
  { symbol: "SOL", name: "Solana", decimals: 4, price: 145, color: "#9945FF" },
  // Native assets for the 8 newly added chains — ETH already covers
  // Arbitrum/Abstract/Ink/Unichain above, so only genuinely new native
  // symbols need their own entry here. price is a rough, cosmetic
  // UI-preview estimate only (same caveat as every price above — not
  // fund-critical, never used to compute an actual transfer amount, which
  // always comes from a real Relay quote).
  { symbol: "AVAX", name: "Avalanche", decimals: 4, price: 25, color: "#E84142" },
  { symbol: "HYPE", name: "Hyperliquid", decimals: 4, price: 25, color: "#97FCE4" },
  { symbol: "XPL", name: "Plasma", decimals: 2, price: 0.5, color: "#0FDD8D" },
  { symbol: "OKB", name: "OKB", decimals: 4, price: 45, color: "#00D2B5" },
  // Native assets for walletChains.js's 25 wallet-only chains, now also
  // offered as Bridge routes — same "ETH already covers chains that share
  // it" logic as above (Optimism/zkSync/Linea/Scroll/World Chain/Mode/
  // Zora/Manta/Taiko/Polygon zkEVM all use plain ETH, opBNB uses BNB — no
  // new entry needed for any of those). price is the same rough,
  // cosmetic-only UI-preview estimate every other entry here already
  // uses, never fund-critical.
  { symbol: "POL", name: "Polygon", decimals: 4, price: 0.4, color: "#8247E5" },
  { symbol: "XDAI", name: "xDai", decimals: 2, price: 1, color: "#04795B" },
  { symbol: "MON", name: "Monad", decimals: 4, price: 0.03, color: "#836EF9" },
  { symbol: "S", name: "Sonic", decimals: 4, price: 0.5, color: "#FE9A4D" },
  { symbol: "MNT", name: "Mantle", decimals: 4, price: 1, color: "#000000" },
  { symbol: "BERA", name: "Berachain", decimals: 4, price: 3, color: "#814625" },
  { symbol: "SEI", name: "Sei", decimals: 4, price: 0.3, color: "#9E1F19" },
  { symbol: "CELO", name: "Celo", decimals: 4, price: 0.5, color: "#FCFF52" },
  { symbol: "FTM", name: "Fantom", decimals: 4, price: 0.6, color: "#1969FF" },
  { symbol: "GLMR", name: "Moonbeam", decimals: 4, price: 0.1, color: "#53CBC9" },
  { symbol: "CRO", name: "Cronos", decimals: 4, price: 0.1, color: "#002D74" },
  { symbol: "METIS", name: "Metis", decimals: 4, price: 30, color: "#00DACC" },
  { symbol: "FRAX", name: "Fraxtal", decimals: 4, price: 1, color: "#000000" },
  // Native assets for the real-usage EVM expansion batch (see
  // walletChains.js's own header) — same "ETH already covers chains
  // that share it" logic as above; only genuinely new native symbols
  // get their own entry here. price is the same rough, cosmetic-only
  // UI-preview estimate every other entry above already uses, never
  // fund-critical — never used to compute an actual transfer amount,
  // which always comes from a real Relay quote.
  { symbol: "BEAM", name: "Beam", decimals: 4, price: 0.01, color: "#8054EE" },
  { symbol: "KUB", name: "Bitkub Coin", decimals: 4, price: 0.5, color: "#02D767" },
  { symbol: "BTC", name: "Bitcoin (Botanix)", decimals: 6, price: 65000, color: "#FCCD0C" },
  { symbol: "BB", name: "BounceBit", decimals: 4, price: 0.1, color: "#F4BB44" },
  { symbol: "CHZ", name: "Chiliz", decimals: 4, price: 0.05, color: "#F60250" },
  { symbol: "cBTC", name: "Bitcoin (Citrea)", decimals: 6, price: 65000, color: "#FF7F0E" },
  { symbol: "CFX", name: "Conflux", decimals: 4, price: 0.15, color: "#00D2B4" },
  { symbol: "zkCRO", name: "Cronos zkEVM", decimals: 4, price: 5, color: "#051221" },
  { symbol: "XTZ", name: "Tezos (Etherlink)", decimals: 4, price: 0.7, color: "#38FF9C" },
  { symbol: "FLR", name: "Flare", decimals: 4, price: 0.02, color: "#E62058" },
  { symbol: "FUSE", name: "Fuse", decimals: 4, price: 0.02, color: "#B4F9B9" },
  { symbol: "G", name: "Gravity", decimals: 4, price: 0.05, color: "#FFAC43" },
  { symbol: "GUN", name: "GUNZ", decimals: 4, price: 0.02, color: "#C2FCCD" },
  { symbol: "ONE", name: "Harmony", decimals: 4, price: 0.01, color: "#00AEE9" },
  { symbol: "HSK", name: "HashKey", decimals: 4, price: 0.1, color: "#1B2126" },
  { symbol: "IMX", name: "Immutable", decimals: 4, price: 0.6, color: "#17B5CB" },
  { symbol: "IOTX", name: "IoTeX", decimals: 4, price: 0.03, color: "#00D4D5" },
  { symbol: "KAIA", name: "Kaia", decimals: 4, price: 0.15, color: "#BFF009" },
  { symbol: "KAVA", name: "Kava", decimals: 4, price: 0.4, color: "#FF564F" },
  { symbol: "GHO", name: "GHO (Lens)", decimals: 2, price: 1, color: "#ABFE2C" },
  { symbol: "LYX", name: "LUKSO", decimals: 4, price: 10, color: "#FE005B" },
  { symbol: "RON", name: "Ronin", decimals: 4, price: 0.5, color: "#1273EA" },
  { symbol: "RBTC", name: "Rootstock BTC", decimals: 6, price: 65000, color: "#FF9103" },
  { symbol: "TLOS", name: "Telos", decimals: 4, price: 0.05, color: "#42A0B9" },
  { symbol: "MAGIC", name: "Treasure", decimals: 4, price: 0.3, color: "#DC2626" },
  { symbol: "VANA", name: "Vana", decimals: 4, price: 4, color: "#00A2FF" },
  { symbol: "WEMIX", name: "WEMIX", decimals: 4, price: 0.8, color: "#27EA84" },
  { symbol: "XDC", name: "XDC Network", decimals: 4, price: 0.05, color: "#B8B5B1" },
  { symbol: "ZETA", name: "ZetaChain", decimals: 4, price: 0.3, color: "#005741" },
  { symbol: "ZIL", name: "Zilliqa", decimals: 4, price: 0.01, color: "#60AAAC" },
];

// These symbols exist in ASSETS above purely so each chain that doesn't
// share ETH/BNB as its native asset HAS a native-asset entry of its own
// (see WALLET_ONLY_CHAINS_MAINNET/handleSwapChainChange) — each is only
// ever real on exactly one chain (Solana/Avalanche/HyperEVM/Plasma/X
// Layer/the 13 wallet-only-chain natives), unlike USDC/ETH/USDT, which
// are real on many. Picking one of these while a DIFFERENT chain is
// selected switches that side to the symbol's own chain instead of
// just leaving an asset selected that was never real there — see
// handleFromAssetChange/handleToAssetChange's own use of this map.
const CHAIN_FOR_EXCLUSIVE_NATIVE_SYMBOL = {
  SOL: "solana", AVAX: "avalanche", HYPE: "hyperevm", XPL: "plasma", OKB: "xlayer",
  POL: "polygon", XDAI: "gnosis", MON: "monad", S: "sonic", MNT: "mantle", BERA: "berachain",
  SEI: "sei", CELO: "celo", FTM: "fantom", GLMR: "moonbeam", CRO: "cronos", METIS: "metis", FRAX: "fraxtal",
  // Real-usage EVM expansion batch — same reasoning as above, one entry
  // per genuinely new native symbol added to ASSETS for that batch.
  BEAM: "beam", KUB: "bitkub", BTC: "botanix", BB: "bounceBit", CHZ: "chiliz",
  cBTC: "citrea", CFX: "confluxESpace", zkCRO: "cronoszkEVM", XTZ: "etherlink", FLR: "flare",
  FUSE: "fuse", G: "gravity", GUN: "gunz", ONE: "harmonyOne", HSK: "hashkey",
  IMX: "immutableZkEvm", IOTX: "iotex", KAIA: "kaia", KAVA: "kava", GHO: "lens",
  LYX: "lukso", RON: "ronin", RBTC: "rootstock", TLOS: "telos", MAGIC: "treasure",
  VANA: "vana", WEMIX: "wemix", XDC: "xdc", ZETA: "zetachain", ZIL: "zilliqa",
};

const DEFAULT_BALANCES = {
  ethereum: { USDC: 1820.44, ETH: 1.284, USDT: 500, WBTC: 0.021 },
  base: { USDC: 640.1, ETH: 0.42, USDT: 120, WBTC: 0 },
  bnb: { USDC: 300, ETH: 0.05, USDT: 950.5, WBTC: 0 },
  robinhood: { USDC: 75.2, ETH: 0.01, USDT: 0, WBTC: 0 },
  // Real bug fix: this was missing entirely, causing a crash right after
  // any transaction into Stable completed — balances[to][toAsset.symbol]
  // needs an entry to write into. Stable only ever holds USDT0.
  stable: { USDT0: 0 },
  // Same reason as stable above — each new chain needs its own native-asset
  // entry to write into, or a transfer landing there crashes on completion.
  arbitrum: { ETH: 0 },
  avalanche: { AVAX: 0 },
  abstract: { ETH: 0 },
  hyperevm: { HYPE: 0 },
  ink: { ETH: 0 },
  plasma: { XPL: 0 },
  unichain: { ETH: 0 },
  xlayer: { OKB: 0 },
  // Same reason again, for walletChains.js's 25 wallet-only chains — built
  // programmatically from WALLET_ONLY_NATIVE_SYMBOL rather than hand-typed,
  // so there's no risk of missing one and reintroducing the exact crash
  // the comment above already documents.
  ...Object.fromEntries(WALLET_ONLY_CHAIN_ORDER.map((key) => [key, { [WALLET_ONLY_NATIVE_SYMBOL[key]]: 0 }])),
};

const STEPS = [
  { key: "submit", label: "Transaction submitted" },
  { key: "lock", label: "Asset locked on source chain" },
  { key: "attest", label: "Cross-chain message attested" },
  { key: "mint", label: "Asset released on destination" },
];

const CCTP_STEPS = [
  { key: "approve", label: "Approving USDC spend" },
  { key: "fee", label: `Sending ${formatFeePct(DEV_FEE_PCT)}% dev fee` },
  { key: "burn", label: "Burning USDC on source chain" },
  { key: "attest", label: "Waiting for Circle's attestation" },
  { key: "mint", label: "Minting USDC on destination chain" },
];

function shortHash() {
  const c = "0123456789abcdef";
  let h = "0x";
  for (let i = 0; i < 8; i++) h += c[Math.floor(Math.random() * 16)];
  h += "…";
  for (let i = 0; i < 6; i++) h += c[Math.floor(Math.random() * 16)];
  return h;
}

// Local persistence (safe in a real deployed browser — this is not an Artifacts sandbox)
function loadJSON(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
}
function saveJSON(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    // storage unavailable (private browsing, quota, etc.) — fail silently, app still works in-session
  }
}
function removeKey(key) {
  try {
    window.localStorage.removeItem(key);
  } catch (e) {}
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

function FloatingMangoDecor({ P }) {
  const shapes = [
    { top: "8%", left: "6%", size: 26, delay: "0s", duration: "9s", rotate: -18 },
    { top: "18%", left: "88%", size: 18, delay: "1.2s", duration: "11s", rotate: 24 },
    { top: "62%", left: "4%", size: 20, delay: "2.4s", duration: "10s", rotate: 10 },
    { top: "78%", left: "90%", size: 30, delay: "0.6s", duration: "12s", rotate: -8 },
    { top: "40%", left: "94%", size: 14, delay: "3s", duration: "8s", rotate: 30 },
    { top: "30%", left: "50%", size: 16, delay: "1.8s", duration: "13s", rotate: -22 },
    { top: "88%", left: "40%", size: 22, delay: "2.1s", duration: "9.5s", rotate: 16 },
    { top: "50%", left: "2%", size: 24, delay: "0.9s", duration: "11.5s", rotate: -12 },
  ];
  return (
    <div className="fixed inset-0 pointer-events-none overflow-hidden" style={{ zIndex: 0 }} aria-hidden="true">
      <style>{`
        @keyframes mangoFloat {
          0%, 100% { transform: translateY(0px) rotate(var(--r)); }
          50% { transform: translateY(-16px) rotate(calc(var(--r) + 6deg)); }
        }
        .mango-float { animation: mangoFloat var(--dur) ease-in-out infinite; animation-delay: var(--delay); }
        @media (prefers-reduced-motion: reduce) {
          .mango-float { animation: none; }
        }
      `}</style>
      {shapes.map((s, i) => (
        <div
          key={i}
          className="absolute mango-float"
          style={{ top: s.top, left: s.left, opacity: 0.08, "--r": `${s.rotate}deg`, "--dur": s.duration, "--delay": s.delay }}
        >
          <MangoLogo size={s.size} color={P.textPrimary} />
        </div>
      ))}
    </div>
  );
}

function ChainDropdown({ value, exclude, onChange, P, chainOrder = CHAIN_ORDER }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const c = CHAINS[value];
  useEffect(() => {
    function onDoc(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);
  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-1.5 text-[12.5px] font-medium" style={{ color: P.textPrimary }}>
        <ChainBadge id={value} size={16} />
        {c.name}
        <ChevronDown size={13} color={P.textMuted} />
      </button>
      {open && (
        // Real bug fix, and a real fix to an EARLIER "fix": this trigger
        // is the only child of its row (justify-between with nothing else
        // in it — both Bridge's own from/to pickers and Swap's picker all
        // live in exactly this shape now), so it renders at the row's
        // LEFT edge, not the right. An earlier pass anchored the panel
        // with right-0 based on a DIFFERENT layout — Swap's picker used
        // to sit in its own separate "Swap on" row alongside a label,
        // which right-aligned the trigger — but that row was removed when
        // Swap's picker moved inline to match Bridge's own cards, and
        // this was never revisited: right-0 on a left-aligned trigger
        // pushed the panel off the LEFT edge of the viewport instead.
        // left-0 matches the trigger's real position now. max-h +
        // overflow-y-auto: this list used to be a fixed 14 items (always
        // fit unscrolled) — now optionally extended with whichever of
        // walletChains.js's 25 wallet-only chains Relay's live data
        // currently supports, which can run well past what fits on
        // screen without this.
        <div className="absolute left-0 z-50 mt-2 w-44 max-h-80 overflow-y-auto rounded-xl shadow-2xl" style={{ background: P.panel, border: `1px solid ${P.panelBorder}` }}>
          {chainOrder.filter((id) => id !== exclude).map((id) => {
            const cc = CHAINS[id];
            return (
              <button key={id} onClick={() => { onChange(id); setOpen(false); }} className="w-full flex items-center gap-2 px-3 py-2.5 text-left" style={{ background: "transparent" }}>
                <ChainBadge id={id} size={18} />
                <span className="text-[13px]" style={{ color: P.textPrimary }}>{cc.name}</span>
                {id === value && <Check size={13} color={LIME} className="ml-auto" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Consolidates what used to be two separate always-visible top-bar icons
// (X, Telegram) plus the bottom-nav's Docs entry into one menu, so the top
// bar stays uncluttered as more links get added over time — Terms, Risk
// Disclosure, or anything else the site grows into can go here without
// needing more top-bar real estate or more bottom-nav tabs.
function TopMenuDropdown({ P, onOpenDocs }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    function onDoc(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);
  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen((o) => !o)} className="w-8 h-8 rounded-full flex items-center justify-center" style={{ background: P.panel, border: `1px solid ${P.panelBorder}` }}>
        <Menu size={14} color={P.textSecondary} />
      </button>
      {open && (
        <div className="absolute left-0 z-50 mt-2 w-48 rounded-xl overflow-hidden shadow-2xl py-1" style={{ background: P.panel, border: `1px solid ${P.panelBorder}` }}>
          <button
            onClick={() => { onOpenDocs(); setOpen(false); }}
            className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-left text-[13px] font-medium"
            style={{ color: P.textPrimary }}
          >
            <BookOpen size={15} color={P.textMuted} /> Docs
          </button>
        </div>
      )}
    </div>
  );
}

// Small, always-visible social row — deliberately separate from
// TopMenuDropdown (which stays for Docs and whatever else the site grows
// into) since these two want to be visible at a glance, not a tap away.
// Sits in normal document flow at the bottom of whichever tab's content is
// showing, above the fixed bottom nav, so it's consistent across Bridge,
// Wallet, and every other tab rather than only appearing on one.
function SocialLinksRow({ P }) {
  return (
    <div className="flex items-center gap-2 mt-4">
      <a href="https://x.com/Mango_protocol" target="_blank" rel="noopener noreferrer" className="w-8 h-8 rounded-full flex items-center justify-center" style={{ background: P.panel, border: `1px solid ${P.panelBorder}` }}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
          <path d="M18.9 2H22l-7.6 8.7L23.3 22h-6.8l-5.3-6.9L5 22H1.9l8.1-9.3L1 2h7l4.8 6.3L18.9 2Zm-1.2 18h1.9L7.4 4H5.4l12.3 16Z" fill={P.textSecondary} />
        </svg>
      </a>
      <a href="https://t.me/mango_protocol" target="_blank" rel="noopener noreferrer" className="w-8 h-8 rounded-full flex items-center justify-center" style={{ background: P.panel, border: `1px solid ${P.panelBorder}` }}>
        <Send size={13} color={P.textSecondary} />
      </a>
      <a href="mailto:mango@mangoprotocol.site" className="w-8 h-8 rounded-full flex items-center justify-center" style={{ background: P.panel, border: `1px solid ${P.panelBorder}` }}>
        <Mail size={13} color={P.textSecondary} />
      </a>
    </div>
  );
}

// Direct Android APK download — the actual signed release APK is checked
// into public/mango-app.apk (same pattern as public/mango-wallet-extension.zip
// just above it), so Vite/Vercel serve it as a real static file at this
// site's own origin. A plain same-origin link, not a link out to GitHub:
// no sign-in wall, no expiring artifact retention window, works for any
// visitor. The `download` attribute names the saved file explicitly so a
// browser doesn't just save it as "mango-app".
function DownloadApkRow({ P }) {
  return (
    <a
      href="/mango-app.apk"
      download="mango-app.apk"
      className="flex items-center gap-2 mt-3 px-4 py-2.5 rounded-full text-[12.5px] font-semibold w-fit"
      style={{ background: P.panel, border: `1px solid ${P.panelBorder}`, color: P.textPrimary }}
    >
      <Download size={14} color={P.textSecondary} />
      Download Mango APK
    </a>
  );
}

function HandDrawnAssetGlyph({ symbol, size, color }) {
  const s = size * 0.56;
  let glyph;
  if (symbol === "USDC") {
    glyph = (
      <svg width={s} height={s} viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" fill="none" />
        <path d="M12 7v10M9.5 9.5c0-1.4 1.2-2.2 2.5-2.2s2.5 .8 2.5 2c0 1.5-1.5 1.8-2.5 2.2-1.2.4-2.5.9-2.5 2.3 0 1.2 1.2 2.2 2.5 2.2s2.5-.8 2.5-2" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" />
      </svg>
    );
  } else if (symbol === "ETH") {
    glyph = (
      <svg width={s} height={s} viewBox="0 0 24 24" fill="none">
        <path d="M12 2L4 12.5L12 17L20 12.5L12 2Z" fill="currentColor" opacity="0.85" />
        <path d="M12 18.5L4 14L12 22L20 14L12 18.5Z" fill="currentColor" />
      </svg>
    );
  } else if (symbol === "USDT") {
    glyph = (
      <svg width={s} height={s} viewBox="0 0 24 24" fill="none">
        <path d="M12 3C7 3 4 10 4 14c0 4.5 3.6 7 8 7s8-2.5 8-7c0-4-3-11-8-11z" fill="currentColor" opacity="0.18" />
        <rect x="10.5" y="7" width="3" height="9" fill="currentColor" />
        <rect x="7" y="9.5" width="10" height="2.2" fill="currentColor" />
      </svg>
    );
  } else if (symbol === "BNB") {
    glyph = (
      <svg width={s} height={s} viewBox="0 0 24 24" fill="none">
        <rect x="10" y="2" width="4" height="4" transform="rotate(45 12 4)" fill="currentColor" />
        <rect x="10" y="18" width="4" height="4" transform="rotate(45 12 20)" fill="currentColor" />
        <rect x="2" y="10" width="4" height="4" transform="rotate(45 4 12)" fill="currentColor" />
        <rect x="18" y="10" width="4" height="4" transform="rotate(45 20 12)" fill="currentColor" />
        <rect x="10" y="10" width="4" height="4" transform="rotate(45 12 12)" fill="currentColor" />
      </svg>
    );
  } else if (symbol === "USDG") {
    glyph = (
      <svg width={s} height={s} viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" fill="none" />
        <path d="M15.5 9.5a3.8 3.8 0 100 5" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" />
        <path d="M13.5 12h3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  } else if (symbol === "USDT0") {
    glyph = (
      <svg width={s} height={s} viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.2" fill="none" opacity="0.5" />
        <path d="M12 3.5C7.5 3.5 4.5 10 4.5 14c0 4.5 3.6 7 7.5 7s7.5-2.5 7.5-7c0-4-3-10.5-7.5-10.5z" fill="currentColor" opacity="0.18" />
        <rect x="10.5" y="7.5" width="3" height="8.5" fill="currentColor" />
        <rect x="7.5" y="9.8" width="9" height="2" fill="currentColor" />
      </svg>
    );
  } else if (symbol === "WBTC") {
    glyph = (
      <svg width={s} height={s} viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="9" fill="currentColor" opacity="0.16" />
        <text x="12" y="16.5" fontSize="10" fontWeight="700" textAnchor="middle" fill="currentColor">₿</text>
      </svg>
    );
  } else {
    // A genuinely unrecognized symbol (no hand-drawn glyph above, and —
    // for a custom token specifically — every real logo source
    // CustomTokenIcon tried also came up empty). The token's own first
    // letter reads as a deliberate, on-brand placeholder; a bare "?"
    // read as broken/an error state, which live feedback confirmed
    // ("token icon logo" flagged as something to fix) — same letter-
    // avatar treatment mango-mobile's own TokenIcon.tsx already uses
    // for this exact case.
    const letter = (symbol?.trim()?.[0] || "?").toUpperCase();
    glyph = (
      <svg width={s} height={s} viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="9" fill="currentColor" opacity="0.16" />
        <text x="12" y="16.5" fontSize="12" fontWeight="700" textAnchor="middle" fill="currentColor">{letter}</text>
      </svg>
    );
  }
  return (
    <span className="flex items-center justify-center rounded-full shrink-0" style={{ width: size, height: size, background: `${color}22`, color, border: `1px solid ${color}55` }}>
      {glyph}
    </span>
  );
}

function USDGIcon({ size, color }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <HandDrawnAssetGlyph symbol="USDG" size={size} color={color} />;
  return (
    <img
      src="https://424565.fs1.hubspotusercontent-na1.net/hubfs/424565/GDN_USDG_Token_32x32.png"
      alt="USDG"
      width={size}
      height={size}
      style={{ width: size, height: size, objectFit: "contain" }}
      onError={() => setFailed(true)}
    />
  );
}

// Real, official Solana logomark — solana.com/branding, explicitly
// labeled "Official Solana logo mark icon" (confirmed icon-only, not the
// full wordmark with text), hosted directly on Solana's own domain.
function SolanaLogoIcon({ size, fallback }) {
  const [failed, setFailed] = useState(false);
  if (failed) return fallback;
  return (
    <img
      // Real, confirmed URL — icons.sol.new, an open-source (MIT
      // licensed) icon library built specifically for the Solana
      // ecosystem, explicitly designed for third-party embedding like
      // this. More reliable than hotlinking solana.com's own site
      // assets, which aren't necessarily meant for cross-origin use.
      src="https://icons.sol.new/svg/platforms/solana.svg"
      alt="Solana"
      width={size}
      height={size}
      style={{ width: size, height: size, objectFit: "contain" }}
      onError={() => setFailed(true)}
    />
  );
}

// USDT0's icon previously loaded from docs.usdt0.to as a live <img>, with a
// hand-drawn fallback on error — removed after confirming that domain is
// now blocked at the network egress level (a direct fetch attempt against
// it returns EGRESS_BLOCKED), which matches what was reported live: no
// icon rendering at all. AssetIcon now goes straight to the hand-drawn
// USDT0 glyph in HandDrawnAssetGlyph below — always renders, no external
// dependency to go stale or get blocked again.

// DexScreener's own token-image CDN, keyed by chain slug + checksummed
// contract address (or Solana mint) — no API key, works for any token
// DexScreener has ever indexed a pair for, which in practice covers the
// vast majority of real tokens (including small/meme ones), unlike a
// curated icon package that could only ever ship well-known symbols.
// Chain slugs below are DexScreener's own naming — the well-established
// ones (base/ethereum/bnb/arbitrum/optimism/avalanche/polygon/solana and
// the rest of chainData.js's original hand-verified set) are confirmed
// against DexScreener's own site; the newer/less common chains added
// later (walletChains.js's broader wallet-only set) are a best-effort
// guess at their slug, not independently confirmed the way every other
// icon in this file is — DexScreener itself is blocked from this
// sandbox, unlike GitHub, so there's no way to verify them here. Either
// way a wrong or unlisted slug just 404s the image, which
// CustomTokenIcon below already falls back from safely — never a
// broken/blank icon.
const CUSTOM_TOKEN_CHAIN_SLUG = {
  ethereum: "ethereum", base: "base", bnb: "bsc", arbitrum: "arbitrum", solana: "solana",
  avalanche: "avalanche", abstract: "abstract", ink: "ink", unichain: "unichain",
  polygon: "polygon", optimism: "optimism", zksync: "zksync", linea: "linea",
  scroll: "scroll", gnosis: "gnosischain", blast: "blast", mantle: "mantle",
  celo: "celo", fantom: "fantom", moonbeam: "moonbeam", cronos: "cronos",
  mode: "mode", zora: "zora", opbnb: "opbnb", polygonzkevm: "polygonzkevm", fraxtal: "fraxtal",
  // Real, reported gap: a custom token on Robinhood Chain (this app's own
  // Bridge chain, not a wallet-only extra) fell straight to the generic
  // "?" glyph — this chain was simply missing from the map entirely, not
  // a genuinely-unsupported one. Confirmed via research (this sandbox
  // still can't reach dexscreener.com directly) that DexScreener does
  // track it, at exactly this slug (dexscreener.com/robinhood/...).
  // Same research confirmed real slugs for Stable, HyperEVM, and Plasma —
  // three more of this app's own Bridge chains that were missing here for
  // no real reason. X Layer was also checked and left out: no DexScreener
  // slug for it could be confirmed one way or the other, and this file's
  // own "not safe to guess one" policy applies here too — a wrong slug
  // only ever silently 404s to the same fallback glyph anyway, but an
  // unverified guess isn't worth adding on the chance it's right.
  robinhood: "robinhood", stable: "stable", hyperevm: "hyperevm", plasma: "plasma",
};
function customTokenLogoUrl(chainId, address) {
  const slug = CUSTOM_TOKEN_CHAIN_SLUG[chainId];
  if (!slug || !address) return null;
  // EVM addresses are case-insensitive (lowercasing is the safe,
  // conventional normalization) — a Solana base58 mint is genuinely
  // case-sensitive, so lowercasing it here would silently corrupt it
  // into a different, invalid address and the image would never match.
  const normalized = chainId === "solana" ? address : address.toLowerCase();
  return `https://dd.dexscreener.com/ds-data/tokens/${slug}/${normalized}.png`;
}

// Second-tier logo source, tried only once the static-guess CDN URL
// above 404s (a chain missing from CUSTOM_TOKEN_CHAIN_SLUG entirely, or
// one whose slug is right but DexScreener just never published an image
// at that exact static path) — same real API mango-mobile's own
// assetMetadata.js already uses (fetchDexScreenerLogoUrl), ported here
// rather than guessed fresh. Queries by address ALONE, no chain slug
// needed, and returns whatever DexScreener's own token-pairs data
// actually has on file — a real, live-verified image, not another
// guessed URL pattern. Live-reported gap this closes: a token search-
// added on Robinhood Chain (already in CUSTOM_TOKEN_CHAIN_SLUG from an
// earlier fix) still fell to the plain "?" glyph — the static-guess URL
// 404'd for that specific token, and until now nothing else was ever
// tried.
const dexScreenerImageCache = new Map();
function fetchDexScreenerTokenImage(address) {
  const key = String(address).toLowerCase();
  if (dexScreenerImageCache.has(key)) return dexScreenerImageCache.get(key);
  const promise = (async () => {
    try {
      const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(address)}`);
      if (!res.ok) return null;
      const body = await res.json();
      const pairs = Array.isArray(body?.pairs) ? body.pairs : [];
      for (const pair of pairs) {
        const imageUrl = pair?.info?.imageUrl;
        if (typeof imageUrl === "string" && imageUrl.length > 0) return imageUrl;
      }
      return null;
    } catch {
      // Best-effort — the hand-drawn fallback below is always there, so
      // a network failure here is never user-visible as anything worse
      // than "shows a letter instead of a logo."
      return null;
    }
  })();
  dexScreenerImageCache.set(key, promise);
  return promise;
}

function CustomTokenIcon({ size, chainId, address, fallback }) {
  const [staticFailed, setStaticFailed] = useState(false);
  const staticUrl = customTokenLogoUrl(chainId, address);
  // undefined = not fetched yet, null = fetched, nothing found, string = a real image URL
  const [apiUrl, setApiUrl] = useState(undefined);
  const [apiFailed, setApiFailed] = useState(false);
  const needsApiTier = !staticUrl || staticFailed;

  useEffect(() => {
    if (!needsApiTier || !address || apiUrl !== undefined) return;
    let cancelled = false;
    fetchDexScreenerTokenImage(address).then((url) => {
      if (!cancelled) setApiUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [needsApiTier, address, apiUrl]);

  if (staticUrl && !staticFailed) {
    return (
      <img
        src={staticUrl}
        alt=""
        width={size}
        height={size}
        style={{ width: size, height: size, objectFit: "contain", borderRadius: "9999px" }}
        onError={() => setStaticFailed(true)}
      />
    );
  }
  if (apiUrl && !apiFailed) {
    return (
      <img
        src={apiUrl}
        alt=""
        width={size}
        height={size}
        style={{ width: size, height: size, objectFit: "contain", borderRadius: "9999px" }}
        onError={() => setApiFailed(true)}
      />
    );
  }
  return fallback;
}

// A logo URL discovered from Relay's own live quote responses
// (details.currencyIn/currencyOut.currency.metadata.logoURI — see
// MangoBridge's own discoveredAssetLogos state and extractLogoUpdates)
// rather than a guessed external domain. Same safe onError-fallback
// shape as USDGIcon/SolanaLogoIcon above.
function DiscoveredLogoIcon({ url, size, fallback }) {
  const [failed, setFailed] = useState(false);
  if (failed) return fallback;
  return (
    <img
      src={url}
      alt=""
      width={size}
      height={size}
      style={{ width: size, height: size, objectFit: "contain", borderRadius: "9999px" }}
      onError={() => setFailed(true)}
    />
  );
}

function AssetIcon({ symbol, size = 18, chainId, address, logoUrl }) {
  const asset = ASSETS.find((a) => a.symbol === symbol);
  const color = asset?.color || "#8C9BAE";

  // A custom/pasted token (address only ever set by AssetDropdown's own
  // custom-token call sites — a built-in ASSETS entry never has one) —
  // try its real logo before falling through to the generic glyph every
  // unrecognized symbol used to get stuck with.
  if (address) {
    return (
      <span className="flex items-center justify-center rounded-full shrink-0 overflow-hidden" style={{ width: size, height: size }}>
        <CustomTokenIcon size={size} chainId={chainId} address={address} fallback={<HandDrawnAssetGlyph symbol={symbol} size={size} color={color} />} />
      </span>
    );
  }

  // Global Dollar Network's own brand page (globaldollar.com/brand)
  // explicitly hosts this exact PNG "for block explorers" — this is the
  // sanctioned use case, not a guess. Falls back to the hand-drawn glyph if
  // the image ever fails to load, via proper React state.
  if (symbol === "USDG") {
    return (
      <span className="flex items-center justify-center rounded-full shrink-0 overflow-hidden" style={{ width: size, height: size }}>
        <USDGIcon size={size} color={color} />
      </span>
    );
  }

  if (symbol === "SOL") {
    return (
      <span className="flex items-center justify-center rounded-full shrink-0 overflow-hidden" style={{ width: size, height: size }}>
        <SolanaLogoIcon size={size} fallback={<HandDrawnAssetGlyph symbol="SOL" size={size} color={color} />} />
      </span>
    );
  }

  // Real, confirmed OKX brand icon — the only one of this whole batch that
  // doesn't ship a "branded" variant (confirmed via a live server-render
  // check: requesting "branded" throws "Icon TokenOKB does not have
  // variant branded. Available variants: mono"). mono is just an outline
  // that reads currentColor, so it needs the same tinted-circle wrapper
  // the hand-drawn fallbacks use rather than rendering standalone.
  if (symbol === "OKB") {
    return (
      <span className="flex items-center justify-center rounded-full shrink-0" style={{ width: size, height: size, background: `${color}22`, color, border: `1px solid ${color}55` }}>
        <TokenOKB variant="mono" size={size * 0.56} />
      </span>
    );
  }

  // Static imports only, matching @web3icons/react's own documented working
  // examples (TokenETH, TokenUSDC, TokenUSDT, TokenBNB) — no dynamic
  // lookup. The dynamic /dynamic entry point requires a <Suspense> boundary
  // to function at all, which this app didn't have, and it crashed the app
  // on every load as a result — a real production issue, not a hypothetical
  // one. A previous attempt to add TokenWBTC alongside NetworkStablechain
  // caused a real BUILD failure — but that failure was NetworkStablechain
  // ("is not exported"), not TokenWBTC; re-checked independently this
  // session via a live server-render of the actual installed package
  // (see the import comment above), confirming TokenWBTC/AVAX/HYPE/XPL all
  // genuinely exist and render. USDG, USDT0, and anything else not in this
  // confirmed set use the hand-drawn fallback.
  const STATIC_ICONS = { ETH: TokenETH, USDC: TokenUSDC, USDT: TokenUSDT, BNB: TokenBNB, WBTC: TokenWBTC, AVAX: TokenAVAX, HYPE: TokenHYPE, XPL: TokenXPL };
  if (STATIC_ICONS[symbol]) {
    const Icon = STATIC_ICONS[symbol];
    return (
      <span className="flex items-center justify-center rounded-full shrink-0 overflow-hidden" style={{ width: size, height: size }}>
        <Icon variant="branded" size={size} />
      </span>
    );
  }

  // Wallet-only chains' own native-asset icons — same Network* imports
  // as chainBadges.jsx's own WALLET_ONLY_ICON, just keyed by asset
  // symbol here instead of chain key. Real, verified icons instead of
  // the generic "?" glyph these previously fell through to.
  const WALLET_ONLY_NATIVE_ICONS = {
    POL: NetworkPolygon, XDAI: NetworkGnosis, MON: NetworkMonad, S: NetworkSonic, MNT: NetworkMantle,
    BERA: NetworkBerachain, SEI: NetworkSeiNetwork, CELO: NetworkCelo, FTM: NetworkFantom,
    GLMR: NetworkMoonbeam, CRO: NetworkCronos, METIS: NetworkMetisAndromeda, FRAX: NetworkFraxtal,
    BEAM: NetworkBeam, KUB: NetworkBitkubChain, BTC: NetworkBotanix, BB: NetworkBouncebit, CHZ: NetworkChiliz,
    cBTC: NetworkCitrea, CFX: NetworkConflux, zkCRO: NetworkCronosZkevm, XTZ: NetworkEtherlink, FLR: NetworkFlare,
    FUSE: NetworkFuse, G: NetworkGravity, GUN: NetworkGunz, ONE: NetworkHarmony, HSK: NetworkHashkey,
    IMX: NetworkImmutable, IOTX: NetworkIotex, KAIA: NetworkKaia, KAVA: NetworkKava, GHO: NetworkLens,
    LYX: NetworkLukso, RON: NetworkRonin, RBTC: NetworkRootstock, TLOS: NetworkTelos, MAGIC: NetworkTreasure,
    VANA: NetworkVana, WEMIX: NetworkWemix, XDC: NetworkXdcNetwork, ZETA: NetworkZetaChain, ZIL: NetworkZilliqa,
  };
  if (WALLET_ONLY_NATIVE_ICONS[symbol]) {
    const Icon = WALLET_ONLY_NATIVE_ICONS[symbol];
    return (
      <span className="flex items-center justify-center rounded-full shrink-0 overflow-hidden" style={{ width: size, height: size }}>
        <Icon variant="branded" size={size} />
      </span>
    );
  }

  // A symbol with no curated icon anywhere in this file (USDT0 being
  // the real case that prompted this — no entry in @web3icons/react,
  // @web3icons/core, Trust Wallet's assets repo, or Uniswap's token
  // lists, confirmed by directly checking each), but that a live Relay
  // quote has already reported a real logoURI for. Tried last, after
  // every curated/verified icon above, so a discovered URL can never
  // override an icon already known to be correct.
  if (logoUrl) {
    return (
      <span className="flex items-center justify-center rounded-full shrink-0 overflow-hidden" style={{ width: size, height: size }}>
        <DiscoveredLogoIcon url={logoUrl} size={size} fallback={<HandDrawnAssetGlyph symbol={symbol} size={size} color={color} />} />
      </span>
    );
  }

  return <HandDrawnAssetGlyph symbol={symbol} size={size} color={color} />;
}

// Search box doubles as a "paste a contract address" field. A valid EVM
// address triggers a real on-chain fetchErc20TokenMetadata() read
// (symbol()/decimals() off the actual contract, never guessed); a valid
// Solana mint triggers a real on-chain decimals read (fetchSplMintDecimals)
// plus a real symbol/name lookup (fetchSplTokenSymbol, DexScreener — see
// that function's own comment on why an SPL mint needs an off-chain
// source at all). Either way this offers an "Add {symbol}" row; confirming
// stores it in customTokens.js (the same registry MangoWallet.jsx's own
// wallet-dashboard "add custom token" flow already uses) and selects it
// immediately. A mint DexScreener has no indexed pair for yet — the
// common case for a pump.fun token before it graduates to a real DEX
// pool — falls back to manual symbol entry (splDecimals/splSymbolInput
// below) rather than blocking the add entirely: decimals already
// confirmed it's a real mint, there's just no live name for it yet.
function AssetDropdown({ assetIdx, setAssetIdx, chainId, P, balances, balancesLoading, onOpen, customToken, onCustomTokenSelect, allowCustomToken = true, discoveredLogos }) {
  const [open, setOpen] = useState(false);
  const [openUpward, setOpenUpward] = useState(false);
  const [query, setQuery] = useState("");
  const [customTokensForChain, setCustomTokensForChain] = useState([]);
  const [fetching, setFetching] = useState(false);
  const [fetchedToken, setFetchedToken] = useState(null);
  // Fallback for a real, verified mint (decimals confirmed on-chain)
  // that fetchSplTokenSymbol couldn't find anything for — most commonly
  // a pump.fun token that hasn't graduated to a real DEX pool yet, so
  // DexScreener has never indexed a pair for it. splDecimals !== null
  // means exactly that case: real mint, no live symbol source, so the
  // user types one same as before this auto-fetch existed.
  const [splDecimals, setSplDecimals] = useState(null);
  const [splSymbolInput, setSplSymbolInput] = useState("");
  // Real bug fix, live-confirmed: pasting an address that's already a
  // known built-in asset or already-added custom token used to just
  // `return` from the verification effect below with nothing else set
  // — fetching/fetchedToken/fetchError all stayed at their reset
  // values, so the dropdown rendered completely empty for that address:
  // no card, no error, no spinner, nothing. Reported live as "works the
  // first time [add a new token], then next time [re-pasting the same
  // address] it won't show" — exactly this case, since adding a token
  // persists it to localStorage (customTokens.js), so re-pasting the
  // same address in the same browser session (or any later one, until
  // the token is removed or a different browser's empty localStorage is
  // used) always hits this silent path. Tracks which already-known
  // entry matched so the UI can offer to just select it instead of
  // going silent.
  const [alreadyKnownToken, setAlreadyKnownToken] = useState(null);
  const [fetchError, setFetchError] = useState("");
  const ref = useRef(null);
  const asset = customToken || ASSETS[assetIdx];
  const isSolanaChain = chainId === "solana";
  // Bridge doesn't get this: Relay only ever routes currencies it has
  // verified itself, so a pasted, unverified token would just fail to
  // quote — Swap (same-chain, no cross-chain route to verify) is where
  // pasting an arbitrary contract address actually works. Solana IS
  // included now — same mint-search flow mango-mobile's DexScreen.tsx
  // already has, just ported over (it was excluded here purely because
  // this file's isAddress() check only recognizes EVM addresses, not
  // because Solana genuinely can't support it).
  const supportsCustomTokens = allowCustomToken;

  useEffect(() => {
    function onDoc(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  // Reloaded on every open/chain-change — same per-chain pattern
  // mobile's own DexScreen.tsx uses for its equivalent list, so a token
  // added from elsewhere in the app (or a moment ago, on the other side
  // of this same swap) always shows up here too.
  // customTokens.js stores a Solana entry's identifier under .mint, not
  // .address (tokenKey()'s own chain-aware convention) — normalized to
  // .address here so every consumer below (icon lookup, balance lookup,
  // onCustomTokenSelect) can stay chain-agnostic instead of branching
  // on isSolanaChain at every single use site.
  useEffect(() => {
    if (!open || !supportsCustomTokens) return;
    const loaded = loadCustomTokens(chainId);
    setCustomTokensForChain(isSolanaChain ? loaded.map((t) => ({ ...t, address: t.mint })) : loaded);
  }, [open, chainId, supportsCustomTokens, isSolanaChain]);

  // Flip-up heuristic for the dropdown running out of room below the
  // trigger: measure actual available space every time it opens, rather
  // than always opening downward and hoping there's room. ~140px covers
  // the bottom nav's real height plus a small safety margin.
  //
  // This alone did NOT fix tokens rendering hidden/cut off under the
  // bottom nav, though — live-reported and reproduced: the real cause is
  // that this panel's z-30 sits BELOW the fixed bottom nav's own z-40
  // (see its own "Bottom nav" block further down this file), so whenever
  // the panel's scrollable list extends into the nav's fixed screen
  // region (its own semi-transparent gradient background painting on
  // top), the last rows read as faded/cut off even though they're still
  // there and still scrollable — nothing was ever actually missing from
  // the list, it was only ever a stacking-order problem. z-50 here (and
  // on the chain-picker dropdown below, same underlying pattern) fixes
  // the actual cause; the flip-up logic below is still worth keeping as
  // a secondary "prefer not to need it at all" heuristic.
  function handleToggle() {
    if (!open && ref.current) {
      const rect = ref.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      setOpenUpward(spaceBelow < 140);
      // Real, required trigger: refresh balances the moment the list
      // opens, not just on connect/network-change, so a value that
      // changed since the last fetch is never shown stale.
      onOpen?.();
    } else {
      setQuery("");
      setFetchedToken(null);
      setSplDecimals(null);
      setSplSymbolInput("");
      setFetchError("");
      setAlreadyKnownToken(null);
    }
    setOpen((o) => !o);
  }

  const trimmedQuery = query.trim();
  const looksLikeAddress = supportsCustomTokens && isValidDestinationAddress(trimmedQuery, isSolanaChain);

  useEffect(() => {
    setFetchedToken(null);
    setSplDecimals(null);
    setSplSymbolInput("");
    setFetchError("");
    setAlreadyKnownToken(null);
    if (!open || !looksLikeAddress) return;
    // Already a known built-in or already-added custom token at this
    // exact address/mint — nothing new to verify or offer adding again,
    // but (real bug fix, see alreadyKnownToken's own comment above) the
    // UI still needs to show *something* rather than going silent —
    // offer to just select the existing entry. A Solana mint is
    // case-sensitive base58, unlike an EVM address, so this only
    // lowercases for the comparison on EVM chains — matches
    // customTokenLogoUrl's own reasoning above.
    const sameAddress = (a, b) => (isSolanaChain ? a === b : a.toLowerCase() === b.toLowerCase());
    const alreadyCustom = customTokensForChain.find((t) => sameAddress(t.address, trimmedQuery));
    if (alreadyCustom) {
      setAlreadyKnownToken({ kind: "custom", token: alreadyCustom });
      return;
    }
    const alreadyBuiltInIdx = ASSETS.findIndex((a) => {
      try { return sameAddress(currencyAddress(chainId, a.symbol), trimmedQuery); } catch { return false; }
    });
    if (alreadyBuiltInIdx !== -1) {
      setAlreadyKnownToken({ kind: "builtin", asset: ASSETS[alreadyBuiltInIdx], index: alreadyBuiltInIdx });
      return;
    }
    let cancelled = false;
    setFetching(true);
    if (isSolanaChain) {
      // Jupiter's own token indexer first — one call returns decimals,
      // symbol, AND the real token program (Token vs Token-2022) for
      // anything it's indexed, which is virtually every token with real
      // trading activity (Jupiter IS Solana's primary swap aggregator,
      // so a tradeable token being absent from its own index is rare).
      // Two real reliability wins over the old RPC-first path: no
      // dependence on either of solanaRpcUrls()' two free public
      // endpoints being up/unthrottled right now, and no separate
      // Token-2022 owner-program guess (fetchSplMintDecimals's own
      // fallback below still needs one, since raw RPC has no other way
      // to know) — Jupiter already resolved that when it indexed the
      // mint. Falls back to the original on-chain decimals +
      // DexScreener symbol two-step for anything genuinely too new for
      // Jupiter to have indexed yet, or if Jupiter itself is
      // unreachable — same graceful-degradation shape as before.
      // A plain async function (not a chained .then/.catch tower) so
      // the fallback path's own async work is genuinely awaited before
      // setFetching(false) below runs — a chained-promise version of
      // this that doesn't `return` its nested fallback call resolves
      // and clears the loading state before the fallback actually
      // finishes, a real ordering bug worth avoiding here.
      (async () => {
        try {
          const { symbol, decimals } = await fetchSplTokenMetadataJupiter(trimmedQuery);
          if (!cancelled) setFetchedToken({ symbol, decimals, address: trimmedQuery, mint: trimmedQuery });
          return;
        } catch {
          // Not indexed by Jupiter (or Jupiter unreachable) — fall through.
        }
        if (cancelled) return;
        try {
          const decimals = await fetchSplMintDecimals(trimmedQuery);
          if (cancelled) return;
          // Decimals confirm this is a real mint — try the live symbol
          // lookup next, but a miss there (no DexScreener-indexed pair,
          // very common for a pump.fun token pre-graduation) falls back
          // to manual entry instead of blocking the add entirely.
          try {
            const { symbol } = await fetchSplTokenSymbol(trimmedQuery);
            if (!cancelled) setFetchedToken({ symbol, decimals, address: trimmedQuery, mint: trimmedQuery });
          } catch {
            if (!cancelled) setSplDecimals(decimals);
          }
        } catch (err) {
          if (!cancelled) setFetchError(err?.message || "Couldn't verify this mint — check the address and network.");
        }
      })().finally(() => { if (!cancelled) setFetching(false); });
    } else {
      fetchErc20TokenMetadata(chainId, trimmedQuery)
        .then(({ symbol, decimals }) => { if (!cancelled) setFetchedToken({ symbol, decimals, address: trimmedQuery }); })
        .catch((err) => { if (!cancelled) setFetchError(err?.message || "Couldn't verify this token — check the address and network."); })
        .finally(() => { if (!cancelled) setFetching(false); });
    }
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, chainId, trimmedQuery, looksLikeAddress, isSolanaChain]);

  function handleSelectAlreadyKnown() {
    if (!alreadyKnownToken) return;
    if (alreadyKnownToken.kind === "custom") {
      onCustomTokenSelect(alreadyKnownToken.token);
    } else {
      setAssetIdx(alreadyKnownToken.index);
    }
    setOpen(false);
    setQuery("");
    setAlreadyKnownToken(null);
  }

  function handleAddFetchedToken() {
    if (!fetchedToken) return;
    try {
      addCustomToken(chainId, fetchedToken);
      const loaded = loadCustomTokens(chainId);
      setCustomTokensForChain(isSolanaChain ? loaded.map((t) => ({ ...t, address: t.mint })) : loaded);
      onCustomTokenSelect(fetchedToken);
      setOpen(false);
      setQuery("");
      setFetchedToken(null);
    } catch (err) {
      setFetchError(err?.message || "Could not add this token.");
    }
  }

  function handleAddSplToken() {
    const symbol = splSymbolInput.trim().toUpperCase();
    if (splDecimals === null || !symbol) return;
    try {
      addCustomToken("solana", { symbol, decimals: splDecimals, mint: trimmedQuery });
      setCustomTokensForChain(loadCustomTokens("solana").map((t) => ({ ...t, address: t.mint })));
      onCustomTokenSelect({ symbol, decimals: splDecimals, address: trimmedQuery });
      setOpen(false);
      setQuery("");
      setSplDecimals(null);
      setSplSymbolInput("");
    } catch (err) {
      setFetchError(err?.message || "Could not add this token.");
    }
  }

  const upperQuery = trimmedQuery.toUpperCase();
  // Real bug fix: when the pasted/typed text neither matches a known
  // symbol NOR parses as a real address (isValidDestinationAddress
  // above — a garbled paste, a truncated address, or just a typo), the
  // dropdown used to render nothing at all below the search box — no
  // result, no error, no loading state. Reported live as "doesn't do
  // anything." matchingAssetCount/matchingCustomTokenCount let the
  // empty-state message below know when that's actually happened,
  // rather than only ever being able to detect it after already
  // rendering (and discarding) every non-matching row.
  const matchingAssetCount = !looksLikeAddress ? ASSETS.filter((a) => !upperQuery || a.symbol.includes(upperQuery)).length : 0;
  const matchingCustomTokenCount =
    !looksLikeAddress && supportsCustomTokens ? customTokensForChain.filter((t) => !upperQuery || t.symbol.toUpperCase().includes(upperQuery)).length : 0;

  return (
    <div className="relative shrink-0" ref={ref}>
      <button onClick={handleToggle} className="flex items-center gap-1.5 pl-2 pr-2.5 py-1.5 rounded-full" style={{ background: P.pillBg }}>
        <AssetIcon symbol={asset.symbol} size={18} chainId={chainId} address={asset.address} logoUrl={discoveredLogos?.[asset.symbol]} />
        <span className="text-[14px] font-semibold" style={{ color: P.textPrimary }}>{asset.symbol}</span>
        <ChevronDown size={14} color={P.textMuted} />
      </button>
      {open && (
        <div
          className={`absolute right-0 z-50 w-64 rounded-xl shadow-2xl flex flex-col ${openUpward ? "bottom-full mb-2" : "top-full mt-2"}`}
          style={{ background: P.panel, border: `1px solid ${P.panelBorder}`, maxHeight: "min(60vh, 380px)" }}
        >
          {supportsCustomTokens && (
            <div className="p-2 shrink-0" style={{ borderBottom: `1px solid ${P.panelBorder}` }}>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search or paste a contract address"
                autoCapitalize="none"
                autoCorrect="off"
                className="w-full px-2.5 py-2 rounded-lg text-[12.5px]"
                style={{ background: P.input, border: `1px solid ${P.panelBorder}`, color: P.textPrimary }}
              />
            </div>
          )}
          <div className="overflow-y-auto">
            {!looksLikeAddress && ASSETS.map((a, i) => {
              if (upperQuery && !a.symbol.includes(upperQuery)) return null;
              // Real balance for this specific asset, if we have a fetched
              // value for it — assets with no real address on the current
              // chain (and thus no entry in `balances`) show nothing
              // rather than a misleading "0".
              const realBalance = balances?.[a.symbol];
              return (
                <button key={a.symbol} onClick={() => { setAssetIdx(i); setOpen(false); }} className="w-full flex items-center justify-between gap-2.5 px-3 py-2.5 text-left">
                  <div className="flex items-center gap-2.5">
                    <AssetIcon symbol={a.symbol} size={22} logoUrl={discoveredLogos?.[a.symbol]} />
                    <div className="flex flex-col">
                      <span className="text-[13px] font-medium" style={{ color: P.textPrimary }}>{a.symbol}</span>
                      <span className="text-[11px]" style={{ color: P.textMuted }}>{a.name}</span>
                    </div>
                  </div>
                  <span className="text-[11.5px] font-mono shrink-0" style={{ color: P.textSecondary }}>
                    {balancesLoading ? "…" : realBalance !== undefined ? fmt(realBalance, realBalance < 1 ? 4 : 2) : ""}
                  </span>
                </button>
              );
            })}
            {!looksLikeAddress && supportsCustomTokens && customTokensForChain.map((t) => {
              if (upperQuery && !t.symbol.toUpperCase().includes(upperQuery)) return null;
              return (
                <button key={t.address} onClick={() => { onCustomTokenSelect(t); setOpen(false); }} className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left">
                  <AssetIcon symbol={t.symbol} size={22} chainId={chainId} address={t.address} />
                  <div className="flex flex-col">
                    <span className="text-[13px] font-medium" style={{ color: P.textPrimary }}>{t.symbol}</span>
                    <span className="text-[11px] font-mono" style={{ color: P.textMuted }}>{t.address.slice(0, 6)}…{t.address.slice(-4)}</span>
                  </div>
                </button>
              );
            })}
            {trimmedQuery && !looksLikeAddress && matchingAssetCount === 0 && matchingCustomTokenCount === 0 && (
              <div className="px-3 py-3 text-[11.5px]" style={{ color: P.textMuted }}>
                {supportsCustomTokens
                  ? `No matching token — paste a full ${isSolanaChain ? "mint" : "contract"} address to add a new one.`
                  : "No matching token."}
              </div>
            )}
            {looksLikeAddress && (
              <div className="px-3 py-3">
                {fetching ? (
                  <div className="flex items-center gap-2">
                    <Loader2 size={14} className="animate-spin" color={P.textMuted} />
                    <span className="text-[12px]" style={{ color: P.textMuted }}>Checking this {isSolanaChain ? "mint" : "contract"} on {CHAINS[chainId]?.name}…</span>
                  </div>
                ) : fetchedToken ? (
                  <button onClick={handleAddFetchedToken} className="w-full flex items-center justify-between gap-2.5">
                    <div className="flex items-center gap-2.5">
                      <AssetIcon symbol={fetchedToken.symbol} size={22} chainId={chainId} address={fetchedToken.address} />
                      <div className="flex flex-col text-left">
                        <span className="text-[13px] font-medium" style={{ color: P.textPrimary }}>Add {fetchedToken.symbol}</span>
                        <span className="text-[11px] font-mono" style={{ color: P.textMuted }}>{trimmedQuery.slice(0, 6)}…{trimmedQuery.slice(-4)}</span>
                      </div>
                    </div>
                    <span className="text-[16px] font-semibold" style={{ color: LIME_DEEP }}>+</span>
                  </button>
                ) : alreadyKnownToken ? (
                  <button onClick={handleSelectAlreadyKnown} className="w-full flex items-center justify-between gap-2.5">
                    <div className="flex items-center gap-2.5">
                      <AssetIcon
                        symbol={alreadyKnownToken.kind === "custom" ? alreadyKnownToken.token.symbol : alreadyKnownToken.asset.symbol}
                        size={22}
                        chainId={chainId}
                        address={alreadyKnownToken.kind === "custom" ? alreadyKnownToken.token.address : undefined}
                      />
                      <div className="flex flex-col text-left">
                        <span className="text-[13px] font-medium" style={{ color: P.textPrimary }}>
                          Already added — select {alreadyKnownToken.kind === "custom" ? alreadyKnownToken.token.symbol : alreadyKnownToken.asset.symbol}
                        </span>
                        <span className="text-[11px] font-mono" style={{ color: P.textMuted }}>{trimmedQuery.slice(0, 6)}…{trimmedQuery.slice(-4)}</span>
                      </div>
                    </div>
                  </button>
                ) : isSolanaChain && splDecimals !== null ? (
                  <div className="flex flex-col gap-2">
                    <input
                      value={splSymbolInput}
                      onChange={(e) => setSplSymbolInput(e.target.value.toUpperCase())}
                      placeholder="Symbol (e.g. BONK)"
                      autoCapitalize="characters"
                      autoCorrect="off"
                      className="w-full px-2.5 py-2 rounded-lg text-[12.5px]"
                      style={{ background: P.input, border: `1px solid ${P.panelBorder}`, color: P.textPrimary }}
                    />
                    <span className="text-[10.5px]" style={{ color: P.textMuted }}>
                      No live listing found for this mint yet (common for a token that hasn't hit a real DEX pool) — enter its symbol yourself.
                    </span>
                    <button
                      onClick={handleAddSplToken}
                      disabled={!splSymbolInput.trim()}
                      className="w-full py-2 rounded-lg text-[12.5px] font-semibold"
                      style={{ background: splSymbolInput.trim() ? `${LIME}1A` : P.pillBg, color: splSymbolInput.trim() ? LIME_DEEP : P.textMuted }}
                    >
                      Add token
                    </button>
                  </div>
                ) : fetchError ? (
                  <div className="text-[11.5px]" style={{ color: "#D92D20" }}>{fetchError}</div>
                ) : null}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function StatusPill({ status }) {
  const done = status === "complete";
  return (
    <span className="text-[10.5px] font-medium px-2 py-0.5 rounded-full" style={{ background: done ? `${LIME}1A` : "#F0B84D1A", border: `1px solid ${done ? LIME : "#F0B84D"}40`, color: done ? LIME : "#F0B84D" }}>
      {done ? "Complete" : "Pending"}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Modal: review -> progress -> done
// ---------------------------------------------------------------------------

const CCTP_STEP_INDEX = { network: 0, approve: 0, fee: 1, burn: 2, attest: 3, "network-dest": 4, mint: 4 };

// l2Key names WHICH OP Stack chain this deposit targets — Base, Ink, or
// Unichain all speak the exact same canonical-bridge protocol, just with
// different L1 contract addresses (see opbridge.js), so one generic step
// list covers all three; only the displayed chain name changes.
function getOpDepositSteps(l2Key = "base") {
  return [
    { key: "fee", label: "Sending protocol fee" },
    { key: "build", label: "Preparing deposit" },
    { key: "deposit", label: `Depositing on ${CHAINS.ethereum.name}` },
    { key: "l1-confirm", label: `Confirming on ${CHAINS.ethereum.name}` },
    { key: "l2-confirm", label: `Crediting on ${CHAINS[l2Key].name}` },
  ];
}
const OP_DEPOSIT_STEP_INDEX = { fee: 0, build: 1, deposit: 2, "l1-confirm": 3, "l2-confirm": 4 };

function getOpWithdrawInitiateSteps(l2Key = "base") {
  return [
    { key: "fee", label: "Sending protocol fee" },
    { key: "build", label: "Preparing withdrawal" },
    { key: "withdraw", label: `Submitting withdrawal on ${CHAINS[l2Key].name}` },
    { key: "l2-confirm", label: `Confirming on ${CHAINS[l2Key].name}` },
  ];
}
const OP_WITHDRAW_INITIATE_STEP_INDEX = { fee: 0, build: 1, withdraw: 2, "l2-confirm": 3 };

function getArbDepositSteps() {
  return [
    { key: "fee", label: "Sending protocol fee" },
    { key: "build", label: "Preparing deposit" },
    { key: "deposit", label: `Depositing on ${CHAINS.ethereum.name}` },
    { key: "confirm", label: `Crediting on ${CHAINS.robinhood.name}` },
  ];
}
const ARB_DEPOSIT_STEP_INDEX = { fee: 0, build: 1, deposit: 2, confirm: 3 };

function getArbErc20DepositSteps() {
  return [
    { key: "fee", label: "Sending protocol fee" },
    { key: "build", label: "Preparing deposit" },
    { key: "approve", label: "Approving USDC spend" },
    { key: "deposit", label: `Depositing on ${CHAINS.ethereum.name}` },
    { key: "confirm", label: `Crediting on ${CHAINS.robinhood.name}` },
  ];
}
const ARB_ERC20_DEPOSIT_STEP_INDEX = { fee: 0, build: 1, approve: 2, deposit: 3, confirm: 4 };

function getArbWithdrawInitiateSteps() {
  return [
    { key: "fee", label: "Sending protocol fee" },
    { key: "build", label: "Preparing withdrawal" },
    { key: "withdraw", label: `Submitting withdrawal on ${CHAINS.robinhood.name}` },
    { key: "confirm", label: `Confirming on ${CHAINS.robinhood.name}` },
  ];
}
const ARB_WITHDRAW_INITIATE_STEP_INDEX = { fee: 0, build: 1, withdraw: 2, confirm: 3 };

function getWormholeSteps() {
  return [
    { key: "build", label: "Preparing transfer" },
    { key: "fee", label: "Sending protocol fee" },
    { key: "lock", label: `Locking ETH on ${CHAINS.ethereum.name}` },
    { key: "attest", label: "Waiting for Wormhole guardian signatures" },
    { key: "mint", label: `Minting wrapped ETH on ${CHAINS.bnb.name}` },
  ];
}
function getWormholeReverseSteps() {
  return [
    { key: "build", label: "Preparing transfer" },
    { key: "fee", label: "Sending protocol fee" },
    { key: "lock", label: `Burning wrapped ETH on ${CHAINS.bnb.name}` },
    { key: "attest", label: "Waiting for Wormhole guardian signatures" },
    { key: "mint", label: `Unlocking ETH on ${CHAINS.ethereum.name}` },
  ];
}
const WORMHOLE_STEP_INDEX = { build: 0, fee: 1, lock: 2, attest: 3, mint: 4 };

function getRelaySteps() {
  return [
    { key: "build", label: "Getting quote from Relay" },
    { key: "deposit", label: "Confirming transaction in wallet" },
    { key: "fill", label: "Waiting for Relay solver to fill" },
  ];
}
const RELAY_STEP_INDEX = { build: 0, deposit: 1, fill: 2 };

// OP Stack chains this app has a real, address-verified canonical bridge
// for — Base originally, plus Ink and Unichain (both cross-checked against
// Optimism's own superchain-registry; see opbridge.js). Every other OP
// Stack-family chain added to this app (Abstract is ZK Stack, X Layer is
// Polygon CDK — neither is actually OP Stack) stays relay-only until its
// own canonical bridge is independently verified the same way.
const OP_STACK_BRIDGE_CHAINS = ["base", "ink", "unichain"];

function getTransferKind(fromKey, toKey, fromAssetSymbol, toAssetSymbol) {
  const sameAsset = fromAssetSymbol === toAssetSymbol;
  if (sameAsset && isCctpSupportedPair(fromKey, toKey) && fromAssetSymbol === "USDC") return "cctp";
  if (sameAsset && fromKey === "ethereum" && OP_STACK_BRIDGE_CHAINS.includes(toKey) && fromAssetSymbol === "ETH") return "op-deposit";
  if (sameAsset && fromKey === "ethereum" && toKey === "robinhood" && (fromAssetSymbol === "ETH" || fromAssetSymbol === "USDC")) return "arb-deposit";
  if (sameAsset && fromKey === "ethereum" && toKey === "bnb" && fromAssetSymbol === "ETH") return "wormhole";
  // Withdrawal directions (Base/Ink/Unichain/Robinhood Chain -> Ethereum)
  // are ~7 days via the native canonical bridge, by fraud-proof design —
  // that's not "fixable," it's how the security model works. But Relay can
  // move ETH through this same pair in under a minute via its solver
  // network, so prefer that when available and fall back to the slow
  // canonical route only for what Relay can't handle.
  if (sameAsset && OP_STACK_BRIDGE_CHAINS.includes(fromKey) && toKey === "ethereum" && fromAssetSymbol === "ETH" && canRelayHandle(fromKey, toKey, fromAssetSymbol, toAssetSymbol)) return "relay";
  if (sameAsset && OP_STACK_BRIDGE_CHAINS.includes(fromKey) && toKey === "ethereum" && fromAssetSymbol === "ETH") return "op-withdraw";
  if (sameAsset && fromKey === "robinhood" && toKey === "ethereum" && (fromAssetSymbol === "ETH" || fromAssetSymbol === "USDC") && canRelayHandle(fromKey, toKey, fromAssetSymbol, toAssetSymbol)) return "relay";
  if (sameAsset && fromKey === "robinhood" && toKey === "ethereum" && (fromAssetSymbol === "ETH" || fromAssetSymbol === "USDC")) return "arb-withdraw";
  if (sameAsset && fromKey === "bnb" && toKey === "ethereum" && fromAssetSymbol === "ETH") return "wormhole-reverse";
  // Relay is the universal fallback for everything else — including
  // cross-asset swaps, which only Relay supports. Deliberately NOT gated by
  // a static canRelayHandle check anymore: that produced a confusing UX
  // where an unsupported pair silently fell into a fake "simulated" success
  // screen instead of a real error. Now every route either uses a native
  // protocol above, or genuinely attempts Relay — and if the exact
  // combination has no verified address or no live route, that surfaces as
  // an actual, specific error (from currencyAddress() or Relay's own API)
  // instead of a fabricated success.
  return "relay";
}

function BridgeModal({ from, to, amount, asset, toAsset, fromCustom, toCustom, fee, etaLabel, received, receivedRoundsToZero, devFeeAmount, originAmountUsd, destination, account, evmAddress, isFromSolana, solanaWallet, onClose, onComplete, onWithdrawalInitiated, onPendingHash }) {
  const kind = getTransferKind(from, to, asset, toAsset);
  const isReal = kind !== "simulated";
  // Which OP Stack chain this op-deposit/op-withdraw actually targets —
  // "kind" alone can't say, since Base/Ink/Unichain all produce the same
  // kind string. Deposits go TO the L2 (to), withdrawals come FROM it (from).
  const opL2Key = kind === "op-deposit" ? to : kind === "op-withdraw" ? from : "base";
  const steps = kind === "cctp" ? CCTP_STEPS
    : kind === "op-deposit" ? getOpDepositSteps(opL2Key)
    : kind === "op-withdraw" ? getOpWithdrawInitiateSteps(opL2Key)
    : kind === "arb-deposit" ? (asset === "USDC" ? getArbErc20DepositSteps() : getArbDepositSteps())
    : kind === "arb-withdraw" ? getArbWithdrawInitiateSteps()
    : kind === "wormhole" ? getWormholeSteps()
    : kind === "wormhole-reverse" ? getWormholeReverseSteps()
    : kind === "relay" ? getRelaySteps()
    : STEPS;

  const [phase, setPhase] = useState("review");
  const [stepIndex, setStepIndex] = useState(0);
  const [errorMessage, setErrorMessage] = useState("");
  const [realBurnHash, setRealBurnHash] = useState(null);
  const [realMintHash, setRealMintHash] = useState(null);
  const [simulatedHash] = useState(shortHash());
  const a = CHAINS[from], b = CHAINS[to];

  // Simulated flow: auto-advance on a timer (used for pairs with no real integration yet)
  useEffect(() => {
    if (isReal || phase !== "progress") return;
    if (stepIndex >= steps.length) { setPhase("done"); onComplete(simulatedHash); return; }
    const t = setTimeout(() => setStepIndex((i) => i + 1), 900 + Math.random() * 600);
    return () => clearTimeout(t);
  }, [isReal, phase, stepIndex]);

  // Real gap this closes: History used to only ever get a record on
  // FULL completion (onComplete, below) — a user who closed this tab,
  // or whose connection dropped, while the destination side was still
  // in flight (executeRelayQuote's own pollRelayStatus waits up to 10
  // minutes for Relay's fill) had ZERO record anywhere that real funds
  // had already left their wallet, even though the source-chain
  // transaction had already genuinely broadcast — the same failure
  // mode handleWithdrawalInitiated already exists to prevent for
  // OP/Arbitrum's own multi-day pending window, just never generalized
  // to the far more common Relay/fallback/CCTP/Wormhole path. Fires
  // the moment ANY of those flows' own onStep first learns a real
  // hash, which onComplete (once the flow actually finishes) then
  // updates in place rather than duplicating. op-withdraw/arb-withdraw
  // excluded deliberately — those already have their own, separate,
  // already-correct tracking (onWithdrawalInitiated/withdrawals),
  // which this would otherwise shadow with a second, never-updated
  // "pending" entry that onComplete is never called to resolve.
  useEffect(() => {
    if (!realBurnHash || kind === "op-withdraw" || kind === "arb-withdraw") return;
    onPendingHash?.(realBurnHash);
  }, [realBurnHash]);

  async function handleConfirm() {
    setPhase("progress");
    if (!isReal) return; // simulated path is driven by the effect above

    try {
      if (kind === "cctp") {
        const result = await runCctpTransfer({
          fromKey: from, toKey: to, account, amountHuman: amount,
          recipientAddress: destination || account,
          onStep: (key) => { if (key !== "done") setStepIndex(CCTP_STEP_INDEX[key] ?? 0); },
        });
        setRealBurnHash(result.burnHash);
        setRealMintHash(result.mintHash);
        setStepIndex(steps.length);
        setPhase("done");
        onComplete(result.burnHash);
      } else if (kind === "op-deposit") {
        const result = await runOpDeposit({
          account, amountHuman: amount, l2Key: opL2Key,
          onStep: (key) => { if (key !== "done") setStepIndex(OP_DEPOSIT_STEP_INDEX[key] ?? 0); },
        });
        setRealBurnHash(result.l1Hash);
        setRealMintHash(result.l2Hash);
        setStepIndex(steps.length);
        setPhase("done");
        onComplete(result.l1Hash);
      } else if (kind === "op-withdraw") {
        const result = await initiateOpWithdrawal({
          account, amountHuman: amount, l2Key: opL2Key,
          onStep: (step) => {
            if (typeof step === "object" && step.key === "hash-known") {
              setRealBurnHash(step.l2TxHash);
              return;
            }
            if (step !== "done") setStepIndex(OP_WITHDRAW_INITIATE_STEP_INDEX[step] ?? 0);
          },
        });
        setRealBurnHash(result.l2TxHash);
        setStepIndex(steps.length);
        setPhase("withdrawal-initiated");
        onWithdrawalInitiated?.({ l2TxHash: result.l2TxHash, l2Timestamp: result.l2Timestamp, amount, account, chainType: "op", l2Key: opL2Key });
      } else if (kind === "arb-deposit") {
        const depositFn = asset === "USDC" ? runArbErc20Deposit : runArbDeposit;
        const stepIndexMap = asset === "USDC" ? ARB_ERC20_DEPOSIT_STEP_INDEX : ARB_DEPOSIT_STEP_INDEX;
        const result = await depositFn({
          amountHuman: amount,
          onStep: (key) => { if (key !== "done") setStepIndex(stepIndexMap[key] ?? 0); },
        });
        setRealBurnHash(result.l1Hash);
        setStepIndex(steps.length);
        setPhase("done");
        onComplete(result.l1Hash);
      } else if (kind === "arb-withdraw") {
        const withdrawFn = asset === "USDC" ? initiateArbErc20Withdrawal : initiateArbWithdrawal;
        const result = await withdrawFn({
          account, amountHuman: amount,
          onStep: (key) => { if (key !== "done") setStepIndex(ARB_WITHDRAW_INITIATE_STEP_INDEX[key] ?? 0); },
        });
        setRealBurnHash(result.l2TxHash);
        setStepIndex(steps.length);
        setPhase("withdrawal-initiated");
        onWithdrawalInitiated?.({ l2TxHash: result.l2TxHash, amount, account, chainType: "arb" });
      } else if (kind === "wormhole" || kind === "wormhole-reverse") {
        const transferFn = kind === "wormhole" ? runWormholeTransfer : runWormholeTransferReverse;
        const result = await transferFn({
          amountHuman: amount,
          onStep: (step) => {
            if (typeof step === "object" && step.key === "hash-known") {
              setRealBurnHash(step.srcTxHash);
              return;
            }
            if (step !== "done") setStepIndex(WORMHOLE_STEP_INDEX[step] ?? 0);
          },
        });
        setRealBurnHash(result.srcTxHash);
        setRealMintHash(result.dstTxHash);
        setStepIndex(steps.length);
        setPhase("done");
        onComplete(result.srcTxHash);
      } else if (kind === "relay" && isFromSolana) {
        // Real, separate execution path for Solana-sourced transfers —
        // see relaySdkSolanaExecution.js for why this can't share the
        // EVM path below (wagmi has no concept of Solana chains at all).
        const decimals = fromCustom ? fromCustom.decimals : ASSET_ONCHAIN_DECIMALS[asset];
        const totalBaseUnits = parseUnits(amount, decimals);

        // Real fix for a real bug: the fee used to be sent as a standalone
        // pre-transfer (collected even if the real transfer then failed)
        // and the requested amount was shrunk 1% up front (breaking a
        // MAX-balance transfer). executeSolanaSourcedTransfer now attaches
        // the fee to the quote itself via Relay's own appFees mechanism —
        // see relaySdkSolanaExecution.js's own header for the full
        // explanation — so the full amount goes in and the fee is only
        // ever deducted atomically as part of a successful settlement.
        //
        // Real bug fix: toChainId/toCurrency previously had no wallet-
        // only-chain or custom-token override at all (unlike the EVM-
        // sourced path below, which already had one) — a Solana-sourced
        // transfer TO one of walletChains.js's broader chains would have
        // sent MAINNET_CHAIN_IDS[to] as undefined and thrown out of
        // currencyAddress(), which has no entry for them either.
        setStepIndex(0);
        const result = await executeSolanaSourcedTransfer({
          solanaAddress: account,
          solanaProvider: solanaWallet.solanaProvider.current,
          toChainId: isWalletOnlyChain(to) ? resolveChainId(to) : MAINNET_CHAIN_IDS[to],
          toCurrency: toCustom ? toCustom.address : (isWalletOnlyChain(to) ? resolveCurrency(to, toAsset) : currencyAddress(to, toAsset)),
          amountBaseUnits: totalBaseUnits.toString(),
          // Real bug fix: previously defaulted to `account`, which for a
          // Solana-sourced transfer IS the Solana address — invalid as a
          // recipient on any EVM destination chain. Relay's own docs are
          // explicit that Solana-involved routes need both wallets
          // connected; evmAddress is that second, EVM-side connection,
          // and the only valid default recipient here when no custom
          // destination is set.
          recipient: destination || evmAddress,
          onProgress: ({ currentStep, txHashes }) => {
            if (txHashes?.length) setRealBurnHash(txHashes[0]);
          },
        });
        setStepIndex(steps.length);
        setPhase("done");
        onComplete(result?.txHashes?.[0] || "");
      } else if (kind === "relay") {
        const decimals = fromCustom ? fromCustom.decimals : ASSET_ONCHAIN_DECIMALS[asset];
        const totalBaseUnits = parseUnits(amount, decimals);

        // Real root cause, found by tracing why "buy succeeds, sell
        // gets stuck" kept recurring on Robinhood Chain even after
        // adding OKX and improving the fallback error messages: a
        // token launched through this app's OWN Launchpad trades
        // through a Uniswap v4 pool with a CUSTOM hook
        // (MangoLaunchHook — a dynamic, asymmetric anti-dump fee, see
        // launchpad-contracts.js's own HOOK_BUY_FEE_BPS/
        // HOOK_EARLY_SELL_FEE_BPS comment: 1% buy, 4% sell
        // pre-graduation). Relay and every fallback aggregator tried
        // below (1inch/0x/OKX/KyberSwap) only know how to price and
        // route through well-known, generic pool shapes — none of
        // them has ever indexed this specific bespoke hook, so none
        // can correctly simulate a swap through it. A buy sometimes
        // still slips through by coincidence; a sell — which the hook
        // deliberately makes more complex pre-graduation — reliably
        // can't, no matter which of the 5 total routes attempts it.
        // The one path that genuinely understands this hook is
        // Mango's own Router (buyTokenReal/sellTokenReal — the exact
        // functions the Launchpad page's own Buy/Sell UI already uses
        // successfully). Tried first, ONLY for a same-chain Robinhood
        // Chain trade directly against native ETH (this Router has no
        // concept of any other quote asset) — getTradeQuote is a
        // read-only probe: if the address isn't a real deployed
        // Launchpad pool, its own getSlot0/getLiquidity reads revert,
        // and this falls through to the normal Relay path below
        // completely unchanged for every other token/chain/pair.
        if (from === "robinhood" && to === "robinhood") {
          const launchpadTokenAddress =
            asset === "ETH" && toCustom?.address ? toCustom.address :
            toAsset === "ETH" && fromCustom?.address ? fromCustom.address :
            null;
          if (launchpadTokenAddress) {
            const side = asset === "ETH" ? "buy" : "sell";
            let isLaunchpadPool = false;
            try {
              await getTradeQuote({ tokenAddress: launchpadTokenAddress, side, amountIn: totalBaseUnits });
              isLaunchpadPool = true;
            } catch {
              // Not a real Mango Launchpad pool for this address (or the
              // probe read itself failed) — fall through to Relay below,
              // exactly as before this fix.
            }
            if (isLaunchpadPool) {
              setStepIndex(0);
              // onHashKnown: same real gap this closes as the Relay/
              // fallback-provider paths' own onPendingHash tracking
              // above — without it, neither the approve step (sell
              // only) nor the actual buy/sell transaction's hash was
              // ever known to the UI until waitForTransactionReceipt
              // had ALREADY resolved inside buyTokenReal/sellTokenReal,
              // so a slow RPC or a closed tab during that wait left no
              // record either one had broadcast.
              const result = side === "buy"
                ? await buyTokenReal({ tokenAddress: launchpadTokenAddress, ethAmount: amount, recipient: account, onHashKnown: setRealBurnHash })
                : await sellTokenReal({ tokenAddress: launchpadTokenAddress, tokenAmountWei: totalBaseUnits, recipient: account, onHashKnown: setRealBurnHash });
              setRealBurnHash(result.hash);
              setStepIndex(steps.length);
              setPhase("done");
              onComplete(result.hash);
              return;
            }
          }
        }

        // Real fix, same as the Solana-sourced path above: getRelayQuote
        // now attaches the fee via Relay's own appFees mechanism (see
        // relaybridge.js's own header), deducted atomically only if the
        // transfer succeeds, so the full requested amount goes into the
        // quote with nothing carved out up front.
        setStepIndex(0);

        // Real fix, symmetric with the Solana-sourced path above: when
        // the DESTINATION is Solana (e.g. Base -> Solana), the default
        // recipient must be the connected Solana address, not the EVM
        // one — same category of bug as before, just the other
        // direction. Solana being involved on either side always needs
        // its own, correctly-typed address as the real recipient.
        const defaultRecipient = CHAINS[to]?.isSolana ? solanaWallet?.address : account;
        const quoteParams = {
          fromChainKey: from, toChainKey: to,
          fromAsset: asset, toAsset: toAsset,
          // Overrides needed for walletChains.js's wallet-only chains —
          // chainData.js has no verified MAINNET_CHAIN_IDS/currencyAddress
          // entry for them, so resolveChainId/resolveCurrency step in with
          // wagmi/chains' own chain id and the universal native
          // placeholder instead. undefined for every hand-verified chain,
          // where getRelayQuote's own internal lookups already apply. A
          // selected custom token (fromCustom/toCustom) takes priority
          // over the wallet-only-chain fallback — it has its own real,
          // verified address regardless of which chain it's on.
          originChainId: isWalletOnlyChain(from) ? resolveChainId(from) : undefined,
          originCurrency: fromCustom ? fromCustom.address : (isWalletOnlyChain(from) ? resolveCurrency(from, asset) : undefined),
          destinationChainId: isWalletOnlyChain(to) ? resolveChainId(to) : undefined,
          destinationCurrency: toCustom ? toCustom.address : (isWalletOnlyChain(to) ? resolveCurrency(to, toAsset) : undefined),
          amountBaseUnits: totalBaseUnits.toString(), userAddress: account,
          recipientAddress: destination || defaultRecipient,
        };
        // Real fallback, same-chain Swap only (from === to — Bridge
        // always has from !== to, so this never fires there): a route
        // that fails to simulate WITH the normal fee sometimes succeeds
        // at 0%, because Relay's solver network has to commit to
        // delivering (100%-fee%) of value for a fill — a thin/low-value
        // trade can fail to clear that bar with any fee attached at
        // all, live-confirmed on a real ~$1 sell. Deliberately does NOT
        // collect a separate fallback fee afterward the way mango-
        // mobile's own DexScreen.tsx does — this app signs through the
        // user's own connected wallet (wagmi), not a self-custodial key,
        // so doing that here would mean a SECOND signature prompt right
        // after the swap succeeds, actively working against the smooth
        // experience this fallback exists for. Forgoing a fee that
        // would mostly be sub-cent dust anyway is the right trade.
        let quote;
        let fallbackResult = null;
        try {
          quote = await getRelayQuote({ ...quoteParams, originAmountUsd });
        } catch (firstErr) {
          if (from !== to) {
            throw firstErr;
          }
          try {
            quote = await getRelayQuote({ ...quoteParams, feeBpsOverride: "0" });
          } catch {
            // Both Relay attempts failed — a genuine route gap, not a
            // fee-margin problem. Real second-source fallback
            // (fallbackDex.js): 0x/1inch/OKX/KyberSwap call
            // Uniswap/PancakeSwap/etc. directly, real liquidity Relay
            // might not have indexed yet.
            let fallbackErr;
            try {
              const sellTokenAddress = fromCustom ? fromCustom.address : resolveCurrency(from, asset);
              const buyTokenAddress = toCustom ? toCustom.address : resolveCurrency(to, toAsset);
              fallbackResult = await tryFallbackProviders({
                chainId: resolveChainId(from),
                sellToken: sellTokenAddress,
                buyToken: buyTokenAddress,
                sellAmount: totalBaseUnits.toString(),
                takerAddress: account,
                originAmountUsd,
                // Same real gap this closes as the Relay path's own
                // onPendingHash effect above: without this, the swap
                // transaction's hash was only ever known to the UI
                // AFTER waitForTransactionReceipt had already resolved
                // inside fallbackDex.js — a closed tab or slow RPC
                // during that wait left no record it had broadcast.
                onSwapHashKnown: setRealBurnHash,
              });
            } catch (err) {
              fallbackErr = err;
            }
            if (!fallbackResult) {
              // Real bug fix, live-reported: this used to throw ONLY
              // firstErr (Relay's own original error) — tryFallbackProviders'
              // own aggregate message (each of 1inch/0x/OKX/KyberSwap's
              // own specific failure reason) was silently discarded, so
              // a genuine Relay AMOUNT_TOO_LOW gave zero visibility into
              // whether the fallback providers were even reachable for
              // this chain/pair, let alone why each one failed. Relay's
              // error stays first (still the most informative single
              // reason a same-chain swap failed), with the fallback
              // detail appended rather than replacing it.
              throw new Error(fallbackErr?.message ? `${firstErr.message} Also tried 1inch/0x/OKX/KyberSwap: ${fallbackErr.message}` : firstErr.message);
            }
          }
        }
        const result = fallbackResult
          ? { txHashes: [fallbackResult.hash] }
          : await executeRelayQuote({
              quote,
              onStep: (step) => {
                if (typeof step === "object" && step.key === "hash-known") {
                  setRealBurnHash(step.txHash);
                  return;
                }
                if (step !== "done") setStepIndex(RELAY_STEP_INDEX[step] ?? 0);
              },
            });
        setRealBurnHash(result.txHashes[0]);
        // Deliberately NOT setting realMintHash here: when there's only one
        // signing step (the common case), the destination-side fill is
        // executed by Relay's own solver wallet, not the user's — there is
        // no destination-chain hash tied to the user's address to show.
        // Claiming one would be misleading.
        setStepIndex(steps.length);
        setPhase("done");
        onComplete(result.txHashes[0]);
      }
    } catch (err) {
      const rawMessage = err?.message || String(err);
      const isNoRoute = /No verified mainnet contract address|Relay quote failed/i.test(rawMessage);
      setErrorMessage(isNoRoute ? `No available route for this trade yet. (${rawMessage})` : rawMessage);
      setPhase("error");
    }
  }

  const displayHash = kind === "simulated" ? simulatedHash : (realBurnHash || "pending…");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(4,5,7,0.75)", backdropFilter: "blur(4px)" }}>
      <div className="w-full max-w-sm rounded-2xl p-5" style={{ background: "#14171D", border: "1px solid #262C36" }}>
        <div className="flex items-center justify-between mb-4">
          <span className="font-mono text-[11px] tracking-wide" style={{ color: "#5B6472" }}>
            {phase === "review" ? (isReal ? "real transfer" : displayHash) : displayHash.slice(0, 18)}
          </span>
          {phase === "progress" ? (
            <div className="flex items-center gap-2.5">
              <span className="text-[11px] uppercase tracking-wider" style={{ color: LIME }}>In progress</span>
              <button onClick={onClose} title="Go back — your transaction keeps running in the background">
                <ArrowLeft size={15} color="#5B6472" />
              </button>
            </div>
          ) : (
            <button onClick={onClose}><X size={16} color="#5B6472" /></button>
          )}
        </div>

        {phase === "progress" && (
          <div className="text-[11px] mb-3 -mt-2" style={{ color: "#4A515D" }}>
            You can go back — this keeps running in the background.
          </div>
        )}

        <div className="flex items-center justify-center gap-3 mb-5">
          <ChainBadge id={from} size={22} />
          <ArrowUpRight size={13} color="#4A515D" />
          <ChainBadge id={to} size={22} />
        </div>

        <div className="text-center mb-5 py-3 rounded-xl" style={{ background: "#0E1116", border: "1px solid #1E232B" }}>
          <div className="font-display text-2xl font-semibold" style={{ color: "#F2F4F7" }}>{amount || "0"} {asset}</div>
          <div className="text-[12px] mt-0.5" style={{ color: "#5B6472" }}>{a.name} → {b.name}</div>
          {destination && <div className="text-[11px] mt-1 font-mono" style={{ color: "#4A515D" }}>to {destination}</div>}
        </div>

        {phase === "review" && (
          <>
            <div className="flex flex-col gap-2.5 mb-5">
              <div className="flex items-center justify-between text-[13px]"><span style={{ color: "#5B6472" }}>Network fee</span><span className="font-mono" style={{ color: "#D7DBE2" }}>${fmt(fee, 2)}</span></div>
              <div className="flex items-center justify-between text-[13px]"><span style={{ color: "#5B6472" }}>Protocol fee ({formatFeePct(DEV_FEE_PCT)}%)</span><span className="font-mono" style={{ color: "#D7DBE2" }}>{fmt(devFeeAmount, 4)} {asset}</span></div>
              <div className="flex items-center justify-between text-[13px]"><span style={{ color: "#5B6472" }}>Estimated time</span><span style={{ color: "#D7DBE2" }}>{kind === "op-withdraw" || kind === "arb-withdraw" ? "~7 days to finalize" : etaLabel}</span></div>
              <div className="flex items-center justify-between text-[13px]"><span style={{ color: "#5B6472" }}>You receive</span><span className="font-mono font-medium" style={{ color: "#F2F4F7" }}>{received !== null ? `${fmt(received, 4)} ${toAsset}${asset !== toAsset ? " (estimate)" : ""}` : "Set by Relay's live quote"}</span></div>
            </div>
            {receivedRoundsToZero && (
              <div className="flex items-start gap-2 mb-4 px-3 py-2.5 rounded-lg text-[12px]" style={{ background: "#F0B84D14", border: "1px solid #F0B84D40", color: "#F0B84D" }}>
                <AlertTriangle size={14} className="shrink-0 mt-0.5" color="#F0B84D" />
                This amount would return next to nothing at the current rate — you're likely to lose most of what you send. Consider a larger amount, or check that this token/pair actually has a working route before confirming.
              </div>
            )}
            <div className="flex items-start gap-2 mb-4 px-3 py-2.5 rounded-lg text-[12px]" style={{ background: isReal ? `${LIME}14` : "#1C212A", border: `1px solid ${isReal ? LIME + "40" : "#262C36"}`, color: isReal ? LIME : "#8B95A1" }}>
              <AlertTriangle size={14} className="shrink-0 mt-0.5" color={isReal ? LIME : "#F0B84D"} />
              {kind === "cctp" && "Real testnet transfer via Circle's CCTP. You'll be asked to approve and sign transactions."}
              {kind === "op-deposit" && `Real testnet deposit via ${CHAINS[opL2Key].name}'s official bridge contract. One transaction to sign.`}
              {kind === "op-withdraw" && `This only starts a real withdrawal. ${CHAINS[opL2Key].name} requires a 7-day challenge period — you'll need to come back later to prove and finalize it from the Withdrawals tab.`}
              {kind === "arb-deposit" && asset === "USDC" && "Real testnet deposit via Robinhood Chain's Arbitrum bridge (standard ERC-20 gateway). This produces a bridged USDC representation — not CCTP-native USDC, and not Robinhood Chain's real native USDG stablecoin. Two transactions to sign (approve + deposit)."}
              {kind === "arb-deposit" && asset === "ETH" && "Real testnet deposit via Robinhood Chain's official Arbitrum bridge. One transaction to sign."}
              {kind === "arb-withdraw" && "This only starts a real withdrawal. Robinhood Chain requires a ~7-day challenge period — you'll need to come back later to finalize it from the Withdrawals tab. This integration is newer and less battle-tested than the Base one — start with a small amount."}
              {kind === "wormhole" && `Real transfer via Wormhole. You'll receive Wormhole-wrapped ETH on ${CHAINS.bnb.name} — not native BNB or any other app's wrapped ETH. This is the newest, least battle-tested integration here — start very small.`}
              {kind === "wormhole-reverse" && `Real transfer via Wormhole — burns your Wormhole-wrapped ETH on ${CHAINS.bnb.name} and unlocks the original ETH on ${CHAINS.ethereum.name}. Only works if your BNB-side ETH actually arrived via this same bridge. Just built, not yet proven live — start very small.`}
              {kind === "relay" && asset === toAsset && "Route uses Relay's solver network to enable fast, non-custodial cross-chain transfers."}
              {kind === "relay" && asset !== toAsset && `Real swap via Relay's solver network — ${asset} in, ${toAsset} out. The "You receive" amount above is a rough estimate; the actual rate is set at execution by Relay's quote, and can differ meaningfully for volatile assets. Just built, not yet proven live — start very small.`}
              {kind === "simulated" && "Simulated route — real transfers aren't wired up for this chain/asset pair yet."}
            </div>
            {(kind === "op-deposit" || kind === "arb-deposit") && (
              <div className="flex items-start gap-2 mb-4 px-3 py-2.5 rounded-lg text-[11.5px]" style={{ background: "#1C212A", border: "1px solid #262C36", color: "#8B95A1" }}>
                📝 Deposits like this are fast, but heads up — if you ever bridge this back the other way, that withdrawal takes a real 7-day challenge period, not minutes.
              </div>
            )}
            <button onClick={handleConfirm} className="w-full py-3 rounded-xl font-display font-semibold text-[14.5px]" style={{ background: `linear-gradient(135deg, ${LIME}, ${LIME_DEEP})`, color: "#10130A" }}>
              {kind === "op-withdraw" || kind === "arb-withdraw" ? "Start withdrawal" : from === to ? "Confirm swap" : "Confirm bridge"}
            </button>
          </>
        )}

        {phase === "error" && (
          <div className="flex flex-col gap-3">
            <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg text-[12.5px] font-mono" style={{ background: "#2A1414", border: "1px solid #4A1E1E", color: "#E5726B" }}>
              {errorMessage}
            </div>
            {isReal && realBurnHash && (
              <div className="flex flex-col gap-2 px-3 py-2.5 rounded-lg text-[12px]" style={{ background: `${LIME}14`, border: `1px solid ${LIME}40`, color: LIME }}>
                <span>Your transaction likely succeeded on-chain — this error happened after. Hash: <span className="font-mono">{realBurnHash.slice(0, 10)}…{realBurnHash.slice(-6)}</span></span>
                {(kind === "op-withdraw" || kind === "arb-withdraw") && <span>Go to the Withdrawals tab and use "Track by hash" with the full hash to recover it.</span>}
                {(kind === "wormhole" || kind === "wormhole-reverse") && <span>Your ETH is locked/burned on {kind === "wormhole" ? CHAINS.ethereum.name : CHAINS.bnb.name} — nothing is lost. Wait a bit for the guardians to finish, then tap Resume below.</span>}
                <a href={`${a.explorer}${realBurnHash}`} target="_blank" rel="noopener noreferrer" className="underline">View on {a.name} explorer</a>
              </div>
            )}
            {(kind === "wormhole" || kind === "wormhole-reverse") && realBurnHash && (
              <button
                onClick={async () => {
                  setPhase("progress");
                  setStepIndex(2);
                  setErrorMessage("");
                  try {
                    const result = await resumeWormholeTransfer({
                      srcTxHash: realBurnHash,
                      fromChainName: kind === "wormhole" ? "Ethereum" : "Bsc",
                      toChainName: kind === "wormhole" ? "Bsc" : "Ethereum",
                      toChainId: kind === "wormhole" ? getWagmiChain("bnb").id : getWagmiChain("ethereum").id,
                      onStep: (step) => { if (step !== "done") setStepIndex(WORMHOLE_STEP_INDEX[step] ?? 2); },
                    });
                    setRealMintHash(result.dstTxHash);
                    setStepIndex(steps.length);
                    setPhase("done");
                    onComplete(result.srcTxHash);
                  } catch (err) {
                    setErrorMessage(err?.message || String(err));
                    setPhase("error");
                  }
                }}
                className="w-full py-3 rounded-xl font-display font-semibold text-[14.5px]"
                style={{ background: `linear-gradient(135deg, ${LIME}, ${LIME_DEEP})`, color: "#10130A" }}
              >
                Resume Wormhole transfer
              </button>
            )}
            <button onClick={onClose} className="w-full py-2.5 rounded-lg text-[13.5px] font-medium" style={{ background: "#1C212A", color: "#B6BEC9", border: "1px solid #262C36" }}>
              Close
            </button>
          </div>
        )}

        {(phase === "progress" || phase === "done" || phase === "withdrawal-initiated") && (
          <div className="flex flex-col gap-3">
            {steps.map((s, i) => {
              const state = i < stepIndex ? "done" : i === stepIndex && phase === "progress" ? "active" : phase !== "progress" ? "done" : "pending";
              return (
                <div key={s.key} className="flex items-center gap-3">
                  <div className="w-5 h-5 rounded-full flex items-center justify-center shrink-0" style={{ background: state === "done" ? `${LIME}22` : state === "active" ? `${LIME}22` : "#181C24", border: state === "done" ? `1px solid ${LIME}` : state === "active" ? `1px solid ${LIME}` : "1px solid #262C36" }}>
                    {state === "done" && <Check size={11} color={LIME} />}
                    {state === "active" && <Loader2 size={11} color={LIME} className="animate-spin" />}
                  </div>
                  <span className="text-[13.5px]" style={{ color: state === "pending" ? "#4A515D" : "#D7DBE2" }}>{s.label}</span>
                </div>
              );
            })}

            {phase === "withdrawal-initiated" && (
              <div className="mt-2 flex flex-col gap-2">
                <div className="flex items-center gap-2 text-[13px] px-3 py-2.5 rounded-lg" style={{ background: `${LIME}14`, border: `1px solid ${LIME}40`, color: LIME }}>
                  <Check size={14} /> Withdrawal started
                </div>
                <div className="text-[12px] px-1" style={{ color: "#8B95A1" }}>
                  {kind === "op-withdraw"
                    ? "Check the Withdrawals tab in about an hour to prove it, then again in ~7 days to finalize."
                    : "Check the Withdrawals tab in ~7 days to finalize it."}
                </div>
                <a href={`${a.explorer}${realBurnHash}`} target="_blank" rel="noopener noreferrer" className="w-full py-2.5 rounded-lg text-[13.5px] font-medium flex items-center justify-center gap-1.5" style={{ background: "#1C212A", color: "#B6BEC9", border: "1px solid #262C36" }}>
                  View tx on {a.name} <ExternalLink size={13} />
                </a>
                <button onClick={onClose} className="w-full py-2 text-[12.5px]" style={{ color: "#5B6472" }}>Close</button>
              </div>
            )}

            {phase === "done" && (
              <div className="mt-2 flex flex-col gap-2">
                <div className="flex items-center gap-2 text-[13px] px-3 py-2.5 rounded-lg" style={{ background: `${LIME}14`, border: `1px solid ${LIME}40`, color: LIME }}>
                  <Check size={14} /> {from === to ? "Swap complete" : "Bridge complete"}
                </div>
                {isReal ? (
                  <>
                    <a
                      href={`${a.explorer}${realBurnHash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="w-full py-2.5 rounded-lg text-[13.5px] font-medium flex items-center justify-center gap-1.5"
                      style={{ background: "#1C212A", color: "#B6BEC9", border: "1px solid #262C36" }}
                    >
                      View {kind === "op-deposit" || kind === "arb-deposit" ? "L1" : kind === "wormhole" ? "lock" : "burn"} tx on {a.name} <ExternalLink size={13} />
                    </a>
                    {realMintHash && (
                      <a
                        href={`${b.explorer}${realMintHash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="w-full py-2.5 rounded-lg text-[13.5px] font-medium flex items-center justify-center gap-1.5"
                        style={{ background: "#1C212A", color: "#B6BEC9", border: "1px solid #262C36" }}
                      >
                        View {kind === "op-deposit" ? "L2" : "mint"} tx on {b.name} <ExternalLink size={13} />
                      </a>
                    )}
                    {!realMintHash && (kind === "arb-deposit") && (
                      <div className="w-full py-2 text-[11.5px] text-center" style={{ color: "#4A515D" }}>
                        Funds typically arrive on {b.name} within a few minutes — check your balance there.
                      </div>
                    )}
                    {!realMintHash && kind === "relay" && (
                      <div className="w-full py-2 text-[11.5px] text-center" style={{ color: "#4A515D" }}>
                        Relay's solver completes the transfer on {b.name} using its own wallet, not yours — there's no destination hash tied to your address to show. Check your balance there in a minute or two.
                      </div>
                    )}
                  </>
                ) : (
                  <div className="w-full py-2.5 rounded-lg text-[12.5px] text-center" style={{ background: "#161A20", color: "#4A515D", border: "1px solid #1E232B" }}>
                    Simulated transfer — no real explorer record exists
                  </div>
                )}
                <button onClick={onClose} className="w-full py-2 text-[12.5px]" style={{ color: "#5B6472" }}>
                  Close
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

function HistoryTab({ history, onReset }) {
  if (history.length === 0) {
    return (
      <div className="rounded-2xl p-8 flex flex-col items-center text-center gap-2" style={{ background: "#12151B", border: "1px solid #1E232B" }}>
        <HistoryIcon size={22} color="#333A44" />
        <div className="text-[13.5px]" style={{ color: "#8B95A1" }}>No bridges yet</div>
        <div className="text-[12px]" style={{ color: "#4A515D" }}>Your transfers will show up here as soon as they broadcast — including still-pending ones.</div>
      </div>
    );
  }
  return (
    <div className="rounded-2xl overflow-hidden" style={{ background: "#12151B", border: "1px solid #1E232B" }}>
      {history.map((tx, i) => {
        // Real gap this closes: every row showed its own real,
        // already-known hash as plain, unclickable text — no way to
        // actually verify a trade on-chain without manually copying it
        // into an explorer yourself. tx.from is the chain the hash
        // itself lives on (both handleComplete and handlePendingHash
        // record it that way), so that's always the right explorer to
        // link to, same convention BridgeModal's own error state
        // already uses for realBurnHash. Falls back to plain text for
        // a chain with no verified explorer entry (a wallet-only chain
        // this app hasn't hand-added CHAINS data for) rather than a
        // dead/wrong link.
        const explorerBase = CHAINS[tx.from]?.explorer;
        const explorerUrl = explorerBase && tx.hash ? `${explorerBase}${tx.hash}` : null;
        return (
          <div key={tx.id} className="flex items-center gap-3 px-4 py-3.5" style={{ borderTop: i === 0 ? "none" : "1px solid #1A1E26" }}>
            <div className="flex items-center -space-x-1.5">
              <ChainBadge id={tx.from} size={22} />
              <ChainBadge id={tx.to} size={22} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 text-[13.5px] font-medium" style={{ color: "#F2F4F7" }}>{fmt(tx.amount, 2)} {tx.symbol}<ArrowUpRight size={11} color="#4A515D" /></div>
              {explorerUrl ? (
                <a href={explorerUrl} target="_blank" rel="noopener noreferrer" className="text-[11.5px] font-mono underline decoration-dotted underline-offset-2 hover:opacity-80" style={{ color: "#4A515D" }}>
                  {tx.hash} · {timeAgo(tx.timestamp)}
                </a>
              ) : (
                <div className="text-[11.5px] font-mono" style={{ color: "#4A515D" }}>{tx.hash} · {timeAgo(tx.timestamp)}</div>
              )}
            </div>
            <StatusPill status={tx.status} />
          </div>
        );
      })}
      <button onClick={onReset} className="w-full flex items-center justify-center gap-1.5 py-2.5 text-[12px]" style={{ color: "#4A515D", borderTop: "1px solid #1A1E26" }}>
        <RotateCcw size={12} /> Clear history
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main app
// ---------------------------------------------------------------------------

const WITHDRAWAL_STATUS_LABEL = {
  "waiting-to-prove": "Waiting to be provable (~1hr after initiating)",
  "ready-to-prove": "Ready to prove",
  "waiting-to-finalize": "Waiting out the 7-day challenge period",
  "ready-to-finalize": "Ready to finalize",
  finalized: "Finalized",
};

// Real, resolved label for any OP Stack withdrawal — covers Base, Ink, and
// Unichain (and stays correct automatically if another OP Stack chain's
// canonical bridge is added later) rather than a fixed op/arb pair. Old
// persisted withdrawal records predate l2Key and won't have one; those
// default to "base", which is what they always meant before this existed.
function opStackWithdrawalLabel(l2Key) {
  const key = l2Key || "base";
  return `${CHAINS[key]?.name || "Base"} → ${CHAINS.ethereum.name}`;
}
const CHAIN_TYPE_LABEL = { arb: "Robinhood Chain → Ethereum" };

function WithdrawalRow({ w, onUpdate }) {
  const [checking, setChecking] = useState(false);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState("");
  const isArb = w.chainType === "arb";
  const l2Key = w.l2Key || "base";

  async function checkStatus() {
    setChecking(true);
    setError("");
    try {
      const result = isArb
        ? await getArbWithdrawalStatus({ l2TxHash: w.l2TxHash })
        : await getOpWithdrawalStatus({ l2TxHash: w.l2TxHash, l2Timestamp: w.l2Timestamp, l2Key });
      onUpdate({ ...w, status: result.status, etaSeconds: result.etaSeconds, lastChecked: Date.now() });
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setChecking(false);
    }
  }

  async function prove() {
    setActing(true);
    setError("");
    try {
      const { proveHash } = await proveOpWithdrawal({ l2TxHash: w.l2TxHash, l2Timestamp: w.l2Timestamp, l2Key });
      onUpdate({ ...w, proveHash, status: "waiting-to-finalize" });
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setActing(false);
    }
  }

  async function finalize() {
    setActing(true);
    setError("");
    try {
      const { finalizeHash } = isArb
        ? await finalizeArbWithdrawal({ l2TxHash: w.l2TxHash })
        : await finalizeOpWithdrawal({ l2TxHash: w.l2TxHash, l2Key });
      onUpdate({ ...w, finalizeHash, status: "finalized" });
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setActing(false);
    }
  }

  const daysLeft = w.etaSeconds ? Math.ceil(w.etaSeconds / 86400) : null;

  return (
    <div className="px-4 py-3.5" style={{ borderTop: "1px solid #1A1E26" }}>
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[13.5px] font-medium" style={{ color: "#F2F4F7" }}>{w.amount} ETH — {isArb ? CHAIN_TYPE_LABEL.arb : opStackWithdrawalLabel(l2Key)}</span>
        <span className="text-[11px]" style={{ color: "#4A515D" }}>{timeAgo(w.initiatedAt)}</span>
      </div>
      <div className="text-[12px] mb-2.5" style={{ color: "#8B95A1" }}>
        {w.status ? WITHDRAWAL_STATUS_LABEL[w.status] || w.status : "Status unknown — tap Check status"}
        {daysLeft ? ` (~${daysLeft}d left)` : ""}
      </div>
      {error && <div className="text-[11px] font-mono mb-2" style={{ color: "#E5726B" }}>{error}</div>}
      <div className="flex gap-2">
        <button onClick={checkStatus} disabled={checking || acting} className="flex-1 py-2 rounded-lg text-[12px] font-medium" style={{ background: "#1C212A", color: "#B6BEC9", border: "1px solid #262C36" }}>
          {checking ? "Checking…" : "Check status"}
        </button>
        {!isArb && w.status === "ready-to-prove" && (
          <button onClick={prove} disabled={acting} className="flex-1 py-2 rounded-lg text-[12px] font-semibold" style={{ background: LIME, color: "#10130A" }}>
            {acting ? "Proving…" : "Prove"}
          </button>
        )}
        {w.status === "ready-to-finalize" && (
          <button onClick={finalize} disabled={acting} className="flex-1 py-2 rounded-lg text-[12px] font-semibold" style={{ background: LIME, color: "#10130A" }}>
            {acting ? "Finalizing…" : "Finalize"}
          </button>
        )}
      </div>
    </div>
  );
}

function TrackByHashForm({ onTracked }) {
  const [hash, setHash] = useState("");
  // "arb" for Robinhood Chain, otherwise this IS the l2Key directly
  // (base/ink/unichain) — trackWithdrawalByHash needs to know which OP
  // Stack chain's client to look the transaction up against.
  const [chainType, setChainType] = useState("base");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleTrack() {
    setLoading(true);
    setError("");
    try {
      if (chainType === "arb") {
        const { l2TxHash } = await trackArbWithdrawalByHash({ l2TxHash: hash.trim() });
        onTracked({ id: Date.now(), l2TxHash, amount: "?", initiatedAt: Date.now(), status: "waiting-to-finalize", chainType: "arb" });
      } else {
        const { l2TxHash, l2Timestamp } = await trackWithdrawalByHash({ l2TxHash: hash.trim(), l2Key: chainType });
        onTracked({ id: Date.now(), l2TxHash, l2Timestamp, amount: "?", initiatedAt: Date.now(), status: "waiting-to-prove", chainType: "op", l2Key: chainType });
      }
      setHash("");
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-2xl p-4 mb-3" style={{ background: "#12151B", border: "1px solid #1E232B" }}>
      <div className="text-[12.5px] font-medium mb-2" style={{ color: "#8B95A1" }}>
        Had a withdrawal succeed on-chain but not show up here? Track it by hash:
      </div>
      <div className="flex gap-1 mb-2 p-1 rounded-lg w-fit flex-wrap" style={{ background: "#0E1116" }}>
        {[{ id: "base", label: "Base" }, { id: "ink", label: "Ink" }, { id: "unichain", label: "Unichain" }, { id: "arb", label: "Robinhood Chain" }].map((c) => (
          <button key={c.id} onClick={() => setChainType(c.id)} className="px-3 py-1 rounded-md text-[11.5px] font-medium" style={{ background: chainType === c.id ? "#1E232B" : "transparent", color: chainType === c.id ? "#F2F4F7" : "#5B6472" }}>
            {c.label}
          </button>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          value={hash}
          onChange={(e) => setHash(e.target.value)}
          placeholder="0x… L2 transaction hash"
          className="flex-1 px-3 py-2 rounded-lg text-[12.5px] font-mono"
          style={{ background: "#0E1116", border: "1px solid #1E232B", color: "#F2F4F7" }}
        />
        <button onClick={handleTrack} disabled={loading || !hash.trim()} className="px-4 py-2 rounded-lg text-[12.5px] font-semibold" style={{ background: LIME, color: "#10130A" }}>
          {loading ? "Checking…" : "Track"}
        </button>
      </div>
      {error && <div className="text-[11px] font-mono mt-2" style={{ color: "#E5726B" }}>{error}</div>}
    </div>
  );
}

function WithdrawalsTab({ withdrawals, onUpdate, onTrack }) {
  return (
    <>
      <TrackByHashForm onTracked={onTrack} />
      {withdrawals.length === 0 ? (
        <div className="rounded-2xl p-8 flex flex-col items-center text-center gap-2" style={{ background: "#12151B", border: "1px solid #1E232B" }}>
          <HistoryIcon size={22} color="#333A44" />
          <div className="text-[13.5px]" style={{ color: "#8B95A1" }}>No pending withdrawals</div>
          <div className="text-[12px]" style={{ color: "#4A515D" }}>Start a {CHAINS.base.name} → {CHAINS.ethereum.name} ETH transfer to see it tracked here.</div>
        </div>
      ) : (
        <div className="rounded-2xl overflow-hidden" style={{ background: "#12151B", border: "1px solid #1E232B" }}>
          {withdrawals.map((w) => (
            <WithdrawalRow key={w.id} w={w} onUpdate={onUpdate} />
          ))}
        </div>
      )}
    </>
  );
}

function PortfolioRow({ chainKey, address, connected, P, isFirst }) {
  const c = CHAINS[chainKey];
  const wagmiChain = getWagmiChain(chainKey);
  const { data, isLoading } = useBalance({ address, chainId: wagmiChain.id, query: { enabled: connected } });

  const usdcAddress = CCTP_CHAINS[chainKey]?.usdc;
  const { data: usdcData, isLoading: usdcLoading } = useBalance({
    address,
    token: usdcAddress,
    chainId: wagmiChain.id,
    query: { enabled: connected && !!usdcAddress },
  });

  return (
    <div className="flex items-center justify-between px-4 py-3.5" style={{ borderTop: isFirst ? "none" : `1px solid ${P.divider}` }}>
      <div className="flex items-center gap-2.5">
        <ChainBadge id={chainKey} size={26} />
        <span className="text-[13.5px] font-medium" style={{ color: P.textPrimary }}>{c.name}</span>
      </div>
      <div className="flex flex-col items-end gap-1">
        <div className="flex items-center gap-1.5 text-[13.5px] font-mono font-medium" style={{ color: P.textPrimary }}>
          <span>{!connected ? "—" : isLoading ? "…" : data ? Number(data.formatted).toFixed(4) : "0.0000"}</span>
          <span className="text-[11px] font-sans" style={{ color: P.textMuted }}>{NATIVE_SYMBOL_BY_CHAIN[chainKey]}</span>
        </div>
        {usdcAddress && (
          <div className="flex items-center gap-1.5 text-[12px] font-mono" style={{ color: P.textSecondary }}>
            <span>{!connected ? "—" : usdcLoading ? "…" : usdcData ? Number(usdcData.formatted).toFixed(2) : "0.00"}</span>
            <span className="text-[10.5px] font-sans" style={{ color: P.textMuted }}>USDC</span>
          </div>
        )}
      </div>
    </div>
  );
}

function PortfolioTab({ address, connected, P }) {
  if (!connected) {
    return (
      <div className="rounded-2xl p-8 flex flex-col items-center text-center gap-2" style={{ background: P.panel, border: `1px solid ${P.panelBorder}` }}>
        <Wallet size={22} color={P.textMuted} />
        <div className="text-[13.5px]" style={{ color: P.textSecondary }}>Connect your wallet</div>
        <div className="text-[12px]" style={{ color: P.textMuted }}>Your native balance across every supported chain will show up here.</div>
      </div>
    );
  }
  return (
    <div className="rounded-2xl overflow-hidden" style={{ background: P.panel, border: `1px solid ${P.panelBorder}` }}>
      {CHAIN_ORDER.map((key, i) => (
        <PortfolioRow key={key} chainKey={key} address={address} connected={connected} P={P} isFirst={i === 0} />
      ))}
      <div className="px-4 py-3 text-[11px]" style={{ color: P.textMuted, borderTop: `1px solid ${P.divider}` }}>
        Native balance shown for every chain. USDC shown where a real contract exists (Ethereum, Base). Other assets (USDT, WBTC, USDG, BNB) route through Relay based on your Bridge tab selection — check the Bridge tab for what's supported on a given pair.
      </div>
    </div>
  );
}

// One shared modal, not a separate picker per tab — which networks it
// offers depends on which tab opened it. Bridge (and every other tab)
// gets the full real chain list, unchanged. Launchpad only ever works on
// two networks, so it gets exactly those two here instead of a second,
// duplicate selector living inside Launchpad.jsx itself.
function NetworkSelectorModal({ onClose, P, tab, launchpadNetwork, setLaunchpadNetwork }) {
  const { switchChain } = useSwitchChain();
  const { chainId: connectedChainId, isConnected } = useAccount();
  const isLaunchpad = tab === "launchpad";
  const chains = isLaunchpad
    ? { robinhood: getChains().robinhood, solana: getChains().solana }
    : getChains();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(4,5,7,0.6)", backdropFilter: "blur(4px)" }}>
      {/* Real fix: with 14 networks now supported, a flat list at ~52px a row
          runs past 700px tall — on mobile that pushed the modal itself off
          screen and forced a page-level scroll instead of a contained one.
          Only the list in the middle scrolls now; the header and footer
          note stay fixed, and the scrollbar itself is thin/subtle rather
          than the browser default, with native momentum scrolling on iOS. */}
      <style>{`
        .mango-network-scroll::-webkit-scrollbar { width: 5px; }
        .mango-network-scroll::-webkit-scrollbar-track { background: transparent; }
        .mango-network-scroll::-webkit-scrollbar-thumb { background: ${P.textMuted}55; border-radius: 999px; }
        .mango-network-scroll { scrollbar-width: thin; scrollbar-color: ${P.textMuted}55 transparent; -webkit-overflow-scrolling: touch; }
      `}</style>
      <div className="w-full max-w-sm rounded-2xl p-5 flex flex-col" style={{ background: P.bg, border: `1px solid ${P.panelBorder}`, maxHeight: "min(80vh, 560px)" }}>
        <div className="flex items-center justify-between mb-4 shrink-0">
          <span className="font-display text-[16px] font-semibold" style={{ color: P.textPrimary }}>Select Network</span>
          <button onClick={onClose}><X size={18} color={P.textMuted} /></button>
        </div>
        <div
          className="mango-network-scroll flex flex-col gap-1.5 overflow-y-auto pr-1 -mr-1"
          style={{ maxHeight: "min(60vh, 440px)" }}
        >
          {Object.values(chains).map((chain) => {
            const wagmiChain = getWagmiChain(chain.id);
            // Launchpad's two entries are a display-mode toggle (which
            // network's launchpad you're looking at), not a real wallet
            // connection check — Solana isn't wagmi-switchable at all
            // (getWagmiChain returns id: undefined for it, see
            // networkMode.js), so "active" has to mean something
            // different here than it does for Bridge's real chain list.
            const isActive = isLaunchpad
              ? launchpadNetwork === chain.id
              : isConnected && connectedChainId === wagmiChain.id;
            return (
              <button
                key={chain.id}
                onClick={() => {
                  if (isLaunchpad) {
                    setLaunchpadNetwork(chain.id);
                    // Robinhood Chain is a real, tradeable network here —
                    // still worth actually switching the wallet to it.
                    // Solana isn't (no wagmi chain to switch to, and
                    // picking it just shows the coming-soon panel).
                    if (chain.id === "robinhood" && isConnected) {
                      switchChain({ chainId: wagmiChain.id });
                    }
                  } else if (isConnected) {
                    switchChain({ chainId: wagmiChain.id });
                  }
                  onClose();
                }}
                className="flex items-center justify-between px-3.5 py-3 rounded-xl shrink-0"
                style={{ background: isActive ? P.pillBg : "transparent", border: `1px solid ${isActive ? P.panelBorder : "transparent"}` }}
              >
                <div className="flex items-center gap-2.5">
                  <ChainBadge id={chain.id} size={26} />
                  <span className="text-[13.5px] font-medium" style={{ color: P.textPrimary }}>{chain.name}</span>
                </div>
                {isActive && <Check size={15} color={LIME_DEEP} />}
              </button>
            );
          })}
        </div>
        {!isConnected && (
          <div className="text-[11px] mt-3 text-center shrink-0" style={{ color: P.textMuted }}>Connect a wallet to switch networks.</div>
        )}
      </div>
    </div>
  );
}

// Real wallet selection, now backed by Reown AppKit's own searchable,
// 500+-wallet directory instead of a hand-enumerated button list — see
// src/appkit.js for the createAppKit() call this modal opens into.
// OKX Wallet for Solana stays as its own explicitly-labeled option since
// it's deliberately kept outside AppKit (see appkit.js for why).
function WalletSelectorModal({ onClose, P, solanaRelevant }) {
  const solanaWallet = useSolanaWallet();
  const { open: openAppKit } = useAppKit();
  const [connectingOkx, setConnectingOkx] = useState(false);

  async function handleOkxConnect() {
    setConnectingOkx(true);
    try {
      await solanaWallet.connect();
      onClose();
    } catch {
      // Real error is already captured in solanaWallet.error and shown
      // below — nothing further needed here beyond stopping the
      // loading state.
    } finally {
      setConnectingOkx(false);
    }
  }

  function openAppKitSolana() {
    openAppKit({ view: "Connect", namespace: "solana" });
    onClose();
  }

  function openAppKitEvm() {
    openAppKit({ view: "Connect", namespace: "eip155" });
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(4,5,7,0.6)", backdropFilter: "blur(4px)" }}>
      <div className="w-full max-w-sm rounded-2xl p-5 max-h-[85vh] overflow-y-auto" style={{ background: P.bg, border: `1px solid ${P.panelBorder}` }}>
        <div className="flex items-center justify-between mb-4">
          <span className="font-display text-[16px] font-semibold" style={{ color: P.textPrimary }}>Connect Wallet</span>
          <button onClick={onClose}><X size={18} color={P.textMuted} /></button>
        </div>

        {solanaRelevant && (
          <div className="mb-4">
            <div className="text-[11px] font-semibold uppercase tracking-wide mb-2" style={{ color: P.textMuted }}>Solana</div>
            <div className="flex flex-col gap-2">
              <button
                onClick={handleOkxConnect}
                disabled={connectingOkx}
                className="flex items-center justify-between px-3.5 py-3 rounded-xl text-left"
                style={{ background: P.pillBg, border: `1px solid ${P.panelBorder}`, opacity: connectingOkx ? 0.6 : 1 }}
              >
                <span className="text-[13.5px] font-semibold" style={{ color: P.textPrimary }}>OKX Wallet</span>
                {connectingOkx && <span className="text-[11px]" style={{ color: P.textMuted }}>Connecting…</span>}
              </button>
              <button
                onClick={openAppKitSolana}
                className="flex flex-col items-start px-3.5 py-3 rounded-xl text-left"
                style={{ background: P.pillBg, border: `1px solid ${P.panelBorder}` }}
              >
                <span className="text-[13.5px] font-semibold" style={{ color: P.textPrimary }}>More Solana Wallets</span>
                <span className="text-[11px] mt-0.5" style={{ color: P.textMuted }}>Phantom, Solflare, Coinbase, Trust, Backpack, and more</span>
              </button>
            </div>
          </div>
        )}

        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide mb-2" style={{ color: P.textMuted }}>EVM</div>
          <button
            onClick={openAppKitEvm}
            className="w-full flex flex-col items-start px-3.5 py-3 rounded-xl text-left"
            style={{ background: P.pillBg, border: `1px solid ${P.panelBorder}` }}
          >
            <span className="text-[13.5px] font-semibold" style={{ color: P.textPrimary }}>Browse EVM Wallets</span>
            <span className="text-[11px] mt-0.5" style={{ color: P.textMuted }}>MetaMask, Trust Wallet, Binance Wallet, SafePal, and 500+ more</span>
          </button>
        </div>

        {solanaWallet.error && (
          <div className="mt-3 rounded-lg p-3 text-[11.5px]" style={{ background: "#D92D2015", border: "1px solid #D92D2040", color: "#D92D20" }}>
            {solanaWallet.error}
          </div>
        )}
      </div>
    </div>
  );
}

// Docs — sidebar-driven, one page at a time (grouped nav, breadcrumb,
// search-filtered sidebar), replacing the previous single long-scroll
// modal. Every fact below is carried over verbatim from that version —
// this only restructures how it's organized and presented; nothing here
// is newly claimed. DOC_GROUPS is the nav; DOC_CONTENT[id] renders each
// page's body, given (P, goTo) — goTo lets a page link directly to
// another one, same as a real docs site's internal cross-links.
const DOC_GROUPS = [
  { label: "Welcome", pages: [
    { id: "overview", title: "Overview" },
    { id: "quickstart", title: "Quickstart" },
  ] },
  { label: "Bridge", pages: [
    { id: "bridge-overview", title: "Overview" },
    { id: "bridge-networks", title: "Supported networks" },
    { id: "bridge-protocols", title: "Supported protocols" },
    { id: "bridge-routing", title: "How routing works" },
    { id: "bridge-solana", title: "Solana support" },
    { id: "bridge-security", title: "Security model" },
    { id: "bridge-fees", title: "Fees" },
    { id: "bridge-assets", title: "Supported assets" },
  ] },
  { label: "Swap", pages: [
    { id: "swap-overview", title: "Overview" },
  ] },
  { label: "Launchpad", pages: [
    { id: "launchpad-overview", title: "Launching a token" },
    { id: "launchpad-hooks", title: "How Uniswap v4 hooks work" },
    { id: "launchpad-powered", title: "Powered by Uniswap v4" },
    { id: "launchpad-contracts", title: "Contracts" },
  ] },
  { label: "Wallet", pages: [
    { id: "wallet-overview", title: "Mango Wallet" },
    { id: "telegram-bot", title: "Telegram Bot" },
  ] },
  { label: "Trust & security", pages: [
    { id: "custody", title: "Custody" },
    { id: "privacy", title: "Privacy policy" },
  ] },
  { label: "Builders", pages: [
    { id: "api-sdk", title: "REST API" },
  ] },
  { label: "Roadmap", pages: [
    { id: "roadmap", title: "What's next" },
  ] },
];

function DocLink({ P, onClick, children }) {
  return (
    <button onClick={onClick} className="font-medium underline underline-offset-2" style={{ color: P.textPrimary }}>
      {children}
    </button>
  );
}

function DocCallout({ P, children }) {
  return (
    <div className="flex items-start gap-2 rounded-xl px-3.5 py-3 text-[12.5px] leading-relaxed" style={{ background: `${LIME}14`, border: `1px solid ${LIME}40`, color: P.textPrimary }}>
      <span className="shrink-0 mt-0.5" style={{ color: LIME_DEEP }}>●</span>
      <span>{children}</span>
    </div>
  );
}

function DocFactCard({ P, title, children }) {
  return (
    <div className="rounded-xl p-3.5" style={{ background: P.panel, border: `1px solid ${P.panelBorder}` }}>
      <div className="text-[12.5px] font-semibold mb-1" style={{ color: P.textPrimary }}>{title}</div>
      <div className="text-[11.5px] leading-relaxed" style={{ color: P.textSecondary }}>{children}</div>
    </div>
  );
}

const DOC_CONTENT = {
  overview: (P, goTo) => (
    <>
      <p className="mb-4">Mango Protocol is a permissionless infrastructure suite for moving assets across chains, swapping them, and launching new tokens. Anyone can bridge, anyone can swap, anyone can launch a token, anyone can trade — there's no gatekeeping, no approval process, no account to register. You connect a wallet and use it.</p>
      <div className="grid grid-cols-1 gap-2.5 mb-4">
        <DocFactCard P={P} title="Never in custody">Bridge transfers and swaps settle through the underlying protocol's own contracts — Circle's, Optimism's, Arbitrum's, Wormhole's, or Relay's. Mango's role is routing and fee collection, not holding funds. See <DocLink P={P} onClick={() => goTo("custody")}>Custody →</DocLink></DocFactCard>
        <DocFactCard P={P} title="Live routes, checked before you confirm">An unsupported chain/asset combination is never guessed at or faked as a success — the app checks for a real, live route first and tells you plainly if one doesn't exist.</DocFactCard>
        <DocFactCard P={P} title="One visible fee, always">A {formatFeePct(DEV_FEE_PCT)}% protocol fee applies to real transfers and swaps, shown before you confirm and never bundled invisibly into another transaction.</DocFactCard>
      </div>
      <p className="mb-1.5 font-medium" style={{ color: P.textPrimary }}>What's here</p>
      <ul className="list-disc ml-5 flex flex-col gap-1">
        <li><DocLink P={P} onClick={() => goTo("bridge-overview")}>Bridge</DocLink> — move an asset across chains, choosing the safest available protocol automatically.</li>
        <li><DocLink P={P} onClick={() => goTo("swap-overview")}>Swap</DocLink> — trade one asset for another on the same chain.</li>
        <li><DocLink P={P} onClick={() => goTo("launchpad-overview")}>Launchpad</DocLink> — launch a token directly into a live Uniswap v4 pool.</li>
        <li><DocLink P={P} onClick={() => goTo("wallet-overview")}>Mango Wallet</DocLink> — a self-custodial wallet built into the site (coming soon).</li>
      </ul>
    </>
  ),
  quickstart: (P) => (
    <>
      <p className="mb-3">Every action on Mango — a bridge, a swap, a launch — follows the same basic shape:</p>
      <ol className="list-decimal ml-5 flex flex-col gap-1 mb-3">
        <li>Connect a wallet</li>
        <li>Choose what you're moving/trading and where</li>
        <li>Mango determines the safest available route and checks it's actually live</li>
        <li>You sign — Mango never signs on your behalf</li>
        <li>The transaction executes and settles on-chain</li>
      </ol>
      <DocCallout P={P}>Estimated fees, ETA, and which protocol will handle a given transfer are always shown before you confirm — nothing executes silently.</DocCallout>
    </>
  ),
  "bridge-overview": (P, goTo) => (
    <>
      <p className="mb-2">Mango routes transfers across Ethereum, Base, BNB Chain, Robinhood Chain, Stable, Solana, Arbitrum One, Avalanche, Abstract, HyperEVM, Ink, Plasma, Unichain, and X Layer, automatically selecting the safest available path for a given pair:</p>
      <ul className="list-disc ml-5 mb-2 flex flex-col gap-0.5">
        <li><span className="font-medium" style={{ color: P.textPrimary }}>Circle CCTP</span> for native USDC between Ethereum and Base — no wrapped tokens, burn-and-mint via Circle's own attestation service</li>
        <li><span className="font-medium" style={{ color: P.textPrimary }}>OP Stack canonical bridge</span> for ETH between Ethereum and each of Base, Ink, and Unichain</li>
        <li><span className="font-medium" style={{ color: P.textPrimary }}>Arbitrum canonical bridge</span> for ETH and USDC between Ethereum and Robinhood Chain</li>
        <li><span className="font-medium" style={{ color: P.textPrimary }}>Wormhole</span> for ETH between Ethereum and BNB Chain, both directions</li>
        <li><span className="font-medium" style={{ color: P.textPrimary }}>Relay Protocol</span> for everything else with a verified contract on both sides — cross-asset swaps, any pair without a canonical bridge, and every Solana-involving route (both directions, with its own separate wallet requirement — see <DocLink P={P} onClick={() => goTo("bridge-solana")}>Solana support →</DocLink>)</li>
      </ul>
      <p>A {formatFeePct(DEV_FEE_PCT)}% protocol fee applies to real transfers, sent as its own visible transaction. The app checks for a live route before you're ever asked to confirm — an unsupported pair is never silently faked as a success.</p>
    </>
  ),
  "bridge-networks": (P, goTo) => (
    <>
      <ul className="list-disc ml-5 flex flex-col gap-0.5">
        <li>Ethereum</li>
        <li>Base</li>
        <li>BNB Chain</li>
        <li>Robinhood Chain</li>
        <li>Stable — Tether's own L1, native gas token USDT0</li>
        <li>Solana — genuinely different from every other chain here, not EVM-compatible. See <DocLink P={P} onClick={() => goTo("bridge-solana")}>Solana support →</DocLink> for what that actually means for you.</li>
        <li>Arbitrum One</li>
        <li>Avalanche</li>
        <li>Abstract</li>
        <li>HyperEVM</li>
        <li>Ink</li>
        <li>Plasma</li>
        <li>Unichain</li>
        <li>X Layer</li>
      </ul>
      <p className="mt-2">Each native asset (ETH, AVAX, HYPE, XPL, OKB) always routes through Relay. Beyond that: Ink and Unichain additionally have a real OP Stack canonical bridge for ETH, same protocol as Base (see <DocLink P={P} onClick={() => goTo("bridge-protocols")}>Supported protocols →</DocLink>); Avalanche, Arbitrum One, and Unichain additionally support USDC via Circle CCTP. Abstract, HyperEVM, X Layer, and Plasma have neither yet — Relay only.</p>
    </>
  ),
  "bridge-protocols": (P) => (
    <>
      <p className="font-semibold mb-1.5" style={{ color: P.textPrimary }}>Circle CCTP</p>
      <p className="mb-2">Circle Cross-Chain Transfer Protocol (CCTP) enables native USDC transfers between supported blockchains through a burn-and-mint mechanism.</p>
      <p className="font-medium mb-1" style={{ color: P.textPrimary }}>How it works</p>
      <ol className="list-decimal ml-5 mb-2 flex flex-col gap-0.5">
        <li>USDC is burned on the source chain.</li>
        <li>Circle's Attestation Service verifies the burn event.</li>
        <li>A signed attestation is generated.</li>
        <li>The destination contract mints an equivalent amount of native USDC.</li>
        <li>The recipient receives canonical USDC instead of wrapped tokens.</li>
      </ol>
      <p className="font-medium mb-1" style={{ color: P.textPrimary }}>Advantages</p>
      <ul className="list-disc ml-5 mb-2 flex flex-col gap-0.5">
        <li>Native USDC</li>
        <li>No wrapped assets</li>
        <li>Backed directly by Circle</li>
        <li>High security</li>
        <li>Fast settlement</li>
      </ul>
      <p className="mb-4"><span className="font-medium" style={{ color: P.textPrimary }}>Supported routes:</span> USDC between any two of Ethereum, Base, Avalanche, Arbitrum One, and Unichain. Domain IDs and contract addresses for the newest three were verified against Circle's own CREATE2-deployed CCTP V2 contracts (identical TokenMessenger/MessageTransmitter address on every chain) before being wired in — not guessed.</p>

      <p className="font-semibold mb-1.5" style={{ color: P.textPrimary }}>OP Stack canonical bridge — Base, Ink, Unichain</p>
      <p className="mb-2">Base, Ink, and Unichain are all OP Stack chains, so they share the exact same canonical bridge design (Base's official Coinbase-run bridge, Ink's own, and Unichain's own) for ETH between Ethereum and each of them. Each chain's bridge contract addresses were independently verified against Optimism's own superchain-registry before being wired in.</p>
      <p className="font-medium mb-1" style={{ color: P.textPrimary }}>Deposit flow</p>
      <p className="mb-2 font-mono text-[12px]">User → Ethereum Bridge Contract → L2 Sequencer → L2 Network</p>
      <p className="mb-2">Deposits typically finalize within minutes.</p>
      <p className="font-medium mb-1" style={{ color: P.textPrimary }}>Withdrawal flow</p>
      <p className="mb-2 font-mono text-[12px]">L2 → Withdrawal Proof → 7-Day Challenge Period → Ethereum Release</p>
      <p className="mb-4">The challenge period protects users against fraudulent state transitions. Where a faster route exists via Relay (below), Mango Bridge prefers it for this direction and reserves the canonical 7-day path as the fallback.</p>

      <p className="font-semibold mb-1.5" style={{ color: P.textPrimary }}>Arbitrum canonical bridge</p>
      <p className="mb-2">Mango Bridge integrates Arbitrum's canonical bridge for Orbit chains such as Robinhood Chain.</p>
      <p className="mb-2">Deposits settle quickly while withdrawals follow Arbitrum's optimistic security model.</p>
      <p className="font-medium mb-1" style={{ color: P.textPrimary }}>Characteristics</p>
      <ul className="list-disc ml-5 mb-4 flex flex-col gap-0.5">
        <li>Native ETH and USDC</li>
        <li>Optimistic Rollup</li>
        <li>Fraud-proof secured</li>
        <li>Seven-day withdrawal period (or faster via Relay, where available)</li>
      </ul>

      <p className="font-semibold mb-1.5" style={{ color: P.textPrimary }}>Wormhole</p>
      <p className="mb-2">Wormhole enables interoperability between independent blockchains using its Guardian Network. Supports both directions between Ethereum and BNB Chain.</p>
      <p className="font-medium mb-1" style={{ color: P.textPrimary }}>Transfer flow</p>
      <ol className="list-decimal ml-5 mb-2 flex flex-col gap-0.5">
        <li>Asset locked (or burned, on the return trip) on source chain</li>
        <li>Guardian Network observes transaction</li>
        <li>Guardians sign a VAA</li>
        <li>Destination chain verifies VAA</li>
        <li>Asset minted (or unlocked, on the return trip) on destination chain</li>
      </ol>
      <p className="mb-4"><span className="font-medium" style={{ color: P.textPrimary }}>Example:</span> Ethereum → BNB Chain — ETH becomes Wormhole-wrapped ETH. The reverse direction burns the wrapped ETH and unlocks the original.</p>

      <p className="font-semibold mb-1.5" style={{ color: P.textPrimary }}>Relay Protocol</p>
      <p className="mb-2">For chain/asset combinations with no canonical bridge — including direct transfers between Base and Robinhood Chain, cross-asset swaps like BNB for USDC, and every same-chain Swap trade — Mango routes through Relay's solver network.</p>
      <p className="font-medium mb-1" style={{ color: P.textPrimary }}>How it's different</p>
      <p className="mb-2">Relay is non-custodial, but it's a genuinely different trust model than the canonical bridges above: you're trusting Relay's solvers to fulfill the transfer, not an audited bridge contract with no operator discretion. Failed steps auto-refund rather than leaving funds stuck.</p>
      <p>Mango only routes a pair through Relay when it has an independently verified contract address for the asset on both sides — an unverified combination is never guessed at, and the app checks for a live route before you're ever asked to confirm anything.</p>
    </>
  ),
  "bridge-routing": (P) => (
    <>
      <p className="mb-2">The routing engine automatically determines the optimal bridge based on:</p>
      <ul className="list-disc ml-5 mb-2 flex flex-col gap-0.5">
        <li>Source blockchain</li>
        <li>Destination blockchain</li>
        <li>Asset type (same-asset transfer or cross-asset swap)</li>
        <li>Native bridge availability</li>
        <li>Security characteristics</li>
        <li>Estimated fees and speed</li>
      </ul>
      <p>Canonical bridges are always preferred where one exists and is reasonably fast. Everything else routes through Relay, with a live check for route availability before you confirm — if no route exists for a given pair, Mango tells you plainly rather than showing a fake success.</p>
    </>
  ),
  "bridge-solana": (P) => (
    <>
      <p className="mb-2">Solana isn't EVM-compatible — a genuinely different blockchain architecture from every other chain Mango Bridge supports, not just another entry in the same list. This has two real, concrete consequences worth knowing before you start:</p>
      <p className="font-medium mb-1" style={{ color: P.textPrimary }}>Two separate wallets, not one</p>
      <p className="mb-2">Any route touching Solana — as either source or destination — needs both an EVM wallet (Browser Wallet or WalletConnect) and a separate Solana wallet, connected via OKX Connect. The app shows a direct prompt for whichever one is still missing, right in the bridge form, once you've selected a Solana-involving pair.</p>
      <p className="font-medium mb-1" style={{ color: P.textPrimary }}>Different execution path entirely</p>
      <p>A Solana-sourced transfer is signed and submitted through Relay's own official SDK, using Solana's real transaction format — not the same signing mechanism used for every EVM-to-EVM route in this app. Solana-to-EVM and EVM-to-Solana are both supported.</p>
    </>
  ),
  "bridge-security": (P) => (
    <>
      <p className="mb-2">Mango Bridge prioritizes canonical bridges whenever available.</p>
      <div className="rounded-lg overflow-hidden mb-2" style={{ border: `1px solid ${P.panelBorder}` }}>
        <table className="w-full text-[12.5px]">
          <thead>
            <tr style={{ background: P.panel }}>
              <th className="text-left px-3 py-2 font-medium" style={{ color: P.textPrimary }}>Protocol</th>
              <th className="text-left px-3 py-2 font-medium" style={{ color: P.textPrimary }}>Security</th>
            </tr>
          </thead>
          <tbody>
            {[["Circle CCTP", "Circle Attestation"], ["OP Stack Bridge (Base, Ink, Unichain)", "Ethereum + Fraud Proofs"], ["Arbitrum Bridge", "Ethereum + Fraud Proofs"], ["Wormhole", "Guardian Network"], ["Relay Protocol", "Solver Network"]].map((row) => (
              <tr key={row[0]} style={{ borderTop: `1px solid ${P.panelBorder}` }}>
                <td className="px-3 py-2">{row[0]}</td>
                <td className="px-3 py-2">{row[1]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>This approach minimizes wrapped assets while maximizing interoperability. The app discloses which security model applies to a given route before you confirm a transfer.</p>
    </>
  ),
  "bridge-fees": (P) => (
    <>
      <p className="mb-2">Users may incur:</p>
      <ul className="list-disc ml-5 mb-2 flex flex-col gap-0.5">
        <li>Source chain gas fee</li>
        <li>Destination chain gas fee (where applicable)</li>
        <li>A {formatFeePct(DEV_FEE_PCT)}% Mango protocol fee, sent as its own separate, visible on-chain transaction — never bundled invisibly into another transfer</li>
        <li>Relay solver fee, where the route uses Relay</li>
      </ul>
      <p>Mango displays all estimated fees before confirmation.</p>
    </>
  ),
  "bridge-assets": (P) => (
    <>
      <p className="mb-2">Which specific assets work on which chain pair depends on the route — the app always shows this before you confirm.</p>
      <ul className="list-disc ml-5 flex flex-col gap-0.5">
        <li>ETH</li>
        <li>USDC</li>
        <li>USDT</li>
        <li>WBTC</li>
        <li>BNB</li>
        <li>USDG — Global Dollar, Robinhood Chain's native stablecoin</li>
        <li>USDT0 — Stable's native gas token</li>
        <li>SOL — Solana's native asset</li>
        <li>AVAX — Avalanche's native asset</li>
        <li>HYPE — HyperEVM's native asset</li>
        <li>XPL — Plasma's native asset</li>
        <li>OKB — X Layer's native asset</li>
      </ul>
    </>
  ),
  "swap-overview": (P, goTo) => (
    <>
      <p className="mb-3">Swap trades one asset for another on a single chain — pick a chain, pick what you're paying with and what you want back, and Mango finds the route. No separate destination chain, no "send to another address" step: a swap always lands back in the connected wallet that made it.</p>
      <p className="mb-3">Under the hood this is the exact same Relay solver network the Bridge tab uses for anything without a canonical bridge (see <DocLink P={P} onClick={() => goTo("bridge-protocols")}>Relay Protocol →</DocLink>) — just with the origin and destination chain set to the same chain. A live route check runs before you're ever asked to confirm, the same way it does for a cross-chain transfer.</p>
      <ul className="list-disc ml-5 mb-3 flex flex-col gap-0.5">
        <li>Available on any chain Mango Bridge supports (see <DocLink P={P} onClick={() => goTo("bridge-networks")}>Supported networks →</DocLink>), and any two of that chain's supported assets that Relay currently has a live route between.</li>
        <li>The same {formatFeePct(DEV_FEE_PCT)}% protocol fee as Bridge applies, deducted from what you receive — not carved out of what you pay in.</li>
        <li>Gas is estimated once, not twice — a same-chain swap is a single transaction, not a source leg and a destination leg.</li>
        <li>Not on the built-in list? Paste a contract address (or, on Solana, a mint address) directly into the asset picker to add and trade any token, verified live on-chain before it's offered.</li>
      </ul>
      <DocCallout P={P}>An unsupported pair on a given chain surfaces as an explicit "no route available" message — never a fabricated success.</DocCallout>
    </>
  ),
  "launchpad-overview": (P) => (
    <>
      <p className="mb-2">Every token launches directly into a live Uniswap v4 pool, trading on real, audited Uniswap infrastructure from the first buy. Prices move on genuine market activity from block one.</p>
      <p className="font-semibold mb-1.5" style={{ color: P.textPrimary }}>Launching a token</p>
      <ol className="list-decimal ml-5 mb-2 flex flex-col gap-0.5">
        <li>Connect your wallet</li>
        <li>Set a name, ticker, and description</li>
        <li>Upload artwork (stored on public IPFS)</li>
        <li>Optionally link an X profile and Telegram</li>
        <li>Optionally make a developer buy — purchasing some of your own supply at launch</li>
        <li>Confirm — your token is live in a real trading pool immediately</li>
      </ol>
      <p className="mb-2"><span className="font-medium" style={{ color: P.textPrimary }}>Trading fees:</span> 1% per trade, split 70% to the token's creator and 30% to the Mango Protocol treasury — paid automatically inside the same transaction as the trade. Nothing to claim, ever.</p>
      <p><span className="font-medium" style={{ color: P.textPrimary }}>Creator tools:</span> the Profile page tracks your launches, holdings, unrealized PnL, and total creator fees earned over time, all in one place.</p>
    </>
  ),
  "launchpad-hooks": (P) => (
    <>
      <p className="mb-2">Every version of Uniswap before v4 deployed a separate contract per trading pair. V4 replaced that with a <span className="font-medium" style={{ color: P.textPrimary }}>singleton</span> — one contract, PoolManager, holding every pool's state internally. Creating a pool isn't a deployment anymore; it's a cheap state update in a contract that already exists.</p>
      <p className="mb-2">A <span className="font-medium" style={{ color: P.textPrimary }}>hook</span> is a separate contract attached to a specific pool, which PoolManager calls automatically at defined moments — before or after a swap, before or after liquidity changes, and so on. This is where custom logic lives. Mango's hook uses exactly two of these: <span className="font-mono text-[12px]">afterInitialize</span> (registers the token's creator when the pool is created) and <span className="font-mono text-[12px]">afterSwap</span> (splits and pays out the trading fee).</p>
      <p className="mb-2">The distinctive part: a hook's permissions are encoded directly into its own contract address. Developers use CREATE2 with a specifically-mined salt to produce an address whose lowest bits spell out exactly which hook functions it's allowed to use. PoolManager reads those bits straight off the address — no permissions can be added after deployment, and a hook can never claim capabilities it wasn't deployed with. Mango's hook address is mined to expose only those two functions, nothing else.</p>
      <p>This is also why fees never need claiming: v4's "flash accounting" tracks running balance changes within a single transaction and only settles the net result at the very end. That's the exact mechanism the hook uses to split a trade's fee and send both shares to their destination wallets — inside the swap itself, not as a separate step afterward.</p>
    </>
  ),
  "launchpad-powered": (P) => (
    <>
      <p className="mb-2">Every token launched on Mango deploys onto a real Uniswap v4 hook — the same permission-mined, singleton-native architecture live on Robinhood Chain since day one. No custom AMM, no forked contracts, no bolted-on middleware — just Uniswap's actual PoolManager, doing what it was built to do.</p>
      <p>That's what makes the 70/30 fee split real instead of a promise: the hook redirects each trade's fee split inside the same transaction as the swap itself, the moment it settles. One click to launch, and the token is trading against genuine, audited, first-party Uniswap infrastructure — not a clone, not a wrapper, the real thing.</p>
    </>
  ),
  "launchpad-contracts": (P) => (
    <>
      <p className="mb-2">Deployed and verified on Robinhood Chain mainnet — tap any to view on the block explorer.</p>
      <p className="font-medium mb-1.5" style={{ color: P.textPrimary }}>Current (live now)</p>
      <div className="flex flex-col gap-2 mb-4">
        <a href="https://robinhoodchain.blockscout.com/address/0x8aD6607EbBAd5F4A088EDC25e98B3B454F9E912A" target="_blank" rel="noopener noreferrer" className="rounded-lg p-3" style={{ background: P.panel, border: `1px solid ${P.panelBorder}` }}>
          <div className="text-[12px] font-medium mb-0.5" style={{ color: P.textPrimary }}>MangoLaunchFactory</div>
          <div className="text-[11px] font-mono break-all" style={{ color: P.textSecondary }}>0x8aD6607EbBAd5F4A088EDC25e98B3B454F9E912A</div>
        </a>
        <a href="https://robinhoodchain.blockscout.com/address/0x6df44617b8C13AB961dCe5097F9375AE6BE09044" target="_blank" rel="noopener noreferrer" className="rounded-lg p-3" style={{ background: P.panel, border: `1px solid ${P.panelBorder}` }}>
          <div className="text-[12px] font-medium mb-0.5" style={{ color: P.textPrimary }}>MangoLaunchHook (v4)</div>
          <div className="text-[11px] font-mono break-all" style={{ color: P.textSecondary }}>0x6df44617b8C13AB961dCe5097F9375AE6BE09044</div>
        </a>
        <a href="https://robinhoodchain.blockscout.com/address/0xb4D9c0928d0bf15ACa8D698cb83703752CfdF785" target="_blank" rel="noopener noreferrer" className="rounded-lg p-3" style={{ background: P.panel, border: `1px solid ${P.panelBorder}` }}>
          <div className="text-[12px] font-medium mb-0.5" style={{ color: P.textPrimary }}>MangoLaunchRegistry (v3)</div>
          <div className="text-[11px] font-mono break-all" style={{ color: P.textSecondary }}>0xb4D9c0928d0bf15ACa8D698cb83703752CfdF785</div>
        </a>
        <a href="https://robinhoodchain.blockscout.com/address/0xb347EEad23D4FC41338845E35Ee8Fc42D9789d70" target="_blank" rel="noopener noreferrer" className="rounded-lg p-3" style={{ background: P.panel, border: `1px solid ${P.panelBorder}` }}>
          <div className="text-[12px] font-medium mb-0.5" style={{ color: P.textPrimary }}>MangoLaunchRouter (v4)</div>
          <div className="text-[11px] font-mono break-all" style={{ color: P.textSecondary }}>0xb347EEad23D4FC41338845E35Ee8Fc42D9789d70</div>
        </a>
      </div>

      <p className="font-medium mb-1.5" style={{ color: P.textPrimary }}>Version history</p>
      <div className="flex flex-col gap-2 text-[11px]" style={{ color: P.textSecondary }}>
        <div>
          <span className="font-medium" style={{ color: P.textPrimary }}>Hook v1 → v2:</span> redesigned the fee structure — flat 3% became 1% buy, 4% sell pre-graduation (real anti-dump protection), 1% both ways after.
        </div>
        <div>
          <span className="font-medium" style={{ color: P.textPrimary }}>Hook/Registry v2 → v3:</span> added a permanent, separate admin role. The old design let only the current operator reassign itself — once that became a contract with no forwarding function, it got permanently stuck. Confirmed on real mainnet, not caught in testing.
        </div>
        <div>
          <span className="font-medium" style={{ color: P.textPrimary }}>Hook v3 → v4:</span> fixed a missing permission bit. The hook computed trading fees correctly but was never granted permission to actually apply them — every real trade reverted until this was found and fixed.
        </div>
        <div>
          <span className="font-medium" style={{ color: P.textPrimary }}>Factory v1 → v2:</span> fixed an over-settlement bug — the original transferred a token's full supply to seed liquidity, when tick-rounding meant slightly less was actually owed, leaving an unclaimed credit that reverted every launch.
        </div>
        <div>
          <span className="font-medium" style={{ color: P.textPrimary }}>Router v1 → v2 → v3:</span> updated to point at each new Hook version in turn.
        </div>
        <div>
          <span className="font-medium" style={{ color: P.textPrimary }}>Router v3 → v4:</span> fixed a settlement ordering bug in the sell path — buys worked correctly before this fix, sells didn't.
        </div>
      </div>
    </>
  ),
  "wallet-overview": (P) => (
    <>
      <p className="mb-2">Mango Wallet is a real, self-custodial browser extension — your recovery phrase is generated and encrypted entirely on your own device, and is never sent to Mango in any form, encrypted or not. One recovery phrase covers a single address usable across every EVM chain Mango supports, plus a separate Solana address, the same way MetaMask and Phantom derive theirs.</p>
      <p className="mb-3">
        <a href="https://chromewebstore.google.com/detail/nphpjgifdodfhachompmknpdjnhomkcc" target="_blank" rel="noopener noreferrer" className="font-medium underline underline-offset-2" style={{ color: P.textPrimary }}>Install Mango Wallet from the Chrome Web Store →</a>
      </p>
      <p>The site itself doesn't run a second, separate wallet — only an installed extension can actually connect to other sites and dApps, so the site's own Wallet tab points you to install or open the extension rather than duplicating it.</p>
    </>
  ),
  "telegram-bot": (P) => (
    <>
      <p className="mb-2">Mango is also available as a Telegram bot — trade and manage a wallet directly inside a chat, no separate app or extension install needed.</p>
      <p className="mb-2">A Telegram bot can't sign transactions locally the way a browser extension can, so its wallet is custodial — a different trust model from Mango Wallet, described on the previous page.</p>
      <p>
        <a href="https://t.me/mango_protocol" target="_blank" rel="noopener noreferrer" className="font-medium underline underline-offset-2" style={{ color: P.textPrimary }}>Find it on Telegram →</a>
      </p>
    </>
  ),
  custody: (P) => (
    <p>Mango never takes custody of user funds at any point, across Bridge, Swap, or the Launchpad. Bridge and Swap transfers move directly through the underlying protocol's own contracts — Circle's, Optimism's, Arbitrum's, Wormhole's, or Relay's. Launchpad trades settle through Uniswap's own PoolManager. Your wallet signs every transaction directly with that infrastructure; Mango's role is routing and fee collection, not holding.</p>
  ),
  privacy: (P) => (
    <>
      <p className="mb-3">Mango is self-custodial everywhere — the site, the Android app, and the browser extension all generate and encrypt your recovery phrase and private keys locally, and none of them ever send that data to Mango. Each product publishes its own full privacy policy, since exactly what gets talked to (RPC endpoints, Relay's API, Mango's own backend for optional features like Referral) differs slightly by product.</p>
      <div className="flex flex-col gap-2 mb-3">
        <a href="/app-privacy.html" target="_blank" rel="noopener noreferrer" className="font-medium underline underline-offset-2" style={{ color: P.textPrimary }}>Android app privacy policy →</a>
        <a href="/wallet-privacy.html" target="_blank" rel="noopener noreferrer" className="font-medium underline underline-offset-2" style={{ color: P.textPrimary }}>Browser extension privacy policy →</a>
      </div>
      <DocCallout P={P}>The website itself (Bridge, Swap, Launchpad) works the same way: it talks directly to public RPC endpoints and Relay's API from your own browser, and never has access to your keys. A dedicated website policy page is on the roadmap — until then, the principles on this page and the two linked above apply equally to it.</DocCallout>
      <p className="mt-3">Questions about any of these can be sent to <a href="mailto:mango@mangoprotocol.site" className="font-medium underline underline-offset-2" style={{ color: P.textPrimary }}>mango@mangoprotocol.site</a>.</p>
    </>
  ),
  "api-sdk": (P) => (
    <>
      <p className="mb-2">A real, public REST API — every endpoint returns live, on-chain data, nothing mocked.</p>
      <p className="font-medium mb-1" style={{ color: P.textPrimary }}>Base URL</p>
      <p className="mb-2 font-mono text-[12px]">https://mangoprotocol.site/api/v1</p>
      <p className="font-medium mb-1" style={{ color: P.textPrimary }}>Endpoints</p>
      <ul className="list-disc ml-5 mb-2 flex flex-col gap-0.5 font-mono text-[12px]">
        <li>GET /launchpad/tokens</li>
        <li>GET /launchpad/token?address=0x...</li>
        <li>GET /launchpad/quote?tokenAddress=0x...&side=buy</li>
        <li>GET /launchpad/launch?name=...&symbol=...&creator=0x...</li>
        <li>GET /bridge/chains</li>
        <li>GET /bridge/quote?from=...&to=...&fromAsset=...&toAsset=...&amount=...&userAddress=0x...</li>
      </ul>
      <p className="mb-2">Same non-custodial principle as everything else here: this API never signs or submits a transaction on your behalf. Endpoints that involve a real transaction (launching, bridging) return unsigned transaction data — your own wallet does the actual signing.</p>
      <p className="text-[11.5px]" style={{ color: P.textMuted }}>All six endpoints above have been directly tested against the live API and confirmed returning real data — not just built and assumed working.</p>
    </>
  ),
  roadmap: (P) => (
    <ul className="list-disc ml-5 flex flex-col gap-0.5">
      <li>Additional EVM networks</li>
      <li>Cross-chain messaging</li>
      <li>Bridge analytics dashboard</li>
    </ul>
  ),
};

function DocsModal({ onClose, P }) {
  const [activePage, setActivePage] = useState("overview");
  const [query, setQuery] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const contentRef = useRef(null);

  const filteredGroups = query.trim()
    ? DOC_GROUPS.map((g) => ({
        ...g,
        pages: g.pages.filter((p) => `${g.label} ${p.title}`.toLowerCase().includes(query.trim().toLowerCase())),
      })).filter((g) => g.pages.length > 0)
    : DOC_GROUPS;

  const activeGroup = DOC_GROUPS.find((g) => g.pages.some((p) => p.id === activePage));
  const activePageMeta = activeGroup?.pages.find((p) => p.id === activePage);
  const renderPage = DOC_CONTENT[activePage];

  function goTo(id) {
    setActivePage(id);
    setSidebarOpen(false);
    contentRef.current?.scrollTo({ top: 0 });
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col" style={{ background: P.bg }}>
      <div className="flex items-center justify-between px-4 h-14 shrink-0" style={{ borderBottom: `1px solid ${P.panelBorder}` }}>
        <div className="flex items-center gap-2.5">
          <button onClick={() => setSidebarOpen((v) => !v)} className="md:hidden" aria-label="Toggle navigation">
            <Menu size={18} color={P.textSecondary} />
          </button>
          <MangoLogo size={20} color={P.textPrimary} />
          <span className="font-display text-[15px] font-semibold" style={{ color: P.textPrimary }}>Docs</span>
        </div>
        <button onClick={onClose} aria-label="Close docs"><X size={18} color={P.textMuted} /></button>
      </div>

      <div className="flex flex-1 min-h-0 relative">
        {sidebarOpen && (
          <div className="md:hidden fixed inset-0 top-14 z-10" style={{ background: "rgba(4,5,7,0.6)" }} onClick={() => setSidebarOpen(false)} />
        )}
        <div
          className={`${sidebarOpen ? "flex" : "hidden"} md:flex flex-col w-72 shrink-0 overflow-y-auto fixed md:static top-14 bottom-0 left-0 z-20`}
          style={{ background: P.panel, borderRight: `1px solid ${P.panelBorder}` }}
        >
          <div className="p-3">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search docs…"
              className="w-full px-3 py-2 rounded-lg text-[12.5px]"
              style={{ background: P.input, border: `1px solid ${P.panelBorder}`, color: P.textPrimary }}
            />
          </div>
          <nav className="px-3 pb-6 flex flex-col gap-4">
            {filteredGroups.map((group) => (
              <div key={group.label}>
                <div className="text-[11px] font-semibold uppercase tracking-wide mb-1 px-2" style={{ color: P.textMuted }}>{group.label}</div>
                <div className="flex flex-col gap-0.5">
                  {group.pages.map((page) => {
                    const active = activePage === page.id;
                    return (
                      <button
                        key={page.id}
                        onClick={() => goTo(page.id)}
                        className="text-left px-2.5 py-1.5 rounded-lg text-[13px]"
                        style={{ background: active ? P.pillBg : "transparent", color: active ? P.textPrimary : P.textSecondary, fontWeight: active ? 600 : 400 }}
                      >
                        {page.title}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
            {filteredGroups.length === 0 && <div className="text-[12px] px-2" style={{ color: P.textMuted }}>No matching pages.</div>}
          </nav>
        </div>

        <div ref={contentRef} className="flex-1 overflow-y-auto">
          <div className="max-w-2xl mx-auto px-5 md:px-8 py-8">
            <div className="text-[11.5px] font-medium mb-2" style={{ color: P.textMuted }}>{activeGroup?.label}</div>
            <h1 className="font-display text-[24px] md:text-[28px] font-semibold mb-5" style={{ color: P.textPrimary }}>{activePageMeta?.title}</h1>
            <div className="text-[13.5px] leading-relaxed flex flex-col" style={{ color: P.textSecondary }}>
              {renderPage ? renderPage(P, goTo) : null}
            </div>

            {activePage === "overview" && (
              <div className="flex flex-col gap-2 mt-8">
                <div className="flex items-center gap-2">
                  <a
                    href="https://x.com/Mango_protocol"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-center gap-2 flex-1 py-3 rounded-xl text-[13px] font-medium"
                    style={{ background: P.panel, border: `1px solid ${P.panelBorder}`, color: P.textPrimary }}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                      <path d="M18.9 2H22l-7.6 8.7L23.3 22h-6.8l-5.3-6.9L5 22H1.9l8.1-9.3L1 2h7l4.8 6.3L18.9 2Zm-1.2 18h1.9L7.4 4H5.4l12.3 16Z" fill={P.textPrimary} />
                    </svg>
                    Follow on X
                  </a>
                  <a
                    href="https://t.me/mango_protocol"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-center gap-2 flex-1 py-3 rounded-xl text-[13px] font-medium"
                    style={{ background: P.panel, border: `1px solid ${P.panelBorder}`, color: P.textPrimary }}
                  >
                    <Send size={14} /> Join our Telegram
                  </a>
                </div>
                <a
                  href="mailto:mango@mangoprotocol.site"
                  className="flex items-center justify-center gap-2 w-full py-3 rounded-xl text-[13px] font-medium"
                  style={{ background: P.panel, border: `1px solid ${P.panelBorder}`, color: P.textPrimary }}
                >
                  <Mail size={14} /> mango@mangoprotocol.site
                </a>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// Real, plain-language risk disclosure and terms — not a substitute for
// actual legal review, and says so explicitly below. Added because the
// app had none at all: no ToS, no risk disclosure, nothing linking to one
// anywhere in the UI, despite handling real user funds across five
// different bridge trust models and an unaudited launchpad.
export default function MangoBridge() {
  const [theme, setTheme] = useState("light");
  const [from, setFrom] = useState("base");
  const [to, setTo] = useState("ethereum");

  // Which of walletChains.js's 25 wallet-only chains Relay's live GET
  // /chains response currently reports as usable — fetched once per app
  // mount (relayChains.js caches it anyway), split into origin (disabled
  // !== true) and destination (also depositEnabled !== false — Relay's
  // own field for "can this chain be a destination") eligibility, since a
  // chain can support one direction without the other. Same pattern
  // mango-mobile's own BridgeScreen.tsx already uses. Any fetch failure
  // (network down, this sandbox blocking relay.link, etc) just means
  // these stay empty and the Bridge tab behaves exactly as it did before
  // this feature — the original 14 hand-verified chains only.
  const [liveBridgeOrigins, setLiveBridgeOrigins] = useState(() => new Set());
  const [liveBridgeDestinations, setLiveBridgeDestinations] = useState(() => new Set());
  useEffect(() => {
    let cancelled = false;
    fetchRelayChains()
      .then((chains) => {
        if (cancelled) return;
        const origins = new Set();
        const destinations = new Set();
        for (const chain of chains) {
          const key = WALLET_ONLY_CHAIN_ID_TO_KEY[chain?.id];
          if (!key || chain.disabled === true) continue;
          origins.add(key);
          if (chain.depositEnabled !== false) destinations.add(key);
        }
        setLiveBridgeOrigins(origins);
        setLiveBridgeDestinations(destinations);
      })
      // Fails closed to the base 14-chain list (see comment above) —
      // but no longer silently: logged so a real failure (network,
      // CORS, an API shape change) is visible in devtools instead of
      // just looking like "the wallet-only chains never showed up,"
      // with nothing to go on to tell those two cases apart.
      .catch((err) => console.error("[relayChains] live chain-support fetch failed — falling back to the base chain list:", err));
    return () => { cancelled = true; };
  }, []);
  const bridgeFromChainOrder = useMemo(
    () => [...CHAIN_ORDER, ...WALLET_ONLY_CHAIN_ORDER.filter((key) => liveBridgeOrigins.has(key))],
    [liveBridgeOrigins]
  );
  const bridgeToChainOrder = useMemo(
    () => [...CHAIN_ORDER, ...WALLET_ONLY_CHAIN_ORDER.filter((key) => liveBridgeDestinations.has(key))],
    [liveBridgeDestinations]
  );
  // Swap tab's single chain picker — a same-chain swap needs a chain
  // Relay supports as BOTH an origin and a destination (unlike Bridge,
  // where the two directions can differ), so this is the intersection
  // of the two lists above rather than either one alone.
  const swapChainOrder = useMemo(
    () => bridgeFromChainOrder.filter((key) => bridgeToChainOrder.includes(key)),
    [bridgeFromChainOrder, bridgeToChainOrder]
  );

  const [amount, setAmount] = useState("");
  const [fromAssetIdx, setFromAssetIdxRaw] = useState(0);
  const [toAssetIdx, setToAssetIdxRaw] = useState(0);
  // A user-pasted "paste a contract address" token (AssetDropdown,
  // customTokens.js) — null when the built-in ASSETS list (indexed by
  // fromAssetIdx/toAssetIdx above) is what's actually selected instead.
  // {symbol, decimals: <display>, address, onchainDecimals, custom:true}.
  const [fromCustomToken, setFromCustomTokenRaw] = useState(null);
  const [toCustomToken, setToCustomTokenRaw] = useState(null);
  // Picking a chain-exclusive native (POL, SOL, AVAX, etc. — see
  // CHAIN_FOR_EXCLUSIVE_NATIVE_SYMBOL's own comment) switches that side
  // to the symbol's own chain, same pattern the ChainDropdown's own
  // handleFromChange/handleToChange already use when from/to would
  // otherwise collide. On Swap, both sides move together (a same-chain
  // swap can't have from !== to) — same as handleSwapChainChange.
  function handleFromAssetChange(idx) {
    const targetChain = CHAIN_FOR_EXCLUSIVE_NATIVE_SYMBOL[ASSETS[idx]?.symbol];
    if (targetChain) {
      if (isSwapTab) {
        setFrom(targetChain);
        setTo(targetChain);
      } else if (targetChain !== from) {
        setFrom(targetChain);
        if (targetChain === to) setTo(CHAIN_ORDER.find((c) => c !== targetChain));
      }
    }
    setFromAssetIdxRaw(idx);
    setFromCustomTokenRaw(null);
    setAmount("");
  }
  function handleToAssetChange(idx) {
    const targetChain = CHAIN_FOR_EXCLUSIVE_NATIVE_SYMBOL[ASSETS[idx]?.symbol];
    if (targetChain) {
      if (isSwapTab) {
        setFrom(targetChain);
        setTo(targetChain);
      } else if (targetChain !== to) {
        setTo(targetChain);
        if (targetChain === from) setFrom(CHAIN_ORDER.find((c) => c !== targetChain));
      }
    }
    setToAssetIdxRaw(idx);
    setToCustomTokenRaw(null);
  } // don't clear amount — user is choosing what to receive, not resetting input
  function handleFromCustomTokenSelect(token) { setFromCustomTokenRaw(token); setAmount(""); }
  function handleToCustomTokenSelect(token) { setToCustomTokenRaw(token); }
  // Real deep-link support for a shared token page: ?token=0x... on load
  // opens straight to Launchpad -> that token's detail view, instead of a
  // Share button copying a link that silently drops you on the homepage.
  // Read once at mount — a URL typed/opened fresh, not synced live as you
  // navigate elsewhere in the app.
  const [deepLinkTokenAddress] = useState(() => new URLSearchParams(window.location.search).get("token"));
  // Same idea as the ?token= deep link above, generalized to any bottom-nav
  // tab: ?tab=wallet on load opens straight to the Wallet tab (e.g. for a
  // "get the app" link that shouldn't dump someone on the Bridge homepage
  // first). ?token= still wins when both are present — a shared token page
  // link is a stronger, more specific intent than a generic tab link.
  // "app" is accepted as a friendlier public-facing alias for "wallet" —
  // the internal tab id stays "wallet" everywhere else in this file, this
  // is just what an external link is allowed to spell it as.
  const [tab, setTab] = useState(() => {
    if (deepLinkTokenAddress) return "launchpad";
    const requestedTab = new URLSearchParams(window.location.search).get("tab");
    if (requestedTab === "app") return "wallet";
    const validTabs = ["bridge", "swap", "launchpad", "wallet", "history", "portfolio"];
    return validTabs.includes(requestedTab) ? requestedTab : "bridge";
  });
  // Which network's launchpad is showing — Robinhood Chain (real, working)
  // or Solana (coming soon). Selected via the same shared
  // NetworkSelectorModal the rest of the app already uses, not a second
  // picker living inside Launchpad.jsx.
  const [launchpadNetwork, setLaunchpadNetwork] = useState("robinhood");
  const [historySubTab, setHistorySubTab] = useState("transfers");
  const [balances, setBalances] = useState(DEFAULT_BALANCES);
  const [history, setHistory] = useState([]);
  const [withdrawals, setWithdrawals] = useState([]);
  const [showModal, setShowModal] = useState(false);
  // ?docs=1 on load opens the Docs modal straight away — same deep-link
  // idea as ?tab= above, for a link that should land someone directly on
  // the documentation rather than the Bridge homepage first.
  const [showDocs, setShowDocs] = useState(() => new URLSearchParams(window.location.search).get("docs") === "1");
  // ?admin-referrals=1 opens AdminReferralsPage.jsx — same deep-link
  // pattern as ?docs= above. Not linked anywhere in this app's own nav;
  // the real gate is the ADMIN_API_SECRET that page itself asks for
  // (see its own header), not this URL's obscurity.
  const [showAdminReferrals, setShowAdminReferrals] = useState(
    () => new URLSearchParams(window.location.search).get("admin-referrals") === "1",
  );
  const [showNetworkSelector, setShowNetworkSelector] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [sendToOther, setSendToOther] = useState(false);
  const [destAddress, setDestAddress] = useState("");

  const { address, isConnected, chainId: connectedChainId } = useAccount();
  const { connect, connectors, isPending: isConnecting, error: connectError } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();
  const solanaWallet = useSolanaWallet();
  const { open: openAppKit } = useAppKit();
  const appKitSolana = useAppKitAccount({ namespace: "solana" });
  const { walletProvider: appKitSolanaProvider } = useAppKitProvider("solana");
  const { disconnect: disconnectAppKit } = useAppKitDisconnect();
  const [showWalletSelector, setShowWalletSelector] = useState(false);

  // Real, unified concept: which wallet is actually relevant depends on
  // which chain is selected as the SOURCE (the one being signed FROM).
  // Genuinely necessary now that two completely separate wallet systems
  // exist side by side — this is the one place that decides which one
  // matters for the current selection, so downstream code doesn't have
  // to keep re-deciding it.
  //
  // Solana itself now has two possible connections layered on top of
  // each other — OKX (its own, separate path) and everything else,
  // connected through AppKit's SolanaAdapter. activeSolanaAddress is
  // whichever one is actually connected; OKX wins if somehow both are
  // (shouldn't normally happen, since connecting one doesn't disconnect
  // the other, but OKX is the one with a real, proven execution path).
  const isFromSolana = CHAINS[from]?.isSolana;
  const activeSolanaAddress = solanaWallet.address || appKitSolana.address;
  const activeAccount = isFromSolana ? activeSolanaAddress : address;
  const connected = isFromSolana ? !!activeSolanaAddress : isConnected;
  // Symmetric requirement: Solana involved on EITHER side needs its own
  // real connection before a valid recipient can even be determined —
  // not just when it's the source. Moved up here (from further down,
  // where canBridge/the CTA already used these) so the route-check
  // effect below can reuse the exact same, already-correct condition —
  // see that effect's own comment on the real bug this fixes.
  const needsEvmAddressForSolanaSource = isFromSolana && !CHAINS[to]?.isSolana && !sendToOther && !address;
  const needsSolanaAddressForSolanaDest = CHAINS[to]?.isSolana && !isFromSolana && !sendToOther && !activeSolanaAddress;

  // BridgeModal reads solanaWallet.solanaProvider.current for real
  // Solana-sourced execution (see relaySdkSolanaExecution.js). When OKX
  // is the one actually connected, pass it through unchanged — that's
  // the one proven path. Otherwise fall back to AppKit's own Solana
  // provider: its signTransaction(transaction) shape is structurally
  // compatible per @reown/appkit-utils/solana's installed types (same
  // single-transaction-argument signature the execution code already
  // calls), but this specific combination hasn't been exercised against
  // a real, funded transfer yet — flag this first if a non-OKX
  // Solana-sourced bridge is reported broken.
  const effectiveSolanaWallet = solanaWallet.address
    ? solanaWallet
    : { ...solanaWallet, solanaProvider: { current: appKitSolanaProvider } };

  // Real, live balances for every asset relevant to the current "from"
  // chain — not just the currently-selected one. Powers the balance
  // display directly inside the asset dropdown itself.
  const [fromChainBalances, setFromChainBalances] = useState({});
  const [balancesLoading, setBalancesLoading] = useState(false);

  // forceFresh bypasses multiAssetBalances.js's short-lived cache — used
  // right after a transaction completes, where a just-spent/just-received
  // balance must be genuinely re-read, not served from a few-seconds-old
  // cached value.
  const refreshFromChainBalances = useCallback(async (forceFresh = false) => {
    if (!connected) { setFromChainBalances({}); return; }
    setBalancesLoading(true);
    try {
      const real = isFromSolana
        ? await fetchSolanaBalance({ solanaAddress: activeSolanaAddress, forceFresh })
        : await fetchAllEvmBalances({ chainKey: from, nativeSymbol: NATIVE_SYMBOL_BY_CHAIN[from], address, forceFresh });
      setFromChainBalances(real);
    } finally {
      setBalancesLoading(false);
    }
  }, [connected, isFromSolana, from, address, activeSolanaAddress]);

  // Refreshes on wallet connect and network change — the third required
  // trigger (asset list opening) is wired directly into AssetDropdown's
  // own onClick below, since that's a real user action, not state this
  // effect can observe on its own.
  useEffect(() => {
    refreshFromChainBalances();
  }, [refreshFromChainBalances]);

  const fromWagmiChain = getWagmiChain(from);
  // Wrong-network detection is an EVM-wallet concept — doesn't apply when
  // the source chain is Solana, since that's a completely separate
  // connection (OKX Connect), not something wagmi/MetaMask tracks at all.
  const onWrongNetwork = connected && !CHAINS[from]?.isSolana && connectedChainId !== fromWagmiChain.id;

  const { data: liveBalance, isLoading: balanceLoading } = useBalance({
    address,
    chainId: fromWagmiChain.id,
    query: { enabled: connected && !CHAINS[from]?.isSolana },
  });

  // Real fix: fromAsset/toAsset now prefer a selected custom token over
  // the built-in ASSETS index, in the exact same object shape ASSETS
  // entries already have (symbol/name/decimals/price/color) plus
  // custom:true/address/onchainDecimals — so every existing consumer
  // below (fee math, balance display, CTA text, handleComplete, the
  // quote/execution calls) keeps working unchanged; only currency/
  // decimals resolution for an actual on-chain request needs to check
  // .custom (resolveCurrencyForAsset/onchainDecimalsForAsset above).
  // decimals:4/price:0 are the same kind of rough, cosmetic-only
  // defaults the rest of this file already uses for a real asset with
  // no hand-tuned display precision — never used for the actual
  // on-chain amount (that's onchainDecimals, read live off the
  // contract when the token was added).
  const fromAsset = fromCustomToken
    ? { symbol: fromCustomToken.symbol, name: fromCustomToken.symbol, decimals: 4, price: 0, color: "#8C9BAE", custom: true, address: fromCustomToken.address, onchainDecimals: fromCustomToken.decimals }
    : ASSETS[fromAssetIdx];
  const toAsset = toCustomToken
    ? { symbol: toCustomToken.symbol, name: toCustomToken.symbol, decimals: 4, price: 0, color: "#8C9BAE", custom: true, address: toCustomToken.address, onchainDecimals: toCustomToken.decimals }
    : ASSETS[toAssetIdx];
  // Real bug fix, directly requested ("we can't rely on symbol... no
  // token can ever match the same [address]"): matching by symbol alone
  // is exactly the fragile identity check the AssetDropdown fixes above
  // just finished hardening around. A custom Solana token's symbol is
  // fully user-supplied — the "no live listing found for this mint yet
  // — enter its symbol yourself" flow (AssetDropdown's own splSymbolInput)
  // puts ZERO restriction on what a user (or an attacker crafting a
  // token to trick one) types in, including literally "SOL" or "USDC".
  // Before this fix, that alone made isNativeAsset/isRealUsdcPair true
  // for a completely unrelated, unverified custom token — usingLiveBalance
  // below would then show and gate against the REAL native/USDC balance
  // as if it belonged to that fake token, a genuinely misleading trust
  // signal (a scam token labeled "SOL" would display the user's actual
  // SOL balance as its own). !fromAsset.custom/!toAsset.custom (set
  // above only for a pasted token, never for the curated ASSETS list)
  // restricts both checks to the one place a symbol is actually a safe,
  // collision-free identifier: the hand-verified built-in registry.
  const isNativeAsset = !fromAsset.custom && fromAsset.symbol === NATIVE_SYMBOL_BY_CHAIN[from];
  const isRealUsdcPair = !fromAsset.custom && !toAsset.custom && fromAsset.symbol === "USDC" && toAsset.symbol === "USDC" && isCctpSupportedPair(from, to);
  const usdcTokenAddress = isRealUsdcPair ? CCTP_CHAINS[from].usdc : undefined;
  // A custom EVM token (pasted address, added via AssetDropdown) never
  // had a live balance source at all before this fix — isNativeAsset/
  // isRealUsdcPair are both deliberately false for one (see their own
  // comments above), so usingLiveBalance used to be false too, meaning
  // no "Balance: X" label, a permanently disabled MAX button, and no
  // client-side insufficient-balance check for a token this wallet
  // genuinely holds. Reported live: bought Basecat on Base through this
  // exact flow, then couldn't see its balance or sell any of it back —
  // MAX stayed disabled and typing an amount larger than the real
  // balance sailed straight past this form's own validation into a
  // Relay "Final transaction simulation failed" error instead of a
  // clear "Insufficient balance" message. fetchWalletTokenBalance
  // already does this exact fetch correctly elsewhere (the wallet
  // dashboard's own TokenBalanceRow, mobile's DexScreen.tsx) — the
  // fix here is the same real balanceOf read, just reusing the same
  // useBalance(token: ...) shape the USDC case right above already
  // established, pointed at whatever custom token is actually selected.
  const isCustomFromToken = !!fromAsset.custom && !CHAINS[from]?.isSolana;
  const { data: liveCustomBalance, isLoading: customBalanceLoading } = useBalance({
    address,
    token: isCustomFromToken ? fromAsset.address : undefined,
    chainId: fromWagmiChain.id,
    query: { enabled: connected && isCustomFromToken },
  });

  const { data: liveUsdcBalance, isLoading: usdcBalanceLoading } = useBalance({
    address,
    token: usdcTokenAddress,
    chainId: fromWagmiChain.id,
    query: { enabled: connected && isRealUsdcPair && !CHAINS[from]?.isSolana },
  });

  // Real bug fix: Solana was excluded from the live-balance display
  // entirely — useBalance above is a wagmi/EVM-only hook, so it could
  // never resolve for a Solana address, but that's not a reason to
  // show nothing. refreshFromChainBalances above already fetches a
  // real Solana balance (fetchSolanaBalance) into fromChainBalances —
  // the exact same data AssetDropdown's own per-asset balance list
  // already shows — this just reuses it for the "Balance: X" label too
  // instead of a second, EVM-only source that was always empty here.
  // (fromChainBalances only ever covers SOL itself, not an SPL token,
  // custom or built-in — a genuinely separate, larger gap on the
  // Solana side than this EVM fix; not the case reported here.)
  const usingLiveBalance = connected && (isNativeAsset || isRealUsdcPair || isCustomFromToken);
  const liveBalanceLoading = isFromSolana ? balancesLoading : (isNativeAsset ? balanceLoading : isCustomFromToken ? customBalanceLoading : usdcBalanceLoading);
  const liveBalanceValue = isFromSolana ? undefined : (isNativeAsset ? liveBalance : isCustomFromToken ? liveCustomBalance : liveUsdcBalance);

  const toWagmiChain = getWagmiChain(to);
  // Same real bug fix as isNativeAsset's own comment above — !toAsset.custom
  // keeps this restricted to the curated, symbol-collision-free ASSETS list.
  const isNativeAssetTo = !toAsset.custom && toAsset.symbol === NATIVE_SYMBOL_BY_CHAIN[to];
  const isRealUsdcPairTo = isRealUsdcPair;
  const usdcTokenAddressTo = isRealUsdcPairTo ? CCTP_CHAINS[to].usdc : undefined;
  // Same real fix as isCustomFromToken above, mirrored for the receive
  // side — informational only (no MAX button there), but "Balance: X"
  // for a custom token you already hold on the receiving side is just
  // as real a gap as the sending side was.
  const isCustomToToken = !!toAsset.custom && !CHAINS[to]?.isSolana;

  const { data: liveBalanceTo, isLoading: balanceLoadingTo } = useBalance({
    address,
    chainId: toWagmiChain.id,
    query: { enabled: connected && isNativeAssetTo && !CHAINS[to]?.isSolana },
  });
  const { data: liveUsdcBalanceTo, isLoading: usdcBalanceLoadingTo } = useBalance({
    address,
    token: usdcTokenAddressTo,
    chainId: toWagmiChain.id,
    query: { enabled: connected && isRealUsdcPairTo && !CHAINS[to]?.isSolana },
  });
  const { data: liveCustomBalanceTo, isLoading: customBalanceLoadingTo } = useBalance({
    address,
    token: isCustomToToken ? toAsset.address : undefined,
    chainId: toWagmiChain.id,
    query: { enabled: connected && isCustomToToken },
  });

  const usingLiveBalanceTo = connected && (isNativeAssetTo || isRealUsdcPairTo || isCustomToToken);
  const liveBalanceLoadingTo = isNativeAssetTo ? balanceLoadingTo : isCustomToToken ? customBalanceLoadingTo : usdcBalanceLoadingTo;
  const liveBalanceValueTo = isNativeAssetTo ? liveBalanceTo : isCustomToToken ? liveCustomBalanceTo : liveUsdcBalanceTo;

  useEffect(() => {
    // Merged against DEFAULT_BALANCES, not just loaded as-is — otherwise
    // anyone with balances already saved from before Stable existed would
    // still be missing that key entirely, even after the fix above,
    // since loadJSON returns the cached value verbatim with no merging.
    setBalances({ ...DEFAULT_BALANCES, ...loadJSON("mango:balances", DEFAULT_BALANCES) });
    setHistory(loadJSON("mango:history", []));
    setWithdrawals(loadJSON("mango:withdrawals", []));
    setTheme(loadJSON("mango:theme", "light"));
  }, []);

  function toggleTheme() {
    setTheme((t) => {
      const next = t === "light" ? "dark" : "light";
      saveJSON("mango:theme", next);
      return next;
    });
  }

  const P = PALETTE[theme];

  function swap() { setFrom(to); setTo(from); setFromAssetIdxRaw(toAssetIdx); setToAssetIdxRaw(fromAssetIdx); setFromCustomTokenRaw(toCustomToken); setToCustomTokenRaw(fromCustomToken); }
  // Real bug fix: switching chains never reset the selected asset, so a
  // stale asset from the previous chain (e.g. BNB) could stay selected
  // even after switching to a chain that doesn't support it at all (e.g.
  // Stable, which only ever has USDT0). Resetting to each chain's native
  // asset on change guarantees the selection is always valid.
  function defaultAssetIdxFor(chainKey) {
    const native = NATIVE_SYMBOL_BY_CHAIN[chainKey];
    const idx = ASSETS.findIndex((a) => a.symbol === native);
    return idx >= 0 ? idx : 0;
  }
  // Real fix: a custom token is chain-specific (its address means
  // nothing, or means something else entirely, on a different chain) —
  // switching chains must drop any selected custom token, same as it
  // already resets the built-in asset index to that chain's native
  // asset below.
  function handleFromChange(id) { setFrom(id); if (id === to) setTo(CHAIN_ORDER.find((c) => c !== id)); setFromAssetIdxRaw(defaultAssetIdxFor(id)); setFromCustomTokenRaw(null); setAmount(""); }
  function handleToChange(id) { setTo(id); if (id === from) setFrom(CHAIN_ORDER.find((c) => c !== id)); setToAssetIdxRaw(defaultAssetIdxFor(id)); setToCustomTokenRaw(null); setAmount(""); }
  // Swap tab's own single chain picker — sets from AND to together
  // (same chain on both sides, since a swap trades one asset for
  // another on ONE chain, unlike Bridge which moves one asset across
  // two). Defaults "you pay" to the chain's native asset and "you
  // receive" to the first other asset in the list, same reasoning
  // defaultAssetIdxFor above already uses for the Bridge tab.
  function handleSwapChainChange(id) {
    setFrom(id);
    setTo(id);
    const nativeIdx = defaultAssetIdxFor(id);
    setFromAssetIdxRaw(nativeIdx);
    const otherIdx = ASSETS.findIndex((a, i) => i !== nativeIdx);
    setToAssetIdxRaw(otherIdx >= 0 ? otherIdx : nativeIdx);
    setFromCustomTokenRaw(null);
    setToCustomTokenRaw(null);
    setAmount("");
  }
  function handleConnect() {
    if (isFromSolana || CHAINS[to]?.isSolana) {
      setShowWalletSelector(true);
    } else {
      openAppKit({ view: "Connect", namespace: "eip155" });
    }
  }

  const isCrossAsset = fromAsset.symbol !== toAsset.symbol;
  const kind = getTransferKind(from, to, fromAsset.symbol, toAsset.symbol);
  const amtNum = Math.max(0, parseFloat(amount) || 0);
  // Swap tab reuses this entire form (state, quote-checking, BridgeModal
  // execution) rather than a separate implementation — getTransferKind
  // already falls through to "relay" for any same-chain pair (none of
  // its CCTP/OP-stack/Arbitrum/Wormhole special cases can match when
  // from === to, they all require two specific DIFFERENT chains), and
  // getRelayQuote/executeRelayQuote are chain-count-agnostic the same
  // way mango-mobile's own DexScreen.tsx documents for its own,
  // separate-screen port of this same idea. Only the chain-picker UI,
  // the "different chain" vs "different asset" validity rule, and the
  // (same-chain-irrelevant) "send to another address" section differ
  // between the two tabs — everything else below is shared.
  const isSwapTab = tab === "swap";

  // Real bug fix: from/to default independently ("base"/"ethereum") and
  // only get forced equal when the user actually touches the chain
  // picker (handleSwapChainChange) — landing directly on the Swap tab
  // (nav click, or a ?tab=swap deep link) before that happens showed two
  // different chains on what's supposed to be a same-chain screen. Syncs
  // "to" to "from" the moment the tab becomes Swap with them mismatched,
  // resetting the asset pair the same way handleSwapChainChange itself
  // does, rather than leaving a stale asset selection from whichever
  // chain "to" used to point at.
  //
  // The reverse bug, same root cause: from/to are shared state across
  // both tabs, so leaving Swap with from === to (Swap's own normal
  // state) and landing back on Bridge showed "Base" in both pickers at
  // once — a real bridge only ever moves between two different chains
  // (Stargate/across.to/deBridge/LI.FI all hard-prevent this; it's what
  // Swap is for). ChainDropdown's own `exclude` prop already stops a
  // user from picking the same chain on both sides BY HAND, but can't
  // catch a collision that arrives from tab-switching instead. Bumps
  // "to" to a different chain the same way handleToChange already does
  // whenever this happens, the moment the tab becomes Bridge.
  useEffect(() => {
    if (isSwapTab && to !== from) {
      setTo(from);
      const nativeIdx = defaultAssetIdxFor(from);
      setFromAssetIdxRaw(nativeIdx);
      const otherIdx = ASSETS.findIndex((a, i) => i !== nativeIdx);
      setToAssetIdxRaw(otherIdx >= 0 ? otherIdx : nativeIdx);
      setFromCustomTokenRaw(null);
      setToCustomTokenRaw(null);
    } else if (!isSwapTab && from === to) {
      const nextTo = CHAIN_ORDER.find((c) => c !== from);
      setTo(nextTo);
      setToAssetIdxRaw(defaultAssetIdxFor(nextTo));
      setToCustomTokenRaw(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSwapTab]);

  // Proactive route check: for anything going through Relay, fetch a real
  // quote in the background as soon as there's a valid amount, rather than
  // waiting until the user taps confirm to find out a route doesn't exist.
  // This is what actually answers "tell the user there's no available route"
  // — a live check, not a guess based on which addresses we happen to have.
  const [routeCheck, setRouteCheck] = useState({ status: "idle" });
  // Logos discovered from Relay's own quote responses — see
  // extractLogoUpdates' own comment on why this is the only real
  // source for a symbol like USDT0 that no curated icon package or
  // open token list has. Grows across the session (never cleared),
  // since a symbol's real logo doesn't change chain-to-chain or
  // quote-to-quote — once discovered, it's discovered for good.
  const [discoveredAssetLogos, setDiscoveredAssetLogos] = useState({});
  useEffect(() => {
    // Real bug fix: this used to gate on the raw EVM `address` being
    // truthy, unconditionally — even for a pure Solana-to-Solana swap
    // that never touches EVM at all (recipientAddress below only ever
    // reads `address` when the destination is EVM and the source is
    // Solana; a Solana destination always uses activeSolanaAddress
    // instead, regardless of origin). With only a Solana wallet
    // connected — never an EVM one — that stray requirement meant this
    // effect stayed "idle" forever for a custom-token Solana swap: no
    // live quote was ever fetched, so the "You receive" preview never
    // got past its own no-price-known fallback (see `received`'s own
    // comment above) even though the actual quote request never needed
    // an EVM address in the first place. Reuses the exact same,
    // already-correct needsEvmAddressForSolanaSource/
    // needsSolanaAddressForSolanaDest the CTA's own canBridge already
    // relies on, instead of a separate, wrong ad-hoc check.
    if (kind !== "relay" || amtNum <= 0 || !connected || needsEvmAddressForSolanaSource || needsSolanaAddressForSolanaDest) {
      setRouteCheck({ status: "idle" });
      return;
    }
    let cancelled = false;
    setRouteCheck({ status: "checking" });
    const timer = setTimeout(async () => {
      // Real fix: this used to be a bare await with the response
      // discarded — see summarizeQuote's own comment. The quote itself
      // is kept here so the fee/ETA/received preview below can show
      // Relay's real numbers instead of a static estimate.
      function applyOkQuote(quote, fallbackQuote) {
        if (cancelled) return;
        setRouteCheck({ status: "ok", quote, fallbackQuote: fallbackQuote ?? null });
        if (!quote) return;
        const logoUpdates = extractLogoUpdates(quote);
        if (Object.keys(logoUpdates).length > 0) {
          setDiscoveredAssetLogos((prev) => {
            // Skip the update entirely (same object reference back)
            // when nothing's actually new — every symbol already known
            // maps to the exact same URL — so this doesn't trigger an
            // extra re-render on every single quote tick once a
            // symbol's logo has already been discovered once.
            const changed = Object.entries(logoUpdates).some(([sym, url]) => prev[sym] !== url);
            return changed ? { ...prev, ...logoUpdates } : prev;
          });
        }
      }

      let firstErr;
      try {
        const decimals = onchainDecimalsForAsset(fromAsset);
        if (!decimals) throw new Error(`No decimals known for ${fromAsset.symbol} — can't safely build an amount.`);
        const amountBaseUnitsBig = parseUnits(amount, decimals);
        const amountBaseUnits = amountBaseUnitsBig.toString();

        // Same real root cause as BridgeModal's own execute-time check
        // (see that call site's own comment for the full explanation:
        // a Launchpad-launched token trades through a custom Uniswap
        // v4 hook that Relay and every fallback provider can't price).
        // Mirrored here so the PREVIEW recognizes it too, instead of
        // showing "No price estimate yet" and leaving the Swap button
        // disabled while Relay/fallback quotes — which can never
        // succeed against this specific pool — keep failing behind the
        // scenes.
        if (from === "robinhood" && to === "robinhood") {
          const launchpadTokenAddress =
            fromAsset.symbol === "ETH" && toAsset.address ? toAsset.address :
            toAsset.symbol === "ETH" && fromAsset.address ? fromAsset.address :
            null;
          if (launchpadTokenAddress) {
            const side = fromAsset.symbol === "ETH" ? "buy" : "sell";
            try {
              const { estimatedAmountOut } = await getTradeQuote({ tokenAddress: launchpadTokenAddress, side, amountIn: amountBaseUnitsBig });
              applyOkQuote(null, { provider: "launchpad", buyAmount: estimatedAmountOut.toString() });
              return;
            } catch {
              // Not a real Launchpad pool for this address — fall
              // through to the normal Relay/fallback checks below,
              // exactly as before this fix.
            }
          }
        }

        const originAmountUsd = fromAsset.price > 0 ? amtNum * fromAsset.price : undefined;
        const quoteParams = {
          fromChainKey: from, toChainKey: to,
          fromAsset: fromAsset.symbol, toAsset: toAsset.symbol,
          // Same override reasoning as the execution path in BridgeModal
          // above — see that call site's own comment. A selected custom
          // token (fromAsset.custom/toAsset.custom) takes priority over
          // the wallet-only-chain fallback, same as
          // resolveCurrencyForAsset's own precedence.
          originChainId: isWalletOnlyChain(from) ? resolveChainId(from) : undefined,
          originCurrency: (fromAsset.custom || isWalletOnlyChain(from)) ? resolveCurrencyForAsset(from, fromAsset) : undefined,
          destinationChainId: isWalletOnlyChain(to) ? resolveChainId(to) : undefined,
          destinationCurrency: (toAsset.custom || isWalletOnlyChain(to)) ? resolveCurrencyForAsset(to, toAsset) : undefined,
          amountBaseUnits, userAddress: activeAccount,
          // Same real fix as the execution path — a Solana source needs
          // the connected EVM address as the recipient on an EVM
          // destination, not the Solana address itself.
          // Same real fix, symmetric for both directions — Solana
          // involved on EITHER side needs its own correctly-typed
          // address as the recipient, not whichever wallet happens to
          // be the "account" for the source side.
          recipientAddress: sendToOther ? destAddress : (CHAINS[to]?.isSolana ? activeSolanaAddress : (isFromSolana ? address : activeAccount)),
        };
        try {
          const quote = await getRelayQuote({ ...quoteParams, originAmountUsd });
          applyOkQuote(quote);
          return;
        } catch (err) {
          firstErr = err;
        }
        // Real bug fix, live-confirmed: this preview used to stop right
        // here and disable the Swap button — "No available route for
        // this trade" — the instant the FIRST attempt above failed,
        // even though BridgeModal's own execute path (below) already
        // has a real fallback chain for exactly this case (a normal-fee
        // quote failing doesn't mean no route exists at all). That made
        // the whole fallback chain unreachable: the button never became
        // tappable, so Confirm — the only place that chain ever ran —
        // could never fire. Mirrors BridgeModal's own three-tier order
        // here too, same-chain Swap only (from === to — Bridge always
        // has from !== to, so this never fires there).
        if (from === to) {
          try {
            const quote = await getRelayQuote({ ...quoteParams, feeBpsOverride: "0" });
            applyOkQuote(quote);
            return;
          } catch {
            // Falls through to the fallback-provider check below.
          }
          try {
            const sellTokenAddress = fromAsset.custom ? fromAsset.address : resolveCurrency(from, fromAsset.symbol);
            const buyTokenAddress = toAsset.custom ? toAsset.address : resolveCurrency(to, toAsset.symbol);
            const fallbackQuote = await checkFallbackRoute({
              chainId: resolveChainId(from),
              sellToken: sellTokenAddress,
              buyToken: buyTokenAddress,
              sellAmount: amountBaseUnits,
              takerAddress: activeAccount,
              originAmountUsd,
            });
            if (fallbackQuote) {
              // No Relay-shaped quote to show, but checkFallbackRoute's
              // own real, provider-quoted buyAmount is — the "received"
              // calc below now reads routeCheck.fallbackQuote directly
              // instead of leaving this blank. Real gap this closes,
              // live-reported: the preview used to show "No price
              // estimate yet" even when a fallback route (with a real
              // quoted output amount) was exactly what unlocked the
              // button.
              applyOkQuote(null, fallbackQuote);
              return;
            }
          } catch {
            // No fallback route either — falls through to unavailable.
          }
        }
      } catch (err) {
        firstErr = err;
      }
      if (!cancelled) setRouteCheck({ status: "unavailable", message: firstErr?.message || String(firstErr) });
    }, 600); // debounce so we don't fire a request per keystroke
    return () => { cancelled = true; clearTimeout(timer); };
  }, [kind, amtNum, connected, address, needsEvmAddressForSolanaSource, needsSolanaAddressForSolanaDest, from, to, fromAsset.symbol, toAsset.symbol, amount]);
  const routeUnavailable = kind === "relay" && routeCheck.status === "unavailable";
  const routeChecking = kind === "relay" && routeCheck.status === "checking";
  // The real quote routeCheck above just fetched — see summarizeQuote's
  // own comment on why this matters: without it, fee/etaLabel/received
  // below are a static per-chain/per-asset estimate that never reflects
  // Relay at all, live route or not.
  const liveQuoteSummary = routeCheck.status === "ok" && routeCheck.quote ? summarizeQuote(routeCheck.quote, onchainDecimalsForAsset(toAsset)) : null;
  // A fallback-provider quote (1inch/0x/OKX/KyberSwap — see
  // checkFallbackRoute's own comment) isn't Relay-shaped, so
  // summarizeQuote can't parse it, but its own buyAmount is real,
  // provider-quoted data in the buy token's own on-chain decimals —
  // formatted here rather than left blank. Guarded the same way every
  // other decimals lookup in this file already is: a symbol
  // onchainDecimalsForAsset doesn't know throws, which just means no
  // preview number rather than a wrong one.
  let fallbackReceivedAmount = null;
  if (routeCheck.status === "ok" && !routeCheck.quote && routeCheck.fallbackQuote?.buyAmount) {
    try {
      fallbackReceivedAmount = Number(formatUnits(BigInt(routeCheck.fallbackQuote.buyAmount), onchainDecimalsForAsset(toAsset)));
    } catch {
      fallbackReceivedAmount = null;
    }
  }
  // A same-chain swap is one transaction, not two — charging both
  // "source gas" and "destination gas" for the same chain would double
  // count it. Bridge (from !== to) keeps paying for both legs. Falls
  // back to this static per-chain estimate only while a live quote
  // isn't available yet (still checking, no route, or a non-Relay kind
  // like a CCTP/op-withdraw/arb-withdraw special case, which never has
  // one).
  const fee = liveQuoteSummary?.totalFeeUsd ?? (isSwapTab ? CHAINS[from].baseFee : CHAINS[from].baseFee + CHAINS[to].baseFee);
  // Real bug fix, live-reported: this used to be a flat amtNum *
  // DEV_FEE_PCT with no cap, while the actual fee sent to Relay/the
  // fallback providers (getRelayQuote's own appFeeBps, devFeeWallets.js)
  // has always applied a $50 maximum on large trades. That mismatch
  // meant the confirm screen could show a bigger fee than what's
  // actually charged — e.g. a $30k trade displaying $75 while only $50
  // is ever collected. Now calls the exact same appFeeBps() the real
  // quote uses, so this number can never drift from what's charged.
  const devFeeAmount = amtNum * (Number(appFeeBps(fromAsset.price > 0 ? amtNum * fromAsset.price : undefined)) / 10000);
  const seconds = liveQuoteSummary?.etaSeconds ?? Math.max(CHAINS[from].baseSeconds, CHAINS[to].baseSeconds);
  const etaLabel = seconds < 60 ? `~${Math.max(1, Math.round(seconds))}s` : `~${Math.round(seconds / 60)} min`;
  // For same-asset transfers this is a direct estimate. For cross-asset swaps
  // this converts through each asset's rough USD price as a ROUGH estimate
  // only — the real exchange rate comes from Relay's live quote at execution
  // time and can differ meaningfully from this number, especially for
  // volatile assets. Never treat this as authoritative for a swap. Used only
  // as a fallback below, while the real quote isn't available yet.
  //
  // Real bug fix: a custom token's price is deliberately 0 above — this
  // file's own "cosmetic-only placeholder, never used for real math"
  // sentinel — but `(fromAsset.price || 1)`/`(toAsset.price || 1)`
  // treated that 0 exactly like a genuine $1 price, silently pricing
  // every custom token as if it were a dollar stablecoin. That's not a
  // rough estimate, it's a fabricated number: a token actually worth a
  // fraction of a cent showed a "You receive" preview built as though
  // it were worth $1 each. Now null (no estimate at all) whenever
  // either side's price is genuinely unknown, rather than a specific,
  // confident-looking wrong one — this can happen even with a real,
  // liquid custom token, any time the live Relay quote above hasn't
  // resolved yet (still checking, or the route-check gate skipped it
  // entirely — see its own comment — because a Solana destination has
  // no wallet connected yet).
  const knownPrice = fromAsset.price > 0 && toAsset.price > 0;
  const amtNumUsdValue = knownPrice ? (amtNum - devFeeAmount) * fromAsset.price - fee : null;
  const received = liveQuoteSummary?.receivedAmount ?? fallbackReceivedAmount ?? (amtNumUsdValue !== null ? Math.max(amtNumUsdValue / toAsset.price, 0) : null);
  // Real bug fix, live-reported: a genuine (non-null) received amount
  // that's just too small to show at 4 decimal places rendered as a
  // bare "0.0000" — visually identical to "nothing happened" or "this
  // is worthless," even though a real quote WAS returned. Most common
  // for a token on an older, unindexed/unsupported Launchpad hook
  // version (api/v1/launchpad/token.js's own "may be on an older,
  // unverified Hook version" case): whatever route did answer (Relay
  // or a fallback provider) may have found only degenerate liquidity
  // for it, producing a real but economically meaningless quote. Shown
  // as an explicit warning instead of a misleadingly bare zero either
  // way — true regardless of why the amount is this small.
  const receivedRoundsToZero = received !== null && amtNum > 0 && Number(received.toFixed(4)) === 0;
  const availableBalance = !usingLiveBalance
    ? null
    : isFromSolana
      ? (fromChainBalances[fromAsset.symbol] ?? null)
      : (liveBalanceValue ? Number(liveBalanceValue.formatted) : null);
  // Native assets need to keep a small amount aside for gas — MAX-ing out a
  // native balance to the exact wei is a classic way to end up unable to pay
  // for the transaction that spends it. ERC-20s don't need this (gas is paid
  // in the native token, separately from the token being sent).
  // SOL didn't have an entry here either — same category of gap as the
  // missing balance display above (Solana was excluded from every one
  // of these EVM-oriented paths, not just skipped intentionally).
  // 0.002 SOL covers real transaction fees plus token-account rent with
  // room to spare — the same conservative minimum-reserve convention
  // Phantom/Solflare themselves use, not a guessed number.
  const GAS_RESERVE = { ETH: 0.0004, BNB: 0.001, USDT0: 0.5, SOL: 0.002 };
  const gasReserve = GAS_RESERVE[fromAsset.symbol] ?? 0;
  const spendableBalance = availableBalance !== null ? Math.max(availableBalance - gasReserve, 0) : null;
  const insufficient = usingLiveBalance && spendableBalance !== null && amtNum > spendableBalance;
  // Bridge requires two different chains (that's what makes it a
  // bridge); Swap requires the same chain but two different assets
  // (that's what makes it a trade — same-asset same-chain is a no-op).
  // "Send to another address" is Bridge-only (a swap always lands back
  // in the connected wallet, same reasoning mobile's own DexScreen.tsx
  // gives for not offering that section at all) — isSwapTab short-
  // circuits that clause rather than relying on sendToOther happening
  // to still be false, in case it was left checked from the Bridge tab.
  const chainAssetPairValid = isSwapTab ? from === to && fromAsset.symbol !== toAsset.symbol : from !== to;
  const canBridge = amtNum > 0 && chainAssetPairValid && !insufficient && !onWrongNetwork && !needsEvmAddressForSolanaSource && !needsSolanaAddressForSolanaDest && (isSwapTab || !sendToOther || isValidDestinationAddress(destAddress, CHAINS[to]?.isSolana));

  function persist(newBalances, newHistory) {
    saveJSON("mango:balances", newBalances);
    saveJSON("mango:history", newHistory);
  }
  function handleComplete(hash) {
    // Real bug fix, newly reachable now that the Swap tab allows from ===
    // to: building [from]: {...} and [to]: {...} as two separate object-
    // literal entries silently drops the first one whenever they're the
    // same key — the second entry's spread reads the ORIGINAL balances,
    // not the just-computed debit, so it overwrites rather than adds to
    // it. Applying the "to" update on top of the already-updated "from"
    // chain entry (not the stale original `balances`) keeps both the
    // debit and the credit when they land on the same chain.
    const fromChainBalances = { ...balances[from], [fromAsset.symbol]: Math.max(0, (balances[from][fromAsset.symbol] || 0) - amtNum) };
    // received can now be null (no reliable price estimate — see its
    // own comment above); this optimistic local credit is cosmetic
    // bookkeeping only, corrected by the next real balance fetch either
    // way, so 0 here (no credit shown yet) beats letting a null
    // propagate into NaN and corrupt the stored balance entirely.
    const receivedForBalance = received ?? 0;
    const toChainBalances = from === to
      ? { ...fromChainBalances, [toAsset.symbol]: (fromChainBalances[toAsset.symbol] || 0) + receivedForBalance }
      : { ...balances[to], [toAsset.symbol]: (balances[to][toAsset.symbol] || 0) + receivedForBalance };
    const newBalances = {
      ...balances,
      [from]: fromChainBalances,
      [to]: toChainBalances,
    };
    // Updates the pending entry handlePendingHash already created for
    // this exact hash (the normal case) rather than inserting a second,
    // duplicate row — falls back to inserting fresh only for a path
    // that never went through that effect (the simulated flow, whose
    // hash is a fake shortHash(), never a real on-chain one).
    //
    // Real bug fix, live-reported ("junk" entries — a stray "pending"
    // row sitting next to the real "complete" one that never resolved):
    // this used to read `history` from the closure and call
    // setHistory(plainValue) — for a fast path where setRealBurnHash
    // and onComplete fire back-to-back synchronously (the fallback-
    // provider execution branch), the onPendingHash effect (which only
    // runs after React's next paint) could still be pending when this
    // ran, so it saw a STALE history snapshot missing the entry
    // handlePendingHash was about to add — then handlePendingHash
    // itself ran against an equally stale snapshot missing THIS
    // update, its own dedupe check (`history.some(...)`) failed to
    // find it, and it inserted a genuine duplicate. The functional
    // updater form below always operates on React's actual latest
    // state at the moment it's applied, regardless of call order or
    // timing, so this race can't happen no matter which fires first.
    let newHistory;
    setHistory((prevHistory) => {
      const existingIdx = prevHistory.findIndex((h) => h.hash === hash);
      const entry = { id: Date.now(), from, to, amount: amtNum, symbol: fromAsset.symbol, toSymbol: toAsset.symbol, hash, timestamp: Date.now(), status: "complete" };
      newHistory = existingIdx >= 0
        ? prevHistory.map((h, i) => (i === existingIdx ? { ...h, status: "complete" } : h))
        : [entry, ...prevHistory];
      return newHistory;
    });
    setBalances(newBalances);
    persist(newBalances, newHistory);
    // Real fix: the asset dropdown's live balance display previously only
    // ever refreshed on wallet connect, chain switch, or opening the
    // dropdown — never after a transaction actually completed, so it
    // silently went stale the moment a trade landed. forceFresh bypasses
    // the short-lived cache so this reads the genuinely-updated balance,
    // not a value cached from just before the transaction.
    refreshFromChainBalances(true);
  }
  // BridgeModal's own onPendingHash — fires the moment a flow's source-
  // side transaction genuinely broadcasts, well before it's known to
  // have fully succeeded. See that effect's own comment for the real
  // gap this closes. Deliberately a distinct status ("pending", not
  // "complete") so the History tab can show it as still-in-flight —
  // handleComplete above updates this exact same entry once (if) the
  // flow actually finishes; if it never does (tab closed, or a
  // destination-side failure after this already broadcast), the entry
  // stays visible with its real hash and an explorer link, instead of
  // vanishing as if nothing was ever sent.
  function handlePendingHash(hash) {
    // Real bug fix, same race as handleComplete's own comment above:
    // the dedupe check and the update both now run against React's
    // actual latest state at apply time, not a closure snapshot that
    // could be stale relative to a same-tick handleComplete call.
    let newHistory = null;
    setHistory((prevHistory) => {
      if (prevHistory.some((h) => h.hash === hash)) return prevHistory; // already recorded (e.g. StrictMode double-invoke, or handleComplete beat this here)
      const entry = { id: Date.now(), from, to, amount: amtNum, symbol: fromAsset.symbol, toSymbol: toAsset.symbol, hash, timestamp: Date.now(), status: "pending" };
      newHistory = [entry, ...prevHistory];
      return newHistory;
    });
    if (newHistory) saveJSON("mango:history", newHistory);
  }
  function resetHistory() {
    setHistory([]);
    removeKey("mango:history");
  }
  function setMax() { if (spendableBalance !== null) setAmount(String(spendableBalance)); }

  function handleWithdrawalInitiated({ l2TxHash, l2Timestamp, amount: amt, account: acct, chainType, l2Key }) {
    const entry = { id: Date.now(), l2TxHash, l2Timestamp, amount: amt, account: acct, initiatedAt: Date.now(), chainType, l2Key, status: chainType === "arb" ? "waiting-to-finalize" : "waiting-to-prove" };
    const next = [entry, ...withdrawals];
    setWithdrawals(next);
    saveJSON("mango:withdrawals", next);
    // The source chain's balance is genuinely debited the moment this
    // initiating transaction lands, even though the destination side
    // takes days to arrive — same staleness fix as handleComplete above.
    refreshFromChainBalances(true);
  }
  function handleWithdrawalTracked(entry) {
    const next = [entry, ...withdrawals];
    setWithdrawals(next);
    saveJSON("mango:withdrawals", next);
  }
  function handleWithdrawalUpdate(updated) {
    const next = withdrawals.map((w) => (w.id === updated.id ? updated : w));
    setWithdrawals(next);
    saveJSON("mango:withdrawals", next);
  }

  return (
    <div className="min-h-screen w-full pb-24 relative overflow-x-hidden" style={{ background: P.bg, fontFamily: "'Inter', sans-serif" }}>
      <style>{`
        .font-display { font-family: 'Space Grotesk', sans-serif; }
        .font-mono { font-family: 'IBM Plex Mono', monospace; }
        input[type=number]::-webkit-inner-spin-button { -webkit-appearance: none; }
        input:focus { outline: none; }
      `}</style>

      <FloatingMangoDecor P={P} />

      {/* Top nav */}
      <div className="flex items-center justify-between px-6 py-4 relative" style={{ borderBottom: `1px solid ${P.divider}`, zIndex: 45, paddingTop: "calc(16px + env(safe-area-inset-top, 0px))" }}>
        <div className="flex items-center gap-2.5">
          <TopMenuDropdown P={P} onOpenDocs={() => setShowDocs(true)} />
          <MangoLogo size={24} color={P.textPrimary} />
          <span className="font-display text-[11px] font-semibold tracking-tight" style={{ color: P.textPrimary }}>Mango Protocol</span>
        </div>
        <div className="flex items-center gap-1.5">
          <button onClick={toggleTheme} className="w-8 h-8 rounded-full flex items-center justify-center" style={{ background: P.panel, border: `1px solid ${P.panelBorder}` }}>
            {theme === "light" ? <Moon size={13} color={P.textSecondary} /> : <Sun size={13} color={P.textSecondary} />}
          </button>
          <button onClick={() => setShowNetworkSelector(true)} className="w-8 h-8 rounded-full flex items-center justify-center" style={{ background: P.panel, border: `1px solid ${P.panelBorder}` }}>
            <Globe size={13} color={P.textSecondary} />
          </button>
          {connected ? (
            <button
              onClick={() => {
                if (!isFromSolana) { disconnect(); return; }
                if (solanaWallet.address) { solanaWallet.disconnect(); } else { disconnectAppKit({ namespace: "solana" }); }
              }}
              className="flex items-center gap-1.5 pl-2 pr-3 py-1.5 rounded-full text-[12px] font-semibold" style={{ background: P.ctaBg, color: P.ctaText }}>
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: LIME }} />
              {activeAccount ? `${activeAccount.slice(0, 5)}…${activeAccount.slice(-3)}` : ""}
            </button>
          ) : (
            <button onClick={handleConnect} disabled={isConnecting} className="px-3.5 py-1.5 rounded-full text-[12px] font-semibold" style={{ background: P.ctaBg, color: P.ctaText, opacity: isConnecting ? 0.6 : 1 }}>
              {isConnecting ? "Connecting…" : "Connect"}
            </button>
          )}
        </div>
      </div>

      {(tab === "bridge" || tab === "swap") && onWrongNetwork && (
        <div className="flex items-center justify-between gap-3 px-6 py-2.5" style={{ background: "#FCEFD9", borderBottom: "1px solid #F0D9A8" }}>
          <span className="flex items-center gap-2 text-[12.5px]" style={{ color: "#8A5A00" }}>
            <AlertTriangle size={13} /> Wallet is on the wrong network for {CHAINS[from].name}
          </span>
          <button onClick={() => switchChain({ chainId: fromWagmiChain.id })} className="text-[12px] font-semibold px-3 py-1.5 rounded-lg" style={{ background: "#8A5A00", color: "#FFFFFF" }}>
            Switch
          </button>
        </div>
      )}

      {connectError && (
        <div className="px-6 py-2.5 text-[12px] font-mono" style={{ background: "#FBE8E8", borderBottom: "1px solid #F0C7C7", color: "#B42318" }}>
          Connect error: {connectError.message || String(connectError)}
        </div>
      )}

      {/* Body */}
      <div className="flex justify-center px-4 py-8 relative" style={{ zIndex: 1 }}>
        <div className="w-full max-w-[420px]">
          {tab === "history" && (
            <div className="flex gap-1 mb-3 p-1 rounded-xl w-fit" style={{ background: P.panel }}>
              {[{ id: "transfers", label: "Transfers" }, { id: "withdrawals", label: "Withdrawals" }].map((s) => (
                <button key={s.id} onClick={() => setHistorySubTab(s.id)} className="px-4 py-1.5 rounded-lg text-[13px] font-medium" style={{ background: historySubTab === s.id ? P.navActive : "transparent", color: historySubTab === s.id ? P.navActiveText : P.textSecondary }}>
                  {s.label}
                </button>
              ))}
            </div>
          )}

          {tab === "history" ? (
            historySubTab === "withdrawals" ? (
              <WithdrawalsTab withdrawals={withdrawals} onUpdate={handleWithdrawalUpdate} onTrack={handleWithdrawalTracked} />
            ) : (
              <HistoryTab history={history} onReset={resetHistory} />
            )
          ) : tab === "portfolio" ? (
            <PortfolioTab address={address} connected={connected} P={P} />
          ) : tab === "launchpad" ? (
            <LaunchpadTab P={P} theme={theme} deepLinkTokenAddress={deepLinkTokenAddress} launchpadNetwork={launchpadNetwork} />
          ) : tab === "wallet" ? (
            <MangoWalletTab P={P} />
          ) : (
            <>
              {/* You send */}
              <div className="rounded-2xl p-4 shadow-sm" style={{ background: P.panel, border: `1px solid ${P.panelBorder}` }}>
                <div className="flex items-center justify-between mb-2.5">
                  <span className="text-[12.5px] font-medium" style={{ color: P.textSecondary }}>You send</span>
                  <span className="text-[11.5px]" style={{ color: P.textMuted }}>
                    {usingLiveBalance && (liveBalanceLoading ? "Loading balance…" : `Balance: ${fmt(availableBalance, fromAsset.decimals)} ${fromAsset.symbol}`)}
                  </span>
                </div>
                {/* Swap tab's chain picker lives right here, in the exact
                    same slot Bridge's own "from" picker already uses —
                    one chain for both legs (handleSwapChainChange sets
                    from/to together), rather than a separate "Swap on"
                    panel above the form. */}
                <div className="flex items-center justify-between mb-3">
                  {isSwapTab ? (
                    <ChainDropdown value={from} onChange={handleSwapChainChange} P={P} chainOrder={swapChainOrder} />
                  ) : (
                    <ChainDropdown value={from} exclude={to} onChange={handleFromChange} P={P} chainOrder={bridgeFromChainOrder} />
                  )}
                </div>
                <div className="flex items-center justify-between rounded-xl px-3.5 py-3" style={{ background: P.input, border: `1px solid ${insufficient ? "#D92D20" : P.panelBorder}` }}>
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="0"
                    className="font-display bg-transparent text-[24px] font-semibold w-full"
                    style={{ color: P.textPrimary }}
                  />
                  <button onClick={setMax} disabled={availableBalance === null} className="text-[10.5px] font-bold px-2 py-1 rounded-md mr-2 shrink-0" style={{ background: availableBalance === null ? P.pillBg : `${LIME}1A`, color: availableBalance === null ? P.textMuted : LIME_DEEP, opacity: availableBalance === null ? 0.6 : 1 }}>MAX</button>
                  <AssetDropdown assetIdx={fromAssetIdx} setAssetIdx={handleFromAssetChange} chainId={from} P={P} balances={fromChainBalances} balancesLoading={balancesLoading} onOpen={refreshFromChainBalances} customToken={fromCustomToken} onCustomTokenSelect={handleFromCustomTokenSelect} allowCustomToken={isSwapTab} discoveredLogos={discoveredAssetLogos} />
                </div>
                {insufficient && <div className="text-[11.5px] mt-1.5" style={{ color: "#D92D20" }}>Insufficient balance on {CHAINS[from].name}</div>}
              </div>

              {/* Swap toggle */}
              <div className="flex justify-center -my-3 relative z-10">
                <button onClick={swap} className="w-9 h-9 rounded-xl flex items-center justify-center shadow-sm" style={{ background: P.ctaBg }}>
                  <ArrowUpDown size={15} color={P.ctaText} />
                </button>
              </div>

              {/* You receive */}
              <div className="rounded-2xl p-4 mt-3 shadow-sm" style={{ background: P.panel, border: `1px solid ${P.panelBorder}` }}>
                <div className="flex items-center justify-between mb-2.5">
                  <span className="text-[12.5px] font-medium" style={{ color: P.textSecondary }}>You receive</span>
                  <span className="text-[11.5px]" style={{ color: P.textMuted }}>
                    {usingLiveBalanceTo && (liveBalanceLoadingTo ? "Loading balance…" : `Balance: ${fmt(Number(liveBalanceValueTo?.formatted ?? 0), toAsset.decimals)} ${toAsset.symbol}`)}
                  </span>
                </div>
                {/* Real swap widgets (Uniswap, Jupiter, 1inch, PancakeSwap)
                    all use ONE network selector for the whole swap, not
                    one per side — a same-chain swap only ever has one
                    chain to pick. Swap's own selector lives in the "You
                    send" card above (handleSwapChainChange already sets
                    from/to together); this card only needs the token
                    picker. Bridge keeps its own second, independent
                    picker below — a bridge genuinely can move between
                    two different chains. */}
                {!isSwapTab && (
                  <div className="flex items-center justify-between mb-3">
                    <ChainDropdown value={to} exclude={from} onChange={handleToChange} P={P} chainOrder={bridgeToChainOrder} />
                  </div>
                )}
                <div className="flex items-center justify-between rounded-xl px-3.5 py-3" style={{ background: P.input, border: `1px solid ${P.panelBorder}` }}>
                  <span className="font-display text-[24px] font-semibold" style={{ color: amtNum > 0 && received !== null ? P.textPrimary : P.textMuted }}>
                    {amtNum > 0 ? (received !== null ? fmt(received, 4) : "—") : "0"}
                  </span>
                  <AssetDropdown assetIdx={toAssetIdx} setAssetIdx={handleToAssetChange} chainId={to} P={P} customToken={toCustomToken} onCustomTokenSelect={handleToCustomTokenSelect} allowCustomToken={isSwapTab} discoveredLogos={discoveredAssetLogos} />
                </div>
                {amtNum > 0 && received === null && (
                  <div className="text-[11.5px] mt-1.5" style={{ color: P.textMuted }}>
                    No price estimate yet for {fromAsset.custom ? fromAsset.symbol : toAsset.symbol} — the real amount is set by Relay's live quote.
                  </div>
                )}
                {receivedRoundsToZero && (
                  <div className="text-[11.5px] mt-1.5" style={{ color: "#F0B84D" }}>
                    This amount would return next to nothing at the current rate — try a larger amount, or this token/pair may not have a working route yet.
                  </div>
                )}
              </div>

              {/* ETA / details collapsible */}
              <button onClick={() => setDetailsOpen((o) => !o)} className="w-full flex items-center justify-between mt-3 px-4 py-2.5 rounded-xl" style={{ background: P.panel, border: `1px solid ${P.panelBorder}` }}>
                <span className="text-[12.5px] font-medium flex items-center gap-1.5" style={{ color: LIME_DEEP }}>
                  <span className="w-1.5 h-1.5 rounded-full" style={{ background: LIME }} /> Fee ${fmt(fee, 2)}
                </span>
                <span className="flex items-center gap-1.5 text-[12.5px]" style={{ color: P.textSecondary }}>
                  ETA: {etaLabel}
                  <ChevronDown size={13} color={P.textMuted} style={{ transform: detailsOpen ? "rotate(180deg)" : "none" }} />
                </span>
              </button>
              {detailsOpen && (
                <div className="mt-2 px-4 py-3 rounded-xl flex flex-col gap-2" style={{ background: P.input, border: `1px solid ${P.panelBorder}` }}>
                  {isSwapTab ? (
                    <>
                      <div className="flex items-center justify-between text-[12.5px]"><span style={{ color: P.textSecondary }}>Route</span><span style={{ color: P.textPrimary }}>{fromAsset.symbol} → {toAsset.symbol} on {CHAINS[from].name}</span></div>
                      <div className="flex items-center justify-between text-[12.5px]"><span style={{ color: P.textSecondary }}>Gas</span><span className="font-mono" style={{ color: P.textPrimary }}>${fmt(CHAINS[from].baseFee, 2)}</span></div>
                    </>
                  ) : (
                    <>
                      <div className="flex items-center justify-between text-[12.5px]"><span style={{ color: P.textSecondary }}>Route</span><span style={{ color: P.textPrimary }}>{CHAINS[from].name} → {CHAINS[to].name}</span></div>
                      <div className="flex items-center justify-between text-[12.5px]"><span style={{ color: P.textSecondary }}>Source gas</span><span className="font-mono" style={{ color: P.textPrimary }}>${fmt(CHAINS[from].baseFee, 2)}</span></div>
                      <div className="flex items-center justify-between text-[12.5px]"><span style={{ color: P.textSecondary }}>Destination gas</span><span className="font-mono" style={{ color: P.textPrimary }}>${fmt(CHAINS[to].baseFee, 2)}</span></div>
                    </>
                  )}
                  <div className="flex items-center justify-between text-[12.5px]"><span style={{ color: P.textSecondary }}>Protocol fee ({formatFeePct(DEV_FEE_PCT)}%)</span><span className="font-mono" style={{ color: P.textPrimary }}>{fmt(devFeeAmount, fromAsset.decimals)} {fromAsset.symbol}</span></div>
                </div>
              )}

              {/* Real, contextual second-wallet prompt — only appears at
                  all when Solana is genuinely involved on either side of
                  the current selection, since that's the only time a
                  second, separate wallet is actually needed. */}
              {(isFromSolana || CHAINS[to]?.isSolana) && !activeSolanaAddress && (
                <div className="mt-3 rounded-xl p-3.5" style={{ background: P.panel, border: `1px solid ${P.panelBorder}` }}>
                  <div className="text-[12.5px] font-medium mb-1" style={{ color: P.textPrimary }}>Solana wallet needed</div>
                  <div className="text-[11px] mb-2.5" style={{ color: P.textMuted }}>
                    Solana isn't EVM-compatible, so this route needs its own separate connection, alongside your regular wallet.
                  </div>
                  <button
                    onClick={() => setShowWalletSelector(true)}
                    disabled={solanaWallet.connecting}
                    className="w-full py-2.5 rounded-lg text-[12.5px] font-semibold"
                    style={{ background: P.ctaBg, color: P.ctaText, opacity: solanaWallet.connecting ? 0.6 : 1 }}
                  >
                    {solanaWallet.connecting ? "Connecting…" : "Connect Solana Wallet"}
                  </button>
                  {solanaWallet.error && (
                    <div className="mt-2 text-[10.5px]" style={{ color: "#D92D20" }}>{solanaWallet.error}</div>
                  )}
                </div>
              )}

              {/* Real, mirrored gap fix: when Solana is connected and
                  used as the source, the top bar only ever shows ONE
                  wallet address at a time - so once the Solana address
                  is showing there, there was no visible way left in the
                  main form to reach the SEPARATE EVM connection this
                  route also genuinely needs. This makes that need
                  visible and actionable, right where the person is
                  already looking. */}
              {isFromSolana && !CHAINS[to]?.isSolana && !sendToOther && !address && (
                <div className="mt-3 rounded-xl p-3.5" style={{ background: P.panel, border: `1px solid ${P.panelBorder}` }}>
                  <div className="text-[12.5px] font-medium mb-1" style={{ color: P.textPrimary }}>EVM wallet needed</div>
                  <div className="text-[11px] mb-2.5" style={{ color: P.textMuted }}>
                    Your Solana wallet is connected, but {CHAINS[to].name} needs a separate EVM wallet as the destination.
                  </div>
                  <button
                    onClick={() => openAppKit({ view: "Connect", namespace: "eip155" })}
                    className="w-full py-2.5 rounded-lg text-[12.5px] font-semibold"
                    style={{ background: P.ctaBg, color: P.ctaText }}
                  >
                    Connect EVM Wallet
                  </button>
                </div>
              )}

              {/* Send to another address — Bridge only. A swap always
                  lands back in the connected wallet, same reasoning
                  mobile's own DexScreen.tsx gives for not offering this
                  section at all on its swap screen. */}
              {!isSwapTab && (
                <div className="mt-3 rounded-xl p-3.5" style={{ background: P.panel, border: `1px solid ${P.panelBorder}` }}>
                  <label className="flex items-center gap-2.5 cursor-pointer">
                    <input type="checkbox" checked={sendToOther} onChange={(e) => setSendToOther(e.target.checked)} className="w-4 h-4 rounded" style={{ accentColor: LIME }} />
                    <span className="text-[12.5px] font-medium" style={{ color: P.textPrimary }}>Send to another address</span>
                  </label>
                  {sendToOther && (
                    <>
                      <input
                        value={destAddress}
                        onChange={(e) => setDestAddress(e.target.value)}
                        placeholder={`Enter ${CHAINS[to].name} address`}
                        className="w-full mt-2.5 px-3 py-2.5 rounded-lg text-[13px] font-mono"
                        style={{ background: P.input, border: `1px solid ${destAddress.trim() && !isValidDestinationAddress(destAddress, CHAINS[to]?.isSolana) ? "#D92D20" : P.panelBorder}`, color: P.textPrimary }}
                      />
                      {destAddress.trim() && !isValidDestinationAddress(destAddress, CHAINS[to]?.isSolana) && (
                        <div className="text-[11px] mt-1.5" style={{ color: "#D92D20" }}>
                          Invalid {CHAINS[to].name} address
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}

              {/* CTA */}
              <button
                disabled={!connected || !canBridge || routeUnavailable}
                onClick={() => setShowModal(true)}
                className="w-full mt-4 py-3.5 rounded-full font-display font-semibold text-[15px]"
                style={{
                  background: !connected || !canBridge || routeUnavailable ? P.ctaDisabledBg : P.ctaBg,
                  color: !connected || !canBridge || routeUnavailable ? P.ctaDisabledText : P.ctaText,
                  cursor: connected && canBridge && !routeUnavailable ? "pointer" : "not-allowed",
                }}
              >
                {!connected ? "Connect wallet" : onWrongNetwork ? "Switch network to continue" : !chainAssetPairValid ? (isSwapTab ? "Choose different assets" : "Choose different chains") : amtNum <= 0 ? "Enter an amount" : insufficient ? "Insufficient balance" : needsEvmAddressForSolanaSource ? "Connect an EVM wallet to receive on this chain" : needsSolanaAddressForSolanaDest ? "Connect a Solana wallet to receive on this chain" : sendToOther && !destAddress.trim() ? "Enter destination address" : sendToOther && !isValidDestinationAddress(destAddress, CHAINS[to]?.isSolana) ? `Invalid ${CHAINS[to].name} address` : routeUnavailable ? "No route available for this trade" : routeChecking ? "Checking route…" : ["op-withdraw", "arb-withdraw"].includes(kind) ? "Start withdrawal" : isCrossAsset ? "Swap assets" : "Bridge assets"}
              </button>
              {routeUnavailable && (
                <div className="text-center mt-2 text-[11.5px]" style={{ color: "#D92D20" }}>
                  No available route for this trade right now — {fromAsset.symbol} on {CHAINS[from].name} to {toAsset.symbol} on {CHAINS[to].name} isn't supported yet.
                  {routeCheck.message && (
                    <div className="mt-1 opacity-70 font-mono text-[10px]">{routeCheck.message}</div>
                  )}
                </div>
              )}

              <div className="text-center mt-4 text-[11.5px]" style={{ color: P.textMuted }}>
                Powered by Relay Protocol. Only verified routes are enabled. Estimated arrival time and fees are shown before you confirm.
              </div>
            </>
          )}
          <DownloadApkRow P={P} />
          <SocialLinksRow P={P} />
        </div>
      </div>

      {/* Bottom nav */}
      <div className="fixed bottom-0 left-0 right-0 flex justify-center px-4 pb-4 pt-2 z-40" style={{ background: `linear-gradient(to top, ${P.bg} 60%, transparent)` }}>
        <div className="flex items-center gap-0.5 p-1.5 rounded-full shadow-lg overflow-x-auto max-w-full" style={{ background: P.panel, border: `1px solid ${P.panelBorder}` }}>
          {[
            { id: "bridge", label: "Bridge", icon: ArrowUpDown },
            { id: "swap", label: "Swap", icon: Repeat },
            { id: "launchpad", label: "Launch", icon: Rocket },
            { id: "wallet", label: "Wallet", icon: Wallet },
            { id: "history", label: "History", icon: HistoryIcon },
            { id: "portfolio", label: "Portfolio", icon: Briefcase },
          ].map((n) => {
            const Icon = n.icon;
            const active = tab === n.id;
            return (
              <button
                key={n.id}
                onClick={() => setTab(n.id)}
                className="flex items-center gap-1 px-2.5 py-2.5 rounded-full text-[11.5px] font-medium whitespace-nowrap shrink-0"
                style={{ background: active ? P.navActive : "transparent", color: active ? P.navActiveText : P.textSecondary }}
              >
                <Icon size={14} /> {n.label}
              </button>
            );
          })}
        </div>
      </div>

      {showModal && (
        <BridgeModal
          from={from} to={to} amount={amount} asset={fromAsset.symbol} toAsset={toAsset.symbol} fromCustom={fromCustomToken} toCustom={toCustomToken} fee={fee} etaLabel={etaLabel} received={received} receivedRoundsToZero={receivedRoundsToZero}
          devFeeAmount={devFeeAmount}
          // Real, verified USD estimate of what's being sent — only for
          // a built-in asset with a real price (fromAsset.price > 0;
          // 0 is this file's own cosmetic-only sentinel for a custom
          // token, see fromAsset's own comment). Lets getRelayQuote's
          // appFeeBps (devFeeWallets.js) apply the $50 fee cap on a
          // real large transfer; omitted entirely for an unpriced
          // custom token, same "never fabricate a number" rule this
          // file already follows elsewhere for custom-token pricing.
          originAmountUsd={fromAsset.price > 0 ? amtNum * fromAsset.price : undefined}
          // isSwapTab-gated even though the "Send to another address"
          // section itself is already hidden on the swap tab: sendToOther/
          // destAddress are shared state with the Bridge tab, so a user
          // who checked it there and then switched to Swap without
          // unchecking it must not have a stale destination silently
          // carried into a swap that's supposed to always land back in
          // their own wallet.
          destination={!isSwapTab && sendToOther ? destAddress : null}
          account={activeAccount}
          evmAddress={address}
          isFromSolana={isFromSolana}
          solanaWallet={effectiveSolanaWallet}
          onClose={() => setShowModal(false)}
          onComplete={handleComplete}
          onWithdrawalInitiated={handleWithdrawalInitiated}
          onPendingHash={handlePendingHash}
        />
      )}
      {showDocs && <DocsModal onClose={() => setShowDocs(false)} P={P} />}
      {showAdminReferrals && <AdminReferralsPage onClose={() => setShowAdminReferrals(false)} />}
      {showWalletSelector && <WalletSelectorModal onClose={() => setShowWalletSelector(false)} P={P} solanaRelevant={isFromSolana || !!CHAINS[to]?.isSolana} />}
      {showNetworkSelector && (
        <NetworkSelectorModal
          onClose={() => setShowNetworkSelector(false)}
          P={P}
          tab={tab}
          launchpadNetwork={launchpadNetwork}
          setLaunchpadNetwork={setLaunchpadNetwork}
        />
      )}
    </div>
  );
}
