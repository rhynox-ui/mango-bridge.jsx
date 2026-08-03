import React, { useState, useEffect, useRef } from "react";
import {
  useAccount,
  useConnect,
  useDisconnect,
  useSwitchChain,
  useBalance,
} from "wagmi";
import {
  ChevronDown,
  ArrowUpDown,
  Check,
  Loader2,
  ExternalLink,
  X,
  History as HistoryIcon,
  RotateCcw,
  ArrowUpRight,
  ArrowLeft,
  AlertTriangle,
  BookOpen,
  Sun,
  Moon,
  Briefcase,
  Wallet,
  Send,
} from "lucide-react";
import { CHAIN_KEY_TO_WAGMI } from "./wagmi.js";
import { isCctpSupportedPair, runCctpTransfer, CCTP_CHAINS, DEV_FEE_PCT } from "./cctp.js";
import { runOpDeposit, initiateOpWithdrawal, getOpWithdrawalStatus, proveOpWithdrawal, finalizeOpWithdrawal, trackWithdrawalByHash } from "./opbridge.js";
import { runArbDeposit, initiateArbWithdrawal, getArbWithdrawalStatus, finalizeArbWithdrawal, trackArbWithdrawalByHash } from "./arbbridge.js";
import { runWormholeTransfer, resumeWormholeTransfer } from "./wormholebridge.js";

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

const CHAINS = {
  ethereum: { id: "ethereum", name: "Ethereum Sepolia", short: "ETH", color: "#8C9BAE", mark: "◆", baseSeconds: 780, baseFee: 4.85, explorer: "https://sepolia.etherscan.io/tx/" },
  base: { id: "base", name: "Base Sepolia", short: "BASE", color: "#3D6BFF", mark: "▲", baseSeconds: 45, baseFee: 0.06, explorer: "https://sepolia.basescan.org/tx/" },
  bnb: { id: "bnb", name: "BNB Testnet", short: "BNB", color: "#F0B90B", mark: "◆", baseSeconds: 25, baseFee: 0.18, explorer: "https://testnet.bscscan.com/tx/" },
  robinhood: { id: "robinhood", name: "Robinhood Chain Testnet", short: "RBH", color: "#00C805", mark: "●", baseSeconds: 20, baseFee: 0.04, explorer: "https://explorer.testnet.chain.robinhood.com/tx/" },
};
const CHAIN_ORDER = ["ethereum", "base", "bnb", "robinhood"];

const ASSETS = [
  { symbol: "USDC", name: "USD Coin", decimals: 2, price: 1, color: "#2775CA" },
  { symbol: "ETH", name: "Ether", decimals: 5, price: 3120, color: "#8C9BAE" },
  { symbol: "USDT", name: "Tether USD", decimals: 2, price: 1, color: "#26A17B" },
  { symbol: "WBTC", name: "Wrapped Bitcoin", decimals: 6, price: 61200, color: "#F09242" },
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

const CCTP_STEPS = [
  { key: "approve", label: "Approving USDC spend" },
  { key: "fee", label: "Sending 1% dev fee" },
  { key: "burn", label: "Burning USDC on source chain" },
  { key: "attest", label: "Waiting for Circle's attestation" },
  { key: "mint", label: "Minting USDC on destination chain" },
];

const LIME = "#FF9A2E";
const LIME_DEEP = "#E8801A";

const PALETTE = {
  light: {
    bg: "#FFFFFF", panel: "#F6F6F7", panelBorder: "#E6E6E8", input: "#FBFBFB", pillBg: "#EFEFF0",
    textPrimary: "#0A0A0B", textSecondary: "#6B6B70", textMuted: "#A6A6AC",
    divider: "#EDEDEF", ctaBg: "#0A0A0B", ctaText: "#FFFFFF",
    ctaDisabledBg: "#EDEDEF", ctaDisabledText: "#B8B8BC", navActive: "#0A0A0B", navActiveText: "#FFFFFF",
  },
  dark: {
    bg: "#0A0A0B", panel: "#151517", panelBorder: "#232326", input: "#0E0E10", pillBg: "#1F1F22",
    textPrimary: "#F5F5F6", textSecondary: "#9A9AA0", textMuted: "#57575D",
    divider: "#1D1D20", ctaBg: "#F5F5F6", ctaText: "#0A0A0B",
    ctaDisabledBg: "#1D1D20", ctaDisabledText: "#57575D", navActive: "#F5F5F6", navActiveText: "#0A0A0B",
  },
};

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

// Local persistence (safe in a real deployed browser — this is not an Artifacts sandbox)
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
  } catch (e) {
    // storage unavailable (private browsing, quota, etc.) — fail silently, app still works in-session
  }
}
function removeKey(key) {
  try {
    window.localStorage.removeItem(key);
  } catch (e) {}
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

function MangoLogo({ size = 36, color = "#0A0A0B" }) {
  return (
    <svg width={size} height={size * 0.86} viewBox="0 0 70 60" className="shrink-0">
      <path
        d="M27 4c1.5-2 4-3.5 6-3.5-.3 3-2.3 5.8-5.3 7-1-1-1.2-2.3-0.7-3.5Z"
        fill={color}
      />
      <path
        d="M29 6c6-2 13 0.5 16 6.5-5.5 3-13 1.5-16.5-3-0.4-1.3-0.2-2.5 0.5-3.5Z"
        fill={color}
      />
      <path
        d="M35 12c11 0 20 10.5 20 24s-10 24-20 24-20-10.5-20-24 9-24 20-24Z"
        fill={color}
      />
      <path
        d="M35 12c2.5 0 4.8 0.4 6.9 1.2-7.7 2.6-13.4 11.6-13.4 22.3s5.7 19.7 13.4 22.3c-2.1 0.8-4.4 1.2-6.9 1.2-11 0-20-10.5-20-24s9-24 20-24Z"
        fill="#FFFFFF"
        opacity="0.16"
      />
    </svg>
  );
}

function FloatingMangoDecor({ P }) {
  const shapes = [
    { top: "8%", left: "6%", size: 26, delay: "0s", duration: "9s", rotate: -18 },
    { top: "18%", left: "88%", size: 18, delay: "1.2s", duration: "11s", rotate: 24 },
    { top: "62%", left: "4%", size: 20, delay: "2.4s", duration: "10s", rotate: 10 },
    { top: "78%", left: "90%", size: 30, delay: "0.6s", duration: "12s", rotate: -8 },
    { top: "40%", left: "94%", size: 14, delay: "3s", duration: "8s", rotate: 30 },
    { top: "30%", left: "50%", size: 16, delay: "1.8s", duration: "13s", rotate: -22 },
    { top: "88%", left: "40%", size: 22, delay: "2.1s", duration: "9.5s", rotate: 16 },
    { top: "50%", left: "2%", size: 24, delay: "0.9s", duration: "11.5s", rotate: -12 },
  ];
  return (
    <div className="fixed inset-0 pointer-events-none overflow-hidden" style={{ zIndex: 0 }} aria-hidden="true">
      <style>{`
        @keyframes mangoFloat {
          0%, 100% { transform: translateY(0px) rotate(var(--r)); }
          50% { transform: translateY(-16px) rotate(calc(var(--r) + 6deg)); }
        }
        .mango-float { animation: mangoFloat var(--dur) ease-in-out infinite; animation-delay: var(--delay); }
        @media (prefers-reduced-motion: reduce) {
          .mango-float { animation: none; }
        }
      `}</style>
      {shapes.map((s, i) => (
        <div
          key={i}
          className="absolute mango-float"
          style={{ top: s.top, left: s.left, opacity: 0.08, "--r": `${s.rotate}deg`, "--dur": s.duration, "--delay": s.delay }}
        >
          <MangoLogo size={s.size} color={P.textPrimary} />
        </div>
      ))}
    </div>
  );
}

function ChainIcon({ id, size }) {
  const s = size * 0.56;
  if (id === "ethereum") {
    return (
      <svg width={s} height={s} viewBox="0 0 24 24" fill="none">
        <path d="M12 2L4 12.5L12 17L20 12.5L12 2Z" fill="currentColor" opacity="0.85" />
        <path d="M12 18.5L4 14L12 22L20 14L12 18.5Z" fill="currentColor" />
      </svg>
    );
  }
  if (id === "base") {
    return (
      <svg width={s} height={s} viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="9" fill="currentColor" />
        <path d="M12 3a9 9 0 000 18 9 9 0 010-18z" fill="currentColor" opacity="0.55" />
      </svg>
    );
  }
  if (id === "bnb") {
    return (
      <svg width={s} height={s} viewBox="0 0 24 24" fill="none">
        <rect x="10" y="2" width="4" height="4" transform="rotate(45 12 4)" fill="currentColor" />
        <rect x="10" y="18" width="4" height="4" transform="rotate(45 12 20)" fill="currentColor" />
        <rect x="2" y="10" width="4" height="4" transform="rotate(45 4 12)" fill="currentColor" />
        <rect x="18" y="10" width="4" height="4" transform="rotate(45 20 12)" fill="currentColor" />
        <rect x="10" y="10" width="4" height="4" transform="rotate(45 12 12)" fill="currentColor" />
      </svg>
    );
  }
  // robinhood
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none">
      <path d="M12 3l7 6-7 12-7-12 7-6z" fill="currentColor" opacity="0.85" />
      <path d="M12 3l7 6h-14l7-6z" fill="currentColor" />
    </svg>
  );
}

function ChainBadge({ id, size = 18 }) {
  const c = CHAINS[id];
  return (
    <span
      className="flex items-center justify-center rounded-full shrink-0"
      style={{ width: size, height: size, background: `${c.color}22`, color: c.color, border: `1px solid ${c.color}55` }}
    >
      <ChainIcon id={id} size={size} />
    </span>
  );
}

function ChainDropdown({ value, exclude, onChange, P }) {
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
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-1.5 text-[12.5px] font-medium" style={{ color: P.textPrimary }}>
        <ChainBadge id={value} size={16} />
        {c.name}
        <ChevronDown size={13} color={P.textMuted} />
      </button>
      {open && (
        <div className="absolute left-0 z-30 mt-2 w-44 rounded-xl overflow-hidden shadow-2xl" style={{ background: P.panel, border: `1px solid ${P.panelBorder}` }}>
          {CHAIN_ORDER.filter((id) => id !== exclude).map((id) => {
            const cc = CHAINS[id];
            return (
              <button key={id} onClick={() => { onChange(id); setOpen(false); }} className="w-full flex items-center gap-2 px-3 py-2.5 text-left" style={{ background: "transparent" }}>
                <ChainBadge id={id} size={18} />
                <span className="text-[13px]" style={{ color: P.textPrimary }}>{cc.name}</span>
                {id === value && <Check size={13} color={LIME} className="ml-auto" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function AssetIcon({ symbol, size = 18 }) {
  const asset = ASSETS.find((a) => a.symbol === symbol);
  const color = asset?.color || "#8C9BAE";
  const s = size * 0.56;
  let glyph;
  if (symbol === "USDC") {
    glyph = (
      <svg width={s} height={s} viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" fill="none" />
        <path d="M12 7v10M9.5 9.5c0-1.4 1.2-2.2 2.5-2.2s2.5 .8 2.5 2c0 1.5-1.5 1.8-2.5 2.2-1.2.4-2.5.9-2.5 2.3 0 1.2 1.2 2.2 2.5 2.2s2.5-.8 2.5-2" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" />
      </svg>
    );
  } else if (symbol === "ETH") {
    glyph = (
      <svg width={s} height={s} viewBox="0 0 24 24" fill="none">
        <path d="M12 2L4 12.5L12 17L20 12.5L12 2Z" fill="currentColor" opacity="0.85" />
        <path d="M12 18.5L4 14L12 22L20 14L12 18.5Z" fill="currentColor" />
      </svg>
    );
  } else if (symbol === "USDT") {
    glyph = (
      <svg width={s} height={s} viewBox="0 0 24 24" fill="none">
        <path d="M12 3C7 3 4 10 4 14c0 4.5 3.6 7 8 7s8-2.5 8-7c0-4-3-11-8-11z" fill="currentColor" opacity="0.18" />
        <rect x="10.5" y="7" width="3" height="9" fill="currentColor" />
        <rect x="7" y="9.5" width="10" height="2.2" fill="currentColor" />
      </svg>
    );
  } else {
    glyph = (
      <svg width={s} height={s} viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="9" fill="currentColor" opacity="0.16" />
        <text x="12" y="16.5" fontSize="12" fontWeight="700" textAnchor="middle" fill="currentColor">B</text>
      </svg>
    );
  }
  return (
    <span className="flex items-center justify-center rounded-full shrink-0" style={{ width: size, height: size, background: `${color}22`, color, border: `1px solid ${color}55` }}>
      {glyph}
    </span>
  );
}

function AssetDropdown({ assetIdx, setAssetIdx, chainId, P }) {
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
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-1.5 pl-2 pr-2.5 py-1.5 rounded-full" style={{ background: P.pillBg }}>
        <AssetIcon symbol={asset.symbol} size={18} />
        <span className="text-[14px] font-semibold" style={{ color: P.textPrimary }}>{asset.symbol}</span>
        <ChevronDown size={14} color={P.textMuted} />
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-2 w-44 rounded-xl overflow-hidden shadow-2xl" style={{ background: P.panel, border: `1px solid ${P.panelBorder}` }}>
          {ASSETS.map((a, i) => (
            <button key={a.symbol} onClick={() => { setAssetIdx(i); setOpen(false); }} className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left">
              <AssetIcon symbol={a.symbol} size={22} />
              <div className="flex flex-col">
                <span className="text-[13px] font-medium" style={{ color: P.textPrimary }}>{a.symbol}</span>
                <span className="text-[11px]" style={{ color: P.textMuted }}>{a.name}</span>
              </div>
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

// ---------------------------------------------------------------------------
// Modal: review -> progress -> done
// ---------------------------------------------------------------------------

const CCTP_STEP_INDEX = { network: 0, approve: 0, fee: 1, burn: 2, attest: 3, "network-dest": 4, mint: 4 };

const OP_DEPOSIT_STEPS = [
  { key: "build", label: "Preparing deposit" },
  { key: "deposit", label: "Depositing on Ethereum Sepolia" },
  { key: "l1-confirm", label: "Confirming on Ethereum Sepolia" },
  { key: "l2-confirm", label: "Crediting on Base Sepolia" },
];
const OP_DEPOSIT_STEP_INDEX = { build: 0, deposit: 1, "l1-confirm": 2, "l2-confirm": 3 };

const OP_WITHDRAW_INITIATE_STEPS = [
  { key: "build", label: "Preparing withdrawal" },
  { key: "withdraw", label: "Submitting withdrawal on Base Sepolia" },
  { key: "l2-confirm", label: "Confirming on Base Sepolia" },
];
const OP_WITHDRAW_INITIATE_STEP_INDEX = { build: 0, withdraw: 1, "l2-confirm": 2 };

const ARB_DEPOSIT_STEPS = [
  { key: "build", label: "Preparing deposit" },
  { key: "deposit", label: "Depositing on Ethereum Sepolia" },
  { key: "confirm", label: "Crediting on Robinhood Chain Testnet" },
];
const ARB_DEPOSIT_STEP_INDEX = { build: 0, deposit: 1, confirm: 2 };

const ARB_WITHDRAW_INITIATE_STEPS = [
  { key: "build", label: "Preparing withdrawal" },
  { key: "withdraw", label: "Submitting withdrawal on Robinhood Chain Testnet" },
  { key: "confirm", label: "Confirming on Robinhood Chain Testnet" },
];
const ARB_WITHDRAW_INITIATE_STEP_INDEX = { build: 0, withdraw: 1, confirm: 2 };

const WORMHOLE_STEPS = [
  { key: "build", label: "Preparing transfer" },
  { key: "lock", label: "Locking ETH on Ethereum Sepolia" },
  { key: "attest", label: "Waiting for Wormhole guardian signatures" },
  { key: "mint", label: "Minting wrapped ETH on BNB Testnet" },
];
const WORMHOLE_STEP_INDEX = { build: 0, lock: 1, attest: 2, mint: 3 };

function getTransferKind(fromKey, toKey, assetSymbol) {
  if (isCctpSupportedPair(fromKey, toKey) && assetSymbol === "USDC") return "cctp";
  if (fromKey === "ethereum" && toKey === "base" && assetSymbol === "ETH") return "op-deposit";
  if (fromKey === "base" && toKey === "ethereum" && assetSymbol === "ETH") return "op-withdraw";
  if (fromKey === "ethereum" && toKey === "robinhood" && assetSymbol === "ETH") return "arb-deposit";
  if (fromKey === "robinhood" && toKey === "ethereum" && assetSymbol === "ETH") return "arb-withdraw";
  if (fromKey === "ethereum" && toKey === "bnb" && assetSymbol === "ETH") return "wormhole";
  return "simulated";
}

function BridgeModal({ from, to, amount, asset, fee, etaLabel, received, devFeeAmount, destination, account, onClose, onComplete, onWithdrawalInitiated }) {
  const kind = getTransferKind(from, to, asset);
  const isReal = kind !== "simulated";
  const steps = kind === "cctp" ? CCTP_STEPS
    : kind === "op-deposit" ? OP_DEPOSIT_STEPS
    : kind === "op-withdraw" ? OP_WITHDRAW_INITIATE_STEPS
    : kind === "arb-deposit" ? ARB_DEPOSIT_STEPS
    : kind === "arb-withdraw" ? ARB_WITHDRAW_INITIATE_STEPS
    : kind === "wormhole" ? WORMHOLE_STEPS
    : STEPS;

  const [phase, setPhase] = useState("review");
  const [stepIndex, setStepIndex] = useState(0);
  const [errorMessage, setErrorMessage] = useState("");
  const [realBurnHash, setRealBurnHash] = useState(null);
  const [realMintHash, setRealMintHash] = useState(null);
  const [simulatedHash] = useState(shortHash());
  const a = CHAINS[from], b = CHAINS[to];

  // Simulated flow: auto-advance on a timer (used for pairs with no real integration yet)
  useEffect(() => {
    if (isReal || phase !== "progress") return;
    if (stepIndex >= steps.length) { setPhase("done"); onComplete(simulatedHash); return; }
    const t = setTimeout(() => setStepIndex((i) => i + 1), 900 + Math.random() * 600);
    return () => clearTimeout(t);
  }, [isReal, phase, stepIndex]);

  async function handleConfirm() {
    setPhase("progress");
    if (!isReal) return; // simulated path is driven by the effect above

    try {
      if (kind === "cctp") {
        const result = await runCctpTransfer({
          fromKey: from, toKey: to, account, amountHuman: amount,
          recipientAddress: destination || account,
          onStep: (key) => { if (key !== "done") setStepIndex(CCTP_STEP_INDEX[key] ?? 0); },
        });
        setRealBurnHash(result.burnHash);
        setRealMintHash(result.mintHash);
        setStepIndex(steps.length);
        setPhase("done");
        onComplete(result.burnHash);
      } else if (kind === "op-deposit") {
        const result = await runOpDeposit({
          account, amountHuman: amount,
          onStep: (key) => { if (key !== "done") setStepIndex(OP_DEPOSIT_STEP_INDEX[key] ?? 0); },
        });
        setRealBurnHash(result.l1Hash);
        setRealMintHash(result.l2Hash);
        setStepIndex(steps.length);
        setPhase("done");
        onComplete(result.l1Hash);
      } else if (kind === "op-withdraw") {
        const result = await initiateOpWithdrawal({
          account, amountHuman: amount,
          onStep: (step) => {
            if (typeof step === "object" && step.key === "hash-known") {
              setRealBurnHash(step.l2TxHash);
              return;
            }
            if (step !== "done") setStepIndex(OP_WITHDRAW_INITIATE_STEP_INDEX[step] ?? 0);
          },
        });
        setRealBurnHash(result.l2TxHash);
        setStepIndex(steps.length);
        setPhase("withdrawal-initiated");
        onWithdrawalInitiated?.({ l2TxHash: result.l2TxHash, l2Timestamp: result.l2Timestamp, amount, account, chainType: "op" });
      } else if (kind === "arb-deposit") {
        const result = await runArbDeposit({
          amountHuman: amount,
          onStep: (key) => { if (key !== "done") setStepIndex(ARB_DEPOSIT_STEP_INDEX[key] ?? 0); },
        });
        setRealBurnHash(result.l1Hash);
        setStepIndex(steps.length);
        setPhase("done");
        onComplete(result.l1Hash);
      } else if (kind === "arb-withdraw") {
        const result = await initiateArbWithdrawal({
          account, amountHuman: amount,
          onStep: (key) => { if (key !== "done") setStepIndex(ARB_WITHDRAW_INITIATE_STEP_INDEX[key] ?? 0); },
        });
        setRealBurnHash(result.l2TxHash);
        setStepIndex(steps.length);
        setPhase("withdrawal-initiated");
        onWithdrawalInitiated?.({ l2TxHash: result.l2TxHash, amount, account, chainType: "arb" });
      } else if (kind === "wormhole") {
        const result = await runWormholeTransfer({
          amountHuman: amount,
          onStep: (step) => {
            if (typeof step === "object" && step.key === "hash-known") {
              setRealBurnHash(step.srcTxHash);
              return;
            }
            if (step !== "done") setStepIndex(WORMHOLE_STEP_INDEX[step] ?? 0);
          },
        });
        setRealBurnHash(result.srcTxHash);
        setRealMintHash(result.dstTxHash);
        setStepIndex(steps.length);
        setPhase("done");
        onComplete(result.srcTxHash);
      }
    } catch (err) {
      setErrorMessage(err?.message || String(err));
      setPhase("error");
    }
  }

  const displayHash = kind === "simulated" ? simulatedHash : (realBurnHash || "pending…");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(4,5,7,0.75)", backdropFilter: "blur(4px)" }}>
      <div className="w-full max-w-sm rounded-2xl p-5" style={{ background: "#14171D", border: "1px solid #262C36" }}>
        <div className="flex items-center justify-between mb-4">
          <span className="font-mono text-[11px] tracking-wide" style={{ color: "#5B6472" }}>
            {phase === "review" ? (isReal ? "real transfer" : displayHash) : displayHash.slice(0, 18)}
          </span>
          {phase === "progress" ? (
            <div className="flex items-center gap-2.5">
              <span className="text-[11px] uppercase tracking-wider" style={{ color: LIME }}>In progress</span>
              <button onClick={onClose} title="Go back — your transaction keeps running in the background">
                <ArrowLeft size={15} color="#5B6472" />
              </button>
            </div>
          ) : (
            <button onClick={onClose}><X size={16} color="#5B6472" /></button>
          )}
        </div>

        {phase === "progress" && (
          <div className="text-[11px] mb-3 -mt-2" style={{ color: "#4A515D" }}>
            You can go back — this keeps running in the background.
          </div>
        )}

        <div className="flex items-center justify-center gap-3 mb-5">
          <ChainBadge id={from} size={22} />
          <ArrowUpRight size={13} color="#4A515D" />
          <ChainBadge id={to} size={22} />
        </div>

        <div className="text-center mb-5 py-3 rounded-xl" style={{ background: "#0E1116", border: "1px solid #1E232B" }}>
          <div className="font-display text-2xl font-semibold" style={{ color: "#F2F4F7" }}>{amount || "0"} {asset}</div>
          <div className="text-[12px] mt-0.5" style={{ color: "#5B6472" }}>{a.name} → {b.name}</div>
          {destination && <div className="text-[11px] mt-1 font-mono" style={{ color: "#4A515D" }}>to {destination}</div>}
        </div>

        {phase === "review" && (
          <>
            <div className="flex flex-col gap-2.5 mb-5">
              <div className="flex items-center justify-between text-[13px]"><span style={{ color: "#5B6472" }}>Network fee</span><span className="font-mono" style={{ color: "#D7DBE2" }}>${fmt(fee, 2)}</span></div>
              <div className="flex items-center justify-between text-[13px]"><span style={{ color: "#5B6472" }}>Protocol fee (1%)</span><span className="font-mono" style={{ color: "#D7DBE2" }}>{fmt(devFeeAmount, 4)} {asset}</span></div>
              <div className="flex items-center justify-between text-[13px]"><span style={{ color: "#5B6472" }}>Estimated time</span><span style={{ color: "#D7DBE2" }}>{kind === "op-withdraw" || kind === "arb-withdraw" ? "~7 days to finalize" : etaLabel}</span></div>
              <div className="flex items-center justify-between text-[13px]"><span style={{ color: "#5B6472" }}>You receive</span><span className="font-mono font-medium" style={{ color: "#F2F4F7" }}>{fmt(received, 4)} {asset}</span></div>
            </div>
            <div className="flex items-start gap-2 mb-4 px-3 py-2.5 rounded-lg text-[12px]" style={{ background: isReal ? `${LIME}14` : "#1C212A", border: `1px solid ${isReal ? LIME + "40" : "#262C36"}`, color: isReal ? LIME : "#8B95A1" }}>
              <AlertTriangle size={14} className="shrink-0 mt-0.5" color={isReal ? LIME : "#F0B84D"} />
              {kind === "cctp" && "Real testnet transfer via Circle's CCTP. You'll be asked to approve and sign transactions."}
              {kind === "op-deposit" && "Real testnet deposit via Base's official bridge contract. One transaction to sign."}
              {kind === "op-withdraw" && "This only starts a real withdrawal. Base requires a 7-day challenge period — you'll need to come back later to prove and finalize it from the Withdrawals tab."}
              {kind === "arb-deposit" && "Real testnet deposit via Robinhood Chain's official Arbitrum bridge. One transaction to sign."}
              {kind === "arb-withdraw" && "This only starts a real withdrawal. Robinhood Chain requires a ~7-day challenge period — you'll need to come back later to finalize it from the Withdrawals tab. This integration is newer and less battle-tested than the Base one — start with a small amount."}
              {kind === "wormhole" && "Real testnet transfer via Wormhole. You'll receive Wormhole-wrapped ETH on BNB Testnet — not native BNB or any other app's wrapped ETH. This is the newest, least battle-tested integration here — start very small."}
              {kind === "simulated" && "Simulated route — real transfers aren't wired up for this chain/asset pair yet."}
            </div>
            {(kind === "op-deposit" || kind === "arb-deposit") && (
              <div className="flex items-start gap-2 mb-4 px-3 py-2.5 rounded-lg text-[11.5px]" style={{ background: "#1C212A", border: "1px solid #262C36", color: "#8B95A1" }}>
                📝 Deposits like this are fast, but heads up — if you ever bridge this back the other way, that withdrawal takes a real 7-day challenge period, not minutes.
              </div>
            )}
            <button onClick={handleConfirm} className="w-full py-3 rounded-xl font-display font-semibold text-[14.5px]" style={{ background: `linear-gradient(135deg, ${LIME}, ${LIME_DEEP})`, color: "#10130A" }}>
              {kind === "op-withdraw" || kind === "arb-withdraw" ? "Start withdrawal" : "Confirm bridge"}
            </button>
          </>
        )}

        {phase === "error" && (
          <div className="flex flex-col gap-3">
            <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg text-[12.5px] font-mono" style={{ background: "#2A1414", border: "1px solid #4A1E1E", color: "#E5726B" }}>
              {errorMessage}
            </div>
            {isReal && realBurnHash && (
              <div className="flex flex-col gap-2 px-3 py-2.5 rounded-lg text-[12px]" style={{ background: `${LIME}14`, border: `1px solid ${LIME}40`, color: LIME }}>
                <span>Your transaction likely succeeded on-chain — this error happened after. Hash: <span className="font-mono">{realBurnHash.slice(0, 10)}…{realBurnHash.slice(-6)}</span></span>
                {(kind === "op-withdraw" || kind === "arb-withdraw") && <span>Go to the Withdrawals tab and use "Track by hash" with the full hash to recover it.</span>}
                {kind === "wormhole" && <span>Your ETH is locked on Sepolia — nothing is lost. Wait a bit for the guardians to finish, then tap Resume below.</span>}
                <a href={`${a.explorer}${realBurnHash}`} target="_blank" rel="noopener noreferrer" className="underline">View on {a.name} explorer</a>
              </div>
            )}
            {kind === "wormhole" && realBurnHash && (
              <button
                onClick={async () => {
                  setPhase("progress");
                  setStepIndex(2);
                  setErrorMessage("");
                  try {
                    const result = await resumeWormholeTransfer({
                      srcTxHash: realBurnHash,
                      onStep: (step) => { if (step !== "done") setStepIndex(WORMHOLE_STEP_INDEX[step] ?? 2); },
                    });
                    setRealMintHash(result.dstTxHash);
                    setStepIndex(steps.length);
                    setPhase("done");
                    onComplete(result.srcTxHash);
                  } catch (err) {
                    setErrorMessage(err?.message || String(err));
                    setPhase("error");
                  }
                }}
                className="w-full py-3 rounded-xl font-display font-semibold text-[14.5px]"
                style={{ background: `linear-gradient(135deg, ${LIME}, ${LIME_DEEP})`, color: "#10130A" }}
              >
                Resume Wormhole transfer
              </button>
            )}
            <button onClick={onClose} className="w-full py-2.5 rounded-lg text-[13.5px] font-medium" style={{ background: "#1C212A", color: "#B6BEC9", border: "1px solid #262C36" }}>
              Close
            </button>
          </div>
        )}

        {(phase === "progress" || phase === "done" || phase === "withdrawal-initiated") && (
          <div className="flex flex-col gap-3">
            {steps.map((s, i) => {
              const state = i < stepIndex ? "done" : i === stepIndex && phase === "progress" ? "active" : phase !== "progress" ? "done" : "pending";
              return (
                <div key={s.key} className="flex items-center gap-3">
                  <div className="w-5 h-5 rounded-full flex items-center justify-center shrink-0" style={{ background: state === "done" ? `${LIME}22` : state === "active" ? `${LIME}22` : "#181C24", border: state === "done" ? `1px solid ${LIME}` : state === "active" ? `1px solid ${LIME}` : "1px solid #262C36" }}>
                    {state === "done" && <Check size={11} color={LIME} />}
                    {state === "active" && <Loader2 size={11} color={LIME} className="animate-spin" />}
                  </div>
                  <span className="text-[13.5px]" style={{ color: state === "pending" ? "#4A515D" : "#D7DBE2" }}>{s.label}</span>
                </div>
              );
            })}

            {phase === "withdrawal-initiated" && (
              <div className="mt-2 flex flex-col gap-2">
                <div className="flex items-center gap-2 text-[13px] px-3 py-2.5 rounded-lg" style={{ background: `${LIME}14`, border: `1px solid ${LIME}40`, color: LIME }}>
                  <Check size={14} /> Withdrawal started
                </div>
                <div className="text-[12px] px-1" style={{ color: "#8B95A1" }}>
                  {kind === "op-withdraw"
                    ? "Check the Withdrawals tab in about an hour to prove it, then again in ~7 days to finalize."
                    : "Check the Withdrawals tab in ~7 days to finalize it."}
                </div>
                <a href={`${a.explorer}${realBurnHash}`} target="_blank" rel="noopener noreferrer" className="w-full py-2.5 rounded-lg text-[13.5px] font-medium flex items-center justify-center gap-1.5" style={{ background: "#1C212A", color: "#B6BEC9", border: "1px solid #262C36" }}>
                  View tx on {a.name} <ExternalLink size={13} />
                </a>
                <button onClick={onClose} className="w-full py-2 text-[12.5px]" style={{ color: "#5B6472" }}>Close</button>
              </div>
            )}

            {phase === "done" && (
              <div className="mt-2 flex flex-col gap-2">
                <div className="flex items-center gap-2 text-[13px] px-3 py-2.5 rounded-lg" style={{ background: `${LIME}14`, border: `1px solid ${LIME}40`, color: LIME }}>
                  <Check size={14} /> Bridge complete
                </div>
                {isReal ? (
                  <>
                    <a
                      href={`${a.explorer}${realBurnHash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="w-full py-2.5 rounded-lg text-[13.5px] font-medium flex items-center justify-center gap-1.5"
                      style={{ background: "#1C212A", color: "#B6BEC9", border: "1px solid #262C36" }}
                    >
                      View {kind === "op-deposit" || kind === "arb-deposit" ? "L1" : kind === "wormhole" ? "lock" : "burn"} tx on {a.name} <ExternalLink size={13} />
                    </a>
                    {realMintHash && (
                      <a
                        href={`${b.explorer}${realMintHash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="w-full py-2.5 rounded-lg text-[13.5px] font-medium flex items-center justify-center gap-1.5"
                        style={{ background: "#1C212A", color: "#B6BEC9", border: "1px solid #262C36" }}
                      >
                        View {kind === "op-deposit" ? "L2" : "mint"} tx on {b.name} <ExternalLink size={13} />
                      </a>
                    )}
                    {!realMintHash && (kind === "arb-deposit") && (
                      <div className="w-full py-2 text-[11.5px] text-center" style={{ color: "#4A515D" }}>
                        Funds typically arrive on {b.name} within a few minutes — check your balance there.
                      </div>
                    )}
                  </>
                ) : (
                  <div className="w-full py-2.5 rounded-lg text-[12.5px] text-center" style={{ background: "#161A20", color: "#4A515D", border: "1px solid #1E232B" }}>
                    Simulated transfer — no real explorer record exists
                  </div>
                )}
                <button onClick={onClose} className="w-full py-2 text-[12.5px]" style={{ color: "#5B6472" }}>
                  Close
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

function HistoryTab({ history, onReset }) {
  if (history.length === 0) {
    return (
      <div className="rounded-2xl p-8 flex flex-col items-center text-center gap-2" style={{ background: "#12151B", border: "1px solid #1E232B" }}>
        <HistoryIcon size={22} color="#333A44" />
        <div className="text-[13.5px]" style={{ color: "#8B95A1" }}>No bridges yet</div>
        <div className="text-[12px]" style={{ color: "#4A515D" }}>Your completed transfers will show up here.</div>
      </div>
    );
  }
  return (
    <div className="rounded-2xl overflow-hidden" style={{ background: "#12151B", border: "1px solid #1E232B" }}>
      {history.map((tx, i) => (
        <div key={tx.id} className="flex items-center gap-3 px-4 py-3.5" style={{ borderTop: i === 0 ? "none" : "1px solid #1A1E26" }}>
          <div className="flex items-center -space-x-1.5">
            <ChainBadge id={tx.from} size={22} />
            <ChainBadge id={tx.to} size={22} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 text-[13.5px] font-medium" style={{ color: "#F2F4F7" }}>{fmt(tx.amount, 2)} {tx.symbol}<ArrowUpRight size={11} color="#4A515D" /></div>
            <div className="text-[11.5px] font-mono" style={{ color: "#4A515D" }}>{tx.hash} · {timeAgo(tx.timestamp)}</div>
          </div>
          <StatusPill status={tx.status} />
        </div>
      ))}
      <button onClick={onReset} className="w-full flex items-center justify-center gap-1.5 py-2.5 text-[12px]" style={{ color: "#4A515D", borderTop: "1px solid #1A1E26" }}>
        <RotateCcw size={12} /> Clear history
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main app
// ---------------------------------------------------------------------------

const WITHDRAWAL_STATUS_LABEL = {
  "waiting-to-prove": "Waiting to be provable (~1hr after initiating)",
  "ready-to-prove": "Ready to prove",
  "waiting-to-finalize": "Waiting out the 7-day challenge period",
  "ready-to-finalize": "Ready to finalize",
  finalized: "Finalized",
};

const CHAIN_TYPE_LABEL = { op: "Base → Ethereum", arb: "Robinhood Chain → Ethereum" };

function WithdrawalRow({ w, onUpdate }) {
  const [checking, setChecking] = useState(false);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState("");
  const isArb = w.chainType === "arb";

  async function checkStatus() {
    setChecking(true);
    setError("");
    try {
      const result = isArb
        ? await getArbWithdrawalStatus({ l2TxHash: w.l2TxHash })
        : await getOpWithdrawalStatus({ l2TxHash: w.l2TxHash, l2Timestamp: w.l2Timestamp });
      onUpdate({ ...w, status: result.status, etaSeconds: result.etaSeconds, lastChecked: Date.now() });
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setChecking(false);
    }
  }

  async function prove() {
    setActing(true);
    setError("");
    try {
      const { proveHash } = await proveOpWithdrawal({ l2TxHash: w.l2TxHash, l2Timestamp: w.l2Timestamp });
      onUpdate({ ...w, proveHash, status: "waiting-to-finalize" });
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setActing(false);
    }
  }

  async function finalize() {
    setActing(true);
    setError("");
    try {
      const { finalizeHash } = isArb
        ? await finalizeArbWithdrawal({ l2TxHash: w.l2TxHash })
        : await finalizeOpWithdrawal({ l2TxHash: w.l2TxHash });
      onUpdate({ ...w, finalizeHash, status: "finalized" });
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setActing(false);
    }
  }

  const daysLeft = w.etaSeconds ? Math.ceil(w.etaSeconds / 86400) : null;

  return (
    <div className="px-4 py-3.5" style={{ borderTop: "1px solid #1A1E26" }}>
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[13.5px] font-medium" style={{ color: "#F2F4F7" }}>{w.amount} ETH — {CHAIN_TYPE_LABEL[w.chainType] || "Base → Ethereum"}</span>
        <span className="text-[11px]" style={{ color: "#4A515D" }}>{timeAgo(w.initiatedAt)}</span>
      </div>
      <div className="text-[12px] mb-2.5" style={{ color: "#8B95A1" }}>
        {w.status ? WITHDRAWAL_STATUS_LABEL[w.status] || w.status : "Status unknown — tap Check status"}
        {daysLeft ? ` (~${daysLeft}d left)` : ""}
      </div>
      {error && <div className="text-[11px] font-mono mb-2" style={{ color: "#E5726B" }}>{error}</div>}
      <div className="flex gap-2">
        <button onClick={checkStatus} disabled={checking || acting} className="flex-1 py-2 rounded-lg text-[12px] font-medium" style={{ background: "#1C212A", color: "#B6BEC9", border: "1px solid #262C36" }}>
          {checking ? "Checking…" : "Check status"}
        </button>
        {!isArb && w.status === "ready-to-prove" && (
          <button onClick={prove} disabled={acting} className="flex-1 py-2 rounded-lg text-[12px] font-semibold" style={{ background: LIME, color: "#10130A" }}>
            {acting ? "Proving…" : "Prove"}
          </button>
        )}
        {w.status === "ready-to-finalize" && (
          <button onClick={finalize} disabled={acting} className="flex-1 py-2 rounded-lg text-[12px] font-semibold" style={{ background: LIME, color: "#10130A" }}>
            {acting ? "Finalizing…" : "Finalize"}
          </button>
        )}
      </div>
    </div>
  );
}

function TrackByHashForm({ onTracked }) {
  const [hash, setHash] = useState("");
  const [chainType, setChainType] = useState("op");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleTrack() {
    setLoading(true);
    setError("");
    try {
      if (chainType === "arb") {
        const { l2TxHash } = await trackArbWithdrawalByHash({ l2TxHash: hash.trim() });
        onTracked({ id: Date.now(), l2TxHash, amount: "?", initiatedAt: Date.now(), status: "waiting-to-finalize", chainType: "arb" });
      } else {
        const { l2TxHash, l2Timestamp } = await trackWithdrawalByHash({ l2TxHash: hash.trim() });
        onTracked({ id: Date.now(), l2TxHash, l2Timestamp, amount: "?", initiatedAt: Date.now(), status: "waiting-to-prove", chainType: "op" });
      }
      setHash("");
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-2xl p-4 mb-3" style={{ background: "#12151B", border: "1px solid #1E232B" }}>
      <div className="text-[12.5px] font-medium mb-2" style={{ color: "#8B95A1" }}>
        Had a withdrawal succeed on-chain but not show up here? Track it by hash:
      </div>
      <div className="flex gap-1 mb-2 p-1 rounded-lg w-fit" style={{ background: "#0E1116" }}>
        {[{ id: "op", label: "Base" }, { id: "arb", label: "Robinhood Chain" }].map((c) => (
          <button key={c.id} onClick={() => setChainType(c.id)} className="px-3 py-1 rounded-md text-[11.5px] font-medium" style={{ background: chainType === c.id ? "#1E232B" : "transparent", color: chainType === c.id ? "#F2F4F7" : "#5B6472" }}>
            {c.label}
          </button>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          value={hash}
          onChange={(e) => setHash(e.target.value)}
          placeholder="0x… L2 transaction hash"
          className="flex-1 px-3 py-2 rounded-lg text-[12.5px] font-mono"
          style={{ background: "#0E1116", border: "1px solid #1E232B", color: "#F2F4F7" }}
        />
        <button onClick={handleTrack} disabled={loading || !hash.trim()} className="px-4 py-2 rounded-lg text-[12.5px] font-semibold" style={{ background: LIME, color: "#10130A" }}>
          {loading ? "Checking…" : "Track"}
        </button>
      </div>
      {error && <div className="text-[11px] font-mono mt-2" style={{ color: "#E5726B" }}>{error}</div>}
    </div>
  );
}

function WithdrawalsTab({ withdrawals, onUpdate, onTrack }) {
  return (
    <>
      <TrackByHashForm onTracked={onTrack} />
      {withdrawals.length === 0 ? (
        <div className="rounded-2xl p-8 flex flex-col items-center text-center gap-2" style={{ background: "#12151B", border: "1px solid #1E232B" }}>
          <HistoryIcon size={22} color="#333A44" />
          <div className="text-[13.5px]" style={{ color: "#8B95A1" }}>No pending withdrawals</div>
          <div className="text-[12px]" style={{ color: "#4A515D" }}>Start a Base Sepolia → Ethereum Sepolia ETH transfer to see it tracked here.</div>
        </div>
      ) : (
        <div className="rounded-2xl overflow-hidden" style={{ background: "#12151B", border: "1px solid #1E232B" }}>
          {withdrawals.map((w) => (
            <WithdrawalRow key={w.id} w={w} onUpdate={onUpdate} />
          ))}
        </div>
      )}
    </>
  );
}

const PROTOCOLS = [
  {
    name: "Circle CCTP",
    powers: "Ethereum ↔ Base — USDC",
    desc: "Native burn-and-mint transfer, no wrapped tokens. Circle's own attestation service verifies each transfer.",
    url: "https://developers.circle.com/cctp",
  },
  {
    name: "Base Bridge (OP Stack)",
    powers: "Ethereum ↔ Base — ETH",
    desc: "Base's official rollup bridge. Deposits are fast (minutes); withdrawals require a 7-day fraud-proof challenge period.",
    url: "https://docs.base.org/base-chain/differences/eth-bridging",
  },
  {
    name: "Arbitrum Bridge",
    powers: "Ethereum ↔ Robinhood Chain — ETH",
    desc: "Robinhood Chain is built on Arbitrum Orbit and uses Arbitrum's canonical bridge. Same fast-deposit / ~7-day-withdrawal pattern as Base.",
    url: "https://docs.arbitrum.io/",
  },
  {
    name: "Wormhole",
    powers: "Ethereum → BNB Testnet — ETH",
    desc: "Lock-and-mint via Wormhole's guardian network. You receive Wormhole-wrapped ETH on BNB, not native BNB. Newest, least battle-tested integration here.",
    url: "https://wormhole.com/docs",
  },
];

function ProtocolsModal({ onClose }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(4,5,7,0.75)", backdropFilter: "blur(4px)" }}>
      <div className="w-full max-w-sm rounded-2xl p-5 max-h-[85vh] overflow-y-auto" style={{ background: "#14171D", border: "1px solid #262C36" }}>
        <div className="flex items-center justify-between mb-4">
          <span className="font-display text-[16px] font-semibold" style={{ color: "#F2F4F7" }}>Protocols</span>
          <button onClick={onClose}><X size={16} color="#5B6472" /></button>
        </div>
        <div className="flex flex-col gap-3">
          {PROTOCOLS.map((p) => (
            <a
              key={p.name}
              href={p.url}
              target="_blank"
              rel="noopener noreferrer"
              className="block rounded-xl p-3.5"
              style={{ background: "#0E1116", border: "1px solid #1E232B" }}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-[13.5px] font-semibold" style={{ color: "#F2F4F7" }}>{p.name}</span>
                <ExternalLink size={13} color="#5B6472" />
              </div>
              <div className="text-[11.5px] font-mono mb-1.5" style={{ color: LIME }}>{p.powers}</div>
              <div className="text-[12px] leading-relaxed" style={{ color: "#8B95A1" }}>{p.desc}</div>
            </a>
          ))}
        </div>
        <div className="text-[11px] text-center mt-4" style={{ color: "#4A515D" }}>
          Everything else in this app is a simulated demo, not a real transfer.
        </div>
      </div>
    </div>
  );
}

function PortfolioRow({ chainKey, address, connected, P, isFirst }) {
  const c = CHAINS[chainKey];
  const wagmiChain = CHAIN_KEY_TO_WAGMI[chainKey];
  const { data, isLoading } = useBalance({ address, chainId: wagmiChain.id, query: { enabled: connected } });

  const usdcAddress = CCTP_CHAINS[chainKey]?.usdc;
  const { data: usdcData, isLoading: usdcLoading } = useBalance({
    address,
    token: usdcAddress,
    chainId: wagmiChain.id,
    query: { enabled: connected && !!usdcAddress },
  });

  return (
    <div className="flex items-center justify-between px-4 py-3.5" style={{ borderTop: isFirst ? "none" : `1px solid ${P.divider}` }}>
      <div className="flex items-center gap-2.5">
        <ChainBadge id={chainKey} size={26} />
        <span className="text-[13.5px] font-medium" style={{ color: P.textPrimary }}>{c.name}</span>
      </div>
      <div className="flex flex-col items-end gap-1">
        <div className="flex items-center gap-1.5 text-[13.5px] font-mono font-medium" style={{ color: P.textPrimary }}>
          <span>{!connected ? "—" : isLoading ? "…" : data ? Number(data.formatted).toFixed(4) : "0.0000"}</span>
          <span className="text-[11px] font-sans" style={{ color: P.textMuted }}>{c.short === "BNB" ? "BNB" : "ETH"}</span>
        </div>
        {usdcAddress && (
          <div className="flex items-center gap-1.5 text-[12px] font-mono" style={{ color: P.textSecondary }}>
            <span>{!connected ? "—" : usdcLoading ? "…" : usdcData ? Number(usdcData.formatted).toFixed(2) : "0.00"}</span>
            <span className="text-[10.5px] font-sans" style={{ color: P.textMuted }}>USDC</span>
          </div>
        )}
      </div>
    </div>
  );
}

function PortfolioTab({ address, connected, P }) {
  if (!connected) {
    return (
      <div className="rounded-2xl p-8 flex flex-col items-center text-center gap-2" style={{ background: P.panel, border: `1px solid ${P.panelBorder}` }}>
        <Wallet size={22} color={P.textMuted} />
        <div className="text-[13.5px]" style={{ color: P.textSecondary }}>Connect your wallet</div>
        <div className="text-[12px]" style={{ color: P.textMuted }}>Your native balance across every supported testnet will show up here.</div>
      </div>
    );
  }
  return (
    <div className="rounded-2xl overflow-hidden" style={{ background: P.panel, border: `1px solid ${P.panelBorder}` }}>
      {CHAIN_ORDER.map((key, i) => (
        <PortfolioRow key={key} chainKey={key} address={address} connected={connected} P={P} isFirst={i === 0} />
      ))}
      <div className="px-4 py-3 text-[11px]" style={{ color: P.textMuted, borderTop: `1px solid ${P.divider}` }}>
        Native balance shown for every chain. USDC shown where a real testnet contract exists (Ethereum, Base). USDT and WBTC aren't wired to any chain yet.
      </div>
    </div>
  );
}

function DocSection({ title, children, P }) {
  return (
    <div className="mb-6">
      <h3 className="text-[15px] font-semibold mb-2" style={{ color: P.textPrimary }}>{title}</h3>
      <div className="text-[13px] leading-relaxed" style={{ color: P.textSecondary }}>{children}</div>
    </div>
  );
}

function DocsModal({ onClose, P }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(4,5,7,0.6)", backdropFilter: "blur(4px)" }}>
      <div className="w-full max-w-lg rounded-2xl p-6 max-h-[85vh] overflow-y-auto" style={{ background: P.bg, border: `1px solid ${P.panelBorder}` }}>
        <div className="flex items-center justify-between mb-5 sticky top-0 pb-2" style={{ background: P.bg }}>
          <span className="font-display text-[19px] font-semibold" style={{ color: P.textPrimary }}>Mango Bridge Documentation</span>
          <button onClick={onClose}><X size={18} color={P.textMuted} /></button>
        </div>

        <DocSection title="Introduction" P={P}>
          <p className="mb-3">Mango Bridge is a unified cross-chain asset bridge that routes transfers through the most secure and efficient protocol available for each supported network pair. Instead of relying on a single bridge, Mango Bridge integrates native and canonical bridge protocols to provide secure, low-cost, and reliable asset transfers across multiple blockchain ecosystems.</p>
          <p>Users interact with a single interface while Mango Bridge automatically selects the underlying bridge protocol based on the source chain, destination chain, and asset being transferred.</p>
        </DocSection>

        <DocSection title="Supported Protocols" P={P}>
          <p className="font-semibold mb-1.5" style={{ color: P.textPrimary }}>Circle CCTP</p>
          <p className="mb-2">Circle Cross-Chain Transfer Protocol (CCTP) enables native USDC transfers between supported blockchains through a burn-and-mint mechanism.</p>
          <p className="font-medium mb-1" style={{ color: P.textPrimary }}>How it works</p>
          <ol className="list-decimal ml-5 mb-2 flex flex-col gap-0.5">
            <li>USDC is burned on the source chain.</li>
            <li>Circle's Attestation Service verifies the burn event.</li>
            <li>A signed attestation is generated.</li>
            <li>The destination contract mints an equivalent amount of native USDC.</li>
            <li>The recipient receives canonical USDC instead of wrapped tokens.</li>
          </ol>
          <p className="font-medium mb-1" style={{ color: P.textPrimary }}>Advantages</p>
          <ul className="list-disc ml-5 mb-2 flex flex-col gap-0.5">
            <li>Native USDC</li>
            <li>No wrapped assets</li>
            <li>Backed directly by Circle</li>
            <li>High security</li>
            <li>Fast settlement</li>
          </ul>
          <p className="mb-3"><span className="font-medium" style={{ color: P.textPrimary }}>Supported route example:</span> Ethereum ↔ Base — Asset: USDC</p>

          <p className="font-semibold mb-1.5" style={{ color: P.textPrimary }}>Base Bridge (OP Stack)</p>
          <p className="mb-2">The Base Bridge is Coinbase's official canonical bridge for transferring ETH and supported assets between Ethereum and Base.</p>
          <p className="font-medium mb-1" style={{ color: P.textPrimary }}>Deposit Flow</p>
          <p className="mb-2 font-mono text-[12px]">User → Ethereum Bridge Contract → Base Sequencer → Base Network</p>
          <p className="mb-2">Deposits typically finalize within minutes.</p>
          <p className="font-medium mb-1" style={{ color: P.textPrimary }}>Withdrawal Flow</p>
          <p className="mb-2 font-mono text-[12px]">Base → Withdrawal Proof → 7-Day Challenge Period → Ethereum Release</p>
          <p className="mb-3">The challenge period protects users against fraudulent state transitions.</p>

          <p className="font-semibold mb-1.5" style={{ color: P.textPrimary }}>Arbitrum Canonical Bridge</p>
          <p className="mb-2">Mango Bridge integrates Arbitrum's canonical bridge for Orbit chains such as Robinhood Chain.</p>
          <p className="mb-2">Deposits settle quickly while withdrawals follow Arbitrum's optimistic security model.</p>
          <p className="font-medium mb-1" style={{ color: P.textPrimary }}>Characteristics</p>
          <ul className="list-disc ml-5 mb-3 flex flex-col gap-0.5">
            <li>Native ETH</li>
            <li>Optimistic Rollup</li>
            <li>Fraud-proof secured</li>
            <li>Seven-day withdrawal period</li>
          </ul>

          <p className="font-semibold mb-1.5" style={{ color: P.textPrimary }}>Wormhole</p>
          <p className="mb-2">Wormhole enables interoperability between independent blockchains using its Guardian Network.</p>
          <p className="font-medium mb-1" style={{ color: P.textPrimary }}>Transfer Flow</p>
          <ol className="list-decimal ml-5 mb-2 flex flex-col gap-0.5">
            <li>Asset locked on source chain</li>
            <li>Guardian Network observes transaction</li>
            <li>Guardians sign a VAA</li>
            <li>Destination chain verifies VAA</li>
            <li>Wrapped asset minted</li>
          </ol>
          <p><span className="font-medium" style={{ color: P.textPrimary }}>Example:</span> Ethereum → BNB Testnet — ETH becomes Wormhole Wrapped ETH.</p>
        </DocSection>

        <DocSection title="Bridge Routing Engine" P={P}>
          <p className="mb-2">The routing engine automatically determines the optimal bridge based on:</p>
          <ul className="list-disc ml-5 mb-2 flex flex-col gap-0.5">
            <li>Source blockchain</li>
            <li>Destination blockchain</li>
            <li>Asset type</li>
            <li>Native bridge availability</li>
            <li>Security characteristics</li>
            <li>Estimated fees</li>
          </ul>
          <p>Users never need to manually choose a protocol unless advanced mode is enabled.</p>
        </DocSection>

        <DocSection title="Security Model" P={P}>
          <p className="mb-2">Mango Bridge prioritizes canonical bridges whenever available.</p>
          <div className="rounded-lg overflow-hidden mb-2" style={{ border: `1px solid ${P.panelBorder}` }}>
            <table className="w-full text-[12.5px]">
              <thead>
                <tr style={{ background: P.panel }}>
                  <th className="text-left px-3 py-2 font-medium" style={{ color: P.textPrimary }}>Protocol</th>
                  <th className="text-left px-3 py-2 font-medium" style={{ color: P.textPrimary }}>Security</th>
                </tr>
              </thead>
              <tbody>
                {[["Circle CCTP", "Circle Attestation"], ["Base Bridge", "Ethereum + OP Stack"], ["Arbitrum Bridge", "Ethereum + Fraud Proofs"], ["Wormhole", "Guardian Network"]].map((row) => (
                  <tr key={row[0]} style={{ borderTop: `1px solid ${P.panelBorder}` }}>
                    <td className="px-3 py-2">{row[0]}</td>
                    <td className="px-3 py-2">{row[1]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p>This approach minimizes wrapped assets while maximizing interoperability.</p>
        </DocSection>

        <DocSection title="Transaction Lifecycle" P={P}>
          <ol className="list-decimal ml-5 flex flex-col gap-0.5">
            <li>Connect wallet</li>
            <li>Select source chain</li>
            <li>Choose destination chain</li>
            <li>Select asset</li>
            <li>Mango Bridge determines the optimal protocol</li>
            <li>User signs transaction</li>
            <li>Bridge executes transfer</li>
            <li>Destination chain confirms receipt</li>
          </ol>
        </DocSection>

        <DocSection title="Fees" P={P}>
          <p className="mb-2">Users may incur:</p>
          <ul className="list-disc ml-5 mb-2 flex flex-col gap-0.5">
            <li>Source chain gas fee</li>
            <li>Destination chain gas fee (where applicable)</li>
            <li>Bridge protocol fee (if applicable)</li>
            <li>Liquidity or relayer fee (protocol dependent)</li>
          </ul>
          <p>Mango Bridge displays all estimated fees before confirmation.</p>
        </DocSection>

        <DocSection title="Supported Assets" P={P}>
          <ul className="list-disc ml-5 flex flex-col gap-0.5">
            <li>ETH</li>
            <li>USDC</li>
            <li>Wrapped Assets (when required)</li>
            <li>Future ERC-20 support</li>
          </ul>
        </DocSection>

        <DocSection title="Future Roadmap" P={P}>
          <ul className="list-disc ml-5 flex flex-col gap-0.5">
            <li>Additional EVM networks</li>
            <li>Solana integration</li>
            <li>Avalanche integration</li>
            <li>Polygon support</li>
            <li>Cross-chain token swaps</li>
            <li>Cross-chain messaging</li>
            <li>Bridge analytics dashboard</li>
            <li>Developer SDK</li>
            <li>REST API</li>
            <li>Telegram Bot integration</li>
            <li>Bonding Curve Launchpad integration</li>
          </ul>
        </DocSection>

        <a
          href="https://t.me/mango_protocol"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center justify-center gap-2 w-full py-3 rounded-xl text-[13px] font-medium mt-2"
          style={{ background: P.panel, border: `1px solid ${P.panelBorder}`, color: P.textPrimary }}
        >
          <Send size={14} /> Join our Telegram
        </a>
      </div>
    </div>
  );
}

export default function MangoBridge() {
  const [theme, setTheme] = useState("light");
  const [from, setFrom] = useState("base");
  const [to, setTo] = useState("ethereum");
  const [amount, setAmount] = useState("");
  const [assetIdx, setAssetIdx] = useState(0);
  const [tab, setTab] = useState("bridge");
  const [historySubTab, setHistorySubTab] = useState("transfers");
  const [balances, setBalances] = useState(DEFAULT_BALANCES);
  const [history, setHistory] = useState([]);
  const [withdrawals, setWithdrawals] = useState([]);
  const [showModal, setShowModal] = useState(false);
  const [showDocs, setShowDocs] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [sendToOther, setSendToOther] = useState(false);
  const [destAddress, setDestAddress] = useState("");

  const { address, isConnected, chainId: connectedChainId } = useAccount();
  const { connect, connectors, isPending: isConnecting, error: connectError } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();
  const connected = isConnected;

  const fromWagmiChain = CHAIN_KEY_TO_WAGMI[from];
  const onWrongNetwork = connected && connectedChainId !== fromWagmiChain.id;

  const { data: liveBalance, isLoading: balanceLoading } = useBalance({
    address,
    chainId: fromWagmiChain.id,
    query: { enabled: connected },
  });

  const asset = ASSETS[assetIdx];
  const isNativeAsset = asset.symbol === "ETH" || (asset.symbol === "BNB" && from === "bnb");
  const isRealUsdcPair = asset.symbol === "USDC" && isCctpSupportedPair(from, to);
  const usdcTokenAddress = isRealUsdcPair ? CCTP_CHAINS[from].usdc : undefined;

  const { data: liveUsdcBalance, isLoading: usdcBalanceLoading } = useBalance({
    address,
    token: usdcTokenAddress,
    chainId: fromWagmiChain.id,
    query: { enabled: connected && isRealUsdcPair },
  });

  const usingLiveBalance = connected && (isNativeAsset || isRealUsdcPair);
  const liveBalanceLoading = isNativeAsset ? balanceLoading : usdcBalanceLoading;
  const liveBalanceValue = isNativeAsset ? liveBalance : liveUsdcBalance;

  const toWagmiChain = CHAIN_KEY_TO_WAGMI[to];
  const isNativeAssetTo = asset.symbol === "ETH" || (asset.symbol === "BNB" && to === "bnb");
  const isRealUsdcPairTo = asset.symbol === "USDC" && isCctpSupportedPair(to, from);
  const usdcTokenAddressTo = isRealUsdcPairTo ? CCTP_CHAINS[to].usdc : undefined;

  const { data: liveBalanceTo, isLoading: balanceLoadingTo } = useBalance({
    address,
    chainId: toWagmiChain.id,
    query: { enabled: connected && isNativeAssetTo },
  });
  const { data: liveUsdcBalanceTo, isLoading: usdcBalanceLoadingTo } = useBalance({
    address,
    token: usdcTokenAddressTo,
    chainId: toWagmiChain.id,
    query: { enabled: connected && isRealUsdcPairTo },
  });

  const usingLiveBalanceTo = connected && (isNativeAssetTo || isRealUsdcPairTo);
  const liveBalanceLoadingTo = isNativeAssetTo ? balanceLoadingTo : usdcBalanceLoadingTo;
  const liveBalanceValueTo = isNativeAssetTo ? liveBalanceTo : liveUsdcBalanceTo;

  useEffect(() => {
    setBalances(loadJSON("mango:balances", DEFAULT_BALANCES));
    setHistory(loadJSON("mango:history", []));
    setWithdrawals(loadJSON("mango:withdrawals", []));
    setTheme(loadJSON("mango:theme", "light"));
  }, []);

  function toggleTheme() {
    setTheme((t) => {
      const next = t === "light" ? "dark" : "light";
      saveJSON("mango:theme", next);
      return next;
    });
  }

  const P = PALETTE[theme];

  function swap() { setFrom(to); setTo(from); }
  function handleFromChange(id) { setFrom(id); if (id === to) setTo(CHAIN_ORDER.find((c) => c !== id)); }
  function handleToChange(id) { setTo(id); if (id === from) setFrom(CHAIN_ORDER.find((c) => c !== id)); }
  function handleConnect() {
    const hasInjectedWallet = typeof window !== "undefined" && !!window.ethereum;
    const preferredId = hasInjectedWallet ? "injected" : "walletConnect";
    const preferredConnector = connectors.find((c) => c.id === preferredId) || connectors[0];
    if (preferredConnector) connect({ connector: preferredConnector });
  }

  const amtNum = Math.max(0, parseFloat(amount) || 0);
  const fee = CHAINS[from].baseFee + CHAINS[to].baseFee;
  const devFeeAmount = amtNum * DEV_FEE_PCT;
  const seconds = Math.max(CHAINS[from].baseSeconds, CHAINS[to].baseSeconds);
  const etaLabel = seconds < 60 ? `~${seconds}s` : `~${Math.round(seconds / 60)} min`;
  const received = Math.max(amtNum - devFeeAmount - fee / (asset.price || 1), 0);
  const availableBalance = usingLiveBalance && liveBalanceValue ? Number(liveBalanceValue.formatted) : null;
  const insufficient = usingLiveBalance && availableBalance !== null && amtNum > availableBalance;
  const canBridge = amtNum > 0 && from !== to && !insufficient && !onWrongNetwork && (!sendToOther || destAddress.trim().length > 4);

  function persist(newBalances, newHistory) {
    saveJSON("mango:balances", newBalances);
    saveJSON("mango:history", newHistory);
  }
  function handleComplete(hash) {
    const newBalances = {
      ...balances,
      [from]: { ...balances[from], [asset.symbol]: Math.max(0, (balances[from][asset.symbol] || 0) - amtNum) },
      [to]: { ...balances[to], [asset.symbol]: (balances[to][asset.symbol] || 0) + received },
    };
    const entry = { id: Date.now(), from, to, amount: amtNum, symbol: asset.symbol, hash, timestamp: Date.now(), status: "complete" };
    const newHistory = [entry, ...history];
    setBalances(newBalances);
    setHistory(newHistory);
    persist(newBalances, newHistory);
  }
  function resetHistory() {
    setHistory([]);
    removeKey("mango:history");
  }
  function setMax() { if (availableBalance !== null) setAmount(String(availableBalance)); }

  function handleWithdrawalInitiated({ l2TxHash, l2Timestamp, amount: amt, account: acct, chainType }) {
    const entry = { id: Date.now(), l2TxHash, l2Timestamp, amount: amt, account: acct, initiatedAt: Date.now(), chainType, status: chainType === "arb" ? "waiting-to-finalize" : "waiting-to-prove" };
    const next = [entry, ...withdrawals];
    setWithdrawals(next);
    saveJSON("mango:withdrawals", next);
  }
  function handleWithdrawalTracked(entry) {
    const next = [entry, ...withdrawals];
    setWithdrawals(next);
    saveJSON("mango:withdrawals", next);
  }
  function handleWithdrawalUpdate(updated) {
    const next = withdrawals.map((w) => (w.id === updated.id ? updated : w));
    setWithdrawals(next);
    saveJSON("mango:withdrawals", next);
  }

  return (
    <div className="min-h-screen w-full pb-24 relative" style={{ background: P.bg, fontFamily: "'Inter', sans-serif" }}>
      <style>{`
        .font-display { font-family: 'Space Grotesk', sans-serif; }
        .font-mono { font-family: 'IBM Plex Mono', monospace; }
        input[type=number]::-webkit-inner-spin-button { -webkit-appearance: none; }
        input:focus { outline: none; }
      `}</style>

      <FloatingMangoDecor P={P} />

      {/* Top nav */}
      <div className="flex items-center justify-between px-6 py-4 relative" style={{ borderBottom: `1px solid ${P.divider}`, zIndex: 1 }}>
        <div className="flex items-center gap-2.5">
          <MangoLogo size={32} color={P.textPrimary} />
          <div className="flex flex-col leading-tight">
            <span className="font-display text-[16px] font-semibold tracking-tight" style={{ color: P.textPrimary }}>Mango Protocol</span>
            <span className="text-[10px] font-medium tracking-wide uppercase" style={{ color: P.textMuted }}>Testnet</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <a href="https://t.me/mango_protocol" target="_blank" rel="noopener noreferrer" className="w-9 h-9 rounded-full flex items-center justify-center" style={{ background: P.panel, border: `1px solid ${P.panelBorder}` }}>
            <Send size={14} color={P.textSecondary} />
          </a>
          <button onClick={toggleTheme} className="w-9 h-9 rounded-full flex items-center justify-center" style={{ background: P.panel, border: `1px solid ${P.panelBorder}` }}>
            {theme === "light" ? <Moon size={14} color={P.textSecondary} /> : <Sun size={14} color={P.textSecondary} />}
          </button>
          <button onClick={() => setShowDocs(true)} className="w-9 h-9 rounded-full flex items-center justify-center" style={{ background: P.panel, border: `1px solid ${P.panelBorder}` }}>
            <BookOpen size={14} color={P.textSecondary} />
          </button>
          {connected ? (
            <button onClick={() => disconnect()} className="flex items-center gap-2 px-3.5 py-2 rounded-full text-[12.5px] font-semibold" style={{ background: P.ctaBg, color: P.ctaText }}>
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: LIME }} />
              {address ? `${address.slice(0, 6)}…${address.slice(-4)}` : ""}
            </button>
          ) : (
            <button onClick={handleConnect} disabled={isConnecting} className="flex items-center gap-2 px-4 py-2 rounded-full text-[13px] font-semibold" style={{ background: P.ctaBg, color: P.ctaText, opacity: isConnecting ? 0.6 : 1 }}>
              {isConnecting ? "Connecting…" : "Connect wallet"}
            </button>
          )}
        </div>
      </div>

      {onWrongNetwork && (
        <div className="flex items-center justify-between gap-3 px-6 py-2.5" style={{ background: "#FCEFD9", borderBottom: "1px solid #F0D9A8" }}>
          <span className="flex items-center gap-2 text-[12.5px]" style={{ color: "#8A5A00" }}>
            <AlertTriangle size={13} /> Wallet is on the wrong network for {CHAINS[from].name}
          </span>
          <button onClick={() => switchChain({ chainId: fromWagmiChain.id })} className="text-[12px] font-semibold px-3 py-1.5 rounded-lg" style={{ background: "#8A5A00", color: "#FFFFFF" }}>
            Switch
          </button>
        </div>
      )}

      {connectError && (
        <div className="px-6 py-2.5 text-[12px] font-mono" style={{ background: "#FBE8E8", borderBottom: "1px solid #F0C7C7", color: "#B42318" }}>
          Connect error: {connectError.message || String(connectError)}
        </div>
      )}

      {/* Body */}
      <div className="flex justify-center px-4 py-8 relative" style={{ zIndex: 1 }}>
        <div className="w-full max-w-[420px]">
          {tab === "history" && (
            <div className="flex gap-1 mb-3 p-1 rounded-xl w-fit" style={{ background: P.panel }}>
              {[{ id: "transfers", label: "Transfers" }, { id: "withdrawals", label: "Withdrawals" }].map((s) => (
                <button key={s.id} onClick={() => setHistorySubTab(s.id)} className="px-4 py-1.5 rounded-lg text-[13px] font-medium" style={{ background: historySubTab === s.id ? P.navActive : "transparent", color: historySubTab === s.id ? P.navActiveText : P.textSecondary }}>
                  {s.label}
                </button>
              ))}
            </div>
          )}

          {tab === "history" ? (
            historySubTab === "withdrawals" ? (
              <WithdrawalsTab withdrawals={withdrawals} onUpdate={handleWithdrawalUpdate} onTrack={handleWithdrawalTracked} />
            ) : (
              <HistoryTab history={history} onReset={resetHistory} />
            )
          ) : tab === "portfolio" ? (
            <PortfolioTab address={address} connected={connected} P={P} />
          ) : (
            <>
              {/* You send */}
              <div className="rounded-2xl p-4 shadow-sm" style={{ background: P.panel, border: `1px solid ${P.panelBorder}` }}>
                <div className="flex items-center justify-between mb-2.5">
                  <span className="text-[12.5px] font-medium" style={{ color: P.textSecondary }}>You send</span>
                  <span className="text-[11.5px]" style={{ color: P.textMuted }}>
                    {usingLiveBalance && (liveBalanceLoading ? "Loading balance…" : `Balance: ${fmt(availableBalance, asset.decimals)} ${asset.symbol}`)}
                  </span>
                </div>
                <div className="flex items-center justify-between mb-3">
                  <ChainDropdown value={from} exclude={to} onChange={handleFromChange} P={P} />
                </div>
                <div className="flex items-center justify-between rounded-xl px-3.5 py-3" style={{ background: P.input, border: `1px solid ${insufficient ? "#D92D20" : P.panelBorder}` }}>
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="0"
                    className="font-display bg-transparent text-[24px] font-semibold w-full"
                    style={{ color: P.textPrimary }}
                  />
                  <button onClick={setMax} disabled={availableBalance === null} className="text-[10.5px] font-bold px-2 py-1 rounded-md mr-2 shrink-0" style={{ background: availableBalance === null ? P.pillBg : `${LIME}1A`, color: availableBalance === null ? P.textMuted : LIME_DEEP, opacity: availableBalance === null ? 0.6 : 1 }}>MAX</button>
                  <AssetDropdown assetIdx={assetIdx} setAssetIdx={setAssetIdx} chainId={from} P={P} />
                </div>
                {insufficient && <div className="text-[11.5px] mt-1.5" style={{ color: "#D92D20" }}>Insufficient balance on {CHAINS[from].name}</div>}
              </div>

              {/* Swap toggle */}
              <div className="flex justify-center -my-3 relative z-10">
                <button onClick={swap} className="w-9 h-9 rounded-xl flex items-center justify-center shadow-sm" style={{ background: P.ctaBg }}>
                  <ArrowUpDown size={15} color={P.ctaText} />
                </button>
              </div>

              {/* You receive */}
              <div className="rounded-2xl p-4 mt-3 shadow-sm" style={{ background: P.panel, border: `1px solid ${P.panelBorder}` }}>
                <div className="flex items-center justify-between mb-2.5">
                  <span className="text-[12.5px] font-medium" style={{ color: P.textSecondary }}>You receive</span>
                  <span className="text-[11.5px]" style={{ color: P.textMuted }}>
                    {usingLiveBalanceTo && (liveBalanceLoadingTo ? "Loading balance…" : `Balance: ${fmt(Number(liveBalanceValueTo?.formatted ?? 0), asset.decimals)} ${asset.symbol}`)}
                  </span>
                </div>
                <div className="flex items-center justify-between mb-3">
                  <ChainDropdown value={to} exclude={from} onChange={handleToChange} P={P} />
                </div>
                <div className="flex items-center justify-between rounded-xl px-3.5 py-3" style={{ background: P.input, border: `1px solid ${P.panelBorder}` }}>
                  <span className="font-display text-[24px] font-semibold" style={{ color: amtNum > 0 ? P.textPrimary : P.textMuted }}>{amtNum > 0 ? fmt(received, 4) : "0"}</span>
                  <AssetDropdown assetIdx={assetIdx} setAssetIdx={setAssetIdx} chainId={to} P={P} />
                </div>
              </div>

              {/* ETA / details collapsible */}
              <button onClick={() => setDetailsOpen((o) => !o)} className="w-full flex items-center justify-between mt-3 px-4 py-2.5 rounded-xl" style={{ background: P.panel, border: `1px solid ${P.panelBorder}` }}>
                <span className="text-[12.5px] font-medium flex items-center gap-1.5" style={{ color: LIME_DEEP }}>
                  <span className="w-1.5 h-1.5 rounded-full" style={{ background: LIME }} /> Fee ${fmt(fee, 2)}
                </span>
                <span className="flex items-center gap-1.5 text-[12.5px]" style={{ color: P.textSecondary }}>
                  ETA: {etaLabel}
                  <ChevronDown size={13} color={P.textMuted} style={{ transform: detailsOpen ? "rotate(180deg)" : "none" }} />
                </span>
              </button>
              {detailsOpen && (
                <div className="mt-2 px-4 py-3 rounded-xl flex flex-col gap-2" style={{ background: P.input, border: `1px solid ${P.panelBorder}` }}>
                  <div className="flex items-center justify-between text-[12.5px]"><span style={{ color: P.textSecondary }}>Route</span><span style={{ color: P.textPrimary }}>{CHAINS[from].name} → {CHAINS[to].name}</span></div>
                  <div className="flex items-center justify-between text-[12.5px]"><span style={{ color: P.textSecondary }}>Source gas</span><span className="font-mono" style={{ color: P.textPrimary }}>${fmt(CHAINS[from].baseFee, 2)}</span></div>
                  <div className="flex items-center justify-between text-[12.5px]"><span style={{ color: P.textSecondary }}>Destination gas</span><span className="font-mono" style={{ color: P.textPrimary }}>${fmt(CHAINS[to].baseFee, 2)}</span></div>
                  <div className="flex items-center justify-between text-[12.5px]"><span style={{ color: P.textSecondary }}>Protocol fee (1%)</span><span className="font-mono" style={{ color: P.textPrimary }}>{fmt(devFeeAmount, asset.decimals)} {asset.symbol}</span></div>
                </div>
              )}

              {/* Send to another address */}
              <div className="mt-3 rounded-xl p-3.5" style={{ background: P.panel, border: `1px solid ${P.panelBorder}` }}>
                <label className="flex items-center gap-2.5 cursor-pointer">
                  <input type="checkbox" checked={sendToOther} onChange={(e) => setSendToOther(e.target.checked)} className="w-4 h-4 rounded" style={{ accentColor: LIME }} />
                  <span className="text-[12.5px] font-medium" style={{ color: P.textPrimary }}>Send to another address</span>
                </label>
                {sendToOther && (
                  <input
                    value={destAddress}
                    onChange={(e) => setDestAddress(e.target.value)}
                    placeholder={`Enter ${CHAINS[to].name} address`}
                    className="w-full mt-2.5 px-3 py-2.5 rounded-lg text-[13px] font-mono"
                    style={{ background: P.input, border: `1px solid ${P.panelBorder}`, color: P.textPrimary }}
                  />
                )}
              </div>

              {/* CTA */}
              <button
                disabled={!connected || !canBridge}
                onClick={() => setShowModal(true)}
                className="w-full mt-4 py-3.5 rounded-full font-display font-semibold text-[15px]"
                style={{
                  background: !connected || !canBridge ? P.ctaDisabledBg : P.ctaBg,
                  color: !connected || !canBridge ? P.ctaDisabledText : P.ctaText,
                  cursor: connected && canBridge ? "pointer" : "not-allowed",
                }}
              >
                {!connected ? "Connect wallet" : onWrongNetwork ? "Switch network to continue" : from === to ? "Choose different chains" : amtNum <= 0 ? "Enter an amount" : insufficient ? "Insufficient balance" : sendToOther && destAddress.trim().length <= 4 ? "Enter destination address" : ["op-withdraw", "arb-withdraw"].includes(getTransferKind(from, to, asset.symbol)) ? "Start withdrawal" : "Bridge assets"}
              </button>

              <div className="text-center mt-4 text-[11.5px]" style={{ color: P.textMuted }}>
                Testnet only. Real: Ethereum↔Base (USDC/ETH), Ethereum↔Robinhood Chain (ETH), Ethereum→BNB (ETH via Wormhole, wrapped). Withdrawals take ~7 real days. BNB→Ethereum and all other pairs are simulated.
              </div>
              <div className="text-center mt-1.5 text-[10.5px] font-mono" style={{ color: P.textMuted }}>
                1% protocol fee
              </div>
            </>
          )}
        </div>
      </div>

      {/* Bottom nav */}
      <div className="fixed bottom-0 left-0 right-0 flex justify-center px-4 pb-4 pt-2 z-40" style={{ background: `linear-gradient(to top, ${P.bg} 60%, transparent)` }}>
        <div className="flex items-center gap-1 p-1.5 rounded-full shadow-lg" style={{ background: P.panel, border: `1px solid ${P.panelBorder}` }}>
          {[
            { id: "bridge", label: "Bridge", icon: ArrowUpDown },
            { id: "history", label: "History", icon: HistoryIcon },
            { id: "portfolio", label: "Portfolio", icon: Briefcase },
          ].map((n) => {
            const Icon = n.icon;
            const active = tab === n.id;
            return (
              <button
                key={n.id}
                onClick={() => setTab(n.id)}
                className="flex items-center gap-1.5 px-4 py-2.5 rounded-full text-[12.5px] font-medium"
                style={{ background: active ? P.navActive : "transparent", color: active ? P.navActiveText : P.textSecondary }}
              >
                <Icon size={15} /> {n.label}
              </button>
            );
          })}
          <button
            onClick={() => setShowDocs(true)}
            className="flex items-center gap-1.5 px-4 py-2.5 rounded-full text-[12.5px] font-medium"
            style={{ color: P.textSecondary }}
          >
            <BookOpen size={15} /> Docs
          </button>
        </div>
      </div>

      {showModal && (
        <BridgeModal
          from={from} to={to} amount={amount} asset={asset.symbol} fee={fee} etaLabel={etaLabel} received={received}
          devFeeAmount={devFeeAmount}
          destination={sendToOther ? destAddress : null}
          account={address}
          onClose={() => setShowModal(false)}
          onComplete={handleComplete}
          onWithdrawalInitiated={handleWithdrawalInitiated}
        />
      )}
      {showDocs && <DocsModal onClose={() => setShowDocs(false)} P={P} />}
    </div>
  );
}
