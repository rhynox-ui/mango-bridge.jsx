// api/referralStore.js
//
// Real, persistent referral points ledger — the referral program's
// signup bonus (1000 points) and per-referral reward (100 points) need
// a server-side, tamper-resistant store keyed by wallet address: an
// on-device-only points counter would be trivially editable by the
// user themselves, so it wouldn't be a real reward system. Points are
// keyed by wallet address rather than any account/login, so re-
// importing the same seed phrase on any device reunites the wallet
// with its existing points automatically — no separate sync needed.
//
// Uses Upstash Redis (NOT Vercel's own now-defunct KV/Postgres
// products, deprecated Dec 2024) via the standard @upstash/redis
// client, which reads UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN
// from the environment automatically once the Upstash integration is
// connected in the Vercel dashboard's Storage tab.
//
// Deliberately a different backing store than rateLimit.js's Vercel
// Blob counters: Blob's read-check-write is explicitly documented
// there as non-atomic (an acceptable, named tradeoff for a soft
// rate-limit counter). A real points balance needs true atomic
// increments — Redis's HINCRBY/HSETNX are exactly that, and are what
// every guarantee below actually relies on.

import { Redis } from "@upstash/redis";

const REFERRAL_SIGNUP_BONUS = 1000;
const REFERRAL_REWARD = 100;
const MAX_REFERRALS_PER_DAY = 30;
const DAILY_KEY_TTL_SECONDS = 60 * 60 * 25; // slightly over 24h so a slow clock never lets a key expire early
const DAILY_CHECKIN_POINTS = 150;
const DAILY_CHECKIN_COOLDOWN_SECONDS = 60 * 60 * 24;

let redis = null;
function getRedis() {
  if (!redis) {
    redis = Redis.fromEnv();
  }
  return redis;
}

const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
// Twitter-style handle: letters/digits/underscore only, 3-20 chars —
// short enough to fit comfortably in a shared link, long enough to rule
// out near-total collisions. Case-insensitive for uniqueness/lookup
// (handleKey below always lowercases), but the user's own chosen casing
// is preserved for display (setHandle stores the raw value it's given).
const HANDLE_RE = /^[a-zA-Z0-9_]{3,20}$/;

export function isValidAddress(address) {
  return typeof address === "string" && EVM_ADDRESS_RE.test(address);
}

export function isValidHandle(handle) {
  return typeof handle === "string" && HANDLE_RE.test(handle);
}

function referralKey(address) {
  return `referral:${address.toLowerCase()}`;
}

function handleKey(handle) {
  return `referral-handle:${handle.toLowerCase()}`;
}

export async function getReferralStats(address) {
  const client = getRedis();
  const [record, dailyLockTtl] = await Promise.all([
    client.hgetall(referralKey(address)),
    client.ttl(`daily-claim-lock:${address.toLowerCase()}`),
  ]);
  return {
    address: address.toLowerCase(),
    points: Number(record?.points || 0),
    referralCount: Number(record?.referralCount || 0),
    referredBy: record?.referredBy || null,
    handle: record?.handle || null,
    // So the dashboard can show accurate "already claimed today" state
    // on load, without needing the user to tap Claim first just to
    // discover it's on cooldown.
    dailyCooldownSeconds: dailyLockTtl > 0 ? dailyLockTtl : 0,
  };
}

/**
 * Claims a custom referral handle for `address` — a friendlier,
 * memorable stand-in for a raw 0x address in a shared invite link.
 * Strictly 1-to-1 and immutable once set (same "Twitter-style" real
 * uniqueness requested, minus rename support — a rename would need to
 * atomically release the old reverse-lookup key too, a real additional
 * failure mode not worth taking on until renaming is actually asked
 * for): an address that already has one is rejected outright rather
 * than silently overwriting it.
 *
 * The actual uniqueness guarantee is `client.set(..., {nx: true})` on
 * the reverse-lookup key below — same atomic-claim pattern
 * claimReferral's own HSETNX/claimDailyPoints's own SET-NX already
 * establish in this file: only the first caller to reach it for a given
 * handle ever succeeds, even under concurrent duplicate requests, so
 * this is a real guarantee, not just an application-level check.
 */
export async function setHandle(address, handle) {
  const client = getRedis();
  const existing = await client.hget(referralKey(address), "handle");
  if (existing) {
    return { ok: false, reason: "already-set", handle: existing };
  }

  const claimed = await client.set(handleKey(handle), address.toLowerCase(), { nx: true });
  if (!claimed) {
    return { ok: false, reason: "taken" };
  }

  await client.hset(referralKey(address), { handle });
  return { ok: true, handle };
}

/** Resolves a claimed handle to its underlying wallet address, or null if nothing's claimed it. */
export async function resolveHandle(handle) {
  const client = getRedis();
  const address = await client.get(handleKey(handle));
  return address || null;
}

/**
 * Credits the signup bonus to `address` (only ever once, atomically
 * gated — a repeat call is a real 409, not a silent no-op) and the
 * referral reward to `referrer`, unless `referrer` has already hit
 * today's referral cap, in which case the new wallet still gets its
 * own signup bonus but the referrer's reward is skipped for this one.
 *
 * Returns { alreadyClaimed: boolean, referrerCapped: boolean }.
 */
export async function claimReferral({ address, referrer }) {
  const client = getRedis();
  const key = referralKey(address);

  // Atomic one-time gate: HSETNX only succeeds (returns 1) the very
  // first time this field is ever set for this address, even under
  // concurrent duplicate requests — this IS the "never claim twice"
  // guarantee, not just an application-level check.
  const firstClaim = await client.hsetnx(key, "claimed", "1");
  if (!firstClaim) {
    return { alreadyClaimed: true, referrerCapped: false };
  }

  await client.hset(key, {
    referredBy: referrer.toLowerCase(),
    createdAt: Date.now(),
  });
  await client.hincrby(key, "points", REFERRAL_SIGNUP_BONUS);

  const today = new Date().toISOString().slice(0, 10);
  const dailyKey = `referral-daily:${referrer.toLowerCase()}:${today}`;
  const dailyCount = await client.incr(dailyKey);
  if (dailyCount === 1) {
    await client.expire(dailyKey, DAILY_KEY_TTL_SECONDS);
  }

  const referrerCapped = dailyCount > MAX_REFERRALS_PER_DAY;
  if (!referrerCapped) {
    const referrerKey = referralKey(referrer);
    await client.hincrby(referrerKey, "points", REFERRAL_REWARD);
    await client.hincrby(referrerKey, "referralCount", 1);
  }

  return { alreadyClaimed: false, referrerCapped };
}

/**
 * Daily check-in bonus. The anti-farm guarantee is entirely the SET-NX
 * lock below, not application logic: SET key value NX EX <ttl> is a
 * single atomic Redis command that only succeeds if the key doesn't
 * already exist, so two concurrent duplicate requests can't both win
 * it — one gets the points, the other gets "already claimed", even if
 * they arrive in the same millisecond. The lock self-expires (no
 * cleanup job needed), and points are only ever touched via HINCRBY
 * (additive), never HSET/overwrite — a user's balance can go up from
 * this, never down, and never gets clobbered.
 */
export async function claimDailyPoints(address) {
  const client = getRedis();
  const lockKey = `daily-claim-lock:${address.toLowerCase()}`;

  const acquired = await client.set(lockKey, Date.now(), {
    nx: true,
    ex: DAILY_CHECKIN_COOLDOWN_SECONDS,
  });
  if (!acquired) {
    const ttl = await client.ttl(lockKey);
    return { claimed: false, secondsUntilNextClaim: ttl > 0 ? ttl : DAILY_CHECKIN_COOLDOWN_SECONDS };
  }

  await client.hincrby(referralKey(address), "points", DAILY_CHECKIN_POINTS);
  return { claimed: true, pointsAwarded: DAILY_CHECKIN_POINTS };
}

/**
 * Removes every server-side key this store ever writes for `address` —
 * the real, automated version of the manual email-request flow
 * (app-delete-data.html). Four keys, all namespaced by this exact
 * address:
 *  - `referral:<address>` — the main hash (points, referralCount,
 *    referredBy, handle, the one-time claimed flag, createdAt).
 *  - `daily-claim-lock:<address>` — their own check-in cooldown lock.
 *  - `referral-daily:<address>:<today>` — today's count of referrals
 *    THEY made as a referrer, if any. Past days' equivalents are
 *    already gone (DAILY_KEY_TTL_SECONDS self-expires them), so only
 *    today's can still exist to delete.
 *  - `referral-handle:<handle>` — their claimed handle's reverse-lookup
 *    entry, if they ever set one. Read from the main hash BEFORE it's
 *    deleted, since the reverse key is keyed by handle text, not
 *    address — without releasing this, a deleted account's handle would
 *    stay permanently squatted, unclaimable even by the same person
 *    re-onboarding with a fresh wallet.
 * Deliberately does NOT touch other addresses' `referredBy` pointers —
 * a referral this address made stays a real, already-happened event in
 * the referrer's own ledger (referralCount/points already credited);
 * deleting this address's record doesn't retroactively unwind rewards
 * someone else already received, the same way deleting a bank
 * transaction's source account doesn't undo the destination's balance.
 */
export async function deleteReferralRecord(address) {
  const client = getRedis();
  const today = new Date().toISOString().slice(0, 10);
  const handle = await client.hget(referralKey(address), "handle");
  await Promise.all([
    client.del(referralKey(address)),
    client.del(`daily-claim-lock:${address.toLowerCase()}`),
    client.del(`referral-daily:${address.toLowerCase()}:${today}`),
    ...(handle ? [client.del(handleKey(handle))] : []),
  ]);
  return { deleted: true };
}

/**
 * Every referral record ever created, for reward distribution — nothing
 * in this store previously listed them; getReferralStats/claimReferral
 * only ever operate on one already-known address at a time. Real gap,
 * not a design choice: no set of "every address that's claimed" was
 * ever maintained, so this uses Redis's own SCAN (cursor-paginated key
 * iteration, never blocks the server the way a bare KEYS call would on
 * a large keyspace) to walk every `referral:*` key directly, then reads
 * each hash. Works retroactively on every record that already exists —
 * no backfill needed, since it doesn't depend on anything being written
 * at claim time.
 *
 * Not paginated at the API layer (see admin-export.js) — this is an
 * operator export, not a user-facing list, and even thousands of
 * records is a small response by that standard.
 */
export async function listAllReferralRecords() {
  const client = getRedis();
  const records = [];
  let cursor = "0";
  do {
    const [nextCursor, keys] = await client.scan(cursor, { match: "referral:*", count: 100 });
    cursor = nextCursor;
    if (keys.length === 0) continue;
    const hashes = await Promise.all(keys.map((key) => client.hgetall(key)));
    keys.forEach((key, i) => {
      const record = hashes[i];
      if (!record) return;
      records.push({
        address: key.slice("referral:".length),
        points: Number(record.points || 0),
        referralCount: Number(record.referralCount || 0),
        referredBy: record.referredBy || null,
        handle: record.handle || null,
        createdAt: record.createdAt ? Number(record.createdAt) : null,
      });
    });
  } while (cursor !== "0");
  return records;
}

export { REFERRAL_SIGNUP_BONUS, REFERRAL_REWARD, MAX_REFERRALS_PER_DAY, DAILY_CHECKIN_POINTS, DAILY_CHECKIN_COOLDOWN_SECONDS };
