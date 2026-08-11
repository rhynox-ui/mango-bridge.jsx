import { NetworkEthereum, NetworkBase, NetworkBinanceSmartChain, TokenETH, TokenUSDC, TokenUSDT, TokenBNB } from "@web3icons/react";
import React, { useState, useEffect, useRef, useCallback } from "react";
import { parseUnits, isAddress } from "viem";
import { fetchAllEvmBalances, fetchSolanaBalance } from "./multiAssetBalances.js";
import { PublicKey } from "@solana/web3.js";
import { useSolanaWallet } from "./SolanaWalletContext.jsx";
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
  Rocket,
  Globe,
} from "lucide-react";
import { isCctpSupportedPair, runCctpTransfer, CCTP_CHAINS, DEV_FEE_PCT } from "./cctp.js";
import { runOpDeposit, initiateOpWithdrawal, getOpWithdrawalStatus, proveOpWithdrawal, finalizeOpWithdrawal, trackWithdrawalByHash } from "./opbridge.js";
import { runArbDeposit, initiateArbWithdrawal, getArbWithdrawalStatus, finalizeArbWithdrawal, trackArbWithdrawalByHash, runArbErc20Deposit, initiateArbErc20Withdrawal } from "./arbbridge.js";
import { runWormholeTransfer, runWormholeTransferReverse, resumeWormholeTransfer } from "./wormholebridge.js";
import { getRelayQuote, executeRelayQuote, canRelayHandle, sendRelayProtocolFee, currencyAddress, MAINNET_CHAIN_IDS, ASSET_ONCHAIN_DECIMALS } from "./relaybridge.js";
import { executeSolanaSourcedTransfer } from "./relaySdkSolanaExecution.js";
import { isMainnet, getWagmiChain } from "./networkMode.js";
import { LaunchpadTab } from "./Launchpad.jsx";
import { PALETTE, LIME, LIME_DEEP, fmt, timeAgo } from "./theme.js";

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

const CHAINS_TESTNET = {
  ethereum: { id: "ethereum", name: "Ethereum Sepolia", short: "ETH", color: "#8C9BAE", mark: "◆", baseSeconds: 780, baseFee: 4.85, explorer: "https://sepolia.etherscan.io/tx/" },
  base: { id: "base", name: "Base Sepolia", short: "BASE", color: "#3D6BFF", mark: "▲", baseSeconds: 45, baseFee: 0.06, explorer: "https://sepolia.basescan.org/tx/" },
  bnb: { id: "bnb", name: "BNB Testnet", short: "BNB", color: "#F0B90B", mark: "◆", baseSeconds: 25, baseFee: 0.18, explorer: "https://testnet.bscscan.com/tx/" },
  robinhood: { id: "robinhood", name: "Robinhood Chain Testnet", short: "RBH", color: "#00C805", mark: "●", baseSeconds: 20, baseFee: 0.04, explorer: "https://explorer.testnet.chain.robinhood.com/tx/" },
};
const CHAINS_MAINNET = {
  ethereum: { id: "ethereum", name: "Ethereum", short: "ETH", color: "#8C9BAE", mark: "◆", baseSeconds: 780, baseFee: 4.85, explorer: "https://etherscan.io/tx/" },
  base: { id: "base", name: "Base", short: "BASE", color: "#3D6BFF", mark: "▲", baseSeconds: 45, baseFee: 0.06, explorer: "https://basescan.org/tx/" },
  bnb: { id: "bnb", name: "BNB Chain", short: "BNB", color: "#F0B90B", mark: "◆", baseSeconds: 25, baseFee: 0.18, explorer: "https://bscscan.com/tx/" },
  robinhood: { id: "robinhood", name: "Robinhood Chain", short: "RBH", color: "#00C805", mark: "●", baseSeconds: 20, baseFee: 0.04, explorer: "https://robinhoodchain.blockscout.com/tx/" },
  stable: { id: "stable", name: "Stable", short: "STBL", color: "#26A17B", mark: "◆", baseSeconds: 15, baseFee: 0.02, explorer: "https://stablescan.xyz/tx/" },
  // Solana — deliberately NOT an EVM chain, unlike every other entry here.
  // isSolana:true is checked everywhere this matters (wallet connection,
  // address validation, getWagmiChain callers) so nothing accidentally
  // treats it like the rest. baseSeconds/baseFee reflect Relay's own
  // documented real-world performance (median ~2.7s execution, sub-cent
  // network fees), not guessed.
  solana: { id: "solana", name: "Solana", short: "SOL", color: "#9945FF", mark: "◆", baseSeconds: 3, baseFee: 0.001, explorer: "https://solscan.io/tx/", isSolana: true },
};
function getChains() { return isMainnet() ? CHAINS_MAINNET : CHAINS_TESTNET; }
// Proxy so every existing `CHAINS[key]` reference throughout this file stays
// correct without needing to be rewritten — always reflects the CURRENT mode.
const CHAINS = new Proxy({}, {
  get(_, key) { return getChains()[key]; },
  ownKeys() { return Reflect.ownKeys(getChains()); },
  getOwnPropertyDescriptor(_, key) { return Reflect.getOwnPropertyDescriptor(getChains(), key); },
});
const CHAIN_ORDER = ["ethereum", "base", "bnb", "robinhood", "stable", "solana"];

// Real, network-aware address validation. EVM uses viem's own isAddress
// (proper format + checksum validation, not a hand-rolled regex). Solana
// uses the actual PublicKey constructor from @solana/web3.js — the
// canonical way to validate a Solana address, since it genuinely decodes
// the base58 string and confirms the byte length is correct, not just a
// superficial format check.
function isValidDestinationAddress(address, isSolanaChain) {
  if (!address || !address.trim()) return false;
  if (isSolanaChain) {
    try {
      new PublicKey(address.trim());
      return true;
    } catch {
      return false;
    }
  }
  return isAddress(address.trim());
}
const NATIVE_SYMBOL_BY_CHAIN = { ethereum: "ETH", base: "ETH", bnb: "BNB", robinhood: "ETH", stable: "USDT0", solana: "SOL" };

const ASSETS = [
  { symbol: "USDC", name: "USD Coin", decimals: 2, price: 1, color: "#2775CA" },
  { symbol: "ETH", name: "Ether", decimals: 5, price: 3120, color: "#8C9BAE" },
  { symbol: "USDT", name: "Tether USD", decimals: 2, price: 1, color: "#26A17B" },
  { symbol: "WBTC", name: "Wrapped Bitcoin", decimals: 6, price: 61200, color: "#F09242" },
  { symbol: "BNB", name: "BNB", decimals: 5, price: 590, color: "#F0B90B" },
  { symbol: "USDG", name: "Global Dollar", decimals: 2, price: 1, color: "#00C805" },
  { symbol: "USDT0", name: "USDT0 (Stable native)", decimals: 2, price: 1, color: "#26A17B" },
  // Real gap fix: Solana was added as a selectable chain, but its native
  // asset never existed anywhere in this list — meaning even once a user
  // reached Solana, there was nothing valid to actually send or receive.
  { symbol: "SOL", name: "Solana", decimals: 4, price: 145, color: "#9945FF" },
];

const DEFAULT_BALANCES = {
  ethereum: { USDC: 1820.44, ETH: 1.284, USDT: 500, WBTC: 0.021 },
  base: { USDC: 640.1, ETH: 0.42, USDT: 120, WBTC: 0 },
  bnb: { USDC: 300, ETH: 0.05, USDT: 950.5, WBTC: 0 },
  robinhood: { USDC: 75.2, ETH: 0.01, USDT: 0, WBTC: 0 },
  // Real bug fix: this was missing entirely, causing a crash right after
  // any transaction into Stable completed — balances[to][toAsset.symbol]
  // needs an entry to write into. Stable only ever holds USDT0.
  stable: { USDT0: 0 },
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

function shortHash() {
  const c = "0123456789abcdef";
  let h = "0x";
  for (let i = 0; i < 8; i++) h += c[Math.floor(Math.random() * 16)];
  h += "…";
  for (let i = 0; i < 6; i++) h += c[Math.floor(Math.random() * 16)];
  return h;
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
  const s = size * 0.8;
  if (id === "ethereum") return <NetworkEthereum variant="branded" size={s} />;
  if (id === "base") return <NetworkBase variant="branded" size={s} />;
  if (id === "bnb") return <NetworkBinanceSmartChain variant="branded" size={s} />;
  const sHand = size * 0.56;
  const stableFallback = (
    <svg width={sHand} height={sHand} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" fill="none" />
      <path d="M7 13c1-2 3-2 4 0s3 2 4 0" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" />
    </svg>
  );
  const robinhoodFallback = (
    <svg width={sHand} height={sHand} viewBox="0 0 24 24" fill="none">
      <path d="M12 3l7 6-7 12-7-12 7-6z" fill="currentColor" opacity="0.85" />
      <path d="M12 3l7 6h-14l7-6z" fill="currentColor" />
    </svg>
  );
  // Both use Relay's own /chains API for a real icon where available — a
  // runtime fetch, not a build-time import, so it can never break the build
  // the way guessing @web3icons/react's export names did. Falls back to the
  // existing hand-drawn versions cleanly if Relay doesn't have one.
  if (id === "stable") return <RelayChainIcon chainId={988} size={s} fallback={stableFallback} />;
  if (id === "robinhood") return <RelayChainIcon chainId={4663} size={s} fallback={robinhoodFallback} />;
  const solanaFallback = (
    <svg width={sHand} height={sHand} viewBox="0 0 24 24" fill="none">
      <path d="M4 6.5L7 4h13l-3 2.5H4z" fill="currentColor" opacity="0.9" />
      <path d="M4 17.5L7 20h13l-3-2.5H4z" fill="currentColor" opacity="0.9" />
      <path d="M4 12L7 9.5h13L17 12H4z" fill="currentColor" />
    </svg>
  );
  // Real bug fix: this branch didn't exist at all, so selecting Solana
  // silently fell through to the Robinhood arrow icon below — visually
  // making it look like the chain selector wasn't actually changing
  // anything, even though the underlying state genuinely was.
  if (id === "solana") return <SolanaLogoIcon size={s} fallback={solanaFallback} />;
  return robinhoodFallback;
}

function ChainBadge({ id, size = 18 }) {
  const c = CHAINS[id];
  if (!c) {
    // Defensive fallback: id could be a chain that no longer exists (e.g. a
    // persisted history entry from before a chain was removed). Never crash
    // rendering someone's past transaction history over this.
    return (
      <span className="flex items-center justify-center rounded-full shrink-0" style={{ width: size, height: size, background: "#8C9BAE22", color: "#8C9BAE", border: "1px solid #8C9BAE55" }}>
        <span style={{ fontSize: size * 0.5, fontWeight: 700 }}>?</span>
      </span>
    );
  }
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

function HandDrawnAssetGlyph({ symbol, size, color }) {
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
  } else if (symbol === "BNB") {
    glyph = (
      <svg width={s} height={s} viewBox="0 0 24 24" fill="none">
        <rect x="10" y="2" width="4" height="4" transform="rotate(45 12 4)" fill="currentColor" />
        <rect x="10" y="18" width="4" height="4" transform="rotate(45 12 20)" fill="currentColor" />
        <rect x="2" y="10" width="4" height="4" transform="rotate(45 4 12)" fill="currentColor" />
        <rect x="18" y="10" width="4" height="4" transform="rotate(45 20 12)" fill="currentColor" />
        <rect x="10" y="10" width="4" height="4" transform="rotate(45 12 12)" fill="currentColor" />
      </svg>
    );
  } else if (symbol === "USDG") {
    glyph = (
      <svg width={s} height={s} viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" fill="none" />
        <path d="M15.5 9.5a3.8 3.8 0 100 5" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" />
        <path d="M13.5 12h3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  } else if (symbol === "USDT0") {
    glyph = (
      <svg width={s} height={s} viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.2" fill="none" opacity="0.5" />
        <path d="M12 3.5C7.5 3.5 4.5 10 4.5 14c0 4.5 3.6 7 7.5 7s7.5-2.5 7.5-7c0-4-3-10.5-7.5-10.5z" fill="currentColor" opacity="0.18" />
        <rect x="10.5" y="7.5" width="3" height="8.5" fill="currentColor" />
        <rect x="7.5" y="9.8" width="9" height="2" fill="currentColor" />
      </svg>
    );
  } else if (symbol === "WBTC") {
    glyph = (
      <svg width={s} height={s} viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="9" fill="currentColor" opacity="0.16" />
        <text x="12" y="16.5" fontSize="10" fontWeight="700" textAnchor="middle" fill="currentColor">₿</text>
      </svg>
    );
  } else {
    glyph = (
      <svg width={s} height={s} viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="9" fill="currentColor" opacity="0.16" />
        <text x="12" y="16.5" fontSize="12" fontWeight="700" textAnchor="middle" fill="currentColor">?</text>
      </svg>
    );
  }
  return (
    <span className="flex items-center justify-center rounded-full shrink-0" style={{ width: size, height: size, background: `${color}22`, color, border: `1px solid ${color}55` }}>
      {glyph}
    </span>
  );
}

// Fetched once, cached at module scope — Relay's own /chains API returns a
// logoURI per chain (confirmed via their own docs examples, e.g.
// "https://assets.relay.link/icons/1/light.png" for Ethereum). This is
// runtime data, not a build-time import, so unlike the icon-library attempts
// earlier, a wrong or missing icon here can never break the build — it just
// falls back to the hand-drawn version, same as everything else.
let relayChainsCache = null;
let relayChainsPromise = null;
async function getRelayChainIconUrl(chainId) {
  if (!relayChainsCache) {
    if (!relayChainsPromise) {
      relayChainsPromise = fetch("https://api.relay.link/chains")
        .then((r) => r.json())
        .then((data) => { relayChainsCache = data?.chains || []; return relayChainsCache; })
        .catch(() => { relayChainsCache = []; return relayChainsCache; });
    }
    await relayChainsPromise;
  }
  const chain = relayChainsCache.find((c) => c.id === chainId);
  // Real bug fix: this previously read the native CURRENCY's icon
  // (chain.currency.metadata.logoURI), which for many chains is just a
  // generic ETH mark reused across dozens of L2s — not distinctive to the
  // chain itself. chain.iconUrl is Relay's own actual per-chain icon,
  // confirmed present directly in their /chains response (e.g. Robinhood
  // Chain's own real icon, not a reused ETH logo).
  return chain?.iconUrl || chain?.currency?.metadata?.logoURI || null;
}

function RelayChainIcon({ chainId, size, fallback }) {
  const [url, setUrl] = useState(undefined); // undefined = loading, null = not found, string = found
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    getRelayChainIconUrl(chainId).then((u) => { if (!cancelled) setUrl(u); });
    return () => { cancelled = true; };
  }, [chainId]);

  if (url === undefined || url === null || failed) return fallback;
  return (
    <img
      src={url}
      alt=""
      width={size}
      height={size}
      style={{ width: size, height: size, objectFit: "contain" }}
      onError={() => setFailed(true)}
    />
  );
}

function USDGIcon({ size, color }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <HandDrawnAssetGlyph symbol="USDG" size={size} color={color} />;
  return (
    <img
      src="https://424565.fs1.hubspotusercontent-na1.net/hubfs/424565/GDN_USDG_Token_32x32.png"
      alt="USDG"
      width={size}
      height={size}
      style={{ width: size, height: size, objectFit: "contain" }}
      onError={() => setFailed(true)}
    />
  );
}

// Real, official Solana logomark — solana.com/branding, explicitly
// labeled "Official Solana logo mark icon" (confirmed icon-only, not the
// full wordmark with text), hosted directly on Solana's own domain.
function SolanaLogoIcon({ size, fallback }) {
  const [failed, setFailed] = useState(false);
  if (failed) return fallback;
  return (
    <img
      // Real, confirmed URL — icons.sol.new, an open-source (MIT
      // licensed) icon library built specifically for the Solana
      // ecosystem, explicitly designed for third-party embedding like
      // this. More reliable than hotlinking solana.com's own site
      // assets, which aren't necessarily meant for cross-origin use.
      src="https://icons.sol.new/svg/platforms/solana.svg"
      alt="Solana"
      width={size}
      height={size}
      style={{ width: size, height: size, objectFit: "contain" }}
      onError={() => setFailed(true)}
    />
  );
}

// Real, confirmed URL — found directly in Relay's own /chains response,
// under Stable chain's featuredTokens entry for USDT0. Not guessed.
function USDT0Icon({ size, color }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <HandDrawnAssetGlyph symbol="USDT0" size={size} color={color} />;
  return (
    <img
      // Real, confirmed URL from USDT0's own official media kit
      // (docs.usdt0.to/resources/mediakit) — explicitly labeled "Icon —
      // simplified symbol for smaller form factors," unlike the earlier
      // navbar logo, which risked being a full wordmark rather than an
      // icon-only mark.
      src="https://docs.usdt0.to/downloads/usdt0/Symbol_USDT0_Secondary.svg"
      alt="USDT0"
      width={size}
      height={size}
      style={{ width: size, height: size, objectFit: "contain", borderRadius: "50%" }}
      onError={() => setFailed(true)}
    />
  );
}

function AssetIcon({ symbol, size = 18 }) {
  const asset = ASSETS.find((a) => a.symbol === symbol);
  const color = asset?.color || "#8C9BAE";

  // Global Dollar Network's own brand page (globaldollar.com/brand)
  // explicitly hosts this exact PNG "for block explorers" — this is the
  // sanctioned use case, not a guess. Falls back to the hand-drawn glyph if
  // the image ever fails to load, via proper React state.
  if (symbol === "USDG") {
    return (
      <span className="flex items-center justify-center rounded-full shrink-0 overflow-hidden" style={{ width: size, height: size }}>
        <USDGIcon size={size} color={color} />
      </span>
    );
  }

  if (symbol === "USDT0") {
    return (
      <span className="flex items-center justify-center rounded-full shrink-0 overflow-hidden" style={{ width: size, height: size }}>
        <USDT0Icon size={size} color={color} />
      </span>
    );
  }

  if (symbol === "SOL") {
    return (
      <span className="flex items-center justify-center rounded-full shrink-0 overflow-hidden" style={{ width: size, height: size, background: "#9945FF15" }}>
        <SolanaLogoIcon size={size * 0.68} fallback={<HandDrawnAssetGlyph symbol="SOL" size={size} color={color} />} />
      </span>
    );
  }

  // Static imports only, matching @web3icons/react's own documented working
  // examples (TokenETH, TokenUSDC, TokenUSDT, TokenBNB) — no dynamic
  // lookup. The dynamic /dynamic entry point requires a <Suspense> boundary
  // to function at all, which this app didn't have, and it crashed the app
  // on every load as a result — a real production issue, not a hypothetical
  // one. A separate attempt to add TokenWBTC and NetworkStablechain caused a
  // real BUILD failure ("NetworkStablechain is not exported") — reverted
  // both until each is independently confirmed via an actual successful
  // build, not just a search-result guess. WBTC, USDG, USDT0, and anything
  // else not in this confirmed set use the hand-drawn fallback.
  const STATIC_ICONS = { ETH: TokenETH, USDC: TokenUSDC, USDT: TokenUSDT, BNB: TokenBNB };
  if (STATIC_ICONS[symbol]) {
    const Icon = STATIC_ICONS[symbol];
    return (
      <span className="flex items-center justify-center rounded-full shrink-0 overflow-hidden" style={{ width: size, height: size }}>
        <Icon variant="branded" size={size} />
      </span>
    );
  }

  return <HandDrawnAssetGlyph symbol={symbol} size={size} color={color} />;
}

function AssetDropdown({ assetIdx, setAssetIdx, chainId, P, balances, balancesLoading, onOpen }) {
  const [open, setOpen] = useState(false);
  const [openUpward, setOpenUpward] = useState(false);
  const ref = useRef(null);
  const asset = ASSETS[assetIdx];

  useEffect(() => {
    function onDoc(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  // Real fix for the dropdown getting hidden behind the fixed bottom nav:
  // measure actual available space below the trigger every time it opens,
  // rather than always opening downward and hoping there's room. ~140px
  // covers the bottom nav's real height plus a small safety margin — if
  // less than that remains below the button, flip the menu to open
  // upward instead, so every asset stays reachable regardless of where
  // this dropdown sits on the page.
  function handleToggle() {
    if (!open && ref.current) {
      const rect = ref.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      setOpenUpward(spaceBelow < 140);
      // Real, required trigger: refresh balances the moment the list
      // opens, not just on connect/network-change, so a value that
      // changed since the last fetch is never shown stale.
      onOpen?.();
    }
    setOpen((o) => !o);
  }

  return (
    <div className="relative shrink-0" ref={ref}>
      <button onClick={handleToggle} className="flex items-center gap-1.5 pl-2 pr-2.5 py-1.5 rounded-full" style={{ background: P.pillBg }}>
        <AssetIcon symbol={asset.symbol} size={18} />
        <span className="text-[14px] font-semibold" style={{ color: P.textPrimary }}>{asset.symbol}</span>
        <ChevronDown size={14} color={P.textMuted} />
      </button>
      {open && (
        <div
          className={`absolute right-0 z-30 w-52 rounded-xl overflow-hidden shadow-2xl ${openUpward ? "bottom-full mb-2" : "top-full mt-2"}`}
          style={{ background: P.panel, border: `1px solid ${P.panelBorder}`, maxHeight: "min(60vh, 320px)", overflowY: "auto" }}
        >
          {ASSETS.map((a, i) => {
            // Real balance for this specific asset, if we have a fetched
            // value for it — assets with no real address on the current
            // chain (and thus no entry in `balances`) show nothing
            // rather than a misleading "0".
            const realBalance = balances?.[a.symbol];
            return (
              <button key={a.symbol} onClick={() => { setAssetIdx(i); setOpen(false); }} className="w-full flex items-center justify-between gap-2.5 px-3 py-2.5 text-left">
                <div className="flex items-center gap-2.5">
                  <AssetIcon symbol={a.symbol} size={22} />
                  <div className="flex flex-col">
                    <span className="text-[13px] font-medium" style={{ color: P.textPrimary }}>{a.symbol}</span>
                    <span className="text-[11px]" style={{ color: P.textMuted }}>{a.name}</span>
                  </div>
                </div>
                <span className="text-[11.5px] font-mono shrink-0" style={{ color: P.textSecondary }}>
                  {balancesLoading ? "…" : realBalance !== undefined ? fmt(realBalance, realBalance < 1 ? 4 : 2) : ""}
                </span>
              </button>
            );
          })}
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

function getOpDepositSteps() {
  return [
    { key: "fee", label: "Sending protocol fee" },
    { key: "build", label: "Preparing deposit" },
    { key: "deposit", label: `Depositing on ${CHAINS.ethereum.name}` },
    { key: "l1-confirm", label: `Confirming on ${CHAINS.ethereum.name}` },
    { key: "l2-confirm", label: `Crediting on ${CHAINS.base.name}` },
  ];
}
const OP_DEPOSIT_STEP_INDEX = { fee: 0, build: 1, deposit: 2, "l1-confirm": 3, "l2-confirm": 4 };

function getOpWithdrawInitiateSteps() {
  return [
    { key: "fee", label: "Sending protocol fee" },
    { key: "build", label: "Preparing withdrawal" },
    { key: "withdraw", label: `Submitting withdrawal on ${CHAINS.base.name}` },
    { key: "l2-confirm", label: `Confirming on ${CHAINS.base.name}` },
  ];
}
const OP_WITHDRAW_INITIATE_STEP_INDEX = { fee: 0, build: 1, withdraw: 2, "l2-confirm": 3 };

function getArbDepositSteps() {
  return [
    { key: "fee", label: "Sending protocol fee" },
    { key: "build", label: "Preparing deposit" },
    { key: "deposit", label: `Depositing on ${CHAINS.ethereum.name}` },
    { key: "confirm", label: `Crediting on ${CHAINS.robinhood.name}` },
  ];
}
const ARB_DEPOSIT_STEP_INDEX = { fee: 0, build: 1, deposit: 2, confirm: 3 };

function getArbErc20DepositSteps() {
  return [
    { key: "fee", label: "Sending protocol fee" },
    { key: "build", label: "Preparing deposit" },
    { key: "approve", label: "Approving USDC spend" },
    { key: "deposit", label: `Depositing on ${CHAINS.ethereum.name}` },
    { key: "confirm", label: `Crediting on ${CHAINS.robinhood.name}` },
  ];
}
const ARB_ERC20_DEPOSIT_STEP_INDEX = { fee: 0, build: 1, approve: 2, deposit: 3, confirm: 4 };

function getArbWithdrawInitiateSteps() {
  return [
    { key: "fee", label: "Sending protocol fee" },
    { key: "build", label: "Preparing withdrawal" },
    { key: "withdraw", label: `Submitting withdrawal on ${CHAINS.robinhood.name}` },
    { key: "confirm", label: `Confirming on ${CHAINS.robinhood.name}` },
  ];
}
const ARB_WITHDRAW_INITIATE_STEP_INDEX = { fee: 0, build: 1, withdraw: 2, confirm: 3 };

function getWormholeSteps() {
  return [
    { key: "build", label: "Preparing transfer" },
    { key: "fee", label: "Sending protocol fee" },
    { key: "lock", label: `Locking ETH on ${CHAINS.ethereum.name}` },
    { key: "attest", label: "Waiting for Wormhole guardian signatures" },
    { key: "mint", label: `Minting wrapped ETH on ${CHAINS.bnb.name}` },
  ];
}
function getWormholeReverseSteps() {
  return [
    { key: "build", label: "Preparing transfer" },
    { key: "fee", label: "Sending protocol fee" },
    { key: "lock", label: `Burning wrapped ETH on ${CHAINS.bnb.name}` },
    { key: "attest", label: "Waiting for Wormhole guardian signatures" },
    { key: "mint", label: `Unlocking ETH on ${CHAINS.ethereum.name}` },
  ];
}
const WORMHOLE_STEP_INDEX = { build: 0, fee: 1, lock: 2, attest: 3, mint: 4 };

function getRelaySteps() {
  return [
    { key: "build", label: "Getting quote from Relay" },
    { key: "deposit", label: "Confirming transaction in wallet" },
    { key: "fill", label: "Waiting for Relay solver to fill" },
  ];
}
const RELAY_STEP_INDEX = { build: 0, deposit: 1, fill: 2 };

function getTransferKind(fromKey, toKey, fromAssetSymbol, toAssetSymbol) {
  const sameAsset = fromAssetSymbol === toAssetSymbol;
  if (sameAsset && isCctpSupportedPair(fromKey, toKey) && fromAssetSymbol === "USDC") return "cctp";
  if (sameAsset && fromKey === "ethereum" && toKey === "base" && fromAssetSymbol === "ETH") return "op-deposit";
  if (sameAsset && fromKey === "ethereum" && toKey === "robinhood" && (fromAssetSymbol === "ETH" || fromAssetSymbol === "USDC")) return "arb-deposit";
  if (sameAsset && fromKey === "ethereum" && toKey === "bnb" && fromAssetSymbol === "ETH") return "wormhole";
  // Withdrawal directions (Base/Robinhood Chain -> Ethereum) are ~7 days via
  // the native canonical bridge, by fraud-proof design — that's not
  // "fixable," it's how the security model works. But Relay can move ETH
  // through this same pair in under a minute via its solver network, so
  // prefer that when available and fall back to the slow canonical route
  // only for what Relay can't handle.
  if (sameAsset && fromKey === "base" && toKey === "ethereum" && fromAssetSymbol === "ETH" && canRelayHandle(fromKey, toKey, fromAssetSymbol, toAssetSymbol)) return "relay";
  if (sameAsset && fromKey === "base" && toKey === "ethereum" && fromAssetSymbol === "ETH") return "op-withdraw";
  if (sameAsset && fromKey === "robinhood" && toKey === "ethereum" && (fromAssetSymbol === "ETH" || fromAssetSymbol === "USDC") && canRelayHandle(fromKey, toKey, fromAssetSymbol, toAssetSymbol)) return "relay";
  if (sameAsset && fromKey === "robinhood" && toKey === "ethereum" && (fromAssetSymbol === "ETH" || fromAssetSymbol === "USDC")) return "arb-withdraw";
  if (sameAsset && fromKey === "bnb" && toKey === "ethereum" && fromAssetSymbol === "ETH") return "wormhole-reverse";
  // Relay is the universal fallback for everything else — including
  // cross-asset swaps, which only Relay supports. Deliberately NOT gated by
  // a static canRelayHandle check anymore: that produced a confusing UX
  // where an unsupported pair silently fell into a fake "simulated" success
  // screen instead of a real error. Now every route either uses a native
  // protocol above, or genuinely attempts Relay — and if the exact
  // combination has no verified address or no live route, that surfaces as
  // an actual, specific error (from currencyAddress() or Relay's own API)
  // instead of a fabricated success.
  return "relay";
}

function BridgeModal({ from, to, amount, asset, toAsset, fee, etaLabel, received, devFeeAmount, destination, account, evmAddress, isFromSolana, solanaWallet, onClose, onComplete, onWithdrawalInitiated }) {
  const kind = getTransferKind(from, to, asset, toAsset);
  const isReal = kind !== "simulated";
  const steps = kind === "cctp" ? CCTP_STEPS
    : kind === "op-deposit" ? getOpDepositSteps()
    : kind === "op-withdraw" ? getOpWithdrawInitiateSteps()
    : kind === "arb-deposit" ? (asset === "USDC" ? getArbErc20DepositSteps() : getArbDepositSteps())
    : kind === "arb-withdraw" ? getArbWithdrawInitiateSteps()
    : kind === "wormhole" ? getWormholeSteps()
    : kind === "wormhole-reverse" ? getWormholeReverseSteps()
    : kind === "relay" ? getRelaySteps()
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
        const depositFn = asset === "USDC" ? runArbErc20Deposit : runArbDeposit;
        const stepIndexMap = asset === "USDC" ? ARB_ERC20_DEPOSIT_STEP_INDEX : ARB_DEPOSIT_STEP_INDEX;
        const result = await depositFn({
          amountHuman: amount,
          onStep: (key) => { if (key !== "done") setStepIndex(stepIndexMap[key] ?? 0); },
        });
        setRealBurnHash(result.l1Hash);
        setStepIndex(steps.length);
        setPhase("done");
        onComplete(result.l1Hash);
      } else if (kind === "arb-withdraw") {
        const withdrawFn = asset === "USDC" ? initiateArbErc20Withdrawal : initiateArbWithdrawal;
        const result = await withdrawFn({
          account, amountHuman: amount,
          onStep: (key) => { if (key !== "done") setStepIndex(ARB_WITHDRAW_INITIATE_STEP_INDEX[key] ?? 0); },
        });
        setRealBurnHash(result.l2TxHash);
        setStepIndex(steps.length);
        setPhase("withdrawal-initiated");
        onWithdrawalInitiated?.({ l2TxHash: result.l2TxHash, amount, account, chainType: "arb" });
      } else if (kind === "wormhole" || kind === "wormhole-reverse") {
        const transferFn = kind === "wormhole" ? runWormholeTransfer : runWormholeTransferReverse;
        const result = await transferFn({
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
      } else if (kind === "relay" && isFromSolana) {
        // Real, separate execution path for Solana-sourced transfers —
        // see relaySdkSolanaExecution.js for why this can't share the
        // EVM path below (wagmi has no concept of Solana chains at all).
        const decimals = ASSET_ONCHAIN_DECIMALS[asset];
        const totalBaseUnits = parseUnits(amount, decimals);

        setStepIndex(0);
        const result = await executeSolanaSourcedTransfer({
          solanaAddress: account,
          solanaProvider: solanaWallet.solanaProvider.current,
          toChainId: MAINNET_CHAIN_IDS[to],
          toCurrency: currencyAddress(to, toAsset),
          amountBaseUnits: totalBaseUnits.toString(),
          // Real bug fix: previously defaulted to `account`, which for a
          // Solana-sourced transfer IS the Solana address — invalid as a
          // recipient on any EVM destination chain. Relay's own docs are
          // explicit that Solana-involved routes need both wallets
          // connected; evmAddress is that second, EVM-side connection,
          // and the only valid default recipient here when no custom
          // destination is set.
          recipient: destination || evmAddress,
          onProgress: ({ currentStep, txHashes }) => {
            if (txHashes?.length) setRealBurnHash(txHashes[0]);
          },
        });
        setStepIndex(steps.length);
        setPhase("done");
        onComplete(result?.txHashes?.[0] || "");
      } else if (kind === "relay") {
        const decimals = ASSET_ONCHAIN_DECIMALS[asset];
        const totalBaseUnits = parseUnits(amount, decimals);
        const feeBaseUnits = totalBaseUnits / 100n; // 1%
        const transferBaseUnits = totalBaseUnits - feeBaseUnits;

        setStepIndex(0);
        if (feeBaseUnits > 0n) {
          await sendRelayProtocolFee({
            chainKey: from,
            chainId: MAINNET_CHAIN_IDS[from],
            assetSymbol: asset,
            feeBaseUnits,
          });
        }

        // Real fix, symmetric with the Solana-sourced path above: when
        // the DESTINATION is Solana (e.g. Base -> Solana), the default
        // recipient must be the connected Solana address, not the EVM
        // one — same category of bug as before, just the other
        // direction. Solana being involved on either side always needs
        // its own, correctly-typed address as the real recipient.
        const defaultRecipient = CHAINS[to]?.isSolana ? solanaWallet?.address : account;
        const quote = await getRelayQuote({
          fromChainKey: from, toChainKey: to,
          fromAsset: asset, toAsset: toAsset,
          amountBaseUnits: transferBaseUnits.toString(), userAddress: account,
          recipientAddress: destination || defaultRecipient,
        });
        const result = await executeRelayQuote({
          quote,
          onStep: (step) => {
            if (typeof step === "object" && step.key === "hash-known") {
              setRealBurnHash(step.txHash);
              return;
            }
            if (step !== "done") setStepIndex(RELAY_STEP_INDEX[step] ?? 0);
          },
        });
        setRealBurnHash(result.txHashes[0]);
        // Deliberately NOT setting realMintHash here: when there's only one
        // signing step (the common case), the destination-side fill is
        // executed by Relay's own solver wallet, not the user's — there is
        // no destination-chain hash tied to the user's address to show.
        // Claiming one would be misleading.
        setStepIndex(steps.length);
        setPhase("done");
        onComplete(result.txHashes[0]);
      }
    } catch (err) {
      const rawMessage = err?.message || String(err);
      const isNoRoute = /No verified mainnet contract address|Relay quote failed/i.test(rawMessage);
      setErrorMessage(isNoRoute ? `No available route for this trade yet. (${rawMessage})` : rawMessage);
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
              <div className="flex items-center justify-between text-[13px]"><span style={{ color: "#5B6472" }}>You receive</span><span className="font-mono font-medium" style={{ color: "#F2F4F7" }}>{fmt(received, 4)} {toAsset}{asset !== toAsset ? " (estimate)" : ""}</span></div>
            </div>
            <div className="flex items-start gap-2 mb-4 px-3 py-2.5 rounded-lg text-[12px]" style={{ background: isReal ? `${LIME}14` : "#1C212A", border: `1px solid ${isReal ? LIME + "40" : "#262C36"}`, color: isReal ? LIME : "#8B95A1" }}>
              <AlertTriangle size={14} className="shrink-0 mt-0.5" color={isReal ? LIME : "#F0B84D"} />
              {kind === "cctp" && "Real testnet transfer via Circle's CCTP. You'll be asked to approve and sign transactions."}
              {kind === "op-deposit" && "Real testnet deposit via Base's official bridge contract. One transaction to sign."}
              {kind === "op-withdraw" && "This only starts a real withdrawal. Base requires a 7-day challenge period — you'll need to come back later to prove and finalize it from the Withdrawals tab."}
              {kind === "arb-deposit" && asset === "USDC" && "Real testnet deposit via Robinhood Chain's Arbitrum bridge (standard ERC-20 gateway). This produces a bridged USDC representation — not CCTP-native USDC, and not Robinhood Chain's real native USDG stablecoin. Two transactions to sign (approve + deposit)."}
              {kind === "arb-deposit" && asset === "ETH" && "Real testnet deposit via Robinhood Chain's official Arbitrum bridge. One transaction to sign."}
              {kind === "arb-withdraw" && "This only starts a real withdrawal. Robinhood Chain requires a ~7-day challenge period — you'll need to come back later to finalize it from the Withdrawals tab. This integration is newer and less battle-tested than the Base one — start with a small amount."}
              {kind === "wormhole" && `Real transfer via Wormhole. You'll receive Wormhole-wrapped ETH on ${CHAINS.bnb.name} — not native BNB or any other app's wrapped ETH. This is the newest, least battle-tested integration here — start very small.`}
              {kind === "wormhole-reverse" && `Real transfer via Wormhole — burns your Wormhole-wrapped ETH on ${CHAINS.bnb.name} and unlocks the original ETH on ${CHAINS.ethereum.name}. Only works if your BNB-side ETH actually arrived via this same bridge. Just built, not yet proven live — start very small.`}
              {kind === "relay" && asset === toAsset && "Route uses Relay's solver network to enable fast, non-custodial cross-chain transfers."}
              {kind === "relay" && asset !== toAsset && `Real swap via Relay's solver network — ${asset} in, ${toAsset} out. The "You receive" amount above is a rough estimate; the actual rate is set at execution by Relay's quote, and can differ meaningfully for volatile assets. Just built, not yet proven live — start very small.`}
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
                {(kind === "wormhole" || kind === "wormhole-reverse") && <span>Your ETH is locked/burned on {kind === "wormhole" ? CHAINS.ethereum.name : CHAINS.bnb.name} — nothing is lost. Wait a bit for the guardians to finish, then tap Resume below.</span>}
                <a href={`${a.explorer}${realBurnHash}`} target="_blank" rel="noopener noreferrer" className="underline">View on {a.name} explorer</a>
              </div>
            )}
            {(kind === "wormhole" || kind === "wormhole-reverse") && realBurnHash && (
              <button
                onClick={async () => {
                  setPhase("progress");
                  setStepIndex(2);
                  setErrorMessage("");
                  try {
                    const result = await resumeWormholeTransfer({
                      srcTxHash: realBurnHash,
                      fromChainName: kind === "wormhole" ? "Ethereum" : "Bsc",
                      toChainName: kind === "wormhole" ? "Bsc" : "Ethereum",
                      toChainId: kind === "wormhole" ? getWagmiChain("bnb").id : getWagmiChain("ethereum").id,
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
                    {!realMintHash && kind === "relay" && (
                      <div className="w-full py-2 text-[11.5px] text-center" style={{ color: "#4A515D" }}>
                        Relay's solver completes the transfer on {b.name} using its own wallet, not yours — there's no destination hash tied to your address to show. Check your balance there in a minute or two.
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
          <div className="text-[12px]" style={{ color: "#4A515D" }}>Start a {CHAINS.base.name} → {CHAINS.ethereum.name} ETH transfer to see it tracked here.</div>
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

function PortfolioRow({ chainKey, address, connected, P, isFirst }) {
  const c = CHAINS[chainKey];
  const wagmiChain = getWagmiChain(chainKey);
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
          <span className="text-[11px] font-sans" style={{ color: P.textMuted }}>{NATIVE_SYMBOL_BY_CHAIN[chainKey]}</span>
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
        <div className="text-[12px]" style={{ color: P.textMuted }}>Your native balance across every supported chain will show up here.</div>
      </div>
    );
  }
  return (
    <div className="rounded-2xl overflow-hidden" style={{ background: P.panel, border: `1px solid ${P.panelBorder}` }}>
      {CHAIN_ORDER.map((key, i) => (
        <PortfolioRow key={key} chainKey={key} address={address} connected={connected} P={P} isFirst={i === 0} />
      ))}
      <div className="px-4 py-3 text-[11px]" style={{ color: P.textMuted, borderTop: `1px solid ${P.divider}` }}>
        Native balance shown for every chain. USDC shown where a real contract exists (Ethereum, Base). Other assets (USDT, WBTC, USDG, BNB) route through Relay based on your Bridge tab selection — check the Bridge tab for what's supported on a given pair.
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

function NetworkSelectorModal({ onClose, P }) {
  const { switchChain } = useSwitchChain();
  const { chainId: connectedChainId, isConnected } = useAccount();
  const chains = getChains();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(4,5,7,0.6)", backdropFilter: "blur(4px)" }}>
      <div className="w-full max-w-sm rounded-2xl p-5" style={{ background: P.bg, border: `1px solid ${P.panelBorder}` }}>
        <div className="flex items-center justify-between mb-4">
          <span className="font-display text-[16px] font-semibold" style={{ color: P.textPrimary }}>Select Network</span>
          <button onClick={onClose}><X size={18} color={P.textMuted} /></button>
        </div>
        <div className="flex flex-col gap-1.5">
          {Object.values(chains).map((chain) => {
            const wagmiChain = getWagmiChain(chain.id);
            const isActive = isConnected && connectedChainId === wagmiChain.id;
            return (
              <button
                key={chain.id}
                onClick={() => {
                  if (isConnected) switchChain({ chainId: wagmiChain.id });
                  onClose();
                }}
                className="flex items-center justify-between px-3.5 py-3 rounded-xl"
                style={{ background: isActive ? P.pillBg : "transparent", border: `1px solid ${isActive ? P.panelBorder : "transparent"}` }}
              >
                <div className="flex items-center gap-2.5">
                  <span className="w-2 h-2 rounded-full" style={{ background: chain.color }} />
                  <span className="text-[13.5px] font-medium" style={{ color: P.textPrimary }}>{chain.name}</span>
                </div>
                {isActive && <Check size={15} color={LIME_DEEP} />}
              </button>
            );
          })}
        </div>
        {!isConnected && (
          <div className="text-[11px] mt-3 text-center" style={{ color: P.textMuted }}>Connect a wallet to switch networks.</div>
        )}
      </div>
    </div>
  );
}

function WalletSelectorModal({ onClose, P }) {
  const { connect, connectors } = useConnect();
  const solanaWallet = useSolanaWallet();
  const [connectingSolana, setConnectingSolana] = useState(false);

  async function handleSolanaConnect() {
    setConnectingSolana(true);
    try {
      await solanaWallet.connect();
      onClose();
    } catch {
      // Real error is already captured in solanaWallet.error and shown
      // below — nothing further needed here beyond stopping the
      // loading state.
    } finally {
      setConnectingSolana(false);
    }
  }

  function handleInjected() {
    const injectedConnector = connectors.find((c) => c.id === "injected");
    if (injectedConnector) connect({ connector: injectedConnector });
    onClose();
  }

  function handleWalletConnect() {
    const wcConnector = connectors.find((c) => c.id === "walletConnect");
    if (wcConnector) connect({ connector: wcConnector });
    onClose();
  }

  const options = [
    {
      key: "injected",
      title: "Browser Wallet",
      subtitle: "MetaMask, OKX, or another extension already in this browser",
      onClick: handleInjected,
      loading: false,
    },
    {
      key: "walletconnect",
      title: "WalletConnect",
      subtitle: "Scan a QR code with any compatible mobile wallet",
      onClick: handleWalletConnect,
      loading: false,
    },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(4,5,7,0.6)", backdropFilter: "blur(4px)" }}>
      <div className="w-full max-w-sm rounded-2xl p-5" style={{ background: P.bg, border: `1px solid ${P.panelBorder}` }}>
        <div className="flex items-center justify-between mb-4">
          <span className="font-display text-[16px] font-semibold" style={{ color: P.textPrimary }}>Connect Wallet</span>
          <button onClick={onClose}><X size={18} color={P.textMuted} /></button>
        </div>
        <div className="flex flex-col gap-2">
          {options.map((opt) => (
            <button
              key={opt.key}
              onClick={opt.onClick}
              disabled={opt.loading}
              className="flex flex-col items-start px-3.5 py-3 rounded-xl text-left"
              style={{ background: P.pillBg, border: `1px solid ${P.panelBorder}`, opacity: opt.loading ? 0.6 : 1 }}
            >
              <span className="text-[13.5px] font-semibold" style={{ color: P.textPrimary }}>
                {opt.loading ? "Connecting…" : opt.title}
              </span>
              <span className="text-[11px] mt-0.5" style={{ color: P.textMuted }}>{opt.subtitle}</span>
            </button>
          ))}
        </div>
        {solanaWallet.error && (
          <div className="mt-3 rounded-lg p-3 text-[11.5px]" style={{ background: "#D92D2015", border: "1px solid #D92D2040", color: "#D92D20" }}>
            {solanaWallet.error}
          </div>
        )}
      </div>
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

        <DocSection title="What it is" P={P}>
          <p>Mango Protocol is a permissionless infrastructure suite for moving assets across chains and launching new tokens. Anyone can bridge, anyone can launch a token, anyone can trade — there's no gatekeeping, no approval process, no account to register. You connect a wallet and use it.</p>
        </DocSection>

        <DocSection title="Supported Networks" P={P}>
          <ul className="list-disc ml-5 flex flex-col gap-0.5">
            <li>Ethereum</li>
            <li>Base</li>
            <li>BNB Chain</li>
            <li>Robinhood Chain</li>
            <li>Stable — Tether's own L1, native gas token USDT0</li>
          </ul>
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
          <p className="mb-3"><span className="font-medium" style={{ color: P.textPrimary }}>Supported route:</span> Ethereum ↔ Base — Asset: USDC</p>

          <p className="font-semibold mb-1.5" style={{ color: P.textPrimary }}>Base Bridge (OP Stack)</p>
          <p className="mb-2">The Base Bridge is Coinbase's official canonical bridge for transferring ETH and supported assets between Ethereum and Base.</p>
          <p className="font-medium mb-1" style={{ color: P.textPrimary }}>Deposit Flow</p>
          <p className="mb-2 font-mono text-[12px]">User → Ethereum Bridge Contract → Base Sequencer → Base Network</p>
          <p className="mb-2">Deposits typically finalize within minutes.</p>
          <p className="font-medium mb-1" style={{ color: P.textPrimary }}>Withdrawal Flow</p>
          <p className="mb-2 font-mono text-[12px]">Base → Withdrawal Proof → 7-Day Challenge Period → Ethereum Release</p>
          <p className="mb-3">The challenge period protects users against fraudulent state transitions. Where a faster route exists via Relay (below), Mango Bridge prefers it for this direction and reserves the canonical 7-day path as the fallback.</p>

          <p className="font-semibold mb-1.5" style={{ color: P.textPrimary }}>Arbitrum Canonical Bridge</p>
          <p className="mb-2">Mango Bridge integrates Arbitrum's canonical bridge for Orbit chains such as Robinhood Chain.</p>
          <p className="mb-2">Deposits settle quickly while withdrawals follow Arbitrum's optimistic security model.</p>
          <p className="font-medium mb-1" style={{ color: P.textPrimary }}>Characteristics</p>
          <ul className="list-disc ml-5 mb-3 flex flex-col gap-0.5">
            <li>Native ETH and USDC</li>
            <li>Optimistic Rollup</li>
            <li>Fraud-proof secured</li>
            <li>Seven-day withdrawal period (or faster via Relay, where available)</li>
          </ul>

          <p className="font-semibold mb-1.5" style={{ color: P.textPrimary }}>Wormhole</p>
          <p className="mb-2">Wormhole enables interoperability between independent blockchains using its Guardian Network. Supports both directions between Ethereum and BNB Chain.</p>
          <p className="font-medium mb-1" style={{ color: P.textPrimary }}>Transfer Flow</p>
          <ol className="list-decimal ml-5 mb-2 flex flex-col gap-0.5">
            <li>Asset locked (or burned, on the return trip) on source chain</li>
            <li>Guardian Network observes transaction</li>
            <li>Guardians sign a VAA</li>
            <li>Destination chain verifies VAA</li>
            <li>Asset minted (or unlocked, on the return trip) on destination chain</li>
          </ol>
          <p className="mb-3"><span className="font-medium" style={{ color: P.textPrimary }}>Example:</span> Ethereum → BNB Chain — ETH becomes Wormhole-wrapped ETH. The reverse direction burns the wrapped ETH and unlocks the original.</p>

          <p className="font-semibold mb-1.5" style={{ color: P.textPrimary }}>Relay Protocol</p>
          <p className="mb-2">For chain/asset combinations with no canonical bridge — including direct transfers between Base and Robinhood Chain, and cross-asset swaps like BNB for USDC — Mango Bridge routes through Relay's solver network.</p>
          <p className="font-medium mb-1" style={{ color: P.textPrimary }}>How it's different</p>
          <p className="mb-2">Relay is non-custodial, but it's a genuinely different trust model than the canonical bridges above: you're trusting Relay's solvers to fulfill the transfer, not an audited bridge contract with no operator discretion. Failed steps auto-refund rather than leaving funds stuck.</p>
          <p>Mango Bridge only routes a pair through Relay when it has an independently verified contract address for the asset on both chains — an unverified combination is never guessed at, and the app checks for a live route before you're ever asked to confirm anything.</p>
        </DocSection>

        <DocSection title="Bridge Routing Engine" P={P}>
          <p className="mb-2">The routing engine automatically determines the optimal bridge based on:</p>
          <ul className="list-disc ml-5 mb-2 flex flex-col gap-0.5">
            <li>Source blockchain</li>
            <li>Destination blockchain</li>
            <li>Asset type (same-asset transfer or cross-asset swap)</li>
            <li>Native bridge availability</li>
            <li>Security characteristics</li>
            <li>Estimated fees and speed</li>
          </ul>
          <p>Canonical bridges are always preferred where one exists and is reasonably fast. Everything else routes through Relay, with a live check for route availability before you confirm — if no route exists for a given pair, Mango Bridge tells you plainly rather than showing a fake success.</p>
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
                {[["Circle CCTP", "Circle Attestation"], ["Base Bridge", "Ethereum + OP Stack"], ["Arbitrum Bridge", "Ethereum + Fraud Proofs"], ["Wormhole", "Guardian Network"], ["Relay Protocol", "Solver Network"]].map((row) => (
                  <tr key={row[0]} style={{ borderTop: `1px solid ${P.panelBorder}` }}>
                    <td className="px-3 py-2">{row[0]}</td>
                    <td className="px-3 py-2">{row[1]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p>This approach minimizes wrapped assets while maximizing interoperability. The app discloses which security model applies to a given route before you confirm a transfer.</p>
        </DocSection>

        <DocSection title="Transaction Lifecycle" P={P}>
          <ol className="list-decimal ml-5 flex flex-col gap-0.5">
            <li>Connect wallet</li>
            <li>Select source chain and asset</li>
            <li>Choose destination chain and asset</li>
            <li>Mango Bridge determines the optimal protocol and checks route availability</li>
            <li>User signs transaction(s)</li>
            <li>Bridge executes transfer</li>
            <li>Destination chain confirms receipt</li>
          </ol>
        </DocSection>

        <DocSection title="Fees" P={P}>
          <p className="mb-2">Users may incur:</p>
          <ul className="list-disc ml-5 mb-2 flex flex-col gap-0.5">
            <li>Source chain gas fee</li>
            <li>Destination chain gas fee (where applicable)</li>
            <li>A 1% Mango Bridge protocol fee, sent as its own separate, visible on-chain transaction — never bundled invisibly into another transfer</li>
            <li>Relay solver fee, where the route uses Relay</li>
          </ul>
          <p>Mango Bridge displays all estimated fees before confirmation.</p>
        </DocSection>

        <DocSection title="Supported Assets" P={P}>
          <p className="mb-2">Which specific assets work on which chain pair depends on the route — the app always shows this before you confirm.</p>
          <ul className="list-disc ml-5 flex flex-col gap-0.5">
            <li>ETH</li>
            <li>USDC</li>
            <li>USDT</li>
            <li>WBTC</li>
            <li>BNB</li>
            <li>USDG — Global Dollar, Robinhood Chain's native stablecoin</li>
            <li>USDT0 — Stable's native gas token</li>
          </ul>
        </DocSection>

        <DocSection title="The Bridge" P={P}>
          <p className="mb-2">Mango routes transfers across Ethereum, Base, BNB Chain, Robinhood Chain, and Stable, automatically selecting the safest available path for a given pair:</p>
          <ul className="list-disc ml-5 mb-2 flex flex-col gap-0.5">
            <li><span className="font-medium" style={{ color: P.textPrimary }}>Circle CCTP</span> for native USDC between Ethereum and Base — no wrapped tokens, burn-and-mint via Circle's own attestation service</li>
            <li><span className="font-medium" style={{ color: P.textPrimary }}>OP Stack canonical bridge</span> for ETH between Ethereum and Base</li>
            <li><span className="font-medium" style={{ color: P.textPrimary }}>Arbitrum canonical bridge</span> for ETH and USDC between Ethereum and Robinhood Chain</li>
            <li><span className="font-medium" style={{ color: P.textPrimary }}>Wormhole</span> for ETH between Ethereum and BNB Chain, both directions</li>
            <li><span className="font-medium" style={{ color: P.textPrimary }}>Relay Protocol</span> for everything else with a verified contract on both sides — cross-asset swaps, and any pair without a canonical bridge</li>
          </ul>
          <p>A 1% protocol fee applies to real transfers, sent as its own visible transaction. The app checks for a live route before you're ever asked to confirm — an unsupported pair is never silently faked as a success.</p>
        </DocSection>

        <DocSection title="The Launchpad" P={P}>
          <p className="mb-2">Every token launches directly into a live Uniswap v4 pool, trading on real, audited Uniswap infrastructure from the first buy. Prices move on genuine market activity from block one.</p>
          <p className="font-semibold mb-1.5" style={{ color: P.textPrimary }}>Launching a token</p>
          <ol className="list-decimal ml-5 mb-2 flex flex-col gap-0.5">
            <li>Connect your wallet</li>
            <li>Set a name, ticker, and description</li>
            <li>Upload artwork (stored on public IPFS)</li>
            <li>Optionally link an X profile and Telegram</li>
            <li>Optionally make a developer buy — purchasing some of your own supply at launch</li>
            <li>Confirm — your token is live in a real trading pool immediately</li>
          </ol>
          <p className="mb-2"><span className="font-medium" style={{ color: P.textPrimary }}>Trading fees:</span> 1% per trade, split 70% to the token's creator and 30% to the Mango Protocol treasury — paid automatically inside the same transaction as the trade. Nothing to claim, ever.</p>
          <p><span className="font-medium" style={{ color: P.textPrimary }}>Creator tools:</span> the Profile page tracks your launches, holdings, unrealized PnL, and total creator fees earned over time, all in one place.</p>
        </DocSection>

        <DocSection title="How Uniswap v4 Hooks Work" P={P}>
          <p className="mb-2">Every version of Uniswap before v4 deployed a separate contract per trading pair. V4 replaced that with a <span className="font-medium" style={{ color: P.textPrimary }}>singleton</span> — one contract, PoolManager, holding every pool's state internally. Creating a pool isn't a deployment anymore; it's a cheap state update in a contract that already exists.</p>
          <p className="mb-2">A <span className="font-medium" style={{ color: P.textPrimary }}>hook</span> is a separate contract attached to a specific pool, which PoolManager calls automatically at defined moments — before or after a swap, before or after liquidity changes, and so on. This is where custom logic lives. Mango's hook uses exactly two of these: <span className="font-mono text-[12px]">afterInitialize</span> (registers the token's creator when the pool is created) and <span className="font-mono text-[12px]">afterSwap</span> (splits and pays out the trading fee).</p>
          <p className="mb-2">The distinctive part: a hook's permissions are encoded directly into its own contract address. Developers use CREATE2 with a specifically-mined salt to produce an address whose lowest bits spell out exactly which hook functions it's allowed to use. PoolManager reads those bits straight off the address — no permissions can be added after deployment, and a hook can never claim capabilities it wasn't deployed with. Mango's hook address is mined to expose only those two functions, nothing else.</p>
          <p>This is also why fees never need claiming: v4's "flash accounting" tracks running balance changes within a single transaction and only settles the net result at the very end. That's the exact mechanism the hook uses to split a trade's fee and send both shares to their destination wallets — inside the swap itself, not as a separate step afterward.</p>
        </DocSection>

        <DocSection title="Powered by Uniswap v4 Hooks" P={P}>
          <p className="mb-2">Every token launched on Mango deploys onto a real Uniswap v4 hook — the same permission-mined, singleton-native architecture live on Robinhood Chain since day one. No custom AMM, no forked contracts, no bolted-on middleware — just Uniswap's actual PoolManager, doing what it was built to do.</p>
          <p>That's what makes the 70/30 fee split real instead of a promise: the hook redirects each trade's fee split inside the same transaction as the swap itself, the moment it settles. One click to launch, and the token is trading against genuine, audited, first-party Uniswap infrastructure — not a clone, not a wrapper, the real thing.</p>
        </DocSection>

        <DocSection title="Contracts" P={P}>
          <p className="mb-2">Deployed and verified on Robinhood Chain mainnet — tap any to view on the block explorer.</p>
          <p className="font-medium mb-1.5" style={{ color: P.textPrimary }}>Current (live now)</p>
          <div className="flex flex-col gap-2 mb-3">
            <a href="https://robinhoodchain.blockscout.com/address/0x8aD6607EbBAd5F4A088EDC25e98B3B454F9E912A" target="_blank" rel="noopener noreferrer" className="rounded-lg p-3" style={{ background: P.panel, border: `1px solid ${P.panelBorder}` }}>
              <div className="text-[12px] font-medium mb-0.5" style={{ color: P.textPrimary }}>MangoLaunchFactory</div>
              <div className="text-[11px] font-mono break-all" style={{ color: P.textSecondary }}>0x8aD6607EbBAd5F4A088EDC25e98B3B454F9E912A</div>
            </a>
            <a href="https://robinhoodchain.blockscout.com/address/0x6df44617b8C13AB961dCe5097F9375AE6BE09044" target="_blank" rel="noopener noreferrer" className="rounded-lg p-3" style={{ background: P.panel, border: `1px solid ${P.panelBorder}` }}>
              <div className="text-[12px] font-medium mb-0.5" style={{ color: P.textPrimary }}>MangoLaunchHook (v4)</div>
              <div className="text-[11px] font-mono break-all" style={{ color: P.textSecondary }}>0x6df44617b8C13AB961dCe5097F9375AE6BE09044</div>
            </a>
            <a href="https://robinhoodchain.blockscout.com/address/0xb4D9c0928d0bf15ACa8D698cb83703752CfdF785" target="_blank" rel="noopener noreferrer" className="rounded-lg p-3" style={{ background: P.panel, border: `1px solid ${P.panelBorder}` }}>
              <div className="text-[12px] font-medium mb-0.5" style={{ color: P.textPrimary }}>MangoLaunchRegistry (v3)</div>
              <div className="text-[11px] font-mono break-all" style={{ color: P.textSecondary }}>0xb4D9c0928d0bf15ACa8D698cb83703752CfdF785</div>
            </a>
            <a href="https://robinhoodchain.blockscout.com/address/0xb347EEad23D4FC41338845E35Ee8Fc42D9789d70" target="_blank" rel="noopener noreferrer" className="rounded-lg p-3" style={{ background: P.panel, border: `1px solid ${P.panelBorder}` }}>
              <div className="text-[12px] font-medium mb-0.5" style={{ color: P.textPrimary }}>MangoLaunchRouter (v4)</div>
              <div className="text-[11px] font-mono break-all" style={{ color: P.textSecondary }}>0xb347EEad23D4FC41338845E35Ee8Fc42D9789d70</div>
            </a>
          </div>

          <p className="font-medium mb-1.5" style={{ color: P.textPrimary }}>Version history</p>
          <div className="flex flex-col gap-2 text-[11px]" style={{ color: P.textSecondary }}>
            <div>
              <span className="font-medium" style={{ color: P.textPrimary }}>Hook v1 → v2:</span> redesigned the fee structure — flat 3% became 1% buy, 4% sell pre-graduation (real anti-dump protection), 1% both ways after.
            </div>
            <div>
              <span className="font-medium" style={{ color: P.textPrimary }}>Hook/Registry v2 → v3:</span> added a permanent, separate admin role. The old design let only the current operator reassign itself — once that became a contract with no forwarding function, it got permanently stuck. Confirmed on real mainnet, not caught in testing.
            </div>
            <div>
              <span className="font-medium" style={{ color: P.textPrimary }}>Hook v3 → v4:</span> fixed a missing permission bit. The hook computed trading fees correctly but was never granted permission to actually apply them — every real trade reverted until this was found and fixed.
            </div>
            <div>
              <span className="font-medium" style={{ color: P.textPrimary }}>Factory v1 → v2:</span> fixed an over-settlement bug — the original transferred a token's full supply to seed liquidity, when tick-rounding meant slightly less was actually owed, leaving an unclaimed credit that reverted every launch.
            </div>
            <div>
              <span className="font-medium" style={{ color: P.textPrimary }}>Router v1 → v2 → v3:</span> updated to point at each new Hook version in turn.
            </div>
            <div>
              <span className="font-medium" style={{ color: P.textPrimary }}>Router v3 → v4:</span> fixed a settlement ordering bug in the sell path — buys worked correctly before this fix, sells didn't.
            </div>
          </div>
        </DocSection>

        <DocSection title="Custody" P={P}>
          <p>Mango never takes custody of user funds at any point, on either the bridge or the launchpad. Bridge transfers move directly through the underlying protocol's own contracts — Circle's, Optimism's, Arbitrum's, Wormhole's, or Relay's. Launchpad trades settle through Uniswap's own PoolManager. Your wallet signs every transaction directly with that infrastructure; Mango's role is routing and fee collection, not holding.</p>
        </DocSection>

        <DocSection title="Future Roadmap" P={P}>
          <ul className="list-disc ml-5 flex flex-col gap-0.5">
            <li>Additional EVM networks</li>
            <li>Solana integration</li>
            <li>Avalanche integration</li>
            <li>Polygon support</li>
            <li>Cross-chain messaging</li>
            <li>Bridge analytics dashboard</li>
            <li>Developer SDK</li>
            <li>REST API</li>
            <li>Telegram Bot integration</li>
          </ul>
        </DocSection>

        <div className="flex items-center gap-2 mt-2">
          <a
            href="https://x.com/Mango_protocol"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center gap-2 flex-1 py-3 rounded-xl text-[13px] font-medium"
            style={{ background: P.panel, border: `1px solid ${P.panelBorder}`, color: P.textPrimary }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
              <path d="M18.9 2H22l-7.6 8.7L23.3 22h-6.8l-5.3-6.9L5 22H1.9l8.1-9.3L1 2h7l4.8 6.3L18.9 2Zm-1.2 18h1.9L7.4 4H5.4l12.3 16Z" fill={P.textPrimary} />
            </svg>
            Follow on X
          </a>
          <a
            href="https://t.me/mango_protocol"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center gap-2 flex-1 py-3 rounded-xl text-[13px] font-medium"
            style={{ background: P.panel, border: `1px solid ${P.panelBorder}`, color: P.textPrimary }}
          >
            <Send size={14} /> Join our Telegram
          </a>
        </div>
      </div>
    </div>
  );
}

export default function MangoBridge() {
  const [theme, setTheme] = useState("light");
  const [from, setFrom] = useState("base");
  const [to, setTo] = useState("ethereum");
  const [amount, setAmount] = useState("");
  const [fromAssetIdx, setFromAssetIdxRaw] = useState(0);
  const [toAssetIdx, setToAssetIdxRaw] = useState(0);
  function handleFromAssetChange(idx) { setFromAssetIdxRaw(idx); setAmount(""); }
  function handleToAssetChange(idx) { setToAssetIdxRaw(idx); } // don't clear amount — user is choosing what to receive, not resetting input
  const [tab, setTab] = useState("bridge");
  const [historySubTab, setHistorySubTab] = useState("transfers");
  const [balances, setBalances] = useState(DEFAULT_BALANCES);
  const [history, setHistory] = useState([]);
  const [withdrawals, setWithdrawals] = useState([]);
  const [showModal, setShowModal] = useState(false);
  const [showDocs, setShowDocs] = useState(false);
  const [showNetworkSelector, setShowNetworkSelector] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [sendToOther, setSendToOther] = useState(false);
  const [destAddress, setDestAddress] = useState("");

  const { address, isConnected, chainId: connectedChainId } = useAccount();
  const { connect, connectors, isPending: isConnecting, error: connectError } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();
  const solanaWallet = useSolanaWallet();
  const [showWalletSelector, setShowWalletSelector] = useState(false);

  // Real, unified concept: which wallet is actually relevant depends on
  // which chain is selected as the SOURCE (the one being signed FROM).
  // Genuinely necessary now that two completely separate wallet systems
  // exist side by side — this is the one place that decides which one
  // matters for the current selection, so downstream code doesn't have
  // to keep re-deciding it.
  const isFromSolana = CHAINS[from]?.isSolana;
  const activeAccount = isFromSolana ? solanaWallet.address : address;
  const connected = isFromSolana ? !!solanaWallet.address : isConnected;

  // Real, live balances for every asset relevant to the current "from"
  // chain — not just the currently-selected one. Powers the balance
  // display directly inside the asset dropdown itself.
  const [fromChainBalances, setFromChainBalances] = useState({});
  const [balancesLoading, setBalancesLoading] = useState(false);

  const refreshFromChainBalances = useCallback(async () => {
    if (!connected) { setFromChainBalances({}); return; }
    setBalancesLoading(true);
    try {
      const real = isFromSolana
        ? await fetchSolanaBalance({ solanaAddress: solanaWallet.address })
        : await fetchAllEvmBalances({ chainKey: from, nativeSymbol: NATIVE_SYMBOL_BY_CHAIN[from], address });
      setFromChainBalances(real);
    } finally {
      setBalancesLoading(false);
    }
  }, [connected, isFromSolana, from, address, solanaWallet.address]);

  // Refreshes on wallet connect and network change — the third required
  // trigger (asset list opening) is wired directly into AssetDropdown's
  // own onClick below, since that's a real user action, not state this
  // effect can observe on its own.
  useEffect(() => {
    refreshFromChainBalances();
  }, [refreshFromChainBalances]);

  const fromWagmiChain = getWagmiChain(from);
  // Wrong-network detection is an EVM-wallet concept — doesn't apply when
  // the source chain is Solana, since that's a completely separate
  // connection (OKX Connect), not something wagmi/MetaMask tracks at all.
  const onWrongNetwork = connected && !CHAINS[from]?.isSolana && connectedChainId !== fromWagmiChain.id;

  const { data: liveBalance, isLoading: balanceLoading } = useBalance({
    address,
    chainId: fromWagmiChain.id,
    query: { enabled: connected && !CHAINS[from]?.isSolana },
  });

  const fromAsset = ASSETS[fromAssetIdx];
  const toAsset = ASSETS[toAssetIdx];
  const isNativeAsset = fromAsset.symbol === NATIVE_SYMBOL_BY_CHAIN[from];
  const isRealUsdcPair = fromAsset.symbol === "USDC" && toAsset.symbol === "USDC" && isCctpSupportedPair(from, to);
  const usdcTokenAddress = isRealUsdcPair ? CCTP_CHAINS[from].usdc : undefined;

  const { data: liveUsdcBalance, isLoading: usdcBalanceLoading } = useBalance({
    address,
    token: usdcTokenAddress,
    chainId: fromWagmiChain.id,
    query: { enabled: connected && isRealUsdcPair && !CHAINS[from]?.isSolana },
  });

  const usingLiveBalance = connected && (isNativeAsset || isRealUsdcPair) && !CHAINS[from]?.isSolana;
  const liveBalanceLoading = isNativeAsset ? balanceLoading : usdcBalanceLoading;
  const liveBalanceValue = isNativeAsset ? liveBalance : liveUsdcBalance;

  const toWagmiChain = getWagmiChain(to);
  const isNativeAssetTo = toAsset.symbol === NATIVE_SYMBOL_BY_CHAIN[to];
  const isRealUsdcPairTo = isRealUsdcPair;
  const usdcTokenAddressTo = isRealUsdcPairTo ? CCTP_CHAINS[to].usdc : undefined;

  const { data: liveBalanceTo, isLoading: balanceLoadingTo } = useBalance({
    address,
    chainId: toWagmiChain.id,
    query: { enabled: connected && isNativeAssetTo && !CHAINS[to]?.isSolana },
  });
  const { data: liveUsdcBalanceTo, isLoading: usdcBalanceLoadingTo } = useBalance({
    address,
    token: usdcTokenAddressTo,
    chainId: toWagmiChain.id,
    query: { enabled: connected && isRealUsdcPairTo && !CHAINS[to]?.isSolana },
  });

  const usingLiveBalanceTo = connected && (isNativeAssetTo || isRealUsdcPairTo);
  const liveBalanceLoadingTo = isNativeAssetTo ? balanceLoadingTo : usdcBalanceLoadingTo;
  const liveBalanceValueTo = isNativeAssetTo ? liveBalanceTo : liveUsdcBalanceTo;

  useEffect(() => {
    // Merged against DEFAULT_BALANCES, not just loaded as-is — otherwise
    // anyone with balances already saved from before Stable existed would
    // still be missing that key entirely, even after the fix above,
    // since loadJSON returns the cached value verbatim with no merging.
    setBalances({ ...DEFAULT_BALANCES, ...loadJSON("mango:balances", DEFAULT_BALANCES) });
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

  function swap() { setFrom(to); setTo(from); setFromAssetIdxRaw(toAssetIdx); setToAssetIdxRaw(fromAssetIdx); }
  // Real bug fix: switching chains never reset the selected asset, so a
  // stale asset from the previous chain (e.g. BNB) could stay selected
  // even after switching to a chain that doesn't support it at all (e.g.
  // Stable, which only ever has USDT0). Resetting to each chain's native
  // asset on change guarantees the selection is always valid.
  function defaultAssetIdxFor(chainKey) {
    const native = NATIVE_SYMBOL_BY_CHAIN[chainKey];
    const idx = ASSETS.findIndex((a) => a.symbol === native);
    return idx >= 0 ? idx : 0;
  }
  function handleFromChange(id) { setFrom(id); if (id === to) setTo(CHAIN_ORDER.find((c) => c !== id)); setFromAssetIdxRaw(defaultAssetIdxFor(id)); setAmount(""); }
  function handleToChange(id) { setTo(id); if (id === from) setFrom(CHAIN_ORDER.find((c) => c !== id)); setToAssetIdxRaw(defaultAssetIdxFor(id)); setAmount(""); }
  function handleConnect() {
    setShowWalletSelector(true);
  }

  const isCrossAsset = fromAsset.symbol !== toAsset.symbol;
  const kind = getTransferKind(from, to, fromAsset.symbol, toAsset.symbol);
  const amtNum = Math.max(0, parseFloat(amount) || 0);

  // Proactive route check: for anything going through Relay, fetch a real
  // quote in the background as soon as there's a valid amount, rather than
  // waiting until the user taps confirm to find out a route doesn't exist.
  // This is what actually answers "tell the user there's no available route"
  // — a live check, not a guess based on which addresses we happen to have.
  const [routeCheck, setRouteCheck] = useState({ status: "idle" });
  useEffect(() => {
    if (kind !== "relay" || amtNum <= 0 || !connected || !address || (CHAINS[to]?.isSolana && !sendToOther && !solanaWallet.address)) {
      setRouteCheck({ status: "idle" });
      return;
    }
    let cancelled = false;
    setRouteCheck({ status: "checking" });
    const timer = setTimeout(async () => {
      try {
        const decimals = ASSET_ONCHAIN_DECIMALS[fromAsset.symbol];
        if (!decimals) throw new Error(`No decimals known for ${fromAsset.symbol} — can't safely build an amount.`);
        const amountBaseUnits = parseUnits(amount, decimals).toString();
        await getRelayQuote({
          fromChainKey: from, toChainKey: to,
          fromAsset: fromAsset.symbol, toAsset: toAsset.symbol,
          amountBaseUnits, userAddress: activeAccount,
          // Same real fix as the execution path — a Solana source needs
          // the connected EVM address as the recipient on an EVM
          // destination, not the Solana address itself.
          // Same real fix, symmetric for both directions — Solana
          // involved on EITHER side needs its own correctly-typed
          // address as the recipient, not whichever wallet happens to
          // be the "account" for the source side.
          recipientAddress: sendToOther ? destAddress : (CHAINS[to]?.isSolana ? solanaWallet.address : (isFromSolana ? address : activeAccount)),
        });
        if (!cancelled) setRouteCheck({ status: "ok" });
      } catch (err) {
        if (!cancelled) setRouteCheck({ status: "unavailable", message: err?.message || String(err) });
      }
    }, 600); // debounce so we don't fire a request per keystroke
    return () => { cancelled = true; clearTimeout(timer); };
  }, [kind, amtNum, connected, address, from, to, fromAsset.symbol, toAsset.symbol, amount]);
  const routeUnavailable = kind === "relay" && routeCheck.status === "unavailable";
  const routeChecking = kind === "relay" && routeCheck.status === "checking";
  const fee = CHAINS[from].baseFee + CHAINS[to].baseFee;
  const devFeeAmount = amtNum * DEV_FEE_PCT;
  const seconds = Math.max(CHAINS[from].baseSeconds, CHAINS[to].baseSeconds);
  const etaLabel = seconds < 60 ? `~${seconds}s` : `~${Math.round(seconds / 60)} min`;
  // For same-asset transfers this is a direct estimate. For cross-asset swaps
  // this converts through each asset's rough USD price as a ROUGH estimate
  // only — the real exchange rate comes from Relay's live quote at execution
  // time and can differ meaningfully from this number, especially for
  // volatile assets. Never treat this as authoritative for a swap.
  const amtNumUsdValue = (amtNum - devFeeAmount) * (fromAsset.price || 1) - fee;
  const received = Math.max(amtNumUsdValue / (toAsset.price || 1), 0);
  const availableBalance = usingLiveBalance && liveBalanceValue ? Number(liveBalanceValue.formatted) : null;
  // Native assets need to keep a small amount aside for gas — MAX-ing out a
  // native balance to the exact wei is a classic way to end up unable to pay
  // for the transaction that spends it. ERC-20s don't need this (gas is paid
  // in the native token, separately from the token being sent).
  const GAS_RESERVE = { ETH: 0.0004, BNB: 0.001, USDT0: 0.5 };
  const gasReserve = GAS_RESERVE[fromAsset.symbol] ?? 0;
  const spendableBalance = availableBalance !== null ? Math.max(availableBalance - gasReserve, 0) : null;
  const insufficient = usingLiveBalance && spendableBalance !== null && amtNum > spendableBalance;
  // Symmetric requirement: Solana involved on EITHER side needs its own
  // real connection before a valid recipient can even be determined —
  // not just when it's the source.
  const needsEvmAddressForSolanaSource = isFromSolana && !CHAINS[to]?.isSolana && !sendToOther && !address;
  const needsSolanaAddressForSolanaDest = CHAINS[to]?.isSolana && !isFromSolana && !sendToOther && !solanaWallet.address;
  const canBridge = amtNum > 0 && from !== to && !insufficient && !onWrongNetwork && !needsEvmAddressForSolanaSource && !needsSolanaAddressForSolanaDest && (!sendToOther || isValidDestinationAddress(destAddress, CHAINS[to]?.isSolana));

  function persist(newBalances, newHistory) {
    saveJSON("mango:balances", newBalances);
    saveJSON("mango:history", newHistory);
  }
  function handleComplete(hash) {
    const newBalances = {
      ...balances,
      [from]: { ...balances[from], [fromAsset.symbol]: Math.max(0, (balances[from][fromAsset.symbol] || 0) - amtNum) },
      [to]: { ...balances[to], [toAsset.symbol]: (balances[to][toAsset.symbol] || 0) + received },
    };
    const entry = { id: Date.now(), from, to, amount: amtNum, symbol: fromAsset.symbol, toSymbol: toAsset.symbol, hash, timestamp: Date.now(), status: "complete" };
    const newHistory = [entry, ...history];
    setBalances(newBalances);
    setHistory(newHistory);
    persist(newBalances, newHistory);
  }
  function resetHistory() {
    setHistory([]);
    removeKey("mango:history");
  }
  function setMax() { if (spendableBalance !== null) setAmount(String(spendableBalance)); }

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
    <div className="min-h-screen w-full pb-24 relative overflow-x-hidden" style={{ background: P.bg, fontFamily: "'Inter', sans-serif" }}>
      <style>{`
        .font-display { font-family: 'Space Grotesk', sans-serif; }
        .font-mono { font-family: 'IBM Plex Mono', monospace; }
        input[type=number]::-webkit-inner-spin-button { -webkit-appearance: none; }
        input:focus { outline: none; }
      `}</style>

      <FloatingMangoDecor P={P} />

      {/* Top nav */}
      <div className="flex items-center justify-between px-6 py-4 relative" style={{ borderBottom: `1px solid ${P.divider}`, zIndex: 1, paddingTop: "calc(16px + env(safe-area-inset-top, 0px))" }}>
        <div className="flex items-center gap-2.5">
          <MangoLogo size={24} color={P.textPrimary} />
          <span className="font-display text-[11px] font-semibold tracking-tight" style={{ color: P.textPrimary }}>Mango Protocol</span>
        </div>
        <div className="flex items-center gap-1.5">
          <a href="https://x.com/Mango_protocol" target="_blank" rel="noopener noreferrer" className="w-8 h-8 rounded-full flex items-center justify-center" style={{ background: P.panel, border: `1px solid ${P.panelBorder}` }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
              <path d="M18.9 2H22l-7.6 8.7L23.3 22h-6.8l-5.3-6.9L5 22H1.9l8.1-9.3L1 2h7l4.8 6.3L18.9 2Zm-1.2 18h1.9L7.4 4H5.4l12.3 16Z" fill={P.textSecondary} />
            </svg>
          </a>
          <a href="https://t.me/mango_protocol" target="_blank" rel="noopener noreferrer" className="w-8 h-8 rounded-full flex items-center justify-center" style={{ background: P.panel, border: `1px solid ${P.panelBorder}` }}>
            <Send size={13} color={P.textSecondary} />
          </a>
          <button onClick={toggleTheme} className="w-8 h-8 rounded-full flex items-center justify-center" style={{ background: P.panel, border: `1px solid ${P.panelBorder}` }}>
            {theme === "light" ? <Moon size={13} color={P.textSecondary} /> : <Sun size={13} color={P.textSecondary} />}
          </button>
          <button onClick={() => setShowNetworkSelector(true)} className="w-8 h-8 rounded-full flex items-center justify-center" style={{ background: P.panel, border: `1px solid ${P.panelBorder}` }}>
            <Globe size={13} color={P.textSecondary} />
          </button>
          {connected ? (
            <button onClick={() => (isFromSolana ? solanaWallet.disconnect() : disconnect())} className="flex items-center gap-1.5 pl-2 pr-3 py-1.5 rounded-full text-[12px] font-semibold" style={{ background: P.ctaBg, color: P.ctaText }}>
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: LIME }} />
              {activeAccount ? `${activeAccount.slice(0, 5)}…${activeAccount.slice(-3)}` : ""}
            </button>
          ) : (
            <button onClick={handleConnect} disabled={isConnecting} className="px-3.5 py-1.5 rounded-full text-[12px] font-semibold" style={{ background: P.ctaBg, color: P.ctaText, opacity: isConnecting ? 0.6 : 1 }}>
              {isConnecting ? "Connecting…" : "Connect"}
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
          ) : tab === "launchpad" ? (
            <LaunchpadTab P={P} />
          ) : (
            <>
              {/* You send */}
              <div className="rounded-2xl p-4 shadow-sm" style={{ background: P.panel, border: `1px solid ${P.panelBorder}` }}>
                <div className="flex items-center justify-between mb-2.5">
                  <span className="text-[12.5px] font-medium" style={{ color: P.textSecondary }}>You send</span>
                  <span className="text-[11.5px]" style={{ color: P.textMuted }}>
                    {usingLiveBalance && (liveBalanceLoading ? "Loading balance…" : `Balance: ${fmt(availableBalance, fromAsset.decimals)} ${fromAsset.symbol}`)}
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
                  <AssetDropdown assetIdx={fromAssetIdx} setAssetIdx={handleFromAssetChange} chainId={from} P={P} balances={fromChainBalances} balancesLoading={balancesLoading} onOpen={refreshFromChainBalances} />
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
                    {usingLiveBalanceTo && (liveBalanceLoadingTo ? "Loading balance…" : `Balance: ${fmt(Number(liveBalanceValueTo?.formatted ?? 0), toAsset.decimals)} ${toAsset.symbol}`)}
                  </span>
                </div>
                <div className="flex items-center justify-between mb-3">
                  <ChainDropdown value={to} exclude={from} onChange={handleToChange} P={P} />
                </div>
                <div className="flex items-center justify-between rounded-xl px-3.5 py-3" style={{ background: P.input, border: `1px solid ${P.panelBorder}` }}>
                  <span className="font-display text-[24px] font-semibold" style={{ color: amtNum > 0 ? P.textPrimary : P.textMuted }}>{amtNum > 0 ? fmt(received, 4) : "0"}</span>
                  <AssetDropdown assetIdx={toAssetIdx} setAssetIdx={handleToAssetChange} chainId={to} P={P} />
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
                  <div className="flex items-center justify-between text-[12.5px]"><span style={{ color: P.textSecondary }}>Protocol fee (1%)</span><span className="font-mono" style={{ color: P.textPrimary }}>{fmt(devFeeAmount, fromAsset.decimals)} {fromAsset.symbol}</span></div>
                </div>
              )}

              {/* Real, contextual second-wallet prompt — only appears at
                  all when Solana is genuinely involved on either side of
                  the current selection, since that's the only time a
                  second, separate wallet is actually needed. */}
              {(isFromSolana || CHAINS[to]?.isSolana) && !solanaWallet.address && (
                <div className="mt-3 rounded-xl p-3.5" style={{ background: P.panel, border: `1px solid ${P.panelBorder}` }}>
                  <div className="text-[12.5px] font-medium mb-1" style={{ color: P.textPrimary }}>Solana wallet needed</div>
                  <div className="text-[11px] mb-2.5" style={{ color: P.textMuted }}>
                    Solana isn't EVM-compatible, so this route needs its own separate connection, alongside your regular wallet.
                  </div>
                  <button
                    onClick={async () => { try { await solanaWallet.connect(); } catch {} }}
                    disabled={solanaWallet.connecting}
                    className="w-full py-2.5 rounded-lg text-[12.5px] font-semibold"
                    style={{ background: P.ctaBg, color: P.ctaText, opacity: solanaWallet.connecting ? 0.6 : 1 }}
                  >
                    {solanaWallet.connecting ? "Connecting…" : "Connect Solana Wallet"}
                  </button>
                  {solanaWallet.error && (
                    <div className="mt-2 text-[10.5px]" style={{ color: "#D92D20" }}>{solanaWallet.error}</div>
                  )}
                </div>
              )}

              {/* Send to another address */}
              <div className="mt-3 rounded-xl p-3.5" style={{ background: P.panel, border: `1px solid ${P.panelBorder}` }}>
                <label className="flex items-center gap-2.5 cursor-pointer">
                  <input type="checkbox" checked={sendToOther} onChange={(e) => setSendToOther(e.target.checked)} className="w-4 h-4 rounded" style={{ accentColor: LIME }} />
                  <span className="text-[12.5px] font-medium" style={{ color: P.textPrimary }}>Send to another address</span>
                </label>
                {sendToOther && (
                  <>
                    <input
                      value={destAddress}
                      onChange={(e) => setDestAddress(e.target.value)}
                      placeholder={`Enter ${CHAINS[to].name} address`}
                      className="w-full mt-2.5 px-3 py-2.5 rounded-lg text-[13px] font-mono"
                      style={{ background: P.input, border: `1px solid ${destAddress.trim() && !isValidDestinationAddress(destAddress, CHAINS[to]?.isSolana) ? "#D92D20" : P.panelBorder}`, color: P.textPrimary }}
                    />
                    {destAddress.trim() && !isValidDestinationAddress(destAddress, CHAINS[to]?.isSolana) && (
                      <div className="text-[11px] mt-1.5" style={{ color: "#D92D20" }}>
                        Invalid {CHAINS[to].name} address
                      </div>
                    )}
                  </>
                )}
              </div>

              {/* CTA */}
              <button
                disabled={!connected || !canBridge || routeUnavailable}
                onClick={() => setShowModal(true)}
                className="w-full mt-4 py-3.5 rounded-full font-display font-semibold text-[15px]"
                style={{
                  background: !connected || !canBridge || routeUnavailable ? P.ctaDisabledBg : P.ctaBg,
                  color: !connected || !canBridge || routeUnavailable ? P.ctaDisabledText : P.ctaText,
                  cursor: connected && canBridge && !routeUnavailable ? "pointer" : "not-allowed",
                }}
              >
                {!connected ? "Connect wallet" : onWrongNetwork ? "Switch network to continue" : from === to ? "Choose different chains" : amtNum <= 0 ? "Enter an amount" : insufficient ? "Insufficient balance" : needsEvmAddressForSolanaSource ? "Connect an EVM wallet to receive on this chain" : needsSolanaAddressForSolanaDest ? "Connect a Solana wallet to receive on this chain" : sendToOther && !destAddress.trim() ? "Enter destination address" : sendToOther && !isValidDestinationAddress(destAddress, CHAINS[to]?.isSolana) ? `Invalid ${CHAINS[to].name} address` : routeUnavailable ? "No route available for this trade" : routeChecking ? "Checking route…" : ["op-withdraw", "arb-withdraw"].includes(kind) ? "Start withdrawal" : isCrossAsset ? "Swap assets" : "Bridge assets"}
              </button>
              {routeUnavailable && (
                <div className="text-center mt-2 text-[11.5px]" style={{ color: "#D92D20" }}>
                  No available route for this trade right now — {fromAsset.symbol} on {CHAINS[from].name} to {toAsset.symbol} on {CHAINS[to].name} isn't supported yet.
                  {routeCheck.message && (
                    <div className="mt-1 opacity-70 font-mono text-[10px]">{routeCheck.message}</div>
                  )}
                </div>
              )}

              <div className="text-center mt-4 text-[11.5px]" style={{ color: P.textMuted }}>
                Powered by Relay Protocol. Only verified routes are enabled. Estimated arrival time and fees are shown before you confirm.
              </div>
            </>
          )}
        </div>
      </div>

      {/* Bottom nav */}
      <div className="fixed bottom-0 left-0 right-0 flex justify-center px-4 pb-4 pt-2 z-40" style={{ background: `linear-gradient(to top, ${P.bg} 60%, transparent)` }}>
        <div className="flex items-center gap-0.5 p-1.5 rounded-full shadow-lg overflow-x-auto max-w-full" style={{ background: P.panel, border: `1px solid ${P.panelBorder}` }}>
          {[
            { id: "bridge", label: "Bridge", icon: ArrowUpDown },
            { id: "launchpad", label: "Launch", icon: Rocket },
            { id: "history", label: "History", icon: HistoryIcon },
            { id: "portfolio", label: "Portfolio", icon: Briefcase },
          ].map((n) => {
            const Icon = n.icon;
            const active = tab === n.id;
            return (
              <button
                key={n.id}
                onClick={() => setTab(n.id)}
                className="flex items-center gap-1 px-2.5 py-2.5 rounded-full text-[11.5px] font-medium whitespace-nowrap shrink-0"
                style={{ background: active ? P.navActive : "transparent", color: active ? P.navActiveText : P.textSecondary }}
              >
                <Icon size={14} /> {n.label}
              </button>
            );
          })}
          <button
            onClick={() => setShowDocs(true)}
            className="flex items-center gap-1 px-2.5 py-2.5 rounded-full text-[11.5px] font-medium whitespace-nowrap shrink-0"
            style={{ color: P.textSecondary }}
          >
            <BookOpen size={14} /> Docs
          </button>
        </div>
      </div>

      {showModal && (
        <BridgeModal
          from={from} to={to} amount={amount} asset={fromAsset.symbol} toAsset={toAsset.symbol} fee={fee} etaLabel={etaLabel} received={received}
          devFeeAmount={devFeeAmount}
          destination={sendToOther ? destAddress : null}
          account={activeAccount}
          evmAddress={address}
          isFromSolana={isFromSolana}
          solanaWallet={solanaWallet}
          onClose={() => setShowModal(false)}
          onComplete={handleComplete}
          onWithdrawalInitiated={handleWithdrawalInitiated}
        />
      )}
      {showDocs && <DocsModal onClose={() => setShowDocs(false)} P={P} />}
      {showWalletSelector && <WalletSelectorModal onClose={() => setShowWalletSelector(false)} P={P} />}
      {showNetworkSelector && <NetworkSelectorModal onClose={() => setShowNetworkSelector(false)} P={P} />}
    </div>
  );
}
