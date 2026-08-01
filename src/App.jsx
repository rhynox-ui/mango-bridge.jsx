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
  RefreshCw,
  Settings2,
  Check,
  Loader2,
  ExternalLink,
  X,
  History as HistoryIcon,
  RotateCcw,
  ArrowUpRight,
  AlertTriangle,
  Link2,
} from "lucide-react";
import { CHAIN_KEY_TO_WAGMI } from "./wagmi.js";
import { isCctpSupportedPair, runCctpTransfer, CCTP_CHAINS, DEV_FEE_PCT, DEV_FEE_WALLET } from "./cctp.js";

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

const CHAINS = {
  ethereum: { id: "ethereum", name: "Ethereum Sepolia", short: "ETH", color: "#8C9BAE", mark: "◆", baseSeconds: 780, baseFee: 4.85 },
  base: { id: "base", name: "Base Sepolia", short: "BASE", color: "#3D6BFF", mark: "▲", baseSeconds: 45, baseFee: 0.06 },
  bnb: { id: "bnb", name: "BNB Testnet", short: "BNB", color: "#F0B90B", mark: "◆", baseSeconds: 25, baseFee: 0.18 },
  robinhood: { id: "robinhood", name: "Robinhood Chain Testnet", short: "RBH", color: "#00C805", mark: "●", baseSeconds: 20, baseFee: 0.04 },
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

const CCTP_STEPS = [
  { key: "approve", label: "Approving USDC spend" },
  { key: "fee", label: "Sending 1% dev fee" },
  { key: "burn", label: "Burning USDC on source chain" },
  { key: "attest", label: "Waiting for Circle's attestation" },
  { key: "mint", label: "Minting USDC on destination chain" },
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

// ---------------------------------------------------------------------------
// Modal: review -> progress -> done
// ---------------------------------------------------------------------------

const CCTP_STEP_INDEX = { network: 0, approve: 0, fee: 1, burn: 2, attest: 3, "network-dest": 4, mint: 4 };

function BridgeModal({ from, to, amount, asset, fee, etaLabel, received, devFeeAmount, destination, account, onClose, onComplete }) {
  const isReal = isCctpSupportedPair(from, to) && asset === "USDC";
  const steps = isReal ? CCTP_STEPS : STEPS;

  const [phase, setPhase] = useState("review");
  const [stepIndex, setStepIndex] = useState(0);
  const [errorMessage, setErrorMessage] = useState("");
  const [realHash, setRealHash] = useState(null);
  const [simulatedHash] = useState(shortHash());
  const a = CHAINS[from], b = CHAINS[to];

  // Simulated flow: auto-advance on a timer (used for pairs CCTP doesn't support yet)
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
      const result = await runCctpTransfer({
        fromKey: from,
        toKey: to,
        account,
        amountHuman: amount,
        recipientAddress: destination || account,
        onStep: (key) => {
          if (key === "done") return;
          setStepIndex(CCTP_STEP_INDEX[key] ?? 0);
        },
      });
      setRealHash(result.burnHash);
      setStepIndex(steps.length);
      setPhase("done");
      onComplete(result.burnHash);
    } catch (err) {
      setErrorMessage(err?.message || String(err));
      setPhase("error");
    }
  }

  const displayHash = realHash || simulatedHash;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(4,5,7,0.75)", backdropFilter: "blur(4px)" }}>
      <div className="w-full max-w-sm rounded-2xl p-5" style={{ background: "#14171D", border: "1px solid #262C36" }}>
        <div className="flex items-center justify-between mb-4">
          <span className="font-mono text-[11px] tracking-wide" style={{ color: "#5B6472" }}>
            {phase === "review" ? (isReal ? "real transfer" : displayHash) : displayHash.slice(0, 18)}
          </span>
          {phase === "progress" ? (
            <span className="text-[11px] uppercase tracking-wider" style={{ color: LIME }}>In progress</span>
          ) : (
            <button onClick={onClose}><X size={16} color="#5B6472" /></button>
          )}
        </div>

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
              <div className="flex items-center justify-between text-[13px]"><span style={{ color: "#5B6472" }}>Dev fee (1%)</span><span className="font-mono" style={{ color: "#D7DBE2" }}>{fmt(devFeeAmount, 4)} {asset}</span></div>
              <div className="flex items-center justify-between text-[13px]"><span style={{ color: "#5B6472" }}>Estimated time</span><span style={{ color: "#D7DBE2" }}>{etaLabel}</span></div>
              <div className="flex items-center justify-between text-[13px]"><span style={{ color: "#5B6472" }}>You receive</span><span className="font-mono font-medium" style={{ color: "#F2F4F7" }}>{fmt(received, 4)} {asset}</span></div>
            </div>
            <div className="flex items-start gap-2 mb-4 px-3 py-2.5 rounded-lg text-[12px]" style={{ background: isReal ? `${LIME}14` : "#1C212A", border: `1px solid ${isReal ? LIME + "40" : "#262C36"}`, color: isReal ? LIME : "#8B95A1" }}>
              <AlertTriangle size={14} className="shrink-0 mt-0.5" color={isReal ? LIME : "#F0B84D"} />
              {isReal
                ? "Real testnet transfer via Circle's CCTP. You'll be asked to approve and sign two transactions."
                : "Simulated route — real transfers aren't wired up for this chain pair yet."}
            </div>
            <button onClick={handleConfirm} className="w-full py-3 rounded-xl font-display font-semibold text-[14.5px]" style={{ background: `linear-gradient(135deg, ${LIME}, ${LIME_DEEP})`, color: "#10130A" }}>
              Confirm bridge
            </button>
          </>
        )}

        {phase === "error" && (
          <div className="flex flex-col gap-3">
            <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg text-[12.5px] font-mono" style={{ background: "#2A1414", border: "1px solid #4A1E1E", color: "#E5726B" }}>
              {errorMessage}
            </div>
            <button onClick={onClose} className="w-full py-2.5 rounded-lg text-[13.5px] font-medium" style={{ background: "#1C212A", color: "#B6BEC9", border: "1px solid #262C36" }}>
              Close
            </button>
          </div>
        )}

        {(phase === "progress" || phase === "done") && (
          <div className="flex flex-col gap-3">
            {steps.map((s, i) => {
              const state = i < stepIndex ? "done" : i === stepIndex && phase === "progress" ? "active" : phase === "done" ? "done" : "pending";
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
            {phase === "done" && (
              <div className="mt-2 flex flex-col gap-2">
                <div className="flex items-center gap-2 text-[13px] px-3 py-2.5 rounded-lg" style={{ background: `${LIME}14`, border: `1px solid ${LIME}40`, color: LIME }}>
                  <Check size={14} /> Bridge complete
                </div>
                <button onClick={onClose} className="w-full py-2.5 rounded-lg text-[13.5px] font-medium flex items-center justify-center gap-1.5" style={{ background: "#1C212A", color: "#B6BEC9", border: "1px solid #262C36" }}>
                  View on explorer <ExternalLink size={13} />
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

export default function MangoBridge() {
  const [from, setFrom] = useState("base");
  const [to, setTo] = useState("ethereum");
  const [amount, setAmount] = useState("");
  const [assetIdx, setAssetIdx] = useState(0);
  const [tab, setTab] = useState("bridge");
  const [balances, setBalances] = useState(DEFAULT_BALANCES);
  const [history, setHistory] = useState([]);
  const [showModal, setShowModal] = useState(false);
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

  useEffect(() => {
    setBalances(loadJSON("mango:balances", DEFAULT_BALANCES));
    setHistory(loadJSON("mango:history", []));
  }, []);

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
  const simulatedBalance = balances?.[from]?.[asset.symbol] ?? 0;
  const availableBalance = usingLiveBalance && liveBalanceValue ? Number(liveBalanceValue.formatted) : simulatedBalance;
  const insufficient = amtNum > availableBalance;
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
  function setMax() { setAmount(String(availableBalance)); }

  return (
    <div className="min-h-screen w-full" style={{ background: "#0A0C10", fontFamily: "'Inter', sans-serif" }}>
      <style>{`
        .font-display { font-family: 'Space Grotesk', sans-serif; }
        .font-mono { font-family: 'IBM Plex Mono', monospace; }
        input[type=number]::-webkit-inner-spin-button { -webkit-appearance: none; }
        input:focus { outline: none; }
      `}</style>

      {/* Top nav */}
      <div className="flex items-center justify-between px-6 py-4" style={{ borderBottom: "1px solid #15181E" }}>
        <div className="flex items-center gap-2.5">
          <img src="/logo.png" alt="Mango Bridge" className="w-8 h-8 rounded-lg object-cover" />
          <div className="flex flex-col leading-tight">
            <span className="font-display text-[16px] font-semibold" style={{ color: "#F2F4F7" }}>Mango Bridge</span>
            <span className="text-[10px] font-medium tracking-wide uppercase" style={{ color: "#F0B84D" }}>Testnet</span>
          </div>
        </div>
        {connected ? (
          <button onClick={() => disconnect()} className="flex items-center gap-2 px-3.5 py-2 rounded-lg text-[13px] font-semibold" style={{ background: `${LIME}1A`, border: `1px solid ${LIME}40`, color: LIME }}>
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: LIME }} />
            {address ? `${address.slice(0, 6)}…${address.slice(-4)}` : ""}
          </button>
        ) : (
          <button onClick={handleConnect} disabled={isConnecting} className="flex items-center gap-2 px-4 py-2 rounded-lg text-[13.5px] font-semibold" style={{ background: LIME, color: "#10130A", opacity: isConnecting ? 0.7 : 1 }}>
            <Link2 size={14} /> {isConnecting ? "Connecting…" : "Connect wallet"}
          </button>
        )}
      </div>

      {onWrongNetwork && (
        <div className="flex items-center justify-between gap-3 px-6 py-2.5" style={{ background: "#241C0F", borderBottom: "1px solid #3A2E15" }}>
          <span className="flex items-center gap-2 text-[12.5px]" style={{ color: "#F0B84D" }}>
            <AlertTriangle size={13} /> Wallet is on the wrong network for {CHAINS[from].name}
          </span>
          <button onClick={() => switchChain({ chainId: fromWagmiChain.id })} className="text-[12px] font-semibold px-3 py-1.5 rounded-lg" style={{ background: "#F0B84D", color: "#241C0F" }}>
            Switch
          </button>
        </div>
      )}

      {connectError && (
        <div className="px-6 py-2.5 text-[12px] font-mono" style={{ background: "#2A1414", borderBottom: "1px solid #4A1E1E", color: "#E5726B" }}>
          Connect error: {connectError.message || String(connectError)}
        </div>
      )}

      <div className="px-6 py-1.5 text-[10.5px] font-mono" style={{ color: "#3A414C" }}>
        debug: {connectors.length} connector(s) available — {connectors.map((c) => c.id).join(", ") || "none"}
      </div>

      {/* Body */}
      <div className="flex justify-center px-4 py-10">
        <div className="w-full max-w-[420px]">
          {/* Tabs + icon buttons */}
          <div className="flex items-center justify-between mb-3">
            <div className="flex gap-1 p-1 rounded-xl" style={{ background: "#12151B" }}>
              {["bridge", "history"].map((t) => (
                <button key={t} onClick={() => setTab(t)} className="px-4 py-1.5 rounded-lg text-[13px] font-medium capitalize" style={{ background: tab === t ? "#20242D" : "transparent", color: tab === t ? "#F2F4F7" : "#5B6472" }}>
                  {t}
                </button>
              ))}
            </div>
            {tab === "bridge" && (
              <div className="flex items-center gap-1.5">
                <button className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: "#12151B", border: "1px solid #1E232B" }}>
                  <RefreshCw size={14} color="#5B6472" />
                </button>
                <button className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: "#12151B", border: "1px solid #1E232B" }}>
                  <Settings2 size={14} color="#5B6472" />
                </button>
              </div>
            )}
          </div>

          {tab === "history" ? (
            <HistoryTab history={history} onReset={resetHistory} />
          ) : (
            <>
              {/* You send */}
              <div className="rounded-2xl p-4" style={{ background: "#12151B", border: "1px solid #1E232B" }}>
                <div className="flex items-center justify-between mb-2.5">
                  <span className="text-[12.5px] font-medium" style={{ color: "#8B95A1" }}>You send</span>
                  <span className="text-[11.5px]" style={{ color: "#4A515D" }}>
                    {usingLiveBalance && liveBalanceLoading
                      ? "Loading balance…"
                      : `Balance: ${fmt(availableBalance, asset.decimals)} ${asset.symbol}${usingLiveBalance ? "" : " (simulated)"}`}
                  </span>
                </div>
                <div className="flex items-center justify-between mb-3">
                  <ChainDropdown value={from} exclude={to} onChange={handleFromChange} />
                </div>
                <div className="flex items-center justify-between rounded-xl px-3.5 py-3" style={{ background: "#0E1116", border: `1px solid ${insufficient ? "#7A2E2E" : "#1E232B"}` }}>
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="0"
                    className="font-display bg-transparent text-[24px] font-semibold w-full"
                    style={{ color: "#F2F4F7" }}
                  />
                  <button onClick={setMax} className="text-[10.5px] font-bold px-2 py-1 rounded-md mr-2 shrink-0" style={{ background: `${LIME}1A`, color: LIME }}>MAX</button>
                  <AssetDropdown assetIdx={assetIdx} setAssetIdx={setAssetIdx} chainId={from} />
                </div>
                {insufficient && <div className="text-[11.5px] mt-1.5" style={{ color: "#E5726B" }}>Insufficient balance on {CHAINS[from].name}</div>}
              </div>

              {/* Swap toggle */}
              <div className="flex justify-center -my-3 relative z-10">
                <button onClick={swap} className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: "#181C24", border: "1px solid #262C36" }}>
                  <ArrowUpDown size={15} color={LIME} />
                </button>
              </div>

              {/* You receive */}
              <div className="rounded-2xl p-4 mt-3" style={{ background: "#12151B", border: "1px solid #1E232B" }}>
                <div className="flex items-center justify-between mb-2.5">
                  <span className="text-[12.5px] font-medium" style={{ color: "#8B95A1" }}>You receive</span>
                  <span className="text-[11.5px]" style={{ color: "#4A515D" }}>Balance: {fmt(balances?.[to]?.[asset.symbol] ?? 0, asset.decimals)} {asset.symbol}</span>
                </div>
                <div className="flex items-center justify-between mb-3">
                  <ChainDropdown value={to} exclude={from} onChange={handleToChange} />
                </div>
                <div className="flex items-center justify-between rounded-xl px-3.5 py-3" style={{ background: "#0E1116", border: "1px solid #1E232B" }}>
                  <span className="font-display text-[24px] font-semibold" style={{ color: amtNum > 0 ? "#F2F4F7" : "#3A414C" }}>{amtNum > 0 ? fmt(received, 4) : "0"}</span>
                  <AssetDropdown assetIdx={assetIdx} setAssetIdx={setAssetIdx} chainId={to} />
                </div>
              </div>

              {/* ETA / details collapsible */}
              <button onClick={() => setDetailsOpen((o) => !o)} className="w-full flex items-center justify-between mt-3 px-4 py-2.5 rounded-xl" style={{ background: "#12151B", border: "1px solid #1E232B" }}>
                <span className="text-[12.5px] font-medium flex items-center gap-1.5" style={{ color: LIME }}>
                  <span className="w-1.5 h-1.5 rounded-full" style={{ background: LIME }} /> Fee ${fmt(fee, 2)}
                </span>
                <span className="flex items-center gap-1.5 text-[12.5px]" style={{ color: "#8B95A1" }}>
                  ETA: {etaLabel}
                  <ChevronDown size={13} color="#5B6472" style={{ transform: detailsOpen ? "rotate(180deg)" : "none" }} />
                </span>
              </button>
              {detailsOpen && (
                <div className="mt-2 px-4 py-3 rounded-xl flex flex-col gap-2" style={{ background: "#0E1116", border: "1px solid #1E232B" }}>
                  <div className="flex items-center justify-between text-[12.5px]"><span style={{ color: "#5B6472" }}>Route</span><span style={{ color: "#D7DBE2" }}>{CHAINS[from].name} → {CHAINS[to].name}</span></div>
                  <div className="flex items-center justify-between text-[12.5px]"><span style={{ color: "#5B6472" }}>Source gas</span><span className="font-mono" style={{ color: "#D7DBE2" }}>${fmt(CHAINS[from].baseFee, 2)}</span></div>
                  <div className="flex items-center justify-between text-[12.5px]"><span style={{ color: "#5B6472" }}>Destination gas</span><span className="font-mono" style={{ color: "#D7DBE2" }}>${fmt(CHAINS[to].baseFee, 2)}</span></div>
                  <div className="flex items-center justify-between text-[12.5px]"><span style={{ color: "#5B6472" }}>Dev fee (1%)</span><span className="font-mono" style={{ color: "#D7DBE2" }}>{fmt(devFeeAmount, asset.decimals)} {asset.symbol}</span></div>
                </div>
              )}

              {/* Send to another address */}
              <div className="mt-3 rounded-xl p-3.5" style={{ background: "#12151B", border: "1px solid #1E232B" }}>
                <label className="flex items-center gap-2.5 cursor-pointer">
                  <input type="checkbox" checked={sendToOther} onChange={(e) => setSendToOther(e.target.checked)} className="w-4 h-4 rounded" style={{ accentColor: LIME }} />
                  <span className="text-[12.5px] font-medium" style={{ color: "#D7DBE2" }}>Send to another address</span>
                </label>
                {sendToOther && (
                  <input
                    value={destAddress}
                    onChange={(e) => setDestAddress(e.target.value)}
                    placeholder={`Enter ${CHAINS[to].name} address`}
                    className="w-full mt-2.5 px-3 py-2.5 rounded-lg text-[13px] font-mono"
                    style={{ background: "#0E1116", border: "1px solid #1E232B", color: "#F2F4F7" }}
                  />
                )}
              </div>

              {/* CTA */}
              <button
                disabled={!connected || !canBridge}
                onClick={() => setShowModal(true)}
                className="w-full mt-4 py-3.5 rounded-xl font-display font-semibold text-[15px]"
                style={{
                  background: !connected ? "#1E232B" : canBridge ? LIME : "#1E232B",
                  color: !connected ? "#4A515D" : canBridge ? "#10130A" : "#4A515D",
                  cursor: connected && canBridge ? "pointer" : "not-allowed",
                }}
              >
                {!connected ? "Connect wallet" : onWrongNetwork ? "Switch network to continue" : from === to ? "Choose different chains" : amtNum <= 0 ? "Enter an amount" : insufficient ? "Insufficient balance" : sendToOther && destAddress.trim().length <= 4 ? "Enter destination address" : "Bridge assets"}
              </button>

              <div className="text-center mt-4 text-[11.5px]" style={{ color: "#3A414C" }}>
                Testnet only. Ethereum Sepolia ↔ Base Sepolia USDC transfers are real (via Circle's CCTP). All other routes are still simulated.
              </div>
              <div className="text-center mt-1.5 text-[10.5px] font-mono" style={{ color: "#2C333D" }}>
                1% dev fee to {DEV_FEE_WALLET.slice(0, 6)}…{DEV_FEE_WALLET.slice(-4)}
              </div>
            </>
          )}
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
        />
      )}
    </div>
  );
}
