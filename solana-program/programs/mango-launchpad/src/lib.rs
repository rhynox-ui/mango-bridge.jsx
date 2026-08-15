use anchor_lang::prelude::*;

pub mod constants;
pub mod curve;
pub mod errors;
pub mod instructions;
pub mod meteora_damm_v2;
pub mod state;

// `pub use instructions::*` (not a plain `use`) is required at the crate
// root — Anchor's #[program] macro below looks for each Accounts struct's
// hidden `__client_accounts_*` items relative to the crate root
// specifically, not relative to the `instructions` module, so the glob
// re-export has to reach all the way up here, matching Anchor's own
// standard project layout. This DOES make every instruction file's same-
// named `handler` function ambiguously multiply-available under this glob
// — that's fine and does not error, since Rust only rejects an ambiguous
// glob-imported name if it's actually referenced unqualified, and every
// call site below uses the fully qualified `instructions::buy::handler`
// form specifically to avoid ever doing that.
pub use instructions::*;

// ============================================================================
// STATUS — read this before trusting anything below.
//
// This program has been verified with `cargo check` against the native
// (non-BPF) target — real compiler-level checking of types, borrow rules,
// and Anchor's macro expansion, which caught and fixed real issues while
// writing it. curve.rs additionally has real, passing `cargo test` unit
// tests (pure arithmetic, no Solana runtime needed) — these caught one
// genuine, non-hypothetical bug: the original buy/sell math rounded
// output amounts in the TRADER's favor instead of the pool's on every
// single trade (bounded to ~1 base unit, not practically exploitable at
// Solana's real transaction cost, but still the wrong direction for an
// AMM to round in). Fixed by switching to the single-division closed-form
// formula — see curve.rs's module comment for the concrete numbers. This
// is the level of confidence unit tests can actually provide: real
// arithmetic correctness, not proof the full Anchor program (PDA
// derivation, CPI signer seeds, account validation) behaves correctly end
// to end. It has NOT been:
//   - built to an actual deployable BPF/SBF binary (`anchor build` /
//     `cargo build-sbf`) — the Solana CLI's installer domain
//     (release.anza.xyz) is blocked by this sandbox's egress policy, the
//     same class of restriction that blocked direct RPC access to
//     Robinhood Chain earlier in this project. No local toolchain exists
//     here to do this.
//   - run against a local validator or devnet — same reason, no `solana`
//     CLI available. This means none of the Accounts structs' PDA seeds,
//     CPI calls, or account constraints have ever actually executed —
//     only compiled.
//   - audited.
//
// This is the same honesty standard this project has held EVM contracts
// to all along: a real compile check is real evidence, it is not proof of
// correctness, and it is not a substitute for a real build + real tests +
// a real audit before this touches a single real dollar. Treat this
// exactly like an unverified draft until someone with the actual Solana
// toolchain builds and tests it for real.
//
// Known, deliberate gaps, not oversights:
//   - No graduation/migration instruction yet. buy.rs/sell.rs flip
//     `graduated = true` and then refuse further trades once the SOL
//     threshold is crossed, but nothing yet moves the accumulated
//     reserves into a real external AMM (Meteora DAMM v2, per the
//     research this design is based on). A graduated token is currently a
//     dead end with funds correctly locked in the bonding_curve PDA and
//     token_vault, not lost — but genuinely untradeable until a migrate
//     instruction exists. meteora_damm_v2.rs has real, source-verified
//     program ID / PDA seeds / derivation helpers for this, but the
//     actual migrate instruction is NOT built — see that file's own
//     module doc for exactly what's still unsolved (DAMM v2's opaque
//     packed fee-parameter encoding, and the linear-curve-to-sqrt-price
//     math) and why it isn't safe to guess at blind in this sandbox.
//   - update_global (authority-gated fee schedule / protocol wallet /
//     graduation threshold / authority-rotation updates) now exists —
//     see instructions/update_global.rs for exactly what it does and does
//     NOT cover (curve-shape constants are deliberately excluded).
// ============================================================================

declare_id!("2iPvVbb64HNmRq1oWW83cgSQ9frgYd8Kv3ShckUafccU");

#[program]
pub mod mango_launchpad {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        instructions::initialize::handler(ctx)
    }

    pub fn create_launch(ctx: Context<CreateLaunch>) -> Result<()> {
        instructions::create::handler(ctx)
    }

    pub fn buy(ctx: Context<Buy>, sol_in: u64, min_token_out: u64) -> Result<()> {
        instructions::buy::handler(ctx, sol_in, min_token_out)
    }

    pub fn sell(ctx: Context<Sell>, token_in: u64, min_sol_out: u64) -> Result<()> {
        instructions::sell::handler(ctx, token_in, min_sol_out)
    }

    pub fn claim_creator_fees(ctx: Context<ClaimCreatorFees>) -> Result<()> {
        instructions::claim_creator_fees::handler(ctx)
    }

    pub fn claim_protocol_fees(ctx: Context<ClaimProtocolFees>) -> Result<()> {
        instructions::claim_protocol_fees::handler(ctx)
    }

    pub fn update_global(ctx: Context<UpdateGlobal>, params: UpdateGlobalParams) -> Result<()> {
        instructions::update_global::handler(ctx, params)
    }
}

// ============================================================================
// Cross-language regression pin — src/solanaLaunchpadProgram.js (the
// client-side instruction builder) independently hardcodes this exact
// program ID and these exact seed byte strings to derive the same PDAs.
// This test doesn't just check the seeds match themselves — it pins the
// actual resulting addresses (verified once by literally running both the
// Rust and JS derivations side by side and confirming an exact match), so
// if PROGRAM_ID, GLOBAL_SEED, or BONDING_CURVE_SEED ever changes here
// without the JS module being updated to match, this test catches the
// drift immediately instead of it surfacing as a mysterious "account not
// found" from a live transaction later.
// ============================================================================
#[cfg(test)]
mod js_client_cross_check {
    use crate::constants::{BONDING_CURVE_SEED, GLOBAL_SEED};
    use anchor_lang::prelude::*;

    #[test]
    fn pda_derivation_matches_solana_launchpad_program_js() {
        let program_id: Pubkey = "2iPvVbb64HNmRq1oWW83cgSQ9frgYd8Kv3ShckUafccU".parse().unwrap();
        let fixed_mint: Pubkey = "So11111111111111111111111111111111111111112".parse().unwrap();

        let (global_pda, global_bump) = Pubkey::find_program_address(&[GLOBAL_SEED], &program_id);
        assert_eq!(global_pda.to_string(), "FxaR3zYCA11WtbvVDpQ4juX7ktwKFDb45MdTnwVh5os2");
        assert_eq!(global_bump, 253);

        let (bonding_curve_pda, bc_bump) =
            Pubkey::find_program_address(&[BONDING_CURVE_SEED, fixed_mint.as_ref()], &program_id);
        assert_eq!(bonding_curve_pda.to_string(), "BM5yig234taXP5yYikbUvdSrrhSrpZHFGHrfv1RqPgWS");
        assert_eq!(bc_bump, 253);
    }
}
