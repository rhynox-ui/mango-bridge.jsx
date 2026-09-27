// src/intearRouter.js
//
// Best price across every NEAR DEX, through Intear's open-source DEX
// aggregator (github.com/INTEARnear/dex-aggregator, the code behind
// router.intear.tech). One /route call quotes Rhea (classic + DCL
// concentrated pools), Intear's own DEX (Plach), Aidols launchpad
// tokens, and the liquid-staking venues (MetaPool stNEAR, LiNEAR, rNEAR,
// xRHEA) in parallel and returns each venue's route, best first, with
// the exact transactions to sign.
//
// Because the transactions come from a third-party API, none of them is
// signed until assertIntearRouteSafe() has checked it against what the
// aggregator's own source code can ever produce:
//   - receivers: only those venues' contracts, wrap.near, or the two
//     tokens being swapped (plus *.aidols.near tokens on Aidols routes);
//   - methods: only the ones those venues use — no ft_transfer to a
//     stranger, no plain Transfer, no key / account / contract actions;
//   - every ft_transfer_call goes to a known venue, and together they
//     never move more of the input token than the user entered;
//   - attached NEAR never exceeds the NEAR being swapped plus a small
//     storage allowance; storage_deposit only ever registers the user.
// A route that fails any of this is skipped, and the NEAR swap panel
// falls back to its own Rhea engine (rheaSwap.js).

import { NATIVE_NEAR, WRAP_NEAR } from "./rheaSwap.js";

export const INTEAR_ROUTE_URL = "https://router.intear.tech/route";

export const DEX_LABEL = {
  Rhea: "Rhea",
  RheaDcl: "Rhea DCL",
  Plach: "Intear DEX",
  Aidols: "Aidols",
  MetaPool: "Meta Pool",
  Linear: "LiNEAR",
  RNear: "rNEAR",
  XRhea: "xRHEA",
  Wrap: "Wrap",
};

// Every contract the aggregator's providers send transactions to or
// transfer tokens into (src/providers/*.rs).
export const VENUE_CONTRACTS = new Set([
  "v2.ref-finance.near",
  "dclv2.ref-labs.near",
  "dex.intear.near",
  "aidols.near",
  "meta-pool.near",
  "linear-protocol.near",
  "xtoken.rhealab.near",
  "lst.rhealab.near",
  WRAP_NEAR,
]);

const ALLOWED_METHODS = new Set([
  "ft_transfer_call",
  "storage_deposit",
  "near_deposit",
  "near_withdraw",
  "deposit_and_stake",
  "deposit_near",
  "execute_operations",
  "liquid_unstake",
  "register_assets",
  "register_tokens",
  "swap",
  "unstake",
  "withdraw",
]);

// Storage registrations across a route (output token, DEX accounts) —
// far above what they really cost, far below anything worth stealing.
export const MAX_STORAGE_NEAR = 500000000000000000000000n; // 0.5 NEAR

export class IntearRouteError extends Error {}

function fail(message) {
  throw new IntearRouteError(message);
}

export function intearTokenParam(tokenId) {
  return tokenId === NATIVE_NEAR ? "near" : `nep141:${tokenId}`;
}

function amountOf(tagged) {
  const v = tagged?.amount_out ?? tagged?.amount_in;
  if (typeof v !== "string" && typeof v !== "number") return null;
  const s = String(v);
  return /^\d+$/.test(s) ? BigInt(s) : null;
}

function decodeArgs(args) {
  if (args && typeof args === "object" && !Array.isArray(args)) return args;
  if (typeof args !== "string") fail("Unreadable call arguments.");
  let text;
  try {
    const bin = atob(args);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    text = new TextDecoder().decode(bytes);
  } catch {
    fail("Unreadable call arguments.");
  }
  if (text === "") return {};
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("Unexpected call arguments.");
    return parsed;
  } catch (e) {
    if (e instanceof IntearRouteError) throw e;
    fail("Non-JSON call arguments.");
  }
}

function toBig(value, what) {
  const s = String(value ?? "0");
  if (!/^\d+$/.test(s)) fail(`Bad ${what}.`);
  return BigInt(s);
}

/** Intear's NearTransaction instructions → near-connect transactions. Throws on anything but FunctionCall. */
export function toWalletTransactions(route) {
  const list = Array.isArray(route?.execution_instructions) ? route.execution_instructions : [];
  if (list.length === 0) fail("The route has no transactions.");
  return list.map((instr) => {
    const tx = instr?.NearTransaction;
    if (!tx || typeof tx.receiver_id !== "string" || !Array.isArray(tx.actions) || tx.actions.length === 0) fail("Unknown instruction in route.");
    return {
      receiverId: tx.receiver_id,
      actions: tx.actions.map((a) => {
        const fc = a?.FunctionCall;
        if (!fc || Object.keys(a).length !== 1) fail("The route contains a non-call action.");
        return {
          type: "FunctionCall",
          params: {
            methodName: String(fc.method_name),
            args: decodeArgs(fc.args),
            gas: toBig(fc.gas, "gas").toString(),
            deposit: toBig(fc.deposit, "deposit").toString(),
          },
        };
      }),
    };
  });
}

function isAidolsToken(id) {
  return typeof id === "string" && id.endsWith(".aidols.near");
}

/**
 * Checks converted transactions against what this swap may do.
 * `tokenIn` / `tokenOut` are UI ids (NATIVE_NEAR or a NEP-141 contract).
 */
export function assertIntearRouteSafe(txs, { accountId, tokenIn, tokenOut, amountIn }) {
  const routingIn = tokenIn === NATIVE_NEAR ? WRAP_NEAR : tokenIn;
  const routingOut = tokenOut === NATIVE_NEAR ? WRAP_NEAR : tokenOut;
  const receivers = new Set([...VENUE_CONTRACTS, routingIn, routingOut]);
  let movedIn = 0n;
  let attachedNear = 0n;

  for (const tx of txs) {
    if (!receivers.has(tx.receiverId) && !isAidolsToken(tx.receiverId)) fail(`The route calls an unexpected contract (${tx.receiverId}).`);
    for (const { type, params } of tx.actions) {
      if (type !== "FunctionCall" || !ALLOWED_METHODS.has(params.methodName)) fail(`The route uses an unexpected method (${params.methodName}).`);
      attachedNear += BigInt(params.deposit);
      const args = params.args || {};
      if (params.methodName === "ft_transfer_call") {
        if (!VENUE_CONTRACTS.has(args.receiver_id)) fail(`The route sends tokens to an unexpected account (${args.receiver_id}).`);
        if (tx.receiverId === routingIn) movedIn += toBig(args.amount, "amount");
      }
      if (params.methodName === "storage_deposit" && args.account_id !== undefined && args.account_id !== accountId) {
        fail("The route registers storage for someone else.");
      }
      if (params.methodName === "near_withdraw" && tokenOut !== NATIVE_NEAR) {
        // unwrapping is only ever part of a swap that ends in NEAR
        fail("The route unwraps NEAR unexpectedly.");
      }
    }
  }
  if (movedIn > amountIn) fail("The route would spend more than you entered.");
  const nearBudget = (tokenIn === NATIVE_NEAR ? amountIn : 0n) + MAX_STORAGE_NEAR;
  if (attachedNear > nearBudget) fail("The route attaches more NEAR than this swap needs.");
}

/**
 * Asks the aggregator for routes. Returns the raw list, best first.
 * `accountId` makes the routes include the user's storage deposits.
 */
export async function fetchIntearRoutes({ tokenIn, tokenOut, amountIn, slippageBps, accountId, fetchImpl = fetch, timeoutMs = 8000 }) {
  const params = new URLSearchParams({
    token_in: intearTokenParam(tokenIn),
    token_out: intearTokenParam(tokenOut),
    amount_in: amountIn.toString(),
    max_wait_ms: "2500",
    slippage_type: "Fixed",
    slippage: (Math.max(0, Math.min(5000, slippageBps)) / 10000).toString(),
  });
  if (accountId) params.set("trader_account_id", accountId);
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetchImpl(`${INTEAR_ROUTE_URL}?${params}`, { signal: controller?.signal });
    if (!res.ok) throw new Error(`NEAR aggregator error (${res.status}).`);
    const body = await res.json();
    return Array.isArray(body) ? body : [];
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The best route that converts, passes every check, and ends in the
 * requested token (or in wNEAR when NEAR was requested, in which case the
 * guaranteed minimum is unwrapped afterwards). Null if none qualifies.
 */
export function pickSafeRoute(routes, { accountId, tokenIn, tokenOut, amountIn }) {
  const wantOut = intearTokenParam(tokenOut);
  for (const route of routes) {
    try {
      const estimated = amountOf(route.estimated_amount);
      const worst = amountOf(route.worst_case_amount);
      if (!estimated || !worst || worst <= 0n || worst > estimated) continue;
      const txs = toWalletTransactions(route);
      const endsIn = route.token_output;
      const unwrapAfter = tokenOut === NATIVE_NEAR && endsIn === `nep141:${WRAP_NEAR}`;
      if (endsIn !== wantOut && !unwrapAfter) continue;
      if (unwrapAfter) {
        txs.push({ receiverId: WRAP_NEAR, actions: [{ type: "FunctionCall", params: { methodName: "near_withdraw", args: { amount: worst.toString() }, gas: "10000000000000", deposit: "1" } }] });
      }
      if (accountId) assertIntearRouteSafe(txs, { accountId, tokenIn, tokenOut, amountIn });
      return { dexId: route.dex_id, label: DEX_LABEL[route.dex_id] ?? route.dex_id, amountOut: estimated, minOut: worst, txs, deadline: route.deadline ?? null };
    } catch {
      // try the next venue
    }
  }
  return null;
}

/** Mango's fee as its own final transaction, so it's only charged once the swap transactions are submitted. */
export function feeTransaction({ tokenIn, fee, feeAccount, feeRegistration }) {
  if (fee <= 0n) return null;
  if (tokenIn === NATIVE_NEAR) return { receiverId: feeAccount, actions: [{ type: "Transfer", params: { deposit: fee.toString() } }] };
  const actions = [];
  if (feeRegistration?.needed) {
    actions.push({ type: "FunctionCall", params: { methodName: "storage_deposit", args: { account_id: feeAccount, registration_only: true }, gas: "10000000000000", deposit: feeRegistration.deposit.toString() } });
  }
  actions.push({ type: "FunctionCall", params: { methodName: "ft_transfer", args: { receiver_id: feeAccount, amount: fee.toString(), memo: "Mango swap fee" }, gas: "10000000000000", deposit: "1" } });
  return { receiverId: tokenIn, actions };
}
