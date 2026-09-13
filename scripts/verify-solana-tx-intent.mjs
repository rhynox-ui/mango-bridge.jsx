// scripts/verify-solana-tx-intent.mjs
//
// Offline test vectors for src/solanaTxIntent.js — the pre-sign check
// on the Solana path (security audit finding #6).
//
// Uses hand-built objects in both transaction shapes rather than the
// real SDK's builders, so this runs with no network, no wallet and no
// RPC: the module is deliberately structural (program ids and the first
// data byte) precisely so it can be tested this way.
//
// Run: node scripts/verify-solana-tx-intent.mjs

import {
  SolanaIntentError,
  describeSolanaTransaction,
  assertSolanaTransactionMatchesIntent,
} from "../src/solanaTxIntent.js";

const USER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const STRANGER = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";

let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message ?? "assertion failed");
}
function blocks(fn, fragment) {
  let threw = null;
  try {
    fn();
  } catch (err) {
    threw = err;
  }
  assert(threw !== null, "expected a block, but signing was allowed");
  assert(threw instanceof SolanaIntentError, `expected SolanaIntentError, got ${threw?.name}`);
  assert(threw.message.includes(fragment), `blocked for the wrong reason: ${threw.message}`);
}

// A VersionedTransaction as the wallet actually receives one: a
// compiled message with a static key table the instructions index into.
const versioned = (feePayer, instructions) => ({
  message: {
    staticAccountKeys: [
      { toBase58: () => feePayer },
      { toBase58: () => TOKEN_PROGRAM },
      { toBase58: () => TOKEN_2022 },
      { toBase58: () => SYSTEM_PROGRAM },
    ],
    compiledInstructions: instructions.map(({ programIndex, dataByte }) => ({
      programIdIndex: programIndex,
      data: dataByte === null ? new Uint8Array() : Uint8Array.from([dataByte]),
    })),
  },
});
// A legacy Transaction: instructions carry their own program ids.
const legacy = (feePayer, instructions) => ({
  feePayer: { toBase58: () => feePayer },
  instructions: instructions.map(({ programId, dataByte }) => ({
    programId: { toBase58: () => programId },
    data: dataByte === null ? new Uint8Array() : Uint8Array.from([dataByte]),
  })),
});

// ---- both shapes are understood -----------------------------------
check("a versioned transaction is parsed", () => {
  const d = describeSolanaTransaction(versioned(USER, [{ programIndex: 3, dataByte: 2 }]));
  assert(d.feePayer === USER, d.feePayer);
  assert(d.instructions[0].programId === SYSTEM_PROGRAM, d.instructions[0].programId);
});
check("a legacy transaction is parsed", () => {
  const d = describeSolanaTransaction(legacy(USER, [{ programId: SYSTEM_PROGRAM, dataByte: 2 }]));
  assert(d.feePayer === USER, d.feePayer);
});
check("an unrecognised shape parses to null rather than throwing", () => {
  assert(describeSolanaTransaction({ nonsense: true }) === null);
  assert(describeSolanaTransaction(null) === null);
});

// ---- the block ------------------------------------------------------
check("BLOCKS a transaction paid for by somebody else", () => {
  blocks(
    () => assertSolanaTransactionMatchesIntent(versioned(STRANGER, []), { expectedSigner: USER }),
    "not by your wallet",
  );
});
check("BLOCKS it in the legacy shape too", () => {
  blocks(
    () => assertSolanaTransactionMatchesIntent(legacy(STRANGER, []), { expectedSigner: USER }),
    "not by your wallet",
  );
});
check("base58 comparison is case-sensitive (unlike an EVM address)", () => {
  // Same characters, different case — a DIFFERENT Solana account.
  blocks(
    () => assertSolanaTransactionMatchesIntent(versioned(USER.toLowerCase(), []), { expectedSigner: USER }),
    "not by your wallet",
  );
});

// ---- the honest path is not blocked --------------------------------
check("an ordinary route signed by the user passes with no warnings", () => {
  const warnings = assertSolanaTransactionMatchesIntent(
    versioned(USER, [
      { programIndex: 3, dataByte: 2 }, // SystemProgram transfer
      { programIndex: 1, dataByte: 12 }, // spl-token TransferChecked
    ]),
    { expectedSigner: USER },
  );
  assert(warnings.length === 0, JSON.stringify(warnings));
});
check("an empty-data instruction does not crash the parser", () => {
  assertSolanaTransactionMatchesIntent(versioned(USER, [{ programIndex: 1, dataByte: null }]), { expectedSigner: USER });
});

// ---- the warnings ---------------------------------------------------
check("WARNS on an spl-token Approve (Solana's unlimited-allowance shape)", () => {
  const warnings = assertSolanaTransactionMatchesIntent(versioned(USER, [{ programIndex: 1, dataByte: 4 }]), { expectedSigner: USER });
  assert(warnings.length === 1 && warnings[0].includes("delegate"), JSON.stringify(warnings));
});
check("WARNS on ApproveChecked as well", () => {
  const warnings = assertSolanaTransactionMatchesIntent(versioned(USER, [{ programIndex: 1, dataByte: 13 }]), { expectedSigner: USER });
  assert(warnings.length === 1 && warnings[0].includes("delegate"), JSON.stringify(warnings));
});
check("WARNS on SetAuthority", () => {
  const warnings = assertSolanaTransactionMatchesIntent(versioned(USER, [{ programIndex: 1, dataByte: 6 }]), { expectedSigner: USER });
  assert(warnings.length === 1 && warnings[0].includes("authority"), JSON.stringify(warnings));
});
check("WARNS on CloseAccount", () => {
  const warnings = assertSolanaTransactionMatchesIntent(versioned(USER, [{ programIndex: 1, dataByte: 9 }]), { expectedSigner: USER });
  assert(warnings.length === 1 && warnings[0].includes("closes"), JSON.stringify(warnings));
});
check("Token-2022 is checked, not just the classic token program", () => {
  const warnings = assertSolanaTransactionMatchesIntent(versioned(USER, [{ programIndex: 2, dataByte: 4 }]), { expectedSigner: USER });
  assert(warnings.length === 1, JSON.stringify(warnings));
});
check("the same byte under a NON-token program is not flagged", () => {
  // Byte 4 means something entirely different to the system program;
  // matching on data bytes alone, without the program id, would produce
  // a warning on every ordinary route.
  const warnings = assertSolanaTransactionMatchesIntent(versioned(USER, [{ programIndex: 3, dataByte: 4 }]), { expectedSigner: USER });
  assert(warnings.length === 0, JSON.stringify(warnings));
});
check("an unparseable transaction warns rather than blocking the trade", () => {
  const warnings = assertSolanaTransactionMatchesIntent({ nonsense: true }, { expectedSigner: USER });
  assert(warnings.length === 1 && warnings[0].includes("could not be inspected"), JSON.stringify(warnings));
});

console.log(`${passed}/${passed + failures.length} checks passed`);
for (const failure of failures) console.error(`  FAIL ${failure}`);
if (failures.length > 0) process.exit(1);
