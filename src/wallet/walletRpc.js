// src/wallet/walletRpc.js
//
// Independent RPC path for Mango Wallet's own balance reads — deliberately
// NOT routed through wagmi's shared Config/React Query client, which is
// what the Bridge tab's connected-wallet calls (useBalance, getBalance,
// readContracts in multiAssetBalances.js) all use. Wallet balance polling
// covers 13 EVM chains at once every time the tab renders; if that shared
// the exact same RPC endpoints as a live bridge transaction in progress,
// the two could contend for the same provider's rate limit right when the
// bridge needs it most.
//
// Both features already have a verified, two-endpoint fallback list per
// chain (wagmi.js's RPC_FALLBACKS — every URL there is independently
// sourced from each chain's own docs or a chain registry, not guessed).
// This reuses those exact endpoints rather than introducing unverified new
// ones, but reverses which endpoint each feature tries FIRST, and builds a
// genuinely separate viem client per chain (its own connection, its own
// cache) — so a burst of wallet reads and a burst of bridge activity don't
// both open with the same provider at the same moment. The wallet-only
// chains (Polygon, Optimism, etc. — see walletChains.js) have their own
// separately-sourced second endpoint (WALLET_ONLY_RPC_FALLBACK), pulled
// from ethereum-lists/chains rather than guessed.

import { createPublicClient, http, fallback } from "viem";
import { RPC_FALLBACKS, CHAIN_KEY_TO_WAGMI_MAINNET } from "../wagmi.js";
import { solanaRpcUrls } from "../solanaRpc.js";
import { WALLET_ONLY_EVM_CHAINS, WALLET_ONLY_RPC_FALLBACK } from "./walletChains.js";
import { loadCustomNetworks, viemChainForCustomNetwork } from "./customNetworks.js";

const ERC20_BALANCE_ABI = [
  { type: "function", name: "balanceOf", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
];
const ERC20_METADATA_ABI = [
  { type: "function", name: "symbol", inputs: [], outputs: [{ type: "string" }], stateMutability: "view" },
  { type: "function", name: "decimals", inputs: [], outputs: [{ type: "uint8" }], stateMutability: "view" },
];

// Wallet-visible EVM chains = every chain the Bridge already knows about,
// PLUS the wallet-only additions in walletChains.js (Polygon, Optimism,
// etc.) that the Bridge doesn't yet support routing/fees for.
const ALL_WALLET_CHAINS = { ...CHAIN_KEY_TO_WAGMI_MAINNET, ...WALLET_ONLY_EVM_CHAINS };

// RPC_FALLBACKS only covers the Bridge's original chains; wallet-only
// chains get their real second endpoint from WALLET_ONLY_RPC_FALLBACK
// instead (Monad and Sei have none documented — see that file's comment).
function extraFallbackUrl(chainId) {
  return WALLET_ONLY_RPC_FALLBACK[chainId] || null;
}

const clientCache = new Map();

// Short-lived, in-memory balance cache — same TTL and same reasoning as
// multiAssetBalances.js's own cache: cuts redundant RPC round trips when
// this tab re-renders (switching away and back, an unrelated state
// update remounting a row) within a few seconds, without letting a
// balance go stale for long. The explicit refresh button bypasses this
// via forceFresh, same contract as multiAssetBalances.js.
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
  if (chain) return chain;
  const custom = loadCustomNetworks().find((n) => n.chainKey === chainKey);
  if (custom) return viemChainForCustomNetwork(custom);
  throw new Error(`No mainnet chain configured for key "${chainKey}"`);
}

function getWalletTransport(chain) {
  const bridgeUrls = (RPC_FALLBACKS[chain.id] || []).filter(Boolean);
  if (bridgeUrls.length > 0) {
    const reversedPriority = [...bridgeUrls].reverse(); // opposite of wagmi.js's transportFor()
    return fallback(reversedPriority.map((url) => http(url)), { rank: true });
  }
  const extraUrl = extraFallbackUrl(chain.id);
  if (extraUrl) {
    // No existing Bridge-side ordering to reverse here (these chains
    // aren't in the Bridge's own list at all) — just the chain's own
    // wagmi/chains default plus the real second endpoint sourced in
    // walletChains.js.
    return fallback([http(), http(extraUrl)], { rank: true });
  }
  return http(); // no second verified endpoint documented for this chain (Monad, Sei) — its own default only
}

export function getWalletPublicClient(chainKey) {
  if (clientCache.has(chainKey)) return clientCache.get(chainKey);
  const chain = getWalletChain(chainKey);
  const client = createPublicClient({ chain, transport: getWalletTransport(chain) });
  clientCache.set(chainKey, client);
  return client;
}

/**
 * A viem WalletClient for signing/sending FROM the wallet's own derived
 * account — same transport (and same "separate from the Bridge" reasoning)
 * as getWalletPublicClient, just with a local account attached so it can
 * sign. Not cached (a fresh account import per call is cheap and avoids
 * holding a signer keyed to a private key past when it's needed).
 */
export async function getWalletClientFor(chainKey, privateKeyHex) {
  const { createWalletClient } = await import("viem");
  const { privateKeyToAccount } = await import("viem/accounts");
  const chain = getWalletChain(chainKey);
  const account = privateKeyToAccount(privateKeyHex);
  return createWalletClient({ account, chain, transport: getWalletTransport(chain) });
}

/**
 * A real Solana Connection using the same reversed-priority endpoint choice
 * as fetchWalletSolanaBalance — but single-endpoint, deliberately not
 * wrapped in fallback-and-retry like the read path is. Retrying a SIGNED
 * broadcast against a second, independently-tracked RPC node risks a real
 * double-send if the first attempt actually landed but only the
 * confirmation was lost — same reasoning the Telegram bot's
 * sendExecution.service.ts already documents for exactly this class of
 * call.
 */
export async function getWalletSolanaConnection() {
  const { Connection } = await import("@solana/web3.js");
  const urls = [...solanaRpcUrls()].reverse();
  return new Connection(urls[0], "confirmed");
}

/** Native-asset balance for one EVM chain, as a human-readable number. Every native asset this app supports uses 18 decimals. */
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

/** ERC-20 balance for one token on one chain, as a human-readable number (using the token's own real decimals, not assumed). */
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

/**
 * SOL balance via a reversed-priority endpoint list vs. solanaRpc.js's
 * withSolanaFallback — PublicNode first here (this codebase's own
 * established, trusted, keyless RPC provider), SolanaTracker as the
 * fallback, Alchemy last if a key happens to be configured. Genuine
 * separation now even without an Alchemy key, unlike before
 * solanaRpcUrls() had a real second entry (see that file's own
 * comment).
 */
export async function fetchWalletSolanaBalance(address, { forceFresh = false } = {}) {
  const key = `solana:${address}`;
  if (!forceFresh) {
    const cached = getCached(key);
    if (cached !== null) return cached;
  }
  const urls = [...solanaRpcUrls()].reverse();
  let lastError;
  for (const url of urls) {
    try {
      const { Connection, PublicKey } = await import("@solana/web3.js");
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

/**
 * SPL token balance for one mint, as a human-readable number. Zero is a
 * REAL, common answer here, not just "no data yet" — most wallets never
 * have an associated token account (ATA) created for a token they've
 * never held, and reading a nonexistent ATA is expected to fail; that
 * failure is treated as balance 0, not surfaced as an error, since from
 * the user's point of view "you have none of this token" is exactly
 * correct.
 */
export async function fetchWalletSplTokenBalance(mintAddress, decimals, ownerAddress, { forceFresh = false } = {}) {
  const key = `solana-token:${mintAddress}:${ownerAddress}`;
  if (!forceFresh) {
    const cached = getCached(key);
    if (cached !== null) return cached;
  }
  const urls = [...solanaRpcUrls()].reverse();
  let lastError;
  for (const url of urls) {
    try {
      const [{ Connection, PublicKey }, { getAssociatedTokenAddress, getAccount }] = await Promise.all([
        import("@solana/web3.js"),
        import("@solana/spl-token"),
      ]);
      const connection = new Connection(url, "confirmed");
      const ata = await getAssociatedTokenAddress(new PublicKey(mintAddress), new PublicKey(ownerAddress));
      let balance;
      try {
        const account = await getAccount(connection, ata);
        balance = Number(account.amount) / 10 ** decimals;
      } catch {
        balance = 0; // no ATA exists yet for this mint — genuinely zero, not an error
      }
      setCached(key, balance);
      return balance;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

/**
 * Real on-chain symbol()/decimals() reads for a user-pasted ERC-20
 * contract address — the "import custom token" flow. Deliberately no
 * fallback/guess: if either call reverts (not actually an ERC-20, wrong
 * chain) this throws, and the caller surfaces that as "couldn't verify
 * this token," never a fabricated symbol.
 */
export async function fetchErc20TokenMetadata(chainKey, tokenAddress) {
  const client = getWalletPublicClient(chainKey);
  const [symbol, decimals] = await Promise.all([
    client.readContract({ address: tokenAddress, abi: ERC20_METADATA_ABI, functionName: "symbol" }),
    client.readContract({ address: tokenAddress, abi: ERC20_METADATA_ABI, functionName: "decimals" }),
  ]);
  return { symbol, decimals: Number(decimals) };
}

/**
 * Real on-chain decimals for a user-pasted SPL mint address. SPL mints
 * carry no on-chain symbol/name (that lives in an optional, separate
 * Metaplex metadata account this project doesn't parse) — the caller
 * asks the user for a symbol directly, same honest limitation
 * documented on the "import custom token" UI itself.
 *
 * Real bug fix: this used to go through getWalletSolanaConnection()
 * — a single, non-retried endpoint, deliberately built that way for
 * signing/broadcasting a real transaction (see that function's own
 * comment on why retrying a SIGNED call risks a double-send). A mint
 * lookup is a pure read with no such risk, and every other read in
 * this file (fetchWalletSolanaBalance/fetchWalletSplTokenBalance)
 * already retries across solanaRpcUrls() for exactly that reason —
 * this was the one read path that didn't, so a single flaky/rate-
 * limited endpoint could reject a genuinely real mint.
 */
export async function fetchSplMintDecimals(mintAddress) {
  const [{ getMint }, { Connection, PublicKey }] = await Promise.all([import("@solana/spl-token"), import("@solana/web3.js")]);
  const mintPubkey = new PublicKey(mintAddress);
  const urls = [...solanaRpcUrls()].reverse();
  let lastError;
  for (const url of urls) {
    try {
      const connection = new Connection(url, "confirmed");
      const mint = await getMint(connection, mintPubkey);
      return mint.decimals;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}
