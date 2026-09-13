import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";

export default defineConfig({
  // nodePolyfills fixes a real, confirmed "Buffer is not defined" error
  // hit during actual Solana transaction execution tonight —
  // @solana/web3.js expects Node's Buffer global, which Vite doesn't
  // provide automatically. Explicitly listing 'buffer' (rather than
  // polyfilling everything) keeps this scoped to the actual, confirmed
  // need.
  plugins: [react(), nodePolyfills({ include: ["buffer"] })],
  build: {
    sourcemap: true,
  },
});
