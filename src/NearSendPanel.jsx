// src/NearSendPanel.jsx
//
// The Bridge tab when NEAR is picked under "You send": pay NEAR, USDC or
// USDT from the user's own NEAR wallet and receive USDC or the chain's
// native coin on Ethereum, Base, Arbitrum, BNB Chain or Avalanche.
// Mirror image of NearIntentsSection.jsx (which receives on NEAR), same
// route (NEAR Intents 1Click through Mango's proxy) and the same safety
// rules from nearIntents.js: 1Click's quote signature verified against
// its pinned key, request echo, exact Mango fee, deadline margin, the
// signed quote saved before paying, one payment per quote. Refunds go
// back to the user's own NEAR account.
//
// The NEAR-side deposit is one transaction on the token contract:
// [wrap NEAR if paying NEAR] + [register the one-time deposit address on
// the token] + ft_transfer of exactly quote.amountIn to it.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { parseUnits, formatUnits, isAddress } from "viem";
import NearTokenPicker from "./NearTokenPicker.jsx";
import { BridgeCard, AmountBox, MaxButton, FlipArrow, FeeRow, DetailsPanel, DetailRow, CtaButton, FootNote } from "./swapUi.jsx";
import { NATIVE_SYMBOL, TOKEN_ADDRESSES } from "./chainData.js";
import { nearView, nearAvailableBalance } from "./nearRpc.js";
import { useNearWallet } from "./nearWallet.js";
import { NATIVE_NEAR, USDC_NEAR, USDT_NEAR, WRAP_NEAR, NEAR_GAS_RESERVE, registrationNeed } from "./rheaSwap.js";
import {
  NEAR_ORIGIN_BLOCKCHAIN,
  NEAR_QUOTE_DEADLINE_MS,
  NearSendRejectedError,
  applyStatus,
  assertQuoteSafeToFund,
  createLocalNearSwapStore,
  fetchNearStatus,
  fetchNearTokens,
  findOneClickAssetId,
  fundNearQuote,
  isFinalStatus,
  nearAppFees,
  requestNearQuote,
  shouldPollNearSwap,
  submitNearDepositTx,
} from "./nearIntents.js";

const SLIPPAGE_BPS = 100;
const PAY_OPTIONS = [
  { id: NATIVE_NEAR, symbol: "NEAR", contract: WRAP_NEAR, decimals: 24 },
  { id: USDC_NEAR, symbol: "USDC", contract: USDC_NEAR, decimals: 6 },
  { id: USDT_NEAR, symbol: "USDT", contract: USDT_NEAR, decimals: 6 },
];
const DEST_CHAINS = Object.keys(NEAR_ORIGIN_BLOCKCHAIN); // ethereum, base, arbitrum, bnb, avalanche
const CHAIN_NAME = { ethereum: "Ethereum", base: "Base", arbitrum: "Arbitrum", bnb: "BNB Chain", avalanche: "Avalanche" };
const TGAS = 1000000000000n;

const STATUS_TEXT = {
  SENDING: "Sending your deposit from NEAR…",
  SEND_FAILED: "The deposit didn't go through from this browser. If your NEAR wallet shows it was sent, it will still be picked up.",
  PENDING_DEPOSIT: "Deposit sent — waiting for NEAR Intents to see it.",
  KNOWN_DEPOSIT_TX: "Deposit seen — waiting for confirmations.",
  INCOMPLETE_DEPOSIT: "The deposit was less than quoted. It will be refunded if not topped up before the deadline.",
  PROCESSING: "Swapping and delivering…",
  SUCCESS: "Delivered.",
  REFUNDED: "Refunded to your NEAR wallet.",
  FAILED: "NEAR Intents couldn't complete this transfer.",
};

let tokensPromise = null;
function loadTokens() {
  if (!tokensPromise) tokensPromise = fetchNearTokens().catch((e) => ((tokensPromise = null), Promise.reject(e)));
  return tokensPromise;
}

function short(v) {
  return typeof v === "string" && v.length > 16 ? `${v.slice(0, 8)}…${v.slice(-6)}` : v;
}
function fmt(raw, decimals, max = 6) {
  const [w, f = ""] = formatUnits(BigInt(raw), decimals).split(".");
  const frac = f.slice(0, max).replace(/0+$/, "");
  return `${Number(w).toLocaleString()}${frac ? `.${frac}` : ""}`;
}
function call(methodName, args, gasTgas, deposit) {
  return { type: "FunctionCall", params: { methodName, args, gas: (BigInt(gasTgas) * TGAS).toString(), deposit: deposit.toString() } };
}

// What you can pay with, as NEAR token ids, for the shared NEAR picker.
const PAY_TOKENS = PAY_OPTIONS.map((p) => p.id);
const PAY_METAS = Object.fromEntries(PAY_OPTIONS.map((p) => [p.id, { symbol: p.symbol }]));

// ChainPicker (the Bridge's own network dropdown) and renderReceivePicker
// (the Bridge's own token dropdown) come from App.jsx, so this panel
// uses the same controls as every other Bridge route.
export default function NearSendPanel({ P, fromPicker, evmAddress, onConnectNear, ChainPicker, TokenIcon, renderReceivePicker, chainName = (k) => CHAIN_NAME[k] ?? k, initialDest, onFlip }) {
  const wallet = useNearWallet();
  const accountId = wallet.account?.accountId;
  const store = useMemo(() => createLocalNearSwapStore(), []);
  const [payId, setPayId] = useState(NATIVE_NEAR);
  const [amount, setAmount] = useState("");
  const [destChain, setDestChain] = useState(DEST_CHAINS.includes(initialDest) ? initialDest : "base");
  const [destSymbol, setDestSymbol] = useState("USDC");
  const [tokens, setTokens] = useState(null);
  const [tokensError, setTokensError] = useState(null);
  const [balance, setBalance] = useState(null);
  const [preview, setPreview] = useState({ status: "idle" });
  const [confirm, setConfirm] = useState(null);
  const [activeSwap, setActiveSwap] = useState(null);
  const previewId = useRef(0);

  const pay = PAY_OPTIONS.find((p) => p.id === payId);
  const to = evmAddress || "";
  const recipientValid = isAddress(to);

  useEffect(() => {
    loadTokens().then(setTokens).catch(() => setTokensError("NEAR routes are unavailable right now — couldn't reach NEAR Intents. Try again shortly."));
    const unfinished = store.list().find((r) => shouldPollNearSwap(r) && r.fromChain === "near");
    if (unfinished) setActiveSwap(unfinished);
  }, [store]);

  useEffect(() => {
    if (!accountId) return setBalance(null);
    let cancelled = false;
    (payId === NATIVE_NEAR ? nearAvailableBalance(accountId) : nearView(pay.contract, "ft_balance_of", { account_id: accountId }))
      .then((b) => !cancelled && setBalance(BigInt(b ?? "0")))
      .catch(() => !cancelled && setBalance(null));
    return () => {
      cancelled = true;
    };
  }, [accountId, payId, pay.contract, activeSwap?.status]);

  const route = useMemo(() => {
    if (!tokens) return null;
    const origin = findOneClickAssetId(tokens, "near", pay.contract);
    if (!origin) return { error: `NEAR Intents doesn't list ${pay.symbol} on NEAR right now.` };
    if (origin.decimals !== pay.decimals) return { error: `${pay.symbol} decimals don't match NEAR Intents' listing, so this route is disabled for safety.` };
    const bc = NEAR_ORIGIN_BLOCKCHAIN[destChain];
    // The chain's own coin, or the token's verified contract on that chain.
    const isNative = destSymbol === NATIVE_SYMBOL[destChain];
    const contract = TOKEN_ADDRESSES[destSymbol]?.[destChain];
    const dest = isNative ? findOneClickAssetId(tokens, bc, null, NATIVE_SYMBOL[destChain]) : contract ? findOneClickAssetId(tokens, bc, contract) : null;
    if (!dest) return { error: `NEAR Intents doesn't support ${destSymbol} on ${chainName(destChain)} — pick another token.` };
    return { originAsset: origin.assetId, destinationAsset: dest.assetId, destDecimals: dest.decimals, destSymbol: dest.symbol, price: Number(origin.price) || 0 };
  }, [tokens, pay, destChain, destSymbol]); // eslint-disable-line react-hooks/exhaustive-deps

  const amountRaw = useMemo(() => {
    if (!amount || !/^\d*\.?\d*$/.test(amount)) return null;
    try {
      const v = parseUnits(amount, pay.decimals);
      return v > 0n ? v : null;
    } catch {
      return null;
    }
  }, [amount, pay]);
  const spendable = balance == null ? null : payId === NATIVE_NEAR ? (balance > NEAR_GAS_RESERVE ? balance - NEAR_GAS_RESERVE : 0n) : balance;
  const insufficient = amountRaw != null && spendable != null && amountRaw > spendable;
  const amountUsd = amountRaw != null && route?.price ? Number(formatUnits(amountRaw, pay.decimals)) * route.price : null;

  function quoteRequest(dry) {
    return {
      dry,
      swapType: "EXACT_INPUT",
      slippageTolerance: SLIPPAGE_BPS,
      originAsset: route.originAsset,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: route.destinationAsset,
      amount: amountRaw.toString(),
      refundTo: accountId || "widekingdom6862.near",
      refundType: "ORIGIN_CHAIN",
      recipient: recipientValid ? to : "0x0000000000000000000000000000000000000001",
      recipientType: "DESTINATION_CHAIN",
      deadline: new Date(Date.now() + NEAR_QUOTE_DEADLINE_MS).toISOString(),
      appFees: nearAppFees(amountUsd),
    };
  }

  useEffect(() => {
    if (!route || route.error || !amountRaw) return setPreview({ status: "idle" });
    const id = ++previewId.current;
    setPreview({ status: "loading" });
    const t = setTimeout(() => {
      requestNearQuote(quoteRequest(true))
        .then((q) => id === previewId.current && setPreview({ status: "ok", quote: q.quote }))
        .catch((e) => id === previewId.current && setPreview({ status: "error", error: e?.message || "No route for this amount right now." }));
    }, 600);
    return () => clearTimeout(t);
  }, [route, amountRaw, accountId, recipientValid, to]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!activeSwap || !shouldPollNearSwap(activeSwap)) return;
    let stopped = false;
    const tick = async () => {
      try {
        const next = applyStatus(activeSwap, await fetchNearStatus(activeSwap.depositAddress));
        if (stopped) return;
        store.put(next);
        setActiveSwap(next);
      } catch {
        // try again next tick
      }
    };
    const h = setInterval(tick, 5000);
    tick();
    return () => {
      stopped = true;
      clearInterval(h);
    };
  }, [activeSwap?.depositAddress, activeSwap?.status, store]); // eslint-disable-line react-hooks/exhaustive-deps

  const busy = activeSwap && !isFinalStatus(activeSwap.status) && activeSwap.status !== "SEND_FAILED";
  const blocker = !accountId
    ? null
    : route?.error
      ? route.error
      : !route
        ? "Loading routes…"
        : !amountRaw
          ? "Enter an amount"
          : insufficient
            ? payId === NATIVE_NEAR
              ? "Not enough NEAR (0.25 NEAR is kept for fees)"
              : `Insufficient ${pay.symbol} balance`
            : !recipientValid
              ? "Connect an EVM wallet to receive"
              : preview.status === "error"
                ? "No route for this amount"
                : preview.status !== "ok"
                  ? "Getting a quote…"
                  : busy
                    ? "A transfer is in progress"
                    : null;

  function expected() {
    const r = quoteRequest(false);
    return { originAsset: r.originAsset, destinationAsset: r.destinationAsset, amount: r.amount, recipient: to, recipientType: "DESTINATION_CHAIN", refundTo: accountId, maxSlippageBps: SLIPPAGE_BPS, appFees: r.appFees };
  }

  async function openConfirm() {
    setConfirm({ status: "quoting" });
    try {
      const response = await requestNearQuote(quoteRequest(false));
      const exp = expected();
      assertQuoteSafeToFund(response, exp);
      // Everything the deposit needs is pinned here, so nothing typed or
      // picked after the quote can change what gets sent.
      setConfirm({ status: "ready", response, expected: exp, route, payAmount: amount, pay, destName: chainName(destChain) });
    } catch (e) {
      setConfirm({ status: "error", error: e?.message || "Couldn't get a quote." });
    }
  }

  async function sendDeposit() {
    const c = confirm;
    const pay = c.pay;
    setConfirm({ ...c, status: "paying" });
    try {
      const value = BigInt(c.response.quote.amountIn);
      const record = await fundNearQuote({
        response: c.response,
        expected: c.expected,
        fromChain: "near",
        fromSymbol: pay.symbol,
        fromAddress: accountId,
        payAmount: c.payAmount,
        store,
        submitDepositTx: submitNearDepositTx,
        send: async (depositAddress) => {
          const [depositReg, userWrapReg] = await Promise.all([
            registrationNeed(nearView, pay.contract, depositAddress),
            pay.id === NATIVE_NEAR ? registrationNeed(nearView, WRAP_NEAR, accountId) : Promise.resolve({ needed: false, deposit: 0n }),
          ]);
          const actions = [];
          if (pay.id === NATIVE_NEAR) actions.push(call("near_deposit", {}, 10, value + (userWrapReg.needed ? userWrapReg.deposit : 0n)));
          if (depositReg.needed) actions.push(call("storage_deposit", { account_id: depositAddress, registration_only: true }, 10, depositReg.deposit));
          actions.push(call("ft_transfer", { receiver_id: depositAddress, amount: value.toString() }, 20, 1n));
          let outcomes;
          try {
            outcomes = await wallet.signAndSendTransactions([{ receiverId: pay.contract, actions }]);
          } catch (e) {
            if (/reject|cancel|denied/i.test(e?.message || "")) throw new NearSendRejectedError("You declined in your NEAR wallet — nothing was sent.");
            throw e;
          }
          const outcome = Array.isArray(outcomes) ? outcomes[0] : outcomes;
          if (outcome?.status && typeof outcome.status === "object" && "Failure" in outcome.status) throw new Error("The deposit transaction failed on NEAR.");
          const hash = outcome?.transaction?.hash || outcome?.transaction_outcome?.id;
          if (!hash) throw new Error("Your wallet didn't return the transaction hash.");
          return hash;
        },
      });
      setActiveSwap(record);
      setConfirm(null);
      setAmount("");
    } catch (e) {
      const saved = store.get(c.response.quote.depositAddress);
      if (saved?.broadcastAttempted) setActiveSwap(saved);
      setConfirm({ ...c, status: "error", error: e?.message || "The deposit wasn't sent." });
    }
  }

  const box = { background: P.input, border: `1px solid ${P.panelBorder}` };
  const q = preview.status === "ok" ? preview.quote : null;
  const [detailsOpen, setDetailsOpen] = useState(false);

  return (
    <div>
      {/* The Bridge form's own pieces (swapUi.jsx + App's pickers): the
          NEAR wallet connects from the header's Connect button. */}
      <BridgeCard P={P} label="You send" right={accountId && balance != null ? `Balance: ${fmt(balance, pay.decimals)} ${pay.symbol}` : ""}>
        <div className="flex items-center justify-between mb-3">{fromPicker}</div>
        <AmountBox P={P} danger={insufficient}>
          <input
            value={amount}
            onChange={(e) => /^\d*\.?\d*$/.test(e.target.value) && setAmount(e.target.value)}
            placeholder="0"
            inputMode="decimal"
            className="font-display bg-transparent text-[24px] font-semibold w-full"
            style={{ color: P.textPrimary }}
          />
          <MaxButton P={P} disabled={spendable == null} onClick={() => spendable != null && setAmount(formatUnits(spendable, pay.decimals))} />
          <NearTokenPicker P={P} value={payId} metas={PAY_METAS} tokens={PAY_TOKENS} onPick={setPayId} TokenIcon={TokenIcon} />
        </AmountBox>
        {insufficient && <div className="text-[11.5px] mt-1.5" style={{ color: "#D92D20" }}>{blocker}</div>}
        {wallet.status === "error" && <div className="text-[11px] mt-1.5" style={{ color: "#D92D20" }}>{wallet.error}</div>}
      </BridgeCard>

      <FlipArrow P={P} onClick={() => onFlip?.(destChain)} disabled={!onFlip} title="Receive on NEAR instead" />

      <BridgeCard P={P} label="You receive" className="rounded-2xl p-4 mt-3 shadow-sm">
        <div className="flex items-center justify-between mb-3">
          {ChainPicker && <ChainPicker value={destChain} onChange={(k) => { setDestChain(k); setDestSymbol("USDC"); }} P={P} chainOrder={DEST_CHAINS} />}
        </div>
        <AmountBox P={P}>
          <span className="font-display text-[24px] font-semibold" style={{ color: q ? P.textPrimary : P.textMuted }}>{q ? q.amountOutFormatted : preview.status === "loading" ? "…" : "0"}</span>
          {renderReceivePicker?.(destSymbol, setDestSymbol, destChain)}
        </AmountBox>
        {/* Delivered only to the connected EVM wallet — no typed addresses. */}
        <div className="text-[11.5px] mt-1.5" style={{ color: P.textMuted }}>
          {evmAddress ? `Arrives at your connected wallet ${evmAddress.slice(0, 6)}…${evmAddress.slice(-4)} on ${chainName(destChain)}.` : `Connect an EVM wallet (top right) to receive on ${chainName(destChain)}.`}
        </div>
      </BridgeCard>

      <FeeRow
        P={P}
        feeLabel="Fee 0.5%"
        right={q?.timeEstimate ? `ETA: ~${Math.max(1, Math.round(q.timeEstimate / 60))} min` : "ETA: —"}
        open={detailsOpen}
        onToggle={() => setDetailsOpen((o) => !o)}
      />
      {detailsOpen && (
        <DetailsPanel P={P}>
          <DetailRow P={P} label="Route" mono={false}>NEAR → {chainName(destChain)} via NEAR Intents</DetailRow>
          <DetailRow P={P} label="Minimum received">{q && route?.destDecimals != null ? `${fmt(q.minAmountOut, route.destDecimals)} ${route.destSymbol}` : "—"}</DetailRow>
          <DetailRow P={P} label="Protocol fee (0.5%)">{amountRaw ? `${fmt((amountRaw * 50n) / 10000n, pay.decimals)} ${pay.symbol}` : "—"}</DetailRow>
          <DetailRow P={P} label="NEAR Intents fee" mono={false}>Included in the quote</DetailRow>
        </DetailsPanel>
      )}

      {tokensError && <div className="text-[11.5px] mt-2" style={{ color: "#D92D20" }}>{tokensError}</div>}
      {route?.error && <div className="text-[11.5px] mt-2" style={{ color: P.textMuted }}>{route.error}</div>}
      {preview.status === "error" && <div className="text-[11.5px] mt-2" style={{ color: "#D92D20" }}>{preview.error}</div>}

      {activeSwap && (
        <div className="mt-3 rounded-xl px-3.5 py-3 text-[12px] flex flex-col gap-1" style={{ ...box, borderColor: activeSwap.status === "SUCCESS" ? "#00D67D" : ["FAILED", "SEND_FAILED"].includes(activeSwap.status) ? "#D92D20" : P.panelBorder }}>
          <div className="font-medium" style={{ color: P.textPrimary }}>{activeSwap.payAmount} {activeSwap.fromSymbol} from NEAR → {short(activeSwap.recipient)}</div>
          <div style={{ color: P.textSecondary }}>{STATUS_TEXT[activeSwap.status] ?? activeSwap.status}</div>
          {activeSwap.amountOutFormatted && activeSwap.status === "SUCCESS" && <div style={{ color: P.textSecondary }}>Received {activeSwap.amountOutFormatted}</div>}
          {activeSwap.depositTxHash && <a href={`https://nearblocks.io/txns/${activeSwap.depositTxHash}`} target="_blank" rel="noopener noreferrer" style={{ color: P.ctaBg }}>Deposit on NearBlocks</a>}
          {isFinalStatus(activeSwap.status) && <button onClick={() => setActiveSwap(null)} className="self-start mt-1 text-[11.5px] underline" style={{ color: P.textMuted }}>Dismiss</button>}
        </div>
      )}

      {!accountId && <FootNote P={P}>Connect your NEAR wallet with the Connect button at the top.</FootNote>}
      {accountId && (
        <CtaButton P={P} disabled={!!blocker} onClick={openConfirm}>
          {blocker ?? "Send from NEAR"}
        </CtaButton>
      )}
      <FootNote P={P}>Powered by NEAR Intents. You pay NEAR gas and NEAR Intents' own fee; refunds go back to your NEAR wallet.</FootNote>

      {confirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.55)" }}>
          <div className="w-full max-w-sm rounded-2xl p-5 flex flex-col gap-3" style={{ background: P.bg, border: `1px solid ${P.panelBorder}` }}>
            <div className="font-display text-[17px] font-semibold" style={{ color: P.textPrimary }}>Send from NEAR</div>
            {confirm.status === "quoting" && <div className="text-[13px]" style={{ color: P.textSecondary }}>Getting a signed quote…</div>}
            {(confirm.status === "ready" || confirm.status === "paying") && (
              <div className="flex flex-col gap-1.5 text-[12.5px]">
                <div className="flex justify-between"><span style={{ color: P.textSecondary }}>You send</span><span className="font-mono" style={{ color: P.textPrimary }}>{confirm.payAmount} {confirm.pay.symbol}</span></div>
                <div className="flex justify-between"><span style={{ color: P.textSecondary }}>You receive (est.)</span><span className="font-mono" style={{ color: P.textPrimary }}>{confirm.response.quote.amountOutFormatted} {confirm.route.destSymbol}</span></div>
                <div className="flex justify-between"><span style={{ color: P.textSecondary }}>Minimum</span><span className="font-mono" style={{ color: P.textPrimary }}>{fmt(confirm.response.quote.minAmountOut, confirm.route.destDecimals)}</span></div>
                <div className="flex justify-between"><span style={{ color: P.textSecondary }}>To</span><span className="font-mono" style={{ color: P.textPrimary }}>{short(confirm.expected.recipient)} on {confirm.destName}</span></div>
                <div className="flex justify-between"><span style={{ color: P.textSecondary }}>Quote valid until</span><span style={{ color: P.textPrimary }}>{new Date(confirm.response.quote.deadline).toLocaleTimeString()}</span></div>
                <div className="text-[11px] mt-1" style={{ color: P.textMuted }}>Verified: signed by NEAR Intents. If it can't be completed, your {confirm.pay.symbol} is refunded to {short(accountId)}.</div>
              </div>
            )}
            {confirm.status === "error" && <div className="text-[12.5px]" style={{ color: "#D92D20" }}>{confirm.error}</div>}
            <div className="flex gap-2 mt-1">
              <button onClick={() => setConfirm(null)} disabled={confirm.status === "paying"} className="flex-1 py-3 rounded-full text-[14px] font-semibold" style={{ background: P.input, color: P.textPrimary, border: `1px solid ${P.panelBorder}` }}>{confirm.status === "error" ? "Close" : "Cancel"}</button>
              {confirm.status !== "error" && (
                <button onClick={sendDeposit} disabled={confirm.status !== "ready"} className="flex-1 py-3 rounded-full text-[14px] font-semibold" style={{ background: confirm.status === "ready" ? P.ctaBg : P.ctaDisabledBg, color: confirm.status === "ready" ? P.ctaText : P.ctaDisabledText }}>
                  {confirm.status === "paying" ? "Confirm in NEAR wallet…" : "Confirm & send"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
