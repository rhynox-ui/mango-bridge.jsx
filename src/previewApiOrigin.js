// src/previewApiOrigin.js
//
// Preview builds only. The app calls its backend at relative /api/*
// paths, which on mangoprotocol.site reach the mango-api Worker. A branch
// preview (*.pages.dev) has no /api of its own, so a preview build can set
// VITE_API_ORIGIN=https://mangoprotocol.site to send those calls to the
// live API instead — letting a branch be tested with real routes before
// it is merged. Unset (every production build), this does nothing.

const origin = import.meta.env.VITE_API_ORIGIN;

if (origin && typeof window !== "undefined" && window.location.origin !== origin) {
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    if (typeof input === "string" && input.startsWith("/api/")) return realFetch(`${origin}${input}`, init);
    return realFetch(input, init);
  };
}
