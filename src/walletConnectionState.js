// src/walletConnectionState.js
//
// AppKit is the source of truth for the EVM connection modal, while wagmi
// remains the source of truth for signing/actions. This tiny external store
// gives UI code a stable connection signal without starting a connection,
// reconnecting, or touching wallet permissions on its own.

let state = {isConnected: false, address: undefined};
const listeners = new Set();

export function setEvmWalletConnection(next) {
  const isConnected = !!next?.isConnected && !!next?.address;
  const address = isConnected ? next.address : undefined;
  if (state.isConnected === isConnected && state.address === address) return;
  state = {isConnected, address};
  listeners.forEach(listener => listener());
}

export function getEvmWalletConnection() {
  return state;
}

export function subscribeEvmWalletConnection(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
