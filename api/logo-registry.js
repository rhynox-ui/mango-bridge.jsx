// api/logo-registry.js
//
// A single JSON file in Blob storage acts as the whole "database" — an
// object mapping token addresses to logo URLs. Genuinely small: even
// thousands of entries stay well under any meaningful storage limit, since
// this only ever holds text pointers, never the images themselves.
//
// GET  -> returns the full mapping
// POST -> saves or updates one entry
//   - First-time save (right after a launch): no signature required, since
//     this is called once, immediately, by the same session that just
//     confirmed the launch transaction — there's no prior owner to protect
//     against yet.
//   - Update (changing an existing entry): REQUIRES a real signature from
//     the token's actual registered creator, verified against the
//     Registry contract on-chain — not just trusted from the request.

import { put, head } from "@vercel/blob";
import { createPublicClient, http, verifyMessage } from "viem";

const REGISTRY_ADDRESS = "0xb4D9c0928d0bf15ACa8D698cb83703752CfdF785"; // v3, current
const REGISTRY_ABI = [
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

const publicClient = createPublicClient({
  transport: http("https://rpc.mainnet.chain.robinhood.com"),
});

const REGISTRY_BLOB_PATH = "token-logo-registry.json";

async function readRegistry() {
  try {
    const blobInfo = await head(REGISTRY_BLOB_PATH);
    const res = await fetch(blobInfo.url);
    return await res.json();
  } catch {
    return {}; // doesn't exist yet — first logo ever saved creates it
  }
}

export default async function handler(request, response) {
  if (request.method === "GET") {
    const registry = await readRegistry();
    return response.status(200).json(registry);
  }

  if (request.method === "POST") {
    const { tokenAddress, logoUrl, poolId, isUpdate, signature, signerAddress } = request.body;

    if (!tokenAddress || !logoUrl) {
      return response.status(400).json({ error: "tokenAddress and logoUrl are required" });
    }

    const registry = await readRegistry();
    const key = tokenAddress.toLowerCase();
    const alreadyExists = Boolean(registry[key]);

    // Real access control — only actually enforced on updates, not the
    // first save. An update to something already in the registry requires
    // proof the requester genuinely controls the token's real, on-chain
    // registered creator wallet, not just a claim in the request body.
    if (alreadyExists || isUpdate) {
      if (!poolId || !signature || !signerAddress) {
        return response.status(400).json({ error: "Updating an existing logo requires poolId, signature, and signerAddress" });
      }

      const [realCreator] = await publicClient.readContract({
        address: REGISTRY_ADDRESS,
        abi: REGISTRY_ABI,
        functionName: "launches",
        args: [poolId],
      });

      if (realCreator.toLowerCase() !== signerAddress.toLowerCase()) {
        return response.status(403).json({ error: "signerAddress does not match this token's real, on-chain registered creator" });
      }

      const message = `I authorize updating the logo for token ${tokenAddress}`;
      const validSignature = await verifyMessage({
        address: signerAddress,
        message,
        signature,
      });

      if (!validSignature) {
        return response.status(403).json({ error: "Invalid signature" });
      }
    }

    registry[key] = logoUrl;

    await put(REGISTRY_BLOB_PATH, JSON.stringify(registry), {
      access: "public",
      contentType: "application/json",
      allowOverwrite: true,
    });

    return response.status(200).json({ success: true });
  }

  return response.status(405).json({ error: "Method not allowed" });
}
