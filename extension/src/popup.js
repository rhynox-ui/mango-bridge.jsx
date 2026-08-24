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
import { MangoWalletTab } from "../../src/MangoWallet.jsx";
import { PALETTE } from "../../src/theme.js";
import { generateMnemonic, isValidMnemonic, deriveAccountAtIndex, normalizeMnemonic } from "../../src/wallet/keys.js";
import { encryptSecret, decryptSecret, saveVault, loadVault, clearVault } from "../../src/wallet/vault.js";
import {
  signAndSendEvmTx, signEvmPersonalMessage, signEvmTypedData,
  signSolanaTransaction, signAndSendSolanaTransaction, signSolanaMessage,
} from "./signing.js";
import { viemChainForId, DEFAULT_EVM_CHAIN_ID } from "./chains.js";
import { isHex, hexToBytes, hexToString } from "viem";

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
function ExtensionApp() {
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

  return React.createElement(MangoWalletTab, { P, theme, onToggleTheme: toggleTheme });
}

function renderFullWalletApp() {
  // MangoWallet.jsx's WelcomeScreen/WalletDashboard check
  // window.ethereum?.isMangoWallet to show "browser extension detected"
  // instead of re-promoting an install. That check only ever sees a real
  // value on a page inpage.js was injected into — which this popup, as
  // an extension page rather than a normal tab, never is. From the
  // popup's own point of view "the extension" (itself) genuinely is
  // installed, so this is accurate, not a workaround.
  if (typeof window.ethereum === "undefined") window.ethereum = { isMangoWallet: true };
  root.classList.remove("legacy"); // in case a previous render() in this same page left it set
  createRoot(root).render(React.createElement(ExtensionApp));
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
const WALLET_ICON_SVG = '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="#E8801A" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4Z"/></svg>';
const LOCK_ICON_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#9A9AA0" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';

// ---------------------------------------------------------------------
// Onboarding + unlock
// ---------------------------------------------------------------------

function renderWelcome(onDone) {
  mount(
    h("div", { class: "panel", style: "display:flex;flex-direction:column;align-items:center;text-align:center;" },
      iconCircle(WALLET_ICON_SVG),
      h("h1", {}, "Mango Wallet"),
      h("p", {}, "Self-custodial, generated and stored only in this browser extension. Mango never sees your recovery phrase or private keys."),
      h("div", { style: "width:100%;margin-top:8px;" },
        h("button", { class: "btn-primary", onclick: () => renderCreateReveal(onDone) }, "Create a new wallet"),
        h("button", { class: "btn-secondary", onclick: () => renderImportPhrase(onDone) }, "I already have a recovery phrase"),
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
      onDone(account0);
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
        const mnemonic = await decryptSecret(vault.wallets[0].mnemonicRecord, pw.value);
        onDone(deriveAccountAtIndex(mnemonic, 0));
      } catch {
        error = "Incorrect password.";
        paint();
      }
    });
    mount(
      h("div", { class: "panel", style: "display:flex;flex-direction:column;align-items:center;text-align:center;" },
        iconCircle(LOCK_ICON_SVG),
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
    renderFullWalletApp();
    return;
  }

  const request = await chrome.runtime.sendMessage({ type: "MANGO_WALLET_POPUP_READY", requestId });
  if (!request) {
    mount(h("div", { class: "panel" }, h("h1", {}, "Request expired"), h("p", {}, "Go back to the site and try again.")));
    return;
  }

  const vault = loadVault();
  const afterUnlock = (account) => renderApproval(requestId, request, account);
  if (!vault) renderWelcome(afterUnlock);
  else renderUnlock(afterUnlock);
}

main();
