// api/blob-upload.js
//
// Handles the client-upload handshake for Vercel Blob. The actual image
// bytes never pass through this function — the browser uploads directly to
// Blob storage using a short-lived token this endpoint issues. This avoids
// routing potentially large files through a serverless function's payload
// limits, and keeps uploads fast on a mobile connection.
//
// Requires @vercel/blob installed, and Blob storage enabled in the Vercel
// project dashboard (Storage tab) — this is a one-time setup step outside
// of code, not something deploying this file alone handles.

import { handleUpload } from "@vercel/blob/client";

export default async function handler(request, response) {
  if (request.method !== "POST") {
    return response.status(405).json({ error: "Method not allowed" });
  }

  try {
    const body = request.body;

    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname) => {
        // Restrict uploads to image files, under a reasonable size — no
        // reason a token logo needs to be more than a couple MB.
        return {
          allowedContentTypes: ["image/png", "image/jpeg", "image/gif", "image/webp"],
          maximumSizeInBytes: 5 * 1024 * 1024, // 5MB
          addRandomSuffix: true, // avoids collisions if two tokens use the same filename
        };
      },
      onUploadCompleted: async () => {
        // Nothing needed here — the frontend receives the real URL
        // directly from the upload call itself and handles saving the
        // address->logo mapping as its own separate, explicit step.
      },
    });

    return response.status(200).json(jsonResponse);
  } catch (error) {
    return response.status(400).json({ error: error.message });
  }
}
