// src/wallet/customNetworks.js
//
// User-added custom EVM networks (MetaMask/OKX's "Add network" — a chain
// ID, an RPC URL, a name, a currency symbol, typed in by the user rather
// than one of this project's own independently-verified chains). Genuinely
// portable — just localStorage + viem's defineChain, no import.meta.env,
// no Vite-only imports — so both src/wallet/walletRpc.js (the site) and
// extension/src/rpc.js (the extension) can import this exact file, same
// pattern as chainRegistry.js.
//
// A custom network is inherently less trustworthy than this project's own
// chain list: the RPC URL is whatever the user typed, with no fallback
// endpoint and no independent verification. That's an accepted, honest
// trade-off — the whole point of this feature is letting a user point the
// wallet at a chain Mango hasn't reviewed.

import { defineChain } from "viem";

const STORAGE_KEY = "mango_wallet_custom_networks";

function load() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function save(list) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // storage unavailable — the network just won't persist, nothing else breaks
  }
}

export function loadCustomNetworks() {
  return load();
}

export function customNetworkChainKey(chainId) {
  return `custom-${chainId}`;
}

/** Throws with a real, user-facing reason if the network can't be added. */
export function addCustomNetwork({ name, rpcUrl, chainId, symbol }) {
  const trimmedName = (name || "").trim();
  const trimmedRpc = (rpcUrl || "").trim();
  const trimmedSymbol = (symbol || "").trim().toUpperCase();
  const idNumber = Number(chainId);

  if (!trimmedName) throw new Error("Network name is required.");
  if (!/^https?:\/\//i.test(trimmedRpc)) throw new Error("RPC URL must start with http:// or https://.");
  if (!Number.isInteger(idNumber) || idNumber <= 0) throw new Error("Chain ID must be a positive whole number.");
  if (!trimmedSymbol) throw new Error("Currency symbol is required.");

  const list = load();
  if (list.some((n) => n.chainId === idNumber)) {
    throw new Error(`Chain ID ${idNumber} is already added.`);
  }

  const entry = { chainKey: customNetworkChainKey(idNumber), chainId: idNumber, name: trimmedName, rpcUrl: trimmedRpc, symbol: trimmedSymbol };
  save([...list, entry]);
  return entry;
}

export function removeCustomNetwork(chainKey) {
  save(load().filter((n) => n.chainKey !== chainKey));
}

export function viemChainForCustomNetwork(net) {
  return defineChain({
    id: net.chainId,
    name: net.name,
    nativeCurrency: { name: net.symbol, symbol: net.symbol, decimals: 18 },
    rpcUrls: { default: { http: [net.rpcUrl] } },
    testnet: false,
  });
}
