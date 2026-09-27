// src/swapUi.jsx
//
// The Swap / Bridge form's building blocks, shared by every route: the
// EVM / Solana Swap and Bridge in App.jsx and the NEAR panels
// (NearSwapPanel.jsx, NearSendPanel.jsx) render these same components,
// so there is one version of each control to fix or restyle. The markup
// is App.jsx's own, moved here unchanged.

import React from "react";
import { ArrowUpDown, ChevronDown } from "lucide-react";

export const SWAP_GAIN = "#00D67D";
export const SWAP_DANGER = "#D92D20";

// Buy / Sell pills. Buy = paying the chain's base asset for the other
// side, Sell = the reverse. The ACTIVE side submits (only when `ready`),
// the inactive side flips direction.
export function BuySellRow({ P, isBuySide, ready, onSubmit, onFlip, className = "flex gap-2 mt-2 mb-2" }) {
  return (
    <div className={className}>
      <button
        onClick={() => (!isBuySide ? onFlip() : ready && onSubmit())}
        className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-full"
        style={{
          background: isBuySide ? SWAP_GAIN : P.panel,
          border: `1px solid ${SWAP_GAIN}`,
          opacity: isBuySide && !ready ? 0.4 : 1,
          cursor: isBuySide && !ready ? "not-allowed" : "pointer",
        }}
      >
        <span className="text-[14px] font-extrabold" style={{ color: isBuySide ? "#fff" : SWAP_GAIN }}>↗</span>
        <span className="text-[13.5px] font-bold" style={{ color: isBuySide ? "#fff" : SWAP_GAIN }}>Buy</span>
      </button>
      <button
        onClick={() => (isBuySide ? onFlip() : ready && onSubmit())}
        className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-full"
        style={{
          background: !isBuySide ? SWAP_DANGER : P.panel,
          border: `1px solid ${SWAP_DANGER}`,
          opacity: !isBuySide && !ready ? 0.4 : 1,
          cursor: !isBuySide && !ready ? "not-allowed" : "pointer",
        }}
      >
        <span className="text-[14px] font-extrabold" style={{ color: !isBuySide ? "#fff" : SWAP_DANGER }}>↘</span>
        <span className="text-[13.5px] font-bold" style={{ color: !isBuySide ? "#fff" : SWAP_DANGER }}>Sell</span>
      </button>
    </div>
  );
}

// Shown under Buy / Sell only while the active pill can't submit.
export function PillHint({ P, text }) {
  if (text == null) return null;
  return <div className="text-[11px] text-center -mt-1 mb-1.5" style={{ color: P.textMuted }}>{text}</div>;
}

// 25 / 50 / 75 / MAX, plus "Custom" lit when the amount matches none.
export function PercentRow({ P, selectedPercent, disabled, onPick, customActive, className = "flex gap-1.5 mb-2" }) {
  return (
    <div className={className}>
      {[25, 50, 75, 100].map((pct) => (
        <button
          key={pct}
          onClick={() => onPick(pct)}
          disabled={disabled}
          className="flex-1 rounded-full py-[7px] text-[11px] font-semibold"
          style={{
            background: selectedPercent === pct ? P.ctaBg : P.pillBg,
            color: selectedPercent === pct ? P.ctaText : P.textSecondary,
            opacity: disabled ? 0.5 : 1,
          }}
        >
          {pct === 100 ? "MAX" : `${pct}%`}
        </button>
      ))}
      <div
        className="flex-1 rounded-full py-[7px] text-[11px] font-semibold text-center"
        style={{
          background: customActive ? P.ctaBg : P.pillBg,
          color: customActive ? P.ctaText : P.textSecondary,
        }}
      >
        Custom
      </div>
    </div>
  );
}

// One of the two side-by-side "You pay" / "You receive" cards.
export function SwapSideCard({ P, label, danger = false, children }) {
  return (
    <div className="flex-1 rounded-[14px] p-3" style={{ background: P.panel, border: `1px solid ${danger ? "#D92D20" : P.panelBorder}` }}>
      <div className="text-[10px] font-bold uppercase mb-2" style={{ color: P.textMuted, letterSpacing: "0.6px" }}>{label}</div>
      {children}
    </div>
  );
}

// The collapsible "● Fee x% … ETA ▾" row.
export function FeeRow({ P, feeLabel, right, open, onToggle }) {
  return (
    <button onClick={onToggle} className="w-full flex items-center justify-between mt-3 px-4 py-2.5 rounded-xl" style={{ background: P.panel, border: `1px solid ${P.panelBorder}` }}>
      <span className="text-[12.5px] font-medium flex items-center gap-1.5" style={{ color: P.ctaBg }}>
        <span className="w-1.5 h-1.5 rounded-full" style={{ background: P.ctaBg }} /> {feeLabel}
      </span>
      <span className="flex items-center gap-1.5 text-[12.5px]" style={{ color: P.textSecondary }}>
        {right}
        <ChevronDown size={13} color={P.textMuted} style={{ transform: open ? "rotate(180deg)" : "none" }} />
      </span>
    </button>
  );
}

// The details panel the fee row opens: label / value rows.
export function DetailsPanel({ P, children }) {
  return (
    <div className="mt-2 px-4 py-3 rounded-xl flex flex-col gap-2" style={{ background: P.input, border: `1px solid ${P.panelBorder}` }}>
      {children}
    </div>
  );
}
export function DetailRow({ P, label, children, mono = true }) {
  return (
    <div className="flex items-center justify-between text-[12.5px]">
      <span style={{ color: P.textSecondary }}>{label}</span>
      <span className={mono ? "font-mono" : undefined} style={{ color: P.textPrimary }}>{children}</span>
    </div>
  );
}

// The round token button (icon, symbol, ▾) that opens a token list.
export function TokenPill({ P, icon, symbol, onClick }) {
  return (
    <button onClick={onClick} className="flex items-center gap-1.5 pl-2 pr-2.5 py-1.5 rounded-full" style={{ background: P.pillBg }}>
      {icon}
      <span className="text-[14px] font-semibold" style={{ color: P.textPrimary }}>{symbol}</span>
      <ChevronDown size={14} color={P.textMuted} />
    </button>
  );
}

// MAX inside the Bridge amount box.
export function MaxButton({ P, disabled, onClick }) {
  return (
    <button onClick={onClick} disabled={disabled} className="text-[10.5px] font-bold px-2 py-1 rounded-md mr-2 shrink-0" style={{ background: disabled ? P.pillBg : `${P.ctaBg}1A`, color: disabled ? P.textMuted : P.ctaBg, opacity: disabled ? 0.6 : 1 }}>MAX</button>
  );
}

// The ⇅ button between the Bridge's two cards.
export function FlipArrow({ P, onClick, disabled, title }) {
  return (
    <div className="flex justify-center -my-3 relative z-10">
      <button
        onClick={disabled ? undefined : onClick}
        disabled={disabled}
        title={title}
        className="w-9 h-9 rounded-xl flex items-center justify-center shadow-sm"
        style={{ background: P.ctaBg, opacity: disabled ? 0.4 : 1 }}
      >
        <ArrowUpDown size={15} color={P.ctaText} />
      </button>
    </div>
  );
}

// The Bridge's "You send" / "You receive" card: label, a right-hand note
// (balance), then its contents.
export function BridgeCard({ P, label, right, className = "rounded-2xl p-4 shadow-sm", children }) {
  return (
    <div className={className} style={{ background: P.panel, border: `1px solid ${P.panelBorder}` }}>
      <div className="flex items-center justify-between mb-2.5">
        <span className="text-[12.5px] font-medium" style={{ color: P.textSecondary }}>{label}</span>
        <span className="text-[11.5px]" style={{ color: P.textMuted }}>
          {right}
        </span>
      </div>
      {children}
    </div>
  );
}

// The amount row inside a Bridge card (amount, then MAX / token).
export function AmountBox({ P, danger = false, children }) {
  return (
    <div className="flex items-center justify-between rounded-xl px-3.5 py-3" style={{ background: P.input, border: `1px solid ${danger ? "#D92D20" : P.panelBorder}` }}>
      {children}
    </div>
  );
}

// The Bridge's main action button ("Bridge assets", "Enter an amount"…).
export function CtaButton({ P, disabled, onClick, children }) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className="w-full mt-4 py-3.5 rounded-full font-display font-semibold text-[15px]"
      style={{
        background: disabled ? P.ctaDisabledBg : P.ctaBg,
        color: disabled ? P.ctaDisabledText : P.ctaText,
        cursor: disabled ? "not-allowed" : "pointer",
      }}
    >
      {children}
    </button>
  );
}

// The small centred note under the form ("Powered by …").
export function FootNote({ P, children }) {
  return (
    <div className="text-center mt-4 text-[11.5px]" style={{ color: P.textMuted }}>
      {children}
    </div>
  );
}
