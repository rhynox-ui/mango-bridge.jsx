// api/automation-worker.js
//
// POST /api/automation-worker
// Header: X-Automation-Secret: <QSTASH_TOKEN>
//
// The ONLY thing this does is detect conditions and queue jobs — it
// never signs or broadcasts anything (see automationStore.js's own
// header for the full non-custodial reasoning). Triggered on a
// schedule by Upstash QStash, which is what actually wakes this up
// periodically; Vercel itself has no cron involved. Not part of the
// public api/v1/* surface (no rate limit here — it's locked down by
// the shared secret below, not by request volume from arbitrary
// callers), same reasoning api/token-activity.js's own internal-only
// endpoints already follow.
//
// Set up ONCE, by hand, after this is deployed: create an Upstash
// QStash schedule (either via the QStash dashboard, or its REST API)
// pointed at this endpoint's real URL
// (https://mangoprotocol.site/api/automation-worker), method POST,
// a cron of e.g. "*/2 * * * *" (every 2 minutes — DCA/limit orders
// aren't time-critical enough server-side to need every-minute checks,
// and this halves QStash usage), with a custom header
// "X-Automation-Secret: <the real QSTASH_TOKEN value>" so this
// endpoint can verify the call genuinely came from that schedule and
// not an arbitrary POST from anyone who finds the URL.

import { currencyAddress, MAINNET_CHAIN_IDS, assetDecimalsForChain, ASSET_ONCHAIN_DECIMALS } from "../src/chainData.js";
import { fetchWalletPrices, SYMBOL_TO_COINGECKO_ID } from "../src/wallet/walletPrices.js";
import {
  dueAutomationIds,
  getAutomationRecord,
  markAutomationExpired,
  queueJobIfNotInflight,
  removeFromDueSet,
  rescheduleAutomationCheck,
} from "./automationStore.js";

// Re-check a Limit order that didn't trigger this tick again in 2
// minutes — same cadence as the QStash schedule itself is set up for,
// so a check doesn't sit needlessly stale between ticks.
const LIMIT_RECHECK_MS = 2 * 60 * 1000;

function isExpired(record, now) {
  return typeof record.config?.expiresAt === "number" && record.config.expiresAt > 0 && now >= record.config.expiresAt;
}

/** Verbatim mirror of mango-mobile's automationEngine.ts own isLimitTriggered — kept in sync by hand, same process this file's own header already documents for SUPPORTED_AUTOMATION_CHAINS. */
function isLimitTriggered(record, currentPriceUsd) {
  if (currentPriceUsd == null || typeof record.config.triggerPriceUsd !== "number") return false;
  if (record.config.triggerDirection === "above") return currentPriceUsd >= record.config.triggerPriceUsd;
  if (record.config.triggerDirection === "below") return currentPriceUsd <= record.config.triggerPriceUsd;
  return false;
}

async function processDue(id, now) {
  const record = await getAutomationRecord(id);
  if (!record || record.status !== "active") {
    await removeFromDueSet(id);
    return { skipped: true };
  }
  if (isExpired(record, now)) {
    await markAutomationExpired(record);
    return { expired: true };
  }

  if (record.type === "dca") {
    const job = await queueJobIfNotInflight(record);
    if (job) await removeFromDueSet(id);
    return { queued: !!job };
  }

  // Limit — only ever checked against a real, verified CoinGecko price
  // (walletPrices.js's own conservative symbol map). A watchedAsset
  // outside that set was already rejected at creation time
  // (validateAutomationConfig doesn't check this specifically, but the
  // mobile app never offers it — this is a defense-in-depth guard, not
  // the primary one), so this should never actually happen; if it
  // somehow does, the order just keeps getting rechecked rather than
  // silently firing on a guessed price.
  if (!SYMBOL_TO_COINGECKO_ID[record.config.watchedAsset]) {
    await rescheduleAutomationCheck(id, now + LIMIT_RECHECK_MS);
    return { skipped: true, reason: "watchedAsset has no verified price source" };
  }

  let prices;
  try {
    prices = await fetchWalletPrices();
  } catch {
    await rescheduleAutomationCheck(id, now + LIMIT_RECHECK_MS);
    return { skipped: true, reason: "price fetch failed" };
  }
  const currentPriceUsd = prices[record.config.watchedAsset];
  if (!isLimitTriggered(record, currentPriceUsd)) {
    await rescheduleAutomationCheck(id, now + LIMIT_RECHECK_MS);
    return { triggered: false };
  }

  // Confirms the chain/asset pair actually still resolves to a real,
  // verified currency before queuing — the mobile app's own
  // executeOrder does this same resolution again independently right
  // before it signs anything, so this is a fast-fail, not the only
  // safety net.
  try {
    currencyAddress(record.config.chainKey, record.config.fromAsset);
    currencyAddress(record.config.chainKey, record.config.toAsset);
    const decimals = assetDecimalsForChain(record.config.chainKey, record.config.fromAsset) ?? ASSET_ONCHAIN_DECIMALS[record.config.fromAsset];
    if (decimals === undefined || !MAINNET_CHAIN_IDS[record.config.chainKey]) throw new Error("unresolvable pair");
  } catch {
    await rescheduleAutomationCheck(id, now + LIMIT_RECHECK_MS);
    return { skipped: true, reason: "chain/asset pair no longer resolvable" };
  }

  const job = await queueJobIfNotInflight(record);
  if (job) await removeFromDueSet(id);
  return { triggered: true, queued: !!job };
}

export default async function handler(request, response) {
  if (request.method !== "POST") {
    return response.status(405).json({ error: "Method not allowed. This endpoint only supports POST." });
  }

  const secret = process.env.QSTASH_TOKEN;
  if (!secret) {
    return response.status(503).json({ error: "Automation worker is not configured." });
  }
  if (request.headers["x-automation-secret"] !== secret) {
    return response.status(401).json({ error: "Unauthorized." });
  }

  try {
    const now = Date.now();
    const ids = await dueAutomationIds(now, 50);
    const results = await Promise.allSettled(ids.map((id) => processDue(id, now)));
    const queued = results.filter((r) => r.status === "fulfilled" && r.value?.queued).length;
    return response.status(200).json({ ok: true, checked: ids.length, queued });
  } catch (err) {
    return response.status(500).json({ error: err?.message || "Automation worker failed." });
  }
}
