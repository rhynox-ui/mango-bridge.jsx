// src/pancakeswapV3.js
//
// Direct, no-API-key PancakeSwap V3 fallback via their own Universal
// Router — same real motivation as uniswapV3.js/uniswapV4.js/
// sushiswapV2.js (see those files' own headers): Robinhood Chain
// (4663) needs every real, independent liquidity source it can get,
// with no third-party API/key to fail on.
//
// Direct port of mango-mobile's own pancakeswapV3.js — same verified
// addresses/ABIs, ported here per this repo's own SAS.md durable
// instruction ("every treatment applies to both repos"). See that
// file's own header for exactly where every address/ABI/encoding
// detail came from (PancakeSwap's own published npm packages, pulled
// via `npm pack` + reading the installed source — never guessed). The
// one real difference from the mobile port: this app has no embedded
// key — execution signs through the user's CONNECTED wallet (wagmi's
// writeContract/simulateContract/readContract against `config`, with
// an explicit chainId per call), same as this repo's own uniswapV3.js/
// uniswapV4.js/sushiswapV2.js ports already do.
//
// Deliberately scoped to Robinhood Chain ONLY, not the other chains
// this app supports (ethereum/bnb/arbitrum/base, where PancakeSwap V3
// is also deployed) — real, disclosed limitation, not an oversight:
// Robinhood Chain is the one chain where PancakeSwap's own published
// config gives a confirmed, chain-specific Permit2 address
// (0x31c2F6f...) DIFFERENT from the canonical shared Permit2 deployment
// every other chain typically uses. No confirmed per-chain Permit2
// address was found for ethereum/bnb/arbitrum/base specifically —
// using the canonical address there would very likely be correct (it
// usually is for a Uniswap-Universal-Router fork) but "very likely"
// isn't the bar this codebase holds contract addresses to. Extend this
// file the same way once that's independently confirmed for a given
// chain, rather than assuming.

import { encodeAbiParameters, encodePacked } from "viem";
import { readContract, writeContract, simulateContract, waitForTransactionReceipt } from "wagmi/actions";
import { config } from "./wagmi.js";
import { isNative } from "./uniswapV3.js";

export const PANCAKESWAP_V3_ADDRESSES = {
  4663: {
    factory: "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865",
    quoter: "0x8553AA1615549A86882151784b329B017aA7c832",
    universalRouter: "0xE28c0e44F4016b073db20cF28971CAc6ce3664D3",
    permit2: "0x31c2F6fcFf4F8759b3Bd5Bf0e1084A055615c768",
    wrappedNative: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  },
};

// PancakeSwap V3's own factory-enabled tiers — genuinely different
// from Uniswap V3's (500/3000/10000/100) — see this file's own header.
const FEE_TIERS = [500, 2500, 10000, 100];

const MAX_UINT160 = 2n ** 160n - 1n;
const PERMIT2_ALLOWANCE_TTL_SECONDS = 30 * 24 * 60 * 60;

const QUOTER_ABI = [{
  type: "function",
  name: "quoteExactInputSingle",
  stateMutability: "nonpayable",
  inputs: [
    { name: "tokenIn", type: "address" },
    { name: "tokenOut", type: "address" },
    { name: "fee", type: "uint24" },
    { name: "amountIn", type: "uint256" },
    { name: "sqrtPriceLimitX96", type: "uint160" },
  ],
  outputs: [{ name: "amountOut", type: "uint256" }],
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

export function pancakeswapV3SupportsChain(chainId) {
  return Boolean(PANCAKESWAP_V3_ADDRESSES[chainId]);
}

function resolvedPoolAddress(chainId, address) {
  return isNative(address) ? PANCAKESWAP_V3_ADDRESSES[chainId].wrappedNative : address;
}

/**
 * Quotes across PancakeSwap V3's own fee tiers via their Quoter's
 * quoteExactInputSingle (identical interface to Uniswap V3's own
 * QuoterV1, called read-only through simulateContract for the same
 * reason this repo's own uniswapV3.js's quote function does).
 */
export async function quotePancakeSwapV3({ chainId, tokenIn, tokenOut, amountIn }) {
  const addresses = PANCAKESWAP_V3_ADDRESSES[chainId];
  if (!addresses) return null;
  const poolTokenIn = resolvedPoolAddress(chainId, tokenIn);
  const poolTokenOut = resolvedPoolAddress(chainId, tokenOut);

  const attempts = await Promise.allSettled(
    FEE_TIERS.map((fee) =>
      simulateContract(config, {
        address: addresses.quoter,
        abi: QUOTER_ABI,
        functionName: "quoteExactInputSingle",
        args: [poolTokenIn, poolTokenOut, fee, amountIn, 0n],
        chainId,
      }).then(({ result }) => ({ fee, amountOut: result })),
    ),
  );

  let best = null;
  for (const attempt of attempts) {
    if (attempt.status !== "fulfilled") continue;
    if (!best || attempt.value.amountOut > best.amountOut) {
      best = attempt.value;
    }
  }
  return best;
}

/**
 * Executes a direct PancakeSwap V3 swap through their Universal
 * Router's V3_SWAP_EXACT_IN command (byte 0) — genuinely simpler than
 * Uniswap V4's own V4Planner-actions encoding since V3 has no
 * singleton-pool/action-list concept, just a single ABI-encoded
 * (recipient, amountIn, amountOutMin, path, payerIsUser) tuple, where
 * `path` is the same packed tokenIn+fee+tokenOut bytes format Uniswap
 * V3's own Quoter.quoteExactInput uses. A native sell needs a
 * prepended WRAP_ETH command (11) — V3 pools hold ERC-20 WETH, never
 * native value directly, unlike V4 — with `value: amountIn` sent on
 * the outer execute() call. An ERC-20 sell goes through Permit2 (token
 * -> Permit2, then Permit2 -> Universal Router), same two-step
 * approval this repo's own uniswapV4.js header explains in full —
 * PancakeSwap's Universal Router is an explicit fork of Uniswap's,
 * confirmed by the identical execute() signature and command-byte
 * scheme.
 */
export async function executePancakeSwapV3Swap({ chainId, account, tokenIn, tokenOut, amountIn, fee, minAmountOut }) {
  const addresses = PANCAKESWAP_V3_ADDRESSES[chainId];
  if (!addresses) {
    throw new Error(`PancakeSwap V3 isn't configured for chain ${chainId}.`);
  }
  const tokenInIsNative = isNative(tokenIn);
  const poolTokenIn = resolvedPoolAddress(chainId, tokenIn);
  const poolTokenOut = resolvedPoolAddress(chainId, tokenOut);

  if (!tokenInIsNative) {
    const erc20Allowance = await readContract(config, {
      address: poolTokenIn,
      abi: ERC20_ALLOWANCE_ABI,
      functionName: "allowance",
      args: [account, addresses.permit2],
      chainId,
    });
    if (erc20Allowance < amountIn) {
      const approveHash = await writeContract(config, {
        address: poolTokenIn,
        abi: ERC20_ALLOWANCE_ABI,
        functionName: "approve",
        args: [addresses.permit2, MAX_UINT160],
        chainId,
      });
      await waitForTransactionReceipt(config, { hash: approveHash, chainId });
    }

    const [permit2Amount, permit2Expiration] = await readContract(config, {
      address: addresses.permit2,
      abi: PERMIT2_ALLOWANCE_ABI,
      functionName: "allowance",
      args: [account, poolTokenIn, addresses.universalRouter],
      chainId,
    });
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (permit2Amount < amountIn || permit2Expiration <= nowSeconds) {
      const permit2ApproveHash = await writeContract(config, {
        address: addresses.permit2,
        abi: PERMIT2_ALLOWANCE_ABI,
        functionName: "approve",
        args: [poolTokenIn, addresses.universalRouter, MAX_UINT160, nowSeconds + PERMIT2_ALLOWANCE_TTL_SECONDS],
        chainId,
      });
      await waitForTransactionReceipt(config, { hash: permit2ApproveHash, chainId });
    }
  }

  const path = encodePacked(["address", "uint24", "address"], [poolTokenIn, fee, poolTokenOut]);
  // payerIsUser=true pulls tokenIn from the account via Permit2 as
  // part of this command; payerIsUser=false spends whatever the
  // router already holds in its own balance — the case right after a
  // WRAP_ETH command deposited native value there, same standard
  // Universal Router convention this file's own header documents
  // verifying against the V4 case.
  const swapInput = encodeAbiParameters(
    [{ name: "recipient", type: "address" }, { name: "amountIn", type: "uint256" }, { name: "amountOutMin", type: "uint256" }, { name: "path", type: "bytes" }, { name: "payerIsUser", type: "bool" }],
    [account, amountIn, minAmountOut, path, !tokenInIsNative],
  );

  let commands;
  let inputs;
  if (tokenInIsNative) {
    // WRAP_ETH (11) then V3_SWAP_EXACT_IN (0) — WRAP_ETH's own params
    // are (recipient, amountMin); ADDRESS_THIS-equivalent here is
    // simply the router itself receiving the wrap, then the swap
    // command spends it — same shape Uniswap's own Universal Router
    // uses for a native sell ahead of a V3/V4 swap command.
    const wrapInput = encodeAbiParameters(
      [{ name: "recipient", type: "address" }, { name: "amountMin", type: "uint256" }],
      ["0x0000000000000000000000000000000000000002", amountIn], // ADDRESS_THIS sentinel — Universal Router's own convention for "the router itself"
    );
    commands = encodePacked(["uint8", "uint8"], [11, 0]);
    inputs = [wrapInput, swapInput];
  } else {
    commands = encodePacked(["uint8"], [0]);
    inputs = [swapInput];
  }
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 20 * 60);

  const swapHash = await writeContract(config, {
    address: addresses.universalRouter,
    abi: UNIVERSAL_ROUTER_ABI,
    functionName: "execute",
    args: [commands, inputs, deadline],
    chainId,
    ...(tokenInIsNative ? { value: amountIn } : {}),
  });
  await waitForTransactionReceipt(config, { hash: swapHash, chainId });
  return { hash: swapHash };
}
