// src/sushiswapV2.js
//
// Direct, no-API-key SushiSwap V2 fallback — direct port of
// mango-mobile's own sushiswapV2.js, same verified addresses/ABIs,
// ported here per this repo's own SAS.md durable instruction. See
// that file's own header for exactly where every value came from
// (SushiSwap's own actively-maintained `sushi` npm package —
// `@sushiswap/sdk`/`@sushiswap/v2-sdk` are both marked DEPRECATED).
//
// Genuinely simpler than uniswapV3.js/uniswapV4.js: SushiSwap's V2
// router is a direct fork of Uniswap's own V2 Router02 — one router
// per chain, a plain `view` function for quoting (no simulateContract
// trick needed), and the router wraps/unwraps native value internally
// via its own ETH-suffixed functions. Uses the
// SupportingFeeOnTransferTokens swap variants deliberately — a custom
// pasted-CA token (the reason a second-source fallback exists at all)
// could be fee-on-transfer.

import { getAddress } from "viem";
import { readContract, writeContract, waitForTransactionReceipt } from "wagmi/actions";
import { config } from "./wagmi.js";
import { isNative, UNISWAP_V3_ADDRESSES } from "./uniswapV3.js";

export const SUSHISWAP_V2_ADDRESSES = {
  1: { factory: "0xc0aee478e3658e2610c5f7a4a2e1777ce9e4f2ac", router: "0xd9e1ce17f2641f24ae83637ab66a2cca9c378b9f" },
  10: { factory: "0xfbc12984689e5f15626bad03ad60160fe98b303c", router: "0x2abf469074dc0b54d793850807e6eb5faf2625b1" },
  137: { factory: "0xc35dadb65012ec5796536bd9864ed8773abc74c4", router: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506" },
  42161: { factory: "0xc35dadb65012ec5796536bd9864ed8773abc74c4", router: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506" },
  8453: { factory: "0x71524b4f93c58fcbf659783284e38825f0622859", router: "0x6bded42c6da8fbf0d2ba55b2fa120c5e0c8d7891" },
  56: { factory: "0xc35dadb65012ec5796536bd9864ed8773abc74c4", router: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506" },
  43114: { factory: "0xc35dadb65012ec5796536bd9864ed8773abc74c4", router: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506" },
  // Robinhood — the whole reason this file exists, same as
  // uniswapV3.js/uniswapV4.js.
  4663: { factory: "0xe52abd50ad151ecdf56427effd715e703696a6b1", router: "0x9a55d3d0c0f09859c7869510f53ed0a30b340766" },
};

const ROUTER_ABI = [
  {
    type: "function",
    name: "getAmountsOut",
    stateMutability: "view",
    inputs: [{ name: "amountIn", type: "uint256" }, { name: "path", type: "address[]" }],
    outputs: [{ name: "amounts", type: "uint256[]" }],
  },
  {
    type: "function",
    name: "swapExactTokensForTokensSupportingFeeOnTransferTokens",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "amountOutMin", type: "uint256" },
      { name: "path", type: "address[]" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "swapExactETHForTokensSupportingFeeOnTransferTokens",
    stateMutability: "payable",
    inputs: [
      { name: "amountOutMin", type: "uint256" },
      { name: "path", type: "address[]" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "swapExactTokensForETHSupportingFeeOnTransferTokens",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "amountOutMin", type: "uint256" },
      { name: "path", type: "address[]" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
];

const ERC20_ALLOWANCE_ABI = [
  { type: "function", name: "allowance", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "approve", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "nonpayable" },
];

export function sushiswapV2SupportsChain(chainId) {
  return Boolean(SUSHISWAP_V2_ADDRESSES[chainId]);
}

function poolAddress(chainId, address) {
  return isNative(address) ? UNISWAP_V3_ADDRESSES[chainId].wrappedNative : address;
}

export async function quoteSushiSwapV2({ chainId, tokenIn, tokenOut, amountIn }) {
  if (!sushiswapV2SupportsChain(chainId)) return null;
  const { router } = SUSHISWAP_V2_ADDRESSES[chainId];
  const path = [poolAddress(chainId, tokenIn), poolAddress(chainId, tokenOut)];
  try {
    const amounts = await readContract(config, {
      address: router,
      abi: ROUTER_ABI,
      functionName: "getAmountsOut",
      args: [amountIn, path],
      chainId,
    });
    return { amountOut: amounts[amounts.length - 1], path };
  } catch {
    return null;
  }
}

export async function executeSushiSwapV2Swap({ chainId, account, tokenIn, tokenOut, amountIn, minAmountOut }) {
  const addresses = SUSHISWAP_V2_ADDRESSES[chainId];
  if (!addresses) {
    throw new Error(`SushiSwap V2 isn't configured for chain ${chainId}.`);
  }
  const tokenInIsNative = isNative(tokenIn);
  const tokenOutIsNative = isNative(tokenOut);
  const path = [poolAddress(chainId, tokenIn), poolAddress(chainId, tokenOut)];
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 20 * 60);

  let swapHash;
  if (tokenInIsNative) {
    swapHash = await writeContract(config, {
      address: addresses.router,
      abi: ROUTER_ABI,
      functionName: "swapExactETHForTokensSupportingFeeOnTransferTokens",
      args: [minAmountOut, path, account, deadline],
      value: amountIn,
      chainId,
    });
  } else {
    const currentAllowance = await readContract(config, {
      address: getAddress(tokenIn),
      abi: ERC20_ALLOWANCE_ABI,
      functionName: "allowance",
      args: [account, addresses.router],
      chainId,
    });
    if (currentAllowance < amountIn) {
      const approveHash = await writeContract(config, {
        address: getAddress(tokenIn),
        abi: ERC20_ALLOWANCE_ABI,
        functionName: "approve",
        args: [addresses.router, amountIn],
        chainId,
      });
      await waitForTransactionReceipt(config, { hash: approveHash, chainId });
    }
    swapHash = await writeContract(config, {
      address: addresses.router,
      abi: ROUTER_ABI,
      functionName: tokenOutIsNative
        ? "swapExactTokensForETHSupportingFeeOnTransferTokens"
        : "swapExactTokensForTokensSupportingFeeOnTransferTokens",
      args: [amountIn, minAmountOut, path, account, deadline],
      chainId,
    });
  }
  await waitForTransactionReceipt(config, { hash: swapHash, chainId });
  return { hash: swapHash };
}
