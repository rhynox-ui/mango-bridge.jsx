// src/MangoLogo.jsx
//
// Pulled out of App.jsx into its own file specifically so MangoWallet.jsx
// (bundled standalone into the browser extension's popup — see that
// file's own header comment) can use the real brand mark without ever
// importing App.jsx itself. App.jsx pulls in wagmi/Reown AppKit/viem and
// Vite-only import.meta.env reads that have no business in the extension
// bundle; a plain SVG component has none of that, so this file is safe
// for both the site and the extension to import directly.

export function MangoLogo({ size = 36, color = "#0A0A0B" }) {
  return (
    <svg width={size} height={size * 0.86} viewBox="0 0 70 60" className="shrink-0">
      <path
        d="M27 4c1.5-2 4-3.5 6-3.5-.3 3-2.3 5.8-5.3 7-1-1-1.2-2.3-0.7-3.5Z"
        fill={color}
      />
      <path
        d="M29 6c6-2 13 0.5 16 6.5-5.5 3-13 1.5-16.5-3-0.4-1.3-0.2-2.5 0.5-3.5Z"
        fill={color}
      />
      <path
        d="M35 12c11 0 20 10.5 20 24s-10 24-20 24-20-10.5-20-24 9-24 20-24Z"
        fill={color}
      />
      <path
        d="M35 12c2.5 0 4.8 0.4 6.9 1.2-7.7 2.6-13.4 11.6-13.4 22.3s5.7 19.7 13.4 22.3c-2.1 0.8-4.4 1.2-6.9 1.2-11 0-20-10.5-20-24s9-24 20-24Z"
        fill="#FFFFFF"
        opacity="0.16"
      />
    </svg>
  );
}
