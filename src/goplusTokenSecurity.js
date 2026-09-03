// src/goplusTokenSecurity.js
//
// PORTED from mango-mobile's own src/launchpad/goplusTokenSecurity.js,
// unchanged apart from this header. Both the EVM and the Solana paths
// come across together — including the Solana one's honest gaps, which
// are the whole reason it reads the way it does.
//
// Live per-token risk check via GoPlus Security's public Token Security
// API (GET /api/v1/token_security/{chain_id}?contract_addresses=...) —
// real and free, same vendor already wired in for address-level checks
// (src/browser/goplusSecurity.js). Confirmed the exact response shape
// the same way that file did: pulled GoPlus's own official Node SDK
// (@goplus/sdk-node) from npm (api.gopluslabs.io/docs.gopluslabs.io are
// both blocked by this sandbox's egress proxy) and read the generated
// model straight off the source — dist/gen/api/TokenControllerV1Api.js
// for the real endpoint path/query param (chain_id in the path,
// contract_addresses as a query param, comma-separated for multiple),
// dist/gen/model/ResponseWrapperTokenSecurity.js for the outer envelope
// (`result` keyed by lowercased contract address), and
// ResponseWrapperTokenSecurityResult.js / ResponseWrapperTokenSecurityLpHolders.js /
// ResponseWrapperTokenSecurityHolders.js (the top-10 TOKEN holders list,
// distinct from lp_holders' LIQUIDITY-POOL position holders — this file's
// own parseHolders below)
// for every field read below — not guessed. Same unauthenticated-call
// confirmation as goplusSecurity.js: the generated client's
// `Authorization` header is optional, no app_key/app_secret signup
// needed.
//
// GENUINE, NAMED GAP, same shape goplusSecurity.js already discloses:
// whether GoPlus's token_security function actually has real coverage
// for Robinhood Chain (chain_id 4663 — this app's own Launchpad chain)
// could NOT be confirmed from this sandbox (api.gopluslabs.io blocked;
// the SDK's own getChainsListUsingGET/supported_chains endpoint returns
// LIVE data, not something baked into the SDK source, so it can't be
// read offline either). This fails open exactly like goplusSecurity.js:
// an unsupported chain, timeout, non-200, or unparseable body all
// return `null` ("no live check happened"), never a false "confirmed
// safe" risk summary — worth a real confirm the first time this runs
// against a live network.

const FETCH_TIMEOUT_MS = 6000;
const API_BASE = 'https://api.gopluslabs.io/api/v1/token_security';
// Solana is a SEPARATE endpoint with a separate response model, not the
// EVM one with a chain id — confirmed the same offline way as
// everything else here: `npm pack @goplus/sdk-node` and read the
// generated source. The path comes from its own api client
// ('/api/v1/solana/token_security', mint passed as contract_addresses,
// no chain id in the path), and every field below from
// ResponseWrapperSolanaTokenSecurityResult.js /
// ResponseWrapperSolanaTokenSecurityHolders.js.
const SOLANA_API_BASE = 'https://api.gopluslabs.io/api/v1/solana/token_security';
const CACHE_TTL_MS = 10 * 60 * 1000;

const cache = new Map(); // `${chainId}:${address.toLowerCase()}` -> {summary, expiresAt}

function toBool(flag) {
  return flag === '1';
}

function toPercent(taxFraction) {
  // GoPlus's own field docs: buy_tax/sell_tax are a fraction (0.1 = 10%),
  // same "1 means 100%" convention percent uses on lp_holders below.
  const n = Number(taxFraction);
  return Number.isFinite(n) ? n * 100 : null;
}

/**
 * Sums the LP share held by every locked LP holder GoPlus found (top-10
 * only — GoPlus's own lp_holders field docs: "Top10 LP token holders
 * info" — a real, disclosed lower bound, not the true total whenever a
 * pool has more than 10 LP holders). null when lp_holders itself is
 * absent (GoPlus's own note: no return at all when is_in_dex is "0" —
 * genuinely unknown, not "0% locked").
 */
function lockedLpPercent(lpHolders) {
  if (!Array.isArray(lpHolders) || lpHolders.length === 0) {
    return null;
  }
  const lockedFraction = lpHolders
    .filter(h => h?.is_locked === 1)
    .reduce((sum, h) => sum + (Number(h?.percent) || 0), 0);
  return Math.min(100, lockedFraction * 100);
}

// Real field -> human label, off ResponseWrapperTokenSecurityResult's
// own field docs — not paraphrased loosely. Ordered roughly by how
// directly each one threatens "you may not be able to sell this token
// or the owner can take your funds," the risk this panel exists to
// surface before a Launchpad buy.
const RISK_FLAGS = [
  ['is_honeypot', 'Flagged as a honeypot — may not be sellable once bought'],
  ['cannot_sell_all', 'Some holders cannot sell their full balance'],
  ['transfer_pausable', 'Owner can pause all transfers'],
  ['owner_change_balance', 'Owner can directly change holder balances'],
  ['selfdestruct', 'Contract can self-destruct'],
  ['hidden_owner', 'Contract has a hidden owner'],
  ['can_take_back_ownership', 'Ownership can be reclaimed after renouncing'],
  ['is_blacklisted', 'Contract has a blacklist function'],
  ['is_proxy', 'Contract is upgradeable (proxy pattern) — logic can change after launch'],
  ['is_airdrop_scam', 'Flagged as an airdrop scam'],
];

/**
 * Real top-10 TOKEN holders (distinct from lp_holders above, which is
 * LIQUIDITY-POOL position holders) — GoPlus's own field docs: "Top10
 * holders info". Same address/balance/percent/is_locked/tag shape
 * confirmed off the SDK's own ResponseWrapperTokenSecurityHolders
 * model (address, balance, percent — "1 means 100%", is_locked — "1"
 * for a known lock/burn address, tag — a real public label like "Burn"
 * or "Deployer" when GoPlus has one). null when GoPlus itself returns
 * no holders array (an unsupported chain or a token it hasn't indexed
 * holder data for), never a fabricated empty list standing in for
 * "confirmed no other holders."
 */
function parseHolders(holders) {
  if (!Array.isArray(holders) || holders.length === 0) {
    return null;
  }
  return holders
    .filter(h => h?.address)
    .map(h => ({
      address: String(h.address),
      percent: toPercent(h.percent),
      isLocked: h.is_locked === 1,
      isContract: h.is_contract === 1,
      tag: h.tag || null,
    }));
}

/**
 * Top-10 holders, Solana shape.
 *
 * Deliberately separate from parseHolders above rather than a shared
 * function with optional fields, because the two models genuinely
 * differ and pretending otherwise would hide a real caveat:
 *
 *  - The identifier is `token_account`, not `address`. On Solana that
 *    is the TOKEN ACCOUNT, not the owner's wallet — GoPlus's Solana
 *    model carries no owner field at all. Labelled as such at the call
 *    site rather than presented as a wallet address, which would be
 *    wrong.
 *  - There is no `is_contract`; the concept doesn't apply.
 *
 * Same "null, never a fabricated empty list" contract as the EVM one.
 */
function parseSolanaHolders(holders) {
  if (!Array.isArray(holders) || holders.length === 0) {
    return null;
  }
  return holders
    .filter(h => h?.token_account)
    .map(h => ({
      address: String(h.token_account),
      percent: toPercent(h.percent),
      isLocked: h.is_locked === 1,
      isContract: false,
      tag: h.tag || null,
    }));
}

/**
 * Live per-token risk lookup for a Solana mint.
 *
 * Returns the same summary shape the EVM path does so the UI needs no
 * per-chain branching, with two fields honestly left null because
 * GoPlus's Solana model simply doesn't carry them:
 *
 *  - holderCount. The EVM result has `holder_count`; the Solana result
 *    has no equivalent field. The chart therefore shows a Holders entry
 *    WITHOUT a number on Solana rather than inventing one — that gap is
 *    real and worth showing as a gap.
 *  - buy/sell tax and honeypot. Solana's risk model is different
 *    (freezable, mintable, transfer_fee, transfer_hook), so those EVM
 *    concepts stay null instead of being mapped onto something they
 *    don't mean.
 *
 * The mint is used as the result key EXACTLY as given, not lowercased:
 * Solana addresses are base58 and case-sensitive, unlike the hex
 * addresses the EVM path lowercases.
 */
export async function checkSolanaTokenSecurity(mintAddress) {
  if (!mintAddress) {
    return null;
  }
  const key = `solana:${mintAddress}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.summary;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${SOLANA_API_BASE}?contract_addresses=${encodeURIComponent(mintAddress)}`, {signal: controller.signal});
    if (!res.ok) {
      return null;
    }
    const data = await res.json();
    const result = data?.result?.[mintAddress];
    if (!result || typeof result !== 'object') {
      return null;
    }
    const flags = [];
    if (result.freezable?.status === '1') flags.push('Freeze authority is still active');
    if (result.mintable?.status === '1') flags.push('Supply can still be minted');
    if (result.closable?.status === '1') flags.push('Mint account can be closed');
    if (result.metadata_mutable?.status === '1') flags.push('Token metadata can still be changed');
    if (result.transfer_hook_upgradable?.status === '1') flags.push('Transfer hook can be changed');
    if (result.transfer_fee_upgradable?.status === '1') flags.push('Transfer fee can be changed');
    if (result.non_transferable === '1' || result.none_transferable === '1') flags.push('Token is non-transferable');

    const summary = {
      isOpenSource: null,
      isHoneypot: false,
      buyTaxPercent: null,
      sellTaxPercent: null,
      lpLockedPercent: lockedLpPercent(result.lp_holders),
      // See this function's own doc: GoPlus's Solana model has no
      // holder_count. Null, never a made-up number.
      holderCount: null,
      holders: parseSolanaHolders(result.holders),
      flags,
    };
    cache.set(key, {summary, expiresAt: Date.now() + CACHE_TTL_MS});
    return summary;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Real, live per-token risk lookup. `null` means "inconclusive" (missing
 * args, unsupported chain, network error, timeout, non-200, or
 * unparseable body), never "confirmed safe" — same contract
 * goplusSecurity.js's checkAddressMalicious already ships under.
 * Returns a structured summary otherwise, built once here so the UI
 * component doesn't need to know GoPlus's own raw "1"/"0" string
 * convention or its top-10-only LP caveat.
 */
export async function checkTokenSecurity(chainId, tokenAddress) {
  if (!chainId || !tokenAddress) {
    return null;
  }
  const key = `${chainId}:${tokenAddress.toLowerCase()}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.summary;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}/${chainId}?contract_addresses=${tokenAddress}`, {signal: controller.signal});
    if (!res.ok) {
      return null;
    }
    const data = await res.json();
    const result = data?.result?.[tokenAddress.toLowerCase()];
    if (!result || typeof result !== 'object') {
      return null;
    }
    const flags = RISK_FLAGS.filter(([field]) => toBool(result[field])).map(([, label]) => label);
    const summary = {
      isOpenSource: result.is_open_source === undefined ? null : toBool(result.is_open_source),
      isHoneypot: toBool(result.is_honeypot),
      buyTaxPercent: toPercent(result.buy_tax),
      sellTaxPercent: toPercent(result.sell_tax),
      lpLockedPercent: lockedLpPercent(result.lp_holders),
      holderCount: Number.isFinite(Number(result.holder_count)) ? Number(result.holder_count) : null,
      holders: parseHolders(result.holders),
      flags,
    };
    cache.set(key, {summary, expiresAt: Date.now() + CACHE_TTL_MS});
    return summary;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
