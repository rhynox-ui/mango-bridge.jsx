// api/rateLimit.js
//
// Real per-IP rate limiting for the public api/v1/* endpoints, using the
// same Vercel Blob store already set up for caching (api/token-activity.js)
// — no new infrastructure, no new credentials to provision. Before this,
// every api/v1 endpoint was completely open: anyone could hammer them with
// unlimited requests, several of which trigger real on-chain RPC calls per
// hit.
//
// GENUINE, NAMED LIMITATIONS, not hidden:
// - The read-check-write here isn't atomic. Two concurrent requests in the
//   same window can both read the same count and each write count+1,
//   under-counting slightly under real concurrency. That's the safe
//   failure direction (an abuser gets a few extra requests, not a real
//   user getting wrongly blocked), but it means this is a real deterrent,
//   not a mathematically exact cap.
// - If the Blob write itself fails, this fails OPEN (allows the request)
//   rather than blocking real traffic over a transient storage error —
//   same failure-direction choice already made throughout this codebase's
//   own caching code.
// - Every checked request costs two Blob operations (a head+fetch, and a
//   put) — real latency and real Vercel Blob usage cost per request, on
//   top of whatever the endpoint itself was already doing.

import { put, head } from "@vercel/blob";

const WINDOW_MS = 60 * 1000; // 1-minute fixed windows

function getClientIp(request) {
  const forwarded = request.headers["x-forwarded-for"];
  if (forwarded) return forwarded.split(",")[0].trim();
  return request.socket?.remoteAddress || "unknown";
}

// Returns true if the request is allowed to proceed. If not, this already
// writes the 429 response itself — the caller just needs to `return`.
export async function checkRateLimit(request, response, { name, limit = 30 }) {
  const ip = getClientIp(request);
  const windowStart = Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS;
  const key = `ratelimit-${name}-${ip}-${windowStart}.json`;

  let count = 0;
  try {
    const blobInfo = await head(key);
    const res = await fetch(blobInfo.url);
    const data = await res.json();
    count = data.count || 0;
  } catch {
    count = 0; // no entry yet this window
  }

  if (count >= limit) {
    response.setHeader("Retry-After", Math.ceil((windowStart + WINDOW_MS - Date.now()) / 1000));
    response.status(429).json({ error: `Too many requests. Limit is ${limit} per minute — please slow down.` });
    return false;
  }

  try {
    await put(key, JSON.stringify({ count: count + 1 }), {
      access: "public",
      contentType: "application/json",
      addRandomSuffix: false,
      allowOverwrite: true,
    });
  } catch {
    // Fail open — see the module-level comment above.
  }

  return true;
}
