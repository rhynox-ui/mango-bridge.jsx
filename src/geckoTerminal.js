// src/geckoTerminal.js
//
// Live market stats for the Swap tab's chart panel — market cap, 24h
// volume, 24h change.
//
// PORTED from mango-mobile's own src/wallet/geckoTerminal.js and
// geckoTerminalNetworks.js, narrowed to just what the site needs. The
// mobile file also carries OHLCV candle fetching and a trades feed;
// neither is ported, because the chart here is DexScreener's embed
// (see dexScreenerChart.js) rather than candles drawn from raw data.
// What's left is the pool lookup and the stats read.
//
// Deliberately NOT polled. Mobile learned this the expensive way: it
// refetched candles from this same free, unauthenticated tier every 25
// seconds from a screen people sit on, and a 429 in place of the chart
// became routine. These stats are read once per pool/chain change.

const BASE_URL = "https://api.geckoterminal.com/api/v2";

// GeckoTerminal network IDs are not the same strings as Mango's chain
// keys, and are not derivable from a chain id or a display name.
// Verified against GeckoTerminal's own network pages/API ids — same
// table mango-mobile's geckoTerminalNetworks.js carries, and the chain
// keys are identical between the two apps so it ports unchanged.
const NETWORK_IDS = {
  ethereum: "eth",
  base: "base",
  bnb: "bsc",
  robinhood: "robinhood",
  solana: "solana",
  arbitrum: "arbitrum",
  avalanche: "avax",
  abstract: "abstract",
  hyperevm: "hyperevm",
  ink: "ink",
  plasma: "plasma",
  unichain: "unichain",
  xlayer: "x-layer",
};

export function geckoTerminalNetworkForChain(chainKey) {
  return NETWORK_IDS[chainKey] ?? null;
}

// This tier rate-limits aggressively — live-confirmed on mobile with a
// real "OHLCV request failed (429)". A 429 is transient, unlike a
// 400/404 wrong-address case, so one retry after a pause is worth it;
// a second in a row means something is genuinely throttled and
// hammering a free public API further isn't.
async function fetchWithRetry(url) {
  const res = await fetch(url);
  if (res.status !== 429) return res;
  await new Promise((resolve) => setTimeout(resolve, 1500));
  return fetch(url);
}

/**
 * Resolves a TOKEN address to its best indexed pool. GeckoTerminal ranks
 * this endpoint's results by liquidity and trading activity, so the
 * first result is taken rather than a pool being guessed.
 */
async function resolveTokenPool({ network, tokenAddress }) {
  const res = await fetchWithRetry(`${BASE_URL}/networks/${network}/tokens/${tokenAddress}/pools`);
  if (!res.ok) return null;
  const json = await res.json();
  const first = json?.data?.[0]?.attributes?.address;
  return typeof first === "string" && first ? first : null;
}

/**
 * Market cap / 24h volume / 24h change for a token or pool address.
 *
 * Takes either: the address is tried as a pool first, and only if that
 * 400/404s is it resolved as a token. That ordering keeps a genuine
 * pool-address caller at one request, which is the same fallback shape
 * the mobile version documents.
 *
 * Returns null for every failure — unmapped chain, network error,
 * non-200, unparseable body — never partial or invented figures.
 */
export async function fetchPoolMarketStats({ network, poolAddress }) {
  if (!network || !poolAddress) return null;
  try {
    let resolved = poolAddress;
    let res = await fetchWithRetry(`${BASE_URL}/networks/${network}/pools/${resolved}`);
    if (res.status === 400 || res.status === 404) {
      resolved = await resolveTokenPool({ network, tokenAddress: poolAddress }).catch(() => null);
      if (!resolved) return null;
      res = await fetchWithRetry(`${BASE_URL}/networks/${network}/pools/${resolved}`);
    }
    if (!res.ok) return null;
    const attrs = (await res.json())?.data?.attributes;
    if (!attrs) return null;
    const marketCapUsd = Number(attrs.market_cap_usd ?? attrs.fdv_usd);
    const volume24hUsd = Number(attrs.volume_usd?.h24);
    const priceChange24hPct = Number(attrs.price_change_percentage?.h24);
    return {
      marketCapUsd: Number.isFinite(marketCapUsd) ? marketCapUsd : null,
      volume24hUsd: Number.isFinite(volume24hUsd) ? volume24hUsd : null,
      priceChange24hPct: Number.isFinite(priceChange24hPct) ? priceChange24hPct : null,
    };
  } catch {
    return null;
  }
}
