// src/nearOutcome.js
//
// What a batch of NEAR swap transactions actually did, read from the
// FinalExecutionOutcome list the wallet returns. On NEAR a swap that
// misses its minimum doesn't fail the transaction: the exchange rejects
// the tokens inside ft_transfer_call and the token contract returns them
// (NEP-141 ft_resolve_transfer). The transaction still "succeeds", and
// its return value is the amount the exchange actually kept — 0 when the
// whole swap was cancelled. Reading that value is the only way to tell
// the user the truth instead of "Swapped" for a refunded swap.

function decodeUsedAmount(successValue) {
  if (typeof successValue !== "string") return null;
  try {
    const text = new TextDecoder().decode(Uint8Array.from(atob(successValue), (c) => c.charCodeAt(0)));
    const v = JSON.parse(text);
    return typeof v === "string" && /^\d+$/.test(v) ? BigInt(v) : null;
  } catch {
    return null;
  }
}

/**
 * { status: "ok" | "partial" | "refunded" | "failed" | "unknown", hashes }
 * `txs` are the transactions that were signed, in order; `skip` holds
 * indexes to leave out of the verdict (Mango's fee transaction).
 */
export function classifySwapOutcomes(txs, outcomes, { skip = [] } = {}) {
  const list = Array.isArray(outcomes) ? outcomes : outcomes ? [outcomes] : [];
  const hashes = list.map((o) => o?.transaction?.hash || o?.transaction_outcome?.id).filter(Boolean);
  if (list.length < txs.length) return { status: "unknown", hashes };
  let refunded = false;
  let partial = false;
  for (let i = 0; i < txs.length; i++) {
    if (skip.includes(i)) continue;
    const st = list[i]?.status;
    if (!st || typeof st !== "object") return { status: "unknown", hashes };
    if ("Failure" in st) return { status: "failed", hashes };
    const actions = txs[i].actions;
    const last = actions[actions.length - 1];
    if (last?.params?.methodName !== "ft_transfer_call") continue;
    const used = decodeUsedAmount(st.SuccessValue);
    if (used === null) return { status: "unknown", hashes };
    const sent = BigInt(last.params.args.amount);
    if (used === 0n) refunded = true;
    else if (used < sent) partial = true;
  }
  return { status: refunded ? "refunded" : partial ? "partial" : "ok", hashes };
}
