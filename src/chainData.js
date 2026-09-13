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
  solana: 792703809,
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
  stable: "USDT0",
  solana: "SOL",
  arbitrum: "ETH", avalanche: "AVAX", abstract: "ETH", hyperevm: "HYPE",
  ink: "ETH", plasma: "XPL", unichain: "ETH", xlayer: "OKB",
};

export const TOKEN_ADDRESSES = {
  USDC: {
    ethereum: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    avalanche: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
    arbitrum: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    unichain: "0x078D782b760474a361dDA0AF3839290b0EF57AD6",
    solana: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    bnb: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
    hyperevm: "0xb88339cb7199b77e23db6e890353e22632ba630f",
    ink: "0x2d270e6886d130d724215a266106e6832161eaed",
    abstract: "0x84A71ccD554Cc1b02749b35d22F684CC8ec987e1",
  },
  USDT: {
    ethereum: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    bnb: "0x55d398326f99059fF775485246999027B3197955",
    base: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2",
    arbitrum: "0xFd086bc7CD5C481DCC9C85ebE478A1C0b69FCbb9",
    solana: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  },
  WBTC: {
    ethereum: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
    base: "0x0555E30da8f98308EdB960aa94C0Db47230d2B9c",
  },
  USDT0: {
    stable: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736",
    plasma: "0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb",
    hyperevm: "0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb",
    ink: "0x0200c29006150606b650577bbe7b6248f58470c1",
  },
  USDG: {
    ethereum: "0xe343167631d89b6ffc58b88d6b7fb0228795491d",
    robinhood: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
  },
};

// Relay's Solana API uses the real native-SOL identifier here, not the
// WSOL mint. Relay's official Solana guide lists native SOL as
// 11111111111111111111111111111111 and WSOL separately as
// So11111111111111111111111111111111111111112. Keeping these distinct is
// critical: WSOL is an SPL token account balance; SOL is native lamports.
const NATIVE_PLACEHOLDER_BY_CHAIN = {
  ethereum: NATIVE_TOKEN_ADDRESS,
  base: NATIVE_TOKEN_ADDRESS,
  bnb: NATIVE_TOKEN_ADDRESS,
  robinhood: NATIVE_TOKEN_ADDRESS,
  stable: NATIVE_TOKEN_ADDRESS,
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

const ASSET_ONCHAIN_DECIMALS_BY_CHAIN = {
  bnb: { USDT: 18, USDC: 18 },
  plasma: { USDT0: 6 },
  hyperevm: { USDT0: 6 },
  ink: { USDT0: 6 },
};

export function assetDecimalsForChain(chainKey, assetSymbol) {
  return ASSET_ONCHAIN_DECIMALS_BY_CHAIN[chainKey]?.[assetSymbol] ?? ASSET_ONCHAIN_DECIMALS[assetSymbol];
}
