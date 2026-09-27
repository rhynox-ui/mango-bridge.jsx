// src/nearRpc.js
//
// Read-only NEAR RPC helpers (view calls, account balances) for the NEAR
// Bridge and Swap panels. Tries each public endpoint in turn; the first
// one that answers wins. No keys, no signing — signing always goes
// through the user's own NEAR wallet (nearWallet.js).

export const NEAR_RPCS = ["https://rpc.mainnet.fastnear.com", "https://near.lava.build", "https://rpc.mainnet.near.org"];

/** One JSON-RPC call, falling through the endpoints. Throws the last error if all fail. */
export async function nearRpc(method, params, rpcs = NEAR_RPCS) {
  let lastError = new Error("Couldn't reach NEAR.");
  for (const url of rpcs) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "mango", method, params }),
      });
      const body = await res.json();
      if (body?.error) {
        // A real contract/account error is the same on every node —
        // don't mask it by retrying elsewhere.
        const err = new Error(body.error?.cause?.name || body.error?.data || body.error?.message || "NEAR RPC error");
        err.nearError = body.error;
        throw err;
      }
      return body.result;
    } catch (err) {
      if (err?.nearError) throw err;
      lastError = err;
    }
  }
  throw lastError;
}

function encodeArgs(args) {
  const json = JSON.stringify(args ?? {});
  const bytes = new TextEncoder().encode(json);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Calls a view method and JSON-decodes its result. */
export async function nearView(contractId, methodName, args = {}, rpcs = NEAR_RPCS) {
  const result = await nearRpc(
    "query",
    { request_type: "call_function", finality: "final", account_id: contractId, method_name: methodName, args_base64: encodeArgs(args) },
    rpcs,
  );
  if (result?.error) throw new Error(result.error);
  const text = new TextDecoder().decode(Uint8Array.from(result.result));
  return text ? JSON.parse(text) : null;
}

/** Native NEAR balance in yocto (string), minus what storage staking locks. */
export async function nearAvailableBalance(accountId, rpcs = NEAR_RPCS) {
  const acct = await nearRpc("query", { request_type: "view_account", finality: "final", account_id: accountId }, rpcs);
  // 1e19 yocto per byte of storage (NEAR's storage staking price).
  const locked = BigInt(acct.storage_usage ?? 0) * 10n ** 19n;
  const amount = BigInt(acct.amount ?? "0");
  return (amount > locked ? amount - locked : 0n).toString();
}
