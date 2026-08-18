// extension/shims/buffer-shim.js
//
// esbuild (unlike Vite, which has vite-plugin-node-polyfills configured
// for the main site — see vite.config.js's own comment on this exact
// issue) doesn't provide Node's Buffer global automatically. @solana/
// web3.js and bs58 both expect it to exist. Injected as esbuild's
// `inject` option so it runs before any bundled module references
// `Buffer` — same real 'buffer' npm package the main site's polyfill
// plugin uses under the hood, not a partial reimplementation.
import { Buffer } from "buffer";
if (typeof globalThis.Buffer === "undefined") globalThis.Buffer = Buffer;
export { Buffer };
