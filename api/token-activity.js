// api/token-activity.js
//
// A real, SHARED cache — not per-browser. Lives in the same Blob storage
// already set up for logos tonight, so every visitor's request checks the
// same cached answer, not just their own.
//
// Without this, ten different people opening the same token's page within
// a few seconds of each other each trigger their own full blockchain scan
// (every Swap event for trades, every Transfer event for holders) — real,
// unnecessary, repeated RPC load against Robinhood Chain's own node.
//
// With this: the first request in any 30-second window does the real
// scan and saves the result. Every request after that, from anyone, just
// reads the saved result until it's stale again.

import { put, head } from "@vercel/blob";
import { createPublicClient, http, keccak256, encodeAbiParameters, parseAbiParameters } from "viem";

const CACHE_TTL_MS = 30 * 1000; // 30 seconds, as requested — real staleness ceiling
// Launches change far less often than trades — a new one only appears
// when someone actually launches a token, not on every swap. A longer
// TTL here is genuinely fine, and cuts real repeated load further.
export const LAUNCHES_CACHE_TTL_MS = 60 * 1000;

const REGISTRY_ADDRESS = "0xb4D9c0928d0bf15ACa8D698cb83703752CfdF785"; // v3, current

// The CURRENT hook — used to verify a launch's real pool actually uses it,
// not just trust the Registry entry exists. A token's poolId inherently
// encodes which hook its pool was created with (hooks is part of the
// PoolKey that gets hashed into the poolId) — so recomputing what the
// poolId WOULD be with the current hook, and comparing against what's
// actually registered, tells us definitively whether this launch is on
// the current, working contract stack or an old one.
//
// This matters for a real reason, not just tidiness: a pool's hook is
// permanent once created. A token launched under an old hook version
// (like the one missing AFTER_SWAP_RETURNS_DELTA_FLAG, confirmed and
// fixed earlier tonight) stays broken forever, regardless of how many
// times the Router gets updated — the bug lives in the pool itself.
// Showing these tokens in Explore just sets users up for a confusing
// failure trading something that looks legitimate.
const CURRENT_HOOK_ADDRESS = "0x6df44617b8C13AB961dCe5097F9375AE6BE09044";
const POOL_FEE = 3000;
const TICK_SPACING = 60;

function computeCurrentHookPoolId(tokenAddress) {
  return keccak256(
    encodeAbiParameters(
      parseAbiParameters("address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks"),
      ["0x0000000000000000000000000000000000000000", tokenAddress, POOL_FEE, TICK_SPACING, CURRENT_HOOK_ADDRESS]
    )
  );
}
const REGISTRY_ABI = [
  { type: "function", name: "totalLaunches", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "allPoolIds", inputs: [{ name: "", type: "uint256" }], outputs: [{ type: "bytes32" }], stateMutability: "view" },
  {
    type: "function",
    name: "launches",
    inputs: [{ name: "", type: "bytes32" }],
    outputs: [
      { name: "creator", type: "address" },
      { name: "tokenAddress", type: "address" },
      { name: "cumulativeProtocolFeesUsd", type: "uint256" },
      { name: "graduationThresholdUsd", type: "uint256" },
      { name: "graduated", type: "bool" },
      { name: "launchedAt", type: "uint256" },
      { name: "graduatedAt", type: "uint256" },
    ],
    stateMutability: "view",
  },
];
const ERC20_METADATA_ABI = [
  { type: "function", name: "name", inputs: [], outputs: [{ type: "string" }], stateMutability: "view" },
  { type: "function", name: "symbol", inputs: [], outputs: [{ type: "string" }], stateMutability: "view" },
];

const LOGO_REGISTRY_BLOB_PATH = "token-logo-registry.json";

async function fetchLogoRegistry() {
  try {
    const blobInfo = await head(LOGO_REGISTRY_BLOB_PATH);
    const res = await fetch(blobInfo.url);
    return await res.json();
  } catch {
    return {};
  }
}

const ROBINHOOD_POOL_MANAGER = "0x8366a39CC670B4001A1121B8F6A443A643e40951";

const SWAP_EVENT_ABI = [
  {
    type: "event",
    name: "Swap",
    inputs: [
      { name: "id", type: "bytes32", indexed: true },
      { name: "sender", type: "address", indexed: true },
      { name: "amount0", type: "int128", indexed: false },
      { name: "amount1", type: "int128", indexed: false },
      { name: "sqrtPriceX96", type: "uint160", indexed: false },
      { name: "liquidity", type: "uint128", indexed: false },
      { name: "tick", type: "int24", indexed: false },
      { name: "fee", type: "uint24", indexed: false },
    ],
  },
];

const TRANSFER_EVENT_ABI = [
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
];

const client = createPublicClient({
  transport: http("https://rpc.mainnet.chain.robinhood.com"),
});

export async function readCache(key, ttlMs = CACHE_TTL_MS) {
  try {
    const blobInfo = await head(key);
    const res = await fetch(blobInfo.url);
    const data = await res.json();
    if (Date.now() - data.cachedAt < ttlMs) {
      return data.payload; // still fresh
    }
    return null; // exists, but stale — needs a real refresh
  } catch {
    return null; // doesn't exist yet
  }
}

export async function writeCache(key, payload) {
  await put(key, JSON.stringify({ cachedAt: Date.now(), payload }), {
    access: "public",
    contentType: "application/json",
    addRandomSuffix: false,
    allowOverwrite: true,
  });
}

export async function fetchRealTrades(poolId, limit = 30) {
  const logs = await client.getLogs({
    address: ROBINHOOD_POOL_MANAGER,
    event: SWAP_EVENT_ABI[0],
    args: { id: poolId },
    fromBlock: 0n,
    toBlock: "latest",
  });

  const recent = logs.slice(-limit).reverse();
  const trades = await Promise.all(
    recent.map(async (log) => {
      const [tx, block] = await Promise.all([
        client.getTransaction({ hash: log.transactionHash }),
        client.getBlock({ blockNumber: log.blockNumber }),
      ]);
      const isBuy = log.args.amount0 < 0n;
      const tokenAmount = isBuy ? log.args.amount1 : -log.args.amount1;
      const ethAmount = isBuy ? -log.args.amount0 : log.args.amount0;
      return {
        hash: log.transactionHash,
        isBuy,
        trader: tx.from,
        tokenAmount: Number(tokenAmount) / 1e18,
        ethAmount: Number(ethAmount) / 1e18,
        timestamp: Number(block.timestamp) * 1000,
      };
    })
  );
  return trades;
}

export async function fetchRealHolders(tokenAddress, limit = 50) {
  const logs = await client.getLogs({
    address: tokenAddress,
    event: TRANSFER_EVENT_ABI[0],
    fromBlock: 0n,
    toBlock: "latest",
  });

  const ZERO = "0x0000000000000000000000000000000000000000";
  const balances = {};
  for (const log of logs) {
    const { from, to, value } = log.args;
    if (from !== ZERO) balances[from] = (balances[from] || 0n) - value;
    if (to !== ZERO) balances[to] = (balances[to] || 0n) + value;
  }

  const TOTAL_SUPPLY = 1_000_000_000n * 10n ** 18n;
  return Object.entries(balances)
    .filter(([, bal]) => bal > 0n)
    .map(([address, bal]) => ({
      address,
      balance: Number(bal) / 1e18,
      percentOfSupply: Number((bal * 10000n) / TOTAL_SUPPLY) / 100,
    }))
    .sort((a, b) => b.balance - a.balance)
    .slice(0, limit);
}

// Real, protocol-wide swap scan — same Swap event, same PoolManager, as
// fetchRealTrades above, just WITHOUT the `id` filter, so this returns
// every swap across every pool on Robinhood Chain's shared PoolManager, not
// just one token's. Callers must cross-reference each log's `id` (poolId)
// against the real launches list before trusting it belongs to a Mango
// token — a shared PoolManager can host pools this app had no part in.
//
// Known, honest limitation: this scans full history with no cap, same as
// fetchRealTrades/fetchRealHolders already do — fine for a young app with
// modest trade counts, but a real cost/latency concern once volume grows
// enough that this becomes a lot of blocks and per-log getTransaction/
// getBlock calls. Worth revisiting (a persisted running total instead of
// a full rescan every cache window) if that day comes — not a problem yet.
async function fetchAllSwapLogs() {
  const logs = await client.getLogs({
    address: ROBINHOOD_POOL_MANAGER,
    event: SWAP_EVENT_ABI[0],
    fromBlock: 0n,
    toBlock: "latest",
  });

  return Promise.all(
    logs.map(async (log) => {
      const [tx, block] = await Promise.all([
        client.getTransaction({ hash: log.transactionHash }),
        client.getBlock({ blockNumber: log.blockNumber }),
      ]);
      const isBuy = log.args.amount0 < 0n;
      const ethAmount = isBuy ? -log.args.amount0 : log.args.amount0;
      return {
        poolId: log.args.id,
        hash: log.transactionHash,
        isBuy,
        trader: tx.from,
        ethAmount: Number(ethAmount) / 1e18,
        timestamp: Number(block.timestamp) * 1000,
      };
    })
  );
}

// Powers the Explore page's launch list — moved server-side specifically
// so this genuinely expensive fetch (a Registry read per token, plus two
// more per token for name/symbol) happens once per cache window instead
// of on every single visit. Mirrors the exact logic that used to run
// client-side in getRealLaunches(), including the same positional
// destructuring fix for the Registry struct.
export async function fetchRealLaunches() {
  const count = await client.readContract({
    address: REGISTRY_ADDRESS,
    abi: REGISTRY_ABI,
    functionName: "totalLaunches",
  });
  if (count === 0n) return [];

  const logoRegistry = await fetchLogoRegistry();
  // Real per-pool volume/last-buy-time, from the same swap scan used for
  // Analytics' protocol-wide numbers — computed once here and attached to
  // each launch, powering the "Top gainers"... i.e. "Recent buys" Explore
  // sort chip with genuine data instead of leaving it disabled.
  const allSwaps = await fetchAllSwapLogs();
  const perPoolStats = {};
  for (const swap of allSwaps) {
    const key = swap.poolId.toLowerCase();
    if (!perPoolStats[key]) perPoolStats[key] = { volumeEth: 0, lastBuyAt: 0 };
    perPoolStats[key].volumeEth += Math.abs(swap.ethAmount);
    if (swap.isBuy && swap.timestamp > perPoolStats[key].lastBuyAt) {
      perPoolStats[key].lastBuyAt = swap.timestamp;
    }
  }
  const launches = [];

  for (let i = 0n; i < count; i++) {
    const poolId = await client.readContract({
      address: REGISTRY_ADDRESS,
      abi: REGISTRY_ABI,
      functionName: "allPoolIds",
      args: [i],
    });
    const launchRaw = await client.readContract({
      address: REGISTRY_ADDRESS,
      abi: REGISTRY_ABI,
      functionName: "launches",
      args: [poolId],
    });
    const [creator, tokenAddress, cumulativeProtocolFeesUsd, graduationThresholdUsd, graduated, launchedAt] = launchRaw;

    // Real check, not a hardcoded list — skip anything whose actual pool
    // isn't using the current hook. This automatically stays correct
    // through future hook upgrades too, without needing this list
    // maintained by hand each time.
    if (computeCurrentHookPoolId(tokenAddress).toLowerCase() !== poolId.toLowerCase()) continue;

    // Separate, explicit exclusion — these two are confirmed to be on the
    // current Hook (verified via cast keccak against their real poolId),
    // yet failed a real sell attempt. Root cause unclear — possibly a
    // timing issue with an earlier Router version, possibly something
    // else — deliberately not chased further tonight. Excluded by
    // address specifically, not by the Hook-based rule above, since
    // that rule genuinely doesn't apply to these two.
    const KNOWN_PROBLEMATIC_TOKENS = new Set([
      "0x353f7e2163a73bef1c996c0c58f2f11564838bbe",
      "0x79f9ce00b64b96aac8f53c32d976b0e6a38a1e86",
    ]);
    if (KNOWN_PROBLEMATIC_TOKENS.has(tokenAddress.toLowerCase())) continue;

    let name = "Unknown";
    let symbol = "???";
    try {
      name = await client.readContract({ address: tokenAddress, abi: ERC20_METADATA_ABI, functionName: "name" });
      symbol = await client.readContract({ address: tokenAddress, abi: ERC20_METADATA_ABI, functionName: "symbol" });
    } catch {
      // Fall back silently — display-only, not a hard failure.
    }

    const stats = perPoolStats[poolId.toLowerCase()] || { volumeEth: 0, lastBuyAt: 0 };

    launches.push({
      id: poolId,
      poolId,
      name,
      symbol,
      creator,
      tokenAddress,
      logoUrl: logoRegistry[tokenAddress.toLowerCase()] || null,
      marketCapUsd: Number(cumulativeProtocolFeesUsd) / 1e8,
      graduationThresholdUsd: Number(graduationThresholdUsd) / 1e8,
      graduated,
      createdAt: Number(launchedAt) * 1000,
      holders: 0,
      priceChange24h: 0,
      volumeEth: stats.volumeEth,
      lastBuyAt: stats.lastBuyAt,
      hue: (symbol.charCodeAt(0) || 0) % 360,
    });
  }
  return launches;
}

// Real, protocol-wide volume — powers Analytics' "Trading volume" tile,
// which previously said "Not available yet" for lack of exactly this.
// Deliberately does NOT attempt "Total creator fees paid out" the same
// way: the hook's actual fee rate depends on each trade's buy/sell side
// AND whether that specific pool had already graduated at the moment of
// that trade (1%/4%/1% per README's own documented schedule) — real
// historical per-trade state this endpoint doesn't have without either a
// dedicated fee event from the hook (not confirmed to exist) or replaying
// graduation state trade-by-trade. Reconstructing that from cumulative
// numbers alone risks a confidently-wrong figure, not an honestly-labeled
// estimate — so that tile stays "Not available yet" rather than guessing.
export async function fetchProtocolStats() {
  const allSwaps = await fetchAllSwapLogs();
  const dayMs = 24 * 3600 * 1000;
  const now = Date.now();
  let totalVolumeEth = 0;
  let volume24hEth = 0;
  for (const swap of allSwaps) {
    const abs = Math.abs(swap.ethAmount);
    totalVolumeEth += abs;
    if (now - swap.timestamp <= dayMs) volume24hEth += abs;
  }
  return { totalVolumeEth, volume24hEth, tradeCount: allSwaps.length };
}

export default async function handler(request, response) {
  const { type, poolId, tokenAddress } = request.query;

  try {
    if (type === "trades") {
      const cacheKey = `cache-trades-${poolId}.json`;
      const cached = await readCache(cacheKey);
      if (cached) return response.status(200).json({ data: cached, cached: true });

      const fresh = await fetchRealTrades(poolId);
      await writeCache(cacheKey, fresh);
      return response.status(200).json({ data: fresh, cached: false });
    }

    if (type === "holders") {
      const cacheKey = `cache-holders-${tokenAddress}.json`;
      const cached = await readCache(cacheKey);
      if (cached) return response.status(200).json({ data: cached, cached: true });

      const fresh = await fetchRealHolders(tokenAddress);
      await writeCache(cacheKey, fresh);
      return response.status(200).json({ data: fresh, cached: false });
    }

    if (type === "launches") {
      const cacheKey = "cache-launches.json";
      const cached = await readCache(cacheKey, LAUNCHES_CACHE_TTL_MS);
      if (cached) return response.status(200).json({ data: cached, cached: true });

      const fresh = await fetchRealLaunches();
      await writeCache(cacheKey, fresh);
      return response.status(200).json({ data: fresh, cached: false });
    }

    if (type === "protocol-stats") {
      const cacheKey = "cache-protocol-stats.json";
      const cached = await readCache(cacheKey);
      if (cached) return response.status(200).json({ data: cached, cached: true });

      const fresh = await fetchProtocolStats();
      await writeCache(cacheKey, fresh);
      return response.status(200).json({ data: fresh, cached: false });
    }

    return response.status(400).json({ error: "type must be 'trades', 'holders', 'launches', or 'protocol-stats'" });
  } catch (error) {
    return response.status(500).json({ error: error.message });
  }
}
