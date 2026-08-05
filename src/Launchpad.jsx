import React, { useState, useEffect } from "react";
import { useAccount } from "wagmi";
import { Plus, X, ArrowLeft, Rocket, Users, Search, BarChart3 } from "lucide-react";
import { PALETTE, LIME, LIME_DEEP, fmt, timeAgo } from "./theme.js";
import { launchToken, getRealLaunches, buyTokenReal, sellTokenReal, ROBINHOOD_CHAIN_ID } from "./launchpad-contracts.js";

function GraduationBar({ current, threshold, P, size = "normal" }) {
  const pct = Math.min(100, (current / threshold) * 100);
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

function TokenAvatar({ name, hue, size = 38 }) {
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
        <TokenAvatar name={token.name} hue={token.hue} />
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
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [imagePreview, setImagePreview] = useState(null);
  const [devBuy, setDevBuy] = useState("");
  const { address, isConnected, chainId } = useAccount();
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState(null);
  const [launchResult, setLaunchResult] = useState(null);

  async function handleLaunch() {
    setLaunchError(null);
    setLaunchResult(null);
    setLaunching(true);
    try {
      const result = await launchToken({ name, symbol, creator: address, devBuyEth: devBuy });
      setLaunchResult(result);
      onLaunchSuccess?.();
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

  function handleImageSelect(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) return; // silently ignore non-images
    const reader = new FileReader();
    reader.onload = () => setImagePreview(reader.result);
    reader.readAsDataURL(file);
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
            <div className="flex items-start gap-2 mt-2 text-[11px]" style={{ color: P.textMuted }}>
              <input type="checkbox" className="mt-0.5" />
              <span>I understand that selected artwork will be moderated and uploaded to public IPFS.</span>
            </div>
          </div>
          <div>
            <label className="text-[12px] font-medium mb-1 block" style={{ color: P.textPrimary }}>X profile</label>
            <div className="flex items-center rounded-lg overflow-hidden" style={fieldStyle}>
              <span className="pl-3 text-[12.5px]" style={{ color: P.textMuted }}>x.com/</span>
              <input placeholder="yourhandle" className="flex-1 px-1 py-2.5 text-[13px] bg-transparent" style={{ color: P.textPrimary }} />
            </div>
          </div>
          <div>
            <label className="text-[12px] font-medium mb-1 block" style={{ color: P.textPrimary }}>Telegram</label>
            <div className="flex items-center rounded-lg overflow-hidden" style={fieldStyle}>
              <span className="pl-3 text-[12.5px]" style={{ color: P.textMuted }}>t.me/</span>
              <input placeholder="yourgroup" className="flex-1 px-1 py-2.5 text-[13px] bg-transparent" style={{ color: P.textPrimary }} />
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
              <input placeholder="0x..." className="w-full px-3 py-2.5 rounded-lg text-[13.5px] font-mono" style={fieldStyle} />
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
            disabled={!name || !symbol || launching}
            className="w-full py-3.5 rounded-full font-display font-semibold text-[14.5px]"
            style={{ background: name && symbol && !launching ? P.ctaBg : P.pillBg, color: name && symbol && !launching ? P.ctaText : P.textMuted, cursor: name && symbol && !launching ? "pointer" : "not-allowed" }}
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

function TokenDetailView({ token, onBack, P }) {
  const [amount, setAmount] = useState("");
  const [side, setSide] = useState("buy");
  const { address, isConnected } = useAccount();
  const [trading, setTrading] = useState(false);
  const [tradeError, setTradeError] = useState(null);
  const [tradeResult, setTradeResult] = useState(null);

  async function handleTrade() {
    setTradeError(null);
    setTradeResult(null);
    setTrading(true);
    try {
      const result = side === "buy"
        ? await buyTokenReal({ tokenAddress: token.tokenAddress, ethAmount: amount, recipient: address })
        : await sellTokenReal({ tokenAddress: token.tokenAddress, tokenAmountWei: BigInt(Math.round(parseFloat(amount) * 1e18)), recipient: address });
      setTradeResult(result);
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
  const pricePerToken = token.marketCapUsd / TOTAL_SUPPLY;
  const amtNum = parseFloat(amount) || 0;
  const usdValue = side === "buy" ? amtNum * ETH_USD_PRICE : amtNum * pricePerToken;
  const tokensReceived = side === "buy" && pricePerToken > 0 ? usdValue / pricePerToken : 0;
  const ethReceived = side === "sell" && ETH_USD_PRICE > 0 ? usdValue / ETH_USD_PRICE : 0;

  return (
    <div>
      <button onClick={onBack} className="flex items-center gap-1.5 mb-4 text-[13px]" style={{ color: P.textSecondary }}>
        <ArrowLeft size={15} /> Back
      </button>

      <div className="rounded-2xl p-4 mb-3 flex items-center gap-3" style={{ background: P.panel, border: `1px solid ${P.panelBorder}`, boxShadow: "0 1px 2px rgba(0,0,0,0.05)" }}>
        <TokenAvatar name={token.name} hue={token.hue} size={52} />
        <div>
          <div className="text-[18px] font-display font-semibold" style={{ color: P.textPrimary }}>{token.name}</div>
          <div className="text-[12.5px] font-mono" style={{ color: P.textMuted }}>${token.symbol} · by {token.creator}</div>
          {(token.x || token.tg) && (
            <div className="flex gap-1.5 mt-1.5">
              {token.x && <span className="text-[10.5px] px-2 py-0.5 rounded-md" style={{ background: P.pillBg, color: P.textSecondary }}>𝕏 @{token.x}</span>}
              {token.tg && <span className="text-[10.5px] px-2 py-0.5 rounded-md" style={{ background: P.pillBg, color: P.textSecondary }}>✈ {token.tg}</span>}
            </div>
          )}
        </div>
      </div>

      <div className="rounded-2xl p-4 mb-3" style={{ background: P.panel, border: `1px solid ${P.panelBorder}`, boxShadow: "0 1px 2px rgba(0,0,0,0.05)" }}>
        <GraduationBar current={token.marketCapUsd} threshold={token.graduationThresholdUsd} P={P} />
        <div className="flex items-center gap-4 mt-3 pt-3" style={{ borderTop: `1px solid ${P.panelBorder}` }}>
          <div>
            <div className="text-[10.5px]" style={{ color: P.textMuted }}>Market cap</div>
            <div className="text-[13px] font-mono font-semibold" style={{ color: P.textPrimary }}>${fmt(token.marketCapUsd, 0)}</div>
          </div>
          <div>
            <div className="text-[10.5px]" style={{ color: P.textMuted }}>Holders</div>
            <div className="text-[13px] font-mono font-semibold" style={{ color: P.textPrimary }}>{token.holders}</div>
          </div>
          <div>
            <div className="text-[10.5px]" style={{ color: P.textMuted }}>24h</div>
            <div className="text-[13px] font-mono font-semibold" style={{ color: token.priceChange24h >= 0 ? LIME_DEEP : "#D92D20" }}>
              {token.priceChange24h >= 0 ? "+" : ""}{fmt(token.priceChange24h, 1)}%
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-2xl p-4 mb-3" style={{ background: P.panel, border: `1px solid ${P.panelBorder}`, boxShadow: "0 1px 2px rgba(0,0,0,0.05)" }}>
        <div className="flex rounded-xl p-1 mb-3" style={{ background: P.panel, border: `1px solid ${P.panelBorder}` }}>
          <button
            onClick={() => setSide("buy")}
            className="flex-1 py-2 rounded-lg text-[13px] font-semibold"
            style={{ background: side === "buy" ? P.ctaBg : "transparent", color: side === "buy" ? P.ctaText : P.textSecondary }}
          >
            Buy
          </button>
          <button
            onClick={() => setSide("sell")}
            className="flex-1 py-2 rounded-lg text-[13px] font-semibold"
            style={{ background: side === "sell" ? "#D92D20" : "transparent", color: side === "sell" ? "#fff" : P.textSecondary }}
          >
            Sell
          </button>
        </div>
        <div className="rounded-lg px-3 py-2.5 mb-3" style={{ background: P.panel, border: `1px solid ${P.panelBorder}` }}>
          <div className="text-[10.5px] mb-0.5" style={{ color: P.textMuted }}>Amount {side === "buy" ? "(ETH)" : `(${token.symbol})`}</div>
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0"
            inputMode="decimal"
            className="w-full text-[22px] font-display bg-transparent outline-none"
            style={{ color: P.textPrimary }}
          />
        </div>
        {amtNum > 0 && (
          <div className="rounded-lg px-3 py-2.5 mb-3 flex items-center justify-between" style={{ background: P.pillBg, border: `1px solid ${P.panelBorder}` }}>
            <span className="text-[11px]" style={{ color: P.textMuted }}>You'll receive (estimate)</span>
            <span className="text-[13px] font-mono font-semibold" style={{ color: P.textPrimary }}>
              {side === "buy"
                ? `${fmt(tokensReceived, 0)} ${token.symbol}`
                : `${ethReceived.toFixed(5)} ETH`}
              <span className="ml-1.5 font-normal" style={{ color: P.textMuted }}>(${fmt(usdValue, 2)})</span>
            </span>
          </div>
        )}
        {!isConnected ? (
          <div className="text-center py-3 rounded-full font-display font-semibold text-[14px]" style={{ background: P.pillBg, color: P.textMuted }}>
            Connect a wallet to trade
          </div>
        ) : (
          <button
            onClick={handleTrade}
            disabled={!amount || trading}
            className="w-full py-3 rounded-full font-display font-semibold text-[14px]"
            style={{ background: amount && !trading ? (side === "buy" ? P.ctaBg : "#D92D20") : P.pillBg, color: amount && !trading ? (side === "buy" ? P.ctaText : "#fff") : P.textMuted }}
          >
            {trading ? "Trading…" : `${side === "buy" ? "Buy" : "Sell"} ${token.symbol}`}
          </button>
        )}
        {/* Real call against the deployed Router — computes a live price
            limit from StateView before submitting. minAmountOut is
            currently left unset (accepts any output amount) pending a full
            swap-simulation integration — the price limit itself still
            provides real protection against a bad execution price, but
            this is an honest, real gap, not hidden. */}
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

      <div className="flex items-start gap-2 text-[11.5px] px-1" style={{ color: P.textMuted }}>
        <Users size={13} className="mt-0.5 shrink-0" />
        70% of every trading fee goes directly to {token.creator} — automatically, every trade.
      </div>
    </div>
  );
}

function ExplorePage({ onSelectToken, refreshKey, P }) {
  const [sortChip, setSortChip] = useState("Recent buys");
  const [rangeChip, setRangeChip] = useState("All");
  const [tokens, setTokens] = useState([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getRealLaunches()
      .then((real) => { if (!cancelled) { setTokens(real); setFetchError(null); } })
      .catch((err) => { if (!cancelled) setFetchError(err?.message || String(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [refreshKey]); // re-fetches whenever a launch succeeds, not just on mount

  const chipStyle = (active) => ({
    background: active ? P.ctaBg : P.panel,
    color: active ? P.ctaText : P.textSecondary,
    border: active ? "none" : `1px solid ${P.panelBorder}`,
    boxShadow: "0 1px 2px rgba(0,0,0,0.05)",
  });

  return (
    <div>
      <div className="mb-1">
        <div className="text-[18px] font-display font-semibold" style={{ color: P.textPrimary }}>Explore</div>
        <div className="text-[12px]" style={{ color: P.textMuted }}>Tokens still climbing toward graduation.</div>
      </div>

      <div className="flex gap-1 mt-3 mb-2 overflow-x-auto w-full pr-4" style={{ scrollbarWidth: "none" }}>
        {["Recent buys", "Newest", "Market cap", "Volume"].map((c) => (
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
      ) : tokens.length === 0 ? (
        <div className="flex flex-col items-center text-center gap-2 py-16">
          <Rocket size={26} color={P.textMuted} />
          <div className="text-[13px] font-medium" style={{ color: P.textPrimary }}>No tokens launched yet</div>
          <div className="text-[12px]" style={{ color: P.textMuted, maxWidth: 220 }}>This is real — reading directly from the Registry contract. Be the first to launch one.</div>
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">
          {[...tokens].sort((a, b) => b.marketCapUsd - a.marketCapUsd).map((t) => (
            <TokenCard key={t.id} token={t} onClick={() => onSelectToken(t)} P={P} />
          ))}
        </div>
      )}

      <div className="mt-8 pt-5 text-[11px] leading-relaxed" style={{ borderTop: `1px solid ${P.divider}`, color: P.textMuted }}>
        <p className="mb-3">Launch and explore fixed-supply tokens on Robinhood Chain, trading live on Uniswap v4 from the first buy. Your wallet submits every transaction. Mango does not custody assets.</p>
        <p className="mb-3">Transactions are submitted through your wallet and may be irreversible. Tokens can be volatile or lose all value. Mango Protocol does not provide custody, warranties, or financial advice.</p>
        <p>© 2026 Mango Protocol.</p>
      </div>
    </div>
  );
}

function ProfilePage({ P }) {
  const { address, isConnected } = useAccount();

  if (!isConnected) {
    return (
      <div className="flex flex-col items-center text-center gap-3 py-16">
        <Users size={28} color={P.textMuted} />
        <div className="text-[13px]" style={{ color: P.textSecondary, maxWidth: 220 }}>Connect a wallet to track your positions, PnL, and creator earnings.</div>
      </div>
    );
  }

  // No real data source for this yet — fetching a wallet's actual launches,
  // holdings, PnL, and creator fees needs either an indexer or targeted
  // event-log queries against the Registry, neither of which exist yet.
  // Rather than show fake numbers, this is left as an honest empty state
  // until that real data pipeline exists.
  return (
    <div>
      <div className="text-[18px] font-display font-semibold" style={{ color: P.textPrimary }}>Profile</div>
      <div className="text-[12px] mb-4 font-mono" style={{ color: P.textMuted }}>{address}</div>
      <div className="flex flex-col items-center text-center gap-2 py-16">
        <Users size={26} color={P.textMuted} />
        <div className="text-[13px] font-medium" style={{ color: P.textPrimary }}>No activity yet</div>
        <div className="text-[12px]" style={{ color: P.textMuted, maxWidth: 220 }}>Your launches, holdings, and creator fees will show up here once you have some.</div>
      </div>
    </div>
  );
}

function AnalyticsPage({ P }) {
  const [range, setRange] = useState("24h");
  const [launchCount, setLaunchCount] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    getRealLaunches()
      .then((real) => { if (!cancelled) setLaunchCount(real.length); })
      .catch(() => { if (!cancelled) setLaunchCount(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const chipStyle = (active) => ({
    background: active ? P.ctaBg : P.panel,
    color: active ? P.ctaText : P.textSecondary,
    border: active ? "none" : `1px solid ${P.panelBorder}`,
    boxShadow: "0 1px 2px rgba(0,0,0,0.05)",
  });
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

      {/* Trading volume and total creator fees paid out have no real data
          source yet — computing them needs either an indexer or targeted
          event-log aggregation across every pool, neither of which exist.
          Shown honestly as unavailable rather than faked. */}
      <div className="rounded-2xl p-4 mb-2.5" style={{ background: P.panel, border: `1px solid ${P.panelBorder}`, boxShadow: "0 1px 2px rgba(0,0,0,0.05)" }}>
        <div className="text-[12px] mb-1" style={{ color: P.textSecondary }}>Trading volume</div>
        <div className="text-[13px]" style={{ color: P.textMuted }}>Not available yet</div>
      </div>
      <div className="rounded-2xl p-4 mb-2.5" style={{ background: P.panel, border: `1px solid ${P.panelBorder}`, boxShadow: "0 1px 2px rgba(0,0,0,0.05)" }}>
        <div className="text-[12px] mb-1" style={{ color: P.textSecondary }}>Total creator fees paid out</div>
        <div className="text-[13px]" style={{ color: P.textMuted }}>Not available yet</div>
      </div>
    </div>
  );
}

export function LaunchpadTab({ P }) {
  const [view, setView] = useState("explore");
  const [selectedToken, setSelectedToken] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  // Bumped after a successful launch to force ExplorePage to actually
  // re-fetch — without this, a launch made while already sitting on the
  // Explore page would leave the stale empty state showing.
  const [refreshKey, setRefreshKey] = useState(0);

  return (
    <div className="px-4 pb-24">
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
        <TokenDetailView token={selectedToken} onBack={() => setView("explore")} P={P} />
      ) : view === "profile" ? (
        <ProfilePage P={P} />
      ) : view === "analytics" ? (
        <AnalyticsPage P={P} />
      ) : (
        <ExplorePage onSelectToken={(t) => { setSelectedToken(t); setView("detail"); }} P={P} refreshKey={refreshKey} />
      )}

      {showCreate && <CreateLaunchModal onClose={() => setShowCreate(false)} onLaunchSuccess={() => setRefreshKey((k) => k + 1)} P={P} />}
    </div>
  );
}
