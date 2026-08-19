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
// REAL DEVNET VERIFICATION, achieved 2026-08-16: this program was built to
// an actual BPF/SBF binary (`cargo build-sbf`), deployed to devnet at
// FCGmRZL2yV2wyMiN21zn2Z1zqgTyA8taR5sYNKChnpK5, and exercised end to end
// with real transactions — initialize, create_launch (a real fresh test
// token), buy (0.01 SOL), and sell all executed successfully against the
// live deployed program (scripts/solana-devnet-smoke-test.mjs). This is
// the first time this program's actual on-chain logic — PDA derivation,
// CPI signer seeds, account constraints, the mint/freeze-authority
// revocation in create.rs — has ever run, as opposed to just compiled.
// The buy's real output was cross-checked by hand against the curve
// formula and landed within rounding of the expected value, confirming
// the fee-adjusted constant-product math is correct on a live cluster,
// not just in curve.rs's unit tests.
//
// This was NOT achievable from the sandbox this program was originally
// written in — that environment (and, separately, a "trusted network
// access" cloud environment tried later, including via Alchemy's RPC)
// both blocked all Solana RPC traffic categorically. The real build,
// deploy, and smoke test above were run from a GitHub Codespace with
// genuine network access, walked through interactively.
//
// What this DOES prove: the program's core trading loop (init, launch,
// buy, sell) works correctly against a real Solana cluster. What this
// does NOT prove: claim_creator_fees/claim_protocol_fees and
// update_global have not yet been exercised on devnet (only compiled +
// unit-tested); no security audit has happened; the program ID's deploy
// keypair currently lives only in one Codespace's `target/deploy/`
// directory (never committed, correctly — that's the private key) — if
// that's lost before a real backup, the program's address changes again,
// same as happened twice already during this verification process (see
// git history: GoNqEH... then FCGmRZL... are prior, abandoned IDs whose
// keypairs no longer exist).
//
// This is the same honesty standard this project has held EVM contracts
// to all along: real devnet execution is real evidence for the paths
// actually exercised, not a substitute for a full test suite covering
// every instruction, a real audit, or a deliberate mainnet-readiness
// decision before this touches a single real dollar.
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

declare_id!("FCGmRZL2yV2wyMiN21zn2Z1zqgTyA8taR5sYNKChnpK5");

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
        let program_id: Pubkey = "FCGmRZL2yV2wyMiN21zn2Z1zqgTyA8taR5sYNKChnpK5".parse().unwrap();
        let fixed_mint: Pubkey = "So11111111111111111111111111111111111111112".parse().unwrap();

        let (global_pda, global_bump) = Pubkey::find_program_address(&[GLOBAL_SEED], &program_id);
        assert_eq!(global_pda.to_string(), "8uuKngtesL3UxjeFYXkH7a77AJjYqNdioyKeYzBDBoei");
        assert_eq!(global_bump, 255);

        let (bonding_curve_pda, bc_bump) =
            Pubkey::find_program_address(&[BONDING_CURVE_SEED, fixed_mint.as_ref()], &program_id);
        assert_eq!(bonding_curve_pda.to_string(), "7pKJz25qq61fqHLMyHJp9qkfYiUauPQaqkrNZamhJDgA");
        assert_eq!(bc_bump, 255);
    }
}
