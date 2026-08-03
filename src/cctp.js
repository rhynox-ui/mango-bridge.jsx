import { readContract, writeContract, waitForTransactionReceipt, switchChain } from "wagmi/actions";
import { parseUnits, pad } from "viem";
import { config } from "./wagmi.js";
import { isMainnet } from "./networkMode.js";

// Shared CCTP V2 contract addresses on TESTNET — identical across Ethereum
// and Base testnet (deployed deterministically via CREATE2). Arc testnet has
// its own distinct deployment (see below) — verified directly against Arc's
// official contract-addresses reference, not assumed.
const TESTNET_SHARED_TOKEN_MESSENGER_V2 = "0xBd3fa81B58Ba92a82136038B25aDec7066af3155";
const TESTNET_SHARED_MESSAGE_TRANSMITTER_V2 = "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64";

// Shared CCTP V2 contract addresses on MAINNET. Independently verified via
// Circle's own docs plus cross-checking Etherscan/BaseScan/LineaScan.
// IMPORTANT: TokenMessengerV2's mainnet address is DIFFERENT from testnet's —
// MessageTransmitterV2 happens to share the same address on both networks,
// but that's a coincidence, not a pattern; never assume one from the other.
const MAINNET_SHARED_TOKEN_MESSENGER_V2 = "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d";
const MAINNET_SHARED_MESSAGE_TRANSMITTER_V2 = "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64";

const CCTP_CHAINS_TESTNET = {
  ethereum: { domain: 0, usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", chainId: 11155111, tokenMessenger: TESTNET_SHARED_TOKEN_MESSENGER_V2, messageTransmitter: TESTNET_SHARED_MESSAGE_TRANSMITTER_V2 },
  base: { domain: 6, usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", chainId: 84532, tokenMessenger: TESTNET_SHARED_TOKEN_MESSENGER_V2, messageTransmitter: TESTNET_SHARED_MESSAGE_TRANSMITTER_V2 },
  arc: { domain: 26, usdc: "0x3600000000000000000000000000000000000000", chainId: 5042002, tokenMessenger: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA", messageTransmitter: "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275" },
};

// Arc is deliberately NOT included here — as of this build, Arc's own
// official site still describes it as "currently in public testnet," ahead
// of mainnet launch. There is no real Arc mainnet CCTP domain or contract
// address to point at yet. Add it once Circle actually flips that switch —
// not before, and not by guessing.
const CCTP_CHAINS_MAINNET = {
  ethereum: { domain: 0, usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", chainId: 1, tokenMessenger: MAINNET_SHARED_TOKEN_MESSENGER_V2, messageTransmitter: MAINNET_SHARED_MESSAGE_TRANSMITTER_V2 },
  base: { domain: 6, usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", chainId: 8453, tokenMessenger: MAINNET_SHARED_TOKEN_MESSENGER_V2, messageTransmitter: MAINNET_SHARED_MESSAGE_TRANSMITTER_V2 },
};

export function getCctpChains() {
  return isMainnet() ? CCTP_CHAINS_MAINNET : CCTP_CHAINS_TESTNET;
}

// Kept for any existing call sites that import CCTP_CHAINS directly — always
// reflects the CURRENT network mode at the time it's read. Prefer
// getCctpChains() in new code so it's obvious this is mode-dependent.
export const CCTP_CHAINS = new Proxy({}, {
  get(_, key) { return getCctpChains()[key]; },
  ownKeys() { return Reflect.ownKeys(getCctpChains()); },
  getOwnPropertyDescriptor(_, key) { return Reflect.getOwnPropertyDescriptor(getCctpChains(), key); },
});

export function isCctpSupportedPair(fromKey, toKey) {
  const chains = getCctpChains();
  return !!chains[fromKey] && !!chains[toKey] && fromKey !== toKey;
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
  const base = isMainnet() ? "https://iris-api.circle.com" : "https://iris-api-sandbox.circle.com";
  const url = `${base}/v2/messages/${sourceDomain}?transactionHash=${txHash}`;
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
  const chains = getCctpChains();
  const from = chains[fromKey];
  const to = chains[toKey];
  if (!from || !to) {
    throw new Error(`CCTP doesn't support this pair on ${isMainnet() ? "mainnet" : "testnet"} right now.`);
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
    args: [account, from.tokenMessenger],
    chainId: from.chainId,
  });
  if (currentAllowance < burnAmount) {
    const approveHash = await writeContract(config, {
      address: from.usdc,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [from.tokenMessenger, burnAmount],
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
    address: from.tokenMessenger,
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
    address: to.messageTransmitter,
    abi: MESSAGE_TRANSMITTER_ABI,
    functionName: "receiveMessage",
    args: [attestation.message, attestation.attestation],
    chainId: to.chainId,
  });
  await waitForTransactionReceipt(config, { hash: mintHash, chainId: to.chainId });

  onStep?.("done");
  return { burnHash, mintHash };
}
