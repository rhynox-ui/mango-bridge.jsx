import { readContract, writeContract, waitForTransactionReceipt } from "wagmi/actions";
import { config } from "./wagmi.js";

// ============================================================================
// Real, deployed, verified addresses on Robinhood Chain mainnet — not
// placeholders. Confirmed independently on Blockscout, same rigor as every
// other address used throughout this project.
// ============================================================================
export const LAUNCHPAD_FACTORY_ADDRESS = "0xA2103eb3aaB95A364c2D2f9f441396B2bC0632b1";
export const LAUNCHPAD_HOOK_ADDRESS = "0x01aC474F17E4d8b29f9f212757953C5E505ad040"; // v2, current
export const LAUNCHPAD_REGISTRY_ADDRESS = "0xC94D2b02Ce52224dE6A7C0153CE89AbE9a5f7f06"; // v2, current
export const ROBINHOOD_CHAIN_ID = 4663;

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
  return { hash, receipt };
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
    const launch = await readContract(config, {
      address: LAUNCHPAD_REGISTRY_ADDRESS,
      abi: REGISTRY_ABI,
      functionName: "launches",
      args: [poolId],
      chainId: ROBINHOOD_CHAIN_ID,
    });
    launches.push({ poolId, ...launch });
  }
  return launches;
}
