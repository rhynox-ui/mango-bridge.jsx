// api/txHistoryStore.js
//
// Real, persistent backup of mobile's own on-device transaction history
// (mango-mobile's src/wallet/txHistory.js) — requested directly: "make
// the notification history standard even if user delete app and
// reinstalled history remain there." AsyncStorage is wiped on
// uninstall, same as any device-local store; re-importing the SAME
// seed phrase after a reinstall derives the exact same address, so
// keying this by wallet address (same pattern referralStore.js/
// automationStore.js already establish) reunites a reinstalled wallet
// with its own history automatically — no separate account/login
// needed, consistent with this whole codebase's non-custodial design.
//
// Deliberately NOT signature-gated the way automationStore.js's own
// writes are: this stores metadata about a transaction that ALREADY
// broadcast (or, for a hard "failed" entry, didn't broadcast at all) —
// never anything that authorizes spending or moves funds, so there's
// no equivalent of automation's "prove you own this wallet before we
// let you schedule a trade from it" concern. The real, if narrow, trust
// gap this accepts: without a signature, anyone who knows an address
// could write junk entries into ITS history. The blast radius is
// genuinely small (this is a locally-displayed activity list, not a
// balance, an approval, or anything that grants access to funds — a
// forged row is a display nuisance, not a financial risk), and every
// entry a client can actually act on (its own explorer link) resolves
// against the real chain regardless of what this store says. Bounded
// with the same defenses used everywhere else in this codebase for a
// similarly low-stakes, unauthenticated write (rate limiting, a hard
// per-address entry cap, a hard payload size cap) rather than adding
// signature-prompt friction to what's meant to be a silent background
// sync after every single trade.
//
// Uses Upstash Redis, same as referralStore.js/automationStore.js —
// see either file's own header for why (not Vercel's now-defunct KV/
// Postgres products).

import { Redis } from "@upstash/redis";

let redis = null;
function getRedis() {
  if (!redis) {
    redis = Redis.fromEnv();
  }
  return redis;
}

// Loose but real validation — EVM (0x + 40 hex) or a plausible Solana
// base58 address (32-44 chars, base58's own real alphabet, no 0/O/I/l).
// Not full checksum/curve-point validation (this is just a storage
// partition key, not an authorization boundary — see this file's own
// header on why a signature-checked address isn't the right bar here),
// but enough to reject obvious garbage before it becomes a Redis key.
const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export function isValidHistoryAddress(address) {
  return typeof address === "string" && (EVM_ADDRESS_RE.test(address) || SOLANA_ADDRESS_RE.test(address));
}

function historyKey(address) {
  // EVM addresses are case-insensitive (checksum casing is a display
  // convention, not identity — same reasoning txHistory.js's own
  // filterTxHistoryForAccount already documents); Solana's base58 is
  // case-sensitive, so only lowercase the EVM shape.
  return `tx-history:${EVM_ADDRESS_RE.test(address) ? address.toLowerCase() : address}`;
}

export const MAX_ENTRIES_PER_ADDRESS = 200; // same cap the on-device store already uses
const MAX_ENTRY_BYTES = 2048; // generous for this entry shape; rejects an abusive oversized payload

/**
 * Real, meaningful validation — same "catch a genuinely malformed
 * request before it's ever stored" bar every other api/v1/* endpoint's
 * own input checks already use (automationStore.js's own
 * validateAutomationConfig, for one). Only entries with at least one
 * real hash are worth syncing at all: a hard "failed" entry (nothing
 * ever broadcast) has no on-chain content a reinstall could otherwise
 * lose, so this rejects those rather than growing the store with
 * routine failures no one needs recovered.
 */
export function validateHistoryEntry(entry) {
  if (!entry || typeof entry !== "object") throw new Error("entry is required.");
  if (typeof entry.chainKey !== "string" || !entry.chainKey) throw new Error("entry.chainKey is required.");
  if (typeof entry.kind !== "string" || !entry.kind) throw new Error("entry.kind is required.");
  if (typeof entry.status !== "string" || !entry.status) throw new Error("entry.status is required.");
  const hasHash = (typeof entry.hash === "string" && entry.hash) || (Array.isArray(entry.hashes) && entry.hashes.some((h) => typeof h === "string" && h));
  if (!hasHash) throw new Error("entry must include at least one real transaction hash.");
  if (JSON.stringify(entry).length > MAX_ENTRY_BYTES) throw new Error("entry is too large.");
}

/**
 * Appends one entry to `address`'s own synced history, deduped by
 * hash (a client retrying the same sync call — e.g. after a flaky
 * network response — must never produce two rows for the one real
 * transaction) and capped to MAX_ENTRIES_PER_ADDRESS (oldest dropped
 * first), same bound the on-device store already enforces.
 */
export async function appendHistoryEntry(address, entry) {
  validateHistoryEntry(entry);
  const client = getRedis();
  const key = historyKey(address);
  const existing = (await client.get(key)) || [];
  const list = Array.isArray(existing) ? existing : [];

  const newHash = entry.hash || entry.hashes?.[0];
  const alreadySynced = list.some((e) => (e.hash || e.hashes?.[0]) === newHash);
  if (alreadySynced) return { synced: false, reason: "already-synced" };

  const next = [entry, ...list].slice(0, MAX_ENTRIES_PER_ADDRESS);
  await client.set(key, next);
  return { synced: true, count: next.length };
}

export async function listHistoryEntries(address) {
  const client = getRedis();
  const existing = await client.get(historyKey(address));
  return Array.isArray(existing) ? existing : [];
}
