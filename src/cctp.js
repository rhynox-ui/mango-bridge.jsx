import { readContract, writeContract, waitForTransactionReceipt, switchChain } from "wagmi/actions";
import { parseUnits, pad } from "viem";
import { config } from "./wagmi.js";

// Canonical CCTP V2 contract addresses — identical across supported EVM chains
// (deployed deterministically via CREATE2). Verified against Circle's docs and
// block explorers (Etherscan/Basescan) as of this build.
const TOKEN_MESSENGER_V2 = "0xBd3fa81B58Ba92a82136038B25aDec7066af3155";
const MESSAGE_TRANSMITTER_V2 = "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64";

// CCTP only supports this pair for real USDC transfers right now — see the
// project README for why BNB and Robinhood Chain aren't included here.
export const CCTP_CHAINS = {
  ethereum: { domain: 0, usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", chainId: 11155111 },
  base: { domain: 6, usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", chainId: 84532 },
};

export function isCctpSupportedPair(fromKey, toKey) {
  return !!CCTP_CHAINS[fromKey] && !!CCTP_CHAINS[toKey] && fromKey !== toKey;
}

// Dev fee: 1% of every real transfer is sent to this wallet before the burn.
// This is a plain, visible on-chain USDC transfer — not hidden in the CCTP
// call — so it shows up as its own transaction in the user's wallet/explorer.
export const DEV_FEE_WALLET = "0xf07becc2401a646fff10d10b969ef18b03582e88";
export const DEV_FEE_PCT = 0.01;

const ERC20_ABI = [
  { name: "approve", type: "function", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { name: "allowance", type: "function", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "transfer", type: "function", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
];

const TOKEN_MESSENGER_ABI = [
  {
    name: "depositForBurn",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "destinationDomain", type: "uint32" },
      { name: "mintRecipient", type: "bytes32" },
      { name: "burnToken", type: "address" },
      { name: "destinationCaller", type: "bytes32" },
      { name: "maxFee", type: "uint256" },
      { name: "minFinalityThreshold", type: "uint32" },
    ],
    outputs: [{ name: "nonce", type: "uint64" }],
  },
];

const MESSAGE_TRANSMITTER_ABI = [
  {
    name: "receiveMessage",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "message", type: "bytes" },
      { name: "attestation", type: "bytes" },
    ],
    outputs: [{ name: "success", type: "bool" }],
  },
];

function addressToBytes32(address) {
  return pad(address, { size: 32 });
}

async function pollAttestation(sourceDomain, txHash, { intervalMs = 3000, timeoutMs = 5 * 60 * 1000 } = {}) {
  const start = Date.now();
  const url = `https://iris-api-sandbox.circle.com/v2/messages/${sourceDomain}?transactionHash=${txHash}`;
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      const msg = data?.messages?.[0];
      if (msg && msg.status === "complete" && msg.attestation && msg.attestation !== "PENDING") {
        return msg;
      }
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("Timed out waiting for Circle's attestation. Your USDC was burned — check CCTPScan with your transaction hash before retrying.");
}

/**
 * Runs a real CCTP V2 transfer: approve -> send 1% dev fee -> burn remainder ->
 * wait for attestation -> mint. `onStep(key)` fires as each phase begins:
 * "approve" | "fee" | "burn" | "attest" | "mint" | "done".
 * Throws on any failure — callers should surface the error, not assume success.
 */
export async function runCctpTransfer({ fromKey, toKey, account, amountHuman, recipientAddress, onStep }) {
  const from = CCTP_CHAINS[fromKey];
  const to = CCTP_CHAINS[toKey];
  if (!from || !to) {
    throw new Error("CCTP only supports the Ethereum Sepolia <-> Base Sepolia pair right now.");
  }
  if (!account) throw new Error("No connected wallet account.");
  const recipient = recipientAddress || account;

  const amount = parseUnits(amountHuman, 6); // USDC uses 6 decimals
  const devFeeAmount = amount / 100n; // 1%, integer bigint division
  const burnAmount = amount - devFeeAmount;

  onStep?.("network");
  await switchChain(config, { chainId: from.chainId });

  onStep?.("approve");
  const currentAllowance = await readContract(config, {
    address: from.usdc,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [account, TOKEN_MESSENGER_V2],
    chainId: from.chainId,
  });
  if (currentAllowance < burnAmount) {
    const approveHash = await writeContract(config, {
      address: from.usdc,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [TOKEN_MESSENGER_V2, burnAmount],
      chainId: from.chainId,
    });
    await waitForTransactionReceipt(config, { hash: approveHash, chainId: from.chainId });
  }

  if (devFeeAmount > 0n) {
    onStep?.("fee");
    const feeHash = await writeContract(config, {
      address: from.usdc,
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [DEV_FEE_WALLET, devFeeAmount],
      chainId: from.chainId,
    });
    await waitForTransactionReceipt(config, { hash: feeHash, chainId: from.chainId });
  }

  onStep?.("burn");
  const burnHash = await writeContract(config, {
    address: TOKEN_MESSENGER_V2,
    abi: TOKEN_MESSENGER_ABI,
    functionName: "depositForBurn",
    args: [
      burnAmount,
      to.domain,
      addressToBytes32(recipient),
      from.usdc,
      addressToBytes32("0x0000000000000000000000000000000000000000"), // anyone can relay
      0n, // maxFee: 0 for a standard (non-Fast) transfer
      2000, // minFinalityThreshold: 2000 = wait for full finality
    ],
    chainId: from.chainId,
  });
  const burnReceipt = await waitForTransactionReceipt(config, { hash: burnHash, chainId: from.chainId });

  onStep?.("attest");
  const attestation = await pollAttestation(from.domain, burnReceipt.transactionHash);

  onStep?.("network-dest");
  await switchChain(config, { chainId: to.chainId });

  onStep?.("mint");
  const mintHash = await writeContract(config, {
    address: MESSAGE_TRANSMITTER_V2,
    abi: MESSAGE_TRANSMITTER_ABI,
    functionName: "receiveMessage",
    args: [attestation.message, attestation.attestation],
    chainId: to.chainId,
  });
  await waitForTransactionReceipt(config, { hash: mintHash, chainId: to.chainId });

  onStep?.("done");
  return { burnHash, mintHash };
}
