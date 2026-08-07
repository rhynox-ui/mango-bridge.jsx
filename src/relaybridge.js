import { getAccount, switchChain, sendTransaction, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { config } from "./wagmi.js";

const DEV_FEE_WALLET = "0xf07becc2401a646fff10d10b969ef18b03582e88";
const DEV_FEE_PCT = 0.01;
export { DEV_FEE_WALLET, DEV_FEE_PCT };

const ERC20_TRANSFER_ABI = [
  { name: "transfer", type: "function", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
];

/**
 * Sends the 1% protocol fee as its own visible on-chain transfer, same
 * pattern used for CCTP transfers elsewhere in this app — the fee is never
 * silently bundled into another transaction.
 */
export async function sendRelayProtocolFee({ chainKey, chainId, assetSymbol, feeBaseUnits }) {
  if (feeBaseUnits <= 0n) return null;
  await switchChain(config, { chainId });
  const currency = currencyAddress(chainKey, assetSymbol);
  let hash;
  if (currency === NATIVE_TOKEN_ADDRESS) {
    hash = await sendTransaction(config, { to: DEV_FEE_WALLET, value: feeBaseUnits, chainId });
  } else {
    hash = await writeContract(config, {
      address: currency,
      abi: ERC20_TRANSFER_ABI,
      functionName: "transfer",
      args: [DEV_FEE_WALLET, feeBaseUnits],
      chainId,
    });
  }
  await waitForTransactionReceipt(config, { hash, chainId });
  return hash;
}

// Relay Protocol — confirmed independently across three sources: Relay's own
// docs, Robinhood's own bridging documentation (which recommends Relay
// directly), and live in OKX Wallet's bridge feature. Chosen specifically
// because it's non-custodial (a solver network, not a liquidity pool we'd
// have to trust operationally) and supports genuine any-asset, any-chain
// routing — including pairs with no canonical bridge, like BNB<->ETH or
// direct L2-to-L2 transfers.
//
// IMPORTANT — read this before trusting this module:
// This is a fundamentally different trust model than CCTP, the OP Stack
// bridge, or the Arbitrum bridge. Those move funds through immutable,
// audited contracts with no discretion. Relay works via solvers who front
// liquidity on the destination chain and get repaid on the source — you are
// trusting Relay's solver network to fulfill correctly, not just contract
// math. Relay's docs state failed steps auto-refund rather than getting
// stuck, which is a meaningful safety property, but it's still a different
// category of trust than the other three integrations in this app.
//
// This module has NOT been proven live yet — it's built directly against
// Relay's own documented request/response schema (verified from two
// independent sources agreeing on the exact same shape), but "correctly
// built" and "proven in production" are different things until it's
// actually run. Test with the smallest possible real amount first.

const RELAY_QUOTE_URL = "https://api.relay.link/quote/v2";
const RELAY_STATUS_URL = "https://api.relay.link/intents/status/v3";

const NATIVE_TOKEN_ADDRESS = "0x0000000000000000000000000000000000000000";

const MAINNET_CHAIN_IDS = {
  ethereum: 1,
  base: 8453,
  bnb: 56,
  robinhood: 4663,
  stable: 988,
};

// Native gas token per chain, and verified mainnet contract addresses for
// each ERC-20 this app supports — reusing addresses already established
// elsewhere in this app where they exist, freshly verified for the rest.
// Deliberately incomplete: several real combinations (USDC on BNB/Robinhood
// Chain, USDT on Base/Robinhood Chain, USDG on Robinhood Chain — despite
// USDG being confirmed issued there) are left out because their exact
// contract addresses haven't been independently verified. Guessing an
// address here means real funds sent to the wrong contract — better to
// throw a clear error than be wrong.
// Stable's native gas token is USDT0, addressed via the standard native
// (0x0000...) convention below — this matches how Relay's own API expects
// every chain's native gas token to be referenced, confirmed against their
// documented request schema.
//
// USDT0 also has a separate ERC-20 interface address on Stable, verified
// directly from USDT0's own official deployments page
// (docs.usdt0.to/technical-documentation/deployments), chain ID 988 match:
//   Token:  0x779Ded0c9e1022225f8E0630b35a9b54bE713736
//   OFT:    0xedaba024be4d87974d5aB11C6Dd586963CcCB027
// Not currently used — kept here as a verified reference in case the
// native-address assumption ever needs revisiting once tested live.
// Note: Stable deliberately has no entry here. Relay's own API confirms
// its actual native currency is a separate token (gUSDT) that doesn't
// support bridging at all — USDT0 is a real ERC-20 there, not a native
// asset, so it belongs in TOKEN_ADDRESSES below, not this native-symbol
// shortcut. Confirmed directly against Relay's live /chains endpoint, not
// assumed.
const NATIVE_SYMBOL = { ethereum: "ETH", base: "ETH", bnb: "BNB", robinhood: "ETH" };
const TOKEN_ADDRESSES = {
  USDC: {
    ethereum: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  },
  USDT: {
    ethereum: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    bnb: "0x55d398326f99059fF775485246999027B3197955",
    // IMPORTANT: unlike the Ethereum and BNB Chain addresses above, this is
    // NOT issued by Tether. BaseScan's own listing states plainly: "This
    // bridged token is not issued by, redeemable by, or affiliated with,
    // Tether. Tether is not responsible for it." It's the real, liquid
    // "USDT" that circulates on Base ($24M+ market cap, 600K+ holders) and
    // what Relay would actually route through — but it carries a genuinely
    // different trust footprint than the other two addresses in this list.
    base: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2",
  },
  WBTC: {
    ethereum: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
    base: "0x0555E30da8f98308EdB960aa94C0Db47230d2B9c",
  },
  USDT0: {
    // Confirmed against two independent sources: Tether's own official
    // deployment docs (docs.usdt0.to/technical-documentation/deployments)
    // and Relay's live /chains API, which both agree on this exact
    // address. This is the ONLY one of our four chains where USDT0
    // actually exists — Tether hasn't deployed it on Ethereum (which only
    // hosts the lock/adapter side of the mechanism, not USDT0 itself),
    // Base, or BNB Chain, and Robinhood Chain isn't in Tether's
    // deployment list either.
    stable: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736",
  },
  USDG: {
    ethereum: "0xe343167631d89b6ffc58b88d6b7fb0228795491d",
    // Verified against Robinhood Chain's own official Blockscout explorer,
    // independently cross-checked against GeckoTerminal's pool data — both
    // agree on this exact address. USDG is actually Robinhood Chain's
    // native default stablecoin, chosen over USDC and Tether.
    robinhood: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
  },
};

function currencyAddress(chainKey, assetSymbol) {
  if (assetSymbol === NATIVE_SYMBOL[chainKey]) return NATIVE_TOKEN_ADDRESS;
  const addr = TOKEN_ADDRESSES[assetSymbol]?.[chainKey];
  if (!addr) throw new Error(`No verified mainnet contract address for ${assetSymbol} on ${chainKey} — not safe to guess one.`);
  return addr;
}

/** True only when both sides of a transfer have a verified currency address — used to decide whether to offer this route at all, without throwing. */
export function canRelayHandle(fromChainKey, toChainKey, fromAsset, toAsset) {
  try {
    currencyAddress(fromChainKey, fromAsset);
    currencyAddress(toChainKey, toAsset);
    return true;
  } catch {
    return false;
  }
}

/**
 * Fetches a Relay quote for moving `amountBaseUnits` of `fromAsset` on
 * `fromChainKey` into `toAsset` on `toChainKey`. Amount must already be in
 * base units (wei/smallest denomination) as a string, matching the asset's
 * actual decimals — this function does not do decimal conversion itself.
 */
export async function getRelayQuote({ fromChainKey, toChainKey, fromAsset, toAsset, amountBaseUnits, userAddress }) {
  const body = {
    user: userAddress,
    originChainId: MAINNET_CHAIN_IDS[fromChainKey],
    destinationChainId: MAINNET_CHAIN_IDS[toChainKey],
    originCurrency: currencyAddress(fromChainKey, fromAsset),
    destinationCurrency: currencyAddress(toChainKey, toAsset),
    amount: amountBaseUnits,
    tradeType: "EXACT_INPUT",
  };
  const res = await fetch(RELAY_QUOTE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Relay quote failed (${res.status}): ${text || res.statusText}`);
  }
  return res.json();
}

async function pollRelayStatus(requestId, { intervalMs = 2000, timeoutMs = 10 * 60 * 1000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`${RELAY_STATUS_URL}?requestId=${requestId}`);
    if (res.ok) {
      const data = await res.json();
      if (data.status === "success") return data;
      if (data.status === "failure") throw new Error("Relay reported this transfer failed — check the requestId on relay.link for details.");
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("Timed out waiting for Relay to confirm completion. Your deposit transaction succeeded — check status manually using the requestId before retrying.");
}

/**
 * Executes a quote obtained from getRelayQuote: signs and sends every
 * pending transaction step in order, on whichever chain each step requires,
 * then polls until Relay confirms the destination side is complete.
 */
export async function executeRelayQuote({ quote, onStep }) {
  onStep?.("build");
  let requestId = null;
  const txHashes = [];

  for (const step of quote.steps) {
    if (step.kind !== "transaction") {
      throw new Error(`Unsupported Relay step kind "${step.kind}" — only transaction steps are handled by this app.`);
    }
    requestId = requestId || step.requestId;

    for (const item of step.items) {
      if (item.status === "complete") continue;
      const { to, data, value, chainId } = item.data;

      onStep?.("deposit");
      if (chainId) await switchChain(config, { chainId });
      const hash = await sendTransaction(config, {
        to,
        data,
        value: value ? BigInt(value) : 0n,
        chainId,
      });
      txHashes.push(hash);
      onStep?.({ key: "hash-known", txHash: hash });
      await waitForTransactionReceipt(config, { hash, chainId });
    }
  }

  onStep?.("fill");
  await pollRelayStatus(requestId);

  onStep?.("done");
  return { txHashes, requestId };
}

export { MAINNET_CHAIN_IDS };

// On-chain decimals (NOT display decimals) — needed to convert a human
// amount into base units before calling getRelayQuote.
export const ASSET_ONCHAIN_DECIMALS = {
  ETH: 18,
  BNB: 18,
  USDC: 6,
  USDT: 6,
  USDG: 6,
  WBTC: 8,
  USDT0: 18,
};
