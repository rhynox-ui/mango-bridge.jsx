// src/MangoWallet.jsx
//
// Mango Wallet — Phase 1 (see solana-program/README.md-style status notes
// below): a genuinely self-custodial wallet embedded directly in the site.
// The recovery phrase is generated, encrypted, and stored ENTIRELY in this
// browser — src/wallet/keys.js and src/wallet/vault.js never make a
// network call, and nothing here ever sends a mnemonic, private key, or
// derived signing material to Mango's backend in any form. That's a
// deliberate, different trust model from the Telegram bot's wallet (which
// is necessarily custodial — see mango-telegram-bot's wallet.service.ts).
//
// STATUS:
// - Real: create/import a BIP-39 wallet, password-encrypted local storage
//   (AES-256-GCM via Web Crypto, PBKDF2-SHA256/600k), one EVM address
//   (valid across all 27 EVM chains this wallet supports — 14 shared with
//   the Bridge, 13 wallet-only, see walletChains.js) + one Solana address,
//   derived from a single seed (same derivation paths MetaMask/Phantom
//   use — see src/wallet/keys.js for why that matters); live native AND
//   token balance display (ERC-20 on EVM, SPL on Solana, both restricted
//   to addresses this project has independently verified — never a
//   guessed contract/mint address); real USD price display for assets
//   with a confidently-verified CoinGecko id (walletPrices.js); password-
//   gated reveal of the recovery phrase; wallet reset; sending native and
//   token transfers on both chain families with a real fee estimate
//   shown before confirming; unlimited HD-derived accounts under one seed
//   (same "Add account" model OKX Wallet uses — see keys.js's
//   deriveAccountAtIndex); multiple independent seed-phrase WALLETS too
//   (OKX's separate "Add wallet" — a different seed entirely, new or
//   imported, each with its own unlimited accounts, all under the one
//   password set at onboarding); standalone private-key import/export as
//   a separate, single-chain concept from either (matching OKX's own
//   restriction: a raw imported key has no seed to derive siblings from);
//   custom names for wallets, HD accounts, and imported keys alike. All
//   of this is offline-verified (real transaction construction/signing/
//   encoding, checked against this sandbox's own tools) but NOT
//   broadcast-tested against a live network — this sandbox's egress
//   proxy blocks RPC and price-API traffic entirely (confirmed via direct
//   curl, same limitation documented in solana-program/README.md for the
//   Solana program side of this project) — needs real-world testing on
//   the deployed site before WALLET_LIVE flips to true.
// - Also real, but a separate deliverable from this file: a browser
//   extension (extension/) injecting a real EIP-1193 provider
//   (window.ethereum) and a Phantom-compatible Solana provider
//   (window.solana) into every page, with EIP-6963 discovery, so any
//   dApp can connect to Mango Wallet like it would MetaMask or Phantom.
//   Its own vault is separate from this tab's (different browser
//   origin — see extension/README.md) and its signing logic
//   (extension/src/signing.js) is independently offline-verified in
//   scripts/verify-extension-signing.mjs, same real-crypto-recovery
//   discipline as this file's own send/sign paths.
// - Not yet built: an aggregate portfolio USD total (needs balance state
//   lifted out of each independent row).

import React, { useState, useEffect, useCallback, useRef } from "react";
// Static, named imports only — same convention App.jsx's AssetIcon/ChainIcon
// already established for this package. A namespace import with dynamic
// property access (Web3Icons[name]) defeats tree-shaking and can pull the
// entire icon library into the bundle; these 13 are exactly what's used.
import {
  NetworkPolygon, NetworkOptimism, NetworkZksync, NetworkLinea, NetworkScroll, NetworkGnosis,
  NetworkMonad, NetworkSonic, NetworkMantle, NetworkBlast, NetworkBerachain, NetworkWorld, NetworkSeiNetwork,
} from "@web3icons/react";
import { Wallet, Eye, EyeOff, Copy, Check, AlertTriangle, Lock, Plus, Download, RefreshCw, Trash2, ArrowLeft, ShieldAlert, ExternalLink, ChevronDown, Send as SendIcon, Pencil } from "lucide-react";
import { isAddress, parseUnits } from "viem";
import { PublicKey } from "@solana/web3.js";
import { PALETTE, LIME, LIME_DEEP, fmt } from "./theme.js";
import { ChainBadge } from "./App.jsx";
import { MAINNET_CHAIN_IDS } from "./chainData.js";
import { generateMnemonic, isValidMnemonic, deriveAccountAtIndex, normalizeMnemonic } from "./wallet/keys.js";
import { encryptSecret, decryptSecret, saveVault, loadVault, clearVault } from "./wallet/vault.js";
import { parseImportedPrivateKey, KeyImportError } from "./wallet/walletKeyImport.js";
import { fetchWalletNativeBalance, fetchWalletSolanaBalance, fetchWalletTokenBalance, fetchWalletSplTokenBalance, getWalletChain } from "./wallet/walletRpc.js";
import {
  estimateEvmSendFee, sendEvmNative, estimateSolanaSendFee, sendSolanaNative,
  estimateEvmTokenSendFee, sendEvmToken, estimateSplSendFee, sendSplToken,
} from "./wallet/sendTransaction.js";
import { tokensForWalletChain } from "./wallet/walletTokens.js";
import { SPL_TOKENS } from "./wallet/walletSplTokens.js";
import { fetchWalletPrices } from "./wallet/walletPrices.js";
import {
  WALLET_ONLY_CHAIN_ORDER, WALLET_ONLY_CHAIN_LABEL, WALLET_ONLY_NATIVE_SYMBOL,
} from "./wallet/walletChains.js";

const SOLANA_EXPLORER_TX_URL = "https://solscan.io/tx/";

function isValidChainAddress(chainKey, address) {
  if (!address || !address.trim()) return false;
  if (chainKey === "solana") {
    try { new PublicKey(address.trim()); return true; } catch { return false; }
  }
  return isAddress(address.trim());
}

// Every chain the Bridge already supports, PLUS the wallet-only additions
// from walletChains.js — see that file for why those stay wallet-scoped
// rather than also being added to the Bridge's own chain list.
const WALLET_CHAIN_ORDER = [...Object.keys(MAINNET_CHAIN_IDS), ...WALLET_ONLY_CHAIN_ORDER];
const CHAIN_LABEL = {
  ethereum: "Ethereum", base: "Base", bnb: "BNB Chain", robinhood: "Robinhood Chain",
  stable: "Stable", solana: "Solana", arbitrum: "Arbitrum One", avalanche: "Avalanche",
  abstract: "Abstract", hyperevm: "HyperEVM", ink: "Ink", plasma: "Plasma",
  unichain: "Unichain", xlayer: "X Layer",
  ...WALLET_ONLY_CHAIN_LABEL,
};
const NATIVE_SYMBOL_BY_CHAIN = {
  ethereum: "ETH", base: "ETH", bnb: "BNB", robinhood: "ETH", stable: "USDT0", solana: "SOL",
  arbitrum: "ETH", avalanche: "AVAX", abstract: "ETH", hyperevm: "HYPE",
  ink: "ETH", plasma: "XPL", unichain: "ETH", xlayer: "OKB",
  ...WALLET_ONLY_NATIVE_SYMBOL,
};
const MIN_PASSWORD_LENGTH = 8;

// App.jsx's ChainBadge only knows the Bridge's own chain set — for the
// wallet-only additions, render the verified @web3icons/react icon
// directly instead. Keyed by chain id rather than by the export-name
// string from walletChains.js, so the icon components above stay real
// static imports (see the import comment) rather than a dynamic lookup.
const WALLET_ONLY_ICON = {
  polygon: NetworkPolygon, optimism: NetworkOptimism, zksync: NetworkZksync,
  linea: NetworkLinea, scroll: NetworkScroll, gnosis: NetworkGnosis,
  monad: NetworkMonad, sonic: NetworkSonic, mantle: NetworkMantle,
  blast: NetworkBlast, berachain: NetworkBerachain, worldchain: NetworkWorld, sei: NetworkSeiNetwork,
};
function WalletChainBadge({ id, size = 18 }) {
  const Icon = WALLET_ONLY_ICON[id];
  if (!Icon) return <ChainBadge id={id} size={size} />;
  return (
    <span className="flex items-center justify-center rounded-full shrink-0 overflow-hidden" style={{ width: size, height: size }}>
      <Icon variant="branded" size={size} />
    </span>
  );
}

// ---------------------------------------------------------------------------
// Small shared building blocks
// ---------------------------------------------------------------------------

function CopyableAddress({ address, P, size = 12.5 }) {
  const [copied, setCopied] = useState(false);
  function handleCopy() {
    navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  return (
    <button onClick={handleCopy} className="inline-flex items-center gap-1.5 font-mono" style={{ fontSize: size, color: P.textSecondary }}>
      <span>{address.slice(0, 6)}…{address.slice(-4)}</span>
      {copied ? <Check size={12} color={LIME_DEEP} /> : <Copy size={12} />}
    </button>
  );
}

// Every attribute here exists for one reason: browser/password-manager
// extensions (LastPass, 1Password, Bitwarden, Dashlane, browser-native
// autofill) actively scan password-type inputs and offer to capture and
// cloud-sync whatever's typed into them — which for a recovery-phrase or
// wallet-password field is exactly the kind of secret that must never end
// up in a third party's cloud vault. autoComplete="off"/"new-password"
// stops the browser's own save-password prompt; the data-* attributes are
// each manager's own documented opt-out signal.
const NO_CAPTURE_ATTRS = {
  autoComplete: "off",
  autoCorrect: "off",
  autoCapitalize: "off",
  spellCheck: false,
  "data-lpignore": "true", // LastPass
  "data-1p-ignore": "true", // 1Password
  "data-bwignore": "true", // Bitwarden
  "data-form-type": "other", // Dashlane
};

function PasswordField({ value, onChange, placeholder, P, autoFocus }) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <input
        type={visible ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoFocus={autoFocus}
        {...NO_CAPTURE_ATTRS}
        className="w-full px-3.5 py-3 pr-10 rounded-xl text-[14px]"
        style={{ background: P.input, border: `1px solid ${P.panelBorder}`, color: P.textPrimary }}
      />
      <button type="button" onClick={() => setVisible((v) => !v)} className="absolute right-3 top-1/2 -translate-y-1/2" style={{ color: P.textMuted }}>
        {visible ? <EyeOff size={15} /> : <Eye size={15} />}
      </button>
    </div>
  );
}

function ScreenShell({ title, onBack, P, children }) {
  return (
    <div className="rounded-2xl p-5" style={{ background: P.panel, border: `1px solid ${P.panelBorder}` }}>
      <div className="flex items-center gap-2 mb-4">
        {onBack && (
          <button onClick={onBack} style={{ color: P.textMuted }}>
            <ArrowLeft size={16} />
          </button>
        )}
        <span className="font-display text-[15px] font-semibold" style={{ color: P.textPrimary }}>{title}</span>
      </div>
      {children}
    </div>
  );
}

function PrimaryButton({ onClick, disabled, children, P }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="w-full py-3 rounded-full font-display font-semibold text-[14px]"
      style={{ background: disabled ? P.ctaDisabledBg : P.ctaBg, color: disabled ? P.ctaDisabledText : P.ctaText, cursor: disabled ? "not-allowed" : "pointer" }}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Balances
// ---------------------------------------------------------------------------

// Real USD price for one symbol, or null if walletPrices.js has no
// confidently-verified id for it (see that file for which assets that
// covers and why) — a row simply omits its USD line in that case, rather
// than showing a guessed value.
function useUsdPrice(symbol) {
  const [price, setPrice] = useState(null);
  useEffect(() => {
    let cancelled = false;
    fetchWalletPrices()
      .then((prices) => { if (!cancelled) setPrice(prices[symbol] ?? null); })
      .catch(() => { if (!cancelled) setPrice(null); });
    return () => { cancelled = true; };
  }, [symbol]);
  return price;
}

function UsdSubtext({ balance, price, P }) {
  if (balance === null || price === null) return null;
  return <div className="text-[10.5px] text-right" style={{ color: P.textMuted }}>${fmt(balance * price, 2)}</div>;
}

function EvmBalanceRow({ chainKey, evmAddress, P, isFirst, forceFresh }) {
  // Uses walletRpc.js's own independent viem client — deliberately not
  // wagmi's shared useBalance/config, which the Bridge tab's connected-wallet
  // flows use. See walletRpc.js for why: keeps this tab's 13-chain balance
  // polling from contending with real bridge activity for the same RPC
  // endpoints. forceFresh (true only right after the manual refresh button)
  // bypasses walletRpc.js's 15s cache; every other mount reads through it.
  const [balance, setBalance] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchWalletNativeBalance(chainKey, evmAddress, { forceFresh })
      .then((b) => { if (!cancelled) { setBalance(b); setLoading(false); } })
      .catch(() => { if (!cancelled) { setBalance(null); setLoading(false); } });
    return () => { cancelled = true; };
  }, [chainKey, evmAddress, forceFresh]);
  const price = useUsdPrice(NATIVE_SYMBOL_BY_CHAIN[chainKey]);
  return (
    <div className="flex items-center justify-between px-4 py-3" style={{ borderTop: isFirst ? "none" : `1px solid ${P.divider}` }}>
      <div className="flex items-center gap-2.5">
        <WalletChainBadge id={chainKey} size={24} />
        <span className="text-[13px] font-medium" style={{ color: P.textPrimary }}>{CHAIN_LABEL[chainKey]}</span>
      </div>
      <div>
        <div className="flex items-center gap-1.5 text-[13px] font-mono font-medium" style={{ color: P.textPrimary }}>
          <span>{loading ? "…" : balance !== null ? balance.toFixed(4) : "—"}</span>
          <span className="text-[11px] font-sans" style={{ color: P.textMuted }}>{NATIVE_SYMBOL_BY_CHAIN[chainKey]}</span>
        </div>
        <UsdSubtext balance={balance} price={price} P={P} />
      </div>
    </div>
  );
}

function TokenBalanceRow({ chainKey, token, evmAddress, P, forceFresh }) {
  const [balance, setBalance] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchWalletTokenBalance(chainKey, token.address, token.decimals, evmAddress, { forceFresh })
      .then((b) => { if (!cancelled) { setBalance(b); setLoading(false); } })
      .catch(() => { if (!cancelled) { setBalance(null); setLoading(false); } });
    return () => { cancelled = true; };
  }, [chainKey, token.address, token.decimals, evmAddress, forceFresh]);
  const price = useUsdPrice(token.symbol);
  return (
    <div className="flex items-center justify-between px-4 py-2 pl-11" style={{ borderTop: `1px solid ${P.divider}` }}>
      <span className="text-[11.5px]" style={{ color: P.textMuted }}>{token.symbol}</span>
      <div>
        <div className="flex items-center gap-1.5 text-[12px] font-mono" style={{ color: P.textSecondary }}>
          <span>{loading ? "…" : balance !== null ? fmt(balance, balance < 1 ? 4 : 2) : "—"}</span>
        </div>
        <UsdSubtext balance={balance} price={price} P={P} />
      </div>
    </div>
  );
}

function SplTokenBalanceRow({ token, solanaAddress, P, forceFresh }) {
  const [balance, setBalance] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchWalletSplTokenBalance(token.mint, token.decimals, solanaAddress, { forceFresh })
      .then((b) => { if (!cancelled) { setBalance(b); setLoading(false); } })
      .catch(() => { if (!cancelled) { setBalance(null); setLoading(false); } });
    return () => { cancelled = true; };
  }, [token.mint, token.decimals, solanaAddress, forceFresh]);
  const price = useUsdPrice(token.symbol);
  return (
    <div className="flex items-center justify-between px-4 py-2 pl-11" style={{ borderTop: `1px solid ${P.divider}` }}>
      <span className="text-[11.5px]" style={{ color: P.textMuted }}>{token.symbol}</span>
      <div>
        <div className="flex items-center gap-1.5 text-[12px] font-mono" style={{ color: P.textSecondary }}>
          <span>{loading ? "…" : balance !== null ? fmt(balance, balance < 1 ? 4 : 2) : "—"}</span>
        </div>
        <UsdSubtext balance={balance} price={price} P={P} />
      </div>
    </div>
  );
}

function SolanaBalanceRow({ solanaAddress, P, forceFresh }) {
  const [balance, setBalance] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchWalletSolanaBalance(solanaAddress, { forceFresh })
      .then((b) => { if (!cancelled) { setBalance(b); setLoading(false); } })
      .catch(() => { if (!cancelled) { setBalance(null); setLoading(false); } });
    return () => { cancelled = true; };
  }, [solanaAddress, forceFresh]);
  const price = useUsdPrice("SOL");
  return (
    <div className="flex items-center justify-between px-4 py-3" style={{ borderTop: `1px solid ${P.divider}` }}>
      <div className="flex items-center gap-2.5">
        <ChainBadge id="solana" size={24} />
        <span className="text-[13px] font-medium" style={{ color: P.textPrimary }}>Solana</span>
      </div>
      <div>
        <div className="flex items-center gap-1.5 text-[13px] font-mono font-medium" style={{ color: P.textPrimary }}>
          <span>{loading ? "…" : fmt(balance ?? 0, 4)}</span>
          <span className="text-[11px] font-sans" style={{ color: P.textMuted }}>SOL</span>
        </div>
        <UsdSubtext balance={balance} price={price} P={P} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Onboarding: welcome
// ---------------------------------------------------------------------------

function WelcomeScreen({ onCreate, onImport, P }) {
  return (
    <div className="rounded-2xl p-6 flex flex-col items-center text-center gap-3" style={{ background: P.panel, border: `1px solid ${P.panelBorder}` }}>
      <div className="w-11 h-11 rounded-full flex items-center justify-center" style={{ background: `${LIME}1A` }}>
        <Wallet size={19} color={LIME_DEEP} />
      </div>
      <div>
        <div className="font-display text-[16px] font-semibold mb-1" style={{ color: P.textPrimary }}>Mango Wallet</div>
        <div className="text-[12.5px] leading-relaxed" style={{ color: P.textMuted }}>
          A self-custodial wallet, generated and stored only in this browser. Mango never sees your recovery phrase or private keys — not encrypted, not in any form.
        </div>
      </div>
      <div className="w-full flex flex-col gap-2 mt-2">
        <PrimaryButton onClick={onCreate} P={P}>Create a new wallet</PrimaryButton>
        <button onClick={onImport} className="w-full py-3 rounded-full text-[13.5px] font-medium" style={{ background: P.pillBg, color: P.textPrimary }}>
          I already have a recovery phrase
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Onboarding: create
// ---------------------------------------------------------------------------

function CreateRevealStep({ mnemonic, onNext, onBack, P }) {
  const [revealed, setRevealed] = useState(false);
  const [acked, setAcked] = useState(false);
  const words = mnemonic.split(" ");
  return (
    <ScreenShell title="Your recovery phrase" onBack={onBack} P={P}>
      <div className="text-[12px] mb-3 flex items-start gap-2" style={{ color: P.textMuted }}>
        <ShieldAlert size={14} className="shrink-0 mt-0.5" color="#D92D20" />
        <span>Write these 12 words down in order and keep them somewhere offline. Anyone with this phrase has full control of every asset in this wallet, on every chain. Mango has no copy of it and cannot recover it for you.</span>
      </div>
      <div className="relative">
        <div className="grid grid-cols-3 gap-2 p-3 rounded-xl mb-3" style={{ background: P.input, border: `1px solid ${P.panelBorder}`, filter: revealed ? "none" : "blur(6px)" }}>
          {words.map((w, i) => (
            <div key={i} className="flex items-center gap-1.5 text-[12.5px] font-mono" style={{ color: P.textPrimary }}>
              <span style={{ color: P.textMuted }}>{i + 1}.</span>{w}
            </div>
          ))}
        </div>
        {!revealed && (
          <button onClick={() => setRevealed(true)} className="absolute inset-0 flex items-center justify-center gap-1.5 text-[12.5px] font-semibold rounded-xl" style={{ color: P.textPrimary }}>
            <Eye size={14} /> Tap to reveal
          </button>
        )}
      </div>
      <label className="flex items-start gap-2.5 cursor-pointer mb-4">
        <input type="checkbox" checked={acked} onChange={(e) => setAcked(e.target.checked)} className="w-4 h-4 rounded mt-0.5" style={{ accentColor: LIME }} />
        <span className="text-[12px]" style={{ color: P.textSecondary }}>I've written down my recovery phrase and understand it's the only way to recover this wallet.</span>
      </label>
      <PrimaryButton onClick={onNext} disabled={!revealed || !acked} P={P}>Continue</PrimaryButton>
    </ScreenShell>
  );
}

function CreateConfirmStep({ mnemonic, onConfirmed, onBack, P }) {
  const words = mnemonic.split(" ");
  // Three random, distinct positions — same real purpose as MetaMask/Phantom's
  // re-entry step: proves the phrase was actually written down, not just
  // clicked past. Picked once per mount so it doesn't reshuffle on re-render.
  const checkIndices = useRef(
    Array.from({ length: 12 }, (_, i) => i).sort(() => Math.random() - 0.5).slice(0, 3).sort((a, b) => a - b)
  ).current;
  const [inputs, setInputs] = useState({});
  const [error, setError] = useState("");

  function handleSubmit() {
    const allCorrect = checkIndices.every((i) => (inputs[i] || "").trim().toLowerCase() === words[i]);
    if (!allCorrect) { setError("One or more words don't match — check your written-down copy and try again."); return; }
    setError("");
    onConfirmed();
  }

  return (
    <ScreenShell title="Confirm your phrase" onBack={onBack} P={P}>
      <div className="text-[12px] mb-3" style={{ color: P.textMuted }}>Enter the requested words from what you wrote down.</div>
      <div className="flex flex-col gap-2.5 mb-4">
        {checkIndices.map((i) => (
          <div key={i} className="flex items-center gap-2.5">
            <span className="text-[12px] w-16 shrink-0" style={{ color: P.textMuted }}>Word #{i + 1}</span>
            <input
              value={inputs[i] || ""}
              onChange={(e) => setInputs((s) => ({ ...s, [i]: e.target.value }))}
              {...NO_CAPTURE_ATTRS}
              className="flex-1 px-3 py-2 rounded-lg text-[13px] font-mono"
              style={{ background: P.input, border: `1px solid ${P.panelBorder}`, color: P.textPrimary }}
            />
          </div>
        ))}
      </div>
      {error && <div className="text-[11.5px] mb-3" style={{ color: "#D92D20" }}>{error}</div>}
      <PrimaryButton onClick={handleSubmit} disabled={checkIndices.some((i) => !(inputs[i] || "").trim())} P={P}>Confirm</PrimaryButton>
    </ScreenShell>
  );
}

function SetPasswordStep({ onSet, onBack, P, title, helpText }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const tooShort = password.length > 0 && password.length < MIN_PASSWORD_LENGTH;
  const mismatch = confirm.length > 0 && password !== confirm;
  const valid = password.length >= MIN_PASSWORD_LENGTH && password === confirm;
  return (
    <ScreenShell title={title} onBack={onBack} P={P}>
      <div className="text-[12px] mb-3" style={{ color: P.textMuted }}>{helpText}</div>
      <div className="flex flex-col gap-2.5 mb-1">
        <PasswordField value={password} onChange={setPassword} placeholder="Password" P={P} autoFocus />
        <PasswordField value={confirm} onChange={setConfirm} placeholder="Confirm password" P={P} />
      </div>
      {tooShort && <div className="text-[11.5px] mt-1.5 mb-2" style={{ color: "#D92D20" }}>At least {MIN_PASSWORD_LENGTH} characters.</div>}
      {mismatch && <div className="text-[11.5px] mt-1.5 mb-2" style={{ color: "#D92D20" }}>Passwords don't match.</div>}
      <div className="mt-3">
        <PrimaryButton onClick={() => onSet(password)} disabled={!valid} P={P}>Set password</PrimaryButton>
      </div>
    </ScreenShell>
  );
}

// Used when finishing "Add wallet" — unlike SetPasswordStep (onboarding
// the very first wallet), every later wallet is encrypted under the
// password that already protects this browser's vault, so this just
// verifies it rather than setting a new one.
function VerifyPasswordStep({ title, helpText, buttonLabel, onVerify, onBack, P }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleSubmit() {
    setBusy(true);
    setError("");
    const ok = await onVerify(password);
    setBusy(false);
    if (!ok) setError("Incorrect password.");
  }

  return (
    <ScreenShell title={title} onBack={onBack} P={P}>
      <div className="text-[12px] mb-3" style={{ color: P.textMuted }}>{helpText}</div>
      <PasswordField value={password} onChange={setPassword} placeholder="Password" P={P} autoFocus />
      {error && <div className="text-[11.5px] mt-2" style={{ color: "#D92D20" }}>{error}</div>}
      <div className="mt-3">
        <PrimaryButton onClick={handleSubmit} disabled={!password || busy} P={P}>{busy ? "Adding…" : buttonLabel}</PrimaryButton>
      </div>
    </ScreenShell>
  );
}

function ImportPhraseStep({ onImported, onBack, P }) {
  const [phrase, setPhrase] = useState("");
  const [error, setError] = useState("");
  const normalized = normalizeMnemonic(phrase);
  const wordCount = phrase.trim() ? normalized.split(" ").length : 0;

  function handleContinue() {
    if (!isValidMnemonic(normalized)) { setError("That doesn't look like a valid recovery phrase — check the word order and spelling."); return; }
    setError("");
    onImported(normalized);
  }

  return (
    <ScreenShell title="Import wallet" onBack={onBack} P={P}>
      <div className="text-[12px] mb-3" style={{ color: P.textMuted }}>Enter your 12 or 24-word recovery phrase, separated by spaces.</div>
      <textarea
        value={phrase}
        onChange={(e) => setPhrase(e.target.value)}
        placeholder="word1 word2 word3 ..."
        rows={3}
        {...NO_CAPTURE_ATTRS}
        className="w-full px-3.5 py-3 rounded-xl text-[13px] font-mono resize-none mb-2"
        style={{ background: P.input, border: `1px solid ${P.panelBorder}`, color: P.textPrimary }}
      />
      <div className="text-[11px] mb-3" style={{ color: P.textMuted }}>{wordCount > 0 ? `${wordCount} words` : " "}</div>
      {error && <div className="text-[11.5px] mb-3" style={{ color: "#D92D20" }}>{error}</div>}
      <PrimaryButton onClick={handleContinue} disabled={!phrase.trim()} P={P}>Continue</PrimaryButton>
    </ScreenShell>
  );
}

// ---------------------------------------------------------------------------
// Locked / unlock
// ---------------------------------------------------------------------------

function LockedScreen({ onUnlock, P }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleUnlock() {
    setBusy(true);
    setError("");
    const ok = await onUnlock(password);
    setBusy(false);
    if (!ok) setError("Incorrect password.");
  }

  return (
    <div className="rounded-2xl p-6 flex flex-col items-center text-center gap-3" style={{ background: P.panel, border: `1px solid ${P.panelBorder}` }}>
      <div className="w-11 h-11 rounded-full flex items-center justify-center" style={{ background: P.pillBg }}>
        <Lock size={18} color={P.textSecondary} />
      </div>
      <div className="font-display text-[15px] font-semibold" style={{ color: P.textPrimary }}>Unlock Mango Wallet</div>
      <div className="w-full flex flex-col gap-2.5">
        <PasswordField value={password} onChange={setPassword} placeholder="Password" P={P} autoFocus />
        {error && <div className="text-[11.5px]" style={{ color: "#D92D20" }}>{error}</div>}
        <PrimaryButton onClick={handleUnlock} disabled={!password || busy} P={P}>{busy ? "Unlocking…" : "Unlock"}</PrimaryButton>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Unlocked dashboard
// ---------------------------------------------------------------------------

function RevealPhraseModal({ walletId, onClose, P }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [phrase, setPhrase] = useState(null);

  async function handleReveal() {
    const vault = loadVault();
    try {
      const walletEntry = vault.wallets.find((w) => w.id === walletId);
      const decrypted = await decryptSecret(walletEntry.mnemonicRecord, password);
      setPhrase(decrypted);
      setError("");
    } catch {
      setError("Incorrect password.");
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(4,5,7,0.6)", backdropFilter: "blur(4px)" }}>
      <div className="w-full max-w-sm rounded-2xl p-5" style={{ background: P.bg, border: `1px solid ${P.panelBorder}` }}>
        <div className="flex items-center justify-between mb-3">
          <span className="font-display text-[15px] font-semibold" style={{ color: P.textPrimary }}>Reveal recovery phrase</span>
          <button onClick={onClose} style={{ color: P.textMuted }}>✕</button>
        </div>
        {!phrase ? (
          <>
            <div className="text-[12px] mb-3" style={{ color: P.textMuted }}>Re-enter your password to view it. Make sure nobody can see your screen.</div>
            <PasswordField value={password} onChange={setPassword} placeholder="Password" P={P} autoFocus />
            {error && <div className="text-[11.5px] mt-2" style={{ color: "#D92D20" }}>{error}</div>}
            <div className="mt-3"><PrimaryButton onClick={handleReveal} disabled={!password} P={P}>Reveal</PrimaryButton></div>
          </>
        ) : (
          <div className="grid grid-cols-3 gap-2 p-3 rounded-xl" style={{ background: P.input, border: `1px solid ${P.panelBorder}` }}>
            {phrase.split(" ").map((w, i) => (
              <div key={i} className="flex items-center gap-1.5 text-[12.5px] font-mono" style={{ color: P.textPrimary }}>
                <span style={{ color: P.textMuted }}>{i + 1}.</span>{w}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function RevealPrivateKeyModal({ session, activeKey, onClose, P }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [revealed, setRevealed] = useState(false);

  async function handleReveal() {
    const vault = loadVault();
    try {
      if (activeKey.type === "hd") {
        const walletEntry = vault.wallets.find((w) => w.id === activeKey.walletId);
        await decryptSecret(walletEntry.mnemonicRecord, password); // just confirms the password — the key itself is already in session, derived at unlock
      } else {
        const entry = (vault.importedKeys ?? []).find((k) => k.id === activeKey.id);
        await decryptSecret(entry.record, password);
      }
      setRevealed(true);
      setError("");
    } catch {
      setError("Incorrect password.");
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(4,5,7,0.6)", backdropFilter: "blur(4px)" }}>
      <div className="w-full max-w-sm rounded-2xl p-5" style={{ background: P.bg, border: `1px solid ${P.panelBorder}` }}>
        <div className="flex items-center justify-between mb-3">
          <span className="font-display text-[15px] font-semibold" style={{ color: P.textPrimary }}>Export private key</span>
          <button onClick={onClose} style={{ color: P.textMuted }}>✕</button>
        </div>
        {!revealed ? (
          <>
            <div className="text-[12px] mb-3" style={{ color: P.textMuted }}>
              Anyone with this key has full control of every asset it can access. Re-enter your password to view it.
            </div>
            <PasswordField value={password} onChange={setPassword} placeholder="Password" P={P} autoFocus />
            {error && <div className="text-[11.5px] mt-2" style={{ color: "#D92D20" }}>{error}</div>}
            <div className="mt-3"><PrimaryButton onClick={handleReveal} disabled={!password} P={P}>Reveal</PrimaryButton></div>
          </>
        ) : (
          <div className="flex flex-col gap-3">
            {session.evm && (
              <div>
                <div className="text-[11px] mb-1" style={{ color: P.textMuted }}>EVM (all chains)</div>
                <div className="p-3 rounded-xl text-[12px] font-mono break-all" style={{ background: P.input, border: `1px solid ${P.panelBorder}`, color: P.textPrimary }}>
                  {session.evm.privateKey}
                </div>
              </div>
            )}
            {session.solana && (
              <div>
                <div className="text-[11px] mb-1" style={{ color: P.textMuted }}>Solana</div>
                <div className="p-3 rounded-xl text-[12px] font-mono break-all" style={{ background: P.input, border: `1px solid ${P.panelBorder}`, color: P.textPrimary }}>
                  {session.solana.privateKey}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ImportKeyModal({ onClose, onImport, P }) {
  const [rawKey, setRawKey] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleSubmit() {
    setBusy(true);
    setError("");
    try {
      await onImport(rawKey, password);
      onClose();
    } catch (err) {
      setError(err instanceof KeyImportError ? err.message : "Incorrect password.");
    }
    setBusy(false);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(4,5,7,0.6)", backdropFilter: "blur(4px)" }}>
      <div className="w-full max-w-sm rounded-2xl p-5" style={{ background: P.bg, border: `1px solid ${P.panelBorder}` }}>
        <div className="flex items-center justify-between mb-3">
          <span className="font-display text-[15px] font-semibold" style={{ color: P.textPrimary }}>Import private key</span>
          <button onClick={onClose} style={{ color: P.textMuted }}>✕</button>
        </div>
        <div className="text-[12px] mb-3" style={{ color: P.textMuted }}>
          An EVM (0x…) or Solana (base58) private key. This account is separate from your recovery phrase — losing this specific key means losing access to it, even if you still have your phrase.
        </div>
        <textarea
          value={rawKey}
          onChange={(e) => setRawKey(e.target.value)}
          placeholder="Private key"
          rows={2}
          {...NO_CAPTURE_ATTRS}
          className="w-full px-3.5 py-3 rounded-xl text-[13px] font-mono resize-none mb-2.5"
          style={{ background: P.input, border: `1px solid ${P.panelBorder}`, color: P.textPrimary }}
        />
        <PasswordField value={password} onChange={setPassword} placeholder="Your wallet password" P={P} />
        {error && <div className="text-[11.5px] mt-2" style={{ color: "#D92D20" }}>{error}</div>}
        <div className="mt-3"><PrimaryButton onClick={handleSubmit} disabled={!rawKey.trim() || !password || busy} P={P}>{busy ? "Importing…" : "Import"}</PrimaryButton></div>
      </div>
    </div>
  );
}

function ResetWalletModal({ onClose, onConfirmReset, P }) {
  const [confirmText, setConfirmText] = useState("");
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(4,5,7,0.6)", backdropFilter: "blur(4px)" }}>
      <div className="w-full max-w-sm rounded-2xl p-5" style={{ background: P.bg, border: `1px solid ${P.panelBorder}` }}>
        <div className="flex items-center gap-2 mb-3">
          <AlertTriangle size={16} color="#D92D20" />
          <span className="font-display text-[15px] font-semibold" style={{ color: P.textPrimary }}>Remove all wallets</span>
        </div>
        <div className="text-[12px] mb-3" style={{ color: P.textMuted }}>
          This deletes every wallet and imported key stored in this browser, not just the active one. If you haven't backed up each recovery phrase and private key, everything is lost permanently — Mango cannot recover it. Type REMOVE to confirm.
        </div>
        <input
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          placeholder="REMOVE"
          className="w-full px-3.5 py-2.5 rounded-lg text-[13px] font-mono mb-3"
          style={{ background: P.input, border: `1px solid ${P.panelBorder}`, color: P.textPrimary }}
        />
        <div className="flex gap-2">
          <button onClick={onClose} className="flex-1 py-2.5 rounded-full text-[13px] font-medium" style={{ background: P.pillBg, color: P.textPrimary }}>Cancel</button>
          <button
            onClick={onConfirmReset}
            disabled={confirmText !== "REMOVE"}
            className="flex-1 py-2.5 rounded-full text-[13px] font-semibold"
            style={{ background: confirmText === "REMOVE" ? "#D92D20" : P.ctaDisabledBg, color: confirmText === "REMOVE" ? "#FFFFFF" : P.ctaDisabledText, cursor: confirmText === "REMOVE" ? "pointer" : "not-allowed" }}
          >
            Delete wallet
          </button>
        </div>
      </div>
    </div>
  );
}

// One quick-action circle — same visual language OKX/MetaMask/Trust all
// use for Send/Receive/History. Receive and Send are wired to something
// real; a disabled one stays honestly disabled rather than faked, never
// clickable-but-does-nothing.
function QuickAction({ icon: Icon, label, onClick, disabled, P }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex flex-col items-center gap-1.5"
      style={{ opacity: disabled ? 0.4 : 1, cursor: disabled ? "default" : "pointer" }}
    >
      <span className="w-11 h-11 rounded-full flex items-center justify-center" style={{ background: P.pillBg }}>
        <Icon size={17} color={P.textPrimary} />
      </span>
      <span className="text-[11px] font-medium" style={{ color: P.textSecondary }}>{label}</span>
    </button>
  );
}

function SendChainPicker({ value, onChange, chains, P }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    function onDoc(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);
  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen((o) => !o)} className="w-full flex items-center justify-between px-3.5 py-3 rounded-xl" style={{ background: P.input, border: `1px solid ${P.panelBorder}` }}>
        <span className="flex items-center gap-2">
          <WalletChainBadge id={value} size={20} />
          <span className="text-[13.5px] font-medium" style={{ color: P.textPrimary }}>{CHAIN_LABEL[value]}</span>
        </span>
        <ChevronDown size={14} color={P.textMuted} />
      </button>
      {open && (
        <div className="absolute left-0 right-0 z-30 mt-2 rounded-xl overflow-hidden shadow-2xl" style={{ background: P.panel, border: `1px solid ${P.panelBorder}`, maxHeight: "min(50vh, 320px)", overflowY: "auto" }}>
          {chains.map((key) => (
            <button key={key} onClick={() => { onChange(key); setOpen(false); }} className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-left">
              <WalletChainBadge id={key} size={18} />
              <span className="text-[13px]" style={{ color: P.textPrimary }}>{CHAIN_LABEL[key]}</span>
              {key === value && <Check size={13} color={LIME} className="ml-auto" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function SendAssetPicker({ chainKey, value, onChange, P }) {
  const tokens = chainKey === "solana" ? SPL_TOKENS : tokensForWalletChain(chainKey);
  if (tokens.length === 0) return null; // nothing to pick between — this chain has no verified token, native is the only option
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <button
        onClick={() => onChange("native")}
        className="px-2.5 py-1 rounded-full text-[11.5px] font-medium"
        style={{ background: value === "native" ? P.ctaBg : P.pillBg, color: value === "native" ? P.ctaText : P.textSecondary }}
      >
        {NATIVE_SYMBOL_BY_CHAIN[chainKey]}
      </button>
      {tokens.map((t) => (
        <button
          key={t.symbol}
          onClick={() => onChange(t.symbol)}
          className="px-2.5 py-1 rounded-full text-[11.5px] font-medium"
          style={{ background: value === t.symbol ? P.ctaBg : P.pillBg, color: value === t.symbol ? P.ctaText : P.textSecondary }}
        >
          {t.symbol}
        </button>
      ))}
    </div>
  );
}

function SendScreen({ session, onBack, P }) {
  // An imported single-chain account only offers that one chain — an HD
  // account (both evm + solana) offers everything, same as before.
  const availableChains = WALLET_CHAIN_ORDER.filter((key) => (key === "solana" ? !!session.solana : !!session.evm));
  const [chainKey, setChainKey] = useState(availableChains[0]);
  const [assetSymbol, setAssetSymbol] = useState("native");
  const [toAddress, setToAddress] = useState("");
  const [amount, setAmount] = useState("");
  const [phase, setPhase] = useState("form"); // form | confirm | sending | done | error
  const [feeEstimate, setFeeEstimate] = useState(null);
  const [feeError, setFeeError] = useState("");
  const [result, setResult] = useState(null);
  const [errorMessage, setErrorMessage] = useState("");

  const isSolana = chainKey === "solana";
  const selectedToken = assetSymbol === "native"
    ? null
    : (isSolana ? SPL_TOKENS : tokensForWalletChain(chainKey)).find((t) => t.symbol === assetSymbol);
  const assetLabel = selectedToken ? selectedToken.symbol : NATIVE_SYMBOL_BY_CHAIN[chainKey];
  const addressValid = isValidChainAddress(chainKey, toAddress);
  const amountValid = Number(amount) > 0;

  function handleChainChange(nextChainKey) {
    setChainKey(nextChainKey);
    setAssetSymbol("native"); // a token picked for the previous chain almost certainly doesn't exist on the new one
  }

  async function handleContinue() {
    setFeeError("");
    setFeeEstimate(null);
    setPhase("confirm");
    try {
      const fee = isSolana
        ? (selectedToken ? await estimateSplSendFee({ mintAddress: selectedToken.mint, toAddress: toAddress.trim() }) : estimateSolanaSendFee())
        : selectedToken
          ? await estimateEvmTokenSendFee({
              chainKey, tokenAddress: selectedToken.address, fromAddress: session.evm.address,
              toAddress: toAddress.trim(), amountRaw: parseUnits(String(amount), selectedToken.decimals),
            })
          : await estimateEvmSendFee(chainKey);
      setFeeEstimate(fee);
    } catch (err) {
      setFeeError(err?.message || "Couldn't estimate the network fee — check your connection and try again.");
    }
  }

  async function handleConfirmSend() {
    setPhase("sending");
    setErrorMessage("");
    try {
      const sendResult = isSolana
        ? (selectedToken
            ? await sendSplToken({
                secretKeyBase58: session.solana.privateKey, mintAddress: selectedToken.mint,
                mintDecimals: selectedToken.decimals, toAddress: toAddress.trim(), amountToken: Number(amount),
              })
            : await sendSolanaNative({ secretKeyBase58: session.solana.privateKey, toAddress: toAddress.trim(), amountSol: Number(amount) }))
        : selectedToken
          ? await sendEvmToken({
              chainKey, privateKeyHex: session.evm.privateKey, tokenAddress: selectedToken.address,
              tokenDecimals: selectedToken.decimals, toAddress: toAddress.trim(), amountToken: amount,
            })
          : await sendEvmNative({ chainKey, privateKeyHex: session.evm.privateKey, toAddress: toAddress.trim(), amountEth: amount });
      setResult(sendResult);
      setPhase("done");
    } catch (err) {
      setErrorMessage(err?.message || "The transaction failed to send.");
      setPhase("error");
    }
  }

  const explorerUrl = (() => {
    if (!result) return null;
    if (isSolana) return `${SOLANA_EXPLORER_TX_URL}${result.signature}`;
    try {
      const chain = getWalletChain(chainKey);
      const base = chain.blockExplorers?.default?.url;
      return base ? `${base}/tx/${result.hash}` : null;
    } catch {
      return null;
    }
  })();

  if (phase === "done") {
    return (
      <ScreenShell title="Sent" onBack={onBack} P={P}>
        <div className="flex flex-col items-center text-center gap-2 py-4">
          <span className="w-11 h-11 rounded-full flex items-center justify-center" style={{ background: `${LIME}1A` }}>
            <Check size={19} color={LIME_DEEP} />
          </span>
          <div className="text-[13.5px]" style={{ color: P.textPrimary }}>{amount} {assetLabel} sent</div>
          {explorerUrl && (
            <a href={explorerUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-[12px] mt-1" style={{ color: P.textSecondary }}>
              View on explorer <ExternalLink size={12} />
            </a>
          )}
        </div>
        <PrimaryButton onClick={onBack} P={P}>Done</PrimaryButton>
      </ScreenShell>
    );
  }

  if (phase === "error") {
    return (
      <ScreenShell title="Send failed" onBack={onBack} P={P}>
        <div className="text-[12.5px] mb-4" style={{ color: "#D92D20" }}>{errorMessage}</div>
        <PrimaryButton onClick={() => setPhase("confirm")} P={P}>Try again</PrimaryButton>
      </ScreenShell>
    );
  }

  if (phase === "confirm" || phase === "sending") {
    return (
      <ScreenShell title="Review send" onBack={() => setPhase("form")} P={P}>
        <div className="flex flex-col gap-2.5 mb-4">
          <div className="flex items-center justify-between px-3 py-2.5 rounded-lg" style={{ background: P.input }}>
            <span className="text-[11.5px]" style={{ color: P.textMuted }}>Amount</span>
            <span className="text-[13px] font-mono" style={{ color: P.textPrimary }}>{amount} {assetLabel}</span>
          </div>
          <div className="flex items-center justify-between px-3 py-2.5 rounded-lg" style={{ background: P.input }}>
            <span className="text-[11.5px]" style={{ color: P.textMuted }}>To</span>
            <span className="text-[12px] font-mono" style={{ color: P.textPrimary }}>{toAddress.slice(0, 8)}…{toAddress.slice(-6)}</span>
          </div>
          <div className="flex items-center justify-between px-3 py-2.5 rounded-lg" style={{ background: P.input }}>
            <span className="text-[11.5px]" style={{ color: P.textMuted }}>Network fee</span>
            <span className="text-[12px] font-mono" style={{ color: P.textPrimary }}>
              {feeError ? "—" : feeEstimate ? `${fmt(isSolana ? feeEstimate.feeSol : feeEstimate.feeNative, 6)} ${NATIVE_SYMBOL_BY_CHAIN[chainKey]}` : "Estimating…"}
            </span>
          </div>
        </div>
        {feeError && <div className="text-[11.5px] mb-3" style={{ color: "#D92D20" }}>{feeError}</div>}
        <PrimaryButton onClick={handleConfirmSend} disabled={!feeEstimate || phase === "sending"} P={P}>
          {phase === "sending" ? "Sending…" : "Confirm and send"}
        </PrimaryButton>
      </ScreenShell>
    );
  }

  return (
    <ScreenShell title="Send" onBack={onBack} P={P}>
      <div className="flex flex-col gap-3 mb-4">
        <SendChainPicker value={chainKey} onChange={handleChainChange} chains={availableChains} P={P} />
        <SendAssetPicker chainKey={chainKey} value={assetSymbol} onChange={setAssetSymbol} P={P} />
        <input
          value={toAddress}
          onChange={(e) => setToAddress(e.target.value)}
          placeholder={`Recipient's ${CHAIN_LABEL[chainKey]} address`}
          className="w-full px-3.5 py-3 rounded-xl text-[13px] font-mono"
          style={{ background: P.input, border: `1px solid ${toAddress && !addressValid ? "#D92D20" : P.panelBorder}`, color: P.textPrimary }}
        />
        {toAddress && !addressValid && <div className="text-[11px]" style={{ color: "#D92D20" }}>Invalid {CHAIN_LABEL[chainKey]} address</div>}
        <div className="flex items-center justify-between rounded-xl px-3.5 py-3" style={{ background: P.input, border: `1px solid ${P.panelBorder}` }}>
          <input
            type="number" min="0" step="any"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0"
            className="font-display bg-transparent text-[20px] font-semibold w-full"
            style={{ color: P.textPrimary }}
          />
          <span className="text-[12.5px] font-medium shrink-0" style={{ color: P.textMuted }}>{assetLabel}</span>
        </div>
      </div>
      <PrimaryButton onClick={handleContinue} disabled={!addressValid || !amountValid} P={P}>Continue</PrimaryButton>
    </ScreenShell>
  );
}

// "{Wallet} / Account N ▾" — matches the real OKX Wallet pattern this
// was built against: tapping it lists every wallet (each its own seed
// phrase), every HD-derived account nested under its wallet (checkmark on
// the active one), an "Add account" row per wallet, and — at the bottom —
// "New wallet" / "Import wallet" for adding a whole separate seed-phrase
// identity, distinct from "Add account" under an existing one.
function keysEqual(a, b) {
  return a.type === b.type && (a.type === "hd" ? a.walletId === b.walletId && a.index === b.index : a.id === b.id);
}

function hdAccountLabel(accountLabels, index) {
  return accountLabels[index] || `Account ${index + 1}`;
}

function RenameModal({ initialLabel, onSave, onClose, P }) {
  const [label, setLabel] = useState(initialLabel);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(4,5,7,0.6)", backdropFilter: "blur(4px)" }}>
      <div className="w-full max-w-sm rounded-2xl p-5" style={{ background: P.bg, border: `1px solid ${P.panelBorder}` }}>
        <div className="flex items-center justify-between mb-3">
          <span className="font-display text-[15px] font-semibold" style={{ color: P.textPrimary }}>Rename</span>
          <button onClick={onClose} style={{ color: P.textMuted }}>✕</button>
        </div>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          maxLength={40}
          autoFocus
          className="w-full px-3.5 py-3 rounded-xl text-[13px] mb-3"
          style={{ background: P.input, border: `1px solid ${P.panelBorder}`, color: P.textPrimary }}
        />
        <PrimaryButton onClick={() => { if (label.trim()) { onSave(label.trim()); onClose(); } }} disabled={!label.trim()} P={P}>Save</PrimaryButton>
      </div>
    </div>
  );
}

function AccountSwitcher({
  wallets, importedKeys, activeKey, onSwitch, onAddAccountFor, onAddWalletNew, onAddWalletImport, onImportKey, onRenameAccount, onRenameWallet, P,
}) {
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(null); // { currentLabel, onSave } | null
  const ref = useRef(null);
  useEffect(() => {
    function onDoc(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const activeWallet = activeKey.type === "hd" ? wallets.find((w) => w.id === activeKey.walletId) : null;
  const activeImported = activeKey.type === "imported" ? importedKeys.find((k) => k.id === activeKey.id) : null;
  const activeLabel = activeWallet
    ? (wallets.length > 1 ? `${activeWallet.label} / ${hdAccountLabel(activeWallet.accountLabels, activeKey.index)}` : hdAccountLabel(activeWallet.accountLabels, activeKey.index))
    : (activeImported?.label ?? "Imported");

  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-1.5 text-[12.5px] font-medium" style={{ color: P.textPrimary }}>
        {activeLabel}
        <ChevronDown size={13} color={P.textMuted} />
      </button>
      {open && (
        <div className="absolute left-0 z-30 mt-2 w-72 rounded-xl overflow-hidden shadow-2xl py-1" style={{ background: P.panel, border: `1px solid ${P.panelBorder}`, maxHeight: "min(70vh, 420px)", overflowY: "auto" }}>
          {wallets.map((wallet) => (
            <div key={wallet.id}>
              <div className="flex items-center gap-2 px-3.5 pt-2.5 pb-1" style={{ borderTop: `1px solid ${P.divider}` }}>
                <span className="text-[10px] font-semibold uppercase tracking-wide flex-1 truncate" style={{ color: P.textMuted }}>{wallet.label}</span>
                <button
                  onClick={() => setRenaming({ currentLabel: wallet.label, onSave: (newLabel) => onRenameWallet(wallet.id, newLabel) })}
                  className="shrink-0" style={{ color: P.textMuted }}
                >
                  <Pencil size={11} />
                </button>
              </div>
              {wallet.accounts.map((acc, i) => {
                const key = { type: "hd", walletId: wallet.id, index: i };
                const label = hdAccountLabel(wallet.accountLabels, i);
                return (
                  <div key={`${wallet.id}-${i}`} className="w-full flex items-center gap-2 px-3.5 py-2.5">
                    <button onClick={() => { onSwitch(key); setOpen(false); }} className="flex-1 flex items-center justify-between gap-2 text-left">
                      <div className="flex flex-col">
                        <span className="text-[13px] font-medium" style={{ color: P.textPrimary }}>{label}</span>
                        <span className="text-[10.5px] font-mono" style={{ color: P.textMuted }}>{acc.evm.address.slice(0, 6)}…{acc.evm.address.slice(-4)}</span>
                      </div>
                      {keysEqual(key, activeKey) && <Check size={14} color={LIME} />}
                    </button>
                    <button onClick={() => setRenaming({ currentLabel: label, onSave: (newLabel) => onRenameAccount(key, newLabel) })} className="shrink-0" style={{ color: P.textMuted }}>
                      <Pencil size={13} />
                    </button>
                  </div>
                );
              })}
              <button
                onClick={() => { onAddAccountFor(wallet.id); setOpen(false); }}
                className="w-full flex items-center gap-2 pl-5 pr-3.5 py-2 text-left"
                style={{ color: P.textSecondary }}
              >
                <Plus size={13} color={P.textMuted} /> <span className="text-[12.5px]">Add account</span>
              </button>
            </div>
          ))}
          {importedKeys.length > 0 && (
            <div className="text-[10px] font-semibold uppercase tracking-wide px-3.5 pt-2.5 pb-1" style={{ color: P.textMuted, borderTop: `1px solid ${P.divider}` }}>Imported</div>
          )}
          {importedKeys.map((k) => {
            const key = { type: "imported", id: k.id };
            return (
              <div key={k.id} className="w-full flex items-center gap-2 px-3.5 py-2.5">
                <button onClick={() => { onSwitch(key); setOpen(false); }} className="flex-1 flex items-center justify-between gap-2 text-left">
                  <div className="flex flex-col">
                    <span className="text-[13px] font-medium" style={{ color: P.textPrimary }}>{k.label}</span>
                    <span className="text-[10.5px] font-mono" style={{ color: P.textMuted }}>{k.address.slice(0, 6)}…{k.address.slice(-4)}</span>
                  </div>
                  {keysEqual(key, activeKey) && <Check size={14} color={LIME} />}
                </button>
                <button onClick={() => setRenaming({ currentLabel: k.label, onSave: (newLabel) => onRenameAccount(key, newLabel) })} className="shrink-0" style={{ color: P.textMuted }}>
                  <Pencil size={13} />
                </button>
              </div>
            );
          })}
          <div style={{ borderTop: `1px solid ${P.divider}` }}>
            <button onClick={() => { onAddWalletNew(); setOpen(false); }} className="w-full flex items-center gap-2 px-3.5 py-2.5 text-left" style={{ color: P.textPrimary }}>
              <Plus size={14} color={P.textMuted} /> New wallet
            </button>
            <button onClick={() => { onAddWalletImport(); setOpen(false); }} className="w-full flex items-center gap-2 px-3.5 py-2.5 text-left" style={{ color: P.textPrimary }}>
              <Download size={14} color={P.textMuted} /> Import wallet
            </button>
            <button onClick={() => { onImportKey(); setOpen(false); }} className="w-full flex items-center gap-2 px-3.5 py-2.5 text-left" style={{ color: P.textPrimary }}>
              <Download size={14} color={P.textMuted} /> Import private key
            </button>
          </div>
        </div>
      )}
      {renaming && (
        <RenameModal
          initialLabel={renaming.currentLabel}
          onSave={renaming.onSave}
          onClose={() => setRenaming(null)}
          P={P}
        />
      )}
    </div>
  );
}

function AddAccountModal({ onClose, onAdd, P }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleSubmit() {
    setBusy(true);
    setError("");
    try {
      await onAdd(password);
      onClose();
    } catch {
      setError("Incorrect password.");
    }
    setBusy(false);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(4,5,7,0.6)", backdropFilter: "blur(4px)" }}>
      <div className="w-full max-w-sm rounded-2xl p-5" style={{ background: P.bg, border: `1px solid ${P.panelBorder}` }}>
        <div className="flex items-center justify-between mb-3">
          <span className="font-display text-[15px] font-semibold" style={{ color: P.textPrimary }}>Add account</span>
          <button onClick={onClose} style={{ color: P.textMuted }}>✕</button>
        </div>
        <div className="text-[12px] mb-3" style={{ color: P.textMuted }}>
          Derives the next account from your existing recovery phrase — the same phrase, a new account. Re-enter your password to confirm.
        </div>
        <PasswordField value={password} onChange={setPassword} placeholder="Password" P={P} autoFocus />
        {error && <div className="text-[11.5px] mt-2" style={{ color: "#D92D20" }}>{error}</div>}
        <div className="mt-3">
          <PrimaryButton onClick={handleSubmit} disabled={!password || busy} P={P}>{busy ? "Adding…" : "Add account"}</PrimaryButton>
        </div>
      </div>
    </div>
  );
}

function WalletDashboard({
  session, wallets, importedKeys, activeKey, onSwitchAccount, onAddAccount, onAddWalletNew, onAddWalletImport,
  onImportKey, onRenameAccount, onRenameWallet, onLock, onReset, onSend, P,
}) {
  const [showReveal, setShowReveal] = useState(false);
  const [showRevealKey, setShowRevealKey] = useState(false);
  const [showReset, setShowReset] = useState(false);
  const [addAccountFor, setAddAccountFor] = useState(null); // walletId | null
  const [showImportKey, setShowImportKey] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [justCopied, setJustCopied] = useState(false);

  const isImportedAccount = activeKey.type === "imported";

  function handleReceive() {
    navigator.clipboard.writeText(session.evm ? session.evm.address : session.solana.address);
    setJustCopied(true);
    setTimeout(() => setJustCopied(false), 1500);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-2xl p-4" style={{ background: P.panel, border: `1px solid ${P.panelBorder}` }}>
        <div className="flex items-center justify-between mb-4">
          <AccountSwitcher
            wallets={wallets} importedKeys={importedKeys} activeKey={activeKey}
            onSwitch={onSwitchAccount} onAddAccountFor={(walletId) => setAddAccountFor(walletId)}
            onAddWalletNew={onAddWalletNew} onAddWalletImport={onAddWalletImport}
            onImportKey={() => setShowImportKey(true)}
            onRenameAccount={onRenameAccount} onRenameWallet={onRenameWallet}
            P={P}
          />
          <button onClick={onLock} className="flex items-center gap-1 text-[11.5px] font-medium" style={{ color: P.textMuted }}>
            <Lock size={11} /> Lock
          </button>
        </div>
        <div className="flex items-center justify-around mb-4">
          <QuickAction icon={SendIcon} label="Send" onClick={onSend} P={P} />
          <QuickAction icon={justCopied ? Check : Download} label={justCopied ? "Copied" : "Receive"} onClick={handleReceive} P={P} />
          <QuickAction icon={RefreshCw} label="Refresh" onClick={() => setRefreshKey((k) => k + 1)} P={P} />
        </div>
        <div className="flex flex-col gap-2">
          {session.evm && (
            <div className="flex items-center justify-between px-3 py-2 rounded-lg" style={{ background: P.input }}>
              <span className="text-[11.5px]" style={{ color: P.textMuted }}>EVM (all chains)</span>
              <CopyableAddress address={session.evm.address} P={P} />
            </div>
          )}
          {session.solana && (
            <div className="flex items-center justify-between px-3 py-2 rounded-lg" style={{ background: P.input }}>
              <span className="text-[11.5px]" style={{ color: P.textMuted }}>Solana</span>
              <CopyableAddress address={session.solana.address} P={P} />
            </div>
          )}
        </div>
      </div>

      <div className="rounded-2xl overflow-hidden" style={{ background: P.panel, border: `1px solid ${P.panelBorder}` }}>
        <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: `1px solid ${P.divider}` }}>
          <span className="text-[12.5px] font-medium" style={{ color: P.textSecondary }}>Balances</span>
          <button onClick={() => setRefreshKey((k) => k + 1)} style={{ color: P.textMuted }}>
            <RefreshCw size={13} />
          </button>
        </div>
        {WALLET_CHAIN_ORDER.filter((key) => (key === "solana" ? !!session.solana : !!session.evm)).map((key, i) =>
          key === "solana" ? (
            <React.Fragment key={`${key}-${refreshKey}`}>
              <SolanaBalanceRow solanaAddress={session.solana.address} P={P} forceFresh={refreshKey > 0} />
              {SPL_TOKENS.map((token) => (
                <SplTokenBalanceRow key={token.symbol} token={token} solanaAddress={session.solana.address} P={P} forceFresh={refreshKey > 0} />
              ))}
            </React.Fragment>
          ) : (
            <React.Fragment key={`${key}-${refreshKey}`}>
              <EvmBalanceRow chainKey={key} evmAddress={session.evm.address} P={P} isFirst={i === 0} forceFresh={refreshKey > 0} />
              {tokensForWalletChain(key).map((token) => (
                <TokenBalanceRow key={token.symbol} chainKey={key} token={token} evmAddress={session.evm.address} P={P} forceFresh={refreshKey > 0} />
              ))}
            </React.Fragment>
          )
        )}
      </div>

      <div className="rounded-2xl p-1 overflow-hidden" style={{ background: P.panel, border: `1px solid ${P.panelBorder}` }}>
        {!isImportedAccount && (
          <button onClick={() => setShowReveal(true)} className="w-full flex items-center gap-2.5 px-3.5 py-3 rounded-xl text-[13px] font-medium" style={{ color: P.textPrimary }}>
            <Eye size={15} color={P.textMuted} /> Reveal recovery phrase
          </button>
        )}
        <button onClick={() => setShowRevealKey(true)} className="w-full flex items-center gap-2.5 px-3.5 py-3 rounded-xl text-[13px] font-medium" style={{ color: P.textPrimary }}>
          <Eye size={15} color={P.textMuted} /> Export private key
        </button>
        <button onClick={() => setShowReset(true)} className="w-full flex items-center gap-2.5 px-3.5 py-3 rounded-xl text-[13px] font-medium" style={{ color: "#D92D20" }}>
          <Trash2 size={15} color="#D92D20" /> Remove wallet from this browser
        </button>
      </div>

      {showReveal && <RevealPhraseModal walletId={activeKey.walletId} onClose={() => setShowReveal(false)} P={P} />}
      {showRevealKey && <RevealPrivateKeyModal session={session} activeKey={activeKey} onClose={() => setShowRevealKey(false)} P={P} />}
      {showReset && (
        <ResetWalletModal
          onClose={() => setShowReset(false)}
          onConfirmReset={() => { clearVault(); onReset(); }}
          P={P}
        />
      )}
      {addAccountFor && (
        <AddAccountModal onClose={() => setAddAccountFor(null)} onAdd={(password) => onAddAccount(addAccountFor, password)} P={P} />
      )}
      {showImportKey && <ImportKeyModal onClose={() => setShowImportKey(false)} onImport={onImportKey} P={P} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Top-level state machine
// ---------------------------------------------------------------------------

function genId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function MangoWalletInner({ P }) {
  const [screen, setScreen] = useState(() => (loadVault() ? "locked" : "welcome"));
  const [pendingMnemonic, setPendingMnemonic] = useState(null); // in-memory only, during onboarding
  const [pendingImportPhrase, setPendingImportPhrase] = useState(null);
  const [pendingNewWalletMnemonic, setPendingNewWalletMnemonic] = useState(null); // in-memory only, during "add wallet"
  // Array of { id, label, accounts: [{ evm, solana }], accountLabels }
  // — one entry per independent seed-phrase WALLET (OKX's "Add wallet"),
  // each with its own unlimited HD-derived accounts (OKX's "Add
  // account", nested one level down). In-memory only while unlocked.
  // Deliberately does NOT include any mnemonic itself: each is only
  // needed transiently, to derive an account — at unlock, or when adding
  // a new account/wallet — rather than kept sitting in long-lived React
  // state (inspectable via React DevTools) for the entire session.
  const [wallets, setWallets] = useState([]);
  // Standalone imported keys — NOT derived from any mnemonic, each tied
  // to exactly one chain (see walletKeyImport.js's module doc for why),
  // and — matching OKX's own flat treatment — not nested under any
  // wallet. { id, chain, address, label, privateKey } — privateKey
  // in-memory only while unlocked, same as every other private key here.
  const [importedKeys, setImportedKeys] = useState([]);
  // Which account is active — an HD {walletId, index} pair, or a
  // specific imported key's id.
  const [activeKey, setActiveKey] = useState({ type: "hd", walletId: null, index: 0 });

  async function finalizeWallet(mnemonic, password) {
    const account0 = deriveAccountAtIndex(mnemonic, 0);
    const mnemonicRecord = await encryptSecret(mnemonic, password);
    const id = genId("wallet");
    saveVault({
      wallets: [{ id, label: "Wallet 1", mnemonicRecord, accountCount: 1, accountLabels: {} }],
      importedKeys: [],
    });
    setWallets([{ id, label: "Wallet 1", accounts: [account0], accountLabels: {} }]);
    setImportedKeys([]);
    setActiveKey({ type: "hd", walletId: id, index: 0 });
    setPendingMnemonic(null);
    setPendingImportPhrase(null);
    setScreen("dashboard");
  }

  async function handleUnlock(password) {
    const vault = loadVault();
    try {
      const decryptedWallets = [];
      for (const w of vault.wallets) {
        const mnemonic = await decryptSecret(w.mnemonicRecord, password);
        const accounts = [];
        for (let i = 0; i < w.accountCount; i++) accounts.push(deriveAccountAtIndex(mnemonic, i));
        decryptedWallets.push({ id: w.id, label: w.label, accounts, accountLabels: w.accountLabels ?? {} });
      }
      const decryptedImports = await Promise.all(
        (vault.importedKeys ?? []).map(async (entry) => ({
          id: entry.id, chain: entry.chain, address: entry.address, label: entry.label,
          privateKey: await decryptSecret(entry.record, password),
        }))
      );
      setWallets(decryptedWallets);
      setImportedKeys(decryptedImports);
      setActiveKey({ type: "hd", walletId: decryptedWallets[0].id, index: 0 });
      setScreen("dashboard");
      return true;
    } catch {
      return false;
    }
  }

  /** Derives the next HD account under one specific wallet. Needs the password again since no mnemonic is kept in memory between unlock and this — see the wallets state comment above. */
  async function handleAddAccount(walletId, password) {
    const vault = loadVault();
    const walletEntry = vault.wallets.find((w) => w.id === walletId);
    const mnemonic = await decryptSecret(walletEntry.mnemonicRecord, password); // throws on wrong password — caller (AddAccountModal) handles that
    const wallet = wallets.find((w) => w.id === walletId);
    const nextIndex = wallet.accounts.length;
    const newAccount = deriveAccountAtIndex(mnemonic, nextIndex);
    const nextVaultWallets = vault.wallets.map((w) => (w.id === walletId ? { ...w, accountCount: nextIndex + 1 } : w));
    saveVault({ wallets: nextVaultWallets, importedKeys: vault.importedKeys ?? [] });
    setWallets((prev) => prev.map((w) => (w.id === walletId ? { ...w, accounts: [...w.accounts, newAccount] } : w)));
    setActiveKey({ type: "hd", walletId, index: nextIndex });
  }

  /** Adds a whole new seed-phrase wallet — a different seed entirely, new or imported (caller decides which), encrypted under the vault's EXISTING password. Returns false on a wrong password rather than throwing, so VerifyPasswordStep can show an inline error the same way LockedScreen's onUnlock does. */
  async function handleAddWallet(mnemonic, password) {
    const vault = loadVault();
    try {
      await decryptSecret(vault.wallets[0].mnemonicRecord, password); // proves this is really the vault's password before anything gets encrypted with it
    } catch {
      return false;
    }
    const mnemonicRecord = await encryptSecret(mnemonic, password);
    const id = genId("wallet");
    const label = `Wallet ${vault.wallets.length + 1}`;
    const nextVaultWallets = [...vault.wallets, { id, label, mnemonicRecord, accountCount: 1, accountLabels: {} }];
    saveVault({ wallets: nextVaultWallets, importedKeys: vault.importedKeys ?? [] });
    const account0 = deriveAccountAtIndex(mnemonic, 0);
    setWallets((prev) => [...prev, { id, label, accounts: [account0], accountLabels: {} }]);
    setActiveKey({ type: "hd", walletId: id, index: 0 });
    setPendingNewWalletMnemonic(null);
    setScreen("dashboard");
    return true;
  }

  /** Renames an HD account or an imported key. Purely cosmetic — no password needed, unlike anything that touches key material. */
  function handleRenameAccount(key, newLabel) {
    const vault = loadVault();
    if (key.type === "hd") {
      const nextVaultWallets = vault.wallets.map((w) =>
        w.id === key.walletId ? { ...w, accountLabels: { ...(w.accountLabels ?? {}), [key.index]: newLabel } } : w
      );
      saveVault({ ...vault, wallets: nextVaultWallets });
      setWallets((prev) => prev.map((w) => (w.id === key.walletId ? { ...w, accountLabels: { ...w.accountLabels, [key.index]: newLabel } } : w)));
    } else {
      const nextImportedKeys = (vault.importedKeys ?? []).map((entry) => (entry.id === key.id ? { ...entry, label: newLabel } : entry));
      saveVault({ ...vault, importedKeys: nextImportedKeys });
      setImportedKeys((prev) => prev.map((k) => (k.id === key.id ? { ...k, label: newLabel } : k)));
    }
  }

  /** Renames a whole wallet (the seed-phrase group itself, not one account under it). */
  function handleRenameWallet(walletId, newLabel) {
    const vault = loadVault();
    const nextVaultWallets = vault.wallets.map((w) => (w.id === walletId ? { ...w, label: newLabel } : w));
    saveVault({ ...vault, wallets: nextVaultWallets });
    setWallets((prev) => prev.map((w) => (w.id === walletId ? { ...w, label: newLabel } : w)));
  }

  /** Imports a standalone private key. Requires the vault's existing password (not a new one) — throws on a wrong password or an unparseable key; caller (ImportKeyModal) handles both. */
  async function handleImportPrivateKey(rawInput, password) {
    const vault = loadVault();
    await decryptSecret(vault.wallets[0].mnemonicRecord, password); // confirms this is really the wallet's password before we encrypt anything with it
    const parsed = parseImportedPrivateKey(rawInput);
    const record = await encryptSecret(parsed.privateKey, password);
    const id = genId("imported");
    const label = `Imported ${parsed.chain === "evm" ? "EVM" : "Solana"}`;
    const nextImportedKeys = [...(vault.importedKeys ?? []), { id, chain: parsed.chain, address: parsed.address, label, record }];
    saveVault({ ...vault, importedKeys: nextImportedKeys });
    setImportedKeys((prev) => [...prev, { id, chain: parsed.chain, address: parsed.address, label, privateKey: parsed.privateKey }]);
    setActiveKey({ type: "imported", id });
  }

  function handleLock() {
    setWallets([]); // discard in-memory keys — nothing else to "lock", they're gone
    setImportedKeys([]);
    setActiveKey({ type: "hd", walletId: null, index: 0 });
    setScreen("locked");
  }

  function handleReset() {
    setWallets([]);
    setImportedKeys([]);
    setActiveKey({ type: "hd", walletId: null, index: 0 });
    setPendingMnemonic(null);
    setPendingImportPhrase(null);
    setPendingNewWalletMnemonic(null);
    setScreen("welcome");
  }

  // The active account's { evm, solana } — an HD account always has both;
  // an imported key has exactly one and the other is null. Every consumer
  // of `session` below must treat a null evm/solana as "this chain isn't
  // available for the current account," not crash on it.
  const activeWallet = activeKey.type === "hd" ? (wallets.find((w) => w.id === activeKey.walletId) ?? null) : null;
  const activeHdAccount = activeWallet ? (activeWallet.accounts[activeKey.index] ?? null) : null;
  const activeImportedKey = activeKey.type === "imported" ? (importedKeys.find((k) => k.id === activeKey.id) ?? null) : null;
  const session = activeHdAccount
    ? { evm: activeHdAccount.evm, solana: activeHdAccount.solana }
    : activeImportedKey
      ? {
          evm: activeImportedKey.chain === "evm" ? { address: activeImportedKey.address, privateKey: activeImportedKey.privateKey } : null,
          solana: activeImportedKey.chain === "solana" ? { address: activeImportedKey.address, privateKey: activeImportedKey.privateKey } : null,
        }
      : null;

  if (screen === "welcome") {
    return (
      <WelcomeScreen
        P={P}
        onCreate={() => { setPendingMnemonic(generateMnemonic()); setScreen("create-reveal"); }}
        onImport={() => setScreen("import-phrase")}
      />
    );
  }
  if (screen === "create-reveal") {
    return <CreateRevealStep mnemonic={pendingMnemonic} onBack={() => setScreen("welcome")} onNext={() => setScreen("create-confirm")} P={P} />;
  }
  if (screen === "create-confirm") {
    return <CreateConfirmStep mnemonic={pendingMnemonic} onBack={() => setScreen("create-reveal")} onConfirmed={() => setScreen("create-password")} P={P} />;
  }
  if (screen === "create-password") {
    return (
      <SetPasswordStep
        title="Set a password"
        helpText="This password only encrypts your wallet on this device — it does not replace your recovery phrase, and Mango never sees it."
        onBack={() => setScreen("create-confirm")}
        onSet={(password) => finalizeWallet(pendingMnemonic, password)}
        P={P}
      />
    );
  }
  if (screen === "import-phrase") {
    return (
      <ImportPhraseStep
        onBack={() => setScreen("welcome")}
        onImported={(phrase) => { setPendingImportPhrase(phrase); setScreen("import-password"); }}
        P={P}
      />
    );
  }
  if (screen === "import-password") {
    return (
      <SetPasswordStep
        title="Set a password"
        helpText="This password only encrypts your wallet on this device — it does not replace your recovery phrase, and Mango never sees it."
        onBack={() => setScreen("import-phrase")}
        onSet={(password) => finalizeWallet(pendingImportPhrase, password)}
        P={P}
      />
    );
  }
  if (screen === "locked") {
    return <LockedScreen onUnlock={handleUnlock} P={P} />;
  }
  if (screen === "send") {
    return <SendScreen session={session} onBack={() => setScreen("dashboard")} P={P} />;
  }
  // "Add wallet" — a whole separate seed phrase, new or imported, distinct
  // from "Add account" (which just derives another account under an
  // existing wallet's seed). Reuses the same reveal/confirm onboarding
  // steps as the very first wallet; only the final step differs — instead
  // of setting a brand-new password, it verifies the vault's existing one.
  if (screen === "add-wallet-reveal") {
    return (
      <CreateRevealStep
        mnemonic={pendingNewWalletMnemonic}
        onBack={() => setScreen("dashboard")}
        onNext={() => setScreen("add-wallet-confirm")}
        P={P}
      />
    );
  }
  if (screen === "add-wallet-confirm") {
    return (
      <CreateConfirmStep
        mnemonic={pendingNewWalletMnemonic}
        onBack={() => setScreen("add-wallet-reveal")}
        onConfirmed={() => setScreen("add-wallet-verify-password")}
        P={P}
      />
    );
  }
  if (screen === "add-wallet-import-phrase") {
    return (
      <ImportPhraseStep
        onBack={() => setScreen("dashboard")}
        onImported={(phrase) => { setPendingNewWalletMnemonic(phrase); setScreen("add-wallet-verify-password"); }}
        P={P}
      />
    );
  }
  if (screen === "add-wallet-verify-password") {
    return (
      <VerifyPasswordStep
        title="Add wallet"
        helpText="One password unlocks every wallet in this browser — enter it to finish adding this one."
        buttonLabel="Add wallet"
        onBack={() => setScreen("dashboard")}
        onVerify={(password) => handleAddWallet(pendingNewWalletMnemonic, password)}
        P={P}
      />
    );
  }
  return (
    <WalletDashboard
      session={session}
      wallets={wallets}
      importedKeys={importedKeys}
      activeKey={activeKey}
      onSwitchAccount={setActiveKey}
      onAddAccount={handleAddAccount}
      onAddWalletNew={() => { setPendingNewWalletMnemonic(generateMnemonic()); setScreen("add-wallet-reveal"); }}
      onAddWalletImport={() => setScreen("add-wallet-import-phrase")}
      onImportKey={handleImportPrivateKey}
      onRenameAccount={handleRenameAccount}
      onRenameWallet={handleRenameWallet}
      onLock={handleLock}
      onReset={handleReset}
      onSend={() => setScreen("send")}
      P={P}
    />
  );
}

// ---------------------------------------------------------------------------
// Public gate
// ---------------------------------------------------------------------------

// Same pattern Launchpad.jsx uses for its Solana tab: the real, working
// implementation above stays fully built and testable, but the public site
// shows "Coming soon" until this flips to true — a deliberate choice given
// this generates and stores real private keys, and hasn't gone through a
// security review yet. Flip this one line when that's done; nothing else
// about the implementation needs to change.
export const WALLET_LIVE = false;

// Internal-only bypass for testing the real flow before launch — mirrors
// main.jsx's existing `?test=solana` convention. Not documented anywhere
// public; anyone who doesn't already know this exists sees "Coming soon",
// same as every other visitor.
function hasPreviewOverride() {
  try {
    return new URLSearchParams(window.location.search).get("wallet") === "preview";
  } catch {
    return false;
  }
}

function WalletComingSoon({ P }) {
  return (
    <div className="rounded-2xl p-8 flex flex-col items-center text-center gap-2" style={{ background: P.panel, border: `1px solid ${P.panelBorder}` }}>
      <Wallet size={22} color={P.textMuted} />
      <div className="text-[16px] font-semibold" style={{ color: P.textPrimary }}>Coming soon</div>
      <div className="text-[12px]" style={{ color: P.textMuted }}>
        A self-custodial wallet, built directly into Mango — your keys never leave your browser.
      </div>
    </div>
  );
}

export function MangoWalletTab({ P }) {
  if (!WALLET_LIVE && !hasPreviewOverride()) {
    return <WalletComingSoon P={P} />;
  }
  return <MangoWalletInner P={P} />;
}
