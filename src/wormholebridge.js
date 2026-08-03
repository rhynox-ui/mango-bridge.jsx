import { ethers } from "ethers";
import { getAccount, switchChain } from "wagmi/actions";
import { wormhole, Wormhole, amount as whAmount, signSendWait, TokenTransfer } from "@wormhole-foundation/sdk";
import evmPlatform from "@wormhole-foundation/sdk/evm";
import { config } from "./wagmi.js";
import { isMainnet } from "./networkMode.js";

const SEPOLIA_CHAIN_ID = 11155111;
const BSC_TESTNET_CHAIN_ID = 97;
const ETHEREUM_MAINNET_CHAIN_ID = 1;
const BSC_MAINNET_CHAIN_ID = 56;

// Wormhole's chain *names* ("Ethereum", "Bsc") are the same string on both
// testnet and mainnet — it's the `network` argument passed to wormhole()
// below that actually switches which underlying deployment/RPC set is used.
// Easy to assume the name needs to change too; it doesn't.
function srcChainName() { return isMainnet() ? "Ethereum" : "Sepolia"; }
function srcChainId() { return isMainnet() ? ETHEREUM_MAINNET_CHAIN_ID : SEPOLIA_CHAIN_ID; }
function dstChainId() { return isMainnet() ? BSC_MAINNET_CHAIN_ID : BSC_TESTNET_CHAIN_ID; }

// IMPORTANT — read this before trusting this module:
// Wormhole's Token Bridge is a lock-and-mint design: your ETH gets locked on
// the source chain, and a *Wormhole-wrapped* representation of ETH is minted
// on BNB Chain. That wrapped token is a different contract than native BNB or
// any "real" wrapped ETH other apps might recognize on BSC — it only
// round-trips back through Wormhole. This is a fundamentally different trust
// model than CCTP (burn/mint, no wrapped asset) used for the Ethereum<->Base
// USDC route.
//
// This module also carries more residual implementation risk than the CCTP
// and OP Stack/Arbitrum modules: the browser-wallet-to-Wormhole-Signer
// adapter below is hand-written (no verified official example for this exact
// case was found). Test with a small amount first, especially on mainnet.

let whInstance = null;
let whInstanceMode = null;
async function getWormhole() {
  const wantMode = isMainnet() ? "Mainnet" : "Testnet";
  if (!whInstance || whInstanceMode !== wantMode) {
    whInstance = await wormhole(wantMode, [evmPlatform]);
    whInstanceMode = wantMode;
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
 * Shared core: works for either direction, since Wormhole's Token Bridge is
 * inherently bidirectional. The `tokenId` always references the *origin*
 * asset (native ETH on Ethereum) regardless of which way we're moving it —
 * the SDK compares the token's origin chain against the sender/receiver
 * chains to decide automatically whether this call needs to lock (moving
 * away from origin) or burn-and-redeem (moving back toward origin). Same
 * `tokenTransfer` call either way; only the addresses/signers change.
 */
async function runWormholeCore({ fromChainName, fromChainId, toChainName, toChainId, amountHuman, onStep }) {
  onStep?.("build");
  const wh = await getWormhole();
  const originChain = wh.getChain(srcChainName()); // always "Ethereum"/"Sepolia" — the token's true origin

  const { signer: fromEthersSigner, address: fromAddress } = await getEthersSignerFor(fromChainId);
  const fromSigner = makeWormholeSigner(fromChainName, fromEthersSigner, fromAddress);
  const toAddress = fromAddress; // same wallet, same address on every EVM chain

  const tokenId = Wormhole.tokenId(srcChainName(), "native");
  const decimals = await wh.getDecimals(originChain.chain, tokenId.address);
  const transferAmount = whAmount.units(whAmount.parse(amountHuman, decimals));

  onStep?.("lock");
  const xfer = await wh.tokenTransfer(
    tokenId,
    transferAmount,
    Wormhole.chainAddress(fromChainName, fromAddress),
    Wormhole.chainAddress(toChainName, toAddress),
    false // manual (not automatic-relayed) — we drive each step ourselves
  );
  const srcTxids = await xfer.initiateTransfer(fromSigner);
  onStep?.({ key: "hash-known", srcTxHash: srcTxids[0] });

  onStep?.("attest");
  try {
    await xfer.fetchAttestation(300_000); // wait up to 5 min for the guardian VAA
  } catch (err) {
    throw new Error(
      `Your funds are safely locked on the source chain (tx: ${srcTxids[0]}) — this only means the Wormhole guardian attestation isn't ready yet. ` +
      `Wait a bit and use the resume option with this hash to finish it. Original error: ${err?.message || err}`
    );
  }

  onStep?.("mint");
  const { signer: toEthersSigner } = await getEthersSignerFor(toChainId);
  const toSigner = makeWormholeSigner(toChainName, toEthersSigner, toAddress);
  const dstTxids = await xfer.completeTransfer(toSigner);

  onStep?.("done");
  return { srcTxHash: srcTxids[0], dstTxHash: dstTxids[0] };
}

/**
 * Real ETH transfer: Ethereum -> BNB Chain via Wormhole.
 * Produces Wormhole-wrapped ETH on BNB Chain, not native BNB.
 * Fast (minutes) — no 7-day challenge period, since Wormhole uses guardian
 * attestation rather than a fraud-proof window. Proven working.
 */
export async function runWormholeTransfer({ amountHuman, onStep }) {
  return runWormholeCore({
    fromChainName: srcChainName(), fromChainId: srcChainId(),
    toChainName: "Bsc", toChainId: dstChainId(),
    amountHuman, onStep,
  });
}

/**
 * Real transfer: BNB Chain -> Ethereum via Wormhole — the reverse direction.
 * Burns your Wormhole-wrapped ETH on BNB Chain and unlocks the original
 * native ETH on Ethereum. This is newly built and has NOT been proven live
 * yet the way the forward direction has — test with a small amount first.
 * Requires holding Wormhole-wrapped ETH on BNB Chain already (i.e. ETH that
 * arrived via this same bridge) — it cannot redeem native BNB or any other
 * app's wrapped ETH, since those aren't the same contract.
 */
export async function runWormholeTransferReverse({ amountHuman, onStep }) {
  return runWormholeCore({
    fromChainName: "Bsc", fromChainId: dstChainId(),
    toChainName: srcChainName(), toChainId: srcChainId(),
    amountHuman, onStep,
  });
}

/**
 * Recovery path: if fetchAttestation timed out but the source lock succeeded,
 * this resumes from just the Sepolia transaction hash — re-fetches the
 * attestation (now more likely to be ready) and completes the mint on BNB.
 */
export async function resumeWormholeTransfer({ srcTxHash, fromChainName, toChainName, toChainId, onStep }) {
  onStep?.("build");
  const wh = await getWormhole();

  onStep?.("attest");
  const xfer = await TokenTransfer.from(wh, { chain: fromChainName, txid: srcTxHash });
  await xfer.fetchAttestation(300_000);

  const account = getAccount(config);
  if (!account.address) throw new Error("No wallet connected.");

  onStep?.("mint");
  const { signer: toEthersSigner } = await getEthersSignerFor(toChainId);
  const toSigner = makeWormholeSigner(toChainName, toEthersSigner, account.address);
  const dstTxids = await xfer.completeTransfer(toSigner);

  onStep?.("done");
  return { srcTxHash, dstTxHash: dstTxids[0] };
}
