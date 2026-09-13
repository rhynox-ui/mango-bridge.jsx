// extension/src/popup.js
//
// The extension's popup — the ONLY place a password is ever typed or a
// private key is ever briefly held in memory. Every screen here is a
// plain DOM tree built with the h() helper below (never innerHTML with
// untrusted content — an origin string or a dApp-supplied message is
// exactly the kind of thing that must never be interpreted as HTML), and
// closes/discards its own state the moment the window closes.
//
// This extension's vault is its OWN, separate from the one the main site
// (mangoprotocol.site) keeps in that site's own localStorage — different
// origins can't share localStorage, by design of the web platform, the
// same way MetaMask's extension vault has never been the same storage as
// any website's local data. "I already have a recovery phrase" is how
// the same wallet ends up in both places, exactly like importing a
// MetaMask seed into a second device.
//
// Two rendering paths, chosen by whether a dApp is waiting:
//   - No pending request (the toolbar icon was clicked directly): mounts
//     the ACTUAL src/MangoWallet.jsx component the main site renders —
//     full multi-wallet/multi-account UI, balances, send, the works —
//     not a reimplementation. build.mjs redirects its walletRpc.js
//     import to ./rpc.js (a Vite-independent equivalent) so it runs
//     completely unmodified.
//   - A pending request: the lightweight, hand-rolled approve/reject flow
//     below — deliberately NOT the full app, since a request approval
//     needs a small, fast, unambiguous "approve or reject" surface, not
//     the whole wallet UI.

import React, { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { MangoWalletTab, loadAutoLockMinutes } from "../../src/MangoWallet.jsx";
import { PALETTE } from "../../src/theme.js";
import { generateMnemonic, isValidMnemonic, deriveAccountAtIndex, normalizeMnemonic } from "../../src/wallet/keys.js";
import { encryptSecret, decryptSecret, saveVault, loadVault, clearVault, deriveFullVaultSession } from "../../src/wallet/vault.js";
import {
  signAndSendEvmTx, signEvmPersonalMessage, signEvmTypedData,
  signSolanaTransaction, signAndSendSolanaTransaction, signSolanaMessage,
} from "./signing.js";
import { viemChainForId, DEFAULT_EVM_CHAIN_ID } from "./chains.js";
import { MAINNET_CHAIN_IDS } from "../../src/chainData.js";
import { WALLET_ONLY_EVM_CHAINS } from "../../src/wallet/walletChains.js";
import { addCustomToken } from "../../src/wallet/customTokens.js";
import { isHex, hexToBytes, hexToString } from "viem";

// ---------------------------------------------------------------------
// Shared unlocked-session cache — chrome.storage.session (in-memory only,
// per-browser-session: cleared on browser close or the extension being
// disabled, NEVER written to disk). This is what lets "stop asking for
// the password constantly" and "auto-lock after real inactivity" both be
// true at once: without it, MangoWalletInner's own React state (this
// popup's normal source of truth once unlocked) is destroyed the instant
// the popup closes, and the separate dApp-approval popup below has never
// shared any state with it at all — meaning literally every popup open
// AND every dApp connect/sign request asked for the password again,
// regardless of how recently the wallet was actually used. Shared by both
// renderFullWalletApp() (the real dashboard) and the approval flow in
// main() below, so unlocking in either place benefits the other.
const SESSION_STORAGE_KEY = "mango_wallet_session";
const ACTIVITY_TOUCH_MIN_INTERVAL_MS = 30_000; // throttles onActivity's writes — see MangoWalletInner's own comment on why it fires on every idle-timer reset

function hasSessionStorage() {
  return typeof chrome !== "undefined" && chrome.storage && chrome.storage.session;
}

/** Returns the cached session if one exists AND is still within the current auto-lock window — null otherwise (including "none cached" and "expired"). Never throws. */
async function loadSessionCache() {
  if (!hasSessionStorage()) return null;
  try {
    const stored = await chrome.storage.session.get(SESSION_STORAGE_KEY);
    const cached = stored[SESSION_STORAGE_KEY];
    if (!cached) return null;
    const autoLockMinutes = loadAutoLockMinutes();
    if (autoLockMinutes !== 0 && Date.now() - cached.lastActivityAt > autoLockMinutes * 60 * 1000) return null; // expired
    return cached;
  } catch {
    return null;
  }
}

function saveSessionCache(session) {
  if (!hasSessionStorage()) return;
  chrome.storage.session.set({ [SESSION_STORAGE_KEY]: { ...session, lastActivityAt: Date.now() } }).catch(() => {});
}

let lastActivityTouchAt = 0;
/** Refreshes just the cached session's activity timestamp, throttled — called on every idle-timer reset while the dashboard is open, so it can't be a per-mousemove storage write. */
function touchSessionActivity() {
  if (!hasSessionStorage()) return;
  const now = Date.now();
  if (now - lastActivityTouchAt < ACTIVITY_TOUCH_MIN_INTERVAL_MS) return;
  lastActivityTouchAt = now;
  chrome.storage.session.get(SESSION_STORAGE_KEY).then((stored) => {
    const cached = stored[SESSION_STORAGE_KEY];
    if (!cached) return;
    return chrome.storage.session.set({ [SESSION_STORAGE_KEY]: { ...cached, lastActivityAt: now } });
  }).catch(() => {});
}

function clearSessionCache() {
  if (!hasSessionStorage()) return;
  chrome.storage.session.remove(SESSION_STORAGE_KEY).catch(() => {});
}

/** Extracts the {evm, solana} shape the approval flow needs for the currently-active key out of a cached session — mirrors MangoWalletInner's own identical computation (src/MangoWallet.jsx's `session` value) so both stay consistent. */
function resolveActiveAccountFromSession(cached) {
  const { wallets, importedKeys, activeKey } = cached;
  if (activeKey.type === "hd") {
    const wallet = wallets.find((w) => w.id === activeKey.walletId);
    return wallet?.accounts?.[activeKey.index] ?? null;
  }
  const imported = importedKeys.find((k) => k.id === activeKey.id);
  if (!imported) return null;
  return {
    evm: imported.chain === "evm" ? { address: imported.address, privateKey: imported.privateKey } : null,
    solana: imported.chain === "solana" ? { address: imported.address, privateKey: imported.privateKey } : null,
  };
}

// Numeric EVM chainId -> this app's own chainKey string (e.g. 8453 ->
// "base"), built from the same two chain-key registries MangoWalletTab's
// own Balances panel uses (chainData.js for the Bridge-shared chains,
// walletChains.js for the wallet-only additions) — so wallet_watchAsset
// below can file a token under the exact same key the dashboard already
// reads with allTokensForChain(), not a second, invented mapping.
const CHAIN_ID_TO_KEY = {};
for (const [key, id] of Object.entries(MAINNET_CHAIN_IDS)) CHAIN_ID_TO_KEY[id] = key;
for (const [key, chain] of Object.entries(WALLET_ONLY_EVM_CHAINS)) CHAIN_ID_TO_KEY[chain.id] = key;

const root = document.getElementById("root");

// The extension keeps its own light/dark preference — a real, separate
// setting from the site's own "mango:theme" localStorage key, since a
// different browser origin can't read that key at all (same reason this
// extension's wallet vault is its own — see this file's module doc).
// Defaults to dark, matching this popup's own dark-first chrome; the
// site defaults to light instead — two independent, equally real
// defaults, not one "forgetting" the other.
const THEME_STORAGE_KEY = "mango_wallet_theme";
function loadTheme() {
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}
function saveTheme(theme) {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // storage unavailable — theme just won't persist across popup opens, nothing else breaks
  }
}

// popup.html's plain-DOM "legacy" screens (onboarding reached via a
// pending dApp request, and the approve/reject request UI itself — see
// renderApproval below) can't read React props, so they read these CSS
// custom properties instead. Setting them here, from the SAME PALETTE
// object the real MangoWalletTab UI uses, keeps both surfaces on one real
// source of truth instead of a second, hand-duplicated set of hex values
// baked into the stylesheet. Called synchronously before main() renders
// anything, using the user's actual saved theme — previously popup.html
// hardcoded these to the dark palette permanently, so a dApp's Connect
// popup stayed dark even for someone who'd picked Light in Settings.
function applyLegacyThemeVars(theme) {
  const P = PALETTE[theme];
  const root = document.documentElement.style;
  root.setProperty("--mango-bg", P.bg);
  root.setProperty("--mango-panel", P.panel);
  root.setProperty("--mango-panelBorder", P.panelBorder);
  root.setProperty("--mango-input", P.input);
  root.setProperty("--mango-textPrimary", P.textPrimary);
  root.setProperty("--mango-textSecondary", P.textSecondary);
  root.setProperty("--mango-textMuted", P.textMuted);
  root.setProperty("--mango-divider", P.divider);
  root.setProperty("--mango-ctaBg", P.ctaBg);
  root.setProperty("--mango-ctaText", P.ctaText);
  document.documentElement.style.colorScheme = theme; // native input caret/autofill/scrollbar coloring, same as ExtensionApp's own useEffect does for the React path
}
applyLegacyThemeVars(loadTheme());

// Owns the theme preference and hands it down into MangoWalletTab, which
// now surfaces its own Light/Dark control inside its Settings screen
// (matching mango-mobile's own Settings > Appearance section) — no
// separate toggle button needed here anymore.
function ExtensionApp({ initialSession }) {
  const [theme, setTheme] = useState(loadTheme);
  const P = PALETTE[theme];

  useEffect(() => {
    document.body.style.background = P.bg;
    document.body.style.color = P.textPrimary;
    document.documentElement.style.colorScheme = theme; // native form-control/scrollbar coloring follows too
  }, [P, theme]);

  function toggleTheme() {
    const next = theme === "light" ? "dark" : "light";
    setTheme(next);
    saveTheme(next);
  }

  return React.createElement(MangoWalletTab, {
    P, theme, onToggleTheme: toggleTheme,
    initialSession, onSessionChange: saveSessionCache, onSessionCleared: clearSessionCache, onActivity: touchSessionActivity,
  });
}

async function renderFullWalletApp() {
  // MangoWallet.jsx's WelcomeScreen/WalletDashboard check
  // window.ethereum?.isMangoWallet to show "browser extension detected"
  // instead of re-promoting an install. That check only ever sees a real
  // value on a page inpage.js was injected into — which this popup, as
  // an extension page rather than a normal tab, never is. From the
  // popup's own point of view "the extension" (itself) genuinely is
  // installed, so this is accurate, not a workaround.
  if (typeof window.ethereum === "undefined") window.ethereum = { isMangoWallet: true };
  root.classList.remove("legacy"); // in case a previous render() in this same page left it set
  const initialSession = await loadSessionCache();
  createRoot(root).render(React.createElement(ExtensionApp, { initialSession }));
}

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    el.appendChild(typeof child === "string" || typeof child === "number" ? document.createTextNode(String(child)) : child);
  }
  return el;
}
// "legacy" scopes popup.html's own hand-written CSS to only this render
// path — see that file's comment on the real bug this fixes: those rules
// used to target bare button/input/h1/p tags globally, which silently
// broke MangoWalletTab's own Tailwind-positioned elements too, since both
// this plain-DOM UI and the React tree mount into the same #root.
function mount(...nodes) {
  root.classList.add("legacy");
  root.replaceChildren(...nodes);
}

function truncate(address, head = 6, tail = 4) {
  return address.length > head + tail ? `${address.slice(0, head)}…${address.slice(-tail)}` : address;
}

// Small icon-circle header, matching the main site's WelcomeScreen/
// LockedScreen pattern exactly (an icon-in-a-tinted-circle above the
// title). innerHTML here is a fixed literal SVG string written in this
// file — never derived from a dApp, an origin, or any other untrusted
// input — which is the one case this file's own module doc allows it;
// everywhere else (origin strings, dApp-supplied messages) stays on the
// h() helper's textContent-only path.
function iconCircle(svgMarkup) {
  const wrap = document.createElement("div");
  wrap.className = "icon-circle";
  wrap.innerHTML = svgMarkup;
  return wrap;
}
// Same fixed-literal-SVG rule as iconCircle above: this only ever
// receives a string written in this file, never anything from a dApp.
// Separate from iconCircle because the footer glyph sits inline next to
// text rather than inside a tinted circle.
function inlineSvg(svgMarkup, color) {
  const span = document.createElement("span");
  span.style.display = "block";
  if (color) span.style.color = color;
  span.innerHTML = svgMarkup;
  return span;
}
const WALLET_ICON_SVG = '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="#E8801A" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4Z"/></svg>';
// Real brand mark — same path data as src/MangoLogo.jsx — in place of a
// generic padlock on the returning-user Unlock screen (see renderUnlock
// below). currentColor + a wrapping `color:` style is the SVG equivalent
// of MangoLogo's own `color` prop, so this follows the saved theme
// (var(--mango-textPrimary)) the same way MangoLogo's uses of P.textPrimary
// do everywhere else in this project, rather than a fixed light/dark hex.
const MANGO_LOGO_ICON_SVG = '<svg width="20" height="17" viewBox="0 0 70 60" style="display:block;color:var(--mango-textPrimary);">' +
  '<path d="M27 4c1.5-2 4-3.5 6-3.5-.3 3-2.3 5.8-5.3 7-1-1-1.2-2.3-0.7-3.5Z" fill="currentColor"/>' +
  '<path d="M29 6c6-2 13 0.5 16 6.5-5.5 3-13 1.5-16.5-3-0.4-1.3-0.2-2.5 0.5-3.5Z" fill="currentColor"/>' +
  '<path d="M35 12c11 0 20 10.5 20 24s-10 24-20 24-20-10.5-20-24 9-24 20-24Z" fill="currentColor"/>' +
  '<path d="M35 12c2.5 0 4.8 0.4 6.9 1.2-7.7 2.6-13.4 11.6-13.4 22.3s5.7 19.7 13.4 22.3c-2.1 0.8-4.4 1.2-6.9 1.2-11 0-20-10.5-20-24s9-24 20-24Z" fill="#FFFFFF" opacity="0.16"/>' +
  '</svg>';

// ---------------------------------------------------------------------
// Onboarding + unlock
// ---------------------------------------------------------------------

// The shield-check next to the footer line. Inline rather than an icon
// dependency, same as every other glyph in this file.
const SHIELD_CHECK_SVG =
  '<svg width="15" height="17" viewBox="0 0 24 26" style="display:block;">' +
  '<path d="M12 1.5 21 5v8.2c0 5.6-3.8 9.3-9 11.3-5.2-2-9-5.7-9-11.3V5l9-3.5Z" stroke="currentColor" stroke-width="1.9" fill="none" stroke-linejoin="round"/>' +
  '<path d="M8 12.8l2.8 2.8L16.4 10" stroke="currentColor" stroke-width="1.9" fill="none" stroke-linecap="round" stroke-linejoin="round"/>' +
  '</svg>';

/**
 * Wallet onboarding, built to the supplied reference design and matching
 * the layout used on mobile so the two products read as one wallet.
 *
 * The previous version was a centred panel: an icon circle, "Mango
 * Wallet", a custody paragraph, and two stacked buttons. The design
 * replaces that with a left-aligned headline, a two-line invitation, the
 * 3D mango illustration as the middle's focus, two full-width pills and
 * a one-line reassurance at the foot.
 *
 * The illustration is the design's own artwork (assets/mango-hero.png)
 * rather than the flat brand mark — mango, orbit rings, sparkles, dots
 * and contact shadow as one image, so it cannot drift from the design a
 * piece at a time. package.mjs zips the whole extension directory, so
 * adding the file is all that is needed to ship it.
 *
 * The custody paragraph is not lost, only moved: "Self-custodial. You
 * control your keys." carries the same promise in the design's own
 * words, and the full explanation still appears on the password step
 * where it is actually load-bearing.
 */
function renderWelcome(onDone) {
  mount(
    h("div", { class: "welcome" },
      h("div", { class: "welcome-head" },
        h("h1", { class: "welcome-title" }, "Start your journey"),
        h("div", { class: "welcome-sub" }, "New here? Let\u2019s build your wallet."),
        h("div", { class: "welcome-sub" }, "Already have one? Just import it."),
      ),
      h("div", { class: "welcome-art" },
        h("div", { class: "welcome-art-tile" },
          h("img", { src: "assets/mango-hero.png", alt: "" }),
        ),
      ),
      h("div", { class: "welcome-actions" },
        h("button", { class: "welcome-create", onclick: () => renderCreateReveal(onDone) }, "Create new wallet"),
        h("button", { class: "welcome-import", onclick: () => renderImportPhrase(onDone) }, "Import existing wallet"),
        h("div", { class: "welcome-footer" },
          inlineSvg(SHIELD_CHECK_SVG),
          h("span", {}, "Self-custodial. You control your keys."),
        ),
      ),
    ),
  );
}

function renderCreateReveal(onDone) {
  const mnemonic = generateMnemonic();
  const words = mnemonic.split(" ");
  let revealed = false;
  let acked = false;

  function paint() {
    const grid = h("div", { class: "words-grid", style: revealed ? "" : "filter: blur(5px);" },
      ...words.map((w, i) => h("div", { class: "word" }, h("span", {}, `${i + 1}.`), w)),
    );
    const revealBtn = revealed ? null : h("button", { class: "btn-secondary", onclick: () => { revealed = true; paint(); } }, "Tap to reveal");
    const checkbox = h("input", { type: "checkbox", id: "ack", style: "width:auto;margin-right:8px;" });
    checkbox.checked = acked;
    checkbox.addEventListener("change", (e) => { acked = e.target.checked; paint(); });
    const continueBtn = h("button", { class: "btn-primary" }, "Continue");
    continueBtn.disabled = !(revealed && acked);
    continueBtn.addEventListener("click", () => renderCreatePassword(mnemonic, onDone));

    mount(
      h("div", { class: "panel" },
        h("h1", {}, "Your recovery phrase"),
        h("p", {}, "Write these 12 words down in order and keep them offline. Anyone with this phrase controls every asset it can access."),
        grid,
        revealBtn,
        h("label", { style: "display:flex;align-items:center;margin-bottom:12px;font-size:12px;color:#9A9AA0;" }, checkbox, "I've written it down."),
        continueBtn,
      ),
    );
  }
  paint();
}

function renderImportPhrase(onDone) {
  let error = "";
  function paint() {
    const textarea = h("textarea", { rows: "3", placeholder: "word1 word2 word3 ..." });
    const continueBtn = h("button", { class: "btn-primary" }, "Continue");
    continueBtn.addEventListener("click", () => {
      const normalized = normalizeMnemonic(textarea.value);
      if (!isValidMnemonic(normalized)) { error = "That doesn't look like a valid recovery phrase."; paint(); return; }
      renderCreatePassword(normalized, onDone);
    });
    mount(
      h("div", { class: "panel" },
        h("h1", {}, "Import wallet"),
        h("p", {}, "Enter your 12 or 24-word recovery phrase."),
        textarea,
        error ? h("div", { class: "error" }, error) : null,
        continueBtn,
      ),
    );
  }
  paint();
}

function renderCreatePassword(mnemonic, onDone) {
  let error = "";
  function paint() {
    const pw = h("input", { type: "password", placeholder: "Password" });
    const confirm = h("input", { type: "password", placeholder: "Confirm password" });
    const submitBtn = h("button", { class: "btn-primary" }, "Set password");
    submitBtn.addEventListener("click", async () => {
      if (pw.value.length < 8) { error = "At least 8 characters."; paint(); return; }
      if (pw.value !== confirm.value) { error = "Passwords don't match."; paint(); return; }
      const account0 = deriveAccountAtIndex(mnemonic, 0);
      const mnemonicRecord = await encryptSecret(mnemonic, pw.value);
      const id = `wallet-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      saveVault({ wallets: [{ id, label: "Extension Wallet", mnemonicRecord, accountCount: 1, accountLabels: {} }], importedKeys: [] });
      // onDone now receives the full session shape (matching
      // MangoWalletInner's own in-memory state), not just one account —
      // see main()'s afterUnlock, which caches this so the wallet stays
      // unlocked for future popup opens and dApp requests instead of
      // asking for the password again immediately.
      onDone({
        wallets: [{ id, label: "Extension Wallet", accounts: [account0], accountLabels: {} }],
        importedKeys: [],
        activeKey: { type: "hd", walletId: id, index: 0 },
      });
    });
    mount(
      h("div", { class: "panel" },
        h("h1", {}, "Set a password"),
        h("p", {}, "Encrypts your wallet on this device only — it does not replace your recovery phrase."),
        pw, confirm,
        error ? h("div", { class: "error" }, error) : null,
        submitBtn,
      ),
    );
  }
  paint();
}

function renderUnlock(onDone) {
  let error = "";
  function paint() {
    const pw = h("input", { type: "password", placeholder: "Password" });
    const unlockBtn = h("button", { class: "btn-primary" }, "Unlock");
    unlockBtn.addEventListener("click", async () => {
      const vault = loadVault();
      try {
        // Full vault, not just index 0 of wallet 0 — someone who's added
        // extra wallets/accounts via the real dashboard would otherwise
        // silently lose access to them in whatever session gets cached
        // from THIS unlock (see main()'s afterUnlock).
        const session = await deriveFullVaultSession(vault, pw.value, deriveAccountAtIndex);
        onDone(session);
      } catch {
        error = "Incorrect password.";
        paint();
      }
    });
    mount(
      h("div", { class: "panel", style: "display:flex;flex-direction:column;align-items:center;text-align:center;" },
        iconCircle(MANGO_LOGO_ICON_SVG),
        h("h1", {}, "Unlock Mango Wallet"),
        h("div", { style: "width:100%;margin-top:4px;" },
          pw,
          error ? h("div", { class: "error", style: "text-align:left;" }, error) : null,
          unlockBtn,
        ),
      ),
    );
  }
  paint();
}

// ---------------------------------------------------------------------
// Approval flow — a dApp is waiting on the other end of this popup
// ---------------------------------------------------------------------

function resolveRequest(requestId, payload) {
  chrome.runtime.sendMessage({ type: "MANGO_WALLET_RESOLVE", id: requestId, ...payload }, () => window.close());
}

function decodePersonalSignMessage(message) {
  if (!isHex(message)) return message; // already plain text
  try { return hexToString(message); } catch { return message; }
}

async function renderApproval(requestId, request, account) {
  const { chain, method, params, origin } = request;
  let title = "Approve request";
  let body;
  let onApprove;

  if (chain === "evm" && method === "eth_requestAccounts") {
    title = "Connect";
    body = h("p", {}, `wants to see your Mango Wallet address.`);
    onApprove = () => resolveRequest(requestId, { result: [account.evm.address], connection: { address: account.evm.address, chainId: `0x${DEFAULT_EVM_CHAIN_ID.toString(16)}` } });
  } else if (chain === "evm" && method === "wallet_switchEthereumChain") {
    const chainIdHex = params?.[0]?.chainId ?? "0x1";
    const chainId = parseInt(chainIdHex, 16);
    const chain2 = viemChainForId(chainId);
    title = "Switch network";
    body = h("p", {}, `wants to switch to ${chain2 ? chain2.name : `chain ${chainIdHex}`}.`);
    onApprove = async () => {
      const { connectedSites } = await chrome.storage.local.get("connectedSites");
      const existing = (connectedSites ?? {})[origin]?.evm ?? { address: account.evm.address };
      resolveRequest(requestId, { result: null, connection: { ...existing, chainId: chainIdHex } });
    };
  } else if (chain === "evm" && method === "wallet_addEthereumChain") {
    // EIP-3085. This wallet already carries a real, verified chain
    // definition (id, native currency, a trustworthy default RPC) for
    // every chain viem/chains knows — hundreds of them — via the same
    // viemChainForId() lookup wallet_switchEthereumChain already uses.
    // So "add" a chain we already recognize by just switching to it,
    // the same way MetaMask treats addEthereumChain for an already-known
    // chain. Deliberately does NOT fall back to the dApp's own supplied
    // rpcUrls/chainName for a chain we don't recognize — trusting an
    // arbitrary RPC endpoint a website hands us is a real phishing/
    // tracking vector, not just an edge case, so an unknown chain is a
    // clean rejection instead of a guess.
    const chainIdHex = params?.[0]?.chainId ?? null;
    const chainId = chainIdHex != null ? parseInt(chainIdHex, 16) : null;
    const knownChain = chainId != null ? viemChainForId(chainId) : null;
    title = "Add network";
    if (!knownChain) {
      body = h("p", {}, `wants to add a network Mango Wallet doesn't have verified chain data for. Not adding it — only chains with a real, trusted default RPC can be added.`);
      // Not code 4902 — that specifically means "call wallet_addEthereumChain
      // instead," which would be nonsensical to send back FROM
      // addEthereumChain itself (a well-behaved dApp could loop). -32602
      // ("Invalid params") accurately reflects that we're rejecting the
      // chain data itself as unverified, not asking for a different call.
      onApprove = () => resolveRequest(requestId, { error: { message: "Unrecognized chain — Mango Wallet only adds chains it has verified data for.", code: -32602 } });
    } else {
      body = h("p", {}, `wants to add and switch to ${knownChain.name}.`);
      onApprove = async () => {
        const { connectedSites } = await chrome.storage.local.get("connectedSites");
        const existing = (connectedSites ?? {})[origin]?.evm ?? { address: account.evm.address };
        resolveRequest(requestId, { result: null, connection: { ...existing, chainId: chainIdHex } });
      };
    }
  } else if (chain === "evm" && method === "wallet_watchAsset") {
    // EIP-747 — "Add token to wallet," the button most dApps show right
    // after a swap. Files the token under this SAME wallet's own
    // customTokens.js store the Balances panel's "Add token" flow already
    // uses, so it shows up in the real dashboard immediately, not a
    // separate, disconnected list.
    const opts = params?.options ?? params?.[0]?.options ?? {};
    const tokenAddress = opts.address;
    const symbol = opts.symbol ?? "TOKEN";
    const decimals = typeof opts.decimals === "number" ? opts.decimals : 18;
    title = "Add token";
    body = h("div", {},
      h("p", {}, `wants to add ${symbol} to your wallet.`),
      h("div", { class: "row" }, h("span", { class: "muted" }, "Contract"), h("span", { class: "mono" }, truncate(tokenAddress ?? ""))),
    );
    onApprove = async () => {
      try {
        const { connectedSites } = await chrome.storage.local.get("connectedSites");
        const chainIdHex = (connectedSites ?? {})[origin]?.evm?.chainId ?? `0x${DEFAULT_EVM_CHAIN_ID.toString(16)}`;
        const chainKey = CHAIN_ID_TO_KEY[parseInt(chainIdHex, 16)];
        if (!chainKey) throw new Error("Mango Wallet doesn't yet show balances for this network.");
        if (!tokenAddress) throw new Error("No token address given.");
        addCustomToken(chainKey, { symbol, decimals, address: tokenAddress });
        resolveRequest(requestId, { result: true });
      } catch (err) {
        resolveRequest(requestId, { error: { message: err.message } });
      }
    };
  } else if (chain === "evm" && method === "wallet_requestPermissions") {
    // EIP-2255. This wallet has exactly one real permission to grant
    // (eth_accounts) — functionally the same thing eth_requestAccounts
    // already asks for, so this reuses that same Connect approval rather
    // than a second, parallel connect flow.
    title = "Connect";
    body = h("p", {}, `wants permission to see your Mango Wallet address.`);
    onApprove = () => resolveRequest(requestId, {
      result: [{ parentCapability: "eth_accounts", invoker: origin, caveats: [{ type: "restrictReturnedAccounts", value: [account.evm.address] }], date: Date.now() }],
      connection: { address: account.evm.address, chainId: `0x${DEFAULT_EVM_CHAIN_ID.toString(16)}` },
    });
  } else if (chain === "evm" && method === "personal_sign") {
    title = "Sign message";
    body = h("div", {}, h("p", {}, "Message:"), h("div", { class: "panel mono", style: "word-break:break-word;" }, decodePersonalSignMessage(params[0])));
    onApprove = async () => {
      try {
        const signature = await signEvmPersonalMessage({ privateKeyHex: account.evm.privateKey, message: params[0] });
        resolveRequest(requestId, { result: signature });
      } catch (err) { resolveRequest(requestId, { error: { message: err.message } }); }
    };
  } else if (chain === "evm" && method === "eth_signTypedData_v4") {
    title = "Sign typed data";
    body = h("div", {}, h("p", {}, "This site is requesting a structured-data signature — check that it matches what you expect before approving."));
    onApprove = async () => {
      try {
        const signature = await signEvmTypedData({ privateKeyHex: account.evm.privateKey, typedDataJson: params[1] });
        resolveRequest(requestId, { result: signature });
      } catch (err) { resolveRequest(requestId, { error: { message: err.message } }); }
    };
  } else if (chain === "evm" && method === "eth_sendTransaction") {
    const tx = params[0];
    title = "Send transaction";
    body = h("div", {},
      h("div", { class: "row" }, h("span", { class: "muted" }, "To"), h("span", { class: "mono" }, truncate(tx.to ?? "contract creation"))),
      tx.value ? h("div", { class: "row" }, h("span", { class: "muted" }, "Value"), h("span", { class: "mono" }, `${BigInt(tx.value)} wei`)) : null,
      tx.data && tx.data !== "0x" ? h("p", {}, "Includes contract call data — only approve if you trust this site.") : null,
    );
    onApprove = async () => {
      try {
        const { connectedSites } = await chrome.storage.local.get("connectedSites");
        const chainIdHex = (connectedSites ?? {})[origin]?.evm?.chainId ?? `0x${DEFAULT_EVM_CHAIN_ID.toString(16)}`;
        const hash = await signAndSendEvmTx({ chainId: parseInt(chainIdHex, 16), privateKeyHex: account.evm.privateKey, txParams: tx });
        resolveRequest(requestId, { result: hash });
      } catch (err) { resolveRequest(requestId, { error: { message: err.message } }); }
    };
  } else if (chain === "solana" && method === "connect") {
    title = "Connect";
    body = h("p", {}, "wants to see your Solana address.");
    onApprove = () => resolveRequest(requestId, { result: account.solana.address, connection: { address: account.solana.address } });
  } else if (chain === "solana" && (method === "signTransaction" || method === "signAndSendTransaction")) {
    title = method === "signTransaction" ? "Sign transaction" : "Sign & send transaction";
    body = h("p", {}, "Mango Wallet can't yet show a full breakdown of this transaction — only approve if you trust this site.");
    onApprove = async () => {
      try {
        const result = method === "signTransaction"
          ? await signSolanaTransaction({ secretKeyBase58: account.solana.privateKey, serializedTxBase64: params[0] })
          : await signAndSendSolanaTransaction({ secretKeyBase58: account.solana.privateKey, serializedTxBase64: params[0] });
        resolveRequest(requestId, { result });
      } catch (err) { resolveRequest(requestId, { error: { message: err.message } }); }
    };
  } else if (chain === "solana" && method === "signMessage") {
    title = "Sign message";
    const bytes = new Uint8Array(params[0]);
    let preview;
    try { preview = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { preview = `(${bytes.length} bytes)`; }
    body = h("div", {}, h("p", {}, "Message:"), h("div", { class: "panel mono", style: "word-break:break-word;" }, preview));
    onApprove = () => {
      const signature = signSolanaMessage({ secretKeyBase58: account.solana.privateKey, messageBytes: params[0] });
      resolveRequest(requestId, { result: signature });
    };
  } else {
    body = h("p", {}, `Unsupported request: ${method}`);
    onApprove = () => resolveRequest(requestId, { error: { message: "Unsupported method" } });
  }

  mount(
    h("div", { class: "panel" },
      h("div", { class: "origin-badge" }, origin),
      h("h1", { style: "margin-top:6px;" }, title),
      body,
    ),
    h("div", { class: "btn-row" },
      h("button", { class: "btn-secondary", onclick: () => resolveRequest(requestId, { error: { message: "User rejected the request.", code: 4001 } }) }, "Reject"),
      h("button", { class: "btn-primary", onclick: onApprove }, "Approve"),
    ),
  );
}

// ---------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------

async function main() {
  const params = new URLSearchParams(window.location.search);
  const requestId = params.get("requestId") ? Number(params.get("requestId")) : null;

  if (requestId == null) {
    await renderFullWalletApp();
    return;
  }

  const request = await chrome.runtime.sendMessage({ type: "MANGO_WALLET_POPUP_READY", requestId });
  if (!request) {
    mount(h("div", { class: "panel" }, h("h1", {}, "Request expired"), h("p", {}, "Go back to the site and try again.")));
    return;
  }

  // The whole point of the shared session cache: a dApp asking to
  // connect/sign shouldn't need the password again just because this is
  // a separate popup window from the main dashboard — if the wallet was
  // genuinely unlocked recently (anywhere), go straight to the approve/
  // reject screen instead of re-prompting.
  const cached = await loadSessionCache();
  const cachedAccount = cached ? resolveActiveAccountFromSession(cached) : null;
  if (cachedAccount) {
    touchSessionActivity();
    renderApproval(requestId, request, cachedAccount);
    return;
  }

  const vault = loadVault();
  const afterUnlock = (session) => {
    saveSessionCache(session);
    renderApproval(requestId, request, resolveActiveAccountFromSession(session));
  };
  if (!vault) renderWelcome(afterUnlock);
  else renderUnlock(afterUnlock);
}

main();
