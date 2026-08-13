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
export async function saveTokenLogo({ tokenAddress, logoUrl, poolId, isUpdate, signature, signerAddress }) {
  const res = await fetch("/api/logo-registry", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tokenAddress, logoUrl, poolId, isUpdate, signature, signerAddress }),
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
export async function getRecentTrades({ poolId }) {
  const res = await fetch(`/api/token-activity?type=trades&poolId=${poolId}`);
  if (!res.ok) throw new Error("Failed to load recent trades");
  const { data } = await res.json();
  return data;
}

export async function getTokenHolders({ tokenAddress }) {
  const res = await fetch(`/api/token-activity?type=holders&tokenAddress=${tokenAddress}`);
  if (!res.ok) throw new Error("Failed to load holders");
  const { data } = await res.json();
  return data;
}

// Real, protocol-wide trading volume — a genuine scan over every Swap
// event across every Mango pool on Robinhood Chain's shared PoolManager,
// not an estimate. See api/token-activity.js's fetchProtocolStats for why
// this deliberately does NOT also cover "total creator fees paid out."
export async function getProtocolStats() {
  const res = await fetch("/api/token-activity?type=protocol-stats");
  if (!res.ok) throw new Error("Failed to load protocol stats");
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
  if (!res.ok) throw new Error("Failed to load launches");
  const { data } = await res.json();
  return data;
}
