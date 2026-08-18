// extension/src/rpc.js
//
// Balance-reading RPC path for the extension popup — the same logic as
// src/wallet/walletRpc.js (the main site's own independent wallet RPC
// path), reimplemented here rather than imported directly because
// walletRpc.js pulls in src/wagmi.js (Vite-only `import.meta.env` +
// Reown AppKit's real runtime side effects) and src/solanaRpc.js (same
// `import.meta.env` issue) — neither resolves under esbuild's plain
// browser bundle. This uses the same real, verified RPC endpoints
// (../../src/wallet/chainRegistry.js for EVM, ./chains.js for Solana —
// both genuinely Vite-independent) and the same caching/fallback
// approach, just without those two Vite-only imports.

import { createPublicClient, createWalletClient, http, fallback } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddress, getAccount } from "@solana/spl-token";
import { RPC_FALLBACKS, CHAIN_KEY_TO_WAGMI_MAINNET } from "../../src/wallet/chainRegistry.js";
import { WALLET_ONLY_EVM_CHAINS, WALLET_ONLY_RPC_FALLBACK } from "../../src/wallet/walletChains.js";
import { SOLANA_RPC_ENDPOINTS } from "./chains.js";

const ERC20_BALANCE_ABI = [
  { type: "function", name: "balanceOf", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
];

const ALL_WALLET_CHAINS = { ...CHAIN_KEY_TO_WAGMI_MAINNET, ...WALLET_ONLY_EVM_CHAINS };

function extraFallbackUrl(chainId) {
  return WALLET_ONLY_RPC_FALLBACK[chainId] || null;
}

const clientCache = new Map();

const BALANCE_CACHE_TTL_MS = 15_000;
const balanceCache = new Map();
function getCached(key) {
  const entry = balanceCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt >= BALANCE_CACHE_TTL_MS) return null;
  return entry.data;
}
function setCached(key, data) {
  balanceCache.set(key, { data, fetchedAt: Date.now() });
}

export function getWalletChain(chainKey) {
  const chain = ALL_WALLET_CHAINS[chainKey];
  if (!chain) throw new Error(`No mainnet chain configured for key "${chainKey}"`);
  return chain;
}

function getWalletTransport(chain) {
  const bridgeUrls = (RPC_FALLBACKS[chain.id] || []).filter(Boolean);
  if (bridgeUrls.length > 0) return fallback(bridgeUrls.map((url) => http(url)), { rank: true });
  const extraUrl = extraFallbackUrl(chain.id);
  if (extraUrl) return fallback([http(), http(extraUrl)], { rank: true });
  return http();
}

export function getWalletPublicClient(chainKey) {
  if (clientCache.has(chainKey)) return clientCache.get(chainKey);
  const chain = getWalletChain(chainKey);
  const client = createPublicClient({ chain, transport: getWalletTransport(chain) });
  clientCache.set(chainKey, client);
  return client;
}

export function getWalletClientFor(chainKey, privateKeyHex) {
  const chain = getWalletChain(chainKey);
  const account = privateKeyToAccount(privateKeyHex);
  return createWalletClient({ account, chain, transport: getWalletTransport(chain) });
}

/** Single-endpoint, deliberately not wrapped in fallback-and-retry — see signing.js's own comment on why a signed broadcast is never retried across transports. */
export function getWalletSolanaConnection() {
  return new Connection(SOLANA_RPC_ENDPOINTS[0], "confirmed");
}

export async function fetchWalletNativeBalance(chainKey, address, { forceFresh = false } = {}) {
  const key = `evm:${chainKey}:${address}`;
  if (!forceFresh) {
    const cached = getCached(key);
    if (cached !== null) return cached;
  }
  const client = getWalletPublicClient(chainKey);
  const wei = await client.getBalance({ address });
  const balance = Number(wei) / 1e18;
  setCached(key, balance);
  return balance;
}

export async function fetchWalletTokenBalance(chainKey, tokenAddress, decimals, address, { forceFresh = false } = {}) {
  const key = `evm-token:${chainKey}:${tokenAddress}:${address}`;
  if (!forceFresh) {
    const cached = getCached(key);
    if (cached !== null) return cached;
  }
  const client = getWalletPublicClient(chainKey);
  const raw = await client.readContract({ address: tokenAddress, abi: ERC20_BALANCE_ABI, functionName: "balanceOf", args: [address] });
  const balance = Number(raw) / 10 ** decimals;
  setCached(key, balance);
  return balance;
}

export async function fetchWalletSolanaBalance(address, { forceFresh = false } = {}) {
  const key = `solana:${address}`;
  if (!forceFresh) {
    const cached = getCached(key);
    if (cached !== null) return cached;
  }
  let lastError;
  for (const url of SOLANA_RPC_ENDPOINTS) {
    try {
      const connection = new Connection(url, "confirmed");
      const lamports = await connection.getBalance(new PublicKey(address));
      const balance = lamports / 1e9;
      setCached(key, balance);
      return balance;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

/** Zero is a real, common answer — see walletRpc.js's own version of this comment on why a missing ATA is treated as balance 0, not an error. */
export async function fetchWalletSplTokenBalance(mintAddress, decimals, ownerAddress, { forceFresh = false } = {}) {
  const key = `solana-token:${mintAddress}:${ownerAddress}`;
  if (!forceFresh) {
    const cached = getCached(key);
    if (cached !== null) return cached;
  }
  let lastError;
  for (const url of SOLANA_RPC_ENDPOINTS) {
    try {
      const connection = new Connection(url, "confirmed");
      const ata = await getAssociatedTokenAddress(new PublicKey(mintAddress), new PublicKey(ownerAddress));
      let balance;
      try {
        const account = await getAccount(connection, ata);
        balance = Number(account.amount) / 10 ** decimals;
      } catch {
        balance = 0;
      }
      setCached(key, balance);
      return balance;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}
