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

export const config = {
  api: {
    bodyParser: false, // reading the raw file stream directly
  },
};

export default async function handler(request, response) {
  if (request.method !== "POST") {
    return response.status(405).json({ error: "Method not allowed" });
  }

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
