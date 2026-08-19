#!/usr/bin/env bash
# solana-program/scripts/check-program-id.sh
#
# Catches a real, recurring bug class before it wastes a deploy attempt:
# target/ is gitignored (correctly — that's where the deploy keypair's
# private key lives, never committed), so any fresh `cargo build-sbf` /
# `anchor build` run against a clean/wiped target/ auto-generates a BRAND
# NEW random keypair if none exists yet — which does NOT match the
# committed declare_id!() in lib.rs. This has happened three separate
# times across two different sessions working on this program (see git
# history: GoNqEH... and FCGmRZL... are both abandoned program IDs whose
# keypairs no longer exist anywhere). Every time, it surfaced late — as
# a `DeclaredProgramIdMismatch` runtime error on an actual deploy attempt,
# after real SOL and real time had already been spent. This script checks
# the mismatch BEFORE that, in seconds, with no SOL involved.
#
# Run this after any `cargo build-sbf` / `anchor build`, before deploying:
#   ./scripts/check-program-id.sh
#
# Exit code 0 = IDs match, safe to deploy. Exit code 1 = mismatch found,
# printed instructions for what to do about it.

set -euo pipefail
cd "$(dirname "$0")/.."

LIB_RS="programs/mango-launchpad/src/lib.rs"
KEYPAIR="target/deploy/mango_launchpad-keypair.json"

if ! command -v solana-keygen >/dev/null 2>&1; then
  echo "solana-keygen not found on PATH — install the Solana CLI first (see the project's setup notes)." >&2
  exit 2
fi

if [ ! -f "$LIB_RS" ]; then
  echo "Can't find $LIB_RS — run this from inside solana-program/, or check the repo layout hasn't changed." >&2
  exit 2
fi

DECLARED_ID=$(grep -oP 'declare_id!\("\K[^"]+' "$LIB_RS" || true)
if [ -z "$DECLARED_ID" ]; then
  echo "Couldn't find declare_id!(\"...\") in $LIB_RS — check the file hasn't changed format." >&2
  exit 2
fi

if [ ! -f "$KEYPAIR" ]; then
  echo "No keypair file at $KEYPAIR yet — run 'cargo build-sbf' first (it generates one on first build)."
  echo "declare_id!() currently says: $DECLARED_ID"
  exit 1
fi

ACTUAL_ID=$(solana-keygen pubkey "$KEYPAIR")

if [ "$DECLARED_ID" = "$ACTUAL_ID" ]; then
  echo "OK — declare_id!() ($DECLARED_ID) matches the local keypair. Safe to deploy."
  exit 0
fi

cat >&2 <<EOF
MISMATCH — this WILL fail with DeclaredProgramIdMismatch if you deploy now.

  declare_id!() in lib.rs says: $DECLARED_ID
  Local keypair file actually is: $ACTUAL_ID

This means target/ was built fresh without the real keypair present —
cargo build-sbf generated a new random one instead of using the intended
program's key. Two ways to fix it, pick one:

  1. If you have a BACKUP of the correct keypair (the one matching
     $DECLARED_ID) — restore it to $KEYPAIR, then run
     'cargo build-sbf' again so the binary embeds the right ID, and
     re-run this script to confirm.

  2. If that backup is genuinely lost (as happened twice already this
     project) — the local keypair ($ACTUAL_ID) is now the real one
     going forward. Update declare_id!() in $LIB_RS and the
     [programs.*] section of Anchor.toml to $ACTUAL_ID, update
     src/solanaLaunchpadProgram.js's PROGRAM_ID and the
     js_client_cross_check test in lib.rs to match (see git log for
     the exact pattern — commits f12dcbf and d1fb138 did this before),
     then rebuild.

Either way: back up $KEYPAIR somewhere durable NOW, before doing
anything else, so this doesn't happen a fourth time.
EOF
exit 1
