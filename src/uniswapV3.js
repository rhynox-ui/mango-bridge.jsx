// src/uniswapV3.js
//
// Direct, no-API-key Uniswap V3 fallback: calls the real, public
// QuoterV1 and SwapRouter02 contracts on-chain, the same way any other
// DeFi client does — no account, no signup, no key to rotate, and
// nothing to proxy through this app's own backend (unlike
// fallbackDex.js's other four providers, which all need a real
// developer API key that must never ship inside this app's own client
// bundle — see that file's own header).
//
// Direct port of mango-mobile's own uniswapV3.js — same verified
// addresses/ABIs, ported here per this repo's own SAS.md durable
// instruction ("every treatment applies to both repos"). See that
// file's own header for exactly where every address came from
// (Uniswap Labs' own published @uniswap/sdk-core npm package, pulled
// via `npm pack` + reading the installed source after
// developers.uniswap.org and the Robinhood Chain explorer were both
// blocked in the build sandbox — never guessed). The one real
// difference from the mobile port: this app has no embedded key —
// execution signs through the user's CONNECTED wallet (wagmi's
// writeContract/simulateContract/readContract against `config`, with
// an explicit chainId per call), same as fallbackDex.js's own
// executeFallbackQuote already does for 1inch/0x/okx/kyberswap.
//
// V3 only for now — V4 uses a singleton PoolManager with an
// unlock/callback pattern and no direct external swap entrypoint (it
// needs its own periphery router on top, e.g. Universal Router) — see
// this repo's own uniswapV4.js for that.

import { getAddress } from "viem";
import { readContract, writeContract, simulateContract, waitForTransactionReceipt } from "wagmi/actions";
import { config } from "./wagmi.js";

export const NATIVE_PLACEHOLDER = "0x0000000000000000000000000000000000000000";

// chainId -> real, verified contract addresses. See this file's own
// header for exactly where every one of these came from.
export const UNISWAP_V3_ADDRESSES = {
  1: {
    factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    quoter: "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6",
    swapRouter02: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
    wrappedNative: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    v4PoolManager: "0x000000000004444c5dc75cB358380D2e3dE08A90",
    v4Quoter: "0x52f0e24d1c21c8a0cb1e5a5dd6198556bd9e1203",
    v4StateView: "0x7ffe42c4a5deea5b0fec41c94c136cf115597227",
  },
  10: {
    factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    quoter: "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6",
    swapRouter02: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
    wrappedNative: "0x4200000000000000000000000000000000000006",
    v4PoolManager: "0x9a13f98cb987694c9f086b1f5eb990eea8264ec3",
    v4Quoter: "0x1f3131a13296fb91c90870043742c3cdbff1a8d7",
    v4StateView: "0xc18a3169788f4f75a170290584eca6395c75ecdb",
  },
  137: {
    factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    quoter: "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6",
    swapRouter02: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
    wrappedNative: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
    v4PoolManager: "0x67366782805870060151383f4bbff9dab53e5cd6",
    v4Quoter: "0xb3d5c3dfc3a7aebff71895a7191796bffc2c81b9",
    v4StateView: "0x5ea1bd7974c8a611cbab0bdcafcb1d9cc9b3ba5a",
  },
  42161: {
    factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    quoter: "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6",
    swapRouter02: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
    wrappedNative: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    v4PoolManager: "0x360e68faccca8ca495c1b759fd9eee466db9fb32",
    v4Quoter: "0x3972c00f7ed4885e145823eb7c655375d275a1c5",
    v4StateView: "0x76fd297e2d437cd7f76d50f01afe6160f86e9990",
  },
  8453: {
    factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
    quoter: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
    swapRouter02: "0x2626664c2603336E57B271c5C0b26F421741e481",
    wrappedNative: "0x4200000000000000000000000000000000000006",
    v4PoolManager: "0x498581ff718922c3f8e6a244956af099b2652b2b",
    v4Quoter: "0x0d5e0f971ed27fbff6c2837bf31316121532048d",
    v4StateView: "0xa3c0c9b65bad0b08107aa264b0f3db444b867a71",
  },
  56: {
    factory: "0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7",
    quoter: "0x78D78E420Da98ad378D7799bE8f4AF69033EB077",
    swapRouter02: "0xB971eF87ede563556b2ED4b1C0b0019111Dd85d2",
    wrappedNative: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    v4PoolManager: "0x28e2ea090877bf75740558f6bfb36a5ffee9e9df",
    v4Quoter: "0x9f75dd27d6664c475b90e105573e550ff69437b0",
    v4StateView: "0xd13dd3d6e93f276fafc9db9e6bb47c1180aee0c4",
  },
  43114: {
    factory: "0x740b1c1de25031C31FF4fC9A62f554A55cdC1baD",
    quoter: "0xbe0F5544EC67e9B3b2D979aaA43f18Fd87E6257F",
    swapRouter02: "0xbb00FF08d01D300023C629E8fFfFcb65A5a578cE",
    wrappedNative: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7",
    v4PoolManager: "0x06380c0e0912312b5150364b9dc4542ba0dbbc85",
    v4Quoter: "0xbe40675bb704506a3c2ccfb762dcfd1e979845c2",
    v4StateView: "0xc3c9e198c735a4b97e3e683f391ccbdd60b69286",
  },
  // Robinhood — the whole reason this module exists on mobile, ported
  // here for the same reason: this app's own fallback-quote.js has
  // NO working provider for chain 4663 at all.
  4663: {
    factory: "0x1f7d7550b1b028f7571e69a784071f0205fd2efa",
    quoter: "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7",
    swapRouter02: "0xcaf681a66d020601342297493863e78c959e5cb2",
    wrappedNative: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
    v4PoolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
    v4Quoter: "0x8dc178efb8111bb0973dd9d722ebeff267c98f94",
    v4StateView: "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b",
  },
};

const FEE_TIERS = [500, 3000, 10000, 100];

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

const SWAP_ROUTER_02_ABI = [{
  type: "function",
  name: "exactInputSingle",
  stateMutability: "payable",
  inputs: [{
    name: "params",
    type: "tuple",
    components: [
      { name: "tokenIn", type: "address" },
      { name: "tokenOut", type: "address" },
      { name: "fee", type: "uint24" },
      { name: "recipient", type: "address" },
      { name: "amountIn", type: "uint256" },
      { name: "amountOutMinimum", type: "uint256" },
      { name: "sqrtPriceLimitX96", type: "uint160" },
    ],
  }],
  outputs: [{ name: "amountOut", type: "uint256" }],
}];

const WRAPPED_NATIVE_ABI = [
  { type: "function", name: "deposit", stateMutability: "payable", inputs: [], outputs: [] },
];

const ERC20_ALLOWANCE_ABI = [
  { type: "function", name: "allowance", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "approve", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "nonpayable" },
];

export function uniswapV3SupportsChain(chainId) {
  return Boolean(UNISWAP_V3_ADDRESSES[chainId]);
}

export function isNative(address) {
  return getAddress(address) === getAddress(NATIVE_PLACEHOLDER);
}

function resolvedPoolAddress(chainId, address) {
  return isNative(address) ? UNISWAP_V3_ADDRESSES[chainId].wrappedNative : address;
}

export async function quoteUniswapV3({ chainId, tokenIn, tokenOut, amountIn }) {
  const addresses = UNISWAP_V3_ADDRESSES[chainId];
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

export async function executeUniswapV3Swap({ chainId, account, tokenIn, tokenOut, amountIn, fee, minAmountOut }) {
  const addresses = UNISWAP_V3_ADDRESSES[chainId];
  if (!addresses) {
    throw new Error(`Uniswap V3 isn't configured for chain ${chainId}.`);
  }
  const poolTokenIn = resolvedPoolAddress(chainId, tokenIn);
  const poolTokenOut = resolvedPoolAddress(chainId, tokenOut);

  if (isNative(tokenIn)) {
    const wrapHash = await writeContract(config, {
      address: addresses.wrappedNative,
      abi: WRAPPED_NATIVE_ABI,
      functionName: "deposit",
      value: amountIn,
      chainId,
    });
    await waitForTransactionReceipt(config, { hash: wrapHash, chainId });
  }

  const currentAllowance = await readContract(config, {
    address: poolTokenIn,
    abi: ERC20_ALLOWANCE_ABI,
    functionName: "allowance",
    args: [account, addresses.swapRouter02],
    chainId,
  });
  if (currentAllowance < amountIn) {
    const approveHash = await writeContract(config, {
      address: poolTokenIn,
      abi: ERC20_ALLOWANCE_ABI,
      functionName: "approve",
      args: [addresses.swapRouter02, amountIn],
      chainId,
    });
    await waitForTransactionReceipt(config, { hash: approveHash, chainId });
  }

  const swapHash = await writeContract(config, {
    address: addresses.swapRouter02,
    abi: SWAP_ROUTER_02_ABI,
    functionName: "exactInputSingle",
    args: [{
      tokenIn: poolTokenIn,
      tokenOut: poolTokenOut,
      fee,
      recipient: account,
      amountIn,
      amountOutMinimum: minAmountOut,
      sqrtPriceLimitX96: 0n,
    }],
    chainId,
  });
  try {
    await waitForTransactionReceipt(config, { hash: swapHash, chainId });
  } catch (err) {
    // Same real fix as uniswapV4.js's own executeUniswapV4Swap — see
    // its comment for the full reasoning (fallbackDex.js's retry loop
    // needs this hash to know a real swap already broadcast).
    err.broadcastHash = swapHash;
    throw err;
  }
  return { hash: swapHash };
}
