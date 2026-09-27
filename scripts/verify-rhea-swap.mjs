// scripts/verify-rhea-swap.mjs
//
// Tests for src/rheaSwap.js — NEAR swaps through Rhea (Ref Finance). Runs
// against a simulated exchange (pools + view calls), since the point is
// the money rules: the exact pool math, route choice, the fee, the
// slippage minimum, storage registration and the exact transactions the
// user's NEAR wallet is asked to sign.
//
// Run: node scripts/verify-rhea-swap.mjs

import {
  NATIVE_NEAR,
  NEAR_SWAP_FEE_ACCOUNT,
  REF_EXCHANGE,
  USDC_NEAR,
  WRAP_NEAR,
  bestRoute,
  buildSwapTransactions,
  candidateRoutes,
  fetchAllPools,
  fetchTokenMeta,
  isTokenId,
  minOutFor,
  parsePools,
  priceImpactBps,
  registrationNeed,
  simplePoolOut,
  splitFee,
} from "../src/rheaSwap.js";

let passed = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    passed++;
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
  }
}
function assert(c, m) {
  if (!c) throw new Error(m ?? "assertion failed");
}
async function throws(fn, m) {
  try {
    await fn();
  } catch {
    return;
  }
  throw new Error(m ?? "expected an error");
}

const MEME = "rust-334.meme-cooking.near";
const E24 = 10n ** 24n;
const E6 = 10n ** 6n;
const E18 = 10n ** 18n;

// A small simulated exchange: MEME only trades against wNEAR (as
// meme-cooking launches do); wNEAR/USDC has a deep pool and a shallow
// one; a stable pool that must be quoted through get_return.
const RAW_POOLS = [
  { pool_kind: "SIMPLE_POOL", token_account_ids: [WRAP_NEAR, USDC_NEAR], amounts: [(1_000_000n * E24).toString(), (3_000_000n * E6).toString()], total_fee: 30 },
  { pool_kind: "SIMPLE_POOL", token_account_ids: [WRAP_NEAR, USDC_NEAR], amounts: [(1_000n * E24).toString(), (3_000n * E6).toString()], total_fee: 30 },
  { pool_kind: "SIMPLE_POOL", token_account_ids: [MEME, WRAP_NEAR], amounts: [(50_000_000n * E18).toString(), (20_000n * E24).toString()], total_fee: 100 },
  { pool_kind: "SIMPLE_POOL", token_account_ids: ["meta-token.near", WRAP_NEAR], amounts: ["1000", "1000"], total_fee: 30 },
  { pool_kind: "SIMPLE_POOL", token_account_ids: ["empty.near", WRAP_NEAR], amounts: ["0", "1000"], total_fee: 30 },
  { pool_kind: "STABLE_SWAP", token_account_ids: [USDC_NEAR, "usdt.tether-token.near"], amounts: [(1_000_000n * E6).toString(), (1_000_000n * E6).toString()], total_fee: 5 },
];

const viewCalls = [];
async function view(contract, method, args) {
  viewCalls.push([contract, method, args]);
  if (contract === REF_EXCHANGE && method === "get_number_of_pools") return RAW_POOLS.length;
  if (contract === REF_EXCHANGE && method === "get_pools") return RAW_POOLS.slice(args.from_index, args.from_index + args.limit);
  if (contract === REF_EXCHANGE && method === "get_return") return ((BigInt(args.amount_in) * 9995n) / 10000n).toString();
  if (method === "ft_metadata") return contract === MEME ? { symbol: "RUST", name: "Rust", decimals: 18, icon: "data:image/svg+xml;base64,AA" } : null;
  if (method === "storage_balance_of") return args.account_id === "registered.near" ? { total: "1", available: "0" } : null;
  if (method === "storage_balance_bounds") return { min: "2350000000000000000000", max: null };
  throw new Error(`unexpected view ${contract}.${method}`);
}

await check("the exchange's SIMPLE_POOL formula, exactly", () => {
  const [pool] = parsePools([RAW_POOLS[0]], 0);
  const out = simplePoolOut(pool, WRAP_NEAR, USDC_NEAR, 10n * E24);
  // amount_with_fee·out / (10000·in + amount_with_fee), fee 30 bps
  const withFee = 10n * E24 * 9970n;
  assert(out === (withFee * 3_000_000n * E6) / (10000n * 1_000_000n * E24 + withFee), String(out));
  assert(simplePoolOut(pool, WRAP_NEAR, WRAP_NEAR, 1n) === 0n && simplePoolOut(pool, MEME, USDC_NEAR, 1n) === 0n);
});

await check("pools: blacklisted, empty and malformed pools are dropped; ids are real indexes", async () => {
  const pools = await fetchAllPools(view, { maxAgeMs: 0 });
  assert(pools.length === 4, `got ${pools.length}`);
  assert(pools.map((p) => p.id).join(",") === "0,1,2,5", pools.map((p) => p.id).join(","));
});

await check("routes: direct first, 2-hop through wNEAR for a meme token, deepest pool preferred", async () => {
  const pools = await fetchAllPools(view, { maxAgeMs: 0 });
  const routes = candidateRoutes(pools, MEME, USDC_NEAR);
  assert(routes.length > 0 && routes.every((r) => r.length === 2 && r[0].tokenOut === WRAP_NEAR), JSON.stringify(routes.map((r) => r.map((h) => h.pool.id))));
  const best = await bestRoute(view, pools, MEME, USDC_NEAR, 1_000_000n * E18);
  assert(best.route[0].pool.id === 2 && best.route[1].pool.id === 0, `picked ${best.route.map((h) => h.pool.id)}`);
});

await check("stable pools are quoted through the exchange's own get_return", async () => {
  const pools = await fetchAllPools(view, { maxAgeMs: 0 });
  viewCalls.length = 0;
  const q = await bestRoute(view, pools, USDC_NEAR, "usdt.tether-token.near", 1000n * E6);
  assert(q.route[0].pool.id === 5, `pool ${q.route[0].pool.id}`);
  assert(viewCalls.some(([, m, a]) => m === "get_return" && a.pool_id === 5), "get_return not used");
});

await check("no route → null, never a guess", async () => {
  const pools = await fetchAllPools(view, { maxAgeMs: 0 });
  assert((await bestRoute(view, pools, "nothing.near", USDC_NEAR, 1n)) === null);
});

await check("price impact is ~fees for a small trade and large for a big one", async () => {
  const pools = await fetchAllPools(view, { maxAgeMs: 0 });
  const small = await bestRoute(view, pools, WRAP_NEAR, USDC_NEAR, 1n * E24);
  const big = await bestRoute(view, pools, WRAP_NEAR, USDC_NEAR, 200_000n * E24);
  const si = priceImpactBps(small.route, 1n * E24, small.amountOut);
  const bi = priceImpactBps(big.route, 200_000n * E24, big.amountOut);
  assert(si !== null && si < 5, `small impact ${si}`);
  assert(bi > 1000, `big impact ${bi}`);
});

await check("fee is 0.5% of the input; minimum applies the user's slippage", () => {
  const { fee, swapAmount } = splitFee(1000n * E6);
  assert(fee === 5n * E6 && swapAmount === 995n * E6, `${fee} ${swapAmount}`);
  assert(minOutFor(10_000n, 100) === 9_900n && minOutFor(10_000n, 0) === 10_000n && minOutFor(10_000n, 99999) === 5_000n);
});

await check("storage: registered accounts need nothing; others pay the token's own minimum", async () => {
  const a = await registrationNeed(view, USDC_NEAR, "registered.near");
  const b = await registrationNeed(view, USDC_NEAR, "new.near");
  assert(!a.needed && a.deposit === 0n);
  assert(b.needed && b.deposit === 2350000000000000000000n, String(b.deposit));
});

await check("token metadata: real tokens resolve; non-tokens and bad ids are refused", async () => {
  const meta = await fetchTokenMeta(view, MEME);
  assert(meta.symbol === "RUST" && meta.decimals === 18);
  await throws(() => fetchTokenMeta(view, "notatoken.near"));
  assert(!isTokenId("Bad.Near") && !isTokenId("a") && isTokenId(MEME) && isTokenId("usdt.tether-token.near"));
});

const pools = await fetchAllPools(view, { maxAgeMs: 0 });
const memeRoute = (await bestRoute(view, pools, MEME, USDC_NEAR, 995_000n * E18)).route;
const nearRoute = (await bestRoute(view, pools, WRAP_NEAR, MEME, 99_500_000_000_000_000_000_000_000n)).route;

await check("FT → FT: register output, then fee + swap batched in ONE transaction on the input token", () => {
  const txs = buildSwapTransactions({
    accountId: "alice.near", payToken: MEME, receiveToken: USDC_NEAR, amountIn: 1_000_000n * E18, route: memeRoute, minOut: 123n,
    userOnOut: { needed: true, deposit: 1250000000000000000000n }, feeOnIn: { needed: true, deposit: 1250000000000000000000n },
  });
  assert(txs.length === 2 && txs[0].receiverId === USDC_NEAR && txs[1].receiverId === MEME, txs.map((t) => t.receiverId).join());
  assert(txs[0].actions[0].params.methodName === "storage_deposit" && txs[0].actions[0].params.args.account_id === "alice.near");
  const [reg, fee, swap] = txs[1].actions.map((a) => a.params);
  assert(reg.methodName === "storage_deposit" && reg.args.account_id === NEAR_SWAP_FEE_ACCOUNT);
  assert(fee.methodName === "ft_transfer" && fee.args.receiver_id === NEAR_SWAP_FEE_ACCOUNT && fee.args.amount === (5_000n * E18).toString() && fee.deposit === "1");
  assert(swap.methodName === "ft_transfer_call" && swap.args.receiver_id === REF_EXCHANGE && swap.args.amount === (995_000n * E18).toString() && swap.deposit === "1");
  const msg = JSON.parse(swap.args.msg);
  assert(msg.force === 0 && msg.actions.length === 2, swap.args.msg);
  assert(msg.actions[0].amount_in === swap.args.amount && msg.actions[0].min_amount_out === "0", "first hop");
  assert(!("amount_in" in msg.actions[1]) && msg.actions[1].min_amount_out === "123", "last hop");
  const gas = txs[1].actions.reduce((s, a) => s + BigInt(a.params.gas), 0n);
  assert(gas <= 300n * 10n ** 12n, `batch gas ${gas}`);
});

await check("NEAR → token: wrap (plus storage if new) in the same transaction, no output unwrap", () => {
  const amountIn = 100n * E24;
  const txs = buildSwapTransactions({
    accountId: "alice.near", payToken: NATIVE_NEAR, receiveToken: MEME, amountIn, route: nearRoute, minOut: 1n,
    userOnOut: { needed: false }, userOnWrapIn: { needed: true, deposit: 1250000000000000000000n }, feeOnIn: { needed: false },
  });
  assert(txs.length === 1 && txs[0].receiverId === WRAP_NEAR, txs.map((t) => t.receiverId).join());
  const [wrap, fee, swap] = txs[0].actions.map((a) => a.params);
  assert(wrap.methodName === "near_deposit" && BigInt(wrap.deposit) === amountIn + 1250000000000000000000n, wrap.deposit);
  assert(fee.methodName === "ft_transfer" && BigInt(fee.args.amount) === amountIn / 200n);
  assert(swap.methodName === "ft_transfer_call" && BigInt(swap.args.amount) === amountIn - amountIn / 200n);
});

await check("token → NEAR: the exchange unwraps the whole output (no leftover wNEAR, no wNEAR registration)", () => {
  const route = [{ pool: pools.find((p) => p.id === 2), tokenIn: MEME, tokenOut: WRAP_NEAR }];
  const txs = buildSwapTransactions({ accountId: "alice.near", payToken: MEME, receiveToken: NATIVE_NEAR, amountIn: 1000n * E18, route, minOut: 777n, userOnOut: { needed: true, deposit: 1n }, feeOnIn: { needed: false } });
  assert(txs.length === 1 && txs[0].receiverId === MEME, "expected one transaction on the input token");
  const swap = txs[0].actions[txs[0].actions.length - 1].params;
  const msg = JSON.parse(swap.args.msg);
  assert(msg.skip_unwrap_near === false && msg.actions[0].min_amount_out === "777", swap.args.msg);
  assert(!txs.flatMap((t) => t.actions).some((a) => a.params.methodName === "near_withdraw"));
});

await check("only the tokens, the exchange and wrap.near are ever transaction receivers", () => {
  const allowed = new Set([MEME, USDC_NEAR, WRAP_NEAR]);
  const txs = buildSwapTransactions({ accountId: "alice.near", payToken: MEME, receiveToken: USDC_NEAR, amountIn: 10n * E18, route: memeRoute, minOut: 1n, userOnOut: { needed: true, deposit: 1n }, feeOnIn: { needed: true, deposit: 1n } });
  assert(txs.every((t) => allowed.has(t.receiverId)), txs.map((t) => t.receiverId).join());
});

await check("mismatched or broken routes, same-token swaps and zero amounts are refused", async () => {
  const base = { accountId: "a.near", payToken: MEME, receiveToken: USDC_NEAR, amountIn: 10n, route: memeRoute, minOut: 1n };
  await throws(() => buildSwapTransactions({ ...base, receiveToken: "usdt.tether-token.near" }));
  await throws(() => buildSwapTransactions({ ...base, payToken: NATIVE_NEAR, receiveToken: WRAP_NEAR }));
  await throws(() => buildSwapTransactions({ ...base, route: [memeRoute[1], memeRoute[0]] }));
  await throws(() => buildSwapTransactions({ ...base, minOut: 0n }));
  await throws(() => buildSwapTransactions({ ...base, amountIn: 0n }));
});

console.log(`${passed}/${passed + failures.length} checks passed`);
for (const f of failures) console.error(`  FAIL ${f}`);
if (failures.length > 0) process.exit(1);
