// extension/src/content.js
//
// Isolated-world content script — the only piece of this extension that
// can see both the page (via window.postMessage) and the extension's own
// privileged APIs (via chrome.runtime). It has no access to key material
// and makes no decisions: it just relays.
//
// inpage.js used to be injected from here via a DOM-created <script src>
// tag. That approach is subject to the PAGE's own Content-Security-Policy
// script-src directive — any dApp with a strict CSP (increasingly common
// on serious DeFi front-ends) silently blocked that tag from loading at
// all, meaning window.ethereum/EIP-6963 never showed up there and Mango
// looked "not installed" even though it was. inpage.js is now instead
// declared directly in manifest.json as a second content_scripts entry
// with "world": "MAIN" — Chrome injects it itself, the same way it
// injects this file, which is NOT subject to the page's CSP (this is the
// documented, CSP-proof MV3 pattern other wallet extensions use). This
// file's only remaining job is forwarding every MANGO_WALLET_REQUEST from
// the page to background.js, and every response/event from background.js
// back to the page — tagging each with this frame's real origin, which
// the page's own inpage.js could otherwise lie about.

const REQUEST_TYPE = "MANGO_WALLET_REQUEST";
const RESPONSE_TYPE = "MANGO_WALLET_RESPONSE";
const EVENT_TYPE = "MANGO_WALLET_EVENT";

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.type !== REQUEST_TYPE) return;

  chrome.runtime.sendMessage(
    { type: REQUEST_TYPE, id: data.id, chain: data.chain, method: data.method, params: data.params, origin: window.location.origin },
    (response) => {
      // chrome.runtime.lastError fires if the service worker was torn
      // down mid-request (MV3 workers are ephemeral) — surface it as a
      // real rejection rather than leaving the page's promise hanging.
      if (chrome.runtime.lastError) {
        window.postMessage({ type: RESPONSE_TYPE, id: data.id, error: { message: chrome.runtime.lastError.message } }, "*");
        return;
      }
      window.postMessage({ type: RESPONSE_TYPE, id: data.id, result: response?.result, error: response?.error }, "*");
    }
  );
});

// Background pushes account/chain-change/disconnect events (e.g. after
// the user switches active account in the popup) without the page having
// asked first — relay those straight through too.
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== EVENT_TYPE) return;
  window.postMessage({ type: EVENT_TYPE, chain: message.chain, event: message.event, payload: message.payload }, "*");
});
