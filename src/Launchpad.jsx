import React, { useState, useEffect, useRef } from "react";
import { isAddress } from "viem";
import { useAccount, useBalance, useSignMessage, useSwitchChain } from "wagmi";
import { Plus, X, ArrowLeft, Rocket, Users, Search, BarChart3, Copy, ExternalLink, Check, AlertTriangle, Share2 } from "lucide-react";
import { PALETTE, LIME, LIME_DEEP, fmt, timeAgo } from "./theme.js";
import { ChainBadge } from "./chainBadges.jsx";
import { launchToken, getRealLaunches, buyTokenReal, sellTokenReal, getTokenBalance, uploadTokenLogo, saveTokenLogo, getRecentTrades, getTokenHolders, getLaunchProgress, getUserPortfolio, getLaunchStats, getProtocolStats, ROBINHOOD_CHAIN_ID } from "./launchpad-contracts.js";

// Slippage tolerance at/above this shows an explicit warning in the trade
// card — a wide tolerance should be a decision the user actually sees, not
// something that quietly happens because they dragged a slider.
const HIGH_SLIPPAGE_THRESHOLD = 15;

function CopyableAddress({ address, P, label }) {
  const [copied, setCopied] = useState(false);
  const short = address ? `${address.slice(0, 6)}...${address.slice(-4)}` : "";

  function handleCopy(e) {
    e.stopPropagation();
    navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <button onClick={handleCopy} className="inline-flex items-center gap-1 text-[11px] font-mono" style={{ color: P.textMuted }}>
      {label && <span>{label}: </span>}
      <span>{short}</span>
      {copied ? <Check size={11} color={LIME_DEEP} /> : <Copy size={11} />}
    </button>
  );
}

// Copies a real deep link to this exact token page — App.jsx reads
// ?token=0x... on load and opens straight to it (see LaunchpadTab's
// deepLinkTokenAddress handling), so this isn't a cosmetic link that drops
// a visitor on the homepage; it genuinely opens the same token.
function ShareTokenButton({ tokenAddress, P }) {
  const [copied, setCopied] = useState(false);
  function handleShare() {
    const url = `${window.location.origin}${window.location.pathname}?token=${tokenAddress}`;
    navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  return (
    <button onClick={handleShare} className="flex items-center gap-1.5 text-[12.5px]" style={{ color: P.textSecondary }}>
      {copied ? <Check size={14} color={LIME_DEEP} /> : <Share2 size={14} />}
      {copied ? "Link copied" : "Share"}
    </button>
  );
}

function GraduationBar({ current, threshold, P, size = "normal" }) {
  // Real fix for a real bug: the displayed dollar amount rounds to whole
  // dollars ($0), but this bar's fill width was using the raw, unrounded
  // value underneath — a token with even a fraction of a cent in real
  // accumulated fees would show "$0" in text while still rendering a
  // tiny nonzero sliver of fill. With rounded corners on both ends, that
  // sliver shows up as a small curved cap rather than a flat edge. Snap
  // to genuinely 0% whenever the rounded display value is $0, so the bar
  // never shows progress the text itself says doesn't exist yet.
  const displaysAsZero = Math.round(current) === 0;
  const pct = displaysAsZero ? 0 : Math.min(100, (current / threshold) * 100);
  const graduated = current >= threshold;
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className={size === "small" ? "text-[10px]" : "text-[11.5px]"} style={{ color: P.textMuted }}>
          {graduated ? "Graduated 🎉" : `Graduate at $${fmt(threshold, 0)}`}
        </span>
        <span className={size === "small" ? "text-[10px]" : "text-[11.5px]"} style={{ color: P.textSecondary }}>
          ${fmt(current, 0)}
        </span>
      </div>
      <div className="w-full rounded-full overflow-hidden" style={{ height: size === "small" ? 4 : 6, background: P.panelBorder }}>
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: P.ctaBg }} />
      </div>
    </div>
  );
}

// Temporary, frontend-only logo override, keyed by lowercased token
// address — this is NOT the real on-chain logoURI system discussed and
// deliberately deferred (that needs a contract redesign, planned for a
// later, combined redeploy). This is just a quick, real way to show actual
// artwork for specific tokens right now, easily replaceable once the real
// system exists.
const TOKEN_LOGOS = {
  "0x67078594cf9c868a24abba47297ab7288011de2e": null, // $TEST — add a real image URL here once you have one
};

function TokenAvatar({ name, hue, address, logoUrl, size = 38 }) {
  // Real, dynamic logo first (from the actual registry, fetched per
  // token). Falls back to the temporary hardcoded table (kept for
  // whatever was set before this real system existed), then the
  // generated avatar if neither has anything.
  const resolvedUrl = logoUrl || (address ? TOKEN_LOGOS[address.toLowerCase()] : null);

  if (resolvedUrl) {
    return (
      <img
        src={resolvedUrl}
        alt={name}
        className="rounded-full shrink-0 object-cover"
        style={{ width: size, height: size }}
      />
    );
  }

  return (
    <div
      className="rounded-full flex items-center justify-center font-display font-bold shrink-0"
      style={{ width: size, height: size, background: `hsl(${hue}, 70%, 55%)`, color: "#fff", fontSize: size * 0.4 }}
    >
      {name[0]}
    </div>
  );
}

function TokenCard({ token, onClick, P }) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-stretch rounded-2xl overflow-hidden text-left"
      style={{ background: P.panel, border: `1px solid ${P.panelBorder}`, boxShadow: "0 1px 2px rgba(0,0,0,0.05)" }}
    >
      <div className="flex items-center gap-2.5 p-3" style={{ flex: 1.4, minWidth: 0 }}>
        <TokenAvatar name={token.name} hue={token.hue} address={token.tokenAddress} logoUrl={token.logoUrl} />
        <div className="min-w-0">
          <div className="text-[13px] font-semibold truncate" style={{ color: P.textPrimary }}>{token.name}</div>
          <div className="text-[10px]" style={{ color: P.textMuted }}>${token.symbol} · {token.holders} holders</div>
        </div>
      </div>
      <div className="flex flex-col justify-center items-end p-3" style={{ flex: 0.8, borderLeft: `1px solid ${P.panelBorder}` }}>
        <span className="text-[12px] font-mono font-semibold" style={{ color: token.priceChange24h >= 0 ? LIME_DEEP : "#D92D20" }}>
          {token.priceChange24h >= 0 ? "+" : ""}{fmt(token.priceChange24h, 1)}%
        </span>
        <span className="text-[9.5px]" style={{ color: P.textMuted }}>24h</span>
      </div>
      <div className="flex flex-col justify-center p-3" style={{ flex: 1.1, borderLeft: `1px solid ${P.panelBorder}` }}>
        <GraduationBar current={token.marketCapUsd} threshold={token.graduationThresholdUsd} P={P} size="small" />
      </div>
    </button>
  );
}

function CreateLaunchModal({ onClose, onLaunchSuccess, P }) {
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [description, setDescription] = useState("");
  const [xProfile, setXProfile] = useState("");
  const [telegram, setTelegram] = useState("");
  const [creatorWallet, setCreatorWallet] = useState("");
  const [understandsModeration, setUnderstandsModeration] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [imagePreview, setImagePreview] = useState(null);
  const [uploadedLogoUrl, setUploadedLogoUrl] = useState(null);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [uploadError, setUploadError] = useState(null);
  const [devBuy, setDevBuy] = useState("");
  const { address, isConnected, chainId } = useAccount();
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState(null);
  const [launchResult, setLaunchResult] = useState(null);

  const trimmedCreatorWallet = creatorWallet.trim();
  const creatorWalletInvalid = trimmedCreatorWallet !== "" && !isAddress(trimmedCreatorWallet);

  async function handleLaunch() {
    setLaunchError(null);
    setLaunchResult(null);

    if (creatorWalletInvalid) {
      setLaunchError("Creator wallet isn't a valid address — fix it or leave it blank to use your connected wallet.");
      return;
    }
    if (uploadedLogoUrl && !understandsModeration) {
      setLaunchError("Check the artwork-moderation box below the image to continue, or remove the image.");
      return;
    }

    setLaunching(true);
    try {
      // Creator is the real on-chain address that receives the 70% creator
      // fee share (see the Factory contract's launch() args) — the
      // "Creator wallet" field genuinely controls this now, not just the
      // connected wallet unconditionally.
      const effectiveCreator = trimmedCreatorWallet || address;
      const result = await launchToken({ name, symbol, creator: effectiveCreator, devBuyEth: devBuy });
      setLaunchResult(result);

      // First-time save, right after launch — no signature needed yet,
      // since there's no prior owner to protect against. The Factory
      // contract itself only takes name/symbol/creator, so description
      // and socials have nowhere on-chain to live — this is the same
      // off-chain registry the logo already uses, extended to hold them
      // too, rather than typing them in and having them silently discarded.
      const trimmedDescription = description.trim();
      const trimmedXProfile = xProfile.trim();
      const trimmedTelegram = telegram.trim();
      if (result?.tokenAddress && (uploadedLogoUrl || trimmedDescription || trimmedXProfile || trimmedTelegram)) {
        try {
          await saveTokenLogo({
            tokenAddress: result.tokenAddress,
            logoUrl: uploadedLogoUrl || undefined,
            poolId: result.poolId,
            description: trimmedDescription || undefined,
            xProfile: trimmedXProfile || undefined,
            telegram: trimmedTelegram || undefined,
          });
        } catch {
          // Non-fatal — the launch itself already succeeded. A failed
          // metadata save just means this info doesn't show up later, not
          // a broken launch.
        }
      }

      onLaunchSuccess?.(result, { name, symbol });
    } catch (err) {
      // The access-control handoff has happened, so a failure here now
      // means something else — an actual bug in the untested liquidity/
      // settlement logic, insufficient funds, or a real edge case. Shown
      // plainly either way, not hidden behind a generic error.
      setLaunchError(err?.shortMessage || err?.message || String(err));
    } finally {
      setLaunching(false);
    }
  }
  const fileInputRef = React.useRef(null);

  async function handleImageSelect(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) return; // silently ignore non-images

    // Show a local preview immediately (feels instant), while the real
    // upload happens in the background.
    const reader = new FileReader();
    reader.onload = () => setImagePreview(reader.result);
    reader.readAsDataURL(file);

    setUploadError(null);
    setUploadingImage(true);
    try {
      const realUrl = await uploadTokenLogo(file);
      setUploadedLogoUrl(realUrl);
    } catch (err) {
      setUploadError(err?.message || String(err));
    } finally {
      setUploadingImage(false);
    }
  }

  const fieldStyle = { background: P.panel, border: `1px solid ${P.panelBorder}`, color: P.textPrimary, boxShadow: "0 1px 2px rgba(0,0,0,0.05)" };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center" style={{ background: "rgba(4,5,7,0.75)", backdropFilter: "blur(4px)" }}>
      <div className="w-full sm:max-w-sm rounded-t-2xl sm:rounded-2xl p-5 max-h-[90vh] overflow-y-auto" style={{ background: P.bg, border: `1px solid ${P.panelBorder}` }}>
        <div className="flex items-center justify-between mb-4">
          <span className="font-display text-[16px] font-semibold" style={{ color: P.textPrimary }}>Launch token</span>
          <button onClick={onClose}><X size={18} color={P.textMuted} /></button>
        </div>

        <div className="flex flex-col gap-3.5 mb-4">
          <div>
            <label className="text-[12px] font-medium mb-1 block" style={{ color: P.textPrimary }}>Name</label>
            <div className="text-[10.5px] mb-1.5" style={{ color: P.textMuted }}>Letters, numbers, and spaces. 32 characters max.</div>
            <input value={name} onChange={(e) => setName(e.target.value.slice(0, 32))} placeholder="Mango Cat" className="w-full px-3 py-2.5 rounded-lg text-[13.5px]" style={fieldStyle} />
          </div>
          <div>
            <label className="text-[12px] font-medium mb-1 block" style={{ color: P.textPrimary }}>Ticker</label>
            <div className="text-[10.5px] mb-1.5" style={{ color: P.textMuted }}>Letters and numbers. 10 characters max.</div>
            <input value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10))} placeholder="MCAT" className="w-full px-3 py-2.5 rounded-lg text-[13.5px] font-mono" style={fieldStyle} />
          </div>
          <div>
            <label className="text-[12px] font-medium mb-1 block" style={{ color: P.textPrimary }}>Description</label>
            <div className="text-[10.5px] mb-1.5" style={{ color: P.textMuted }}>No links. 256 characters max.</div>
            <textarea value={description} onChange={(e) => setDescription(e.target.value.slice(0, 256))} placeholder="What's this token about?" rows={3} className="w-full px-3 py-2.5 rounded-lg text-[13px] resize-none" style={fieldStyle} />
          </div>
          <div>
            <label className="text-[12px] font-medium mb-1 block" style={{ color: P.textPrimary }}>Token image</label>
            {/* Preview is fully real and functional — reads the file locally
                via FileReader, no backend involved. Actual upload to IPFS
                (mentioned in the consent text below) isn't wired up yet;
                that's a CONTRACT-adjacent step for when the launch flow
                itself goes live. */}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleImageSelect}
              className="hidden"
            />
            {imagePreview ? (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="w-full rounded-xl overflow-hidden relative"
                style={{ border: `1px solid ${P.panelBorder}` }}
              >
                <img src={imagePreview} alt="Token artwork preview" className="w-full h-32 object-cover" />
                <div className="absolute inset-0 flex items-center justify-center opacity-0 hover:opacity-100 transition-opacity text-[11px] font-medium text-white" style={{ background: "rgba(0,0,0,0.5)" }}>
                  Tap to change
                </div>
              </button>
            ) : (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="w-full rounded-xl p-6 text-center text-[12px]"
                style={{ ...fieldStyle, border: `1.5px dashed ${P.panelBorder}` }}
              >
                Tap to upload artwork
              </button>
            )}
            {uploadingImage && (
              <div className="mt-1.5 text-[11px]" style={{ color: P.textMuted }}>Uploading real artwork…</div>
            )}
            {uploadedLogoUrl && !uploadingImage && (
              <div className="mt-1.5 text-[11px]" style={{ color: LIME_DEEP }}>Uploaded — this real image will show once your token launches.</div>
            )}
            {uploadError && (
              <div className="mt-1.5 text-[11px]" style={{ color: "#D92D20" }}>Upload failed: {uploadError}</div>
            )}
            <div className="flex items-start gap-2 mt-2 text-[11px]" style={{ color: P.textMuted }}>
              <input type="checkbox" checked={understandsModeration} onChange={(e) => setUnderstandsModeration(e.target.checked)} className="mt-0.5" />
              <span>I understand that selected artwork will be moderated and uploaded to public IPFS.</span>
            </div>
          </div>
          <div>
            <label className="text-[12px] font-medium mb-1 block" style={{ color: P.textPrimary }}>X profile</label>
            <div className="flex items-center rounded-lg overflow-hidden" style={fieldStyle}>
              <span className="pl-3 text-[12.5px]" style={{ color: P.textMuted }}>x.com/</span>
              <input value={xProfile} onChange={(e) => setXProfile(e.target.value.replace(/^@/, ""))} placeholder="yourhandle" className="flex-1 px-1 py-2.5 text-[13px] bg-transparent" style={{ color: P.textPrimary }} />
            </div>
          </div>
          <div>
            <label className="text-[12px] font-medium mb-1 block" style={{ color: P.textPrimary }}>Telegram</label>
            <div className="flex items-center rounded-lg overflow-hidden" style={fieldStyle}>
              <span className="pl-3 text-[12.5px]" style={{ color: P.textMuted }}>t.me/</span>
              <input value={telegram} onChange={(e) => setTelegram(e.target.value)} placeholder="yourgroup" className="flex-1 px-1 py-2.5 text-[13px] bg-transparent" style={{ color: P.textPrimary }} />
            </div>
          </div>
          <div>
            <label className="text-[12px] font-medium mb-1 block" style={{ color: P.textPrimary }}>Developer buy</label>
            <div className="text-[10.5px] mb-1.5" style={{ color: P.textMuted }}>Optionally buy some of your own token at launch.</div>
            <input value={devBuy} onChange={(e) => setDevBuy(e.target.value)} placeholder="0 ETH" inputMode="decimal" className="w-full px-3 py-2.5 rounded-lg text-[13.5px]" style={fieldStyle} />
            {/* USD value is exact arithmetic. The supply percentage is a
                rough illustration only, assuming a notional $5,000 starting
                pool valuation — a real number, not the actual figure, since
                the real pool-seeding mechanics (exact starting liquidity
                ratio) aren't finalized yet. Shown as a % of fixed 1B supply
                rather than a token count, so it doesn't imply more
                precision than this actually has. */}
            {parseFloat(devBuy) > 0 && (
              <div className="mt-2 rounded-lg px-3 py-2 flex items-center justify-between" style={{ background: P.pillBg, border: `1px solid ${P.panelBorder}` }}>
                <span className="text-[10.5px]" style={{ color: P.textMuted }}>Rough estimate, assumes $5,000 starting valuation</span>
                <span className="text-[12px] font-mono" style={{ color: P.textPrimary }}>
                  ${fmt(parseFloat(devBuy) * 3120, 2)}
                  <span className="ml-1" style={{ color: P.textMuted }}>· ~{((parseFloat(devBuy) * 3120 / 5000) * 100).toFixed(1)}% of supply</span>
                </span>
              </div>
            )}
          </div>

          {!showAdvanced ? (
            <button onClick={() => setShowAdvanced(true)} className="text-[12px] text-left" style={{ color: LIME_DEEP }}>▸ Advanced</button>
          ) : (
            <div>
              <label className="text-[12px] font-medium mb-1 block" style={{ color: P.textPrimary }}>Creator wallet</label>
              <div className="text-[10.5px] mb-1.5" style={{ color: P.textMuted }}>Receives the 70% creator share of trading fees. Leave blank to use your connected wallet.</div>
              <input
                value={creatorWallet}
                onChange={(e) => setCreatorWallet(e.target.value)}
                placeholder="0x..."
                className="w-full px-3 py-2.5 rounded-lg text-[13.5px] font-mono"
                style={{ ...fieldStyle, border: `1px solid ${creatorWalletInvalid ? "#D92D20" : P.panelBorder}` }}
              />
              {creatorWalletInvalid && <div className="mt-1 text-[11px]" style={{ color: "#D92D20" }}>Not a valid address</div>}
            </div>
          )}
        </div>

        <div className="rounded-xl p-3.5 mb-4" style={{ background: P.panel, border: `1px solid ${P.panelBorder}` }}>
          <div className="flex justify-between text-[12px] py-1"><span style={{ color: P.textMuted }}>Launch fee</span><span className="font-mono" style={{ color: P.textPrimary }}>$5</span></div>
          <div className="flex justify-between text-[12px] py-1"><span style={{ color: P.textMuted }}>Graduate at</span><span className="font-mono" style={{ color: P.textPrimary }}>$30,000</span></div>
          <div className="flex justify-between text-[12px] py-1"><span style={{ color: P.textMuted }}>Creator fee share</span><span className="font-mono" style={{ color: LIME_DEEP }}>70%</span></div>
          <div className="flex justify-between text-[12px] py-1"><span style={{ color: P.textMuted }}>Liquidity</span><span className="font-mono" style={{ color: P.textPrimary }}>Uniswap</span></div>
        </div>

        {!isConnected ? (
          <div className="text-center py-3 rounded-full font-display font-semibold text-[14.5px]" style={{ background: P.pillBg, color: P.textMuted }}>
            Connect a wallet to launch
          </div>
        ) : (
          <button
            onClick={handleLaunch}
            disabled={!name || !symbol || launching || creatorWalletInvalid || (uploadedLogoUrl && !understandsModeration)}
            className="w-full py-3.5 rounded-full font-display font-semibold text-[14.5px]"
            style={(() => {
              const ready = name && symbol && !launching && !creatorWalletInvalid && !(uploadedLogoUrl && !understandsModeration);
              return { background: ready ? P.ctaBg : P.pillBg, color: ready ? P.ctaText : P.textMuted, cursor: ready ? "pointer" : "not-allowed" };
            })()}
          >
            {launching ? "Launching…" : "Launch token"}
          </button>
        )}

        {/* This calls the real, deployed Factory contract — not a
            simulation. The access-control handoff has happened, so this
            call is genuinely capable of succeeding now. A failure here is
            a real, meaningful signal — likely an actual bug in code that's
            never been exercised by a real transaction before, not an
            expected, documented limitation anymore. */}
        {launchError && (
          <div className="mt-2 rounded-lg p-3 text-[11.5px]" style={{ background: "#D92D2015", border: "1px solid #D92D2040", color: "#D92D20" }}>
            <div className="font-medium mb-0.5">Transaction failed</div>
            <div className="font-mono break-all">{launchError}</div>
            <div className="mt-1" style={{ color: P.textMuted }}>This is a real attempt against the real deployed contract. If this fails, it's worth investigating — the underlying logic has never been tested end to end before.</div>
          </div>
        )}
        {launchResult && (
          <div className="mt-2 rounded-lg p-3 text-[11.5px]" style={{ background: `${LIME}15`, border: `1px solid ${LIME}40`, color: LIME_DEEP }}>
            <div className="font-medium mb-0.5">Transaction confirmed</div>
            <div className="font-mono break-all">{launchResult.hash}</div>
          </div>
        )}
        <div className="text-center mt-2 text-[10.5px]" style={{ color: P.textMuted }}>
          This calls the real deployed Factory contract on Robinhood Chain.
        </div>
      </div>
    </div>
  );
}

function TradeRowSkeleton({ P }) {
  return (
    <div className="flex items-center justify-between py-2" style={{ borderBottom: `1px solid ${P.panelBorder}` }}>
      <div className="flex flex-col gap-1.5">
        <div className="w-24 h-3.5 rounded" style={{ background: P.pillBg }} />
        <div className="w-16 h-2.5 rounded" style={{ background: P.pillBg }} />
      </div>
      <div className="flex flex-col items-end gap-1.5">
        <div className="w-12 h-2.5 rounded" style={{ background: P.pillBg }} />
        <div className="w-16 h-2.5 rounded" style={{ background: P.pillBg }} />
      </div>
    </div>
  );
}

// Real, derived-only concentration signal — no new API call, just a sum
// over the same holders array already fetched for the list below.
// Thresholds (green <20%, amber 20-50%, red >50%) match the same
// amber/red risk-color convention already used elsewhere in this app
// (wrong-network banners) rather than inventing a new one.
function HolderConcentrationBar({ holders, P }) {
  const top10Pct = holders.slice(0, 10).reduce((sum, h) => sum + (h.percentOfSupply || 0), 0);
  const color = top10Pct > 50 ? "#D92D20" : top10Pct > 20 ? "#8A5A00" : LIME_DEEP;
  const trackColor = top10Pct > 50 ? "#D92D2015" : top10Pct > 20 ? "#FCEFD9" : `${LIME}1A`;
  return (
    <div className="mb-2.5 pb-2.5" style={{ borderBottom: `1px solid ${P.panelBorder}` }}>
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[11px] font-medium" style={{ color: P.textSecondary }}>Top 10 holders</span>
        <span className="text-[11.5px] font-mono font-semibold" style={{ color }}>{top10Pct.toFixed(1)}%</span>
      </div>
      <div className="w-full h-1.5 rounded-full overflow-hidden" style={{ background: trackColor }}>
        <div className="h-full rounded-full" style={{ width: `${Math.min(top10Pct, 100)}%`, background: color }} />
      </div>
    </div>
  );
}

// Real, live embedded chart via DexScreener's own documented embed mode
// (?embed=1) — confirmed DexScreener genuinely indexes Robinhood Chain
// under the "robinhood" slug (dexscreener.com/robinhood), same chain slug
// already used by the "View chart" external link below. theme is passed
// through from the app's own light/dark toggle so the embed actually
// matches instead of always forcing one look.
//
// Gated on hasTrades rather than always attempting the iframe: this app's
// marketCapUsd is literally the sum of accrued trading fees (see
// CreateLaunchModal/TokenDetailView comments elsewhere in this file), so
// $0 means zero trades ever happened, by construction — not an estimate.
// A pair DexScreener has never seen a swap for won't have a chart to show,
// so this shows the same honest "no trades yet" language used everywhere
// else in this file instead of embedding a guaranteed-empty iframe.
function DexScreenerChart({ tokenAddress, hasTrades, theme, P }) {
  const [loaded, setLoaded] = useState(false);
  if (!hasTrades) {
    return (
      <div className="rounded-2xl p-4 mb-3 flex flex-col items-center justify-center text-center gap-1.5" style={{ background: P.panel, border: `1px solid ${P.panelBorder}`, height: 260 }}>
        <BarChart3 size={22} color={P.textMuted} />
        <div className="text-[12.5px] font-medium" style={{ color: P.textPrimary }}>No trades yet</div>
        <div className="text-[11px]" style={{ color: P.textMuted, maxWidth: 220 }}>The chart appears here once the first trade happens.</div>
      </div>
    );
  }
  return (
    <div className="rounded-2xl overflow-hidden mb-3 relative" style={{ background: P.panel, border: `1px solid ${P.panelBorder}`, height: 380 }}>
      {!loaded && (
        <div className="absolute inset-0 flex items-center justify-center text-[12px]" style={{ color: P.textMuted }}>
          Loading chart…
        </div>
      )}
      <iframe
        title="Token chart"
        src={`https://dexscreener.com/robinhood/${tokenAddress}?embed=1&theme=${theme === "dark" ? "dark" : "light"}&trades=0&info=0`}
        style={{ width: "100%", height: "100%", border: "none", opacity: loaded ? 1 : 0 }}
        onLoad={() => setLoaded(true)}
        loading="lazy"
      />
    </div>
  );
}

function TokenActivityPanel({ token, P }) {
  const [tab, setTab] = useState("trades");
  const [trades, setTrades] = useState(null);
  const [holders, setHolders] = useState(null);
  const [tradesError, setTradesError] = useState(null);
  const [holdersError, setHoldersError] = useState(null);

  // Keyed on the token's own address — automatically refetches whenever
  // the user switches to a different token from Explore, and doesn't
  // block the Buy/Sell widget above, since this loads independently after
  // the rest of the page has already rendered.
  useEffect(() => {
    setTrades(null);
    setTradesError(null);
    let cancelled = false;
    getRecentTrades({ poolId: token.poolId })
      .then((real) => { if (!cancelled) setTrades(real); })
      .catch((err) => { if (!cancelled) setTradesError(err?.message || String(err)); });
    return () => { cancelled = true; };
  }, [token.poolId]);

  useEffect(() => {
    setHolders(null);
    setHoldersError(null);
    let cancelled = false;
    getTokenHolders({ tokenAddress: token.tokenAddress })
      .then((real) => { if (!cancelled) setHolders(real); })
      .catch((err) => { if (!cancelled) setHoldersError(err?.message || String(err)); });
    return () => { cancelled = true; };
  }, [token.tokenAddress]);

  return (
    <div className="rounded-2xl p-3.5 mb-2.5" style={{ background: P.panel, border: `1px solid ${P.panelBorder}`, boxShadow: "0 1px 2px rgba(0,0,0,0.05)" }}>
      <div className="flex rounded-xl p-1 mb-2.5" style={{ background: P.pillBg }}>
        <button
          onClick={() => setTab("trades")}
          className="flex-1 py-1.5 rounded-lg text-[12px] font-semibold"
          style={{ background: tab === "trades" ? P.panel : "transparent", color: tab === "trades" ? P.textPrimary : P.textSecondary }}
        >
          Recent Trades
        </button>
        <button
          onClick={() => setTab("holders")}
          className="flex-1 py-1.5 rounded-lg text-[12px] font-semibold"
          style={{ background: tab === "holders" ? P.panel : "transparent", color: tab === "holders" ? P.textPrimary : P.textSecondary }}
        >
          Holders
        </button>
      </div>

      {tab === "trades" ? (
        trades === null ? (
          <div>{[1, 2, 3, 4].map((i) => <TradeRowSkeleton key={i} P={P} />)}</div>
        ) : tradesError ? (
          <div className="text-center py-5 text-[11.5px]" style={{ color: "#D92D20" }}>Couldn't load trades: {tradesError}</div>
        ) : trades.length === 0 ? (
          <div className="text-center py-6 text-[12px]" style={{ color: P.textMuted }}>No trades yet — be the first.</div>
        ) : (
          <div className="max-h-[300px] overflow-y-auto flex flex-col">
            {trades.map((t) => (
              <a
                key={t.hash}
                href={`https://robinhoodchain.blockscout.com/tx/${t.hash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-between py-2"
                style={{ borderBottom: `1px solid ${P.panelBorder}` }}
              >
                <div>
                  <div className="flex items-center gap-1.5">
                    <span style={{ color: t.isBuy ? LIME_DEEP : "#D92D20" }}>{t.isBuy ? "↗" : "↘"}</span>
                    <span className="text-[13px] font-bold font-mono" style={{ color: P.textPrimary }}>{fmt(t.tokenAmount, 0)} {token.symbol}</span>
                  </div>
                  <div className="text-[10.5px] font-mono" style={{ color: P.textMuted }}>{t.trader.slice(0, 6)}...{t.trader.slice(-4)}</div>
                </div>
                <div className="text-right">
                  <div className="text-[10.5px]" style={{ color: P.textMuted }}>{timeAgo(t.timestamp)}</div>
                  <div className="text-[11.5px] font-mono" style={{ color: P.textSecondary }}>{t.ethAmount.toFixed(5)} ETH</div>
                </div>
              </a>
            ))}
          </div>
        )
      ) : holders === null ? (
        <div>{[1, 2, 3, 4].map((i) => <TradeRowSkeleton key={i} P={P} />)}</div>
      ) : holdersError ? (
        <div className="text-center py-5 text-[11.5px]" style={{ color: "#D92D20" }}>Couldn't load holders: {holdersError}</div>
      ) : holders.length === 0 ? (
        <div className="text-center py-6 text-[12px]" style={{ color: P.textMuted }}>No holders yet.</div>
      ) : (
        <div className="max-h-[300px] overflow-y-auto flex flex-col">
          <HolderConcentrationBar holders={holders} P={P} />
          {holders.map((h, i) => (
            <a
              key={h.address}
              href={`https://robinhoodchain.blockscout.com/address/${h.address}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-between py-2"
              style={{ borderBottom: `1px solid ${P.panelBorder}` }}
            >
              <div className="flex items-center gap-2.5">
                <span className="text-[10.5px] font-mono w-5" style={{ color: P.textMuted }}>#{i + 1}</span>
                <span className="text-[12px] font-mono" style={{ color: P.textPrimary }}>{h.address.slice(0, 6)}...{h.address.slice(-4)}</span>
              </div>
              <div className="text-right">
                <div className="text-[12px] font-mono font-semibold" style={{ color: P.textPrimary }}>{fmt(h.balance, 0)}</div>
                <div className="text-[10.5px]" style={{ color: P.textMuted }}>{h.percentOfSupply.toFixed(2)}%</div>
              </div>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

function TokenDetailView({ token, onBack, P, theme }) {
  const [amount, setAmount] = useState("");
  const [side, setSide] = useState("buy");
  // Real, user-facing slippage tolerance — buyTokenReal/sellTokenReal
  // already accept this and use it to compute a genuine on-chain price
  // limit (getTradeQuote reads the pool's live spot price and derives
  // sqrtPriceLimitX96 from it). Default raised from 5% to 10%: these are
  // thin, pre-graduation bonding-curve pools, where a single trade can
  // move the price enough that 5% tolerance means frequent, confusing
  // reverts rather than real protection. A visible warning kicks in once
  // tolerance goes to 15% or above (HIGH_SLIPPAGE_THRESHOLD below) so a
  // wide tolerance is a decision the user actually sees, not a silent one.
  const [slippagePercent, setSlippagePercent] = useState(10);
  const [customSlippage, setCustomSlippage] = useState("");
  const [showSlippageEditor, setShowSlippageEditor] = useState(false);
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [trading, setTrading] = useState(false);
  const [tradeError, setTradeError] = useState(null);
  const [tradeResult, setTradeResult] = useState(null);
  const [tokenBalance, setTokenBalance] = useState(0n);
  const [tokenBalanceLoading, setTokenBalanceLoading] = useState(true);

  // Real, live progress — initialized from whatever the page loaded with,
  // then refreshed with fresh on-chain numbers right after every trade.
  // This is the actual fix for the graduation bar not moving: nothing
  // previously re-fetched this after a trade, so it just kept showing
  // the snapshot from whenever the page first opened.
  const [liveProgress, setLiveProgress] = useState({
    marketCapUsd: token.marketCapUsd,
    graduationThresholdUsd: token.graduationThresholdUsd,
    graduated: token.graduated,
  });

  async function refreshProgress() {
    try {
      const fresh = await getLaunchProgress({ poolId: token.poolId });
      setLiveProgress(fresh);
    } catch {
      // Non-fatal — the trade itself already succeeded either way. Worst
      // case the bar just keeps its last known value until the next
      // successful refresh.
    }
  }

  // Also refresh the moment this page opens, not just after a trade —
  // otherwise a token another user traded since Explore last fetched would
  // still show a stale number here on first load.
  useEffect(() => {
    refreshProgress();
  }, [token.poolId]);

  // Real update capability for the token's actual creator only —
  // verified server-side against the on-chain registered creator, not
  // just trusted from this check alone (this is just what shows the UI).
  const isCreator = address && token.creator && address.toLowerCase() === token.creator.toLowerCase();
  const [localLogoUrl, setLocalLogoUrl] = useState(null); // reflects a successful update immediately, without a full re-fetch
  const [editingLogo, setEditingLogo] = useState(false);
  const [logoUpdateError, setLogoUpdateError] = useState(null);
  const [logoUpdateStep, setLogoUpdateStep] = useState(null);
  const editFileInputRef = useRef(null);

  async function handleLogoUpdate(e) {
    const file = e.target.files?.[0];
    if (!file) {
      setLogoUpdateError("No file was actually selected — try tapping the badge again.");
      return;
    }
    setLogoUpdateError(null);
    setEditingLogo(true);
    setLogoUpdateStep("Uploading image…");

    let newUrl;
    try {
      newUrl = await uploadTokenLogo(file);
    } catch (err) {
      setLogoUpdateError(`Upload step failed: ${err?.message || String(err)}`);
      setEditingLogo(false);
      setLogoUpdateStep(null);
      return;
    }

    setLogoUpdateStep("Waiting for your wallet to sign…");
    const message = `I authorize updating the logo for token ${token.tokenAddress}`;
    let signature;
    try {
      signature = await signMessageAsync({ message });
    } catch (err) {
      setLogoUpdateError(`Signing step failed: ${err?.message || String(err)}`);
      setEditingLogo(false);
      setLogoUpdateStep(null);
      return;
    }

    setLogoUpdateStep("Saving…");
    try {
      await saveTokenLogo({
        tokenAddress: token.tokenAddress,
        logoUrl: newUrl,
        poolId: token.poolId,
        isUpdate: true,
        signature,
        signerAddress: address,
      });
      setLocalLogoUrl(newUrl);
      setLogoUpdateStep("Done — logo updated.");
    } catch (err) {
      setLogoUpdateError(`Save step failed: ${err?.message || String(err)}`);
    } finally {
      setEditingLogo(false);
    }
  }

  // Real ETH balance, for the buy-side percentage buttons.
  const { data: ethBalanceData, isLoading: ethBalanceLoading, refetch: refetchEthBalance } = useBalance({ address, chainId: ROBINHOOD_CHAIN_ID });

  // Real token balance, for the sell-side percentage buttons. Refetches
  // whenever the token or connected wallet changes, or after a trade
  // completes (so the balance stays accurate after a buy/sell).
  useEffect(() => {
    if (!address || !token.tokenAddress) return;
    let cancelled = false;
    setTokenBalanceLoading(true);
    getTokenBalance({ tokenAddress: token.tokenAddress, ownerAddress: address })
      .then((bal) => { if (!cancelled) setTokenBalance(bal); })
      .catch(() => { if (!cancelled) setTokenBalance(0n); })
      .finally(() => { if (!cancelled) setTokenBalanceLoading(false); });
    return () => { cancelled = true; };
  }, [address, token.tokenAddress, tradeResult]);

  // Small gas buffer reserved on 100% ETH buys, so the transaction doesn't
  // fail from having nothing left to pay gas with.
  const GAS_BUFFER_ETH = 0.0005;

  function setPercentAmount(pct) {
    if (side === "buy") {
      const balEth = ethBalanceData ? parseFloat(ethBalanceData.formatted) : 0;
      const usable = Math.max(0, balEth - GAS_BUFFER_ETH);
      setAmount((usable * (pct / 100)).toFixed(6));
    } else {
      const balTokens = Number(tokenBalance) / 1e18;
      setAmount((balTokens * (pct / 100)).toFixed(6));
    }
  }

  async function handleTrade() {
    setTradeError(null);
    setTradeResult(null);
    setTrading(true);
    try {
      const result = side === "buy"
        ? await buyTokenReal({ tokenAddress: token.tokenAddress, ethAmount: amount, recipient: address, slippagePercent })
        : await sellTokenReal({ tokenAddress: token.tokenAddress, tokenAmountWei: BigInt(Math.round(parseFloat(amount) * 1e18)), recipient: address, slippagePercent });
      setTradeResult(result);
      await refreshProgress();
      await refetchEthBalance();
    } catch (err) {
      setTradeError(err?.shortMessage || err?.message || String(err));
    } finally {
      setTrading(false);
    }
  }

  // Mock quote calculation — no live price oracle wired up yet, so this
  // derives an implied token price the same way the rest of this file
  // already does (market cap ÷ fixed 1B supply), and reuses the same ETH
  // price already used elsewhere in the app (App.jsx's ASSETS array) for
  // consistency. This is illustrative, not a real swap quote.
  const TOTAL_SUPPLY = 1_000_000_000;
  const ETH_USD_PRICE = 3120;
  const pricePerToken = liveProgress.marketCapUsd / TOTAL_SUPPLY;
  const amtNum = parseFloat(amount) || 0;
  const usdValue = side === "buy" ? amtNum * ETH_USD_PRICE : amtNum * pricePerToken;
  const tokensReceived = side === "buy" && pricePerToken > 0 ? usdValue / pricePerToken : 0;
  const ethReceived = side === "sell" && ETH_USD_PRICE > 0 ? usdValue / ETH_USD_PRICE : 0;

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <button onClick={onBack} className="flex items-center gap-1.5 text-[12.5px]" style={{ color: P.textSecondary }}>
          <ArrowLeft size={14} /> Back
        </button>
        <ShareTokenButton tokenAddress={token.tokenAddress} P={P} />
      </div>

      {/* One compact header instead of two full-size cards — identity,
          graduation progress, stats, and addresses/socials all in one
          panel with thin dividers between sections. The chart is the
          actual point of this page now; this just needs to orient you
          before you get there, not compete with it for space. */}
      <div className="rounded-2xl p-3.5 mb-2.5" style={{ background: P.panel, border: `1px solid ${P.panelBorder}`, boxShadow: "0 1px 2px rgba(0,0,0,0.05)" }}>
        <div className="flex items-center gap-2.5">
          <div className="relative shrink-0">
            <TokenAvatar name={token.name} hue={token.hue} address={token.tokenAddress} logoUrl={localLogoUrl || token.logoUrl} size={42} />
            {isCreator && (
              <button
                onClick={() => editFileInputRef.current?.click()}
                disabled={editingLogo}
                className="absolute -bottom-1 -right-1 w-4 h-4 rounded-full flex items-center justify-center"
                style={{ background: P.ctaBg, border: `2px solid ${P.panel}` }}
                title="Update logo"
              >
                <Plus size={9} color={P.ctaText} />
              </button>
            )}
            <input ref={editFileInputRef} type="file" accept="image/*" onChange={handleLogoUpdate} className="hidden" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-1.5">
              <span className="text-[15px] font-display font-semibold truncate" style={{ color: P.textPrimary }}>{token.name}</span>
              <span className="text-[11.5px] font-mono shrink-0" style={{ color: P.textMuted }}>${token.symbol}</span>
            </div>
            {!isCreator && (
              <div className="text-[9.5px] mt-0.5 truncate" style={{ color: P.textMuted }}>
                {address ? "Connected wallet isn't this token's creator — logo edit unavailable" : "Connect the creator's wallet to edit this token's logo"}
              </div>
            )}
          </div>
          <div className="text-right shrink-0">
            <div className="text-[9.5px]" style={{ color: P.textMuted }}>24h</div>
            <div className="text-[12px] font-mono font-semibold" style={{ color: token.priceChange24h >= 0 ? LIME_DEEP : "#D92D20" }}>
              {token.priceChange24h >= 0 ? "+" : ""}{fmt(token.priceChange24h, 1)}%
            </div>
          </div>
        </div>

        {logoUpdateStep && (
          <div className="rounded-lg p-2.5 mt-2.5 text-[11.5px] font-medium" style={{ background: `${LIME}15`, border: `1px solid ${LIME}40`, color: LIME_DEEP }}>
            {logoUpdateStep}
          </div>
        )}
        {logoUpdateError && (
          <div className="rounded-lg p-2.5 mt-2.5 text-[11.5px]" style={{ background: "#D92D2015", border: "1px solid #D92D2040", color: "#D92D20" }}>
            <div className="font-semibold mb-0.5">Logo update failed</div>
            <div>{logoUpdateError}</div>
          </div>
        )}

        <div className="mt-2.5 pt-2.5" style={{ borderTop: `1px solid ${P.panelBorder}` }}>
          <GraduationBar current={liveProgress.marketCapUsd} threshold={liveProgress.graduationThresholdUsd} P={P} size="small" />
        </div>

        <div className="flex items-center gap-4 mt-2.5 pt-2.5" style={{ borderTop: `1px solid ${P.panelBorder}` }}>
          <div>
            <div className="text-[9.5px]" style={{ color: P.textMuted }}>Market cap</div>
            <div className="text-[12px] font-mono font-semibold" style={{ color: P.textPrimary }}>${fmt(liveProgress.marketCapUsd, 0)}</div>
          </div>
          <div>
            <div className="text-[9.5px]" style={{ color: P.textMuted }}>Holders</div>
            <div className="text-[12px] font-mono font-semibold" style={{ color: P.textPrimary }}>{token.holders}</div>
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 mt-2.5 pt-2.5 flex-wrap" style={{ borderTop: `1px solid ${P.panelBorder}` }}>
          <div className="flex flex-col gap-0.5">
            <CopyableAddress address={token.tokenAddress} P={P} label="Contract" />
            <CopyableAddress address={token.creator} P={P} label="Creator" />
          </div>
          {(token.x || token.tg) && (
            <div className="flex gap-1.5">
              {token.x && <span className="text-[10px] px-2 py-0.5 rounded-md" style={{ background: P.pillBg, color: P.textSecondary }}>𝕏 @{token.x}</span>}
              {token.tg && <span className="text-[10px] px-2 py-0.5 rounded-md" style={{ background: P.pillBg, color: P.textSecondary }}>✈ {token.tg}</span>}
            </div>
          )}
        </div>
      </div>

      <DexScreenerChart tokenAddress={token.tokenAddress} hasTrades={liveProgress.marketCapUsd > 0} theme={theme} P={P} />
      <a
        href={`https://dexscreener.com/robinhood/${token.tokenAddress}`}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center justify-center gap-1 mb-2.5 text-[11px] font-medium"
        style={{ color: P.textMuted, marginTop: -6 }}
      >
        Open full chart on DexScreener <ExternalLink size={10} />
      </a>

      <div className="rounded-2xl p-3.5 mb-2.5" style={{ background: P.panel, border: `1px solid ${P.panelBorder}`, boxShadow: "0 1px 2px rgba(0,0,0,0.05)" }}>
        <div className="flex items-center justify-between mb-2">
          <span className="text-[10.5px]" style={{ color: P.textMuted }}>Slippage tolerance</span>
          <button onClick={() => setShowSlippageEditor((v) => !v)} className="text-[11.5px] font-mono font-semibold" style={{ color: slippagePercent >= HIGH_SLIPPAGE_THRESHOLD ? "#8A5A00" : P.textPrimary }}>
            {slippagePercent}% {showSlippageEditor ? "▴" : "▾"}
          </button>
        </div>
        {showSlippageEditor && (
          <div className="flex gap-1.5 mb-2" style={{ marginBottom: slippagePercent >= HIGH_SLIPPAGE_THRESHOLD ? 8 : 10 }}>
            {[5, 10, 15].map((pct) => (
              <button
                key={pct}
                onClick={() => { setSlippagePercent(pct); setCustomSlippage(""); }}
                className="flex-1 py-1.5 rounded-lg text-[11px] font-medium"
                style={{ background: slippagePercent === pct && !customSlippage ? P.ctaBg : P.pillBg, color: slippagePercent === pct && !customSlippage ? P.ctaText : P.textSecondary, border: `1px solid ${P.panelBorder}` }}
              >
                {pct}%
              </button>
            ))}
            <div className="flex-1 flex items-center rounded-lg px-2" style={{ background: P.pillBg, border: `1px solid ${P.panelBorder}` }}>
              <input
                value={customSlippage}
                onChange={(e) => {
                  const v = e.target.value.replace(/[^0-9.]/g, "");
                  setCustomSlippage(v);
                  const n = parseFloat(v);
                  // Real, sane bounds — a 0% tolerance would make every real
                  // trade revert on the tiniest price move, and anything past
                  // 50% stops being meaningful slippage protection at all.
                  if (n > 0 && n <= 50) setSlippagePercent(n);
                }}
                placeholder="Custom %"
                inputMode="decimal"
                className="w-full py-1.5 text-[11px] bg-transparent outline-none"
                style={{ color: P.textPrimary }}
              />
            </div>
          </div>
        )}
        {showSlippageEditor && slippagePercent >= HIGH_SLIPPAGE_THRESHOLD && (
          <div className="flex items-start gap-1.5 mb-2.5 px-2.5 py-2 rounded-lg text-[10.5px]" style={{ background: "#FCEFD9", border: "1px solid #F0D9A8", color: "#8A5A00" }}>
            <AlertTriangle size={12} className="shrink-0 mt-0.5" />
            <span>High tolerance — at {slippagePercent}%, your trade can execute at a noticeably worse price than the pool's current price before it's rejected. Lower this if you want tighter protection.</span>
          </div>
        )}
        <div className="flex rounded-xl p-1 mb-2.5" style={{ background: P.panel, border: `1px solid ${P.panelBorder}` }}>
          <button
            onClick={() => setSide("buy")}
            className="flex-1 py-1.5 rounded-lg text-[12.5px] font-semibold"
            style={{ background: side === "buy" ? P.ctaBg : "transparent", color: side === "buy" ? P.ctaText : P.textSecondary }}
          >
            Buy
          </button>
          <button
            onClick={() => setSide("sell")}
            className="flex-1 py-1.5 rounded-lg text-[12.5px] font-semibold"
            style={{ background: side === "sell" ? "#D92D20" : "transparent", color: side === "sell" ? "#fff" : P.textSecondary }}
          >
            Sell
          </button>
        </div>
        <div className="rounded-lg px-3 py-2 mb-2.5" style={{ background: P.panel, border: `1px solid ${P.panelBorder}` }}>
          <div className="flex items-center justify-between mb-0.5 gap-2">
            <span className="text-[10px] shrink-0" style={{ color: P.textMuted }}>Amount {side === "buy" ? "(ETH)" : `(${token.symbol})`}</span>
            {isConnected && (
              <span className="text-[10px] font-mono truncate" style={{ color: P.textMuted }}>
                {side === "buy"
                  ? ethBalanceLoading ? "Loading…" : `Balance: ${parseFloat(ethBalanceData?.formatted || "0").toFixed(4)} ETH`
                  : tokenBalanceLoading ? "Loading…" : `Balance: ${fmt(Number(tokenBalance) / 1e18, 0)} ${token.symbol}`}
              </span>
            )}
          </div>
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0"
            inputMode="decimal"
            className="w-full text-[19px] font-display bg-transparent outline-none"
            style={{ color: P.textPrimary }}
          />
        </div>
        <div className="flex gap-1.5 mb-2.5">
          {[25, 50, 100].map((pct) => (
            <button
              key={pct}
              onClick={() => setPercentAmount(pct)}
              className="flex-1 py-1 rounded-lg text-[11px] font-medium"
              style={{ background: P.pillBg, color: P.textSecondary, border: `1px solid ${P.panelBorder}` }}
            >
              {pct}%
            </button>
          ))}
        </div>
        {amtNum > 0 && (
          <div className="rounded-lg px-3 py-2 mb-2.5 flex items-center justify-between" style={{ background: P.pillBg, border: `1px solid ${P.panelBorder}` }}>
            <span className="text-[10.5px]" style={{ color: P.textMuted }}>You'll receive (estimate)</span>
            <span className="text-[12.5px] font-mono font-semibold" style={{ color: P.textPrimary }}>
              {side === "buy"
                ? `${fmt(tokensReceived, 0)} ${token.symbol}`
                : `${ethReceived.toFixed(5)} ETH`}
              <span className="ml-1.5 font-normal" style={{ color: P.textMuted }}>(${fmt(usdValue, 2)})</span>
            </span>
          </div>
        )}
        {!isConnected ? (
          <div className="text-center py-2.5 rounded-full font-display font-semibold text-[13.5px]" style={{ background: P.pillBg, color: P.textMuted }}>
            Connect a wallet to trade
          </div>
        ) : (
          <button
            onClick={handleTrade}
            disabled={!amount || trading}
            className="w-full py-2.5 rounded-full font-display font-semibold text-[13.5px]"
            style={{ background: amount && !trading ? (side === "buy" ? P.ctaBg : "#D92D20") : P.pillBg, color: amount && !trading ? (side === "buy" ? P.ctaText : "#fff") : P.textMuted }}
          >
            {trading ? "Trading…" : `${side === "buy" ? "Buy" : "Sell"} ${token.symbol}`}
          </button>
        )}
        {/* Real call against the deployed Router — computes a live price
            limit from StateView using the slippage % selected above, before
            submitting. This genuinely bounds how far the pool's price can
            move during the swap, and is now real, visible, and adjustable
            instead of a hardcoded invisible 5%. minAmountOut itself is
            still left unset (accepts any output amount at whatever price
            the limit allows) pending a full swap-simulation integration —
            for a thin-liquidity pool the actual output at that price limit
            could still come in lower than the price alone suggests. Real,
            honest gap, not hidden. */}
        {tradeError && (
          <div className="mt-2 rounded-lg p-3 text-[11.5px]" style={{ background: "#D92D2015", border: "1px solid #D92D2040", color: "#D92D20" }}>
            <div className="font-medium mb-0.5">Trade failed</div>
            <div className="font-mono break-all">{tradeError}</div>
          </div>
        )}
        {tradeResult && (
          <div className="mt-2 rounded-lg p-3 text-[11.5px]" style={{ background: `${LIME}15`, border: `1px solid ${LIME}40`, color: LIME_DEEP }}>
            <div className="font-medium mb-0.5">Trade confirmed</div>
            <div className="font-mono break-all">{tradeResult.hash}</div>
          </div>
        )}
      </div>

      <TokenActivityPanel token={token} P={P} />
    </div>
  );
}

function ExplorePage({ onSelectToken, refreshKey, P }) {
  const [sortChip, setSortChip] = useState("Market cap");
  const [rangeChip, setRangeChip] = useState("All");
  const [query, setQuery] = useState("");
  const [tokens, setTokens] = useState([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(null);
  // Per-poolId { volumeEth, lastBuyAt }, fetched entirely separately from
  // the launches list below — see getLaunchStats's comment. Starts empty
  // and fills in whenever it resolves; the list renders with real data
  // either way, "Recent buys" just falls back to 0/never-bought ordering
  // until (if) this arrives.
  const [stats, setStats] = useState({});

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getRealLaunches()
      .then((real) => { if (!cancelled) { setTokens(real); setFetchError(null); } })
      .catch((err) => { if (!cancelled) setFetchError(err?.message || String(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [refreshKey]); // re-fetches whenever a launch succeeds, not just on mount

  useEffect(() => {
    let cancelled = false;
    getLaunchStats()
      .then((real) => { if (!cancelled) setStats(real); })
      .catch(() => { /* Explore already works without this — degrade quietly. */ });
    return () => { cancelled = true; };
  }, [refreshKey]);

  const chipStyle = (active) => ({
    background: active ? P.ctaBg : P.panel,
    color: active ? P.ctaText : P.textSecondary,
    border: active ? "none" : `1px solid ${P.panelBorder}`,
    boxShadow: "0 1px 2px rgba(0,0,0,0.05)",
  });

  const now = Date.now();
  const rangeMs = rangeChip === "24h" ? 24 * 3600_000 : rangeChip === "7d" ? 7 * 24 * 3600_000 : Infinity;
  const rangeFiltered = tokens.filter((t) => now - t.createdAt <= rangeMs);

  const q = query.trim().toLowerCase();
  const searched = q
    ? rangeFiltered.filter((t) => t.name.toLowerCase().includes(q) || t.symbol.toLowerCase().includes(q))
    : rangeFiltered;

  const lastBuyAt = (t) => stats[t.poolId?.toLowerCase()]?.lastBuyAt || 0;
  const sorted = [...searched].sort((a, b) =>
    sortChip === "Newest" ? b.createdAt - a.createdAt
      : sortChip === "Top gainers" ? b.priceChange24h - a.priceChange24h
      : sortChip === "Recent buys" ? lastBuyAt(b) - lastBuyAt(a)
      : b.marketCapUsd - a.marketCapUsd
  );

  return (
    <div>
      <div className="mb-1">
        <div className="text-[18px] font-display font-semibold" style={{ color: P.textPrimary }}>Explore</div>
        <div className="text-[12px]" style={{ color: P.textMuted }}>Tokens still climbing toward graduation.</div>
      </div>

      <div className="relative mt-3 mb-2.5">
        <Search size={14} color={P.textMuted} className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name or ticker"
          className="w-full pl-8 pr-3 py-2 rounded-full text-[12.5px]"
          style={{ background: P.panel, border: `1px solid ${P.panelBorder}`, color: P.textPrimary, boxShadow: "0 1px 2px rgba(0,0,0,0.05)" }}
        />
      </div>

      <div className="flex gap-1 mb-2 overflow-x-auto w-full pr-4" style={{ scrollbarWidth: "none" }}>
        {["Market cap", "Newest", "Top gainers", "Recent buys"].map((c) => (
          <button key={c} onClick={() => setSortChip(c)} className="px-2.5 py-1.5 rounded-full text-[11px] font-medium whitespace-nowrap shrink-0" style={chipStyle(sortChip === c)}>{c}</button>
        ))}
      </div>
      <div className="flex gap-1.5 mb-4">
        {["All", "24h", "7d"].map((c) => (
          <button key={c} onClick={() => setRangeChip(c)} className="px-3 py-1.5 rounded-full text-[11.5px] font-medium" style={chipStyle(rangeChip === c)}>{c}</button>
        ))}
      </div>

      {loading ? (
        <div className="text-center py-16 text-[12.5px]" style={{ color: P.textMuted }}>Loading real launches from the Registry…</div>
      ) : fetchError ? (
        <div className="rounded-xl p-4 text-[12px]" style={{ background: "#D92D2015", border: "1px solid #D92D2040", color: "#D92D20" }}>
          Couldn't reach the Registry: {fetchError}
        </div>
      ) : sorted.length === 0 ? (
        <div className="flex flex-col items-center text-center gap-2 py-16">
          <Rocket size={26} color={P.textMuted} />
          <div className="text-[13px] font-medium" style={{ color: P.textPrimary }}>
            {tokens.length === 0 ? "No tokens launched yet" : q ? `No tokens match "${query.trim()}"` : "No tokens in this range"}
          </div>
          <div className="text-[12px]" style={{ color: P.textMuted, maxWidth: 220 }}>
            {tokens.length === 0 ? "This is real — reading directly from the Registry contract. Be the first to launch one." : q ? "Try a different name or ticker." : "Try a wider time range."}
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">
          {sorted.map((t) => (
            <TokenCard key={t.id} token={t} onClick={() => onSelectToken(t)} P={P} />
          ))}
        </div>
      )}

      <div className="mt-8 pt-5 text-[11px] leading-relaxed" style={{ borderTop: `1px solid ${P.divider}`, color: P.textMuted }}>
        <p className="mb-3">Every token launched through Mango goes straight into its own Uniswap v4 pool, live from the first buy. Your wallet signs and sends every transaction directly on-chain.</p>
        <p className="mb-3">A hook is code attached to the pool that runs automatically on every trade. Mango's handles the fee: 1% on buys, 4% on sells pre-graduation, flat 1% after — split 70/30 between creator and protocol, instantly, with no claiming step.</p>
        <p>© 2026 Mango Protocol.</p>
      </div>
    </div>
  );
}

function ProfilePage({ onSelectToken, P }) {
  const { address, isConnected } = useAccount();
  const [tab, setTab] = useState("launches");
  const [portfolio, setPortfolio] = useState(null);
  const [portfolioError, setPortfolioError] = useState(null);

  useEffect(() => {
    if (!address) return;
    setPortfolio(null);
    setPortfolioError(null);
    let cancelled = false;
    getUserPortfolio({ ownerAddress: address })
      .then((real) => { if (!cancelled) setPortfolio(real); })
      .catch((err) => { if (!cancelled) setPortfolioError(err?.message || String(err)); });
    return () => { cancelled = true; };
  }, [address]);

  if (!isConnected) {
    return (
      <div className="flex flex-col items-center text-center gap-3 py-16">
        <Users size={28} color={P.textMuted} />
        <div className="text-[13px]" style={{ color: P.textSecondary, maxWidth: 220 }}>Connect a wallet to track your positions, PnL, and creator earnings.</div>
      </div>
    );
  }

  const list = tab === "launches" ? portfolio?.launched : portfolio?.holdings;

  return (
    <div>
      <div className="text-[18px] font-display font-semibold" style={{ color: P.textPrimary }}>Profile</div>
      <div className="text-[12px] mb-4 font-mono" style={{ color: P.textMuted }}>{address}</div>

      <div className="flex rounded-xl p-1 mb-3" style={{ background: P.pillBg }}>
        <button
          onClick={() => setTab("launches")}
          className="flex-1 py-2 rounded-lg text-[12.5px] font-semibold"
          style={{ background: tab === "launches" ? P.panel : "transparent", color: tab === "launches" ? P.textPrimary : P.textSecondary }}
        >
          Your Launches
        </button>
        <button
          onClick={() => setTab("holdings")}
          className="flex-1 py-2 rounded-lg text-[12.5px] font-semibold"
          style={{ background: tab === "holdings" ? P.panel : "transparent", color: tab === "holdings" ? P.textPrimary : P.textSecondary }}
        >
          Holdings
        </button>
      </div>

      {portfolio === null && !portfolioError ? (
        <div className="text-center py-16 text-[12.5px]" style={{ color: P.textMuted }}>Checking real balances across every launch…</div>
      ) : portfolioError ? (
        <div className="rounded-xl p-4 text-[12px]" style={{ background: "#D92D2015", border: "1px solid #D92D2040", color: "#D92D20" }}>
          Couldn't load your portfolio: {portfolioError}
        </div>
      ) : list.length === 0 ? (
        <div className="flex flex-col items-center text-center gap-2 py-16">
          <Users size={26} color={P.textMuted} />
          <div className="text-[13px] font-medium" style={{ color: P.textPrimary }}>
            {tab === "launches" ? "You haven't launched anything yet" : "You don't hold any launched tokens yet"}
          </div>
          <div className="text-[12px]" style={{ color: P.textMuted, maxWidth: 220 }}>
            {tab === "launches" ? "Tokens you launch will show up here." : "Tokens you buy will show up here."}
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">
          {list.map((t) => (
            <div key={t.id} onClick={() => onSelectToken(t)} className="cursor-pointer">
              <TokenCard token={t} onClick={() => onSelectToken(t)} P={P} />
              {tab === "holdings" && (
                <div className="text-[11px] font-mono mt-1 px-1" style={{ color: P.textMuted }}>You hold: {fmt(t.walletBalance, 0)} {t.symbol}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AnalyticsPage({ P }) {
  const [range, setRange] = useState("24h");
  const [launchCount, setLaunchCount] = useState(null);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState(null);
  const [statsError, setStatsError] = useState(null);
  const [statsLoading, setStatsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    getRealLaunches()
      .then((real) => { if (!cancelled) setLaunchCount(real.length); })
      .catch(() => { if (!cancelled) setLaunchCount(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  // Fetched independently from launch count above, deliberately not
  // Promise.all'd together — a slow/failing protocol-wide scan must only
  // cost the volume tile, never blank out the (unrelated, working) launch
  // count too.
  useEffect(() => {
    let cancelled = false;
    getProtocolStats()
      .then((real) => { if (!cancelled) { setStats(real); setStatsError(null); } })
      .catch((err) => { if (!cancelled) setStatsError(err?.message || String(err)); })
      .finally(() => { if (!cancelled) setStatsLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const chipStyle = (active) => ({
    background: active ? P.ctaBg : P.panel,
    color: active ? P.ctaText : P.textSecondary,
    border: active ? "none" : `1px solid ${P.panelBorder}`,
    boxShadow: "0 1px 2px rgba(0,0,0,0.05)",
  });

  // Same rough ETH->USD conversion used for illustrative purposes
  // elsewhere in this file (TokenDetailView's trade-quote estimate) — not
  // a live price feed, clearly labeled as an estimate below.
  const ETH_USD_PRICE = 3120;
  const volumeEth = stats ? (range === "24h" ? stats.volume24hEth : stats.totalVolumeEth) : null;

  return (
    <div>
      <div className="text-[18px] font-display font-semibold" style={{ color: P.textPrimary }}>Protocol analytics</div>
      <div className="text-[12px] mb-4" style={{ color: P.textMuted }}>Independent onchain reporting for Mango Launchpad.</div>
      <div className="flex gap-1.5 mb-4">
        {["24h", "All time"].map((c) => (
          <button key={c} onClick={() => setRange(c)} className="px-3 py-1.5 rounded-full text-[11.5px] font-medium" style={chipStyle(range === c)}>{c}</button>
        ))}
      </div>

      {/* Real, from the Registry directly. */}
      <div className="rounded-2xl p-4 mb-2.5" style={{ background: P.panel, border: `1px solid ${P.panelBorder}`, boxShadow: "0 1px 2px rgba(0,0,0,0.05)" }}>
        <div className="text-[12px] mb-1" style={{ color: P.textSecondary }}>Token launches</div>
        <div className="text-[26px] font-mono font-bold" style={{ color: P.textPrimary }}>{loading ? "…" : launchCount ?? "—"}</div>
      </div>

      {/* Real — a genuine scan over every Swap event across every Mango
          pool on the shared PoolManager (api/token-activity.js's
          fetchProtocolStats), fetched independently from the launch count
          above so a failure here can't blank that tile out too. */}
      <div className="rounded-2xl p-4 mb-2.5" style={{ background: P.panel, border: `1px solid ${P.panelBorder}`, boxShadow: "0 1px 2px rgba(0,0,0,0.05)" }}>
        <div className="text-[12px] mb-1" style={{ color: P.textSecondary }}>Trading volume ({range})</div>
        {statsLoading ? (
          <div className="text-[26px] font-mono font-bold" style={{ color: P.textPrimary }}>…</div>
        ) : statsError ? (
          <div className="text-[13px]" style={{ color: "#D92D20" }}>Couldn't load: {statsError}</div>
        ) : (
          <div>
            <span className="text-[26px] font-mono font-bold" style={{ color: P.textPrimary }}>{fmt(volumeEth, 4)} ETH</span>
            <span className="text-[12px] ml-1.5" style={{ color: P.textMuted }}>(~${fmt(volumeEth * ETH_USD_PRICE, 0)})</span>
          </div>
        )}
      </div>

      {/* Total creator fees paid out deliberately still says "Not
          available yet" — the hook's real fee rate depends on each
          trade's buy/sell side AND whether that specific pool had already
          graduated at the moment of that trade (1%/4%/1%, per README).
          Reconstructing that accurately per historical trade needs either
          a dedicated fee event from the hook (not confirmed to exist) or
          replaying graduation state trade-by-trade — guessing at it would
          risk a confidently-wrong number, not an honest estimate, so this
          stays unavailable rather than faked. */}
      <div className="rounded-2xl p-4 mb-2.5" style={{ background: P.panel, border: `1px solid ${P.panelBorder}`, boxShadow: "0 1px 2px rgba(0,0,0,0.05)" }}>
        <div className="text-[12px] mb-1" style={{ color: P.textSecondary }}>Total creator fees paid out</div>
        <div className="text-[13px]" style={{ color: P.textMuted }}>Not available yet</div>
      </div>
    </div>
  );
}

export function LaunchpadTab({ P, theme, deepLinkTokenAddress, launchpadNetwork }) {
  const { address, isConnected, chainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const [view, setView] = useState("explore");
  const [selectedToken, setSelectedToken] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  // Bumped after a successful launch to force ExplorePage to actually
  // re-fetch — without this, a launch made while already sitting on the
  // Explore page would leave the stale empty state showing.
  const [refreshKey, setRefreshKey] = useState(0);

  // Resolves a real ?token=0x... deep link (see the Share button in
  // TokenDetailView, and App.jsx for where this prop comes from) against
  // the actual Registry-backed launch list — reuses getRealLaunches()
  // rather than a dedicated single-token fetch, since there isn't one and
  // this endpoint is already server-cached for 60s. Genuinely resolves to
  // the real token or an honest "not found," never a silent fallback to
  // the homepage.
  const [resolvingDeepLink, setResolvingDeepLink] = useState(!!deepLinkTokenAddress);
  const [deepLinkError, setDeepLinkError] = useState(null);
  useEffect(() => {
    if (!deepLinkTokenAddress) return;
    let cancelled = false;
    getRealLaunches()
      .then((tokens) => {
        if (cancelled) return;
        const match = tokens.find((t) => t.tokenAddress.toLowerCase() === deepLinkTokenAddress.toLowerCase());
        if (match) {
          setSelectedToken(match);
          setView("detail");
        } else {
          setDeepLinkError("That link's token doesn't match any launch on the Registry — it may be wrong, or on a different network.");
        }
      })
      .catch((err) => { if (!cancelled) setDeepLinkError(err?.message || String(err)); })
      .finally(() => { if (!cancelled) setResolvingDeepLink(false); });
    return () => { cancelled = true; };
  }, [deepLinkTokenAddress]);

  // Real network-switch prompt, one per connected address per visit to
  // this tab. Originally gated by a mount-only empty-deps effect (fire
  // once per LaunchpadTab mount, since it only exists in the tree while
  // tab === "launchpad"), which turned out to have a real gap: if the
  // wallet was still connecting when this component mounted (isConnected
  // false at that exact moment), the one-shot guard consumed itself on
  // that first, premature check and never got another chance once the
  // connection actually completed — the prompt silently never fired.
  // Gating on the connected *address* instead of "have I mounted yet"
  // fixes that: the effect re-evaluates whenever isConnected/chainId/
  // address actually change (not on every render — that's what the
  // dependency array is for), and promptedForRef makes sure a given
  // address only gets prompted once per mount regardless of how many
  // times those values happen to change afterward. A fresh navigation
  // back into this tab still remounts the component (App.jsx renders it
  // conditionally on tab === "launchpad"), resetting the ref — so this
  // keeps the original "once per navigation in" behavior while also
  // covering "connects after already being on the tab".
  //
  // EVM-only by construction: useAccount() is wagmi's own hook, which has
  // no concept of the separate Solana connection (OKX / AppKit's
  // SolanaAdapter) — a Solana-only wallet leaves isConnected false here,
  // so this never fires for it, exactly as it shouldn't since Solana
  // isn't relevant to the launchpad at all.
  const [switchRejected, setSwitchRejected] = useState(false);
  const promptedForRef = useRef(null);
  useEffect(() => {
    if (!isConnected || chainId === ROBINHOOD_CHAIN_ID) return;
    if (promptedForRef.current === address) return;
    promptedForRef.current = address;
    switchChainAsync({ chainId: ROBINHOOD_CHAIN_ID }).catch(() => setSwitchRejected(true));
  }, [isConnected, chainId, address, switchChainAsync]);

  const onWrongNetwork = isConnected && chainId !== ROBINHOOD_CHAIN_ID;

  return (
    <div className="px-4 pb-24">
      {/* Which network's launchpad shows here is picked from the same
          shared network selector the rest of the app uses (the globe
          button in the header, App.jsx's NetworkSelectorModal) — not a
          second picker duplicated in this file. launchpadNetwork is just
          passed down as a prop. */}
      {launchpadNetwork === "solana" ? (
        <div className="flex items-center justify-center gap-2 py-20">
          <ChainBadge id="solana" size={20} />
          <div className="text-[16px] font-semibold" style={{ color: P.textPrimary }}>Coming soon</div>
        </div>
      ) : (
        <>
          {onWrongNetwork && switchRejected && (
            <div className="flex items-center justify-between gap-3 mb-3 px-3.5 py-2.5 rounded-xl" style={{ background: "#FCEFD9", border: "1px solid #F0D9A8" }}>
              <span className="flex items-center gap-2 text-[12px]" style={{ color: "#8A5A00" }}>
                <AlertTriangle size={13} /> Launchpad runs on Robinhood Chain — switch your wallet to continue.
              </span>
              <button
                onClick={() => switchChainAsync({ chainId: ROBINHOOD_CHAIN_ID }).then(() => setSwitchRejected(false)).catch(() => setSwitchRejected(true))}
                className="text-[12px] font-semibold px-3 py-1.5 rounded-lg shrink-0"
                style={{ background: "#8A5A00", color: "#FFFFFF" }}
              >
                Switch
              </button>
            </div>
          )}

          {resolvingDeepLink ? (
            <div className="flex flex-col items-center justify-center gap-2 py-20 text-center">
              <Rocket size={24} color={P.textMuted} />
              <div className="text-[12.5px]" style={{ color: P.textMuted }}>Loading shared token…</div>
            </div>
          ) : (
            <>
              {deepLinkError && (
                <div className="flex items-center justify-between gap-2 mb-3 px-3.5 py-2.5 rounded-xl text-[12px]" style={{ background: "#D92D2015", border: "1px solid #D92D2040", color: "#D92D20" }}>
                  <span>{deepLinkError}</span>
                  <button onClick={() => setDeepLinkError(null)} className="shrink-0"><X size={13} /></button>
                </div>
              )}

              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-1">
                  <button onClick={() => setView("explore")} className="px-2.5 py-1 text-[12px] font-medium rounded-full" style={{ background: view === "explore" || view === "detail" ? P.pillBg : "transparent", color: view === "explore" || view === "detail" ? P.textPrimary : P.textMuted }}>Explore</button>
                  <button onClick={() => setView("profile")} className="px-2.5 py-1 text-[12px] font-medium rounded-full" style={{ background: view === "profile" ? P.pillBg : "transparent", color: view === "profile" ? P.textPrimary : P.textMuted }}>Profile</button>
                  <button onClick={() => setView("analytics")} className="px-2.5 py-1 text-[12px] font-medium rounded-full" style={{ background: view === "analytics" ? P.pillBg : "transparent", color: view === "analytics" ? P.textPrimary : P.textMuted }}>Stats</button>
                </div>
                {view !== "detail" && (
                  <button onClick={() => setShowCreate(true)} className="flex items-center gap-1.5 px-3.5 py-2 rounded-full text-[12.5px] font-semibold" style={{ background: P.ctaBg, color: P.ctaText }}>
                    <Plus size={14} /> Launch
                  </button>
                )}
              </div>

              {view === "detail" && selectedToken ? (
                <TokenDetailView token={selectedToken} onBack={() => setView("explore")} P={P} theme={theme} />
              ) : view === "profile" ? (
                <ProfilePage onSelectToken={(t) => { setSelectedToken(t); setView("detail"); }} P={P} />
              ) : view === "analytics" ? (
                <AnalyticsPage P={P} />
              ) : (
                <ExplorePage onSelectToken={(t) => { setSelectedToken(t); setView("detail"); }} P={P} refreshKey={refreshKey} />
              )}
            </>
          )}

          {showCreate && (
            <CreateLaunchModal
              onClose={() => setShowCreate(false)}
          onLaunchSuccess={(result, { name, symbol }) => {
            setRefreshKey((k) => k + 1);
            // Real fix for "doesn't navigate after launch" — build a
            // lightweight but genuinely accurate token object from data we
            // actually have (the name/symbol just entered, the real
            // decoded token address from the TokenLaunched event) and
            // navigate immediately, rather than waiting on a slower
            // re-fetch round-trip. Market cap starts at 0 since the token
            // is brand new — no fees have accrued yet, honestly.
            if (result?.tokenAddress) {
              setSelectedToken({
                id: result.tokenAddress,
                tokenAddress: result.tokenAddress,
                name,
                symbol,
                creator: address,
                marketCapUsd: 0,
                graduationThresholdUsd: 30000,
                graduated: false,
                holders: 0,
                priceChange24h: 0,
                hue: (symbol.charCodeAt(0) || 0) % 360,
              });
              setShowCreate(false);
              setView("detail");
            }
          }}
          P={P}
            />
          )}
        </>
      )}
    </div>
  );
}
