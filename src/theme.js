// Shared design tokens and small helpers used by both App.jsx and
// Launchpad.jsx. Deliberately its own file with zero dependencies on either
// of them — App.jsx importing from Launchpad.jsx while Launchpad.jsx
// imports back from App.jsx would be a circular import, and since ES module
// imports are hoisted above a file's own code, that's exactly the kind of
// setup that can reproduce a "used before initialization" error — the same
// bug class that caused a real production crash earlier in this project.

// Mango's brand is genuinely black-and-white, not the orange this
// constant held despite its own name (live-reported: the swap confirm
// screen — and every other LIME-colored surface, CTA buttons, success
// checkmarks, "in progress" labels — rendered orange, which never
// looked like "Mango"). Explicitly monochrome per direct instruction:
// "let's use only dark and light color."
//
// LIME/LIME_DEEP now specifically mean "the light accent for a surface
// that's ALWAYS dark regardless of the app's own light/dark toggle" —
// App.jsx's BridgeModal (the confirm/progress/done/error transaction
// modal), its WithdrawalRow/track-by-hash panel, and StatusPill are
// all genuinely fixed-dark chrome (hardcoded #12151B/#14171D/etc
// backgrounds, no P prop at all), so a flat near-white reads correctly
// there with zero theme-awareness needed — this is NOT the general
// brand accent for the rest of the app.
//
// Everywhere else — anything rendered on a theme-aware P.panel/P.bg
// background, which really can be near-white in light mode — uses
// P.ctaBg directly instead (already black in light mode, white in
// dark mode; the exact same "dark and light only" rule, just applied
// per-theme instead of as one flat hex, since a single flat tone can't
// have real contrast against both a light AND a dark ground). Never
// reuse LIME/LIME_DEEP on a P-aware surface — see call sites already
// converted to P.ctaBg in App.jsx/MangoWallet.jsx/Launchpad.jsx/
// AdminReferralsPage.jsx for the pattern.
export const LIME = "#F5F5F6";
export const LIME_DEEP = "#D8D8DB";

// Real, standard financial semantic color — price-change/buy-vs-sell/
// low-concentration-risk indicators in Launchpad.jsx, paired with the
// existing flat loss/sell/high-risk red (#D92D20) already used the
// same theme-independent way there. Deliberately kept as a real green,
// NOT folded into the "dark and light only" brand-accent rule above:
// that instruction was about Mango's own brand identity (buttons,
// checkmarks, CTAs), not about the gain/loss color convention every
// trading UI relies on — removing green-for-gain/red-for-loss would be
// a real usability regression, not a brand fix. Same "a saturated hue
// has real contrast against both a light and dark ground" reasoning
// as the red it's paired with already relies on, so no P-aware
// variant is needed here either.
export const GAIN = "#00D67D";
export const GAIN_DEEP = "#00A863";

export const PALETTE = {
  light: {
    bg: "#FFFFFF", panel: "#F6F6F7", panelBorder: "#E6E6E8", input: "#FBFBFB", pillBg: "#EFEFF0",
    textPrimary: "#0A0A0B", textSecondary: "#6B6B70", textMuted: "#A6A6AC",
    divider: "#EDEDEF", ctaBg: "#0A0A0B", ctaText: "#FFFFFF",
    ctaDisabledBg: "#EDEDEF", ctaDisabledText: "#B8B8BC", navActive: "#0A0A0B", navActiveText: "#FFFFFF",
    // Real, theme-aware semantic tokens — added so BridgeModal (the
    // Swap/Bridge confirm-progress-done-error modal) could become
    // genuinely light/dark aware instead of permanently dark. A flat
    // dark-mode red/amber tint (e.g. #2A1414 background, #E5726B text)
    // reads as muddy/wrong on a white card, so these need their own
    // real per-theme pastel/deep pairing, not just an alpha-blended
    // version of one flat hex the way GAIN/loss above gets away with.
    dangerBg: "#FEF2F2", dangerBorder: "#FCA5A5", dangerText: "#B91C1C",
    warningBg: "#FFFBEB", warningBorder: "#FDE68A", warningText: "#92400E",
  },
  dark: {
    bg: "#0A0A0B", panel: "#151517", panelBorder: "#232326", input: "#0E0E10", pillBg: "#1F1F22",
    textPrimary: "#F5F5F6", textSecondary: "#9A9AA0", textMuted: "#57575D",
    divider: "#1D1D20", ctaBg: "#F5F5F6", ctaText: "#0A0A0B",
    ctaDisabledBg: "#1D1D20", ctaDisabledText: "#57575D", navActive: "#F5F5F6", navActiveText: "#0A0A0B",
    dangerBg: "#2A1414", dangerBorder: "#4A1E1E", dangerText: "#E5726B",
    warningBg: "#3D2E0F", warningBorder: "#6B4E12", warningText: "#F0B84D",
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
