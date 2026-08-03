import { CHAIN_KEY_TO_WAGMI_TESTNET, CHAIN_KEY_TO_WAGMI_MAINNET } from "./wagmi.js";

// This app now runs mainnet-only, permanently. The testnet/mainnet toggle
// that used to live here has been removed by deliberate choice — there is
// only one mode, so there's nothing to switch between and nothing to label.
// The testnet chain maps and bridge-module code paths are left in place
// (unused) rather than deleted, in case testnet development is needed again
// later — but nothing in the running app can reach them.

export function getNetworkMode() {
  return "mainnet";
}
export function isMainnet() {
  return true;
}
export function getChainKeyMap() {
  return CHAIN_KEY_TO_WAGMI_MAINNET;
}
export function getWagmiChain(chainKey) {
  const chain = CHAIN_KEY_TO_WAGMI_MAINNET[chainKey];
  if (!chain) throw new Error(`No mainnet chain configured for key "${chainKey}"`);
  return chain;
}
