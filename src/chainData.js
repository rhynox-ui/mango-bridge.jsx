// src/chainData.js
//
// Pure, platform-agnostic chain and currency data — extracted from
// relaybridge.js specifically so this can be safely imported by
// serverless API functions (api/v1/*), which run in Node.js and can't
// safely import wagmi/actions (that expects a browser-connected wallet
// client). relaybridge.js re-exports from here, so the frontend keeps
// working exactly as before — this is a single source of truth, not a
// duplicate copy that could drift out of sync.

const NATIVE_TOKEN_ADDRESS = "0x0000000000000000000000000000000000000000";

export const MAINNET_CHAIN_IDS = {
  ethereum: 1,
  base: 8453,
  bnb: 56,
  robinhood: 4663,
  stable: 988,
  // Confirmed directly from Relay's own SDK documentation — Relay's own
  // internal identifier for Solana, not a real Solana concept.
  solana: 792703809,
  // Native-asset-only additions, all chain ids cross-verified against
  // wagmi/chains' own maintained definitions (see src/wagmi.js). No token
  // contract addresses are verified for these yet, so only native-asset
  // transfers are supported — see NATIVE_PLACEHOLDER_BY_CHAIN below.
  arbitrum: 42161,
  avalanche: 43114,
  abstract: 2741,
  hyperevm: 999,
  ink: 57073,
  plasma: 9745,
  unichain: 130,
  xlayer: 196,
};

export const NATIVE_SYMBOL = {
  ethereum: "ETH", base: "ETH", bnb: "BNB", robinhood: "ETH",
  // StableChain's own gas token is USDT0, not ETH/a typical native coin
  // — confirmed against StableChain's own docs (it uses Tether as its
  // universal gas asset). Already correctly reflected in App.jsx's own
  // local NATIVE_SYMBOL_BY_CHAIN; this export (chainData.js's shared
  // source of truth, re-exported by relaybridge.js and used directly by
  // api/v1/bridge/chains.js and currencyAddress() below) was missing
  // it — a real gap: currencyAddress("stable", "USDT0") fell through to
  // the ERC-20 TOKEN_ADDRESSES branch instead of the native-placeholder
  // one below, meaning every real Relay quote for StableChain's own
  // native asset sent its ERC-20 contract address instead of the
  // universal native placeholder Relay actually expects for a native
  // spend/receive.
  stable: "USDT0",
  solana: "SOL",
  arbitrum: "ETH", avalanche: "AVAX", abstract: "ETH", hyperevm: "HYPE",
  ink: "ETH", plasma: "XPL", unichain: "ETH", xlayer: "OKB",
};

// Verified mainnet contract addresses only — deliberately incomplete
// where a combination hasn't been independently confirmed. See
// relaybridge.js's own history for the verification sources behind each
// entry; not repeated here to avoid the comments drifting out of sync
// with the real source of truth.
export const TOKEN_ADDRESSES = {
  USDC: {
    ethereum: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    // Same source/verification as cctp.js's CCTP_CHAINS_MAINNET entries for
    // these three chains — native USDC, not a bridged USDC.e variant.
    avalanche: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
    arbitrum: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    unichain: "0x078D782b760474a361dDA0AF3839290b0EF57AD6",
    // Real, verified USDC mint — cross-checked against two independent
    // authoritative sources: Solana Labs' own token-list repo
    // (solana-labs/token-list, fetched live) and Coinbase's official
    // CDP SDK (@coinbase/cdp-sdk's own USDC_MAINNET_MINT_ADDRESS
    // constant, already installed locally). Previously missing
    // entirely, which is why a same-chain Solana swap into/out of USDC
    // always failed with "not safe to guess one" — a real gap, not a
    // deliberate omission.
    solana: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  },
  USDT: {
    ethereum: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    bnb: "0x55d398326f99059fF775485246999027B3197955",
    base: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2",
  },
  WBTC: {
    ethereum: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
    base: "0x0555E30da8f98308EdB960aa94C0Db47230d2B9c",
  },
  USDT0: {
    stable: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736",
  },
  USDG: {
    ethereum: "0xe343167631d89b6ffc58b88d6b7fb0228795491d",
    robinhood: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
  },
};

const NATIVE_PLACEHOLDER_BY_CHAIN = {
  ethereum: NATIVE_TOKEN_ADDRESS,
  base: NATIVE_TOKEN_ADDRESS,
  bnb: NATIVE_TOKEN_ADDRESS,
  robinhood: NATIVE_TOKEN_ADDRESS,
  stable: NATIVE_TOKEN_ADDRESS,
  // Real bug fix: this was the System Program's own address
  // (11111111111111111111111111111111), which represents "no program/
  // no token" on Solana, not "native SOL" — using it as a currency
  // identifier in a cross-chain quote request is exactly the kind of
  // mistake that produces a confusing rejection instead of a working
  // quote. The actual, universal convention for representing native
  // SOL in DeFi routing is the Wrapped SOL mint — confirmed two ways:
  // Solana's own official token-list repo (solana-labs/token-list,
  // fetched live) labels this exact address "SOL"/"Wrapped SOL", and
  // it's @solana/spl-token's own NATIVE_MINT constant (already
  // installed locally — fully offline confirmation).
  solana: "So11111111111111111111111111111111111111112",
  arbitrum: NATIVE_TOKEN_ADDRESS,
  avalanche: NATIVE_TOKEN_ADDRESS,
  abstract: NATIVE_TOKEN_ADDRESS,
  hyperevm: NATIVE_TOKEN_ADDRESS,
  ink: NATIVE_TOKEN_ADDRESS,
  plasma: NATIVE_TOKEN_ADDRESS,
  unichain: NATIVE_TOKEN_ADDRESS,
  xlayer: NATIVE_TOKEN_ADDRESS,
};

export function currencyAddress(chainKey, assetSymbol) {
  if (assetSymbol === NATIVE_SYMBOL[chainKey]) return NATIVE_PLACEHOLDER_BY_CHAIN[chainKey] || NATIVE_TOKEN_ADDRESS;
  const addr = TOKEN_ADDRESSES[assetSymbol]?.[chainKey];
  if (!addr) throw new Error(`No verified mainnet contract address for ${assetSymbol} on ${chainKey} — not safe to guess one.`);
  return addr;
}

export function canRelayHandle(fromChainKey, toChainKey, fromAsset, toAsset) {
  try {
    currencyAddress(fromChainKey, fromAsset);
    currencyAddress(toChainKey, toAsset);
    return true;
  } catch {
    return false;
  }
}

export const ASSET_ONCHAIN_DECIMALS = {
  ETH: 18,
  BNB: 18,
  USDC: 6,
  USDT: 6,
  USDG: 6,
  WBTC: 8,
  USDT0: 18,
  SOL: 9,
  AVAX: 18,
  HYPE: 18,
  XPL: 18,
  OKB: 18,
  // Native assets for App.jsx's wallet-only Bridge chains (walletChains.js)
  // — 18 decimals for every one is an EVM protocol invariant (msg.value is
  // always denominated in wei on every EVM-compatible chain without
  // exception), not a per-chain fact needing independent verification the
  // way an ERC-20's decimals do. Same reasoning evmChainsExtra.js's own
  // header already documents on mango-mobile for the identical case.
  POL: 18,
  XDAI: 18,
  MON: 18,
  S: 18,
  MNT: 18,
  BERA: 18,
  SEI: 18,
  CELO: 18,
  FTM: 18,
  GLMR: 18,
  CRO: 18,
  METIS: 18,
  FRAX: 18,
};

// Real, verified exception to the global-by-symbol map above: BNB
// Chain's own USDT deployment (0x55d398326f99059fF775485246999027B3197955,
// the same address TOKEN_ADDRESSES.USDT.bnb already points at) uses 18
// decimals, not the 6 every other verified USDT deployment here uses —
// confirmed independently against BscScan, QuickNode, Uniswap, and
// Binplorer's own token pages for that exact contract. A symbol-only
// decimals lookup would silently apply the wrong precision to any
// BNB-USDT amount (balance display, a quote's amount math, a swap's
// actual on-chain value) — every call site that resolves decimals for
// a *token* symbol (not a chain's own native asset) must go through
// assetDecimalsForChain(chainKey, symbol) below, never index
// ASSET_ONCHAIN_DECIMALS directly by symbol alone.
const ASSET_ONCHAIN_DECIMALS_BY_CHAIN = {
  bnb: { USDT: 18 },
};

export function assetDecimalsForChain(chainKey, assetSymbol) {
  return ASSET_ONCHAIN_DECIMALS_BY_CHAIN[chainKey]?.[assetSymbol] ?? ASSET_ONCHAIN_DECIMALS[assetSymbol];
}
