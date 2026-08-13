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
  ethereum: "ETH", base: "ETH", bnb: "BNB", robinhood: "ETH", solana: "SOL",
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
  solana: "11111111111111111111111111111111",
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
};
