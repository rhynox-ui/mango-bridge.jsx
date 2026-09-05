// src/SwapChartPanel.jsx
//
// The Swap tab's chart panel — DexScreener's own embedded chart, plus a
// Holders button above it (the one control here that isn't already
// somewhere in the embed's own UI).
//
// PORTED from mango-mobile's Swap screen (src/components/DexScreenerChart.tsx
// plus the chart-side state in src/wallet/DexScreen.tsx), reusing the
// same data modules rather than re-deriving anything: dexScreenerChart.js
// for pair resolution and the embed URL, goplusTokenSecurity.js for
// holders. Both came across from mobile unchanged, so the two apps show
// the same numbers from the same sources.
//
// What differs from mobile, and only because the platform differs: the
// embed goes in an <iframe> instead of a react-native-webview, and the
// holders list is a plain overlay panel instead of a bottom sheet.
//
// This used to also carry its own interval-pill row and absolutely
// positioned MC/Vol/Holders chips over the embed — removed, same fix as
// mobile's: DexScreener's own embedded page already shows its own
// timeframe selector and its own volume/price header, so those were
// pure duplicates, and worse, visually collided with DexScreener's real
// controls once the canvas underneath became a real page with its own
// header rather than blank space. See the render below for what's left.

import { useEffect, useMemo, useState } from "react";
import { resolveDexScreenerPair, dexScreenerEmbedUrl } from "./dexScreenerChart.js";
import { checkTokenSecurity, checkSolanaTokenSecurity } from "./goplusTokenSecurity.js";
import { MAINNET_CHAIN_IDS } from "./chainData.js";

const CHART_BG = "#0B0B0D";
const CHART_AXIS_TEXT = "#7A7A80";
// DexScreener's own embedded page picks its own timeframe now (see the
// removed interval-pill row below) — this only sets which window it
// opens on.
const DEFAULT_INTERVAL = "1H";

function fmtCompact(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
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
  const [pair, setPair] = useState(null);
  const [resolving, setResolving] = useState(true);
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

  const embedUrl = pair ? dexScreenerEmbedUrl({ ...pair, intervalLabel: DEFAULT_INTERVAL }) : null;
  const holders = security?.holders ?? null;
  const holderCount = security?.holderCount ?? null;
  const hasHolders = (holders?.length ?? 0) > 0;

  return (
    <div className="mb-3">
      {/* The interval-pill row and the Vol/MC chips this used to render
          here are gone — DexScreener's own embedded page already shows
          its own timeframe selector and its own volume/price header
          (visible inside the iframe itself), so this app's copies were
          pure duplicates. Worse than redundant: absolutely positioned on
          top of an iframe whose own header now occupies that same top
          strip, they visually collided with DexScreener's real controls
          instead of floating over blank canvas the way they did before
          this became an embed. Holders is the one real, otherwise-
          unreachable feature that lived in that overlay (opens the
          holders panel below, which nothing else here can reach) — moved
          to a plain row above the chart instead of an overlapping chip.
          Same fix as mobile's Swap chart (src/components/DexScreenerChart.tsx). */}
      {(holderCount != null || hasHolders) && (
        <div className="flex justify-end mb-2">
          <button
            onClick={() => setHoldersOpen(true)}
            className="rounded-full px-2.5 py-1 text-[10.5px] font-bold"
            style={{ background: P.pillBg, color: P.textPrimary }}
          >
            {holderCount != null ? `Holders ${fmtCompact(holderCount)}` : "Top holders"} ▾
          </button>
        </div>
      )}

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
          // Keyed on the full URL so a pair/interval change actually
          // reloads the embed rather than leaving the chart on whatever
          // loaded first.
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
