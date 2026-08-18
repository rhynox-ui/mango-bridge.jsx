// extension/build.mjs
//
// Bundles the popup only. background.js / content.js / inpage.js are
// plain, dependency-free JS (no npm imports) and ship straight from
// src/ — the fewer moving parts between "what's in this repo" and "what
// Chrome actually executes" for the pieces that inject a page provider
// or route signing requests, the easier those are to audit. popup.js is
// the one file that genuinely needs viem/@solana/web3.js/bip39/etc., so
// it's the only one bundled.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));

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
});

console.log("Built extension/popup.bundle.js");
