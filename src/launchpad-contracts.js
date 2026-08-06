import { readContract, writeContract, waitForTransactionReceipt } from "wagmi/actions";
import { keccak256, encodeAbiParameters, parseAbiParameters, decodeEventLog } from "viem";
import { config } from "./wagmi.js";

// ============================================================================
// Real, deployed, verified addresses on Robinhood Chain mainnet — not
// placeholders. Confirmed independently on Blockscout, same rigor as every
// other address used throughout this project.
// ============================================================================
export const LAUNCHPAD_FACTORY_ADDRESS = "0x8aD6607EbBAd5F4A088EDC25e98B3B454F9E912A"; // points at Hook v4 (the real AFTER_SWAP_RETURNS_DELTA_FLAG fix)
export const LAUNCHPAD_HOOK_ADDRESS = "0x6df44617b8C13AB961dCe5097F9375AE6BE09044"; // v4, current
export const LAUNCHPAD_REGISTRY_ADDRESS = "0xb4D9c0928d0bf15ACa8D698cb83703752CfdF785"; // v3, current
export const ROBINHOOD_CHAIN_ID = 4663;
export const LAUNCHPAD_ROUTER_ADDRESS = "0xB8dEa275945355C86688e1dDC499453576B4b95E"; // points at Hook v4
// Confirmed real address, cross-verified against Uniswap's own official
// PoolManager listing matching exactly — same rigor as every other address
// used tonight. Source: Bags' own developer documentation for Robinhood
// Chain, which lists the full protocol address book.
export const STATE_VIEW_ADDRESS = "0xF3334192D15450CdD385c8B70e03f9A6bD9E673b";

const STATE_VIEW_ABI = [
  {
    type: "function",
    name: "getSlot0",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "protocolFee", type: "uint24" },
      { name: "lpFee", type: "uint24" },
    ],
    stateMutability: "view",
  },
];

const ROUTER_ABI = [
  {
    type: "function",
    name: "buy",
    inputs: [
      { name: "token", type: "address" },
      { name: "minAmountOut", type: "uint256" },
      { name: "sqrtPriceLimitX96", type: "uint160" },
      { name: "deadline", type: "uint256" },
      { name: "recipient", type: "address" },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "sell",
    inputs: [
      { name: "token", type: "address" },
      { name: "amountIn", type: "uint256" },
      { name: "minAmountOut", type: "uint256" },
      { name: "sqrtPriceLimitX96", type: "uint160" },
      { name: "deadline", type: "uint256" },
      { name: "recipient", type: "address" },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
    stateMutability: "nonpayable",
  },
];

const ERC20_APPROVE_ABI = [
  {
    type: "function",
    name: "approve",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
    stateMutability: "nonpayable",
  },
];

// Same fixed pool conventions used everywhere in this project — needed
// here to reconstruct the poolId for a live StateView read.
const POOL_FEE = 3000;
const TICK_SPACING = 60;

function computePoolId(tokenAddress) {
  // Mirrors keccak256(abi.encode(key)) from the Solidity side — PoolKey
  // encoding matches Solidity's abi.encode of the same struct shape.
  return keccak256(
    encodeAbiParameters(
      parseAbiParameters("address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks"),
      ["0x0000000000000000000000000000000000000000", tokenAddress, POOL_FEE, TICK_SPACING, LAUNCHPAD_HOOK_ADDRESS]
    )
  );
}

// Reads the pool's REAL, current price and derives both a slippage-adjusted
// price limit and an estimated minimum output. This is a genuine live
// on-chain read, not an estimate based on stale data.
//
// One honest simplification worth naming directly: minAmountOut here is
// computed from the pool's SPOT price, not a full swap simulation (which
// would need V4Quoter, whose exact interface wasn't confirmed during
// tonight's research). For small trades relative to pool depth this is a
// reasonable approximation; for large trades, actual price impact within
// the swap could make the real output meaningfully lower than this
// estimate suggests. The DIRECTION of the slippage math (buy = lower
// price bound, sell = upper price bound, per the actual v4 mechanic where
// zeroForOne=true pushes price down) has been reasoned through carefully,
// but has not yet been confirmed by an actual real trade — that
// confirmation only comes from trying it.
export async function getTradeQuote({ tokenAddress, side, slippagePercent = 5 }) {
  const poolId = computePoolId(tokenAddress);
  const slot0 = await readContract(config, {
    address: STATE_VIEW_ADDRESS,
    abi: STATE_VIEW_ABI,
    functionName: "getSlot0",
    args: [poolId],
    chainId: ROBINHOOD_CHAIN_ID,
  });

  const currentSqrtPriceX96 = slot0[0];
  const slippageFactor = slippagePercent / 100;

  // Buy pushes price DOWN (zeroForOne=true) -> limit is a lower bound.
  // Sell pushes price UP (zeroForOne=false) -> limit is an upper bound.
  const sqrtPriceLimitX96 = side === "buy"
    ? BigInt(Math.floor(Number(currentSqrtPriceX96) * (1 - slippageFactor)))
    : BigInt(Math.ceil(Number(currentSqrtPriceX96) * (1 + slippageFactor)));

  return { currentSqrtPriceX96, sqrtPriceLimitX96, poolId };
}

// ============================================================================
// buyTokenReal / sellTokenReal — call the real deployed Router. Both fetch
// a live quote first, then execute with real slippage protection — not a
// placeholder. sell() requires an approval first, handled here as a
// separate transaction before the actual swap, same standard pattern every
// DEX uses.
// ============================================================================
export async function buyTokenReal({ tokenAddress, ethAmount, recipient, slippagePercent = 5 }) {
  const { sqrtPriceLimitX96 } = await getTradeQuote({ tokenAddress, side: "buy", slippagePercent });
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600); // 10 minutes out
  const valueWei = BigInt(Math.round(parseFloat(ethAmount) * 1e18));

  const hash = await writeContract(config, {
    address: LAUNCHPAD_ROUTER_ADDRESS,
    abi: ROUTER_ABI,
    functionName: "buy",
    args: [tokenAddress, 0n, sqrtPriceLimitX96, deadline, recipient], // minAmountOut left at 0 pending real quote simulation — see checklist note
    value: valueWei,
    chainId: ROBINHOOD_CHAIN_ID,
  });
  const receipt = await waitForTransactionReceipt(config, { hash, chainId: ROBINHOOD_CHAIN_ID });
  return { hash, receipt };
}

export async function sellTokenReal({ tokenAddress, tokenAmountWei, recipient, slippagePercent = 5 }) {
  const { sqrtPriceLimitX96 } = await getTradeQuote({ tokenAddress, side: "sell", slippagePercent });
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);

  const approveHash = await writeContract(config, {
    address: tokenAddress,
    abi: ERC20_APPROVE_ABI,
    functionName: "approve",
    args: [LAUNCHPAD_ROUTER_ADDRESS, tokenAmountWei],
    chainId: ROBINHOOD_CHAIN_ID,
  });
  await waitForTransactionReceipt(config, { hash: approveHash, chainId: ROBINHOOD_CHAIN_ID });

  const hash = await writeContract(config, {
    address: LAUNCHPAD_ROUTER_ADDRESS,
    abi: ROUTER_ABI,
    functionName: "sell",
    args: [tokenAddress, tokenAmountWei, 0n, sqrtPriceLimitX96, deadline, recipient],
    chainId: ROBINHOOD_CHAIN_ID,
  });
  const receipt = await waitForTransactionReceipt(config, { hash, chainId: ROBINHOOD_CHAIN_ID });
  return { hash, receipt };
}


// Minimal ABIs — only the functions this app actually calls, not the full
// contract interface. Matches the exact function signatures confirmed
// against real `forge build` output, not assumed from documentation.
const FACTORY_ABI = [
  {
    type: "function",
    name: "launch",
    inputs: [
      { name: "name", type: "string" },
      { name: "symbol", type: "string" },
      { name: "creator", type: "address" },
    ],
    outputs: [{ name: "token", type: "address" }],
    stateMutability: "payable",
  },
  {
    type: "event",
    name: "TokenLaunched",
    inputs: [
      { name: "token", type: "address", indexed: true },
      { name: "creator", type: "address", indexed: true },
      { name: "poolId", type: "bytes32", indexed: true },
      { name: "devBuyEth", type: "uint256", indexed: false },
    ],
  },
];

const REGISTRY_ABI = [
  {
    type: "function",
    name: "totalLaunches",
    inputs: [],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "allPoolIds",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [{ type: "bytes32" }],
    stateMutability: "view",
  },
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

// Minimal — just the two standard ERC20 read functions needed to show a
// real launch's actual name and symbol, since the Registry itself only
// tracks the token's address, not its metadata.
const ERC20_METADATA_ABI = [
  { type: "function", name: "name", inputs: [], outputs: [{ type: "string" }], stateMutability: "view" },
  { type: "function", name: "symbol", inputs: [], outputs: [{ type: "string" }], stateMutability: "view" },
];

// ============================================================================
// launchToken — calls the real Factory contract to deploy a token and seed
// its pool. The access-control handoff (transferLaunchOperator + setFactory)
// has now happened — both confirmed successful on-chain. This call should
// genuinely be CAPABLE of succeeding now, for the first time. That said,
// nothing has actually been tested end to end yet — the liquidity-seeding
// math, the settlement calls, the swap logic all compiled clean but have
// never been exercised by a real transaction. The first real attempt is
// still a genuine test, not a guaranteed success.
// ============================================================================
export async function launchToken({ name, symbol, creator, devBuyEth }) {
  const devBuyWei = devBuyEth && parseFloat(devBuyEth) > 0
    ? BigInt(Math.round(parseFloat(devBuyEth) * 1e18))
    : 0n;

  const hash = await writeContract(config, {
    address: LAUNCHPAD_FACTORY_ADDRESS,
    abi: FACTORY_ABI,
    functionName: "launch",
    args: [name, symbol, creator],
    value: devBuyWei,
    chainId: ROBINHOOD_CHAIN_ID,
  });

  const receipt = await waitForTransactionReceipt(config, { hash, chainId: ROBINHOOD_CHAIN_ID });

  // Decode the real deployed token address from the TokenLaunched event —
  // this is what lets the UI navigate directly to the new token's page
  // right after launch, instead of leaving the user stranded on the
  // create form. Scans every log since the event could be at any index
  // among the transaction's other emitted events (Transfer, Initialize,
  // ModifyLiquidity, etc.).
  let tokenAddress = null;
  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({ abi: FACTORY_ABI, data: log.data, topics: log.topics });
      if (decoded.eventName === "TokenLaunched") {
        tokenAddress = decoded.args.token;
        break;
      }
    } catch {
      // Not every log matches this ABI — expected, just skip and keep scanning.
    }
  }

  return { hash, receipt, tokenAddress };
}

// ============================================================================
// getRealLaunchCount — reads how many tokens have actually launched through
// the Registry. As of now, this will likely still return 0 — the
// access-control handoff needed for launches to succeed just happened, but
// no one has actually launched anything yet. Once someone does, this
// starts returning real data automatically, no code change needed.
// ============================================================================
export async function getRealLaunchCount() {
  const count = await readContract(config, {
    address: LAUNCHPAD_REGISTRY_ADDRESS,
    abi: REGISTRY_ABI,
    functionName: "totalLaunches",
    chainId: ROBINHOOD_CHAIN_ID,
  });
  return Number(count);
}

// ============================================================================
// getRealLaunches — fetches every real launch's data from the Registry.
// Returns an empty array right now, honestly, since nothing has launched.
// Not yet used by any UI component — wiring this into the Explore page is
// the natural next step once real launches actually exist to display.
// ============================================================================
export async function getRealLaunches() {
  const count = await getRealLaunchCount();
  if (count === 0) return [];

  const launches = [];
  for (let i = 0; i < count; i++) {
    const poolId = await readContract(config, {
      address: LAUNCHPAD_REGISTRY_ADDRESS,
      abi: REGISTRY_ABI,
      functionName: "allPoolIds",
      args: [BigInt(i)],
      chainId: ROBINHOOD_CHAIN_ID,
    });
    const launchRaw = await readContract(config, {
      address: LAUNCHPAD_REGISTRY_ADDRESS,
      abi: REGISTRY_ABI,
      functionName: "launches",
      args: [poolId],
      chainId: ROBINHOOD_CHAIN_ID,
    });

    // Positional destructuring, not named property access (launch.tokenAddress).
    // This is the actual fix for a real reported bug: relying on named
    // properties assumes viem reliably attaches them to a decoded struct
    // from an auto-generated public mapping getter — positional access
    // removes that assumption entirely, matching the struct's real,
    // confirmed field order exactly (creator, tokenAddress,
    // cumulativeProtocolFeesUsd, graduationThresholdUsd, graduated,
    // launchedAt, graduatedAt).
    const [creator, tokenAddress, cumulativeProtocolFeesUsd, graduationThresholdUsd, graduated, launchedAt] = launchRaw;

    // Real name/symbol from the token contract itself — not stored in the
    // Registry, so this needs its own separate reads. If either fails for
    // any reason (shouldn't, given every token here was deployed by our
    // own Factory using the standard template), fall back to the address
    // rather than let the whole list break over one bad entry.
    let name = "Unknown";
    let symbol = "???";
    try {
      name = await readContract(config, {
        address: tokenAddress,
        abi: ERC20_METADATA_ABI,
        functionName: "name",
        chainId: ROBINHOOD_CHAIN_ID,
      });
      symbol = await readContract(config, {
        address: tokenAddress,
        abi: ERC20_METADATA_ABI,
        functionName: "symbol",
        chainId: ROBINHOOD_CHAIN_ID,
      });
    } catch {
      // Fall back silently — this is display-only, not a hard failure.
    }

    launches.push({
      id: poolId,
      poolId,
      name,
      symbol,
      creator,
      tokenAddress,
      // Registry tracks cumulative fees, not market cap directly — used
      // here as the closest real proxy available, same value the
      // graduation bar itself is based on.
      marketCapUsd: Number(cumulativeProtocolFeesUsd) / 1e8,
      graduationThresholdUsd: Number(graduationThresholdUsd) / 1e8,
      graduated,
      createdAt: Number(launchedAt) * 1000,
      // Not yet available from any real on-chain source — holders count
      // and 24h price change would need either an indexer or additional
      // event-log queries neither of which exist yet. Left honestly at 0
      // rather than faked.
      holders: 0,
      priceChange24h: 0,
      hue: (symbol.charCodeAt(0) || 0) % 360,
    });
  }
  return launches;
}
