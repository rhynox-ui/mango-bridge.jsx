// extension/src/inpage.js
//
// Injected directly into the PAGE's own JS context (the "main world") by
// background.js, via chrome.scripting.registerContentScripts({ world:
// "MAIN", ... }) — this is the only file in the extension a dApp's own
// code ever talks to directly. It defines window.ethereum (EIP-1193, the
// same interface MetaMask/Coinbase Wallet expose) and window.mangoSolana +
// a Wallet Standard-ish window.solana surface (the interface Phantom/
// Solflare expose) — never touches key material itself. Every request is
// forwarded, via window.postMessage, to content.js (isolated world) →
// background.js (service worker), which is the only place a password
// prompt / signature ever actually happens (in the extension's popup).
//
// Registered programmatically (see background.js's own comment on this)
// rather than injected via a DOM-created <script src> tag, specifically
// so this keeps working on dApps with a strict page CSP — a script tag
// inserted into the page is subject to that page's script-src directive
// and gets silently blocked on any site that sets one, while a
// browser-injected "world": "MAIN" content script is not. Because
// there's no actual <script> element in the page's DOM for this,
// document.currentScript is unavailable here — see MANGO_ICON_PNG_BASE64
// below for why the EIP-6963 icon is a literal embedded value instead of
// something handed over from content.js.
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
      // wallet_addEthereumChain behaves exactly like a switch once the
      // approval succeeds for a chain Mango already recognizes (see
      // popup.js's own wallet_addEthereumChain handler) — this property
      // needs to track that the same way, or a dApp reading
      // provider.chainId directly right after resolution (rather than
      // waiting for the chainChanged event) would see the OLD chain.
      if ((method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") && params?.[0]?.chainId) {
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
  // The spec REQUIRES icon to be a data URI (RFC-2397), not a regular
  // URL — a chrome-extension://... URL (what this used to send, handed
  // over from content.js) is actually spec-non-compliant, separately
  // from the CSP injection issue above. Embedding it as a self-contained
  // base64 data URI also removes any need for a cross-world handoff.
  const MANGO_UUID = "b6c0a6c4-9a4e-4b3d-8c0a-6f3a1c2d4e5f"; // fixed, arbitrary — stays stable across versions so a dApp doesn't see "two different wallets" on reload
  // A real PNG (this extension's own icons/icon128.png, base64-embedded),
  // not an SVG data URI — the EIP-6963 spec technically allows SVG, but in
  // practice several major dApp wallet-connect UIs (confirmed against a
  // live Uniswap test after the SVG version rendered as a plain fallback
  // "M" initials avatar there) don't render inline SVG icons, likely a
  // deliberate XSS-surface precaution since an SVG can carry <script>/
  // event-handler content. PNG is what MetaMask/Rabby/Coinbase Wallet all
  // actually ship for this field, so this matches real, working precedent
  // instead of only the letter of the spec.
  const MANGO_ICON_PNG_BASE64 = "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";
  const iconUrl = "data:image/png;base64," + MANGO_ICON_PNG_BASE64;
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

  // ---------------------------------------------------------------------
  // Solana Wallet Standard — the modern discovery mechanism most current
  // Solana dApp libraries (@solana/wallet-adapter's Standard Wallet
  // Adapter, used by Jupiter, Raydium, and others) rely on instead of
  // checking window.solana directly. A dApp built with wallets={[]}
  // (Wallet-Standard-only discovery, the pattern the ecosystem has been
  // moving toward specifically to drop the legacy adapter bundle) never
  // sees a wallet that only does the legacy window.solana injection above
  // — this was a real, likely cause of "Solana connect doesn't work" on
  // such dApps, the direct Solana-side analog of the EIP-6963 gap already
  // fixed for EVM. Implements the exact real contract from the installed
  // @wallet-standard/base, @wallet-standard/wallet, @wallet-standard/
  // features, and @solana/wallet-standard-features packages (read
  // directly from node_modules, not guessed) — registerWallet()'s own
  // event-handshake code, the Wallet/WalletAccount interfaces, and each
  // feature's real input/output shapes.
  const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  // Verified against the real `bs58` package (already a project
  // dependency) across 7 addresses, including the all-zero-byte System
  // Program edge case (which a naive port of this algorithm gets wrong by
  // one byte) — this file can't `import bs58` itself, since it ships as
  // plain, dependency-free JS straight from src/ (see build.mjs's own
  // comment on why).
  function base58Decode(str) {
    const bytes = [0];
    for (let i = 0; i < str.length; i++) {
      const value = BASE58_ALPHABET.indexOf(str[i]);
      if (value === -1) throw new Error("Invalid base58 character: " + str[i]);
      let carry = value;
      for (let j = 0; j < bytes.length; j++) {
        carry += bytes[j] * 58;
        bytes[j] = carry & 0xff;
        carry >>= 8;
      }
      while (carry > 0) {
        bytes.push(carry & 0xff);
        carry >>= 8;
      }
    }
    for (let k = 0; str[k] === "1" && k < str.length - 1; k++) bytes.push(0); // off-by-one here silently corrupts the all-zero-byte address — see comment above
    return new Uint8Array(bytes.reverse());
  }
  function bytesToBase64(bytes) {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }
  function base64ToBytes(b64) {
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }

  const SOLANA_MAINNET_CHAIN = "solana:mainnet";
  const SUPPORTED_SOLANA_FEATURES = ["solana:signTransaction", "solana:signMessage", "solana:signAndSendTransaction"];

  function buildWalletAccount(address) {
    return {
      address,
      publicKey: base58Decode(address),
      chains: [SOLANA_MAINNET_CHAIN],
      features: SUPPORTED_SOLANA_FEATURES,
    };
  }

  const standardEventListeners = { change: [] };
  function emitStandardChange(properties) {
    for (const fn of standardEventListeners.change) {
      try { fn(properties); } catch { /* a dApp's own listener throwing shouldn't break the wallet */ }
    }
  }

  const mangoStandardWallet = {
    version: "1.0.0",
    name: "Mango Wallet",
    icon: iconUrl, // same base64 PNG data URI as the EIP-6963 announcement above — one real source, not a second icon
    get chains() { return [SOLANA_MAINNET_CHAIN]; },
    get accounts() {
      return solanaProvider._connected && solanaProvider.publicKey
        ? [buildWalletAccount(solanaProvider.publicKey.toBase58())]
        : [];
    },
    features: {
      "standard:connect": {
        version: "1.0.0",
        connect: async (input) => {
          if (input?.silent) {
            // Per spec: must not prompt, only return already-authorized
            // accounts. This provider has no separate "authorized but not
            // currently connected" persistence beyond the live page's own
            // state, so silent mode's honest answer is whatever's already
            // connected THIS page load, nothing invented beyond that.
            return { accounts: mangoStandardWallet.accounts };
          }
          const { publicKey } = await solanaProvider.connect(); // real approval popup — same path window.solana.connect() uses
          const account = buildWalletAccount(publicKey.toBase58());
          emitStandardChange({ accounts: [account] });
          return { accounts: [account] };
        },
      },
      "standard:disconnect": {
        version: "1.0.0",
        disconnect: async () => {
          await solanaProvider.disconnect();
          emitStandardChange({ accounts: [] });
        },
      },
      "standard:events": {
        version: "1.0.0",
        on: (event, listener) => {
          if (event !== "change") return () => {}; // "change" is the only event type the spec defines
          standardEventListeners.change.push(listener);
          return () => {
            standardEventListeners.change = standardEventListeners.change.filter((fn) => fn !== listener);
          };
        },
      },
      "solana:signTransaction": {
        version: "1.0.0",
        supportedTransactionVersions: ["legacy", 0],
        signTransaction: async (...inputs) => {
          const outputs = [];
          for (const input of inputs) {
            const base64Tx = bytesToBase64(input.transaction);
            const signedBase64 = await solanaProvider.signTransaction(base64Tx);
            outputs.push({ signedTransaction: base64ToBytes(signedBase64) });
          }
          return outputs;
        },
      },
      "solana:signMessage": {
        version: "1.1.0",
        signMessage: async (...inputs) => {
          const outputs = [];
          for (const input of inputs) {
            const { signature } = await solanaProvider.signMessage(input.message);
            outputs.push({ signedMessage: input.message, signature, signatureType: "ed25519" });
          }
          return outputs;
        },
      },
      "solana:signAndSendTransaction": {
        version: "1.0.0",
        supportedTransactionVersions: ["legacy", 0],
        signAndSendTransaction: async (...inputs) => {
          const outputs = [];
          for (const input of inputs) {
            const base64Tx = bytesToBase64(input.transaction);
            const { signature: base58Signature } = await solanaProvider.signAndSendTransaction(base64Tx);
            outputs.push({ signature: base58Decode(base58Signature) });
          }
          return outputs;
        },
      },
    },
  };

  // The exact registerWallet() handshake from @wallet-standard/wallet's
  // own source: dispatch wallet-standard:register-wallet so an
  // already-loaded app can register immediately, AND listen for
  // wallet-standard:app-ready so an app that loads AFTER this script
  // still discovers it — order-independent either way.
  function registerStandardWallet(wallet) {
    const callback = ({ register }) => register(wallet);
    try {
      window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: callback }));
    } catch { /* ignore — a dApp that hasn't loaded this event system yet just won't see it this way */ }
    try {
      window.addEventListener("wallet-standard:app-ready", (event) => callback(event.detail));
    } catch { /* ignore */ }
  }
  registerStandardWallet(mangoStandardWallet);
})();
