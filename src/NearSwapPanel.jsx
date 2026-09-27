// src/NearSwapPanel.jsx
//
// The Swap tab when "Swap on NEAR" is picked: swaps any NEAR token from
// the user's own NEAR wallet — NEAR, USDC, USDT, or any token pasted by
// contract id (meme-cooking launches included).
//
// Routing: best price across every NEAR DEX through Intear's aggregator
// (intearRouter.js — Rhea, Rhea DCL, Intear DEX, Aidols, Meta Pool,
// LiNEAR, rNEAR, xRHEA), with every returned transaction checked before
// signing. If the aggregator is unreachable or no route passes the
// checks, it falls back to this app's own Rhea engine (rheaSwap.js).
//
// Before anything is signed the route is re-quoted against fresh pool
// state and the minimum received is recomputed from that; the exchange
// itself enforces the minimum on-chain, so a price move means a failed,
// refunded swap — never a worse fill than shown.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { parseUnits, formatUnits } from "viem";
import { nearView, nearAvailableBalance } from "./nearRpc.js";
import { useNearWallet } from "./nearWallet.js";
import { resolveDexScreenerPair, dexScreenerEmbedUrl } from "./dexScreenerChart.js";
import { fetchIntearRoutes, pickSafeRoute, feeTransaction } from "./intearRouter.js";
import { classifySwapOutcomes } from "./nearOutcome.js";
import {
  NATIVE_NEAR,
  NEAR_GAS_RESERVE,
  NEAR_META,
  NEAR_SWAP_FEE_ACCOUNT,
  USDC_NEAR,
  USDT_NEAR,
  WRAP_NEAR,
  bestRoute,
  buildSwapTransactions,
  fetchAllPools,
  fetchTokenMeta,
  isTokenId,
  minOutFor,
  priceImpactBps,
  quoteRoute,
  refreshPools,
  registrationNeed,
  routingId,
  splitFee,
} from "./rheaSwap.js";

const DEFAULT_TOKENS = [NATIVE_NEAR, USDC_NEAR, USDT_NEAR];
const CUSTOM_KEY = "mango:near-swap-tokens";
const HUB_SYMBOL = { [WRAP_NEAR]: "wNEAR", [USDC_NEAR]: "USDC", [USDT_NEAR]: "USDT" };
// Label only, until the token's own ft_metadata loads.
function labelFor(tokenId, meta) {
  return meta?.symbol ?? HUB_SYMBOL[tokenId] ?? short(tokenId);
}

function loadCustom() {
  try {
    const list = JSON.parse(localStorage.getItem(CUSTOM_KEY) || "[]");
    return Array.isArray(list) ? list.filter(isTokenId) : [];
  } catch {
    return [];
  }
}
function saveCustom(list) {
  try {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(list));
  } catch {
    // per-browser convenience only
  }
}

function fmtAmount(raw, decimals, max = 6) {
  if (raw == null) return "—";
  const s = formatUnits(BigInt(raw), decimals);
  const [w, f = ""] = s.split(".");
  const frac = f.slice(0, max).replace(/0+$/, "");
  return `${Number(w).toLocaleString()}${frac ? `.${frac}` : ""}`;
}

function short(v) {
  return typeof v === "string" && v.length > 22 ? `${v.slice(0, 10)}…${v.slice(-8)}` : v;
}

async function fetchBalance(tokenId, accountId) {
  if (tokenId === NATIVE_NEAR) return nearAvailableBalance(accountId);
  const b = await nearView(tokenId, "ft_balance_of", { account_id: accountId });
  return typeof b === "string" ? b : "0";
}

function TokenPicker({ P, value, metas, tokens, onPick, onAdd, exclude }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [state, setState] = useState({ status: "idle" });
  const ref = useRef(null);
  useEffect(() => {
    function onDoc(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);
  const meta = metas[value];

  async function add() {
    const id = text.trim().toLowerCase();
    setState({ status: "loading" });
    try {
      const m = await onAdd(id);
      onPick(m.id);
      setText("");
      setState({ status: "idle" });
      setOpen(false);
    } catch (e) {
      setState({ status: "error", error: e?.message || "Couldn't load that token." });
    }
  }

  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[14px] font-semibold" style={{ background: P.pillBg, color: P.textPrimary }}>
        {meta?.icon && <img src={meta.icon} alt="" className="w-5 h-5 rounded-full" />}
        {labelFor(value, meta)} <span style={{ color: P.textMuted }}>▾</span>
      </button>
      {open && (
        <div className="absolute right-0 z-50 mt-2 w-72 rounded-xl shadow-2xl p-2" style={{ background: P.panel, border: `1px solid ${P.panelBorder}` }}>
          <div className="max-h-56 overflow-y-auto">
            {tokens.filter((t) => t !== exclude).map((t) => (
              <button key={t} onClick={() => { onPick(t); setOpen(false); }} className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-left" style={{ background: t === value ? P.input : "transparent" }}>
                {metas[t]?.icon ? <img src={metas[t].icon} alt="" className="w-5 h-5 rounded-full" /> : <span className="w-5 h-5 rounded-full" style={{ background: P.input }} />}
                <span className="text-[13px] font-medium" style={{ color: P.textPrimary }}>{labelFor(t, metas[t])}</span>
                <span className="text-[11px] font-mono truncate ml-auto" style={{ color: P.textMuted }}>{t === NATIVE_NEAR ? "native" : short(t)}</span>
              </button>
            ))}
          </div>
          <div className="mt-2 pt-2 flex flex-col gap-1.5" style={{ borderTop: `1px solid ${P.panelBorder}` }}>
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && isTokenId(text.trim().toLowerCase()) && add()}
              placeholder="Paste token contract, e.g. token.near"
              spellCheck={false}
              autoCapitalize="none"
              className="w-full rounded-lg px-2.5 py-2 text-[12px] font-mono outline-none"
              style={{ background: P.input, border: `1px solid ${P.panelBorder}`, color: P.textPrimary }}
            />
            <button
              onClick={add}
              disabled={!isTokenId(text.trim().toLowerCase()) || state.status === "loading"}
              className="w-full py-2 rounded-lg text-[12px] font-semibold"
              style={{ background: isTokenId(text.trim().toLowerCase()) ? P.ctaBg : P.ctaDisabledBg, color: isTokenId(text.trim().toLowerCase()) ? P.ctaText : P.ctaDisabledText }}
            >
              {state.status === "loading" ? "Checking token…" : "Add token"}
            </button>
            {state.status === "error" && <div className="text-[11px]" style={{ color: "#D92D20" }}>{state.error}</div>}
          </div>
        </div>
      )}
    </div>
  );
}

function NearChart({ P, tokenId }) {
  const [pair, setPair] = useState({ status: "idle" });
  useEffect(() => {
    if (!tokenId) return setPair({ status: "idle" });
    let cancelled = false;
    setPair({ status: "loading" });
    resolveDexScreenerPair({ chainKey: "near", tokenAddress: tokenId }).then((p) => !cancelled && setPair(p ? { status: "ok", ...p } : { status: "none" }));
    return () => {
      cancelled = true;
    };
  }, [tokenId]);
  return (
    <div className="rounded-2xl overflow-hidden mb-3" style={{ background: "#0B0E11", border: `1px solid ${P.panelBorder}`, height: 360 }}>
      {pair.status === "ok" ? (
        <iframe title="NEAR token chart" src={dexScreenerEmbedUrl({ chainId: pair.chainId, pairAddress: pair.pairAddress, intervalLabel: "1H" })} className="w-full h-full" style={{ border: 0 }} />
      ) : (
        <div className="w-full h-full flex items-center justify-center text-[12.5px]" style={{ color: "#8B8B93" }}>
          {pair.status === "loading" ? "Loading chart…" : "No chart for this token yet."}
        </div>
      )}
    </div>
  );
}

export default function NearSwapPanel({ P, slippageBps }) {
  const wallet = useNearWallet();
  const accountId = wallet.account?.accountId;
  const slippage = Number.isFinite(Number(slippageBps)) && slippageBps !== null ? Number(slippageBps) : 100;

  const [custom, setCustom] = useState(loadCustom);
  const tokens = useMemo(() => [...DEFAULT_TOKENS, ...custom.filter((t) => !DEFAULT_TOKENS.includes(t))], [custom]);
  const [metas, setMetas] = useState({ [NATIVE_NEAR]: NEAR_META });
  const [payToken, setPayToken] = useState(NATIVE_NEAR);
  const [receiveToken, setReceiveToken] = useState(USDC_NEAR);
  const [amount, setAmount] = useState("");
  const [balances, setBalances] = useState({});
  const [quote, setQuote] = useState({ status: "idle" });
  const [confirm, setConfirm] = useState(null);
  const [result, setResult] = useState(null);
  const [balanceTick, setBalanceTick] = useState(0);
  const quoteId = useRef(0);

  // Token metadata for everything in the list.
  useEffect(() => {
    for (const t of tokens) {
      if (metas[t]) continue;
      fetchTokenMeta(nearView, t)
        .then((m) => setMetas((prev) => ({ ...prev, [t]: m })))
        .catch(() => {});
    }
  }, [tokens]); // eslint-disable-line react-hooks/exhaustive-deps

  async function addToken(id) {
    const m = await fetchTokenMeta(nearView, id);
    setMetas((prev) => ({ ...prev, [id]: m }));
    if (!tokens.includes(id)) {
      const next = [...custom, id];
      setCustom(next);
      saveCustom(next);
    }
    return m;
  }

  // Balances of the two selected tokens.
  useEffect(() => {
    if (!accountId) return setBalances({});
    let cancelled = false;
    for (const t of [payToken, receiveToken]) {
      fetchBalance(t, accountId)
        .then((b) => !cancelled && setBalances((prev) => ({ ...prev, [t]: b })))
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [accountId, payToken, receiveToken, balanceTick]);

  const payMeta = metas[payToken];
  const receiveMeta = metas[receiveToken];
  const amountRaw = useMemo(() => {
    if (!payMeta || !amount || !/^\d*\.?\d*$/.test(amount)) return null;
    try {
      const v = parseUnits(amount, payMeta.decimals);
      return v > 0n ? v : null;
    } catch {
      return null;
    }
  }, [amount, payMeta]);

  const payBalance = balances[payToken] != null ? BigInt(balances[payToken]) : null;
  const spendable = payBalance == null ? null : payToken === NATIVE_NEAR ? (payBalance > NEAR_GAS_RESERVE ? payBalance - NEAR_GAS_RESERVE : 0n) : payBalance;
  const insufficient = amountRaw != null && spendable != null && amountRaw > spendable;

  // Live quote (fee comes off the input first).
  useEffect(() => {
    if (!amountRaw || payToken === receiveToken || routingId(payToken) === routingId(receiveToken)) return setQuote({ status: "idle" });
    const id = ++quoteId.current;
    setQuote({ status: "loading" });
    const t = setTimeout(async () => {
      try {
        const { swapAmount } = splitFee(amountRaw);
        try {
          const routes = await fetchIntearRoutes({ tokenIn: payToken, tokenOut: receiveToken, amountIn: swapAmount, slippageBps: slippage, accountId });
          const picked = pickSafeRoute(routes, { accountId, tokenIn: payToken, tokenOut: receiveToken, amountIn: swapAmount });
          if (id !== quoteId.current) return;
          if (picked) return setQuote({ status: "ok", source: "intear", label: picked.label, amountOut: picked.amountOut, minOut: picked.minOut, swapAmount, impact: null });
        } catch {
          // aggregator unreachable — fall back to the Rhea engine
        }
        const pools = await fetchAllPools(nearView);
        const best = await bestRoute(nearView, pools, routingId(payToken), routingId(receiveToken), swapAmount);
        if (id !== quoteId.current) return;
        if (!best) return setQuote({ status: "none" });
        setQuote({ status: "ok", source: "rhea", label: "Rhea", ...best, minOut: minOutFor(best.amountOut, slippage), swapAmount, impact: priceImpactBps(best.route, swapAmount, best.amountOut) });
      } catch (e) {
        if (id === quoteId.current) setQuote({ status: "error", error: /fetch|network|timeout/i.test(e?.message || "") ? "Couldn't reach NEAR to get a price — try again shortly." : e?.message || "Couldn't get a price." });
      }
    }, 500);
    return () => clearTimeout(t);
  }, [amountRaw, payToken, receiveToken, accountId, slippage]);

  function setMax() {
    if (spendable == null || !payMeta) return;
    setAmount(formatUnits(spendable, payMeta.decimals));
  }

  function flip() {
    setPayToken(receiveToken);
    setReceiveToken(payToken);
    setAmount("");
  }

  const routeText = quote.status === "ok" && quote.source === "intear" ? `${payMeta?.symbol} → ${receiveMeta?.symbol} via ${quote.label}` : quote.status === "ok" ? [quote.route[0].tokenIn, ...quote.route.map((h) => h.tokenOut)].map((t, i, arr) => (i === 0 ? payMeta?.symbol : i === arr.length - 1 ? receiveMeta?.symbol : HUB_SYMBOL[t] ?? short(t))).join(" → ") : null;

  const blocker = !accountId
    ? null
    : routingId(payToken) === routingId(receiveToken)
      ? "Pick two different tokens"
      : !amountRaw
        ? "Enter an amount"
        : insufficient
          ? payToken === NATIVE_NEAR
            ? "Not enough NEAR (0.25 NEAR is kept for fees)"
            : `Insufficient ${payMeta?.symbol ?? ""} balance`
          : quote.status === "loading"
            ? "Getting a price…"
            : quote.status === "none"
              ? "No route for this pair on any NEAR DEX"
              : quote.status === "error"
                ? "Couldn't get a price — try again"
                : quote.status !== "ok"
                  ? "Getting a price…"
                  : null;

  async function openConfirm() {
    setConfirm({ status: "checking" });
    if (quote.source === "intear") {
      try {
        // A fresh route for this exact account (includes its storage
        // registrations), re-checked, plus Mango's fee as the last step.
        const { swapAmount, fee } = splitFee(amountRaw);
        const routes = await fetchIntearRoutes({ tokenIn: payToken, tokenOut: receiveToken, amountIn: swapAmount, slippageBps: slippage, accountId });
        const picked = pickSafeRoute(routes, { accountId, tokenIn: payToken, tokenOut: receiveToken, amountIn: swapAmount });
        if (!picked) throw new Error("No safe route right now — try again.");
        const feeRegistration = payToken === NATIVE_NEAR ? null : await registrationNeed(nearView, payToken, NEAR_SWAP_FEE_ACCOUNT);
        const feeTx = feeTransaction({ tokenIn: payToken, fee, feeAccount: NEAR_SWAP_FEE_ACCOUNT, feeRegistration });
        const txs = feeTx ? [...picked.txs, feeTx] : picked.txs;
        const storageCost =
          picked.txs.flatMap((t) => t.actions).filter((a) => a.params?.methodName === "storage_deposit").reduce((sum, a) => sum + BigInt(a.params.deposit), 0n) +
          (feeRegistration?.needed ? feeRegistration.deposit : 0n);
        setConfirm({ status: "ready", txs, feeIndex: feeTx ? txs.length - 1 : null, label: picked.label, amountOut: picked.amountOut, minOut: picked.minOut, storageCost, fee, impact: null });
      } catch (e) {
        setConfirm({ status: "error", error: e?.message || "Couldn't prepare this swap." });
      }
      return;
    }
    try {
      // Fresh pool state for this exact route, then a fresh minimum.
      const fresh = await refreshPools(nearView, quote.route.map((h) => h.pool.id));
      const route = quote.route.map((h, i) => ({ ...h, pool: fresh[i] }));
      const { swapAmount } = splitFee(amountRaw);
      const q = await quoteRoute(nearView, route, swapAmount);
      if (q.amountOut <= 0n) throw new Error("This route no longer returns anything.");
      const minOut = minOutFor(q.amountOut, slippage);
      const [userOnOut, userOnWrapIn, feeOnIn] = await Promise.all([
        receiveToken === NATIVE_NEAR ? Promise.resolve({ needed: false, deposit: 0n }) : registrationNeed(nearView, routingId(receiveToken), accountId),
        payToken === NATIVE_NEAR ? registrationNeed(nearView, WRAP_NEAR, accountId) : Promise.resolve({ needed: false, deposit: 0n }),
        registrationNeed(nearView, routingId(payToken), NEAR_SWAP_FEE_ACCOUNT),
      ]);
      const txs = buildSwapTransactions({ accountId, payToken, receiveToken, amountIn: amountRaw, route, minOut, userOnOut, userOnWrapIn, feeOnIn });
      const storageCost = [userOnOut, userOnWrapIn, feeOnIn].reduce((s, r) => s + (r.needed ? r.deposit : 0n), 0n);
      setConfirm({ status: "ready", txs, route, amountOut: q.amountOut, minOut, storageCost, fee: splitFee(amountRaw).fee, impact: priceImpactBps(route, swapAmount, q.amountOut) });
    } catch (e) {
      setConfirm({ status: "error", error: e?.message || "Couldn't prepare this swap." });
    }
  }

  async function sign() {
    const c = confirm;
    setConfirm({ ...c, status: "signing" });
    try {
      const outcomes = await wallet.signAndSendTransactions(c.txs);
      const { status, hashes } = classifySwapOutcomes(c.txs, outcomes, { skip: c.feeIndex == null ? [] : [c.feeIndex] });
      const text = {
        ok: `Swapped ${fmtAmount(amountRaw, payMeta.decimals)} ${payMeta.symbol} for at least ${fmtAmount(c.minOut, receiveMeta.decimals)} ${receiveMeta.symbol}.`,
        partial: `Part of your swap went through; the exchange returned the ${payMeta.symbol} it didn't use.`,
        refunded: `The price moved past your slippage limit, so the exchange cancelled the swap and returned your ${payMeta.symbol}. Network gas and Mango's 0.5% fee aren't refunded.`,
        failed: "The swap transaction failed. Any tokens it didn't use were returned.",
        unknown: "Sent. Your wallet didn't report the result — check your balance or the transaction on NearBlocks.",
      }[status];
      setResult({ ok: status === "ok" || status === "partial", neutral: status === "unknown", hashes, text });
      setConfirm(null);
      setAmount("");
      setTimeout(() => setBalanceTick((n) => n + 1), 2500);
    } catch (e) {
      const msg = e?.message || "";
      setConfirm({ ...c, status: "error", error: /reject|cancel|denied/i.test(msg) ? "You declined in your wallet — nothing was sent." : msg || "The wallet couldn't send this swap." });
    }
  }

  const chartToken = [receiveToken, payToken].find((t) => ![NATIVE_NEAR, USDC_NEAR, USDT_NEAR].includes(t)) ?? WRAP_NEAR;
  const card = { background: P.panel, border: `1px solid ${P.panelBorder}` };
  const box = { background: P.input, border: `1px solid ${P.panelBorder}` };

  return (
    <div className="flex flex-col gap-3">
      <NearChart P={P} tokenId={chartToken} />

      {/* No wallet card here: on Swap the header's Connect button is the
          one place to connect (NEAR wallets only when swapping on NEAR),
          and its account pill shows the connected NEAR account. */}
      {wallet.status === "error" && <div className="text-[11px]" style={{ color: "#D92D20" }}>{wallet.error}</div>}

      <div className="rounded-2xl p-4" style={card}>
        <div className="flex items-center justify-between mb-2">
          <span className="text-[12.5px] font-medium" style={{ color: P.textSecondary }}>You pay</span>
          {accountId && payBalance != null && (
            <button onClick={setMax} className="text-[11.5px]" style={{ color: P.textMuted }}>
              Balance: {fmtAmount(payBalance, payMeta?.decimals ?? 24)} · <span style={{ color: P.ctaBg }}>MAX</span>
            </button>
          )}
        </div>
        <div className="flex items-center justify-between rounded-xl px-3.5 py-3 gap-2" style={box}>
          <input
            value={amount}
            onChange={(e) => /^\d*\.?\d*$/.test(e.target.value) && setAmount(e.target.value)}
            placeholder="0"
            inputMode="decimal"
            className="min-w-0 flex-1 bg-transparent outline-none font-display text-[24px] font-semibold"
            style={{ color: P.textPrimary }}
          />
          <TokenPicker P={P} value={payToken} metas={metas} tokens={tokens} onPick={setPayToken} onAdd={addToken} exclude={receiveToken} />
        </div>
        {insufficient && <div className="text-[11.5px] mt-1.5" style={{ color: "#D92D20" }}>{blocker}</div>}
      </div>

      <div className="flex justify-center -my-4 relative z-10">
        <button onClick={flip} className="w-9 h-9 rounded-xl flex items-center justify-center shadow-sm text-[15px]" style={{ background: P.ctaBg, color: P.ctaText }} aria-label="Swap direction">⇅</button>
      </div>

      <div className="rounded-2xl p-4" style={card}>
        <div className="flex items-center justify-between mb-2">
          <span className="text-[12.5px] font-medium" style={{ color: P.textSecondary }}>You receive</span>
          {accountId && balances[receiveToken] != null && receiveMeta && (
            <span className="text-[11.5px]" style={{ color: P.textMuted }}>Balance: {fmtAmount(balances[receiveToken], receiveMeta.decimals)}</span>
          )}
        </div>
        <div className="flex items-center justify-between rounded-xl px-3.5 py-3 gap-2" style={box}>
          <span className="font-display text-[24px] font-semibold truncate" style={{ color: quote.status === "ok" ? P.textPrimary : P.textMuted }}>
            {quote.status === "ok" && receiveMeta ? fmtAmount(quote.amountOut, receiveMeta.decimals) : quote.status === "loading" ? "…" : "0"}
          </span>
          <TokenPicker P={P} value={receiveToken} metas={metas} tokens={tokens} onPick={setReceiveToken} onAdd={addToken} exclude={payToken} />
        </div>
      </div>

      {quote.status === "ok" && receiveMeta && (
        <div className="rounded-xl px-3.5 py-3 flex flex-col gap-1.5 text-[12px]" style={box}>
          <div className="flex justify-between gap-3"><span style={{ color: P.textSecondary }}>Route</span><span className="text-right" style={{ color: P.textPrimary }}>{routeText}</span></div>
          <div className="flex justify-between"><span style={{ color: P.textSecondary }}>Minimum received ({slippage / 100}% slippage)</span><span className="font-mono" style={{ color: P.textPrimary }}>{fmtAmount(quote.minOut, receiveMeta.decimals)}</span></div>
          <div className="flex justify-between"><span style={{ color: P.textSecondary }}>Mango fee (0.5%)</span><span className="font-mono" style={{ color: P.textPrimary }}>{fmtAmount(splitFee(amountRaw).fee, payMeta.decimals)} {payMeta.symbol}</span></div>
          {quote.impact != null && (
            <div className="flex justify-between"><span style={{ color: P.textSecondary }}>Price impact</span><span className="font-mono" style={{ color: quote.impact > 1500 ? "#D92D20" : quote.impact > 500 ? "#F0B84D" : P.textPrimary }}>{(quote.impact / 100).toFixed(2)}%</span></div>
          )}
        </div>
      )}
      {quote.status === "ok" && quote.impact > 500 && (
        <div className="text-[11.5px]" style={{ color: quote.impact > 1500 ? "#D92D20" : "#F0B84D" }}>
          High price impact — this pool is thin for this size. Consider a smaller amount.
        </div>
      )}
      {quote.status === "error" && <div className="text-[11.5px]" style={{ color: "#D92D20" }}>{quote.error}</div>}

      {!accountId && (
        <div className="text-center text-[12px]" style={{ color: P.textMuted }}>Connect your NEAR wallet with the Connect button at the top.</div>
      )}
      {accountId && (
        <button
          disabled={!!blocker}
          onClick={openConfirm}
          className="w-full py-3.5 rounded-full font-display font-semibold text-[15px]"
          style={{ background: blocker ? P.ctaDisabledBg : P.ctaBg, color: blocker ? P.ctaDisabledText : P.ctaText, cursor: blocker ? "not-allowed" : "pointer" }}
        >
          {blocker ?? "Swap"}
        </button>
      )}

      {result && (
        <div className="rounded-xl px-3.5 py-3 text-[12px] flex flex-col gap-1" style={{ ...box, borderColor: result.ok ? "#00D67D" : result.neutral ? P.panelBorder : "#D92D20" }}>
          <div style={{ color: P.textPrimary }}>{result.text}</div>
          {result.hashes.map((h) => (
            <a key={h} href={`https://nearblocks.io/txns/${h}`} target="_blank" rel="noopener noreferrer" style={{ color: P.ctaBg }}>View {short(h)} on NearBlocks</a>
          ))}
          <button onClick={() => setResult(null)} className="self-start text-[11.5px] underline mt-1" style={{ color: P.textMuted }}>Dismiss</button>
        </div>
      )}

      <div className="text-center text-[11.5px]" style={{ color: P.textMuted }}>
        Best price across NEAR DEXes (Rhea, Rhea DCL, Intear DEX, Aidols, Meta Pool, LiNEAR and more), signed in your own NEAR wallet. You pay NEAR gas; first-time token registration costs a small NEAR deposit.
      </div>

      {confirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.55)" }}>
          <div className="w-full max-w-sm rounded-2xl p-5 flex flex-col gap-3" style={{ background: P.bg, border: `1px solid ${P.panelBorder}` }}>
            <div className="font-display text-[17px] font-semibold" style={{ color: P.textPrimary }}>Confirm swap</div>
            {confirm.status === "checking" && <div className="text-[13px]" style={{ color: P.textSecondary }}>Re-checking the price…</div>}
            {(confirm.status === "ready" || confirm.status === "signing") && (
              <div className="flex flex-col gap-1.5 text-[12.5px]">
                <div className="flex justify-between"><span style={{ color: P.textSecondary }}>You pay</span><span className="font-mono" style={{ color: P.textPrimary }}>{fmtAmount(amountRaw, payMeta.decimals)} {payMeta.symbol}</span></div>
                <div className="flex justify-between"><span style={{ color: P.textSecondary }}>You receive (est.)</span><span className="font-mono" style={{ color: P.textPrimary }}>{fmtAmount(confirm.amountOut, receiveMeta.decimals)} {receiveMeta.symbol}</span></div>
                <div className="flex justify-between"><span style={{ color: P.textSecondary }}>Minimum</span><span className="font-mono" style={{ color: P.textPrimary }}>{fmtAmount(confirm.minOut, receiveMeta.decimals)} {receiveMeta.symbol}</span></div>
                {confirm.label && <div className="flex justify-between"><span style={{ color: P.textSecondary }}>Via</span><span style={{ color: P.textPrimary }}>{confirm.label}</span></div>}
                <div className="flex justify-between"><span style={{ color: P.textSecondary }}>Mango fee</span><span className="font-mono" style={{ color: P.textPrimary }}>{fmtAmount(confirm.fee, payMeta.decimals)} {payMeta.symbol}</span></div>
                {confirm.storageCost > 0n && (
                  <div className="flex justify-between"><span style={{ color: P.textSecondary }}>Token registration</span><span className="font-mono" style={{ color: P.textPrimary }}>{fmtAmount(confirm.storageCost, 24)} NEAR</span></div>
                )}
                {confirm.impact != null && confirm.impact > 500 && (
                  <div className="text-[11.5px]" style={{ color: confirm.impact > 1500 ? "#D92D20" : "#F0B84D" }}>Price impact {(confirm.impact / 100).toFixed(2)}%.</div>
                )}
                <div className="text-[11px] mt-1" style={{ color: P.textMuted }}>
                  Your wallet will ask you to approve {confirm.txs.length} transaction{confirm.txs.length > 1 ? "s" : ""}. If the price moves past the minimum, the swap fails and your tokens stay with you.
                </div>
              </div>
            )}
            {confirm.status === "error" && <div className="text-[12.5px]" style={{ color: "#D92D20" }}>{confirm.error}</div>}
            <div className="flex gap-2 mt-1">
              <button onClick={() => setConfirm(null)} disabled={confirm.status === "signing"} className="flex-1 py-3 rounded-full text-[14px] font-semibold" style={{ background: P.input, color: P.textPrimary, border: `1px solid ${P.panelBorder}` }}>
                {confirm.status === "error" ? "Close" : "Cancel"}
              </button>
              {confirm.status !== "error" && (
                <button onClick={sign} disabled={confirm.status !== "ready"} className="flex-1 py-3 rounded-full text-[14px] font-semibold" style={{ background: confirm.status === "ready" ? P.ctaBg : P.ctaDisabledBg, color: confirm.status === "ready" ? P.ctaText : P.ctaDisabledText }}>
                  {confirm.status === "signing" ? "Confirm in wallet…" : "Swap"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
