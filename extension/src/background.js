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
// Known limitation, stated plainly: MV3 service workers can be torn down
// by the browser after ~30s idle. A pending approval's in-memory
// sendResponse callback does not survive that — if it happens mid-approval,
// the dApp's request will hang until it times out on its own end rather than
// getting a clean rejection. This is a real, documented gap, not something
// this file silently papers over.

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
  "wallet_addEthereumChain", "wallet_watchAsset", "wallet_requestPermissions",
]);
const APPROVAL_METHODS_SOLANA = new Set(["connect", "signTransaction", "signAllTransactions", "signAndSendTransaction", "signMessage"]);

const pendingRequests = new Map();

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
    chrome.tabs.sendMessage(tab.id, { type: EVENT_TYPE, chain, event, payload }).catch(() => {});
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
    return true;
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

  // EIP-1193 explicitly permits eth_requestAccounts to return immediately
  // when the dapp has already been authorized. AppKit/wagmi may call
  // eth_requestAccounts during automatic session restoration. Treating
  // every such call as a fresh approval was the root of the Mango Wallet
  // reconnect loop: AppKit restored the connection, Mango opened a popup,
  // the popup resolved the same connection, AppKit retried restoration,
  // and the cycle repeated. An already-authorized origin must be
  // idempotent and must never open another approval window.
  if (chain === "evm" && method === "eth_requestAccounts") {
    const sites = await getConnectedSites();
    const connection = sites[origin]?.evm;
    if (connection?.address) {
      sendResponse({ result: [connection.address] });
      return;
    }
  }

  // "disconnect" doesn't need a popup — a site can't force the user to
  // keep it connected, so this always succeeds immediately. This has to
  // be checked BEFORE the needsApproval gate below.
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
  if (!entry) return;
  pendingRequests.delete(id);

  if (connection) {
    await setConnectedSite(entry.origin, entry.chain, connection);
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
