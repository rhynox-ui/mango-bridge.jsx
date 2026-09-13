// api/blob-upload.js
//
// Server-side upload — the file comes straight through this function and
// gets stored via Blob's own put(), rather than the two-step client-upload
// handshake (get a token, then upload directly to Blob from the browser).
//
// Switched from the client-upload pattern specifically because it exists
// to bypass a 4.5MB function body limit for LARGE files — something we
// don't need, since token logos are capped at 5MB and realistically much
// smaller. The client pattern also has real, documented flakiness (hangs,
// CORS quirks) that a direct server upload avoids entirely.
//
// Requires @vercel/blob installed and Blob storage connected, same as
// before — no new setup needed beyond what's already configured.

import { put } from "@vercel/blob";
import { checkRateLimit } from "./rateLimit.js";

export const config = {
  api: {
    bodyParser: false, // reading the raw file stream directly
  },
};

// Real magic-byte signatures for the image formats a token logo upload
// actually needs — checked against the real file BYTES, not the
// client-supplied Content-Type header, which anyone can set to
// whatever passes the string check below regardless of what's actually
// in the request body (this endpoint's own real gap before this: a
// request claiming Content-Type: image/svg+xml could carry ANY bytes —
// arbitrary HTML/script content — and still get accepted and hosted
// under an "image" content type). SVG deliberately excluded: it's a
// text format (no fixed magic bytes to check) that can itself embed
// <script>, so it isn't a safe upload type for a public, unauthenticated
// endpoint regardless of what the client claims about it.
const MAGIC_BYTES = {
  "image/png": [0x89, 0x50, 0x4e, 0x47],
  "image/jpeg": [0xff, 0xd8, 0xff],
  "image/gif": [0x47, 0x49, 0x46, 0x38],
  "image/webp": [0x52, 0x49, 0x46, 0x46], // "RIFF" — WEBPs's real container signature
};

function matchesRealImageBytes(buffer) {
  return Object.values(MAGIC_BYTES).some((sig) => sig.every((byte, i) => buffer[i] === byte));
}

export default async function handler(request, response) {
  if (request.method !== "POST") {
    return response.status(405).json({ error: "Method not allowed" });
  }

  // Real gap this closes: this endpoint had ZERO rate limiting or
  // authentication of any kind — unlike every api/v1/* write endpoint
  // (rateLimit.js's own header) — meaning anyone could POST unlimited
  // "logo" uploads to public Blob storage for free, forever: a real
  // storage-cost/spam vector with no cost to the caller.
  if (!(await checkRateLimit(request, response, { name: "blob-upload", limit: 10 }))) return;

  try {
    const filename = request.headers["x-filename"] || `logo-${Date.now()}`;
    const contentType = request.headers["content-type"] || "application/octet-stream";

    if (!contentType.startsWith("image/")) {
      return response.status(400).json({ error: "Only image uploads are allowed" });
    }

    // Collect the raw request body directly — small files (a few MB at
    // most), so buffering in memory is genuinely fine here.
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);

    if (buffer.length > 5 * 1024 * 1024) {
      return response.status(400).json({ error: "File too large — 5MB max" });
    }

    if (!matchesRealImageBytes(buffer)) {
      return response.status(400).json({ error: "File content doesn't match a supported image format (PNG/JPEG/GIF/WEBP)." });
    }

    const blob = await put(filename, buffer, {
      access: "public",
      contentType,
      addRandomSuffix: true,
    });

    return response.status(200).json({ url: blob.url });
  } catch (error) {
    return response.status(500).json({ error: error.message });
  }
}
