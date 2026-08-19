# mango-launchpad (Solana)

A Solana Anchor program implementing Mango Protocol's bonding-curve token
launchpad — the Solana counterpart to the EVM launchpad
(`MangoLaunchHook.sol` on Robinhood Chain), mirroring its fee schedule and
graduation design: a constant-product curve over virtual reserves, 1% buy
fee / 4% pre-graduation sell fee / 1% post-graduation sell fee, split
70/30 creator/protocol, with mint and freeze authority permanently
revoked at launch (fixed 1B supply, no owner-only functions — same
guarantee as the EVM side).

**This directory is deliberately kept out of the main `mango-bridge.jsx`
git history until explicitly pushed** — check `git log` on this path to
see whether that's changed. Not wired into the live frontend
(`src/Launchpad.jsx`'s Solana tab shows "Coming soon") — that's
intentional; see Status below for why.

## Status (as of the last update to this file — check `lib.rs`'s own
STATUS block and recent git log for anything more current)

**Real, live-verified:**
- Deployed to devnet: `FCGmRZL2yV2wyMiN21zn2Z1zqgTyA8taR5sYNKChnpK5`
- `initialize` → `create_launch` → `buy` → `sell` all executed
  successfully against that live deployment
  (`scripts/solana-devnet-smoke-test.mjs`), with the buy's real output
  cross-checked against `curve.rs`'s formula by hand
- Independently re-verified in a second environment against a local
  `solana-test-validator` — same four instructions, same result
- 19/19 `cargo test --lib` unit tests passing (curve math, PDA
  derivation, DAMM v2 fee encoding — see below)

**Built and unit-tested, NOT yet run on any live cluster:**
- `claim_creator_fees`, `claim_protocol_fees`, `update_global` — the
  extended smoke test script covers all three, just hasn't been executed
  against devnet/a validator yet

**Not built:**
- The graduation/migration instruction (moving a graduated curve's
  reserves to a real external AMM, Meteora DAMM v2). Real research
  progress exists in `meteora_damm_v2.rs` — program ID, PDA seeds, and
  the fee-parameter byte encoding are solved and unit-tested; the
  liquidity/sqrt_price conversion math is understood (confirmed real
  formula from source) but not implemented, since doing that correctly
  needs 256-bit fixed-point arithmetic and isn't safe to ship without a
  way to test it step by step against the real DAMM v2 program.

**Not done at all:** a security audit. Do not treat anything here as
mainnet-ready regardless of how much devnet testing has passed — real
devnet execution is real evidence for the paths actually exercised, not
a substitute for full coverage + independent review.

## Real, known operational gotcha

`target/` is gitignored (correctly — that's where the deploy keypair's
private key lives, and it must never be committed to a repo, especially
a public one). This means: **every time `target/` is freshly built with
no existing keypair present, `cargo build-sbf` generates a brand-new
random program ID that won't match `declare_id!()` in `lib.rs`.** This
has already happened three times across two different sessions working
on this program. Before deploying, always run:

```
./scripts/check-program-id.sh
```

It confirms the local keypair matches the committed `declare_id!()` in
seconds, before wasting real SOL and time discovering a mismatch via a
failed `DeclaredProgramIdMismatch` deploy.

**If you have the real deploy keypair** (`target/deploy/mango_launchpad-keypair.json`,
matching `FCGmRZL2yV2wyMiN21zn2Z1zqgTyA8taR5sYNKChnpK5`), back it up
somewhere durable. Losing it means the program's address changes again
— annoying but not catastrophic pre-mainnet (it's just a devnet
identity), genuinely costly post-mainnet.

## Setup (needs a real Solana toolchain — this can't be verified from a
sandboxed AI coding environment; every such environment tried during
this project's development blocked Solana RPC traffic entirely)

```bash
# Solana CLI (Agave) — see https://docs.anza.xyz/cli/install/
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

# Rust, if not already present
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source "$HOME/.cargo/env"

# Anchor, pinned to the exact version this program uses (see Cargo.toml)
cargo install --git https://github.com/coral-xyz/anchor avm --locked --force
avm install 0.30.1 && avm use 0.30.1
```

## Build, test, deploy

```bash
cargo check                    # fast type/borrow check, no BPF needed
cargo test --lib               # 19 unit tests, pure logic, no cluster needed
cargo build-sbf                # real BPF/SBF compile — the deployable binary
./scripts/check-program-id.sh  # confirm the keypair matches declare_id!() — always run before deploying

# Devnet deploy (needs a funded devnet wallet — ~2.7 SOL, free via
# `solana airdrop` or https://faucet.solana.com)
solana program deploy target/deploy/mango_launchpad.so \
  --program-id target/deploy/mango_launchpad-keypair.json \
  --keypair ~/devnet.json --url devnet

# Real end-to-end smoke test against the live deployment
cd .. && node scripts/solana-devnet-smoke-test.mjs ~/devnet.json
```

## Layout

```
programs/mango-launchpad/src/
  lib.rs                    entry point, instruction dispatch, STATUS block
  state.rs                  Global config + BondingCurve accounts
  curve.rs                  constant-product math + fee splitting (unit tested)
  constants.rs               fee schedule, curve defaults, seeds
  errors.rs                 custom error codes
  meteora_damm_v2.rs         graduation/migration research — see Status above
  instructions/
    initialize.rs            one-time Global config setup
    create.rs                launches a new token + bonding curve
    buy.rs / sell.rs         trade against the curve
    claim_creator_fees.rs    creator fee payout
    claim_protocol_fees.rs   protocol fee payout (permissionless)
    update_global.rs         authority-gated admin config updates
scripts/
  check-program-id.sh        catches the keypair-drift gotcha above
```

The client-side counterpart lives outside this directory, at
`../src/solanaLaunchpadProgram.js` (instruction builders) and
`../scripts/solana-devnet-smoke-test.mjs` /
`../scripts/verify-solana-launchpad-program.mjs` (the real devnet test
and a permanent regression check, respectively) — both cross-checked
against this program's own PDA derivation (`lib.rs`'s
`js_client_cross_check` test).
