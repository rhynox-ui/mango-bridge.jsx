# Mango Wallet — browser extension

A Manifest V3 extension that injects a real EIP-1193 provider
(`window.ethereum`) and a Phantom-compatible Solana provider
(`window.solana`, plus `window.mangoSolana`) into every page, so any dApp
can connect to Mango Wallet the same way it would connect to MetaMask or
Phantom. Also announces itself via [EIP-6963](https://eips.ethereum.org/EIPS/eip-6963),
the modern multi-wallet discovery standard most current dApp libraries
(wagmi, RainbowKit) use.

## This is a separate wallet from the website's

The main site (`mangoprotocol.site`) keeps its own wallet vault in that
origin's `localStorage`. A browser extension runs at its own
`chrome-extension://<id>` origin, which cannot read another origin's
`localStorage` — that's the web platform's own security boundary, not a
limitation specific to this project (MetaMask's extension vault has never
been the same storage as any website's local data either). The popup's
"I already have a recovery phrase" option is how the same seed ends up in
both places, exactly like importing a MetaMask seed into a second device.

## Architecture

```
dApp page (window.ethereum / window.solana)
        │  window.postMessage
inpage.js (injected into the page's own JS context — "main world")
        │  window.postMessage
content.js (isolated-world content script — one per tab, no key material)
        │  chrome.runtime messages
background.js (MV3 service worker — routes requests, tracks connected
                sites, has no DOM so it can't touch the vault itself)
        │  chrome.windows.create(popup.html?requestId=...)
popup.js (the ONLY place a password is entered or a key briefly decrypted)
```

Every request that isn't a cached read (`eth_chainId`, `eth_accounts` for
an already-connected site) opens a real approval popup. There is no
"stay unlocked in the background" state — the popup asks for the wallet
password fresh every time, the same principle the main site's Wallet tab
already follows for adding an account or revealing a key.

`background.js`, `content.js`, and `inpage.js` are plain, dependency-free
JavaScript and ship straight from `src/` with no build step — deliberately,
since those are the pieces that inject a page provider or route signing
requests, and keeping them free of a bundler's output makes them easier to
read start to finish. `popup.js` is the one file that needs real
dependencies (viem, `@solana/web3.js`, `bip39`, `bs58`, `tweetnacl`, and
this project's own `src/wallet/keys.js` / `vault.js`), so it's the only
one bundled — see `build.mjs`.

## Scope of this first version

Deliberately single-wallet, single-account (index 0) — the main site's
Wallet tab already has the full multi-wallet/multi-account UI (see
`src/MangoWallet.jsx`); this popup's job is dApp connectivity, kept small
enough to fit a 360×480 popup without duplicating that whole surface here
too. EVM methods supported: `eth_requestAccounts`, `eth_accounts`,
`eth_chainId`, `wallet_switchEthereumChain`, `eth_sendTransaction`,
`personal_sign`, `eth_signTypedData_v4`. Solana methods supported:
`connect`, `disconnect`, `signTransaction`, `signAllTransactions`,
`signAndSendTransaction`, `signMessage`.

**Known limitation, stated plainly:** MV3 service workers can be torn
down by the browser after ~30s idle. A pending approval's in-memory
`sendResponse` callback does not survive that — if it happens mid-
approval, the dApp's request hangs until it times out on its own end
rather than getting a clean rejection. Shared by most MV3 wallet
extensions' simplest implementations; not hidden here.

## Building

```
node extension/build.mjs
```

Bundles `src/popup.js` → `popup.bundle.js` via esbuild (see that file's
own comment for why a Buffer polyfill is injected — the same real issue
`vite.config.js` already documents for the main site's own Vite build).

## Loading it in Chrome

1. Run the build command above.
2. `chrome://extensions` → enable **Developer mode** → **Load unpacked**
   → select this `extension/` directory.
3. Click the toolbar icon to create or import a wallet.

## Distributing it

```
node extension/package.mjs
```

Builds the popup bundle, then zips this directory into
`public/mango-wallet-extension.zip` — the file the main site's Wallet tab
links to from its own "Get the browser extension" button (see
`ExtensionModal` in `src/MangoWallet.jsx`). This is the real distribution
path until the extension goes through the Chrome Web Store's manual
review process; the in-app modal is upfront about that rather than
implying a one-click store install that doesn't exist yet.

## Icons

`icons/icon{16,32,48,128}.png` are generated from the repo's own
`logo.png` (512×512) — not separately designed assets.
