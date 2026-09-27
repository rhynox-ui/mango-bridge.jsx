// src/rheaSwap.js
//
// Swaps on NEAR through Rhea (formerly Ref Finance), the main NEAR DEX,
// for any NEP-141 token with a pool — including meme-cooking launches.
// Pure logic with the RPC view call injected, so the money-moving parts
// are tested offline in scripts/verify-rhea-swap.mjs. Signing happens in
// the user's own NEAR wallet (nearWallet.js); nothing here holds keys.
//
// Contract facts below come from Rhea's own SDK (@ref-finance/ref-sdk
// 1.5.0): exchange `v2.ref-finance.near`, wrapped NEAR `wrap.near`, a
// swap is `ft_transfer_call` to the exchange with msg
// {force:0, actions:[…]} (first hop carries amount_in, intermediate hops
// min_amount_out "0", the last hop the slippage-protected minimum), the
// output token must be storage-registered for the user first, NEAR in is
// wrapped with near_deposit (plus the storage minimum if unregistered),
// NEAR out is unwrapped by the exchange itself (skip_unwrap_near: false,
// ref-exchange v1.9.0+), so the whole output arrives as NEAR — no
// separate unwrap step, no leftover wNEAR, no wNEAR registration.
//
// Quotes: SIMPLE_POOL outputs are computed locally with the exchange's
// exact integer formula; stable/rated pools use the exchange's own
// `get_return` view. Routes are direct or 2-hop through wNEAR, USDC or
// USDT. The exchange enforces min_amount_out on-chain, so a price move
// between quote and execution makes the swap fail and refund — never
// fill worse than the minimum shown.
//
// Mango's fee: 0.5% of the input, sent in the input token to
// NEAR_SWAP_FEE_ACCOUNT in the same transaction as the swap (so it can't
// be charged without the swap being submitted).

export const REF_EXCHANGE = "v2.ref-finance.near";
export const WRAP_NEAR = "wrap.near";
export const NATIVE_NEAR = "near"; // UI id for native NEAR; routes as wrap.near
export const USDC_NEAR = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
export const USDT_NEAR = "usdt.tether-token.near";
export const NEAR_SWAP_FEE_ACCOUNT = "widekingdom6862.near";
export const NEAR_SWAP_FEE_BPS = 50n;
// Kept back from MAX when paying native NEAR: gas for this and future
// transactions plus any storage deposits.
export const NEAR_GAS_RESERVE = 250000000000000000000000n; // 0.25 NEAR
const BLOCKED_TOKENS = new Set(["meta-token.near"]); // from Rhea's SDK
const HUBS = [WRAP_NEAR, USDC_NEAR, USDT_NEAR];
const FEE_DIVISOR = 10000n;
const DEFAULT_STORAGE_MIN = 1250000000000000000000n; // 0.00125 NEAR, the usual NEP-145 minimum
const ONE_YOCTO = "1";
const TGAS = 1000000000000n;

export const NEAR_META = { id: NATIVE_NEAR, symbol: "NEAR", name: "NEAR", decimals: 24, icon: null };

export function routingId(tokenId) {
  return tokenId === NATIVE_NEAR ? WRAP_NEAR : tokenId;
}

// ---------------------------------------------------------------------
// Tokens

const TOKEN_ID = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
export function isTokenId(value) {
  return typeof value === "string" && value.length >= 2 && value.length <= 64 && (TOKEN_ID.test(value) || /^[0-9a-f]{64}$/.test(value));
}

export async function fetchTokenMeta(view, tokenId) {
  if (tokenId === NATIVE_NEAR) return NEAR_META;
  if (!isTokenId(tokenId)) throw new Error("That isn't a NEAR token contract.");
  const m = await view(tokenId, "ft_metadata", {});
  const decimals = Number(m?.decimals);
  if (!m || typeof m.symbol !== "string" || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error("That contract isn't a NEAR token (no valid ft_metadata).");
  }
  return { id: tokenId, symbol: m.symbol, name: m.name || m.symbol, decimals, icon: typeof m.icon === "string" && m.icon.startsWith("data:image") ? m.icon : null };
}

// ---------------------------------------------------------------------
// Pools

export function parsePools(raw, offset) {
  return (Array.isArray(raw) ? raw : [])
    .map((p, i) => ({
      id: offset + i,
      kind: p?.pool_kind,
      tokens: Array.isArray(p?.token_account_ids) ? p.token_account_ids : [],
      amounts: Array.isArray(p?.amounts) ? p.amounts.map((a) => BigInt(a)) : [],
      fee: Number(p?.total_fee ?? 0),
    }))
    .filter((p) => p.tokens.length >= 2 && p.tokens.length === p.amounts.length && p.amounts.every((a) => a > 0n) && !p.tokens.some((t) => BLOCKED_TOKENS.has(t)));
}

const POOL_PAGE = 500;
let poolCache = null;

/** Every Rhea pool with liquidity, cached for a minute. */
export async function fetchAllPools(view, { maxAgeMs = 60_000, now = Date.now } = {}) {
  if (poolCache && now() - poolCache.at < maxAgeMs) return poolCache.pools;
  const count = Number(await view(REF_EXCHANGE, "get_number_of_pools", {}));
  const pages = [];
  for (let from = 0; from < count; from += POOL_PAGE) {
    pages.push(view(REF_EXCHANGE, "get_pools", { from_index: from, limit: POOL_PAGE }).then((raw) => parsePools(raw, from)));
  }
  const pools = (await Promise.all(pages)).flat();
  poolCache = { at: now(), pools };
  return pools;
}

/** Fresh state of specific pools, for re-checking a route right before signing. */
export async function refreshPools(view, poolIds) {
  const fresh = await Promise.all(poolIds.map((id) => view(REF_EXCHANGE, "get_pool", { pool_id: id }).then((raw) => parsePools([raw], id)[0])));
  if (fresh.some((p) => !p)) throw new Error("A pool on this route no longer has liquidity.");
  return fresh;
}

// ---------------------------------------------------------------------
// Quoting

/** The exchange's own SIMPLE_POOL formula (constant product, fee in bps of 10,000). */
export function simplePoolOut(pool, tokenIn, tokenOut, amountIn) {
  const i = pool.tokens.indexOf(tokenIn);
  const o = pool.tokens.indexOf(tokenOut);
  if (i < 0 || o < 0 || i === o || amountIn <= 0n) return 0n;
  const withFee = amountIn * (FEE_DIVISOR - BigInt(pool.fee));
  return (withFee * pool.amounts[o]) / (FEE_DIVISOR * pool.amounts[i] + withFee);
}

function poolsFor(pools, a, b) {
  return pools.filter((p) => p.tokens.includes(a) && p.tokens.includes(b));
}
function byDepth(token) {
  return (x, y) => {
    const dx = x.amounts[x.tokens.indexOf(token)];
    const dy = y.amounts[y.tokens.indexOf(token)];
    return dx === dy ? 0 : dx > dy ? -1 : 1;
  };
}

/** Direct and 2-hop (via wNEAR / USDC / USDT) routes, deepest pools first. */
export function candidateRoutes(pools, tokenIn, tokenOut, { perLeg = 3 } = {}) {
  const routes = [];
  for (const p of poolsFor(pools, tokenIn, tokenOut).sort(byDepth(tokenIn)).slice(0, perLeg)) {
    routes.push([{ pool: p, tokenIn, tokenOut }]);
  }
  for (const hub of HUBS) {
    if (hub === tokenIn || hub === tokenOut) continue;
    const legA = poolsFor(pools, tokenIn, hub).sort(byDepth(tokenIn)).slice(0, perLeg);
    const legB = poolsFor(pools, hub, tokenOut).sort(byDepth(hub)).slice(0, perLeg);
    for (const a of legA) for (const b of legB) routes.push([{ pool: a, tokenIn, tokenOut: hub }, { pool: b, tokenIn: hub, tokenOut }]);
  }
  return routes;
}

async function hopOut(view, hop, amountIn) {
  if (hop.pool.kind === "SIMPLE_POOL") return simplePoolOut(hop.pool, hop.tokenIn, hop.tokenOut, amountIn);
  const r = await view(REF_EXCHANGE, "get_return", { pool_id: hop.pool.id, token_in: hop.tokenIn, amount_in: amountIn.toString(), token_out: hop.tokenOut });
  return BigInt(r);
}

export async function quoteRoute(view, route, amountIn) {
  let amount = amountIn;
  const outs = [];
  for (const hop of route) {
    amount = await hopOut(view, hop, amount);
    if (amount <= 0n) return { route, amountOut: 0n, outs };
    outs.push(amount);
  }
  return { route, amountOut: amount, outs };
}

/** Best of the candidate routes for this amount; null if none. */
export async function bestRoute(view, pools, tokenIn, tokenOut, amountIn) {
  const quotes = await Promise.all(candidateRoutes(pools, tokenIn, tokenOut).map((r) => quoteRoute(view, r, amountIn).catch(() => null)));
  let best = null;
  for (const q of quotes) if (q && q.amountOut > 0n && (!best || q.amountOut > best.amountOut)) best = q;
  return best;
}

/** Price impact in bps for all-SIMPLE_POOL routes (null otherwise): 1 − actual / spot. */
export function priceImpactBps(route, amountIn, amountOut) {
  if (!route.every((h) => h.pool.kind === "SIMPLE_POOL")) return null;
  // spot output = amountIn · Π(outReserve/inReserve) · Π(1 − fee)
  let num = amountIn;
  let den = 1n;
  for (const h of route) {
    const i = h.pool.tokens.indexOf(h.tokenIn);
    const o = h.pool.tokens.indexOf(h.tokenOut);
    num *= h.pool.amounts[o] * (FEE_DIVISOR - BigInt(h.pool.fee));
    den *= h.pool.amounts[i] * FEE_DIVISOR;
  }
  if (num === 0n) return null;
  const impact = FEE_DIVISOR - (amountOut * den * FEE_DIVISOR) / num;
  return Number(impact < 0n ? 0n : impact);
}

export function splitFee(amountIn, feeBps = NEAR_SWAP_FEE_BPS) {
  const fee = (amountIn * feeBps) / FEE_DIVISOR;
  return { fee, swapAmount: amountIn - fee };
}

export function minOutFor(amountOut, slippageBps) {
  const bps = BigInt(Math.max(0, Math.min(5000, Math.round(slippageBps))));
  return (amountOut * (FEE_DIVISOR - bps)) / FEE_DIVISOR;
}

// ---------------------------------------------------------------------
// Storage registration (NEP-145)

/** { needed, deposit } — deposit is the token's own storage minimum. */
export async function registrationNeed(view, tokenId, accountId) {
  const bal = await view(tokenId, "storage_balance_of", { account_id: accountId });
  if (bal) return { needed: false, deposit: 0n };
  let min = DEFAULT_STORAGE_MIN;
  try {
    const bounds = await view(tokenId, "storage_balance_bounds", {});
    if (bounds?.min) min = BigInt(bounds.min);
  } catch {
    // keep the usual minimum
  }
  return { needed: true, deposit: min };
}

// ---------------------------------------------------------------------
// Transactions (near-connect / wallet-selector format)

function call(methodName, args, gasTgas, deposit) {
  return { type: "FunctionCall", params: { methodName, args, gas: (BigInt(gasTgas) * TGAS).toString(), deposit: deposit.toString() } };
}

/**
 * The transactions for one swap, in order:
 *   1. register the user on the output token (only if needed)
 *   2. one transaction on the input token: [wrap NEAR], [register the fee
 *      account], fee transfer, swap — batched so the fee is never taken
 *      without the swap being submitted
 *   3. unwrap the minimum to native NEAR (only when receiving NEAR)
 */
export function buildSwapTransactions({ accountId, payToken, receiveToken, amountIn, route, minOut, userOnOut, userOnWrapIn, feeOnIn, feeAccount = NEAR_SWAP_FEE_ACCOUNT, feeBps = NEAR_SWAP_FEE_BPS }) {
  const tokenIn = routingId(payToken);
  const tokenOut = routingId(receiveToken);
  if (tokenIn === tokenOut) throw new Error("Pick two different tokens.");
  if (!route?.length || route[0].tokenIn !== tokenIn || route[route.length - 1].tokenOut !== tokenOut) throw new Error("The route doesn't match the tokens.");
  for (let i = 1; i < route.length; i++) if (route[i].tokenIn !== route[i - 1].tokenOut) throw new Error("The route is broken.");
  if (amountIn <= 0n || minOut <= 0n) throw new Error("Nothing to swap.");

  const { fee, swapAmount } = splitFee(amountIn, feeBps);
  const actions = route.map((hop, i) => ({
    pool_id: hop.pool.id,
    token_in: hop.tokenIn,
    token_out: hop.tokenOut,
    ...(i === 0 ? { amount_in: swapAmount.toString() } : {}),
    min_amount_out: i === route.length - 1 ? minOut.toString() : "0",
  }));

  const txs = [];
  if (userOnOut?.needed && receiveToken !== NATIVE_NEAR) {
    txs.push({ receiverId: tokenOut, actions: [call("storage_deposit", { account_id: accountId, registration_only: true }, 30, userOnOut.deposit)] });
  }

  const main = [];
  if (payToken === NATIVE_NEAR) {
    main.push(call("near_deposit", {}, 10, amountIn + (userOnWrapIn?.needed ? userOnWrapIn.deposit : 0n)));
  }
  if (fee > 0n) {
    if (feeOnIn?.needed) main.push(call("storage_deposit", { account_id: feeAccount, registration_only: true }, 10, feeOnIn.deposit));
    main.push(call("ft_transfer", { receiver_id: feeAccount, amount: fee.toString(), memo: "Mango swap fee" }, 10, ONE_YOCTO));
  }
  main.push(call("ft_transfer_call", { receiver_id: REF_EXCHANGE, amount: swapAmount.toString(), msg: JSON.stringify({ force: 0, actions, ...(receiveToken === NATIVE_NEAR ? { skip_unwrap_near: false } : {}) }) }, 250, ONE_YOCTO));
  txs.push({ receiverId: tokenIn, actions: main });
  return txs;
}
