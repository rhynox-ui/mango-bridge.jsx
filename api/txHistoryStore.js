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
// Uses Vercel Blob, NOT Upstash Redis — a deliberate choice, changed
// after this first shipped on Redis: this is a low-write, low-read,
// per-address JSON blob (the exact shape logo-registry.js's own
// registry already uses Blob for), and every real write here happens
// silently in the background after every single trade — routing that
// through the metered Redis store this app's OTHER, genuinely
// request-heavy features (automation polling, referral point
// increments) already depend on would compete with them for the same
// quota for no real benefit. Blob is already fully provisioned for
// this app (blob-upload.js, logo-registry.js, rateLimit.js all use
// it), so this adds zero new infrastructure.
//
// Real privacy consideration this addresses: a NAIVE Blob path keyed
// directly by address (e.g. `tx-history/0x1234....json`) would be a
// PUBLICLY FETCHABLE URL for anyone who both knows this store's own
// blob hostname (learnable from any other public blob URL this app
// already serves, like a token logo) and the target address (often
// not secret — shared openly to receive funds) — bypassing this
// store's own rate-limited API entirely and exposing someone's full
// trade history with no access control. blobPath below salts the
// address with HISTORY_SALT (a server-only secret, HMAC-SHA256, same
// signing primitive fallback-quote.js's own okxSignRequest already
// uses) before it's ever used as a path, so the actual blob path for
// a given address is NOT computable by anyone who doesn't also hold
// that secret — closing the enumeration gap a raw address-keyed path
// would have opened. Fails CLOSED if the secret was never configured
// (same "the safer failure direction" admin-export.js's own header
// already establishes for a different secret) rather than silently
// falling back to an unsalted, guessable path.

import { put, head } from "@vercel/blob";
import crypto from "node:crypto";

const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export function isValidHistoryAddress(address) {
  return typeof address === "string" && (EVM_ADDRESS_RE.test(address) || SOLANA_ADDRESS_RE.test(address));
}

function blobPath(address) {
  const secret = process.env.HISTORY_SALT;
  if (!secret) {
    throw new Error("History sync isn't configured yet (missing HISTORY_SALT).");
  }
  // EVM addresses are case-insensitive (checksum casing is a display
  // convention, not identity — same reasoning txHistory.js's own
  // filterTxHistoryForAccount already documents); Solana's base58 is
  // case-sensitive, so only lowercase the EVM shape before salting —
  // otherwise the same address in two different casings would hash to
  // two different, disconnected blobs.
  const normalized = EVM_ADDRESS_RE.test(address) ? address.toLowerCase() : address;
  const digest = crypto.createHmac("sha256", secret).update(normalized).digest("hex");
  return `tx-history/${digest}.json`;
}

async function readEntries(address) {
  try {
    const blobInfo = await head(blobPath(address));
    const res = await fetch(blobInfo.url);
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch {
    return []; // doesn't exist yet — first sync for this address creates it
  }
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
 *
 * Read-then-write, not atomic — same genuinely named tradeoff
 * rateLimit.js's own header already accepts for a similarly
 * best-effort, fire-and-forget write: two concurrent syncs for the
 * SAME address (rare — this app has no feature that broadcasts two
 * transactions from one wallet in the same instant) could race and
 * one write could be silently dropped. The safe failure direction
 * (the device's own local copy, written at the moment it actually
 * happened, is always still there either way), not a real user-facing
 * loss.
 */
export async function appendHistoryEntry(address, entry) {
  validateHistoryEntry(entry);
  const list = await readEntries(address);

  const newHash = entry.hash || entry.hashes?.[0];
  const alreadySynced = list.some((e) => (e.hash || e.hashes?.[0]) === newHash);
  if (alreadySynced) return { synced: false, reason: "already-synced" };

  const next = [entry, ...list].slice(0, MAX_ENTRIES_PER_ADDRESS);
  await put(blobPath(address), JSON.stringify(next), {
    access: "public",
    contentType: "application/json",
    allowOverwrite: true,
  });
  return { synced: true, count: next.length };
}

export async function listHistoryEntries(address) {
  return readEntries(address);
}
