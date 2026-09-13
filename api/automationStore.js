// api/automationStore.js
//
// Real, persisted DCA and Limit orders for Mango Wallet's on-device
// automation feature (mango-mobile's src/automation/) — this backend
// ONLY ever schedules and detects conditions, it never signs or holds
// a private key. The mobile app authenticates once via a real
// challenge/sign/verify flow (same non-custodial pattern
// api/v1/referral/claim.js already uses — a signature proves wallet
// ownership without the wallet ever handing over its key), then polls
// for "ready" jobs and executes each one ENTIRELY on-device with its
// own key, exactly like every other transaction this wallet ever
// signs. This store's own job records only ever describe WHAT to swap
// (chain, assets, amount) — never HOW to sign it.
//
// Uses Upstash Redis via @upstash/redis, same as referralStore.js —
// see that file's own header for why (not Vercel's now-defunct KV/
// Postgres products) and for the atomicity conventions this file
// follows (SET NX EX for real locks, never a read-then-write race).
//
// One canonical record per automation (`automation:record:{id}`), not
// two owner-scoped and id-scoped copies of the same JSON the way an
// earlier prototype of this feature did — a dual-write can partially
// fail and leave the two copies disagreeing about an order's own
// status, which is exactly the kind of bug that would make an order
// silently re-fire or silently stop. `automation:owned:{address}` is
// just an index (a Redis SET of ids), never a second source of truth.

import { Redis } from "@upstash/redis";

let redis = null;
function getRedis() {
  if (!redis) {
    redis = Redis.fromEnv();
  }
  return redis;
}

const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
export function isValidAddress(address) {
  return typeof address === "string" && EVM_ADDRESS_RE.test(address);
}

function normalizedAddress(address) {
  if (!isValidAddress(address)) throw new Error("Invalid wallet address.");
  return address.toLowerCase();
}

const CHALLENGE_TTL_SECONDS = 300; // 5 minutes — long enough to sign, short enough that a stale nonce can't be replayed much later
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
const JOB_TTL_SECONDS = 60 * 60 * 24; // 24 hours — a claimed-but-never-acked job still needs to be inspectable for a day
const INFLIGHT_LOCK_SECONDS = 300; // how long one automation can have an outstanding, unclaimed/unacked job before it's eligible to be queued again
const CLAIM_LOCK_SECONDS = 300;
export const MAX_ACTIVE_AUTOMATIONS_PER_ADDRESS = 20;

// Every chain automationEngine.ts (mango-mobile) actually offers —
// kept in sync BY HAND with that file's own automationChains(), same
// "no automated sync between the two repos" process chainData.js's
// own header already documents for everything else shared between
// them. A request for any other network is rejected outright: this
// backend has no way to verify what an unlisted network even means.
export const SUPPORTED_AUTOMATION_CHAINS = new Set(["ethereum", "base", "bnb", "robinhood", "arbitrum", "avalanche", "unichain"]);

function randomToken(bytes = 32) {
  const bytesOut = new Uint8Array(bytes);
  crypto.getRandomValues(bytesOut);
  return Buffer.from(bytesOut).toString("hex");
}

/**
 * Deliberately NOT a bare nonce — a real, purpose-scoped message
 * (closer to SIWE's own intent than a generic "sign this") so a
 * captured signature can never be confused with authorizing anything
 * else, and states plainly that this never grants spending access,
 * since a user asked to sign something wallet-related deserves to know
 * exactly what it does and doesn't do.
 */
export function messageForChallenge(address, nonce) {
  return [
    "Mango automation login",
    "",
    `Wallet: ${address.toLowerCase()}`,
    `Nonce: ${nonce}`,
    "Purpose: authorize Mango Wallet to store and schedule your DCA/limit orders on this server.",
    "This does NOT grant spending, signing, or transfer access — Mango Wallet only ever signs transactions on your own device.",
  ].join("\n");
}

export async function createChallenge(address) {
  const owner = normalizedAddress(address);
  const nonce = randomToken(16);
  await getRedis().set(`automation:nonce:${owner}`, nonce, { ex: CHALLENGE_TTL_SECONDS });
  return messageForChallenge(owner, nonce);
}

/**
 * `verifyMessageFn` is injected (rather than importing viem's
 * verifyMessage directly in this file) purely so scripts/verify-automation.mjs
 * can exercise the real challenge/message logic offline with a real
 * signature, without needing a live Redis connection for the parts
 * that don't need one — same reasoning verify-referral.mjs's own
 * boundary already documents.
 */
export async function verifyChallenge({ address, message, signature, verifyMessageFn }) {
  const owner = normalizedAddress(address);
  const client = getRedis();
  const nonceKey = `automation:nonce:${owner}`;
  const nonce = await client.get(nonceKey);
  if (!nonce) return { ok: false, error: "Challenge expired or was never requested — request a new one." };

  const expected = messageForChallenge(owner, nonce);
  if (message !== expected) return { ok: false, error: "Message does not match the expected challenge." };

  let valid = false;
  try {
    valid = await verifyMessageFn({ address: owner, message, signature });
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, error: "Signature does not match the claimed address." };

  const token = randomToken(32);
  await client.set(`automation:session:${token}`, owner, { ex: SESSION_TTL_SECONDS });
  await client.del(nonceKey);
  return { ok: true, token, expiresIn: SESSION_TTL_SECONDS };
}

export async function requireSession(request) {
  const authorization = String(request.headers.authorization || "");
  if (!authorization.startsWith("Bearer ")) throw new Error("Missing automation session token.");
  const owner = await getRedis().get(`automation:session:${authorization.slice(7)}`);
  if (!owner) throw new Error("Automation session expired — sign in again.");
  return owner;
}

function normalizeExpiryMs(rawExpiresInMs) {
  if (rawExpiresInMs == null || rawExpiresInMs === "") return null;
  const ms = Number(rawExpiresInMs);
  if (!Number.isFinite(ms) || ms <= 0) throw new Error("Invalid expiry.");
  return Date.now() + ms;
}

/**
 * Real, meaningful validation — not exhaustive, but everything here
 * catches a genuinely malformed request before it's ever stored, same
 * as every other api/v1/* endpoint's own input checks. A chain/asset
 * pair that's syntactically valid but doesn't actually resolve to a
 * real currency (e.g. a token this backend has no verified address
 * for) is caught later, when the worker actually tries to price/check
 * it — see automation-worker.js's own comment on why that's the right
 * layer for that specific check, not here.
 */
export function validateAutomationConfig(type, config) {
  if (!config || typeof config !== "object") throw new Error("Automation configuration is required.");
  if (!SUPPORTED_AUTOMATION_CHAINS.has(String(config.chainKey))) throw new Error("Unsupported chain for automation.");
  if (typeof config.fromAsset !== "string" || !config.fromAsset) throw new Error("fromAsset is required.");
  if (typeof config.toAsset !== "string" || !config.toAsset) throw new Error("toAsset is required.");
  if (config.fromAsset === config.toAsset) throw new Error("fromAsset and toAsset must be different.");
  if (!(Number(config.amount) > 0)) throw new Error("amount must be a positive number.");

  if (type === "dca") {
    if (!(Number(config.intervalMs) >= 60_000)) throw new Error("DCA interval must be at least 1 minute.");
    if (config.totalRuns != null && !(Number(config.totalRuns) > 0)) throw new Error("Invalid DCA run cap.");
  } else if (type === "limit") {
    if (typeof config.watchedAsset !== "string" || !config.watchedAsset) throw new Error("watchedAsset is required.");
    if (!(Number(config.triggerPriceUsd) > 0)) throw new Error("triggerPriceUsd must be a positive number.");
    if (config.triggerDirection !== "above" && config.triggerDirection !== "below") throw new Error("triggerDirection must be 'above' or 'below'.");
  } else {
    throw new Error("Unsupported automation type.");
  }
}

export async function listAutomations(owner) {
  const client = getRedis();
  const ids = (await client.smembers(`automation:owned:${owner}`)) || [];
  if (ids.length === 0) return [];
  const records = await Promise.all(ids.map((id) => client.get(`automation:record:${id}`)));
  return records.filter(Boolean).sort((a, b) => Number(b.createdAt) - Number(a.createdAt));
}

export async function createAutomation(owner, type, config) {
  validateAutomationConfig(type, config);
  const client = getRedis();

  const existingIds = (await client.smembers(`automation:owned:${owner}`)) || [];
  if (existingIds.length >= MAX_ACTIVE_AUTOMATIONS_PER_ADDRESS) {
    throw new Error(`You've reached the limit of ${MAX_ACTIVE_AUTOMATIONS_PER_ADDRESS} automations per wallet.`);
  }

  const expiresAt = normalizeExpiryMs(config.expiresInMs);
  const id = `${type}-${Date.now()}-${randomToken(6)}`;
  const nextCheckAt = type === "dca" ? Date.now() + Number(config.intervalMs) : Date.now();
  const record = {
    id,
    type,
    owner,
    status: "active",
    config: { ...config, expiresAt, expiresInMs: undefined },
    runsCompleted: 0,
    createdAt: Date.now(),
  };

  await client.set(`automation:record:${id}`, record);
  await client.sadd(`automation:owned:${owner}`, id);
  await client.zadd("automation:due", { score: nextCheckAt, member: id });
  return record;
}

export async function cancelAutomation(owner, id) {
  const client = getRedis();
  const record = await client.get(`automation:record:${id}`);
  if (!record || record.owner !== owner) throw new Error("Automation not found.");
  record.status = "cancelled";
  record.cancelledAt = Date.now();
  await client.set(`automation:record:${id}`, record);
  await client.zrem("automation:due", id);
  await client.del(`automation:inflight:${id}`);
  return record;
}

export async function listReadyJobs(owner) {
  const client = getRedis();
  const jobIds = (await client.lrange(`automation:ready:${owner}`, 0, 49)) || [];
  if (jobIds.length === 0) return [];
  const jobs = await Promise.all(jobIds.map((jobId) => client.get(`automation:job:${jobId}`)));
  return jobs.filter((job) => job && job.status === "ready");
}

/**
 * Claim is itself the concurrency guard: SET NX EX only succeeds once
 * per job, even under two devices (or two tabs) racing to claim the
 * exact same job at the same moment — one gets it, the other gets a
 * real 409, never a silent double-claim.
 */
export async function claimJob(owner, jobId) {
  const client = getRedis();
  const job = await client.get(`automation:job:${jobId}`);
  if (!job) throw new Error("Automation job not found.");
  if (job.owner !== owner) throw new Error("This job does not belong to your wallet.");
  if (job.status !== "ready") throw new Error("This job is no longer ready to claim.");

  const acquired = await client.set(`automation:claim:${jobId}`, owner, { nx: true, ex: CLAIM_LOCK_SECONDS });
  if (!acquired) throw new Error("This job was already claimed.");

  job.status = "claimed";
  job.claimedAt = Date.now();
  await client.set(`automation:job:${jobId}`, job, { ex: JOB_TTL_SECONDS });
  return job;
}

/**
 * Advances the parent automation's own schedule/status after a claimed
 * job finishes — DCA re-arms for its next interval (or completes once
 * its run cap is hit), a Limit order completes on a real fill (one-shot,
 * same as a real exchange limit order) or stays active to keep watching
 * on a skip/failure. A 'pending' result (the mobile app broadcast a
 * transaction but couldn't confirm it — see mango-mobile's own
 * txHistory.js doc on why that's tracked separately from a clean
 * failure) marks the AUTOMATION itself 'pending' too and does NOT
 * re-arm it: firing again while a prior attempt might still land risks
 * a real double-execution, so it waits for the owner to review and
 * resume it from the app, exactly like a local-only order already does.
 */
export async function ackJob(owner, jobId, { status, hashes, error }) {
  const client = getRedis();
  const job = await client.get(`automation:job:${jobId}`);
  if (!job) throw new Error("Automation job not found.");
  if (job.owner !== owner) throw new Error("This job does not belong to your wallet.");
  if (job.status === "done") return { ok: true, duplicate: true };

  const claimant = await client.get(`automation:claim:${jobId}`);
  if (claimant !== owner) throw new Error("This job is not claimed by your wallet.");

  await client.lrem(`automation:ready:${owner}`, 1, jobId);
  await client.del(`automation:claim:${jobId}`);
  await client.del(`automation:inflight:${job.automationId}`);
  await client.set(`automation:job:${jobId}`, { ...job, status: "done", result: { status, hashes, error }, finishedAt: Date.now() }, { ex: JOB_TTL_SECONDS });

  const record = await client.get(`automation:record:${job.automationId}`);
  if (!record || record.status !== "active") return { ok: true };

  if (status === "pending") {
    record.status = "pending";
    await client.zrem("automation:due", record.id);
  } else if (record.config.expiresAt && Date.now() >= Number(record.config.expiresAt)) {
    record.status = "expired";
    await client.zrem("automation:due", record.id);
  } else if (record.type === "limit") {
    if (status === "success") {
      record.status = "completed";
      await client.zrem("automation:due", record.id);
    } else {
      // A skip (e.g. insufficient balance) or a clean failure with no
      // broadcast — safe to keep watching, same as a local-only order.
      await client.zadd("automation:due", { score: Date.now() + 60_000, member: record.id });
    }
  } else {
    // DCA
    if (status === "success") record.runsCompleted = Number(record.runsCompleted || 0) + 1;
    const cap = Number(record.config.totalRuns);
    if (Number.isFinite(cap) && cap > 0 && record.runsCompleted >= cap) {
      record.status = "completed";
      await client.zrem("automation:due", record.id);
    } else {
      const nextCheckAt = Date.now() + Number(record.config.intervalMs);
      record.config.nextCheckAt = nextCheckAt;
      await client.zadd("automation:due", { score: nextCheckAt, member: record.id });
    }
  }

  await client.set(`automation:record:${record.id}`, record);
  return { ok: true, automation: record };
}

/**
 * Called only from automation-worker.js — the ONE inflight lock per
 * automation (SET NX EX) is what actually prevents the same order from
 * being queued a second time while a job from it is still unclaimed or
 * unacked, even if the worker runs again before that job resolves.
 */
export async function queueJobIfNotInflight(record) {
  const client = getRedis();
  const lockKey = `automation:inflight:${record.id}`;
  const acquired = await client.set(lockKey, "1", { nx: true, ex: INFLIGHT_LOCK_SECONDS });
  if (!acquired) return null;

  const jobId = `job-${Date.now()}-${randomToken(6)}`;
  const job = { jobId, automationId: record.id, owner: record.owner, type: record.type, config: record.config, status: "ready", createdAt: Date.now() };
  await client.set(`automation:job:${jobId}`, job, { ex: JOB_TTL_SECONDS });
  await client.rpush(`automation:ready:${record.owner}`, jobId);
  return job;
}

export async function dueAutomationIds(now, limit = 50) {
  const client = getRedis();
  return (await client.zrange("automation:due", 0, now, { byScore: true, offset: 0, count: limit })) || [];
}

/**
 * automation-worker.js's own path for a Limit order it checked but
 * that didn't trigger this tick — no job was ever created (there's
 * nothing for the app to claim/ack), so this is the only place that
 * re-arms its next check, distinct from ackJob's own rescheduling
 * (which only ever runs after a REAL claimed-and-acked job).
 */
export async function rescheduleAutomationCheck(id, whenMs) {
  await getRedis().zadd("automation:due", { score: whenMs, member: id });
}

export async function markAutomationExpired(record) {
  const client = getRedis();
  record.status = "expired";
  record.expiredAt = Date.now();
  await client.set(`automation:record:${record.id}`, record);
  await client.zrem("automation:due", record.id);
}

export async function getAutomationRecord(id) {
  return getRedis().get(`automation:record:${id}`);
}

export async function removeFromDueSet(id) {
  await getRedis().zrem("automation:due", id);
}
