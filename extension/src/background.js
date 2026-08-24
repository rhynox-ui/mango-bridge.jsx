// extension/src/background.js
//
// MV3 service worker — the router between a page's request (relayed by
// content.js) and the popup, where any actual key material ever gets
// touched. This file NEVER has a decrypted key or the wallet password in
// memory: it has no DOM (no localStorage, no Web Crypto UI), so it
// couldn't decrypt the vault even if it wanted to — vault.js's
// window.localStorage calls only work from a page context, which the
// popup is and this service worker isn't. That split is deliberate, not
// incidental: it keeps every signing decision behind a real popup the
// user sees, even if this file's request-routing logic has a bug.
//
// Two kinds of request:
//   - Read-only, already-approved (eth_chainId, eth_accounts for a site
//     that's already connected): answered straight from `connectedSites`
//     — no popup, no key material involved either way.
//   - Anything else (connecting, signing, sending): opens a real popup
//     window and waits for the user's decision there.
//
// Known limitation, stated plainly rather than hidden: MV3 service
// workers can be torn down by the browser after ~30s idle. A pending
// approval's in-memory sendResponse callback does not survive that — if
// it happens mid-approval, the dApp's request will hang until it times
// out on its own end rather than getting a clean rejection. This is a
// real, documented gap (shared by most MV3-based wallet extensions'
// simplest implementations), not something this file silently papers
// over.

// Registers inpage.js as a "world": "MAIN" content script, run
// programmatically via chrome.scripting rather than as a static entry in
// manifest.json's content_scripts array. Both forms exist in Chrome, but
// the static-manifest form of a MAIN-world content script has a known,
// documented reliability bug on some Chrome versions; registering it here
// instead — once, at service-worker startup — is the form real wallet
// extensions rely on for this. Chrome persists a registerContentScripts
// registration across browser restarts by itself, so this only needs to
// actually add it once; "already registered" on every later worker wake
// (MV3 workers restart often) is the expected, harmless steady state.
async function registerInpageScript() {
  try {
    await chrome.scripting.registerContentScripts([
      {
        id: "mango-inpage",
        matches: ["<all_urls>"],
        js: ["src/inpage.js"],
        world: "MAIN",
        runAt: "document_start",
        allFrames: true,
        persistAcrossSessions: true,
      },
    ]);
  } catch (err) {
    // Chrome throws if "mango-inpage" is already registered from a prior
    // worker wake — that's success, not a failure, so only a genuinely
    // different error is worth surfacing.
    if (!String(err?.message).includes("Duplicate script ID")) {
      console.error("Mango Wallet: failed to register inpage script", err);
    }
  }
}
registerInpageScript();

const REQUEST_TYPE = "MANGO_WALLET_REQUEST";
const EVENT_TYPE = "MANGO_WALLET_EVENT";
const POPUP_READY_TYPE = "MANGO_WALLET_POPUP_READY";
const RESOLVE_TYPE = "MANGO_WALLET_RESOLVE";

const NO_APPROVAL_NEEDED = new Set(["eth_chainId", "eth_accounts", "eth_getAccounts", "wallet_getPermissions"]);
const APPROVAL_METHODS_EVM = new Set([
  "eth_requestAccounts", "eth_sendTransaction", "personal_sign", "eth_signTypedData_v4", "wallet_switchEthereumChain",
  // wallet_addEthereumChain and wallet_watchAsset previously fell through
  // to the generic "Method not supported" (-32601) rejection below — a
  // clean, spec-correct error, but real missing functionality: plenty of
  // real dApps call addEthereumChain directly (not just as a fallback
  // after a failed switch) when onboarding to a specific network, and
  // watchAsset is the standard "Add token to wallet" button after a swap.
  // wallet_requestPermissions piggybacks on the same approval popup as
  // eth_requestAccounts (see popup.js) since this wallet only ever has
  // the one real permission (eth_accounts) to grant.
  "wallet_addEthereumChain", "wallet_watchAsset", "wallet_requestPermissions",
]);
const APPROVAL_METHODS_SOLANA = new Set(["connect", "signTransaction", "signAllTransactions", "signAndSendTransaction", "signMessage"]);

// In-memory only — see the module doc's "known limitation" above for why
// this can't be the sole source of truth for a long-idle popup.
const pendingRequests = new Map(); // id -> { sendResponse, popupWindowId, chain, method, params, origin }

async function getConnectedSites() {
  const { connectedSites } = await chrome.storage.local.get("connectedSites");
  return connectedSites ?? {};
}
async function setConnectedSite(origin, chain, entry) {
  const sites = await getConnectedSites();
  sites[origin] = { ...(sites[origin] ?? {}), [chain]: entry };
  await chrome.storage.local.set({ connectedSites: sites });
}
async function clearConnectedSite(origin, chain) {
  const sites = await getConnectedSites();
  if (sites[origin]) {
    delete sites[origin][chain];
    if (Object.keys(sites[origin]).length === 0) delete sites[origin];
    await chrome.storage.local.set({ connectedSites: sites });
  }
}

async function broadcastEvent(origin, chain, event, payload) {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (!tab.id || !tab.url) continue;
    try {
      if (new URL(tab.url).origin !== origin) continue;
    } catch { continue; }
    chrome.tabs.sendMessage(tab.id, { type: EVENT_TYPE, chain, event, payload }).catch(() => { /* no content script in that tab (e.g. chrome:// pages) — fine to ignore */ });
  }
}

async function openApprovalPopup(id) {
  const win = await chrome.windows.create({ url: chrome.runtime.getURL(`popup.html?requestId=${id}`), type: "popup", width: 380, height: 640 });
  const entry = pendingRequests.get(id);
  if (entry) entry.popupWindowId = win.id;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === REQUEST_TYPE) {
    handleRequest(message, sendResponse);
    return true; // async response
  }
  if (message?.type === POPUP_READY_TYPE) {
    const entry = pendingRequests.get(message.requestId);
    sendResponse(entry ? { chain: entry.chain, method: entry.method, params: entry.params, origin: entry.origin } : null);
    return false;
  }
  if (message?.type === RESOLVE_TYPE) {
    handleResolve(message);
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

async function handleRequest(message, sendResponse) {
  const { id, chain, method, params, origin } = message;

  if (chain === "evm" && NO_APPROVAL_NEEDED.has(method)) {
    const sites = await getConnectedSites();
    const connection = sites[origin]?.evm;
    if (method === "eth_chainId") { sendResponse({ result: connection?.chainId ?? "0x1" }); return; }
    if (method === "wallet_getPermissions") {
      // EIP-2255. This wallet only ever has one real permission to report
      // (eth_accounts) — no separate permission system exists beyond
      // "connected or not," so this is a real, accurate answer, not a
      // stub: an empty array when there's genuinely nothing granted yet,
      // a single eth_accounts capability when there is.
      sendResponse({
        result: connection
          ? [{ parentCapability: "eth_accounts", invoker: origin, caveats: [{ type: "restrictReturnedAccounts", value: [connection.address] }], date: Date.now() }]
          : [],
      });
      return;
    }
    sendResponse({ result: connection ? [connection.address] : [] });
    return;
  }

  // "disconnect" doesn't need a popup — a site can't force the user to
  // keep it connected, so this always succeeds immediately. This has to
  // be checked BEFORE the needsApproval gate below: "disconnect" was
  // never actually in APPROVAL_METHODS_SOLANA, so that gate rejected
  // every real disconnect call with "Method not supported" and this
  // block never ran — window.solana.disconnect() has been silently
  // broken for every dApp that calls it (e.g. any wallet-adapter
  // "Disconnect" button) until this fix.
  if (chain === "solana" && method === "disconnect") {
    await clearConnectedSite(origin, "solana");
    sendResponse({ result: null });
    return;
  }

  const needsApproval =
    (chain === "evm" && APPROVAL_METHODS_EVM.has(method)) ||
    (chain === "solana" && APPROVAL_METHODS_SOLANA.has(method));

  if (!needsApproval) {
    sendResponse({ error: { message: `Method not supported: ${method}`, code: -32601 } });
    return;
  }

  pendingRequests.set(id, { sendResponse, popupWindowId: null, chain, method, params, origin });
  await openApprovalPopup(id);
}

async function handleResolve(message) {
  const { id, result, error, connection } = message;
  const entry = pendingRequests.get(id);
  if (!entry) return; // popup resolved a request this worker no longer remembers (e.g. it was restarted) — see module doc
  pendingRequests.delete(id);

  if (connection) {
    await setConnectedSite(entry.origin, entry.chain, connection);
    // Real bug fixed here: this used to always broadcast "accountsChanged"
    // for any EVM connection update, including a chain switch — where
    // the account hasn't changed at all, only the chain has. EIP-1193
    // has a separate event for exactly that (chainChanged, whose payload
    // is the bare chainId string, not an array), and dApps that key
    // chain-dependent state off that specific event never saw it fire
    // from this wallet, only ever seeing accountsChanged with the same
    // address it already had.
    if (entry.chain === "solana") {
      await broadcastEvent(entry.origin, "solana", "connect", connection.address);
    } else if (entry.method === "wallet_switchEthereumChain" || entry.method === "wallet_addEthereumChain") {
      await broadcastEvent(entry.origin, "evm", "chainChanged", connection.chainId);
    } else {
      await broadcastEvent(entry.origin, "evm", "accountsChanged", [connection.address]);
    }
  }

  entry.sendResponse(error ? { error } : { result });
  if (entry.popupWindowId != null) {
    chrome.windows.remove(entry.popupWindowId).catch(() => {});
  }
}
