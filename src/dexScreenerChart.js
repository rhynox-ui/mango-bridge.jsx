// src/dexScreenerChart.js
//
// Resolves a token to the DexScreener pair page that can be embedded as
// the Swap tab's chart, and builds that embed URL.
//
// PORTED VERBATIM from mango-mobile's own src/wallet/dexScreenerChart.js
// — same slug map, same pair resolution, same embed flags. It ports with
// no edits because both apps key chains the same way (CHAIN_ORDER here
// and mobile's own chain keys are the identical list), so the only
// change is this comment and the file path.
//
// Why DexScreener rather than this app's own SVG chart: the custom
// chart is drawn from GeckoTerminal's free, unauthenticated OHLCV tier,
// which rate-limits hard enough that "GeckoTerminal OHLCV request
// failed (429)" was a routine on-device sight — a blank chart on a
// screen whose entire point is the chart. DexScreener serves the chart
// as a rendered page instead of raw candles, so the embed is not
// competing for the same quota, and it brings its own crosshair,
// timeframe handling and pair labelling for free.
//
// Deliberate design point, because it decides what a WRONG chain slug
// does. The embed URL needs DexScreener's own chain slug AND a real
// pair address, and this app cannot invent either. So the pair is
// looked up live through DexScreener's own token endpoint, and only
// pairs whose reported chainId EXACTLY matches the slug we asked for
// are eligible. That means an unverified or wrong slug yields no
// matches and the chart shows a clean "not indexed" message — it can
// never quietly render some other chain's pair for the token. A wrong
// slug is a cosmetic failure here, never a wrong-price one.
//
// Pair choice is by real USD liquidity, highest first. A token often
// has many pairs (different quote assets, different DEXes, stale
// dust pools); the deepest one is the chart a trader means, and it's
// the same ranking DexScreener's own token page leads with.

// DexScreener chain slugs, as they appear both in dexscreener.com URLs
// and as the `chainId` field of its API responses.
//
// "robinhood" is the one carried over from existing verified use rather
// than general knowledge: TokenDetailScreen.tsx already links Launchpad
// tokens to dexscreener.com/robinhood/<address>, ported from the site's
// own DexScreenerChart, with a comment recording that DexScreener
// genuinely indexes this launchpad's Robinhood Chain deployment under
// that slug.
//
// Anything not listed resolves to null and the caller shows the chart's
// own unavailable state, rather than guessing a slug from the chain
// name — see this file's own header on why a guess is contained but
// still not worth making.
const DEXSCREENER_CHAIN_IDS = {
  ethereum: 'ethereum',
  base: 'base',
  bnb: 'bsc',
  solana: 'solana',
  arbitrum: 'arbitrum',
  avalanche: 'avalanche',
  robinhood: 'robinhood',
  abstract: 'abstract',
  hyperevm: 'hyperevm',
  ink: 'ink',
  plasma: 'plasma',
  unichain: 'unichain',
  xlayer: 'xlayer',
};

export function dexScreenerChainForChain(chainKey) {
  return DEXSCREENER_CHAIN_IDS[chainKey] ?? null;
}

/**
 * Finds the deepest real DexScreener pair for a token on one chain.
 * Resolves to null — never throws — for every "no chart here" case:
 * an unmapped chain, a network failure, a token DexScreener has never
 * indexed, or a token indexed only on other chains. The caller renders
 * one unavailable state for all of them.
 */
export async function resolveDexScreenerPair({chainKey, tokenAddress}) {
  const chainId = dexScreenerChainForChain(chainKey);
  if (!chainId || !tokenAddress) return null;
  try {
    const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(tokenAddress)}`);
    if (!response.ok) return null;
    const body = await response.json();
    const pairs = Array.isArray(body?.pairs) ? body.pairs : [];
    let best = null;
    let bestLiquidity = -1;
    for (const pair of pairs) {
      // Exact chain match only — see this file's own header. A token
      // address can legitimately exist on several chains (and often
      // does, for bridged assets), so "first pair returned" would be a
      // real chance of charting the wrong network.
      if (pair?.chainId !== chainId) continue;
      if (typeof pair?.pairAddress !== 'string' || !pair.pairAddress) continue;
      const liquidity = Number(pair?.liquidity?.usd);
      const ranked = Number.isFinite(liquidity) ? liquidity : 0;
      if (ranked > bestLiquidity) {
        bestLiquidity = ranked;
        best = pair.pairAddress;
      }
    }
    return best ? {chainId, pairAddress: best} : null;
  } catch {
    return null;
  }
}

// DexScreener's embed reads the timeframe off the `interval` query
// param, in minutes, with day expressed as "1D". Keyed off this app's
// own CANDLE_INTERVALS labels (geckoTerminal.js) so the same four
// pills keep driving the chart and nothing about that row changes.
const EMBED_INTERVAL_BY_LABEL = {
  '15m': '15',
  '1H': '60',
  '4H': '240',
  '1D': '1D',
};

/**
 * Builds the embeddable chart URL.
 *
 * Every flag here is switching OFF a piece of DexScreener's full page
 * that has no business inside a chart panel this size: its trades feed,
 * its pair info panel, its tab bar and its chart-left toolbar. What's
 * left is the chart itself. `theme=dark` matches the panel's own
 * CHART_BG rather than flashing a white page into a dark screen.
 */
export function dexScreenerEmbedUrl({chainId, pairAddress, intervalLabel}) {
  const interval = EMBED_INTERVAL_BY_LABEL[intervalLabel] ?? '60';
  const params = [
    'embed=1',
    'theme=dark',
    'chartTheme=dark',
    'trades=0',
    'info=0',
    'tabs=0',
    'chartLeftToolbar=0',
    'loadChartSettings=0',
    'chartDefaultOnMobile=1',
    'chartType=usd',
    `interval=${interval}`,
  ].join('&');
  return `https://dexscreener.com/${chainId}/${pairAddress}?${params}`;
}
