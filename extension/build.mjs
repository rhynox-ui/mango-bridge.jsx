// extension/build.mjs
//
// Bundles the popup and compiles its Tailwind CSS. background.js /
// content.js / inpage.js are plain, dependency-free JS (no npm imports)
// and ship straight from src/ — the fewer moving parts between "what's
// in this repo" and "what Chrome actually executes" for the pieces that
// inject a page provider or route signing requests, the easier those are
// to audit. popup.js is the one file that genuinely needs React, viem,
// @solana/web3.js, bip39/etc. — and, for its full-wallet-app path, the
// ACTUAL src/MangoWallet.jsx component the main site renders, not a
// reimplementation — so it's the only one bundled.
//
// MangoWallet.jsx (and, through it, src/wallet/sendTransaction.js) import
// src/wallet/walletRpc.js, which pulls in src/wagmi.js's Vite-only
// `import.meta.env` read and Reown AppKit's real runtime side effects
// (creating a WalletConnect modal singleton) — neither belongs in a
// browser-extension popup. The onResolve plugin below redirects every
// import that resolves to that exact file over to extension/src/rpc.js
// instead, which exports the identical function signatures using
// genuinely portable chain data (src/wallet/chainRegistry.js) — so
// MangoWallet.jsx runs completely unmodified.
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const walletRpcPath = path.join(dir, "..", "src", "wallet", "walletRpc.js");
const rpcShimPath = path.join(dir, "src", "rpc.js");

const redirectWalletRpc = {
  name: "redirect-wallet-rpc",
  setup(buildApi) {
    buildApi.onResolve({ filter: /walletRpc\.js$/ }, (args) => {
      const resolved = path.resolve(args.resolveDir, args.path);
      if (resolved === walletRpcPath) return { path: rpcShimPath };
      return null;
    });
  },
};

await build({
  entryPoints: [path.join(dir, "src/popup.js")],
  outfile: path.join(dir, "popup.bundle.js"),
  bundle: true,
  format: "esm",
  target: "chrome110",
  platform: "browser",
  sourcemap: true,
  inject: [path.join(dir, "shims/buffer-shim.js")],
  define: { "global": "globalThis" },
  plugins: [redirectWalletRpc],
  // .png as a data URI so the shared MangoWallet.jsx can `import` its
  // onboarding artwork and have it work in BOTH bundlers: Vite resolves
  // the same import to a hashed /assets URL for the site, esbuild inlines
  // it here. A relative "assets/..." string would have had to resolve
  // differently in each, which is how one of the two ends up with a
  // broken image nobody notices until it ships.
  loader: { ".jsx": "jsx", ".png": "dataurl" },
  jsx: "automatic",
});
console.log("Built extension/popup.bundle.js");

execFileSync(
  process.execPath,
  [path.join(dir, "..", "node_modules", ".bin", "tailwindcss"), "-i", "./tailwind-input.css", "-o", "./popup.css", "--config", "./tailwind.config.js", "--minify"],
  { cwd: dir, stdio: "inherit" }
);
console.log("Built extension/popup.css");
