// api/logo-registry.js
//
// A single JSON file in Blob storage acts as the whole "database" — an
// object mapping token addresses to their launch-time metadata (logo URL,
// description, X/Telegram links). Genuinely small: even thousands of
// entries stay well under any meaningful storage limit, since this only
// ever holds text, never the images themselves.
//
// Each entry's value is an object ({logoUrl, description, xProfile,
// telegram}), not a bare string — the Factory contract itself only takes
// name/symbol/creator, so this is the one place description/socials
// typed into the launch form actually get saved anywhere, instead of
// being silently discarded. A field omitted from a given request keeps
// its previously-saved value rather than being wiped.
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
//     (The only real update path today, from the token detail page's
//     "change logo" flow, only ever sends logoUrl — description/socials
//     currently have no edit-after-launch UI.)

import { put, head } from "@vercel/blob";
import { createPublicClient, http, verifyMessage } from "viem";
import { checkRateLimit } from "./rateLimit.js";

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
    if (!(await checkRateLimit(request, response, { name: "logo-registry-get", limit: 60 }))) return;
    const registry = await readRegistry();
    return response.status(200).json(registry);
  }

  if (request.method === "POST") {
    // Real gap this closes: every other write endpoint in api/v1/* is
    // rate-limited (checkRateLimit's own header — "every api/v1
    // endpoint was completely open" before it existed); this one, not
    // under api/v1/, was missed. Without it, the poolId/on-chain check
    // above is still correct but a brute-force script could hammer this
    // with unlimited requests trying different poolIds/addresses.
    if (!(await checkRateLimit(request, response, { name: "logo-registry-post", limit: 20 }))) return;
    const { tokenAddress, logoUrl, poolId, isUpdate, signature, signerAddress, description, xProfile, telegram } = request.body;

    if (!tokenAddress) {
      return response.status(400).json({ error: "tokenAddress is required" });
    }
    if (!logoUrl && !description && !xProfile && !telegram) {
      return response.status(400).json({ error: "At least one of logoUrl, description, xProfile, or telegram is required" });
    }

    const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
    if (!EVM_ADDRESS_RE.test(tokenAddress)) {
      return response.status(400).json({ error: "tokenAddress must be a valid EVM address." });
    }

    const registry = await readRegistry();
    const key = tokenAddress.toLowerCase();
    const alreadyExists = Boolean(registry[key]);

    // Real vulnerability, closed here: the first-save path had NO
    // on-chain verification at all — literally anyone could POST any
    // tokenAddress (real, not-yet-launched, or entirely fake) and set
    // its logo/description/social links before the real creator ever
    // called this endpoint, e.g. a phishing Telegram/X link squatted on
    // a token before its actual creator saves real metadata. poolId is
    // already sent on every genuine first-save call (Launchpad.jsx
    // passes result.poolId straight from the launch transaction's own
    // decoded event) — cross-checking it against the Registry
    // contract's own real, on-chain tokenAddress for that pool proves
    // this is a real launched token at this exact address, with no
    // signature prompt needed (which would break launching on behalf
    // of a different creator wallet — the "Creator wallet" field this
    // page already supports, and the update path's own documented
    // reason a signature there is checked against the on-chain creator
    // rather than whoever launched it).
    if (!alreadyExists && !isUpdate) {
      if (!poolId) {
        return response.status(400).json({ error: "First-time save requires poolId." });
      }
      const [, realTokenAddress] = await publicClient.readContract({
        address: REGISTRY_ADDRESS,
        abi: REGISTRY_ABI,
        functionName: "launches",
        args: [poolId],
      });
      if (!realTokenAddress || realTokenAddress.toLowerCase() !== key) {
        return response.status(403).json({ error: "poolId does not correspond to this tokenAddress." });
      }
    }

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

    // Older entries (a bare string, before this held anything but a logo
    // URL) are read as logo-only with everything else blank — not treated
    // as corrupt. Any field this request didn't send keeps whatever was
    // already saved, rather than getting wiped to blank.
    const existingEntry = registry[key];
    const existingObject = typeof existingEntry === "object" && existingEntry ? existingEntry : { logoUrl: existingEntry || null };
    registry[key] = {
      logoUrl: logoUrl ?? existingObject.logoUrl ?? null,
      description: description ?? existingObject.description ?? "",
      xProfile: xProfile ?? existingObject.xProfile ?? "",
      telegram: telegram ?? existingObject.telegram ?? "",
    };

    await put(REGISTRY_BLOB_PATH, JSON.stringify(registry), {
      access: "public",
      contentType: "application/json",
      allowOverwrite: true,
    });

    return response.status(200).json({ success: true });
  }

  return response.status(405).json({ error: "Method not allowed" });
}
