// src/wallet/balanceCache.js
//
// Last-known-balance cache — the web/extension counterpart of
// mango-mobile's src/wallet/balanceCache.js, ported so both products
// behave the same way on a cold open.
//
// WHY THIS MATTERS MOST IN THE EXTENSION. A browser-action popup is
// destroyed and rebuilt every single time the icon is clicked. Without a
// cache, every open showed "…" in every balance row and every USD
// subtitle while a dozen independent RPC round-trips ran — so the wallet
// looked empty for the first second, every time. The site tab gets the
// same benefit on reload, but the popup is where it is the difference
// between "my wallet" and "a loading screen".
//
// The contract is deliberately narrow: a row reads this synchronously on
// mount and shows it immediately INSTEAD of a placeholder, while the
// real fetch still always runs and always wins once it resolves. This
// never changes what balance is ultimately shown — only what is shown
// while the real fetch is in flight.
//
// Same architecture Rainbow Wallet uses (balances read from local
// storage before any network call starts), and the same one mobile
// already ships. One difference from mobile, in our favour:
// localStorage is synchronous, so there is no async hydration race to
// guard against — the cache is populated before the first row renders.

const STORAGE_KEY = "mango_balance_cache_v1";
// Enough for every chain x asset a real wallet shows, bounded so a user
// who has added many custom tokens over time cannot grow this without
// limit. Oldest-written entries are dropped first.
const MAX_ENTRIES = 400;

const memoryCache = new Map();

function readStorage() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return;
    for (const [key, entry] of Object.entries(parsed)) {
      // Only accept the shape this module writes. A hand-edited or
      // corrupted entry is skipped rather than trusted into the UI.
      if (entry && typeof entry === "object" && typeof entry.value === "number" && Number.isFinite(entry.value)) {
        memoryCache.set(key, entry);
      }
    }
  } catch {
    // Private mode, storage disabled, quota, or malformed JSON. A
    // missing cache is not an error — every row still fetches.
  }
}

// Synchronous, at module load: by the time the first balance row
// renders, the cache is already warm.
if (typeof window !== "undefined" && window.localStorage) {
  readStorage();
}

let writeScheduled = false;
function scheduleWrite() {
  if (writeScheduled || typeof window === "undefined" || !window.localStorage) return;
  writeScheduled = true;
  // Coalesced: a dozen rows resolving within the same tick produce one
  // serialize + write, not a dozen. setTimeout rather than
  // requestIdleCallback because a popup can be closed at any moment and
  // idle time may never arrive.
  setTimeout(() => {
    writeScheduled = false;
    try {
      if (memoryCache.size > MAX_ENTRIES) {
        // Map preserves insertion order, so the oldest writes are first.
        const excess = memoryCache.size - MAX_ENTRIES;
        let dropped = 0;
        for (const key of memoryCache.keys()) {
          if (dropped++ >= excess) break;
          memoryCache.delete(key);
        }
      }
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(memoryCache)));
    } catch {
      // Quota or disabled storage — the in-memory cache still works for
      // this session, which is the majority of the benefit.
    }
  }, 0);
}

/** Stable key for one asset on one chain, for one address. */
export function balanceCacheKey(addressOrChain, assetKey, address) {
  return address === undefined ? `${addressOrChain}::${assetKey}` : `${addressOrChain}::${assetKey}::${address}`;
}

/**
 * The last known balance, or null when nothing has been cached.
 *
 * Returns a number, never a stale "loading" sentinel — a caller can
 * treat a non-null result as safe to display immediately.
 */
export function getCachedBalance(key) {
  const entry = memoryCache.get(key);
  return entry && typeof entry.value === "number" ? entry.value : null;
}

/** Records a freshly fetched balance. Ignores non-finite values rather than caching a NaN into the UI. */
export function setCachedBalance(key, value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return;
  // Re-insert so the key moves to the end of the Map's insertion order,
  // which is what makes the eviction above least-recently-written.
  memoryCache.delete(key);
  memoryCache.set(key, { value, at: Date.now() });
  scheduleWrite();
}

/** Test seam: drops everything, in memory and on disk. */
export function clearBalanceCache() {
  memoryCache.clear();
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
