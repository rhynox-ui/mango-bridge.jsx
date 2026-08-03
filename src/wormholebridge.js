import { ethers } from "ethers";
import { getAccount, switchChain } from "wagmi/actions";
import { wormhole, Wormhole, amount as whAmount, signSendWait, TokenTransfer } from "@wormhole-foundation/sdk";
import evmPlatform from "@wormhole-foundation/sdk/evm";
import { config } from "./wagmi.js";

const SEPOLIA_CHAIN_ID = 11155111;
const BSC_TESTNET_CHAIN_ID = 97;

// IMPORTANT — read this before trusting this module:
// Wormhole's Token Bridge is a lock-and-mint design: your ETH gets locked on
// Sepolia, and a *Wormhole-wrapped* representation of ETH is minted on BNB
// Testnet. That wrapped token is a different contract than native BNB or any
// "real" wrapped ETH other apps might recognize on BSC — it only round-trips
// back through Wormhole. This is a fundamentally different trust model than
// CCTP (burn/mint, no wrapped asset) used for the Ethereum<->Base USDC route.
//
// This module also carries more residual implementation risk than the CCTP
// and OP Stack/Arbitrum modules: the browser-wallet-to-Wormhole-Signer
// adapter below is hand-written (no verified official example for this exact
// case was found), and BSC Testnet's chain identifier in the SDK ("Bsc") is
// inferred from documentation patterns rather than an explicit testnet
// worked example. Test with a small amount first.

let whInstance = null;
async function getWormhole() {
  if (!whInstance) {
    whInstance = await wormhole("Testnet", [evmPlatform]);
  }
  return whInstance;
}

/**
 * Adapts an ethers.js Signer (itself adapted from wagmi's connected wallet)
 * into the shape Wormhole's SDK expects for signing and sending transactions.
 */
function makeWormholeSigner(chainName, ethersSigner, address) {
  return {
    chain: () => chainName,
    address: () => address,
    signAndSend: async (unsignedTxs) => {
      const txids = [];
      for (const tx of unsignedTxs) {
        const txRequest = tx.transaction ?? tx;
        try {
          const response = await ethersSigner.sendTransaction(txRequest);
          const receipt = await response.wait();
          txids.push(receipt.hash);
        } catch (err) {
          // "missing revert data" means the RPC didn't return a reason string
          // during gas estimation. Try a direct eth_call at the current block
          // to see if we can recover the actual revert reason ourselves.
          let detail = err?.shortMessage || err?.message || String(err);
          try {
            await ethersSigner.provider.call({
              to: txRequest.to,
              data: txRequest.data,
              value: txRequest.value,
              from: await ethersSigner.getAddress(),
            });
          } catch (callErr) {
            const reason = callErr?.revert?.args?.[0] || callErr?.shortMessage || callErr?.reason;
            if (reason) detail = `Revert reason: ${reason}`;
          }
          throw new Error(`Wormhole transaction failed (to=${txRequest.to}, value=${txRequest.value}): ${detail}`);
        }
      }
      return txids;
    },
  };
}

async function getEthersSignerFor(chainId) {
  await switchChain(config, { chainId });
  await new Promise((r) => setTimeout(r, 250)); // let the wallet settle on the new network
  const account = getAccount(config);
  if (!account.connector) throw new Error("No wallet connected.");
  const eip1193Provider = await account.connector.getProvider({ chainId });
  const ethersProvider = new ethers.BrowserProvider(eip1193Provider);
  const signer = await ethersProvider.getSigner(account.address);
  return { signer, address: account.address };
}

/**
 * Real ETH transfer: Ethereum Sepolia -> BNB Testnet via Wormhole.
 * Produces Wormhole-wrapped ETH on BNB Testnet, not native BNB.
 * Fast (minutes) — no 7-day challenge period, since Wormhole uses guardian
 * attestation rather than a fraud-proof window.
 */
export async function runWormholeTransfer({ amountHuman, onStep }) {
  onStep?.("build");
  const wh = await getWormhole();
  const sendChain = wh.getChain("Sepolia");
  const rcvChain = wh.getChain("Bsc");

  const { signer: srcEthersSigner, address: srcAddress } = await getEthersSignerFor(SEPOLIA_CHAIN_ID);
  const srcSigner = makeWormholeSigner("Sepolia", srcEthersSigner, srcAddress);

  // Same wallet, same address on every EVM chain — no need to switch networks
  // (and invalidate the Sepolia signer we just built) just to read it again.
  const dstAddress = srcAddress;

  const tokenId = Wormhole.tokenId("Sepolia", "native");
  const decimals = await wh.getDecimals(sendChain.chain, tokenId.address);
  const transferAmount = whAmount.units(whAmount.parse(amountHuman, decimals));

  onStep?.("lock");
  const xfer = await wh.tokenTransfer(
    tokenId,
    transferAmount,
    Wormhole.chainAddress("Sepolia", srcAddress),
    Wormhole.chainAddress("Bsc", dstAddress),
    false // manual (not automatic-relayed) — we drive each step ourselves
  );
  const srcTxids = await xfer.initiateTransfer(srcSigner);
  onStep?.({ key: "hash-known", srcTxHash: srcTxids[0] });

  onStep?.("attest");
  try {
    await xfer.fetchAttestation(300_000); // wait up to 5 min for the guardian VAA
  } catch (err) {
    throw new Error(
      `Your ETH is safely locked on Sepolia (tx: ${srcTxids[0]}) — this only means the Wormhole guardian attestation isn't ready yet. ` +
      `Wait a bit and use "Resume Wormhole transfer" with this hash to finish it. Original error: ${err?.message || err}`
    );
  }

  onStep?.("mint");
  const { signer: dstEthersSigner } = await getEthersSignerFor(BSC_TESTNET_CHAIN_ID);
  const dstSigner = makeWormholeSigner("Bsc", dstEthersSigner, dstAddress);
  const dstTxids = await xfer.completeTransfer(dstSigner);

  onStep?.("done");
  return { srcTxHash: srcTxids[0], dstTxHash: dstTxids[0] };
}

/**
 * Recovery path: if fetchAttestation timed out but the source lock succeeded,
 * this resumes from just the Sepolia transaction hash — re-fetches the
 * attestation (now more likely to be ready) and completes the mint on BNB.
 */
export async function resumeWormholeTransfer({ srcTxHash, onStep }) {
  onStep?.("build");
  const wh = await getWormhole();

  onStep?.("attest");
  const xfer = await TokenTransfer.from(wh, { chain: "Sepolia", txid: srcTxHash });
  await xfer.fetchAttestation(300_000);

  const account = getAccount(config);
  if (!account.address) throw new Error("No wallet connected.");

  onStep?.("mint");
  const { signer: dstEthersSigner } = await getEthersSignerFor(BSC_TESTNET_CHAIN_ID);
  const dstSigner = makeWormholeSigner("Bsc", dstEthersSigner, account.address);
  const dstTxids = await xfer.completeTransfer(dstSigner);

  onStep?.("done");
  return { srcTxHash, dstTxHash: dstTxids[0] };
}
