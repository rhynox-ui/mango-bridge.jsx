import React, { useState, useEffect, useRef } from "react";
import {
  ChevronDown,
  ArrowUpDown,
  RefreshCw,
  Settings2,
  Check,
  Loader2,
  ExternalLink,
  X,
  Citrus,
  History as HistoryIcon,
  RotateCcw,
  ArrowUpRight,
  AlertTriangle,
  Link2,
} from "lucide-react";

const CHAINS = {
  ethereum: { id: "ethereum", name: "Ethereum", short: "ETH", color: "#8C9BAE", mark: "◆", baseSeconds: 780, baseFee: 4.85 },
  base: { id: "base", name: "Base", short: "BASE", color: "#3D6BFF", mark: "▲", baseSeconds: 45, baseFee: 0.06 },
  bnb: { id: "bnb", name: "BNB Chain", short: "BNB", color: "#F0B90B", mark: "◆", baseSeconds: 25, baseFee: 0.18 },
  robinhood: { id: "robinhood", name: "Robinhood Chain", short: "RBH", color: "#00C805", mark: "●", baseSeconds: 20, baseFee: 0.04 },
};
const CHAIN_ORDER = ["ethereum", "base", "bnb", "robinhood"];

const ASSETS = [
  { symbol: "USDC", name: "USD Coin", decimals: 2, price: 1 },
  { symbol: "ETH", name: "Ether", decimals: 5, price: 3120 },
  { symbol: "USDT", name: "Tether USD", decimals: 2, price: 1 },
  { symbol: "WBTC", name: "Wrapped Bitcoin", decimals: 6, price: 61200 },
];

const DEFAULT_BALANCES = {
  ethereum: { USDC: 1820.44, ETH: 1.284, USDT: 500, WBTC: 0.021 },
  base: { USDC: 640.1, ETH: 0.42, USDT: 120, WBTC: 0 },
  bnb: { USDC: 300, ETH: 0.05, USDT: 950.5, WBTC: 0 },
  robinhood: { USDC: 75.2, ETH: 0.01, USDT: 0, WBTC: 0 },
};

const STEPS = [
  { key: "submit", label: "Transaction submitted" },
  { key: "lock", label: "Asset locked on source chain" },
  { key: "attest", label: "Cross-chain message attested" },
  { key: "mint", label: "Asset released on destination" },
];

const LIME = "#D6FA3C";
const LIME_DEEP = "#B9E01F";

function fmt(n, d = 2) {
  return (Number.isFinite(n) ? n : 0).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
}
function shortHash() {
  const c = "0123456789abcdef";
  let h = "0x";
  for (let i = 0; i < 8; i++) h += c[Math.floor(Math.random() * 16)];
  h += "…";
  for (let i = 0; i < 6; i++) h += c[Math.floor(Math.random() * 16)];
  return h;
}
function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function loadJSON(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
}
function saveJSON(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {}
}
function removeKey(key) {
  try {
    window.localStorage.removeItem(key);
  } catch (e) {}
}

function ChainBadge({ id, size = 18 }) {
  const c = CHAINS[id];
  return (
    <span
      className="flex items-center justify-center rounded-full text-[9px] font-bold shrink-0"
      style={{ width: size, height: size, background: `${c.color}22`, color: c.color, border: `1px solid ${c.color}55` }}
    >
      {c.mark}
    </span>
  );
}

function ChainDropdown({ value, exclude, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const c = CHAINS[value];
  useEffect(() => {
    function onDoc(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);
  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-1.5 text-[12.5px] font-medium" style={{ color: "#C7CCD3" }}>
        <ChainBadge id={value} size={16} />
        {c.name}
        <ChevronDown size={13} color="#5B6472" />
      </button>
      {open && (
        <div className="absolute left-0 z-30 mt-2 w-44 rounded-xl overflow-hidden shadow-2xl" style={{ background: "#171B22", border: "1px solid #262C36" }}>
          {CHAIN_ORDER.filter((id) => id !== exclude).map((id) => {
            const cc = CHAINS[id];
            return (
              <button key={id} onClick={() => { onChange(id); setOpen(false); }} className="w-full flex items-center gap-2 px-3 py-2.5 hover:bg-[#1D2129] text-left">
                <ChainBadge id={id} size={18} />
                <span className="text-[13px]" style={{ color: "#D7DBE2" }}>{cc.name}</span>
                {id === value && <Check size={13} color={LIME} className="ml-auto" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function AssetDropdown({ assetIdx, setAssetIdx, chainId }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const asset = ASSETS[assetIdx];
  useEffect(() => {
    function onDoc(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);
  return (
    <div className="relative shrink-0" ref={ref}>
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-1.5 pl-2 pr-2.5 py-1.5 rounded-full" style={{ background: "#1C212A" }}>
        <ChainBadge id={chainId} size={18} />
        <span className="text-[14px] font-semibold" style={{ color: "#F2F4F7" }}>{asset.symbol}</span>
        <ChevronDown size={14} color="#5B6472" />
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-2 w-40 rounded-xl overflow-hidden shadow-2xl" style={{ background: "#171B22", border: "1px solid #262C36" }}>
          {ASSETS.map((a, i) => (
            <button key={a.symbol} onClick={() => { setAssetIdx(i); setOpen(false); }} className="w-full flex items-center justify-between px-3 py-2.5 hover:bg-[#1D2129] text-left">
              <span className="text-[13px] font-medium" style={{ color: "#D7DBE2" }}>{a.symbol}</span>
              <span className="text-[11px]" style={{ color: "#5B6472" }}>{a.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function StatusPill({ status }) {
  const done = status === "complete";
  return (
    <span className="text-[10.5px] font-medium px-2 py-0.5 rounded-full" style={{ background: done ? `${LIME}1A` : "#F0B84D1A", border: `1px solid ${done ? LIME : "#F0B84D"}40`, color: done ? LIME : "#F0B84D" }}>
      {done ? "Complete" : "Pending"}
    </span>
  );
}
