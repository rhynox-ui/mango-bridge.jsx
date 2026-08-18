// extension/src/inpage.js
//
// Injected into the PAGE's own JS context (the "main world") by
// content.js — this is the only file in the extension a dApp's own code
// ever talks to directly. It defines window.ethereum (EIP-1193, the same
// interface MetaMask/Coinbase Wallet expose) and window.mangoSolana +
// a Wallet Standard-ish window.solana surface (the interface Phantom/
// Solflare expose) — never touches key material itself. Every request is
// forwarded, via window.postMessage, to content.js (isolated world) →
// background.js (service worker), which is the only place a password
// prompt / signature ever actually happens (in the extension's popup).
//
// Also announces itself via EIP-6963 (the modern multi-wallet discovery
// standard most current dApp libraries — wagmi, RainbowKit — use instead
// of just clobbering window.ethereum), so Mango Wallet shows up correctly
// alongside other installed wallets rather than fighting over one global.

(function () {
  const REQUEST_TYPE = "MANGO_WALLET_REQUEST";
  const RESPONSE_TYPE = "MANGO_WALLET_RESPONSE";
  const EVENT_TYPE = "MANGO_WALLET_EVENT";

  let nextId = 1;
  const pending = new Map(); // id -> { resolve, reject }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || typeof data !== "object") return;

    if (data.type === RESPONSE_TYPE) {
      const waiter = pending.get(data.id);
      if (!waiter) return;
      pending.delete(data.id);
      if (data.error) waiter.reject(Object.assign(new Error(data.error.message || "Request rejected"), { code: data.error.code }));
      else waiter.resolve(data.result);
      return;
    }
    if (data.type === EVENT_TYPE) {
      if (data.chain === "evm") ethereumProvider._emit(data.event, data.payload);
      if (data.chain === "solana") solanaProvider._emit(data.event, data.payload);
    }
  });

  function sendRequest(chain, method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      window.postMessage({ type: REQUEST_TYPE, id, chain, method, params: params ?? [] }, "*");
    });
  }

  // Minimal EventEmitter — just what dApp code actually listens for
  // (accountsChanged / chainChanged / connect / disconnect), no external
  // dependency needed for that small a surface.
  class MiniEmitter {
    constructor() { this._listeners = {}; }
    on(event, fn) { (this._listeners[event] ??= []).push(fn); return this; }
    removeListener(event, fn) { this._listeners[event] = (this._listeners[event] ?? []).filter((f) => f !== fn); return this; }
    _emit(event, payload) { for (const fn of this._listeners[event] ?? []) { try { fn(payload); } catch { /* a dApp's own listener throwing shouldn't break the provider */ } } }
  }

  // ---------------------------------------------------------------------
  // EVM: window.ethereum — EIP-1193
  // ---------------------------------------------------------------------
  class MangoEthereumProvider extends MiniEmitter {
    constructor() {
      super();
      this.isMangoWallet = true;
      this.chainId = null;
      this.selectedAddress = null;
    }
    async request({ method, params }) {
      const result = await sendRequest("evm", method, params);
      if (method === "eth_requestAccounts" || method === "eth_accounts") {
        this.selectedAddress = result?.[0] ?? null;
      }
      if (method === "wallet_switchEthereumChain" && params?.[0]?.chainId) {
        this.chainId = params[0].chainId;
      }
      return result;
    }
    // Legacy aliases some older dApp code still calls directly.
    async enable() { return this.request({ method: "eth_requestAccounts" }); }
    async send(methodOrPayload, params) {
      if (typeof methodOrPayload === "string") return this.request({ method: methodOrPayload, params });
      return this.request({ method: methodOrPayload.method, params: methodOrPayload.params });
    }
    sendAsync(payload, callback) {
      this.request({ method: payload.method, params: payload.params })
        .then((result) => callback(null, { id: payload.id, jsonrpc: "2.0", result }))
        .catch((err) => callback(err));
    }
  }

  const ethereumProvider = new MangoEthereumProvider();
  if (!window.ethereum) {
    // Only claim the legacy global if nothing else already has — never
    // clobber an existing wallet extension's window.ethereum. EIP-6963
    // below is the real discovery path; this is just a fallback for the
    // (shrinking) set of dApps that still read window.ethereum directly.
    try {
      Object.defineProperty(window, "ethereum", { value: ethereumProvider, writable: false, configurable: true });
    } catch { /* some other extension already made it non-configurable — fine, EIP-6963 still works */ }
  }

  // EIP-6963: announce on load and on every future request from a dApp
  // library that just started listening (the standard's own handshake).
  // This script runs in the page's own "main world", which has no
  // chrome.* API access at all — the icon URL has to be handed over by
  // content.js (which does have chrome.runtime) via a data attribute on
  // the <script> tag that injected this file; see content.js's own
  // comment on why that's the one channel available for that handoff.
  const MANGO_UUID = "b6c0a6c4-9a4e-4b3d-8c0a-6f3a1c2d4e5f"; // fixed, arbitrary — stays stable across versions so a dApp doesn't see "two different wallets" on reload
  const iconUrl = document.currentScript?.dataset.iconUrl ?? "";
  function announceEip6963() {
    window.dispatchEvent(new CustomEvent("eip6963:announceProvider", {
      detail: Object.freeze({
        info: { uuid: MANGO_UUID, name: "Mango Wallet", icon: iconUrl, rdns: "app.mango.wallet" },
        provider: ethereumProvider,
      }),
    }));
  }
  window.addEventListener("eip6963:requestProvider", announceEip6963);
  announceEip6963();

  // ---------------------------------------------------------------------
  // Solana: window.solana — Phantom-compatible legacy surface (still the
  // widest-supported fallback across Solana dApps even as Wallet Standard
  // adoption grows).
  // ---------------------------------------------------------------------
  class MangoSolanaProvider extends MiniEmitter {
    constructor() {
      super();
      this.isMangoWallet = true;
      this.isPhantom = false; // deliberately false — never impersonate another wallet's brand check
      this.publicKey = null;
      this._connected = false;
    }
    get isConnected() { return this._connected; }
    async connect() {
      const address = await sendRequest("solana", "connect", []);
      this.publicKey = { toString: () => address, toBase58: () => address };
      this._connected = true;
      this._emit("connect", address);
      return { publicKey: this.publicKey };
    }
    async disconnect() {
      await sendRequest("solana", "disconnect", []);
      this.publicKey = null;
      this._connected = false;
      this._emit("disconnect", undefined);
    }
    async signTransaction(tx) {
      const serialized = tx.serialize ? tx.serialize({ requireAllSignatures: false }).toString("base64") : tx;
      const signed = await sendRequest("solana", "signTransaction", [serialized]);
      return signed; // base64 — caller (dApp's own @solana/web3.js) deserializes
    }
    async signAllTransactions(txs) {
      const out = [];
      for (const tx of txs) out.push(await this.signTransaction(tx));
      return out;
    }
    async signAndSendTransaction(tx) {
      const serialized = tx.serialize ? tx.serialize({ requireAllSignatures: false }).toString("base64") : tx;
      const signature = await sendRequest("solana", "signAndSendTransaction", [serialized]);
      return { signature };
    }
    async signMessage(message, display) {
      const encoded = message instanceof Uint8Array ? Array.from(message) : message;
      const signature = await sendRequest("solana", "signMessage", [encoded, display]);
      return { signature: new Uint8Array(signature), publicKey: this.publicKey };
    }
  }

  const solanaProvider = new MangoSolanaProvider();
  if (!window.solana) {
    try {
      Object.defineProperty(window, "mangoSolana", { value: solanaProvider, writable: false, configurable: true });
      // Only claim window.solana if nothing (Phantom etc.) already has —
      // same non-clobbering rule as window.ethereum above.
      Object.defineProperty(window, "solana", { value: solanaProvider, writable: false, configurable: true });
    } catch { /* another Solana wallet got there first */ }
  } else {
    try { Object.defineProperty(window, "mangoSolana", { value: solanaProvider, writable: false, configurable: true }); } catch { /* ignore */ }
  }
})();
