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
// Deliberately single-wallet, single-account (index 0) for this first
// version — the main site's Wallet tab already has the full multi-
// wallet/multi-account UI; this popup's job is dApp connectivity, kept
// small enough to fit a 360×480 popup without needing that entire
// surface duplicated here too.

import { generateMnemonic, isValidMnemonic, deriveAccountAtIndex, normalizeMnemonic } from "../../src/wallet/keys.js";
import { encryptSecret, decryptSecret, saveVault, loadVault, clearVault } from "../../src/wallet/vault.js";
import {
  signAndSendEvmTx, signEvmPersonalMessage, signEvmTypedData,
  signSolanaTransaction, signAndSendSolanaTransaction, signSolanaMessage,
} from "./signing.js";
import { viemChainForId, DEFAULT_EVM_CHAIN_ID } from "./chains.js";
import { isHex, hexToBytes, hexToString } from "viem";

const MANGO_SITE_URL = "https://mangoprotocol.site/";
const root = document.getElementById("root");

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
function mount(...nodes) { root.replaceChildren(...nodes); }

function truncate(address, head = 6, tail = 4) {
  return address.length > head + tail ? `${address.slice(0, head)}…${address.slice(-tail)}` : address;
}

// ---------------------------------------------------------------------
// Onboarding + unlock
// ---------------------------------------------------------------------

function renderWelcome(onDone) {
  mount(
    h("div", { class: "panel" },
      h("h1", {}, "Mango Wallet"),
      h("p", {}, "Self-custodial, generated and stored only in this browser extension. Mango never sees your recovery phrase or private keys."),
      h("button", { class: "btn-primary", onclick: () => renderCreateReveal(onDone) }, "Create a new wallet"),
      h("button", { class: "btn-secondary", onclick: () => renderImportPhrase(onDone) }, "I already have a recovery phrase"),
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
      h("div", { class: "panel" },
        h("h1", {}, "Unlock Mango Wallet"),
        pw,
        error ? h("div", { class: "error" }, error) : null,
        unlockBtn,
      ),
    );
  }
  paint();
}

// ---------------------------------------------------------------------
// Dashboard (no pending dApp request — the toolbar icon was just clicked)
// ---------------------------------------------------------------------

async function renderDashboard(account) {
  const { connectedSites } = await chrome.storage.local.get("connectedSites");
  const sites = connectedSites ?? {};
  const originRows = Object.entries(sites).map(([origin, byChain]) =>
    h("div", { class: "row" },
      h("div", {}, h("div", { class: "origin-badge" }, origin)),
      h("button", {
        class: "btn-secondary", style: "width:auto;padding:6px 12px;margin:0;",
        onclick: async () => {
          const next = { ...sites };
          delete next[origin];
          await chrome.storage.local.set({ connectedSites: next });
          renderDashboard(account);
        },
      }, "Disconnect"),
    ),
  );

  mount(
    h("div", { class: "panel" },
      h("h1", {}, "Mango Wallet"),
      h("div", { class: "row" }, h("span", { class: "muted" }, "EVM (all chains)"), h("span", { class: "mono" }, truncate(account.evm.address))),
      h("div", { class: "row" }, h("span", { class: "muted" }, "Solana"), h("span", { class: "mono" }, truncate(account.solana.address))),
    ),
    h("div", { class: "panel" },
      h("div", { style: "font-size:12px;font-weight:600;margin-bottom:4px;" }, "Connected sites"),
      originRows.length ? h("div", {}, ...originRows) : h("p", { style: "margin:0;" }, "No sites connected yet."),
    ),
    h("a", { class: "link", href: MANGO_SITE_URL, target: "_blank", style: "margin-bottom:8px;" }, "Open full wallet on mangoprotocol.site →"),
    h("button", { class: "btn-danger", onclick: async () => { clearVault(); renderWelcome((acc) => renderDashboard(acc)); } }, "Remove this wallet"),
  );
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

  let request = null;
  if (requestId != null) {
    request = await chrome.runtime.sendMessage({ type: "MANGO_WALLET_POPUP_READY", requestId });
    if (!request) {
      mount(h("div", { class: "panel" }, h("h1", {}, "Request expired"), h("p", {}, "Go back to the site and try again.")));
      return;
    }
  }

  function afterUnlock(account) {
    if (request) renderApproval(requestId, request, account);
    else renderDashboard(account);
  }

  const vault = loadVault();
  if (!vault) renderWelcome(afterUnlock);
  else renderUnlock(afterUnlock);
}

main();
