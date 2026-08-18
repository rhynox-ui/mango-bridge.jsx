// src/wallet/walletPrices.js
//
// Real USD price display for Mango Wallet balances — CoinGecko's free,
// no-API-key public endpoint (/simple/price), one request covering every
// asset this wallet knows a confident id for.
//
// Deliberately conservative: only maps a symbol to a CoinGecko coin id
// when that id is long-established and unambiguous (ETH, SOL, BNB, AVAX,
// WBTC, USDC, USDT, POL, OKB). Several of this wallet's newer chains'
// native tokens — Monad's MON, Berachain's BERA, Sei, Sonic's S, Mantle's
// MNT, Gnosis's XDAI, and the newer stablecoins USDT0/USDG — either don't
// have a confidently-verified id from this project's research, or
// couldn't be confirmed live (CoinGecko's own API is blocked from this
// sandbox, confirmed via a direct curl returning 403 at the proxy — same
// block every RPC/price endpoint tried this session has hit). Rather than
// guess an id and silently show a wrong dollar amount against someone's
// real balance, those assets simply show no price: a real, visible gap,
// not a guess dressed up as data.
export const SYMBOL_TO_COINGECKO_ID = {
  ETH: "ethereum",
  SOL: "solana",
  BNB: "binancecoin",
  AVAX: "avalanche-2",
  WBTC: "wrapped-bitcoin",
  USDC: "usd-coin",
  USDT: "tether",
  POL: "polygon-ecosystem-token",
  OKB: "okb",
};

const PRICE_CACHE_TTL_MS = 60_000;
let cachedPrices = null;
let cachedAt = 0;
let inFlight = null; // dedupes concurrent callers (many balance rows mount at once) into one real request

export async function fetchWalletPrices() {
  if (cachedPrices && Date.now() - cachedAt < PRICE_CACHE_TTL_MS) return cachedPrices;
  if (inFlight) return inFlight;

  const ids = [...new Set(Object.values(SYMBOL_TO_COINGECKO_ID))];
  inFlight = fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(",")}&vs_currencies=usd`)
    .then((res) => {
      if (!res.ok) throw new Error(`CoinGecko price fetch failed: ${res.status}`);
      return res.json();
    })
    .then((data) => {
      const bySymbol = {};
      for (const [symbol, id] of Object.entries(SYMBOL_TO_COINGECKO_ID)) {
        if (typeof data[id]?.usd === "number") bySymbol[symbol] = data[id].usd;
      }
      cachedPrices = bySymbol;
      cachedAt = Date.now();
      return bySymbol;
    })
    .finally(() => { inFlight = null; });

  return inFlight;
}
