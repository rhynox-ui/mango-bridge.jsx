// src/NearIntentsSection.jsx
//
// The Bridge tab's "Receive on NEAR" panel. Replaces the normal "You
// receive" card (and the Relay CTA below it) when NEAR is picked as the
// destination; the "You send" side of the form is unchanged and feeds in
// through props.
//
// Route: NEAR Intents 1Click, through Mango's proxy. The user sends the
// origin asset from their connected EVM wallet to a one-time deposit
// address and receives on their own NEAR account — normally the one
// their NEAR wallet reports when they connect it (HOT's near-connect:
// HOT, Meteor, Intear, MyNearWallet, OKX, Nightly, NEAR Mobile…), with
// typing an address kept as a fallback; they pay their own gas
// and 1Click's own small fee, on top of Mango's 0.5%. Every safety rule
// lives in nearIntents.js (signature check, request echo, fee match,
// deadline margin, save-before-send, one payment per quote); this file
// is UI and wallet calls only.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { parseUnits, formatUnits } from "viem";
import { writeContract, sendTransaction, switchChain, getAccount } from "wagmi/actions";
import { config } from "./wagmi.js";
// One shared NEAR wallet connection for the whole site (nearWallet.js).
import { useNearWallet } from "./nearWallet.js";
import NearTokenPicker from "./NearTokenPicker.jsx";
import { AmountBox } from "./swapUi.jsx";
import { MAINNET_CHAIN_IDS, NATIVE_SYMBOL, TOKEN_ADDRESSES } from "./chainData.js";
import {
  NEAR_DESTINATION_ASSETS,
  NEAR_ORIGIN_BLOCKCHAIN,
  NEAR_QUOTE_DEADLINE_MS,
  applyStatus,
  createLocalNearSwapStore,
  fetchNearStatus,
  fetchNearTokens,
  findOneClickAssetId,
  fundNearQuote,
  isFinalStatus,
  isNearIntentsAccountId,
  nearAccountExists,
  nearAppFees,
  requestNearQuote,
  shouldPollNearSwap,
  submitNearDepositTx,
  assertQuoteSafeToFund,
  NEAR_FEE_ACCOUNT,
  NearSendRejectedError,
} from "./nearIntents.js";

const SLIPPAGE_BPS = 100;
const ERC20_TRANSFER_ABI = [
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
];

// Receiving needs no signature, so only the account id is ever read from
// the NEAR wallet; the confirm screen still shows that account before
// anything is sent.

let tokensPromise = null;
function loadTokens() {
  if (!tokensPromise) {
    tokensPromise = fetchNearTokens().catch((err) => {
      tokensPromise = null;
      throw err;
    });
  }
  return tokensPromise;
}

const STATUS_TEXT = {
  SENDING: "Sending your deposit…",
  SEND_FAILED: "The deposit didn't go through from this browser. If your wallet shows it was sent, it will still be picked up.",
  PENDING_DEPOSIT: "Deposit sent — waiting for NEAR Intents to see it.",
  KNOWN_DEPOSIT_TX: "Deposit seen — waiting for confirmations.",
  INCOMPLETE_DEPOSIT: "The deposit was less than quoted. It will be refunded if not topped up before the deadline.",
  PROCESSING: "Swapping and delivering on NEAR…",
  SUCCESS: "Delivered on NEAR.",
  REFUNDED: "Refunded to your wallet on the origin chain.",
  FAILED: "NEAR Intents couldn't complete this swap.",
};

// viem wraps a wallet's "Reject" (EIP-1193 code 4001) in its own error
// types; walk the cause chain for it.
function isUserRejection(err) {
  for (let e = err; e; e = e.cause) {
    if (e.name === "UserRejectedRequestError" || e.code === 4001) return true;
  }
  return false;
}

function short(value) {
  return typeof value === "string" && value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

export default function NearIntentsSection({ P, from, fromAsset, amount, amtNum, insufficient, originDecimals, evmAddress, connected, isFromSolana, originAmountUsd, onConnectNear, TokenIcon }) {
  const [destSymbol, setDestSymbol] = useState("USDC");
  const sharedNear = useNearWallet();
  // Only an account id that 1Click can deliver to counts as connected here.
  const nearWallet = sharedNear.account && isNearIntentsAccountId(sharedNear.account.accountId) ? sharedNear.account : null; // { accountId, name }
  const [addressState, setAddressState] = useState({ status: "idle" });
  const [tokens, setTokens] = useState(null);
  const [tokensError, setTokensError] = useState(null);
  const [preview, setPreview] = useState({ status: "idle" });
  const [confirm, setConfirm] = useState(null); // { status, quote?, error? }
  const [activeSwap, setActiveSwap] = useState(null);
  const store = useMemo(() => createLocalNearSwapStore(), []);
  const previewId = useRef(0);

  const blockchain = NEAR_ORIGIN_BLOCKCHAIN[from];
  // Where the NEAR side is delivered: only ever the connected NEAR
  // wallet's own account — no typed addresses. Every check below runs on
  // this value.
  const trimmedAddress = nearWallet?.accountId ?? "";
  // Previews only need a valid recipient, not the user's — requote when
  // their address is confirmed, not on every keystroke.
  const previewRecipient = addressState.status === "ok" ? trimmedAddress : NEAR_FEE_ACCOUNT;

  useEffect(() => {
    loadTokens().then(setTokens).catch(() => setTokensError("NEAR routes are unavailable right now — couldn't reach NEAR Intents. Try again shortly."));
  }, []);

  function connectNearWallet() {
    if (onConnectNear) onConnectNear();
    else sharedNear.connect();
  }
  const disconnectNearWallet = sharedNear.disconnect;

  // Resume the most recent unfinished NEAR swap from this browser.
  useEffect(() => {
    const unfinished = store.list().find((r) => shouldPollNearSwap(r));
    if (unfinished) setActiveSwap(unfinished);
  }, [store]);

  // Origin / destination assets, resolved against 1Click's live list by
  // exact contract (or native symbol), with decimals cross-checked
  // against what the "You send" amount is parsed with.
  const route = useMemo(() => {
    if (isFromSolana) return { error: "Receiving on NEAR from Solana isn't supported yet — pick an EVM chain to send from." };
    if (!blockchain) return { error: "Receiving on NEAR works from Ethereum, Base, Arbitrum, BNB Chain and Avalanche." };
    if (fromAsset?.custom) return { error: "Pick a listed asset to send to NEAR." };
    if (!tokens) return null;
    const isNative = fromAsset.symbol === NATIVE_SYMBOL[from];
    const contract = isNative ? null : TOKEN_ADDRESSES[fromAsset.symbol]?.[from];
    if (!isNative && !contract) return { error: `${fromAsset.symbol} on this chain isn't available for NEAR routes.` };
    const origin = findOneClickAssetId(tokens, blockchain, contract, fromAsset.symbol);
    if (!origin) return { error: `NEAR Intents doesn't list ${fromAsset.symbol} on this chain.` };
    if (origin.decimals !== originDecimals) return { error: `${fromAsset.symbol} decimals don't match NEAR Intents' listing, so this route is disabled for safety.` };
    const destDef = NEAR_DESTINATION_ASSETS.find((a) => a.symbol === destSymbol);
    const dest = findOneClickAssetId(tokens, "near", destDef.contract);
    if (!dest) return { error: `${destDef.label} isn't available on NEAR Intents right now.` };
    return { originAsset: origin.assetId, destinationAsset: dest.assetId, isNative, contract, destDef, destDecimals: dest.decimals };
  }, [isFromSolana, blockchain, fromAsset, tokens, from, originDecimals, destSymbol]);

  const amountBaseUnits = useMemo(() => {
    if (!(amtNum > 0) || !Number.isInteger(originDecimals)) return null;
    try {
      const v = parseUnits(amount, originDecimals);
      return v > 0n ? v.toString() : null;
    } catch {
      return null;
    }
  }, [amount, amtNum, originDecimals]);

  // Address: format first, then — for named accounts — that it exists.
  useEffect(() => {
    if (!trimmedAddress) return setAddressState({ status: "idle" });
    if (!isNearIntentsAccountId(trimmedAddress)) return setAddressState({ status: "invalid" });
    let cancelled = false;
    setAddressState({ status: "checking" });
    const t = setTimeout(() => {
      nearAccountExists(trimmedAddress).then((exists) => {
        if (cancelled) return;
        setAddressState({ status: exists === true ? "ok" : exists === false ? "missing" : "unverified" });
      });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [trimmedAddress]);

  // Preview (dry quote): no deposit address, nothing to pay.
  useEffect(() => {
    if (!route || route.error || !amountBaseUnits) return setPreview({ status: "idle" });
    const id = ++previewId.current;
    setPreview({ status: "loading" });
    const t = setTimeout(() => {
      requestNearQuote({
        dry: true,
        swapType: "EXACT_INPUT",
        slippageTolerance: SLIPPAGE_BPS,
        originAsset: route.originAsset,
        depositType: "ORIGIN_CHAIN",
        destinationAsset: route.destinationAsset,
        amount: amountBaseUnits,
        refundTo: evmAddress || "0x0000000000000000000000000000000000000001",
        refundType: "ORIGIN_CHAIN",
        recipient: previewRecipient,
        recipientType: "DESTINATION_CHAIN",
        deadline: new Date(Date.now() + NEAR_QUOTE_DEADLINE_MS).toISOString(),
        appFees: nearAppFees(originAmountUsd),
      })
        .then((q) => id === previewId.current && setPreview({ status: "ok", quote: q.quote }))
        .catch((e) => id === previewId.current && setPreview({ status: "error", error: e?.message || "No NEAR route for this amount right now." }));
    }, 600);
    return () => clearTimeout(t);
  }, [route, amountBaseUnits, evmAddress, originAmountUsd, previewRecipient]);

  // Status polling for the active swap.
  useEffect(() => {
    if (!activeSwap || !shouldPollNearSwap(activeSwap)) return;
    let stopped = false;
    const tick = async () => {
      try {
        const status = await fetchNearStatus(activeSwap.depositAddress);
        if (stopped) return;
        const next = applyStatus(activeSwap, status);
        store.put(next);
        setActiveSwap(next);
      } catch {
        // transient; try again next tick
      }
    };
    const handle = setInterval(tick, 5000);
    tick();
    return () => {
      stopped = true;
      clearInterval(handle);
    };
  }, [activeSwap?.depositAddress, activeSwap?.status, store]); // eslint-disable-line react-hooks/exhaustive-deps

  const busy = activeSwap && !isFinalStatus(activeSwap.status) && activeSwap.status !== "SEND_FAILED";
  const blocker = !connected
    ? "Connect a wallet to continue"
    : route?.error
      ? route.error
      : !route
        ? "Loading NEAR routes…"
        : !amountBaseUnits
          ? "Enter an amount"
          : insufficient
            ? "Insufficient balance"
            : !trimmedAddress
              ? "Connect your NEAR wallet"
              : addressState.status === "invalid"
                ? "That isn't a NEAR address"
                : addressState.status === "missing"
                  ? "That NEAR account doesn't exist"
                  : addressState.status === "unverified"
                    ? "Couldn't verify that NEAR account — try again"
                    : addressState.status === "checking"
                      ? "Checking NEAR address…"
                      : preview.status !== "ok"
                        ? preview.status === "error"
                          ? "No NEAR route for this amount"
                          : "Getting a quote…"
                        : busy
                          ? "A NEAR transfer is in progress"
                          : null;

  function expectedFor() {
    return {
      originAsset: route.originAsset,
      destinationAsset: route.destinationAsset,
      amount: amountBaseUnits,
      recipient: trimmedAddress,
      recipientType: "DESTINATION_CHAIN",
      refundTo: evmAddress,
      maxSlippageBps: SLIPPAGE_BPS,
      appFees: nearAppFees(originAmountUsd),
    };
  }

  async function openConfirm() {
    setConfirm({ status: "quoting" });
    try {
      const response = await requestNearQuote({
        dry: false,
        swapType: "EXACT_INPUT",
        slippageTolerance: SLIPPAGE_BPS,
        originAsset: route.originAsset,
        depositType: "ORIGIN_CHAIN",
        destinationAsset: route.destinationAsset,
        amount: amountBaseUnits,
        refundTo: evmAddress,
        refundType: "ORIGIN_CHAIN",
        recipient: trimmedAddress,
        recipientType: "DESTINATION_CHAIN",
        deadline: new Date(Date.now() + NEAR_QUOTE_DEADLINE_MS).toISOString(),
        appFees: nearAppFees(originAmountUsd),
      });
      assertQuoteSafeToFund(response, expectedFor());
      setConfirm({ status: "ready", response, expected: expectedFor(), route, payAmount: amount });
    } catch (e) {
      setConfirm({ status: "error", error: e?.message || "Couldn't get a NEAR quote." });
    }
  }

  async function pay() {
    const { response, expected, route: r, payAmount } = confirm;
    setConfirm({ ...confirm, status: "paying" });
    const chainId = MAINNET_CHAIN_IDS[from];
    try {
      // Switch networks before the payment step, so declining the switch
      // never counts as a payment attempt.
      if (getAccount(config).chainId !== chainId) await switchChain(config, { chainId });
    } catch (e) {
      setConfirm({ ...confirm, status: "error", error: isUserRejection(e) ? "Network switch declined — nothing was sent." : e?.shortMessage || e?.message || "Couldn't switch networks." });
      return;
    }
    try {
      const record = await fundNearQuote({
        response,
        expected,
        fromChain: from,
        fromSymbol: fromAsset.symbol,
        fromAddress: evmAddress,
        payAmount,
        store,
        submitDepositTx: submitNearDepositTx,
        send: async (depositAddress) => {
          const value = BigInt(response.quote.amountIn);
          try {
            return r.isNative
              ? await sendTransaction(config, { to: depositAddress, value, chainId })
              : await writeContract(config, { address: r.contract, abi: ERC20_TRANSFER_ABI, functionName: "transfer", args: [depositAddress, value], chainId });
          } catch (e) {
            if (isUserRejection(e)) throw new NearSendRejectedError("You declined the transaction in your wallet — nothing was sent.");
            throw e;
          }
        },
      });
      setActiveSwap(record);
      setConfirm(null);
    } catch (e) {
      const saved = store.get(response.quote.depositAddress);
      if (saved?.broadcastAttempted) setActiveSwap(saved);
      setConfirm({ ...confirm, status: "error", error: e?.shortMessage || e?.message || "The deposit wasn't sent." });
    }
  }

  const q = preview.status === "ok" ? preview.quote : null;
  const destLabel = NEAR_DESTINATION_ASSETS.find((a) => a.symbol === destSymbol)?.label;
  const box = { background: P.input, border: `1px solid ${P.panelBorder}` };

  return (
    <div className="flex flex-col gap-3">
      {/* Same amount row and token picker as every other route. */}
      <AmountBox P={P}>
        <span className="font-display text-[24px] font-semibold" style={{ color: q ? P.textPrimary : P.textMuted }}>
          {q ? q.amountOutFormatted : amtNum > 0 && preview.status === "loading" ? "…" : "0"}
        </span>
        <NearTokenPicker
          P={P}
          value={NEAR_DESTINATION_ASSETS.find((a) => a.symbol === destSymbol)?.contract}
          tokens={NEAR_DESTINATION_ASSETS.map((a) => a.contract)}
          metas={Object.fromEntries(NEAR_DESTINATION_ASSETS.map((a) => [a.contract, { symbol: a.symbol }]))}
          onPick={(contract) => setDestSymbol(NEAR_DESTINATION_ASSETS.find((a) => a.contract === contract)?.symbol ?? "USDC")}
          TokenIcon={TokenIcon}
        />
      </AmountBox>
      {tokensError && <div className="text-[11.5px]" style={{ color: "#D92D20" }}>{tokensError}</div>}
      {route?.error && <div className="text-[11.5px]" style={{ color: P.textMuted }}>{route.error}</div>}
      {preview.status === "error" && <div className="text-[11.5px]" style={{ color: "#D92D20" }}>{preview.error}</div>}

      <div>
          <div className="text-[12px] font-medium mb-1.5" style={{ color: P.textSecondary }}>Receive to</div>
          {nearWallet ? (
            <div className="flex items-center justify-between rounded-xl px-3.5 py-2.5" style={box}>
              <div className="min-w-0">
                <div className="text-[13px] font-mono truncate" style={{ color: P.textPrimary }}>{nearWallet.accountId}</div>
                <div className="text-[11px]" style={{ color: addressState.status === "missing" ? "#D92D20" : P.textMuted }}>
                  {addressState.status === "missing"
                    ? "This account isn't active on NEAR yet."
                    : addressState.status === "unverified"
                      ? "Couldn't reach NEAR to check this account. Try again in a moment."
                      : `Connected${nearWallet.name ? ` with ${nearWallet.name}` : ""}`}
                </div>
              </div>
              <button onClick={disconnectNearWallet} className="text-[12px] font-medium shrink-0 ml-3" style={{ color: P.textSecondary }}>Disconnect</button>
            </div>
          ) : (
            <button
              onClick={connectNearWallet}
              disabled={sharedNear.status === "connecting"}
              className="w-full py-3 rounded-xl text-[13.5px] font-semibold"
              style={{ background: P.input, color: P.textPrimary, border: `1px solid ${P.panelBorder}` }}
            >
              {sharedNear.status === "connecting" ? "Opening NEAR wallet…" : "Connect NEAR wallet"}
            </button>
          )}
          {sharedNear.status === "error" && <div className="text-[11px] mt-1" style={{ color: "#D92D20" }}>{sharedNear.error}</div>}
      </div>

      {q && (
        <div className="rounded-xl px-3.5 py-3 flex flex-col gap-1.5 text-[12px]" style={box}>
          <div className="flex justify-between"><span style={{ color: P.textSecondary }}>Minimum received</span><span className="font-mono" style={{ color: P.textPrimary }}>{formatUnits(BigInt(q.minAmountOut), route.destDecimals)} {destSymbol}</span></div>
          <div className="flex justify-between"><span style={{ color: P.textSecondary }}>Fees</span><span style={{ color: P.textPrimary }}>Mango 0.5% + NEAR Intents fee + gas</span></div>
          {q.timeEstimate ? <div className="flex justify-between"><span style={{ color: P.textSecondary }}>ETA</span><span style={{ color: P.textPrimary }}>~{Math.max(1, Math.round(q.timeEstimate / 60))} min after deposit</span></div> : null}
        </div>
      )}

      {activeSwap && (
        <div className="rounded-xl px-3.5 py-3 text-[12px] flex flex-col gap-1" style={{ ...box, borderColor: activeSwap.status === "SUCCESS" ? "#00D67D" : ["FAILED", "SEND_FAILED"].includes(activeSwap.status) ? "#D92D20" : P.panelBorder }}>
          <div className="font-medium" style={{ color: P.textPrimary }}>
            {activeSwap.payAmount} {activeSwap.fromSymbol} → {short(activeSwap.recipient)}
          </div>
          <div style={{ color: P.textSecondary }}>{STATUS_TEXT[activeSwap.status] ?? activeSwap.status}</div>
          {activeSwap.amountOutFormatted && activeSwap.status === "SUCCESS" && <div style={{ color: P.textSecondary }}>Received {activeSwap.amountOutFormatted}</div>}
          {activeSwap.refundReason && <div style={{ color: P.textMuted }}>{activeSwap.refundReason}</div>}
          {activeSwap.destinationTxHashes?.[0] && (
            <a href={`https://nearblocks.io/txns/${activeSwap.destinationTxHashes[0]}`} target="_blank" rel="noopener noreferrer" style={{ color: P.ctaBg }}>View on NearBlocks</a>
          )}
          {isFinalStatus(activeSwap.status) && (
            <button onClick={() => setActiveSwap(null)} className="self-start mt-1 text-[11.5px] underline" style={{ color: P.textMuted }}>Dismiss</button>
          )}
        </div>
      )}

      {connected && (
        <button
          disabled={!!blocker}
          onClick={openConfirm}
          className="w-full mt-1 py-3.5 rounded-full font-display font-semibold text-[15px]"
          style={{ background: blocker ? P.ctaDisabledBg : P.ctaBg, color: blocker ? P.ctaDisabledText : P.ctaText, cursor: blocker ? "not-allowed" : "pointer" }}
        >
          {blocker ?? "Send to NEAR"}
        </button>
      )}
      <div className="text-center text-[11.5px]" style={{ color: P.textMuted }}>
        Powered by NEAR Intents. You pay your network gas and NEAR Intents' own fee.
      </div>

      {confirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.55)" }}>
          <div className="w-full max-w-sm rounded-2xl p-5 flex flex-col gap-3" style={{ background: P.bg, border: `1px solid ${P.panelBorder}` }}>
            <div className="font-display text-[17px] font-semibold" style={{ color: P.textPrimary }}>Send to NEAR</div>
            {confirm.status === "quoting" && <div className="text-[13px]" style={{ color: P.textSecondary }}>Getting a signed quote…</div>}
            {(confirm.status === "ready" || confirm.status === "paying") && (
              <div className="flex flex-col gap-1.5 text-[12.5px]">
                <div className="flex justify-between"><span style={{ color: P.textSecondary }}>You send</span><span className="font-mono" style={{ color: P.textPrimary }}>{confirm.payAmount} {fromAsset.symbol}</span></div>
                <div className="flex justify-between"><span style={{ color: P.textSecondary }}>You receive (est.)</span><span className="font-mono" style={{ color: P.textPrimary }}>{confirm.response.quote.amountOutFormatted} {destSymbol}</span></div>
                <div className="flex justify-between"><span style={{ color: P.textSecondary }}>Minimum</span><span className="font-mono" style={{ color: P.textPrimary }}>{formatUnits(BigInt(confirm.response.quote.minAmountOut), confirm.route.destDecimals)} {destSymbol}</span></div>
                <div className="flex justify-between"><span style={{ color: P.textSecondary }}>To</span><span className="font-mono" style={{ color: P.textPrimary }}>{short(trimmedAddress)}</span></div>
                <div className="flex justify-between"><span style={{ color: P.textSecondary }}>Deposit address</span><span className="font-mono" style={{ color: P.textPrimary }}>{short(confirm.response.quote.depositAddress)}</span></div>
                <div className="flex justify-between"><span style={{ color: P.textSecondary }}>Quote valid until</span><span style={{ color: P.textPrimary }}>{new Date(confirm.response.quote.deadline).toLocaleTimeString()}</span></div>
                <div className="text-[11px] mt-1" style={{ color: P.textMuted }}>
                  Verified: this quote is signed by NEAR Intents. If it can't be completed, your {fromAsset.symbol} is refunded to your wallet.
                </div>
              </div>
            )}
            {confirm.status === "error" && <div className="text-[12.5px]" style={{ color: "#D92D20" }}>{confirm.error}</div>}
            <div className="flex gap-2 mt-1">
              <button
                onClick={() => setConfirm(null)}
                disabled={confirm.status === "paying"}
                className="flex-1 py-3 rounded-full text-[14px] font-semibold"
                style={{ background: P.input, color: P.textPrimary, border: `1px solid ${P.panelBorder}` }}
              >
                {confirm.status === "error" ? "Close" : "Cancel"}
              </button>
              {confirm.status !== "error" && (
                <button
                  onClick={pay}
                  disabled={confirm.status !== "ready"}
                  className="flex-1 py-3 rounded-full text-[14px] font-semibold"
                  style={{ background: confirm.status === "ready" ? P.ctaBg : P.ctaDisabledBg, color: confirm.status === "ready" ? P.ctaText : P.ctaDisabledText }}
                >
                  {confirm.status === "paying" ? "Confirm in wallet…" : "Confirm & send"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
