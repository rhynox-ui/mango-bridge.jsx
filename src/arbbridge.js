import { ethers } from "ethers5";
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
import { isMainnet } from "./networkMode.js";
import { DEV_FEE_PCT, DEV_FEE_MAX_USD } from "./devFeeWallets.js";

// IMPORTANT: @arbitrum/sdk's own docs and code comments (as of the current
// v4.x release) still describe its expected inputs as "an ethers v5 signer" /
// "an ethers v5 provider". Passing ethers v6 objects in caused a real bug —
// v6 represents chain IDs as BigInt where v5 uses plain Number, and the
// SDK's internal chain-id equality check failed even when the printed values
// looked identical (e.g. `11155111 === 11155111n` is `false` in JS). This
// file deliberately uses ethers v5 (aliased as "ethers5" in package.json)
// instead of the v6 used everywhere else in this app, specifically to match
// what the SDK expects.

const ROBINHOOD_TESTNET_CHAIN_ID = 46630;
const SEPOLIA_CHAIN_ID = 11155111;
const ROBINHOOD_MAINNET_CHAIN_ID = 4663;
const ETHEREUM_MAINNET_CHAIN_ID = 1;

const DEV_FEE_WALLET = "0xf07becc2401a646fff10d10b969ef18b03582e88";
const ERC20_TRANSFER_ABI = ["function transfer(address to, uint256 amount) returns (bool)"];
// Real DEV_FEE_PCT from devFeeWallets.js, not a second hardcoded "1%"
// — this file's own `.div(100)` calls couldn't see the rate cut to
// 25bps elsewhere. ETH-denominated fees below have no cap (no live
// ETH/USD price feed in this file to size one against); the USDC ones
// do, trivially, since USDC is ~1:1 with USD already.
const DEV_FEE_BPS = ethers.BigNumber.from(Math.round(DEV_FEE_PCT * 10000));
function cappedUsdcFee(feeAmount) {
  const capAmount = ethers.utils.parseUnits(String(DEV_FEE_MAX_USD), USDC_DECIMALS);
  return feeAmount.gt(capAmount) ? capAmount : feeAmount;
}

function childChainId() { return isMainnet() ? ROBINHOOD_MAINNET_CHAIN_ID : ROBINHOOD_TESTNET_CHAIN_ID; }
function parentChainId() { return isMainnet() ? ETHEREUM_MAINNET_CHAIN_ID : SEPOLIA_CHAIN_ID; }

// Testnet and mainnet contract addresses, both independently verified against
// docs.robinhood.com/chain — the "Robinhood Chain Testnet" contracts page for
// testnet, and the "Cross-Chain Messaging" guide's own mainnet code sample
// for mainnet. These are DIFFERENT sets of addresses on the same-named chain,
// same lesson as Arc: never assume mainnet reuses testnet addresses.
//
// confirmPeriodBlocks uses Arbitrum's standard ~1-week default on both
// networks. This has not been independently confirmed against either
// Rollup contract's actual on-chain confirmPeriodBlocks() value — if
// withdrawal timing looks off on either network, this is the first thing to
// verify by reading it directly from the Rollup contract below.
const registeredNetworks = new Set();
function ensureNetworkRegistered() {
  const key = isMainnet() ? "mainnet" : "testnet";
  if (registeredNetworks.has(key)) return;

  if (isMainnet()) {
    registerCustomArbitrumNetwork({
      name: "Robinhood Chain",
      chainId: ROBINHOOD_MAINNET_CHAIN_ID,
      parentChainId: ETHEREUM_MAINNET_CHAIN_ID,
      confirmPeriodBlocks: 45818,
      isCustom: true,
      ethBridge: {
        bridge: "0xDf8755334ce7A73cCF6b581C02eA649AE3E864b3",
        inbox: "0x1A07cc4BD17E0118BdB54D70990D2158AbAD7a2D",
        sequencerInbox: "0xBd0D173EEb87D57A09521c24388a12789F33ba96",
        outbox: "0xf0ce991ea4A0d2400A4AB49b20ae333f6Dce3DE9",
        rollup: "0x23A19d23e89166adedbDcB432518AB01e4272D94",
      },
    });
  } else {
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
  }
  registeredNetworks.add(key);
}

/**
 * Bridges wagmi's connected wallet into an ethers v5 Signer, since
 * @arbitrum/sdk is built on ethers v5, not viem or ethers v6. Works for both
 * injected (MetaMask) and WalletConnect connections since both expose a
 * standard EIP-1193 provider via connector.getProvider().
 */
async function getEthersSigner(chainId) {
  await switchChain(config, { chainId });
  await new Promise((r) => setTimeout(r, 250)); // let the wallet settle on the new network
  const account = getAccount(config);
  if (!account.connector) throw new Error("No wallet connected.");
  const eip1193Provider = await account.connector.getProvider({ chainId });
  const ethersProvider = new ethers.providers.Web3Provider(eip1193Provider);
  return ethersProvider.getSigner(account.address);
}

/** Real ETH deposit: Ethereum Sepolia -> Robinhood Chain Testnet. Fast (minutes). */
export async function runArbDeposit({ amountHuman, onStep }) {
  ensureNetworkRegistered();

  onStep?.("build");
  const parentSigner = await getEthersSigner(parentChainId());
  const childNetwork = await getArbitrumNetwork(childChainId());
  const ethBridger = new EthBridger(childNetwork);

  const totalAmount = ethers.utils.parseEther(amountHuman);
  const feeAmount = totalAmount.mul(DEV_FEE_BPS).div(10000);
  const depositAmount = totalAmount.sub(feeAmount);

  onStep?.("fee");
  if (feeAmount.gt(0)) {
    const feeTx = await parentSigner.sendTransaction({ to: DEV_FEE_WALLET, value: feeAmount });
    await feeTx.wait();
  }

  onStep?.("deposit");
  const depositTx = await ethBridger.deposit({
    amount: depositAmount,
    parentSigner,
  });

  onStep?.("confirm");
  const receipt = await depositTx.wait();

  onStep?.("done");
  return { l1Hash: receipt.transactionHash };
}

/**
 * Step 1 of a real ETH withdrawal: Robinhood Chain Testnet -> Ethereum Sepolia.
 * Only initiates it — funds aren't claimable on L1 until the challenge period
 * passes and finalizeArbWithdrawal is called (see below).
 */
export async function initiateArbWithdrawal({ account, amountHuman, onStep }) {
  ensureNetworkRegistered();

  onStep?.("build");
  const childSigner = await getEthersSigner(childChainId());
  const childNetwork = await getArbitrumNetwork(childChainId());
  const ethBridger = new EthBridger(childNetwork);

  const totalAmount = ethers.utils.parseEther(amountHuman);
  const feeAmount = totalAmount.mul(DEV_FEE_BPS).div(10000);
  const withdrawAmount = totalAmount.sub(feeAmount);

  onStep?.("fee");
  if (feeAmount.gt(0)) {
    const feeTx = await childSigner.sendTransaction({ to: DEV_FEE_WALLET, value: feeAmount });
    await feeTx.wait();
  }

  onStep?.("withdraw");
  const withdrawTx = await ethBridger.withdraw({
    amount: withdrawAmount,
    childSigner,
    destinationAddress: account,
  });

  onStep?.("confirm");
  const receipt = await withdrawTx.wait();

  onStep?.("done");
  return { l2TxHash: receipt.transactionHash };
}

// Sepolia's testnet USDC contract — same address already verified and used
// in cctp.js. Bridging it via Arbitrum's standard gateway produces a
// *bridged* USDC representation on Robinhood Chain Testnet — this is NOT
// the same as CCTP's native burn/mint USDC, and it's a different token than
// Robinhood Chain's real (mainnet) native USDG stablecoin.
const SEPOLIA_USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const ETHEREUM_MAINNET_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
function parentUsdcAddress() { return isMainnet() ? ETHEREUM_MAINNET_USDC : SEPOLIA_USDC; }
const USDC_DECIMALS = 6;

/** Real USDC deposit: Ethereum Sepolia -> Robinhood Chain Testnet, via Arbitrum's standard ERC-20 gateway. */
export async function runArbErc20Deposit({ amountHuman, onStep }) {
  ensureNetworkRegistered();

  onStep?.("build");
  const parentSigner = await getEthersSigner(parentChainId());
  const childNetwork = await getArbitrumNetwork(childChainId());
  const erc20Bridger = new Erc20Bridger(childNetwork);
  const totalAmount = ethers.utils.parseUnits(amountHuman, USDC_DECIMALS);
  const feeAmount = cappedUsdcFee(totalAmount.mul(DEV_FEE_BPS).div(10000));
  const amount = totalAmount.sub(feeAmount);

  onStep?.("fee");
  if (feeAmount.gt(0)) {
    const usdcContract = new ethers.Contract(parentUsdcAddress(), ERC20_TRANSFER_ABI, parentSigner);
    const feeTx = await usdcContract.transfer(DEV_FEE_WALLET, feeAmount);
    await feeTx.wait();
  }

  onStep?.("approve");
  const approveTx = await erc20Bridger.approveToken({ erc20L1Address: parentUsdcAddress(), parentSigner });
  await approveTx.wait();

  onStep?.("deposit");
  const depositTx = await erc20Bridger.deposit({ amount, erc20L1Address: parentUsdcAddress(), parentSigner });

  onStep?.("confirm");
  const receipt = await depositTx.wait();

  onStep?.("done");
  return { l1Hash: receipt.transactionHash };
}

/** Step 1 of a real USDC withdrawal: Robinhood Chain Testnet -> Ethereum Sepolia. Only initiates it. */
export async function initiateArbErc20Withdrawal({ account, amountHuman, onStep }) {
  ensureNetworkRegistered();

  onStep?.("build");
  const childSigner = await getEthersSigner(childChainId());
  const parentSigner = await getEthersSigner(parentChainId());
  const childNetwork = await getArbitrumNetwork(childChainId());
  const erc20Bridger = new Erc20Bridger(childNetwork);
  const totalAmount = ethers.utils.parseUnits(amountHuman, USDC_DECIMALS);
  const feeAmount = cappedUsdcFee(totalAmount.mul(DEV_FEE_BPS).div(10000));
  const amount = totalAmount.sub(feeAmount);

  onStep?.("fee");
  if (feeAmount.gt(0)) {
    // The fee needs the *bridged* USDC address on Robinhood Chain, not the
    // Ethereum address — Arbitrum's standard gateway computes this
    // deterministically. If this lookup ever fails for any reason, skip the
    // fee rather than block the withdrawal itself from working.
    try {
      const childUsdcAddress = await erc20Bridger.getChildErc20Address(parentUsdcAddress(), parentSigner.provider);
      const usdcContract = new ethers.Contract(childUsdcAddress, ERC20_TRANSFER_ABI, childSigner);
      const feeTx = await usdcContract.transfer(DEV_FEE_WALLET, feeAmount);
      await feeTx.wait();
    } catch (feeErr) {
      console.error("USDC withdrawal fee collection failed (withdrawal itself will still proceed):", feeErr);
    }
  }

  onStep?.("withdraw");
  const withdrawTx = await erc20Bridger.withdraw({
    amount,
    erc20L1Address: parentUsdcAddress(),
    childSigner,
    destinationAddress: account,
  });

  onStep?.("confirm");
  const receipt = await withdrawTx.wait();

  onStep?.("done");
  return { l2TxHash: receipt.transactionHash };
}

const ARB_STATUS_MAP = {
  0: "waiting-to-finalize", // UNCONFIRMED
  1: "ready-to-finalize", // CONFIRMED
  2: "finalized", // EXECUTED
};

/** Checks where an Arbitrum withdrawal currently stands. */
export async function getArbWithdrawalStatus({ l2TxHash }) {
  ensureNetworkRegistered();
  const childSigner = await getEthersSigner(childChainId());
  const parentSigner = await getEthersSigner(parentChainId());
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
  const childSigner = await getEthersSigner(childChainId());
  const parentSigner = await getEthersSigner(parentChainId());
  const receipt = await childSigner.provider.getTransactionReceipt(l2TxHash);
  const childReceipt = new ChildTransactionReceipt(receipt);
  const [message] = await childReceipt.getChildToParentMessages(parentSigner);

  onStep?.("wait-ready");
  await message.waitUntilReadyToExecute(childSigner.provider);

  onStep?.("execute");
  const tx = await message.execute(parentSigner);
  const executeReceipt = await tx.wait();

  onStep?.("done");
  return { finalizeHash: executeReceipt.transactionHash };
}

/** Recovery helper, same purpose as opbridge.js's version: reconstruct
 * tracking for a withdrawal that succeeded on-chain but wasn't saved. */
export async function trackArbWithdrawalByHash({ l2TxHash }) {
  ensureNetworkRegistered();
  const childSigner = await getEthersSigner(childChainId());
  const receipt = await childSigner.provider.getTransactionReceipt(l2TxHash);
  if (!receipt || receipt.status !== 1) {
    throw new Error("That transaction did not succeed on-chain — nothing to track.");
  }
  return { l2TxHash };
}
