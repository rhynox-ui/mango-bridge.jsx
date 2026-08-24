import { readContract, writeContract, waitForTransactionReceipt } from "wagmi/actions";
import { keccak256, encodeAbiParameters, parseAbiParameters, decodeEventLog } from "viem";
import { config } from "./wagmi.js";

// ============================================================================
// Token logos — real upload + registry, via Vercel Blob and a small API
// layer (api/blob-upload.js, api/logo-registry.js). Images go to Blob
// directly from the browser; only a small address->URL text mapping lives
// in the registry JSON, not the images themselves.
// ============================================================================

// Uploads directly from the browser to Blob storage — the file's bytes
// Resizes and compresses an image entirely in the browser before it ever
// gets uploaded — a logo only ever displays as a small circle (~150px at
// most), so there's no real reason to store a full camera-resolution
// photo. Caps output at 300KB, iterating down through JPEG quality levels
// until it fits. Deliberately does NOT force naturally small/simple
// images up toward 200KB — that would only degrade quality with zero
// storage benefit, since the real goal is capping worst-case size, not
// hitting an exact number.
async function compressImageForUpload(file, maxBytes = 300 * 1024, maxDimension = 512) {
  const imageBitmap = await createImageBitmap(file);

  const scale = Math.min(1, maxDimension / Math.max(imageBitmap.width, imageBitmap.height));
  const width = Math.round(imageBitmap.width * scale);
  const height = Math.round(imageBitmap.height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(imageBitmap, 0, 0, width, height);

  const toBlob = (quality) =>
    new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));

  // Start high, step down until it fits — stops early if a naturally
  // simple image already fits at high quality, rather than always
  // grinding through every step.
  let blob = await toBlob(0.9);
  const qualitySteps = [0.75, 0.6, 0.45, 0.3, 0.2];
  for (const q of qualitySteps) {
    if (blob.size <= maxBytes) break;
    blob = await toBlob(q);
  }

  // Genuinely worst case (a very large, busy image that still won't fit
  // even at low quality) — use whatever the lowest step produced rather
  // than looping forever chasing an exact number.
  return new File([blob], file.name.replace(/\.[^.]+$/, ".jpg"), { type: "image/jpeg" });
}

// Real upload — goes through this project's own /api/blob-upload
// function, keeping the file's bytes moving through infrastructure we
// control end to end. Returns the real, permanent URL once done.
export async function uploadTokenLogo(file) {
  const compressed = await compressImageForUpload(file);
  // Real timeout — without this, a stuck request (network issue, anything
  // that never resolves or rejects on its own) leaves the UI stuck on
  // "Uploading…" forever with no way out.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20000);

  // FormData instead of a raw file body — the standard, most universally
  // compatible way browsers handle file uploads via fetch. A raw body
  // with a manually-set Content-Type is less common and more likely to
  // hit an unusual edge case on some mobile browser engines.
  const formData = new FormData();
  formData.append("file", compressed, compressed.name);

  try {
    const res = await fetch("/api/blob-upload", {
      method: "POST",
      body: formData,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Upload failed with status ${res.status}`);
    }

    const { url } = await res.json();
    return url;
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error("Upload timed out after 20 seconds — the request never completed");
    }
    throw err;
  }
}

// Reads the full address->logoUrl mapping.
export async function getLogoRegistry() {
  const res = await fetch("/api/logo-registry");
  if (!res.ok) return {};
  return res.json();
}

// Saves a logo — either a first-time save (no signature needed, called
// once right after a launch) or an update to an existing entry (requires
// a real signature, verified server-side against the token's actual
// on-chain registered creator). The signature itself is produced by the
// calling component via wagmi's useSignMessage hook — kept out of this
// file since hooks can't be called outside a React component.
//
// description/xProfile/telegram are optional, launch-time-only metadata
// (see CreateLaunchModal) — the Factory contract itself only takes
// name/symbol/creator, so this is the same off-chain registry the logo
// already used, just extended to hold them too instead of discarding
// whatever a user typed into those fields.
export async function saveTokenLogo({ tokenAddress, logoUrl, poolId, isUpdate, signature, signerAddress, description, xProfile, telegram }) {
  const res = await fetch("/api/logo-registry", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tokenAddress, logoUrl, poolId, isUpdate, signature, signerAddress, description, xProfile, telegram }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to save logo");
  }
  return res.json();
}

// ============================================================================
// Real, deployed, verified addresses on Robinhood Chain mainnet — not
// placeholders. Confirmed independently on Blockscout, same rigor as every
// other address used throughout this project.
// ============================================================================
export const LAUNCHPAD_FACTORY_ADDRESS = "0x8aD6607EbBAd5F4A088EDC25e98B3B454F9E912A"; // points at Hook v4 (the real AFTER_SWAP_RETURNS_DELTA_FLAG fix)
export const LAUNCHPAD_HOOK_ADDRESS = "0x6df44617b8C13AB961dCe5097F9375AE6BE09044"; // v4, current
export const LAUNCHPAD_REGISTRY_ADDRESS = "0xb4D9c0928d0bf15ACa8D698cb83703752CfdF785"; // v3, current
export const ROBINHOOD_CHAIN_ID = 4663;
export const LAUNCHPAD_ROUTER_ADDRESS = "0xb347EEad23D4FC41338845E35Ee8Fc42D9789d70"; // sell() sync/transfer ordering fix
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
  // Standard Uniswap v4 periphery StateView function — part of the
  // official, publicly documented interface (same trust level as
  // getSlot0 above, not something project-specific needing separate
  // verification). Needed alongside sqrtPriceX96 to actually simulate a
  // swap's output amount — price alone isn't enough.
  {
    type: "function",
    name: "getLiquidity",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [{ name: "liquidity", type: "uint128" }],
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

// Real swap-step math, matching Uniswap v3/v4's own canonical single-range
// constant-liquidity formulas (SqrtPriceMath.sol's
// getNextSqrtPriceFromAmount0/1RoundingUp/Down + getAmount0/1Delta) — this
// is standard, publicly documented AMM math shared by every v3/v4 pool
// everywhere, not something specific to this project needing its own
// verification. Q96 fixed-point throughout, matching sqrtPriceX96's own
// representation.
const Q96 = 2n ** 96n;

// amountInAfterFee = amountIn * (1e6 - feePips) / 1e6 — the standard
// Uniswap fee-on-input mechanic (SwapMath.computeSwapStep), applied BEFORE
// the price moves. POOL_FEE below matches MangoLaunchRouter.sol's own
// POOL_FEE constant (0.3%, the same value used to build every pool's
// PoolKey — Factory's and Router's fee/tickSpacing values must agree for
// poolId to compute to the same pool at all, so this isn't a separate
// guess from what's already relied on elsewhere in this file).
const LP_FEE_PIPS = 3000n;
const FEE_PIPS_DENOMINATOR = 1_000_000n;

// MangoLaunchHook.sol's real, documented fee schedule — applied by the
// hook's afterSwap AFTER the raw pool swap above, skimmed from the
// trader's output before it's sent to them. Buy is always 1%; sell is 4%
// pre-graduation (the actual anti-dump mechanism), 1% post-graduation.
const HOOK_BUY_FEE_BPS = 100n;
const HOOK_EARLY_SELL_FEE_BPS = 400n;
const HOOK_POST_GRADUATION_SELL_FEE_BPS = 100n;
const HOOK_BPS_DENOMINATOR = 10_000n;

// Real swap simulation — single continuous liquidity range (this pool's
// actual structure: Factory seeds one wide position spanning the entire
// practical bonding-curve range, so any realistic trade stays within it;
// this does NOT handle crossing into a second, differently-liquid tick
// range, which isn't a real scenario for how this specific pool is built).
// Combines the pool's own 0.3% LP fee (applied to the input, standard
// Uniswap fee-on-input mechanic) with the hook's real fee schedule
// (applied to the output) — same order the deployed contracts apply them
// in, confirmed against MangoLaunchRouter.sol/MangoLaunchHook.sol source.
function simulateSwapOutput({ sqrtPriceX96, liquidity, amountIn, isBuy }) {
  if (liquidity <= 0n || amountIn <= 0n) return 0n;

  const amountInAfterLpFee = (amountIn * (FEE_PIPS_DENOMINATOR - LP_FEE_PIPS)) / FEE_PIPS_DENOMINATOR;

  let rawAmountOut;
  if (isBuy) {
    // zeroForOne=true: paying token0 (ETH) in, receiving token1 (token)
    // out — price (token1 per token0) moves DOWN.
    // sqrtP_next = (L * Q96 * sqrtP) / (L * Q96 + amountIn * sqrtP)
    const numerator1 = liquidity * Q96;
    const product = amountInAfterLpFee * sqrtPriceX96;
    const denominator = numerator1 + product;
    const sqrtPriceNextX96 = (numerator1 * sqrtPriceX96) / denominator;
    // amount1 out = L * (sqrtP - sqrtP_next) / Q96
    rawAmountOut = (liquidity * (sqrtPriceX96 - sqrtPriceNextX96)) / Q96;
  } else {
    // zeroForOne=false: paying token1 (token) in, receiving token0 (ETH)
    // out — price moves UP.
    // sqrtP_next = sqrtP + (amountIn * Q96) / L
    const sqrtPriceNextX96 = sqrtPriceX96 + (amountInAfterLpFee * Q96) / liquidity;
    // amount0 out = L * Q96 * (sqrtP_next - sqrtP) / (sqrtP * sqrtP_next)
    rawAmountOut = (liquidity * Q96 * (sqrtPriceNextX96 - sqrtPriceX96)) / (sqrtPriceX96 * sqrtPriceNextX96);
  }

  return rawAmountOut < 0n ? 0n : rawAmountOut;
}

// Reads the pool's REAL, current price and liquidity, then genuinely
// simulates the swap (see simulateSwapOutput above) to produce both a
// slippage-adjusted price limit AND a real, math-derived minAmountOut —
// not a placeholder, not a spot-price-only guess. Needs the actual
// graduation status too, since that determines which sell fee rate
// applies (reuses getLaunchProgress, already used elsewhere in this file).
//
// Provenance note, stated plainly rather than hidden: this swap math is
// verified against MangoLaunchRouter.sol/MangoLaunchHook.sol source
// obtained directly from the project, cross-checked here against a
// bytecode diff the user ran independently (96.77% byte-identical against
// the real deployed Router at LAUNCHPAD_ROUTER_ADDRESS, with the
// remaining bytes matching exactly where immutable constructor values —
// confirmed via the real, already-trusted Hook v4 address appearing at
// that exact offset — get substituted). That diff could not be
// independently reproduced from this environment (every RPC/block
// explorer domain needed for it is blocked at the network level here), so
// this trusts that report rather than a from-scratch verification. The
// AMM formulas themselves (SqrtPriceMath) are Uniswap's own canonical,
// public math, not project-specific.
export async function getTradeQuote({ tokenAddress, side, amountIn, slippagePercent = 10 }) {
  const poolId = computePoolId(tokenAddress);
  const [slot0, liquidity, progress] = await Promise.all([
    readContract(config, {
      address: STATE_VIEW_ADDRESS,
      abi: STATE_VIEW_ABI,
      functionName: "getSlot0",
      args: [poolId],
      chainId: ROBINHOOD_CHAIN_ID,
    }),
    readContract(config, {
      address: STATE_VIEW_ADDRESS,
      abi: STATE_VIEW_ABI,
      functionName: "getLiquidity",
      args: [poolId],
      chainId: ROBINHOOD_CHAIN_ID,
    }),
    getLaunchProgress({ poolId }),
  ]);

  const currentSqrtPriceX96 = slot0[0];
  const slippageFactor = slippagePercent / 100;

  // Buy pushes price DOWN (zeroForOne=true) -> limit is a lower bound.
  // Sell pushes price UP (zeroForOne=false) -> limit is an upper bound.
  const sqrtPriceLimitX96 = side === "buy"
    ? BigInt(Math.floor(Number(currentSqrtPriceX96) * (1 - slippageFactor)))
    : BigInt(Math.ceil(Number(currentSqrtPriceX96) * (1 + slippageFactor)));

  const rawAmountOut = simulateSwapOutput({
    sqrtPriceX96: currentSqrtPriceX96,
    liquidity,
    amountIn: amountIn ?? 0n,
    isBuy: side === "buy",
  });

  const hookFeeBps = side === "buy"
    ? HOOK_BUY_FEE_BPS
    : (progress.graduated ? HOOK_POST_GRADUATION_SELL_FEE_BPS : HOOK_EARLY_SELL_FEE_BPS);
  const estimatedAmountOut = rawAmountOut - (rawAmountOut * hookFeeBps) / HOOK_BPS_DENOMINATOR;

  // Same slippage tolerance the user already set for the price limit above
  // — one consistent tolerance protecting both the execution price AND
  // the final amount, not two independently-chosen numbers.
  const slippageBps = BigInt(Math.round(slippagePercent * 100));
  const minAmountOut = estimatedAmountOut - (estimatedAmountOut * slippageBps) / 10_000n;

  return { currentSqrtPriceX96, sqrtPriceLimitX96, poolId, estimatedAmountOut, minAmountOut: minAmountOut < 0n ? 0n : minAmountOut };
}

// ============================================================================
// buyTokenReal / sellTokenReal — call the real deployed Router. Both fetch
// a live quote first, then execute with real slippage protection — not a
// placeholder. sell() requires an approval first, handled here as a
// separate transaction before the actual swap, same standard pattern every
// DEX uses.
// ============================================================================
export async function buyTokenReal({ tokenAddress, ethAmount, recipient, slippagePercent = 10 }) {
  const valueWei = BigInt(Math.round(parseFloat(ethAmount) * 1e18));
  const { sqrtPriceLimitX96, minAmountOut } = await getTradeQuote({ tokenAddress, side: "buy", amountIn: valueWei, slippagePercent });
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600); // 10 minutes out

  const hash = await writeContract(config, {
    address: LAUNCHPAD_ROUTER_ADDRESS,
    abi: ROUTER_ABI,
    functionName: "buy",
    args: [tokenAddress, minAmountOut, sqrtPriceLimitX96, deadline, recipient],
    value: valueWei,
    chainId: ROBINHOOD_CHAIN_ID,
  });
  const receipt = await waitForTransactionReceipt(config, { hash, chainId: ROBINHOOD_CHAIN_ID });
  return { hash, receipt };
}

export async function sellTokenReal({ tokenAddress, tokenAmountWei, recipient, slippagePercent = 10 }) {
  const { sqrtPriceLimitX96, minAmountOut } = await getTradeQuote({ tokenAddress, side: "sell", amountIn: tokenAmountWei, slippagePercent });
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
    args: [tokenAddress, tokenAmountWei, minAmountOut, sqrtPriceLimitX96, deadline, recipient],
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
  { type: "function", name: "balanceOf", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
];

// Real on-chain read of a wallet's actual token balance — used to power
// the 25/50/100% quick-select buttons on the sell side.
export async function getTokenBalance({ tokenAddress, ownerAddress }) {
  const balance = await readContract(config, {
    address: tokenAddress,
    abi: ERC20_METADATA_ABI,
    functionName: "balanceOf",
    args: [ownerAddress],
    chainId: ROBINHOOD_CHAIN_ID,
  });
  return balance; // raw wei-denominated bigint
}

// ============================================================================
// User Portfolio — real "your launches" (filtering the full launch list by
// creator address, data we already fetch) and real "holdings" (checking
// this wallet's actual balance across every launched token). Honest
// scaling note: holdings does one balance check per token that exists,
// which is genuinely fine at today's token count but would need a real
// indexer once there are hundreds of tokens to check against.
// ============================================================================
export async function getUserPortfolio({ ownerAddress }) {
  const allLaunches = await getRealLaunches();
  const owner = ownerAddress.toLowerCase();

  const launched = allLaunches.filter((t) => t.creator.toLowerCase() === owner);

  const balances = await Promise.all(
    allLaunches.map((t) =>
      getTokenBalance({ tokenAddress: t.tokenAddress, ownerAddress })
        .then((bal) => ({ token: t, balance: bal }))
        .catch(() => ({ token: t, balance: 0n }))
    )
  );
  const holdings = balances
    .filter((b) => b.balance > 0n)
    .map((b) => ({ ...b.token, walletBalance: Number(b.balance) / 1e18 }));

  return { launched, holdings };
}

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
  let poolId = null;
  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({ abi: FACTORY_ABI, data: log.data, topics: log.topics });
      if (decoded.eventName === "TokenLaunched") {
        tokenAddress = decoded.args.token;
        poolId = decoded.args.poolId;
        break;
      }
    } catch {
      // Not every log matches this ABI — expected, just skip and keep scanning.
    }
  }

  return { hash, receipt, tokenAddress, poolId };
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
// ============================================================================
// Recent Trades and Holders — now routed through a shared, server-side
// cache (api/token-activity.js), not scanned directly from the browser.
// Without this, every visitor triggers their own full blockchain scan;
// with it, a 30-second-old answer is reused across everyone, and only the
// first request in that window does the real work.
// ============================================================================
// Surfaces the API's real error message (the handler's try/catch returns
// { error: error.message }) instead of masking every failure behind the
// same generic string regardless of cause — an RPC timeout, a reverted
// call, and a genuine bug all used to read identically to whoever saw the
// UI, making the server-side logging next to useless without direct log
// access. Falls back to the generic message only if the body itself can't
// be parsed (e.g. a non-JSON 502 from the platform, not from this handler).
async function throwApiError(res, fallbackMessage) {
  let message = fallbackMessage;
  try {
    const body = await res.json();
    if (body?.error) message = body.error;
  } catch {
    // Body wasn't JSON (e.g. a platform-level error, not from this
    // handler's own try/catch) - keep the fallback.
  }
  throw new Error(message);
}

export async function getRecentTrades({ poolId }) {
  const res = await fetch(`/api/token-activity?type=trades&poolId=${poolId}`);
  if (!res.ok) await throwApiError(res, "Failed to load recent trades");
  const { data } = await res.json();
  return data;
}

export async function getTokenHolders({ tokenAddress }) {
  const res = await fetch(`/api/token-activity?type=holders&tokenAddress=${tokenAddress}`);
  if (!res.ok) await throwApiError(res, "Failed to load holders");
  const { data } = await res.json();
  return data;
}

// ============================================================================
// Real-time progress refresh — used right after a trade completes, so the
// graduation bar and market cap reflect the trade that just happened
// instead of a stale snapshot from whenever the page first loaded. Only
// re-reads the numbers that actually change from a trade (cumulative
// fees, graduation status) — name/symbol/logo don't change from trading,
// so skipping those keeps this fast.
// ============================================================================
export async function getLaunchProgress({ poolId }) {
  const launchRaw = await readContract(config, {
    address: LAUNCHPAD_REGISTRY_ADDRESS,
    abi: REGISTRY_ABI,
    functionName: "launches",
    args: [poolId],
    chainId: ROBINHOOD_CHAIN_ID,
  });

  // Same positional destructuring as getRealLaunches, for the same reason
  // — no assumption about named property access on the decoded struct.
  const [, , cumulativeProtocolFeesUsd, graduationThresholdUsd, graduated] = launchRaw;

  return {
    marketCapUsd: Number(cumulativeProtocolFeesUsd) / 1e8,
    graduationThresholdUsd: Number(graduationThresholdUsd) / 1e8,
    graduated,
  };
}

// Real, shared, server-side cache — same pattern as trades and holders.
// Was previously doing a full Registry scan (a read per token, plus two
// more per token for name/symbol) directly in the browser on every single
// Explore page visit. Now the first request in any 60-second window does
// that real work once; everyone after that just reads the saved result.
export async function getRealLaunches() {
  const res = await fetch("/api/token-activity?type=launches");
  if (!res.ok) await throwApiError(res, "Failed to load launches");
  const { data } = await res.json();
  return data;
}

// Per-pool volume/last-buy-time, powering Explore's "Recent buys" sort.
// Deliberately called separately from getRealLaunches, never Promise.all'd
// together — a slow or failing scan here must never block or blank out
// the core token list, only degrade "Recent buys" specifically. See
// api/token-activity.js's fetchAllSwapLogs comment for the incident this
// separation exists because of.
export async function getLaunchStats() {
  const res = await fetch("/api/token-activity?type=launch-stats");
  if (!res.ok) await throwApiError(res, "Failed to load launch stats");
  const { data } = await res.json();
  return data;
}

// Real, protocol-wide trading volume — a genuine scan over every Swap
// event across every Mango pool on Robinhood Chain's shared PoolManager,
// not an estimate. See api/token-activity.js's fetchProtocolStats for why
// this deliberately does NOT also cover "total creator fees paid out."
export async function getProtocolStats() {
  const res = await fetch("/api/token-activity?type=protocol-stats");
  if (!res.ok) await throwApiError(res, "Failed to load protocol stats");
  const { data } = await res.json();
  return data;
}
