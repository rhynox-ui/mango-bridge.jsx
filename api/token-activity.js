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

// Real swap scan, scoped to ONLY the given poolIds — one getLogs call per
// known Mango pool, run in parallel, instead of a single unfiltered scan
// of the entire shared PoolManager.
//
// This used to be one unfiltered `getLogs({ address: ROBINHOOD_POOL_MANAGER
// })` call with no `id` filter, on the theory that filtering per-pool
// would mean N round trips instead of one. That was a real bug, not just
// an inefficiency: PoolManager is Uniswap v4's shared singleton — ANY
// protocol's pools live at that same address, not just Mango's — so an
// unfiltered scan was silently counting other protocols' swap volume as
// Mango's own "Trading volume," and it broke outright in production once
// the RPC's own result-size cap (10,000 logs) was hit by that combined,
// unrelated activity: "logs matched by query exceeds limit of 10000" —
// with an app that had all of 2 real launches at the time, which could
// not plausibly have produced 10k+ of its own swaps. Scoping to known
// poolIds fixes both: each pool's own log volume is nowhere near the cap
// for an app this size, and only real Mango launches are ever counted.
//
// Deliberately isolated from fetchRealLaunches (a separate concern) — see
// getKnownPoolIds below, and the launch-stats/protocol-stats endpoint
// comments for why calling this must stay independent of the core
// launches list's own request.
//
// No getTransaction call here — no caller reads a per-swap trader address,
// only ethAmount/isBuy/timestamp, so fetching it was pure wasted RPC load.
// getBlock is deduped by block number for the same reason: many swaps
// share a block.
//
// Next real scaling concern, once it actually arrives: a single pool
// itself matching more than 10,000 swaps would hit the same RPC cap
// again, just per-pool instead of protocol-wide — that needs pagination
// (fromBlock/toBlock chunking) when it happens, not before.
async function fetchAllSwapLogs(poolIds) {
  const logsPerPool = await Promise.all(
    poolIds.map((poolId) =>
      client.getLogs({
        address: ROBINHOOD_POOL_MANAGER,
        event: SWAP_EVENT_ABI[0],
        args: { id: poolId },
        fromBlock: 0n,
        toBlock: "latest",
      })
    )
  );
  const logs = logsPerPool.flat();

  const blockNumbers = [...new Set(logs.map((log) => log.blockNumber))];
  const blocks = await Promise.all(blockNumbers.map((bn) => client.getBlock({ blockNumber: bn })));
  const timestampByBlock = new Map(blockNumbers.map((bn, i) => [bn, Number(blocks[i].timestamp) * 1000]));

  return logs.map((log) => {
    const isBuy = log.args.amount0 < 0n;
    const ethAmount = isBuy ? -log.args.amount0 : log.args.amount0;
    return {
      poolId: log.args.id,
      hash: log.transactionHash,
      isBuy,
      ethAmount: Number(ethAmount) / 1e18,
      timestamp: timestampByBlock.get(log.blockNumber),
    };
  });
}

// Reuses the same cached launches list the "launches" endpoint already
// maintains (see LAUNCHES_CACHE_TTL_MS) rather than re-scanning the
// Registry from scratch on every stats request — a real, unnecessary
// Registry read otherwise, since launch-stats/protocol-stats are fetched
// independently and often around the same time as the launches list
// itself.
async function getKnownPoolIds() {
  const cached = await readCache("cache-launches.json", LAUNCHES_CACHE_TTL_MS);
  const launches = cached || (await fetchRealLaunches());
  return launches.map((l) => l.poolId);
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
  console.log(`fetchRealLaunches: Registry ${REGISTRY_ADDRESS} reports totalLaunches=${count}`);
  if (count === 0n) return [];

  const logoRegistry = await fetchLogoRegistry();
  // Previously a single sequential for-loop doing up to 4 awaited RPC
  // calls per launch, one at a time, completely unguarded — any single
  // flaky/reverting call anywhere in that chain (one bad token, one RPC
  // hiccup) threw and killed the ENTIRE launches response, and was a
  // likely live cause of "Failed to load launches" on its own. Now: poolIds
  // and launch structs are fetched in parallel and each index is wrapped
  // so one bad entry is skipped (logged, not silently lost) instead of
  // taking every other launch down with it. Parallel also meaningfully
  // cuts wall-clock time, which matters against a serverless function's
  // execution time limit as the number of real launches grows.
  const indices = Array.from({ length: Number(count) }, (_, i) => BigInt(i));
  const launchResults = await Promise.all(
    indices.map(async (i) => {
      try {
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

        // Real check, not a hardcoded list — skip anything whose actual
        // pool isn't using the current hook. This automatically stays
        // correct through future hook upgrades too, without needing this
        // list maintained by hand each time.
        //
        // Logged on mismatch rather than silently dropped: this recompute
        // assumes POOL_FEE=3000 and TICK_SPACING=60 for every launch, which
        // has never been independently confirmed against the real deployed
        // Factory. If that assumption is wrong, this filter would silently
        // hide every real launch behind a generic empty "No tokens
        // launched yet" — this log line is what actually shows whether
        // that's happening, and if so, which parameter is off.
        const expectedPoolId = computeCurrentHookPoolId(tokenAddress);
        if (expectedPoolId.toLowerCase() !== poolId.toLowerCase()) {
          console.warn(
            `fetchRealLaunches: poolId mismatch for token ${tokenAddress} (index ${i}) - ` +
            `registered poolId=${poolId}, computed (fee=${POOL_FEE}, tickSpacing=${TICK_SPACING}, hook=${CURRENT_HOOK_ADDRESS})=${expectedPoolId}. ` +
            `Filtered out of Explore - if this token should be live, POOL_FEE/TICK_SPACING here likely doesn't match the real Factory.`
          );
          return null;
        }

        // Separate, explicit exclusion — these two are confirmed to be on
        // the current Hook (verified via cast keccak against their real
        // poolId), yet failed a real sell attempt. Root cause unclear —
        // possibly a timing issue with an earlier Router version, possibly
        // something else — deliberately not chased further tonight.
        // Excluded by address specifically, not by the Hook-based rule
        // above, since that rule genuinely doesn't apply to these two.
        const KNOWN_PROBLEMATIC_TOKENS = new Set([
          "0x353f7e2163a73bef1c996c0c58f2f11564838bbe",
          "0x79f9ce00b64b96aac8f53c32d976b0e6a38a1e86",
        ]);
        if (KNOWN_PROBLEMATIC_TOKENS.has(tokenAddress.toLowerCase())) return null;

        let name = "Unknown";
        let symbol = "???";
        try {
          [name, symbol] = await Promise.all([
            client.readContract({ address: tokenAddress, abi: ERC20_METADATA_ABI, functionName: "name" }),
            client.readContract({ address: tokenAddress, abi: ERC20_METADATA_ABI, functionName: "symbol" }),
          ]);
        } catch {
          // Fall back silently — display-only, not a hard failure.
        }

        return {
          poolId,
          name,
          symbol,
          creator,
          tokenAddress,
          cumulativeProtocolFeesUsd,
          graduationThresholdUsd,
          graduated,
          launchedAt,
        };
      } catch (err) {
        console.error(`fetchRealLaunches: skipping launch index ${i}:`, err);
        return null;
      }
    })
  );

  const launches = [];
  for (const r of launchResults) {
    if (!r) continue;
    const { poolId, name, symbol, creator, tokenAddress, cumulativeProtocolFeesUsd, graduationThresholdUsd, graduated, launchedAt } = r;
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
      hue: (symbol.charCodeAt(0) || 0) % 360,
    });
  }
  return launches;
}

// Per-pool volume/last-buy-time, powering Explore's "Recent buys" sort.
// Deliberately its own endpoint (see fetchAllSwapLogs's comment) — the
// frontend fetches this separately from getRealLaunches, so it can never
// block or break the core token list.
export async function fetchLaunchStats() {
  const poolIds = await getKnownPoolIds();
  const allSwaps = await fetchAllSwapLogs(poolIds);
  const perPoolStats = {};
  for (const swap of allSwaps) {
    const key = swap.poolId.toLowerCase();
    if (!perPoolStats[key]) perPoolStats[key] = { volumeEth: 0, lastBuyAt: 0 };
    perPoolStats[key].volumeEth += Math.abs(swap.ethAmount);
    if (swap.isBuy && swap.timestamp > perPoolStats[key].lastBuyAt) {
      perPoolStats[key].lastBuyAt = swap.timestamp;
    }
  }
  return perPoolStats;
}

// Real, protocol-wide volume — powers Analytics' "Trading volume" tile.
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
  const poolIds = await getKnownPoolIds();
  const allSwaps = await fetchAllSwapLogs(poolIds);
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

    // Both below are fetched independently by the frontend, never as part
    // of the "launches" request above — see fetchAllSwapLogs's comment for
    // why that separation matters. A slow or failing RPC scan here only
    // ever costs "Recent buys"/"Trading volume", never the token list.
    if (type === "launch-stats") {
      const cacheKey = "cache-launch-stats.json";
      const cached = await readCache(cacheKey);
      if (cached) return response.status(200).json({ data: cached, cached: true });

      const fresh = await fetchLaunchStats();
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

    return response.status(400).json({ error: "type must be 'trades', 'holders', 'launches', 'launch-stats', or 'protocol-stats'" });
  } catch (error) {
    return response.status(500).json({ error: error.message });
  }
}
