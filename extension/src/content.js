// extension/src/content.js
//
// Isolated-world content script — the only piece of this extension that
// can see both the page (via window.postMessage) and the extension's own
// privileged APIs (via chrome.runtime). It has no access to key material
// and makes no decisions: it just relays. Two jobs:
//   1. Inject inpage.js into the page's own JS context as early as
//      possible (document_start), so window.ethereum/window.solana exist
//      before a dApp's bundle runs its own "is a wallet installed?" check.
//   2. Forward every MANGO_WALLET_REQUEST from the page to background.js,
//      and every response/event from background.js back to the page —
//      tagging each with this frame's real origin, which the page's own
//      inpage.js could otherwise lie about.

(function injectInpageScript() {
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("src/inpage.js");
  // A script element created via createElement defaults to async=true —
  // fine for an ordinary page script, but this one specifically needs to
  // run in document order, before any of the page's own inline/external
  // scripts get a chance to check "is a wallet installed?" and decide
  // there isn't one.
  script.async = false;
  // inpage.js runs in the page's own "main world" JS context, which has
  // no access to chrome.* APIs at all (that isolation is the whole point
  // of content scripts running in a separate "isolated world") — so it
  // can't call chrome.runtime.getURL itself for the EIP-6963 icon. This
  // dataset attribute is the one channel available to hand it over: both
  // worlds share the same DOM, and document.currentScript works in
  // either world since it's plain DOM access, not an extension API.
  script.dataset.iconUrl = chrome.runtime.getURL("icons/icon128.png");
  script.onload = function () { this.remove(); }; // no need to keep the <script> tag around once it's run
  (document.head || document.documentElement).prepend(script);
})();

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
