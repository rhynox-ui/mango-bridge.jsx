// src/SwapChartPanel.jsx
//
// The Swap tab's chart panel — DexScreener's embedded chart with the
// interval pills above it and live MC / Volume / Holders chips over it.
//
// PORTED from mango-mobile's Swap screen (src/components/DexScreenerChart.tsx
// plus the chart-side state in src/wallet/DexScreen.tsx), reusing the
// same data modules rather than re-deriving anything: dexScreenerChart.js
// for pair resolution and the embed URL, geckoTerminal.js for the stats,
// goplusTokenSecurity.js for holders. Those three came across from
// mobile unchanged, so the two apps show the same numbers from the same
// sources.
//
// What differs from mobile, and only because the platform differs: the
// embed goes in an <iframe> instead of a react-native-webview, and the
// holders list is a plain overlay panel instead of a bottom sheet.
// Everything about WHICH token is charted, which pair is picked, and
// what is shown when data is missing is identical.

import { useEffect, useMemo, useState } from "react";
import { resolveDexScreenerPair, dexScreenerEmbedUrl } from "./dexScreenerChart.js";
import { fetchPoolMarketStats, geckoTerminalNetworkForChain } from "./geckoTerminal.js";
import { checkTokenSecurity, checkSolanaTokenSecurity } from "./goplusTokenSecurity.js";
import { MAINNET_CHAIN_IDS } from "./chainData.js";

const CHART_BG = "#0B0B0D";
const CHART_AXIS_TEXT = "#7A7A80";
const INTERVALS = ["15m", "1H", "4H", "1D"];

function fmtCompact(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
}

function fmtUsd(n) {
  return `$${fmtCompact(n)}`;
}

/**
 * Which side of the pair the chart follows.
 *
 * Not simply the "to" side, which is what mobile did until it was
 * fixed: on a buy the receive side IS the searched token, but flipping
 * to a sell made the chart jump to the native coin, which is never what
 * someone looking at a token wants and changed under them on a toggle.
 * The rule is the token being traded — whichever side isn't the chain's
 * own native asset — so both directions show the same chart.
 */
function chartedSide({ fromAsset, toAsset, nativeSymbol }) {
  const fromIsNative = fromAsset?.symbol === nativeSymbol;
  const toIsNative = toAsset?.symbol === nativeSymbol;
  if (toIsNative && !fromIsNative) return fromAsset;
  return toAsset;
}

export default function SwapChartPanel({ P, chainKey, fromAsset, toAsset, nativeSymbol, tokenAddressFor }) {
  const [interval, setInterval] = useState("1H");
  const [pair, setPair] = useState(null);
  const [resolving, setResolving] = useState(true);
  const [stats, setStats] = useState(null);
  const [security, setSecurity] = useState(null);
  const [holdersOpen, setHoldersOpen] = useState(false);

  const charted = useMemo(
    () => chartedSide({ fromAsset, toAsset, nativeSymbol }),
    [fromAsset, toAsset, nativeSymbol]
  );
  const tokenAddress = useMemo(() => tokenAddressFor(charted), [charted, tokenAddressFor]);
  const solana = chainKey === "solana";

  // Resolved per chain+token, never per interval — switching timeframe
  // only changes a query param on an already-known pair, so re-running
  // this would blank the chart on every pill click.
  useEffect(() => {
    if (!tokenAddress) {
      setPair(null);
      setResolving(false);
      return;
    }
    let cancelled = false;
    setResolving(true);
    resolveDexScreenerPair({ chainKey, tokenAddress }).then((result) => {
      if (cancelled) return;
      setPair(result);
      setResolving(false);
    });
    return () => {
      cancelled = true;
    };
  }, [chainKey, tokenAddress]);

  // Read once per pool/chain change, deliberately not polled — see
  // geckoTerminal.js's own header on the rate limit that punished
  // exactly that on mobile.
  useEffect(() => {
    if (!tokenAddress) {
      setStats(null);
      return;
    }
    const network = geckoTerminalNetworkForChain(chainKey);
    if (!network) {
      setStats(null);
      return;
    }
    let cancelled = false;
    fetchPoolMarketStats({ network, poolAddress: tokenAddress }).then((result) => {
      if (!cancelled) setStats(result);
    });
    return () => {
      cancelled = true;
    };
  }, [chainKey, tokenAddress]);

  useEffect(() => {
    if (!tokenAddress) {
      setSecurity(null);
      return;
    }
    let cancelled = false;
    const lookup = solana
      ? checkSolanaTokenSecurity(tokenAddress)
      : (() => {
          const chainId = MAINNET_CHAIN_IDS[chainKey];
          return chainId ? checkTokenSecurity(chainId, tokenAddress) : Promise.resolve(null);
        })();
    lookup.then((result) => {
      if (!cancelled) setSecurity(result);
    });
    return () => {
      cancelled = true;
    };
  }, [chainKey, tokenAddress, solana]);

  const embedUrl = pair ? dexScreenerEmbedUrl({ ...pair, intervalLabel: interval }) : null;
  const holders = security?.holders ?? null;
  const holderCount = security?.holderCount ?? null;
  const hasHolders = (holders?.length ?? 0) > 0;

  return (
    <div className="mb-3">
      <div className="flex gap-1 mb-2">
        {INTERVALS.map((label) => (
          <button
            key={label}
            onClick={() => setInterval(label)}
            className="flex-1 rounded-full py-1.5 text-[10.5px] font-bold transition-colors"
            style={{
              background: label === interval ? P.pillBg : "transparent",
              color: label === interval ? P.textPrimary : P.textMuted,
            }}
          >
            {label}
          </button>
        ))}
      </div>

      <div
        className="relative rounded-2xl overflow-hidden"
        style={{ background: CHART_BG, height: 390, border: `1px solid ${P.panelBorder}` }}
      >
        {resolving && (
          <div className="absolute inset-0 flex items-center justify-center text-[12px]" style={{ color: CHART_AXIS_TEXT }}>
            Loading chart…
          </div>
        )}
        {!resolving && !embedUrl && (
          <div className="absolute inset-0 flex items-center justify-center px-8 text-center text-[12px]" style={{ color: CHART_AXIS_TEXT }}>
            {tokenAddress
              ? "DexScreener hasn't indexed a pair for this token on this network yet."
              : "Pick a token to see its chart."}
          </div>
        )}
        {!!embedUrl && (
          // Keyed on the full URL so an interval change actually
          // reloads the embed rather than leaving the pills looking live
          // while the chart stays on whatever loaded first.
          <iframe
            key={embedUrl}
            src={embedUrl}
            title="DexScreener chart"
            className="w-full h-full"
            style={{ border: 0, background: CHART_BG }}
            // The embed is third-party content in our own chrome with no
            // address bar, so it gets no ambient authority: no scripts
            // reaching our origin, no top-level navigation, no popups.
            sandbox="allow-scripts allow-same-origin"
            referrerPolicy="no-referrer"
            loading="lazy"
          />
        )}

        {/* MC / Vol / Holders — this app's own data over the embed, in
            the same corners mobile puts them. Absolute so they cost no
            layout height. */}
        {stats?.volume24hUsd != null && (
          <div className="absolute top-2 left-2 rounded-md px-1.5 py-0.5 text-[10px] font-bold font-mono" style={{ background: "rgba(0,0,0,0.35)", color: "#C9C9CE" }}>
            <span style={{ color: CHART_AXIS_TEXT }}>Vol</span> {fmtUsd(stats.volume24hUsd)}
          </div>
        )}
        {stats?.marketCapUsd != null && (
          <div className="absolute top-2 right-2 rounded-md px-1.5 py-0.5 text-[10px] font-bold font-mono" style={{ background: "rgba(0,0,0,0.35)", color: "#C9C9CE" }}>
            <span style={{ color: CHART_AXIS_TEXT }}>MC</span> {fmtUsd(stats.marketCapUsd)}
            {stats.priceChange24hPct != null && (
              <span style={{ color: stats.priceChange24hPct >= 0 ? "#0ECB81" : "#D92D20" }}>
                {"  "}
                {stats.priceChange24hPct >= 0 ? "▲" : "▼"} {Math.abs(stats.priceChange24hPct).toFixed(2)}%
              </span>
            )}
          </div>
        )}
        {(holderCount != null || hasHolders) && (
          <button
            onClick={() => setHoldersOpen(true)}
            className="absolute right-2 rounded-md px-1.5 py-0.5 text-[10px] font-bold font-mono"
            style={{ top: 32, background: "rgba(0,0,0,0.35)", color: "#F5F5F6" }}
          >
            {/* No number on Solana, because GoPlus's Solana result has
                no holder_count field at all — showing the label without
                a figure is honest; inventing one, or hiding real holder
                data because one field is missing, are both worse. */}
            {holderCount != null ? `Holders ${fmtCompact(holderCount)} ▾` : "Top holders ▾"}
          </button>
        )}

        {holdersOpen && (
          <div className="absolute inset-0 flex flex-col" style={{ background: "rgba(0,0,0,0.92)" }}>
            <div className="flex items-center justify-between px-4 py-3 shrink-0">
              <span className="text-[13.5px] font-bold" style={{ color: "#F5F5F6" }}>
                Top {charted?.symbol ?? "token"} holders
              </span>
              <button onClick={() => setHoldersOpen(false)} className="text-[12px] font-semibold" style={{ color: CHART_AXIS_TEXT }}>
                Close
              </button>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto px-4">
              {!hasHolders ? (
                <div className="text-[12px] py-6 text-center" style={{ color: CHART_AXIS_TEXT }}>
                  No holder data available for this token right now.
                </div>
              ) : (
                holders.map((h, i) => (
                  <div key={h.address} className="flex items-center justify-between py-2">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span className="text-[11.5px] font-bold w-6 shrink-0" style={{ color: CHART_AXIS_TEXT }}>#{i + 1}</span>
                      <div className="min-w-0">
                        <div className="text-[12.5px] truncate" style={{ color: "#F5F5F6" }}>
                          {h.tag ?? `${h.address.slice(0, 6)}…${h.address.slice(-4)}`}
                        </div>
                        {(h.isLocked || h.isContract) && (
                          <div className="text-[10.5px]" style={{ color: CHART_AXIS_TEXT }}>
                            {[h.isLocked && "Locked", h.isContract && "Contract"].filter(Boolean).join(" · ")}
                          </div>
                        )}
                      </div>
                    </div>
                    <span className="text-[12.5px] font-mono shrink-0" style={{ color: "#F5F5F6" }}>
                      {h.percent != null ? `${h.percent.toFixed(2)}%` : "—"}
                    </span>
                  </div>
                ))
              )}
            </div>
            {/* Solana's wording is a real distinction, not pedantry:
                GoPlus identifies Solana holders by TOKEN ACCOUNT and
                carries no owner field, so these are not wallet
                addresses. */}
            <div className="text-[10px] text-center px-4 py-3 shrink-0" style={{ color: CHART_AXIS_TEXT }}>
              Top 10 {solana ? "token accounts" : "holders"} only, via GoPlus Security — not the full holder list.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
