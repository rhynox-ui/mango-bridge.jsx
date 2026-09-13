// extension/tailwind.config.js
//
// A separate, minimal Tailwind config for the popup's compiled CSS
// (extension/popup.css, built by build.mjs) — scoped to just the files
// the popup actually renders (MangoWallet.jsx + chainBadges.jsx), rather
// than the root tailwind.config.js's full-site content glob. Same
// Tailwind version, same JIT engine, so any utility class MangoWallet.jsx
// uses compiles identically here as it does for the main site — this
// only trims which SOURCE FILES get scanned for class names, not how
// any given class is generated.
export default {
  content: ["../src/MangoWallet.jsx", "../src/chainBadges.jsx"],
  theme: { extend: {} },
  plugins: [],
};
