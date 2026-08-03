import { ethers } from "ethers";
import { getAccount, switchChain } from "wagmi/actions";
import {
  EthBridger,
  Erc20Bridger,
  getArbitrumNetwork,
  registerCustomArbitrumNetwork,
  ChildTransactionReceipt,
  ChildToParentMessageStatus,
} from "@arbitrum/sdk";
import { config } from "./wagmi.js";

const ROBINHOOD_TESTNET_CHAIN_ID = 46630;
const SEPOLIA_CHAIN_ID = 11155111;

// Testnet contract addresses, from docs.robinhood.com/chain/contracts (the
// "Robinhood Chain Testnet" column specifically — Robinhood's own
// cross-chain-messaging code sample elsewhere uses different, MAINNET
// addresses under the same chainId variable name, which is an easy mix-up).
//
// confirmPeriodBlocks uses Arbitrum's standard ~1-week default. This has not
// been independently confirmed against Robinhood Chain Testnet's actual
// on-chain Rollup contract value — if withdrawal timing looks off, this is
// the first thing to verify by reading confirmPeriodBlocks() directly from
// the Rollup contract below.
let registered = false;
function ensureNetworkRegistered() {
  if (registered) return;
  registerCustomArbitrumNetwork({
    name: "Robinhood Chain Testnet",
    chainId: ROBINHOOD_TESTNET_CHAIN_ID,
    parentChainId: SEPOLIA_CHAIN_ID,
    confirmPeriodBlocks: 45818,
    isCustom: true,
    ethBridge: {
      bridge: "0x96295BDad104eaD97cC08797b3dC68efF59CcF30",
      inbox: "0xF2939afA86F6f933A3CE17fCAB007907B6b0B7a4",
      sequencerInbox: "0xA0D9dB3DC9791D54b5183C1C1866eFe1eCA7D414",
      outbox: "0x8D180Caf588f3Da027BEf1F42a106Da93F90b166",
      rollup: "0xdc5F8E399DBd8a9F5F87AeC4C23Beb12431b386D",
    },
  });
  registered = true;
}

/**
 * Bridges wagmi's connected wallet into an ethers.js Signer, since
 * @arbitrum/sdk is built on ethers, not viem. Works for both injected
 * (MetaMask) and WalletConnect connections since both expose a standard
 * EIP-1193 provider via connector.getProvider().
 */
async function getEthersSigner(chainId) {
  await switchChain(config, { chainId });
  await new Promise((r) => setTimeout(r, 250)); // let the wallet settle on the new network
  const account = getAccount(config);
  if (!account.connector) throw new Error("No wallet connected.");
  const eip1193Provider = await account.connector.getProvider({ chainId });
  const ethersProvider = new ethers.BrowserProvider(eip1193Provider);
  return ethersProvider.getSigner(account.address);
}

/** Real ETH deposit: Ethereum Sepolia -> Robinhood Chain Testnet. Fast (minutes). */
export async function runArbDeposit({ amountHuman, onStep }) {
  ensureNetworkRegistered();

  onStep?.("build");
  const parentSigner = await getEthersSigner(SEPOLIA_CHAIN_ID);
  const childNetwork = await getArbitrumNetwork(ROBINHOOD_TESTNET_CHAIN_ID);
  const ethBridger = new EthBridger(childNetwork);

  onStep?.("deposit");
  const depositTx = await ethBridger.deposit({
    amount: ethers.parseEther(amountHuman),
    parentSigner,
  });

  onStep?.("confirm");
  const receipt = await depositTx.wait();

  onStep?.("done");
  return { l1Hash: receipt.hash };
}

/**
 * Step 1 of a real ETH withdrawal: Robinhood Chain Testnet -> Ethereum Sepolia.
 * Only initiates it — funds aren't claimable on L1 until the challenge period
 * passes and finalizeArbWithdrawal is called (see below).
 */
export async function initiateArbWithdrawal({ account, amountHuman, onStep }) {
  ensureNetworkRegistered();

  onStep?.("build");
  const childSigner = await getEthersSigner(ROBINHOOD_TESTNET_CHAIN_ID);
  const childNetwork = await getArbitrumNetwork(ROBINHOOD_TESTNET_CHAIN_ID);
  const ethBridger = new EthBridger(childNetwork);

  onStep?.("withdraw");
  const withdrawTx = await ethBridger.withdraw({
    amount: ethers.parseEther(amountHuman),
    childSigner,
    destinationAddress: account,
  });

  onStep?.("confirm");
  const receipt = await withdrawTx.wait();

  onStep?.("done");
  return { l2TxHash: receipt.hash };
}

// Sepolia's testnet USDC contract — same address already verified and used
// in cctp.js. Bridging it via Arbitrum's standard gateway produces a
// *bridged* USDC representation on Robinhood Chain Testnet — this is NOT
// the same as CCTP's native burn/mint USDC, and it's a different token than
// Robinhood Chain's real (mainnet) native USDG stablecoin.
const SEPOLIA_USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const USDC_DECIMALS = 6;

/** Real USDC deposit: Ethereum Sepolia -> Robinhood Chain Testnet, via Arbitrum's standard ERC-20 gateway. */
export async function runArbErc20Deposit({ amountHuman, onStep }) {
  ensureNetworkRegistered();

  onStep?.("build");
  const parentSigner = await getEthersSigner(SEPOLIA_CHAIN_ID);
  const childNetwork = await getArbitrumNetwork(ROBINHOOD_TESTNET_CHAIN_ID);
  const erc20Bridger = new Erc20Bridger(childNetwork);
  const amount = ethers.parseUnits(amountHuman, USDC_DECIMALS);

  onStep?.("approve");
  const approveTx = await erc20Bridger.approveToken({ erc20L1Address: SEPOLIA_USDC, parentSigner });
  await approveTx.wait();

  onStep?.("deposit");
  const depositTx = await erc20Bridger.deposit({ amount, erc20L1Address: SEPOLIA_USDC, parentSigner });

  onStep?.("confirm");
  const receipt = await depositTx.wait();

  onStep?.("done");
  return { l1Hash: receipt.hash };
}

/** Step 1 of a real USDC withdrawal: Robinhood Chain Testnet -> Ethereum Sepolia. Only initiates it. */
export async function initiateArbErc20Withdrawal({ account, amountHuman, onStep }) {
  ensureNetworkRegistered();

  onStep?.("build");
  const childSigner = await getEthersSigner(ROBINHOOD_TESTNET_CHAIN_ID);
  const childNetwork = await getArbitrumNetwork(ROBINHOOD_TESTNET_CHAIN_ID);
  const erc20Bridger = new Erc20Bridger(childNetwork);
  const amount = ethers.parseUnits(amountHuman, USDC_DECIMALS);

  onStep?.("withdraw");
  const withdrawTx = await erc20Bridger.withdraw({
    amount,
    erc20L1Address: SEPOLIA_USDC,
    childSigner,
    destinationAddress: account,
  });

  onStep?.("confirm");
  const receipt = await withdrawTx.wait();

  onStep?.("done");
  return { l2TxHash: receipt.hash };
}

const ARB_STATUS_MAP = {
  0: "waiting-to-finalize", // UNCONFIRMED
  1: "ready-to-finalize", // CONFIRMED
  2: "finalized", // EXECUTED
};

/** Checks where an Arbitrum withdrawal currently stands. */
export async function getArbWithdrawalStatus({ l2TxHash }) {
  ensureNetworkRegistered();
  const childSigner = await getEthersSigner(ROBINHOOD_TESTNET_CHAIN_ID);
  const parentSigner = await getEthersSigner(SEPOLIA_CHAIN_ID);
  const receipt = await childSigner.provider.getTransactionReceipt(l2TxHash);
  if (!receipt) throw new Error("Transaction not found yet — it may still be pending.");
  const childReceipt = new ChildTransactionReceipt(receipt);
  const [message] = await childReceipt.getChildToParentMessages(parentSigner);
  if (!message) throw new Error("No withdrawal message found on this transaction.");
  const status = await message.status(childSigner.provider);
  return { status: ARB_STATUS_MAP[status] ?? "unknown" };
}

/** Step 2: execute (finalize) the withdrawal on L1, once status is 'ready-to-finalize'. */
export async function finalizeArbWithdrawal({ l2TxHash, onStep }) {
  ensureNetworkRegistered();
  const childSigner = await getEthersSigner(ROBINHOOD_TESTNET_CHAIN_ID);
  const parentSigner = await getEthersSigner(SEPOLIA_CHAIN_ID);
  const receipt = await childSigner.provider.getTransactionReceipt(l2TxHash);
  const childReceipt = new ChildTransactionReceipt(receipt);
  const [message] = await childReceipt.getChildToParentMessages(parentSigner);

  onStep?.("wait-ready");
  await message.waitUntilReadyToExecute(childSigner.provider);

  onStep?.("execute");
  const tx = await message.execute(parentSigner);
  const executeReceipt = await tx.wait();

  onStep?.("done");
  return { finalizeHash: executeReceipt.hash };
}

/** Recovery helper, same purpose as opbridge.js's version: reconstruct
 * tracking for a withdrawal that succeeded on-chain but wasn't saved. */
export async function trackArbWithdrawalByHash({ l2TxHash }) {
  ensureNetworkRegistered();
  const childSigner = await getEthersSigner(ROBINHOOD_TESTNET_CHAIN_ID);
  const receipt = await childSigner.provider.getTransactionReceipt(l2TxHash);
  if (!receipt || receipt.status !== 1) {
    throw new Error("That transaction did not succeed on-chain — nothing to track.");
  }
  return { l2TxHash };
}
