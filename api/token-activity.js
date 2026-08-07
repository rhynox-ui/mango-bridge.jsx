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
import { createPublicClient, http } from "viem";

const CACHE_TTL_MS = 30 * 1000; // 30 seconds, as requested — real staleness ceiling
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

async function readCache(key) {
  try {
    const blobInfo = await head(key);
    const res = await fetch(blobInfo.url);
    const data = await res.json();
    if (Date.now() - data.cachedAt < CACHE_TTL_MS) {
      return data.payload; // still fresh
    }
    return null; // exists, but stale — needs a real refresh
  } catch {
    return null; // doesn't exist yet
  }
}

async function writeCache(key, payload) {
  await put(key, JSON.stringify({ cachedAt: Date.now(), payload }), {
    access: "public",
    contentType: "application/json",
    addRandomSuffix: false,
    allowOverwrite: true,
  });
}

async function fetchRealTrades(poolId, limit = 30) {
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

async function fetchRealHolders(tokenAddress, limit = 50) {
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

    return response.status(400).json({ error: "type must be 'trades' or 'holders'" });
  } catch (error) {
    return response.status(500).json({ error: error.message });
  }
}
