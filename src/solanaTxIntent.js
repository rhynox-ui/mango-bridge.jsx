// src/solanaTxIntent.js
//
// The Solana half of the pre-sign intent check — see txIntentFirewall.js
// for the EVM half and the reasoning behind both.
//
// The audit's finding #6: the Solana path simulates before signing,
// which proves the transaction will SUCCEED but says nothing about
// whether it does what the user asked. A transaction that drains the
// wallet simulates perfectly.
//
// WHAT THIS DELIBERATELY DOES NOT DO. It does not try to prove a route
// is correct by decoding every AMM's instruction layout — Solana routes
// go through whichever program the solver picked, and a client-side
// allowlist of program IDs would break on the first new venue Relay
// adds. Attempting that would produce a check that fails honest trades,
// which is worse than no check.
//
// WHAT IT DOES. One thing that cannot legitimately be wrong, as a hard
// block, and an inventory of things worth knowing as warnings:
//
//   BLOCK — the fee payer (the first required signature) must be the
//   user's own account. This is the account that pays and, in every
//   route this app builds, the account that funds the trade. A
//   transaction presented to this wallet whose fee payer is somebody
//   else is not this user's trade.
//
//   WARN — an spl-token Approve, which hands a delegate standing
//   authority over the user's token account (Solana's equivalent of an
//   unlimited ERC-20 approval), and SetAuthority/CloseAccount, which
//   change or dissolve an account the user owns. None of the three
//   belongs in a swap route. They warn rather than block only because
//   this could not be checked against a live Relay Solana quote from
//   the environment it was written in; promoting them is a one-line
//   change once a real route is observed not to use them.
//
// Parsing is deliberately structural — compiled instruction program IDs
// and the first byte of each instruction's data — so it works on both a
// legacy Transaction and a VersionedTransaction without depending on
// any SDK's decoder staying stable.

const SPL_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SPL_TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

// spl-token instruction discriminators (the first byte of the data),
// from the program's own instruction enum ordering.
const SPL_APPROVE = 4;
const SPL_SET_AUTHORITY = 6;
const SPL_CLOSE_ACCOUNT = 9;
const SPL_APPROVE_CHECKED = 13;

export class SolanaIntentError extends Error {
  constructor(message) {
    super(message);
    this.name = "SolanaIntentError";
  }
}

/**
 * Pulls out just the parts this file reasons about, from either
 * transaction shape.
 *
 * Returns null when the transaction isn't a shape we recognise —
 * callers treat that as "cannot check", not as "safe", and say so.
 */
export function describeSolanaTransaction(transaction) {
  if (!transaction || typeof transaction !== "object") return null;

  // VersionedTransaction: a compiled message with a static key table.
  const message = transaction.message;
  if (message && Array.isArray(message.staticAccountKeys) && Array.isArray(message.compiledInstructions)) {
    const keys = message.staticAccountKeys.map((k) => k?.toBase58?.() ?? String(k));
    return {
      feePayer: keys[0] ?? null,
      instructions: message.compiledInstructions.map((ix) => ({
        programId: keys[ix.programIdIndex] ?? null,
        firstDataByte: ix.data?.length ? ix.data[0] : null,
      })),
    };
  }

  // Legacy Transaction: instructions carry their own program ids.
  if (Array.isArray(transaction.instructions)) {
    return {
      feePayer: transaction.feePayer?.toBase58?.() ?? (transaction.feePayer ? String(transaction.feePayer) : null),
      instructions: transaction.instructions.map((ix) => ({
        programId: ix.programId?.toBase58?.() ?? (ix.programId ? String(ix.programId) : null),
        firstDataByte: ix.data?.length ? ix.data[0] : null,
      })),
    };
  }

  return null;
}

/**
 * Blocks on the one condition that cannot legitimately hold; returns
 * warning strings for the rest.
 *
 * expectedSigner is the user's own base58 address. base58 is
 * case-sensitive, so these are compared exactly — never lowercased the
 * way an EVM address safely can be.
 */
export function assertSolanaTransactionMatchesIntent(transaction, { expectedSigner }) {
  const described = describeSolanaTransaction(transaction);
  if (!described) {
    // Not a refusal: an unrecognised shape means this check couldn't
    // run, and blocking a trade on our own inability to parse it would
    // be a self-inflicted outage. Said out loud instead of swallowed.
    return ["This trade's transaction could not be inspected before signing (unrecognised transaction format)."];
  }

  if (expectedSigner && described.feePayer && described.feePayer !== expectedSigner) {
    throw new SolanaIntentError(
      `This transaction would be paid for by ${described.feePayer}, not by your wallet (${expectedSigner}). ` +
        "It was stopped before signing; nothing was sent and nothing was spent.",
    );
  }

  const warnings = [];
  for (const ix of described.instructions) {
    if (ix.programId !== SPL_TOKEN_PROGRAM_ID && ix.programId !== SPL_TOKEN_2022_PROGRAM_ID) continue;
    if (ix.firstDataByte === SPL_APPROVE || ix.firstDataByte === SPL_APPROVE_CHECKED) {
      warnings.push("This route grants a delegate standing authority over one of your token accounts, which a swap does not normally need.");
    } else if (ix.firstDataByte === SPL_SET_AUTHORITY) {
      warnings.push("This route changes the authority on one of your token accounts.");
    } else if (ix.firstDataByte === SPL_CLOSE_ACCOUNT) {
      warnings.push("This route closes one of your token accounts.");
    }
  }
  return warnings;
}
