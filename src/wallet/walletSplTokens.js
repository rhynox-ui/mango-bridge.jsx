// src/wallet/walletSplTokens.js
//
// Which SPL tokens Mango Wallet can show a balance for / send, on
// Solana — the direct counterpart to walletTokens.js's ERC-20 list.
// Mint addresses cross-checked against Solana Labs' own official token
// list (solana-labs/token-list on GitHub, fetched via
// raw.githubusercontent.com), not guessed or taken from memory alone.
export const SPL_TOKENS = [
  { symbol: "USDC", mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6 },
  { symbol: "USDT", mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", decimals: 6 },
];
