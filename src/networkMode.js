import { CHAIN_KEY_TO_WAGMI_TESTNET, CHAIN_KEY_TO_WAGMI_MAINNET } from "./wagmi.js";

// Single source of truth for which network this app is currently pointed at.
// Deliberately NOT stored only in React state — bridge modules (cctp.js,
// arbbridge.js, wormholebridge.js, opbridge.js) need to read this outside of
// any component, so it lives here as a small standalone module with a
// subscriber list, and the UI layer (App.jsx) mirrors it into React state.
//
// Defaults to testnet on every load, on purpose — mainnet is opt-in per
// session, never persisted as "on" automatically, so a stale localStorage
// value can never silently put someone in mainnet mode.

let mode = "testnet";
const listeners = new Set();

export function getNetworkMode() {
  return mode;
}

export function setNetworkMode(next) {
  if (next !== "testnet" && next !== "mainnet") throw new Error(`Invalid network mode: ${next}`);
  mode = next;
  listeners.forEach((fn) => fn(mode));
}

export function onNetworkModeChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function isMainnet() {
  return mode === "mainnet";
}

export function getChainKeyMap() {
  return mode === "mainnet" ? CHAIN_KEY_TO_WAGMI_MAINNET : CHAIN_KEY_TO_WAGMI_TESTNET;
}

export function getWagmiChain(chainKey) {
  const map = getChainKeyMap();
  const chain = map[chainKey];
  if (!chain) throw new Error(`No ${mode} chain configured for key "${chainKey}"`);
  return chain;
}
