import { getPublicClient, getWalletClient } from "wagmi/actions";
import { parseEther } from "viem";
import { sepolia, baseSepolia, mainnet, base } from "wagmi/chains";
import {
  publicActionsL1,
  publicActionsL2,
  walletActionsL1,
  walletActionsL2,
  getL2TransactionHashes,
  getWithdrawals,
} from "viem/op-stack";
import { config } from "./wagmi.js";
import { isMainnet } from "./networkMode.js";

// Base is a first-class supported chain in viem — unlike Robinhood Chain, no
// custom contract addresses need to be looked up or verified here. Swapping
// sepolia/baseSepolia for mainnet/base is the entire mainnet transition for
// this file.
function l1Chain() { return isMainnet() ? mainnet : sepolia; }
function l2Chain() { return isMainnet() ? base : baseSepolia; }

function l1Public() {
  return getPublicClient(config, { chainId: l1Chain().id }).extend(publicActionsL1());
}
function l2Public() {
  return getPublicClient(config, { chainId: l2Chain().id }).extend(publicActionsL2());
}
async function l1Wallet() {
  const client = await getWalletClient(config, { chainId: l1Chain().id });
  return client.extend(walletActionsL1());
}
async function l2Wallet() {
  const client = await getWalletClient(config, { chainId: l2Chain().id });
  return client.extend(walletActionsL2());
}

/**
 * Real ETH deposit: Ethereum Sepolia -> Base Sepolia.
 * Fast (a few minutes) — no challenge period on the deposit direction.
 */
export async function runOpDeposit({ account, amountHuman, onStep }) {
  const value = parseEther(amountHuman);

  onStep?.("build");
  const publicL2 = l2Public();
  const args = await publicL2.buildDepositTransaction({ mint: value, to: account });

  onStep?.("deposit");
  const walletL1 = await l1Wallet();
  const hash = await walletL1.depositTransaction(args);

  onStep?.("l1-confirm");
  const publicL1 = l1Public();
  const receipt = await publicL1.waitForTransactionReceipt({ hash });
  const [l2Hash] = getL2TransactionHashes(receipt);

  onStep?.("l2-confirm");
  const l2Receipt = await publicL2.waitForTransactionReceipt({ hash: l2Hash });

  onStep?.("done");
  return { l1Hash: hash, l2Hash };
}

async function getBlockWithRetry(client, blockNumber, attempts = 6, delayMs = 2000) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await client.getBlock({ blockNumber });
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

/**
 * Step 1 of a real ETH withdrawal: Base Sepolia -> Ethereum Sepolia.
 * This only *initiates* the withdrawal. Proving and finalizing happen
 * later — see proveOpWithdrawal / finalizeOpWithdrawal below.
 */
export async function initiateOpWithdrawal({ account, amountHuman, onStep }) {
  const value = parseEther(amountHuman);

  onStep?.("build");
  const publicL1 = l1Public();
  const args = await publicL1.buildInitiateWithdrawal({ to: account, value });

  onStep?.("withdraw");
  const walletL2 = await l2Wallet();
  const hash = await walletL2.initiateWithdrawal(args);
  onStep?.({ key: "hash-known", l2TxHash: hash });

  onStep?.("l2-confirm");
  const publicL2 = l2Public();
  const receipt = await publicL2.waitForTransactionReceipt({ hash });
  const block = await getBlockWithRetry(publicL2, receipt.blockNumber);

  onStep?.("done");
  return { l2TxHash: hash, l2Timestamp: Number(block.timestamp) };
}

/**
 * Recovery helper: if a withdrawal transaction succeeded on-chain but the app
 * failed to save it (e.g. an RPC hiccup right after), this reconstructs the
 * tracking record from just the L2 transaction hash.
 */
export async function trackWithdrawalByHash({ l2TxHash }) {
  const publicL2 = l2Public();
  const receipt = await publicL2.getTransactionReceipt({ hash: l2TxHash });
  if (receipt.status !== "success") {
    throw new Error("That transaction did not succeed on-chain — nothing to track.");
  }
  const block = await getBlockWithRetry(publicL2, receipt.blockNumber);
  return { l2TxHash, l2Timestamp: Number(block.timestamp) };
}

/**
 * Checks where a withdrawal currently stands. Returns one of:
 * 'waiting-to-prove' | 'ready-to-prove' | 'waiting-to-finalize' | 'ready-to-finalize' | 'finalized'
 */
export async function getOpWithdrawalStatus({ l2TxHash, l2Timestamp }) {
  const publicL1 = l1Public();
  const publicL2 = l2Public();
  const receipt = await publicL2.getTransactionReceipt({ hash: l2TxHash });
  const status = await publicL1.getWithdrawalStatus({
    receipt,
    l2Timestamp,
    targetChain: l2Chain(),
  });
  let etaSeconds = null;
  try {
    if (status === "waiting-to-prove") {
      const t = await publicL1.getTimeToProve({ receipt, l2Timestamp, targetChain: l2Chain() });
      etaSeconds = t?.seconds ?? null;
    } else if (status === "waiting-to-finalize") {
      const t = await publicL1.getTimeToFinalize({ receipt, targetChain: l2Chain() });
      etaSeconds = t?.seconds ?? null;
    }
  } catch (e) {
    // ETA lookup is best-effort; status itself is still valid without it
  }
  return { status, etaSeconds };
}

/** Step 2: prove the withdrawal on L1, once status is 'ready-to-prove'. */
export async function proveOpWithdrawal({ l2TxHash, l2Timestamp, onStep }) {
  const publicL1 = l1Public();
  const publicL2 = l2Public();
  const receipt = await publicL2.getTransactionReceipt({ hash: l2TxHash });

  onStep?.("wait-ready");
  const { output, withdrawal } = await publicL1.waitToProve({
    receipt,
    l2Timestamp,
    targetChain: l2Chain(),
  });

  onStep?.("build");
  const args = await publicL2.buildProveWithdrawal({ output, withdrawal });

  onStep?.("prove");
  const walletL1 = await l1Wallet();
  const hash = await walletL1.proveWithdrawal(args);

  onStep?.("confirm");
  await publicL1.waitForTransactionReceipt({ hash });

  onStep?.("done");
  return { proveHash: hash };
}

/** Step 3: finalize the withdrawal on L1, once status is 'ready-to-finalize'. */
export async function finalizeOpWithdrawal({ l2TxHash, onStep }) {
  const publicL1 = l1Public();
  const publicL2 = l2Public();
  const receipt = await publicL2.getTransactionReceipt({ hash: l2TxHash });
  const [withdrawal] = getWithdrawals(receipt);

  onStep?.("wait-ready");
  await publicL1.waitToFinalize({ targetChain: l2Chain(), withdrawalHash: withdrawal.withdrawalHash });

  onStep?.("finalize");
  const walletL1 = await l1Wallet();
  const hash = await walletL1.finalizeWithdrawal({ targetChain: l2Chain(), withdrawal });

  onStep?.("confirm");
  await publicL1.waitForTransactionReceipt({ hash });

  onStep?.("done");
  return { finalizeHash: hash };
}
