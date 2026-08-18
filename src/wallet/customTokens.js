// src/wallet/customTokens.js
//
// User-added custom tokens — the "paste a contract address" import OKX
// Wallet and every other serious wallet offers, for tokens this project
// hasn't independently verified (most meme coins never will be). Kept
// entirely separate from walletTokens.js/walletSplTokens.js's own
// verified lists: those stay the trusted default set, this is an
// explicit, user-initiated opt-in per token, clearly a different trust
// tier in the UI.
//
// Genuinely portable (localStorage only) so both the site and the
// extension can import this exact file, same pattern as
// customNetworks.js/chainRegistry.js.

const STORAGE_KEY = "mango_wallet_custom_tokens";

function load() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function save(all) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // storage unavailable — the token just won't persist, nothing else breaks
  }
}

function tokenKey(chainKey, token) {
  return (chainKey === "solana" ? token.mint : token.address).toLowerCase();
}

export function loadCustomTokens(chainKey) {
  return load()[chainKey] || [];
}

/** token: {symbol, decimals, address} for EVM chains, {symbol, decimals, mint} for solana. */
export function addCustomToken(chainKey, token) {
  const all = load();
  const list = all[chainKey] || [];
  const key = tokenKey(chainKey, token);
  if (list.some((t) => tokenKey(chainKey, t) === key)) {
    throw new Error("That token is already added.");
  }
  const next = [...list, token];
  all[chainKey] = next;
  save(all);
  return next;
}

export function removeCustomToken(chainKey, identifier) {
  const all = load();
  const next = (all[chainKey] || []).filter((t) => tokenKey(chainKey, t) !== identifier.toLowerCase());
  all[chainKey] = next;
  save(all);
  return next;
}
