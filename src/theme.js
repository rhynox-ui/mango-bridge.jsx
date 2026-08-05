// Shared design tokens and small helpers used by both App.jsx and
// Launchpad.jsx. Deliberately its own file with zero dependencies on either
// of them — App.jsx importing from Launchpad.jsx while Launchpad.jsx
// imports back from App.jsx would be a circular import, and since ES module
// imports are hoisted above a file's own code, that's exactly the kind of
// setup that can reproduce a "used before initialization" error — the same
// bug class that caused a real production crash earlier in this project.

export const LIME = "#FF9A2E";
export const LIME_DEEP = "#E8801A";

export const PALETTE = {
  light: {
    bg: "#FFFFFF", panel: "#F6F6F7", panelBorder: "#E6E6E8", input: "#FBFBFB", pillBg: "#EFEFF0",
    textPrimary: "#0A0A0B", textSecondary: "#6B6B70", textMuted: "#A6A6AC",
    divider: "#EDEDEF", ctaBg: "#0A0A0B", ctaText: "#FFFFFF",
    ctaDisabledBg: "#EDEDEF", ctaDisabledText: "#B8B8BC", navActive: "#0A0A0B", navActiveText: "#FFFFFF",
  },
  dark: {
    bg: "#0A0A0B", panel: "#151517", panelBorder: "#232326", input: "#0E0E10", pillBg: "#1F1F22",
    textPrimary: "#F5F5F6", textSecondary: "#9A9AA0", textMuted: "#57575D",
    divider: "#1D1D20", ctaBg: "#F5F5F6", ctaText: "#0A0A0B",
    ctaDisabledBg: "#1D1D20", ctaDisabledText: "#57575D", navActive: "#F5F5F6", navActiveText: "#0A0A0B",
  },
};

export function fmt(n, d = 2) {
  return (Number.isFinite(n) ? n : 0).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
}
export function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
