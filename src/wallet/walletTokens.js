// src/wallet/walletTokens.js
//
// Which ERC-20 tokens Mango Wallet can show a balance for / send, per
// chain. Deliberately just a thin re-export of chainData.js's own
// TOKEN_ADDRESSES/ASSET_ONCHAIN_DECIMALS — the same, already-verified
// source of truth the Bridge tab uses (see chainData.js's own comment:
// every address there is independently confirmed, never guessed). No new
// token addresses are introduced here; a chain only gets token support in
// the wallet once it has one there too.

import { TOKEN_ADDRESSES, ASSET_ONCHAIN_DECIMALS } from "../chainData.js";

/** Every {symbol, address, decimals} with a real, verified contract address on this chain. */
export function tokensForWalletChain(chainKey) {
  return Object.entries(TOKEN_ADDRESSES)
    .filter(([, byChain]) => byChain[chainKey])
    .map(([symbol, byChain]) => ({ symbol, address: byChain[chainKey], decimals: ASSET_ONCHAIN_DECIMALS[symbol] }));
}
