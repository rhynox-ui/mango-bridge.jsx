import { getPublicClient, getWalletClient } from "wagmi/actions";
import { parseEther } from "viem";
import { sepolia, baseSepolia, mainnet, base, ink, unichain } from "wagmi/chains";
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
import { DEV_FEE_PCT } from "./devFeeWallets.js";

const DEV_FEE_WALLET = "0xf07becc2401a646fff10d10b969ef18b03582e88";
// No $50 cap here (unlike cctp.js's USDC path or Relay's own appFees) —
// this fee is denominated in ETH itself and this file has no live
// ETH/USD price feed to size a cap against; never fabricate one.
const DEV_FEE_BPS = BigInt(Math.round(DEV_FEE_PCT * 10000));

// Base, Ink, and Unichain are all first-class OP Stack chains in viem — each
// ships with its own real l1StandardBridge/portal/disputeGameFactory
// contract addresses baked into the chain definition, no custom lookup
// needed here. Ink's and Unichain's addresses were independently
// cross-checked against Optimism's own superchain-registry (the canonical
// source for OP Stack chain configs) and matched byte-for-byte with what
// viem ships, before this was wired up.
const L2_MAINNET_CHAINS = { base, ink, unichain };

// Swapping sepolia/baseSepolia for mainnet/<l2> is the entire mainnet
// transition for this file. Ink and Unichain have no testnet wiring in this
// app (see wagmi.js — CHAIN_KEY_TO_WAGMI_TESTNET only covers the original
// four chains), so bridging to/from them is mainnet-only; asking for one in
// testnet mode is a clear error rather than silently falling back to the
// wrong chain.
function l1Chain() { return isMainnet() ? mainnet : sepolia; }
function l2Chain(l2Key = "base") {
  if (!isMainnet()) {
    if (l2Key !== "base") throw new Error(`${l2Key} bridging is only available on mainnet — this app's testnet mode only wires up Base.`);
    return baseSepolia;
  }
  const chain = L2_MAINNET_CHAINS[l2Key];
  if (!chain) throw new Error(`Unknown OP Stack chain key: ${l2Key}`);
  return chain;
}

function l1Public() {
  return getPublicClient(config, { chainId: l1Chain().id }).extend(publicActionsL1());
}
function l2Public(l2Key) {
  return getPublicClient(config, { chainId: l2Chain(l2Key).id }).extend(publicActionsL2());
}
async function l1Wallet() {
  const client = await getWalletClient(config, { chainId: l1Chain().id });
  return client.extend(walletActionsL1());
}
async function l2Wallet(l2Key) {
  const client = await getWalletClient(config, { chainId: l2Chain(l2Key).id });
  return client.extend(walletActionsL2());
}

/**
 * Real ETH deposit: Ethereum -> Base / Ink / Unichain (whichever l2Key names).
 * Fast (a few minutes) — no challenge period on the deposit direction.
 */
export async function runOpDeposit({ account, amountHuman, onStep, l2Key = "base" }) {
  const totalValue = parseEther(amountHuman);
  const feeValue = (totalValue * DEV_FEE_BPS) / 10000n;
  const value = totalValue - feeValue;

  onStep?.("fee");
  if (feeValue > 0n) {
    const walletL1Fee = await l1Wallet();
    const feeHash = await walletL1Fee.sendTransaction({ to: DEV_FEE_WALLET, value: feeValue });
    const publicL1Fee = l1Public();
    await publicL1Fee.waitForTransactionReceipt({ hash: feeHash });
  }

  onStep?.("build");
  const publicL2 = l2Public(l2Key);
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
 * Step 1 of a real ETH withdrawal: Base / Ink / Unichain -> Ethereum.
 * This only *initiates* the withdrawal. Proving and finalizing happen
 * later — see proveOpWithdrawal / finalizeOpWithdrawal below.
 */
export async function initiateOpWithdrawal({ account, amountHuman, onStep, l2Key = "base" }) {
  const totalValue = parseEther(amountHuman);
  const feeValue = (totalValue * DEV_FEE_BPS) / 10000n;
  const value = totalValue - feeValue;

  onStep?.("fee");
  if (feeValue > 0n) {
    const walletL2Fee = await l2Wallet(l2Key);
    const feeHash = await walletL2Fee.sendTransaction({ to: DEV_FEE_WALLET, value: feeValue });
    const publicL2Fee = l2Public(l2Key);
    await publicL2Fee.waitForTransactionReceipt({ hash: feeHash });
  }

  onStep?.("build");
  const publicL1 = l1Public();
  const args = await publicL1.buildInitiateWithdrawal({ to: account, value });

  onStep?.("withdraw");
  const walletL2 = await l2Wallet(l2Key);
  const hash = await walletL2.initiateWithdrawal(args);
  onStep?.({ key: "hash-known", l2TxHash: hash });

  onStep?.("l2-confirm");
  const publicL2 = l2Public(l2Key);
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
export async function trackWithdrawalByHash({ l2TxHash, l2Key = "base" }) {
  const publicL2 = l2Public(l2Key);
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
export async function getOpWithdrawalStatus({ l2TxHash, l2Timestamp, l2Key = "base" }) {
  const publicL1 = l1Public();
  const publicL2 = l2Public(l2Key);
  const receipt = await publicL2.getTransactionReceipt({ hash: l2TxHash });
  const status = await publicL1.getWithdrawalStatus({
    receipt,
    l2Timestamp,
    targetChain: l2Chain(l2Key),
  });
  let etaSeconds = null;
  try {
    if (status === "waiting-to-prove") {
      const t = await publicL1.getTimeToProve({ receipt, l2Timestamp, targetChain: l2Chain(l2Key) });
      etaSeconds = t?.seconds ?? null;
    } else if (status === "waiting-to-finalize") {
      const t = await publicL1.getTimeToFinalize({ receipt, targetChain: l2Chain(l2Key) });
      etaSeconds = t?.seconds ?? null;
    }
  } catch (e) {
    // ETA lookup is best-effort; status itself is still valid without it
  }
  return { status, etaSeconds };
}

/** Step 2: prove the withdrawal on L1, once status is 'ready-to-prove'. */
export async function proveOpWithdrawal({ l2TxHash, l2Timestamp, onStep, l2Key = "base" }) {
  const publicL1 = l1Public();
  const publicL2 = l2Public(l2Key);
  const receipt = await publicL2.getTransactionReceipt({ hash: l2TxHash });

  onStep?.("wait-ready");
  const { output, withdrawal } = await publicL1.waitToProve({
    receipt,
    l2Timestamp,
    targetChain: l2Chain(l2Key),
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
export async function finalizeOpWithdrawal({ l2TxHash, onStep, l2Key = "base" }) {
  const publicL1 = l1Public();
  const publicL2 = l2Public(l2Key);
  const receipt = await publicL2.getTransactionReceipt({ hash: l2TxHash });
  const [withdrawal] = getWithdrawals(receipt);

  onStep?.("wait-ready");
  await publicL1.waitToFinalize({ targetChain: l2Chain(l2Key), withdrawalHash: withdrawal.withdrawalHash });

  onStep?.("finalize");
  const walletL1 = await l1Wallet();
  const hash = await walletL1.finalizeWithdrawal({ targetChain: l2Chain(l2Key), withdrawal });

  onStep?.("confirm");
  await publicL1.waitForTransactionReceipt({ hash });

  onStep?.("done");
  return { finalizeHash: hash };
}
