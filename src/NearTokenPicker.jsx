// src/NearTokenPicker.jsx
//
// The one NEAR token picker, shared by Swap on NEAR, Send from NEAR and
// Receive on NEAR. Its button is the site's own TokenPill (swapUi.jsx),
// the same one the EVM / Solana token dropdown uses. The list shows the
// given NEAR tokens; with `onAdd` it also has a paste box for any NEAR
// token contract. `openSignal` (the header's Search) opens it at that box.

import React, { useEffect, useRef, useState } from "react";
import { TokenPill } from "./swapUi.jsx";
import { NATIVE_NEAR, WRAP_NEAR, USDC_NEAR, USDT_NEAR, isTokenId } from "./rheaSwap.js";

const HUB_SYMBOL = { [WRAP_NEAR]: "wNEAR", [USDC_NEAR]: "USDC", [USDT_NEAR]: "USDT" };

export function short(v) {
  return typeof v === "string" && v.length > 22 ? `${v.slice(0, 10)}…${v.slice(-8)}` : v;
}
// Label only, until the token's own ft_metadata loads.
export function labelFor(tokenId, meta) {
  return meta?.symbol ?? HUB_SYMBOL[tokenId] ?? (tokenId === NATIVE_NEAR ? "NEAR" : short(tokenId));
}

// A token's icon: its own ft_metadata icon, else the site's icon for
// known symbols (NEAR, USDC, USDT), else a plain dot.
export function TokenGlyph({ meta, symbol, TokenIcon, size = 18, P }) {
  if (meta?.icon) return <img src={meta.icon} alt="" className="rounded-full shrink-0" style={{ width: size, height: size }} />;
  if (TokenIcon && ["NEAR", "USDC", "USDT", "wNEAR"].includes(symbol)) return <TokenIcon symbol={symbol === "wNEAR" ? "NEAR" : symbol} size={size} />;
  return <span className="rounded-full shrink-0" style={{ width: size, height: size, background: P.input }} />;
}

export default function NearTokenPicker({ P, value, metas, tokens, onPick, onAdd, exclude, TokenIcon, openSignal }) {
  const [open, setOpen] = useState(false);
  const [focusPaste, setFocusPaste] = useState(false);
  // The header's Search button opens this picker at its paste box.
  useEffect(() => {
    if (openSignal) {
      setOpen(true);
      setFocusPaste(true);
    }
  }, [openSignal]);
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
      <TokenPill
        P={P}
        onClick={() => { setFocusPaste(false); setOpen((o) => !o); }}
        icon={<TokenGlyph meta={meta} symbol={labelFor(value, meta)} TokenIcon={TokenIcon} P={P} />}
        symbol={labelFor(value, meta)}
      />
      {open && (
        // Fixed and centred, so it fits whichever card it opens from.
        <div className="fixed left-1/2 top-24 -translate-x-1/2 z-50 rounded-xl shadow-2xl p-2" style={{ width: "min(20rem, calc(100vw - 2rem))", background: P.panel, border: `1px solid ${P.panelBorder}` }}>
          <div className="max-h-56 overflow-y-auto">
            {tokens.filter((t) => t !== exclude).map((t) => (
              <button key={t} onClick={() => { onPick(t); setOpen(false); }} className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-left" style={{ background: t === value ? P.input : "transparent" }}>
                <TokenGlyph meta={metas[t]} symbol={labelFor(t, metas[t])} TokenIcon={TokenIcon} size={20} P={P} />
                <span className="text-[13px] font-medium" style={{ color: P.textPrimary }}>{labelFor(t, metas[t])}</span>
                <span className="text-[11px] font-mono truncate ml-auto" style={{ color: P.textMuted }}>{t === NATIVE_NEAR ? "native" : short(t)}</span>
              </button>
            ))}
          </div>
          {onAdd && (
          <div className="mt-2 pt-2 flex flex-col gap-1.5" style={{ borderTop: `1px solid ${P.panelBorder}` }}>
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && isTokenId(text.trim().toLowerCase()) && add()}
              placeholder="Paste token contract, e.g. token.near"
              autoFocus={focusPaste}
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
          )}
        </div>
      )}
    </div>
  );
}
