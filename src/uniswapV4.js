// src/uniswapV4.js
//
// Direct, no-API-key Uniswap V4 fallback via Universal Router — direct
// port of mango-mobile's own uniswapV4.js, same verified addresses/
// ABIs/encoding, ported here per this repo's own SAS.md durable
// instruction. See that file's own header for exactly where every
// value came from (Uniswap Labs' own published npm packages —
// @uniswap/universal-router-sdk, @uniswap/v4-sdk, @uniswap/v4-periphery,
// @uniswap/universal-router — pulled via `npm pack` + reading the
// installed source). The one real difference from the mobile port:
// this app has no embedded key — a non-native sell's real two-step
// Permit2 approval (token -> Permit2, then Permit2 -> Universal
// Router — confirmed from Universal Router's own Permit2Payments.sol/
// V4SwapRouter.sol source, see uniswapV4.js's own header on mobile for
// the full explanation) and the swap itself sign through the user's
// CONNECTED wallet (wagmi), same as fallbackDex.js's own
// executeFallbackQuote already does.
//
// Deliberately scoped to "vanilla" hookless pools at Uniswap's own
// standard fee-tier/tick-spacing pairings — same real, disclosed
// limitation as the mobile port: a pool with a custom hook can use ANY
// tick spacing/hooks address, not discoverable by bounded search
// without an off-chain indexer.

import { getAddress, encodeAbiParameters, encodePacked } from "viem";
import { readContract, writeContract, simulateContract, waitForTransactionReceipt } from "wagmi/actions";
import { config } from "./wagmi.js";
import { NATIVE_PLACEHOLDER, isNative, UNISWAP_V3_ADDRESSES } from "./uniswapV3.js";

// Universal Router (V2.1.1) per chain — verified source in uniswapV3.js's
// own header (same verification path applies here).
export const UNIVERSAL_ROUTER_ADDRESSES = {
  1: "0x4C82D1fBFe28C977cBB58D8C7FF8FCF9F70a2cCA",
  10: "0x8B844f885672f333Bc0042cB669255f93a4C1E6b",
  137: "0x8B844f885672f333Bc0042cB669255f93a4C1E6b",
  42161: "0x8B844f885672f333Bc0042cB669255f93a4C1E6b",
  8453: "0xfdf682f51fe81aa4898f0ae2163d8a55c127fbc7",
  56: "0x8B844f885672f333Bc0042cB669255f93a4C1E6b",
  43114: "0x8B844f885672f333Bc0042cB669255f93a4C1E6b",
  4663: "0x8876789976decbfcbbbe364623c63652db8c0904",
};

// Canonical Permit2 contract — same address on every EVM chain
// (deterministic CREATE2 deployment).
export const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

const FEE_TIER_TICK_SPACING = [
  { fee: 500, tickSpacing: 10 },
  { fee: 3000, tickSpacing: 60 },
  { fee: 10000, tickSpacing: 200 },
  { fee: 100, tickSpacing: 1 },
];

const NO_HOOKS = "0x0000000000000000000000000000000000000000";
const MAX_UINT160 = 2n ** 160n - 1n;
const PERMIT2_ALLOWANCE_TTL_SECONDS = 30 * 24 * 60 * 60;

const V4_QUOTER_ABI = [{
  type: "function",
  name: "quoteExactInputSingle",
  stateMutability: "nonpayable",
  inputs: [{
    name: "params",
    type: "tuple",
    components: [
      { name: "poolKey", type: "tuple", components: [
        { name: "currency0", type: "address" },
        { name: "currency1", type: "address" },
        { name: "fee", type: "uint24" },
        { name: "tickSpacing", type: "int24" },
        { name: "hooks", type: "address" },
      ] },
      { name: "zeroForOne", type: "bool" },
      { name: "exactAmount", type: "uint128" },
      { name: "hookData", type: "bytes" },
    ],
  }],
  outputs: [{ name: "amountOut", type: "uint256" }, { name: "gasEstimate", type: "uint256" }],
}];

const UNIVERSAL_ROUTER_ABI = [{
  type: "function",
  name: "execute",
  stateMutability: "payable",
  inputs: [
    { name: "commands", type: "bytes" },
    { name: "inputs", type: "bytes[]" },
    { name: "deadline", type: "uint256" },
  ],
  outputs: [],
}];

const ERC20_ALLOWANCE_ABI = [
  { type: "function", name: "allowance", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "approve", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "nonpayable" },
];

const PERMIT2_ALLOWANCE_ABI = [
  { type: "function", name: "allowance", inputs: [{ name: "owner", type: "address" }, { name: "token", type: "address" }, { name: "spender", type: "address" }], outputs: [{ name: "amount", type: "uint160" }, { name: "expiration", type: "uint48" }, { name: "nonce", type: "uint48" }], stateMutability: "view" },
  { type: "function", name: "approve", inputs: [{ name: "token", type: "address" }, { name: "spender", type: "address" }, { name: "amount", type: "uint160" }, { name: "expiration", type: "uint48" }], outputs: [], stateMutability: "nonpayable" },
];

export function uniswapV4SupportsChain(chainId) {
  return Boolean(UNIVERSAL_ROUTER_ADDRESSES[chainId] && UNISWAP_V3_ADDRESSES[chainId]);
}

function sortsBefore(currencyA, currencyB) {
  const aNative = getAddress(currencyA) === getAddress(NATIVE_PLACEHOLDER);
  const bNative = getAddress(currencyB) === getAddress(NATIVE_PLACEHOLDER);
  if (aNative) return true;
  if (bNative) return false;
  return currencyA.toLowerCase() < currencyB.toLowerCase();
}

function buildPoolKey(currencyA, currencyB, fee, tickSpacing) {
  const [currency0, currency1] = sortsBefore(currencyA, currencyB) ? [currencyA, currencyB] : [currencyB, currencyA];
  return {
    poolKey: { currency0: getAddress(currency0), currency1: getAddress(currency1), fee, tickSpacing, hooks: NO_HOOKS },
    zeroForOne: getAddress(currency0) === getAddress(getAddress(currencyA)),
  };
}

function poolCandidates(chainId, address) {
  if (!isNative(address)) return [address];
  return [NATIVE_PLACEHOLDER, UNISWAP_V3_ADDRESSES[chainId].wrappedNative];
}

export async function quoteUniswapV4({ chainId, tokenIn, tokenOut, amountIn }) {
  if (!uniswapV4SupportsChain(chainId)) return null;
  const quoterAddress = UNISWAP_V3_ADDRESSES[chainId].v4Quoter;

  const tokenInCandidates = poolCandidates(chainId, tokenIn);
  const tokenOutCandidates = poolCandidates(chainId, tokenOut);

  const attempts = [];
  for (const { fee, tickSpacing } of FEE_TIER_TICK_SPACING) {
    for (const candidateIn of tokenInCandidates) {
      for (const candidateOut of tokenOutCandidates) {
        if (getAddress(candidateIn) === getAddress(candidateOut)) continue;
        const { poolKey, zeroForOne } = buildPoolKey(candidateIn, candidateOut, fee, tickSpacing);
        attempts.push(
          simulateContract(config, {
            address: quoterAddress,
            abi: V4_QUOTER_ABI,
            functionName: "quoteExactInputSingle",
            args: [{ poolKey, zeroForOne, exactAmount: amountIn, hookData: "0x" }],
            chainId,
          }).then(({ result }) => ({
            amountOut: result[0],
            fee,
            tickSpacing,
            poolKey,
            zeroForOne,
            tokenInIsNative: getAddress(candidateIn) === getAddress(NATIVE_PLACEHOLDER),
          })),
        );
      }
    }
  }

  const settled = await Promise.allSettled(attempts);
  let best = null;
  for (const attempt of settled) {
    if (attempt.status !== "fulfilled") continue;
    if (!best || attempt.value.amountOut > best.amountOut) {
      best = attempt.value;
    }
  }
  return best;
}

function encodeV4SwapActions({ poolKey, zeroForOne, amountIn, minAmountOut, currencyIn, currencyOut }) {
  const actions = encodePacked(["uint8", "uint8", "uint8"], [6, 12, 15]);

  const swapParam = encodeAbiParameters(
    [{
      type: "tuple",
      components: [
        { name: "poolKey", type: "tuple", components: [
          { name: "currency0", type: "address" },
          { name: "currency1", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "hooks", type: "address" },
        ] },
        { name: "zeroForOne", type: "bool" },
        { name: "amountIn", type: "uint128" },
        { name: "amountOutMinimum", type: "uint128" },
        { name: "minHopPriceX36", type: "uint256" },
        { name: "hookData", type: "bytes" },
      ],
    }],
    [{ poolKey, zeroForOne, amountIn, amountOutMinimum: minAmountOut, minHopPriceX36: 0n, hookData: "0x" }],
  );

  const settleAllParam = encodeAbiParameters(
    [{ name: "currency", type: "address" }, { name: "maxAmount", type: "uint256" }],
    [currencyIn, amountIn],
  );
  const takeAllParam = encodeAbiParameters(
    [{ name: "currency", type: "address" }, { name: "minAmount", type: "uint256" }],
    [currencyOut, minAmountOut],
  );

  return encodeAbiParameters(
    [{ type: "bytes" }, { type: "bytes[]" }],
    [actions, [swapParam, settleAllParam, takeAllParam]],
  );
}

export async function executeUniswapV4Swap({ chainId, account, tokenIn, tokenOut, amountIn, poolKey, zeroForOne, minAmountOut }) {
  const routerAddress = UNIVERSAL_ROUTER_ADDRESSES[chainId];
  if (!routerAddress) {
    throw new Error(`Uniswap V4 isn't configured for chain ${chainId}.`);
  }
  const tokenInIsNative = isNative(tokenIn);
  const currencyIn = zeroForOne ? poolKey.currency0 : poolKey.currency1;
  const currencyOut = zeroForOne ? poolKey.currency1 : poolKey.currency0;

  if (!tokenInIsNative) {
    const erc20Allowance = await readContract(config, {
      address: currencyIn,
      abi: ERC20_ALLOWANCE_ABI,
      functionName: "allowance",
      args: [account, PERMIT2_ADDRESS],
      chainId,
    });
    if (erc20Allowance < amountIn) {
      const approveHash = await writeContract(config, {
        address: currencyIn,
        abi: ERC20_ALLOWANCE_ABI,
        functionName: "approve",
        args: [PERMIT2_ADDRESS, MAX_UINT160],
        chainId,
      });
      await waitForTransactionReceipt(config, { hash: approveHash, chainId });
    }

    const [permit2Amount, permit2Expiration] = await readContract(config, {
      address: PERMIT2_ADDRESS,
      abi: PERMIT2_ALLOWANCE_ABI,
      functionName: "allowance",
      args: [account, currencyIn, routerAddress],
      chainId,
    });
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (permit2Amount < amountIn || permit2Expiration <= nowSeconds) {
      const permit2ApproveHash = await writeContract(config, {
        address: PERMIT2_ADDRESS,
        abi: PERMIT2_ALLOWANCE_ABI,
        functionName: "approve",
        args: [currencyIn, routerAddress, MAX_UINT160, nowSeconds + PERMIT2_ALLOWANCE_TTL_SECONDS],
        chainId,
      });
      await waitForTransactionReceipt(config, { hash: permit2ApproveHash, chainId });
    }
  }

  const v4Input = encodeV4SwapActions({ poolKey, zeroForOne, amountIn, minAmountOut, currencyIn, currencyOut });
  const commands = encodePacked(["uint8"], [16]);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 20 * 60);

  const swapHash = await writeContract(config, {
    address: routerAddress,
    abi: UNIVERSAL_ROUTER_ABI,
    functionName: "execute",
    args: [commands, [v4Input], deadline],
    ...(tokenInIsNative ? { value: amountIn } : {}),
    chainId,
  });
  try {
    await waitForTransactionReceipt(config, { hash: swapHash, chainId });
  } catch (err) {
    // Real bug, live-reported (fallbackDex.js's own tryFallbackProviders
    // loop): swapHash above is a REAL broadcast transaction the instant
    // writeContract returns it — if only the receipt wait then throws
    // (a revert, or the wait itself timing out/erroring), this used to
    // lose that hash entirely, since it was never returned on the
    // throw path. The caller's retry-next-provider loop would then try
    // ANOTHER swap of the same sellAmount against a wallet whose real
    // on-chain balance/allowance had already changed — which is what
    // produced the reported screen (a real hash shown as "likely
    // succeeded", right next to a brand-new revert from a doomed next
    // attempt). Tagging it here lets that loop recognize a broadcast
    // already happened and stop instead of compounding it.
    err.broadcastHash = swapHash;
    throw err;
  }
  return { hash: swapHash };
}
