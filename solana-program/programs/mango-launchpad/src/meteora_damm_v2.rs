use anchor_lang::prelude::*;

// ============================================================================
// Meteora DAMM v2 integration constants — real, verified values only.
//
// STATUS: research/scaffold, not a working migration instruction. See the
// long comment below for exactly what's missing and why. Every constant in
// this file was pulled directly from Meteora's own source
// (github.com/MeteoraAg/damm-v2, `main` branch, read at the time this was
// written) — not guessed, not inferred from documentation prose. If
// Meteora ever changes their program (a new deployment, renamed seeds),
// this file needs re-verifying against their current source before reuse.
//
// WHY THIS ISN'T A FINISHED migrate.rs INSTRUCTION YET:
//
// 1. Anchor version mismatch. This program is on anchor-lang 0.30.1
//    (Cargo.toml). Meteora's damm-v2 workspace pins anchor-lang 1.0.2 (their
//    root Cargo.toml). Anchor's typed account wrappers (Account<>,
//    InterfaceAccount<>, Context<>, etc.) from two different major Anchor
//    versions are not interchangeable in one compilation — adding their
//    `cp-amm` crate as a direct dependency would very likely produce
//    duplicate/incompatible-type compile errors, not a clean CPI call.
//    The correct fix is a MANUAL CPI: build the raw
//    `solana_program::instruction::Instruction` (program id + account
//    metas + Borsh-encoded instruction data, using Anchor's standard
//    8-byte sha256("global:<ix_name>") discriminator) and invoke it via
//    `invoke_signed`, never importing their crate's types at all. This is
//    exactly what this file's constants are for.
//
// 2. The genuinely hard, NOT-yet-solved part: DAMM v2's `PoolFeeParameters`
//    packs its base-fee schedule into an opaque `BaseFeeParameters { data:
//    [u8; 27] }` — one of three different fee-scheduler encodings
//    (market-cap, rate-limiter, time-scheduler), serialized by Meteora's
//    own `base_fee_serde` module. Hand-deriving that byte layout from
//    source alone, for an instruction that will move a graduated curve's
//    ENTIRE real SOL + token reserves in one shot, is not something this
//    project's own standard allows shipping without a real way to verify
//    it — there's no local Solana toolchain in this sandbox to test the
//    encoding against the actual deployed program (see lib.rs's STATUS
//    block for the same constraint on the rest of this program).
//
// 3. Also unsolved: converting this program's LINEAR virtual-reserve curve
//    (virtual_sol_reserves / virtual_token_reserves) into DAMM v2's
//    `sqrt_price` (Q64.64) and `liquidity` (concentrated-liquidity, not a
//    simple constant-product value) parameters. This is a real, derivable
//    math conversion, just not yet derived or checked here.
//
// What IS safe to trust from this file: the program ID and every PDA seed
// constant below, and the derive_* helper functions built from them — pure
// deterministic PDA math, verified against Meteora's real source, with no
// dependency on the unsolved pieces above.
// ============================================================================

pub const DAMM_V2_PROGRAM_ID: &str = "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG";

pub fn damm_v2_program_id() -> Pubkey {
    DAMM_V2_PROGRAM_ID
        .parse::<Pubkey>()
        .expect("DAMM_V2_PROGRAM_ID is a valid, real, already-deployed Solana address")
}

// Seeds copied verbatim from programs/cp-amm/src/constants.rs's `seeds`
// module in Meteora's damm-v2 repo.
pub const POOL_AUTHORITY_SEED: &[u8] = b"pool_authority";
pub const CUSTOMIZABLE_POOL_SEED: &[u8] = b"cpool";
pub const TOKEN_VAULT_SEED: &[u8] = b"token_vault";
pub const POSITION_SEED: &[u8] = b"position";
pub const POSITION_NFT_ACCOUNT_SEED: &[u8] = b"position_nft_account";

/// The DAMM v2 program's single, global pool-authority PDA — the signer
/// authority over every pool's token vaults across the whole program, not
/// per-pool. Same account for every migration; safe to derive once and
/// reuse.
pub fn derive_pool_authority() -> (Pubkey, u8) {
    Pubkey::find_program_address(&[POOL_AUTHORITY_SEED], &damm_v2_program_id())
}

/// A "customizable" pool's address is deterministic from its two mints —
/// ordered by MAX/MIN pubkey bytes (NOT token_a/token_b in caller-chosen
/// order), matching `max_key`/`min_key` in Meteora's
/// ix_initialize_customizable_pool.rs. Caller must still independently
/// decide which of the two mints is passed as token_a vs token_b in the
/// CPI accounts — that ordering affects sqrt_price's meaning
/// (sqrt(token_b/token_a)) even though the POOL ADDRESS itself doesn't
/// depend on which is which.
pub fn derive_customizable_pool(mint_a: &Pubkey, mint_b: &Pubkey) -> (Pubkey, u8) {
    let (max_key, min_key) = if mint_a > mint_b { (mint_a, mint_b) } else { (mint_b, mint_a) };
    Pubkey::find_program_address(
        &[CUSTOMIZABLE_POOL_SEED, max_key.as_ref(), min_key.as_ref()],
        &damm_v2_program_id(),
    )
}

pub fn derive_token_vault(token_mint: &Pubkey, pool: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[TOKEN_VAULT_SEED, token_mint.as_ref(), pool.as_ref()],
        &damm_v2_program_id(),
    )
}

pub fn derive_position(position_nft_mint: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[POSITION_SEED, position_nft_mint.as_ref()], &damm_v2_program_id())
}

pub fn derive_position_nft_account(position_nft_mint: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[POSITION_NFT_ACCOUNT_SEED, position_nft_mint.as_ref()],
        &damm_v2_program_id(),
    )
}

// ============================================================================
// Unit tests — same "actually verifiable in this sandbox" principle as
// curve.rs's tests. These don't prove the migration instruction is
// correct (it doesn't exist yet), but they do pin down real, checkable
// facts: the program ID string parses to a valid Pubkey, and the pool-
// address derivation is symmetric regardless of argument order (a real
// correctness requirement — the same token pair must always resolve to
// the same pool address no matter which order a caller happens to pass
// the two mints in, or migrate.rs could derive a different `pool` address
// than a concurrent caller, and the CPI would fail on an account mismatch
// instead of finding the real pool).
// ============================================================================
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn program_id_parses() {
        let _ = damm_v2_program_id();
    }

    #[test]
    fn pool_derivation_is_order_independent() {
        let mint_x = Pubkey::new_unique();
        let mint_y = Pubkey::new_unique();
        assert_eq!(derive_customizable_pool(&mint_x, &mint_y), derive_customizable_pool(&mint_y, &mint_x));
    }

    #[test]
    fn pool_derivation_differs_for_different_pairs() {
        let mint_x = Pubkey::new_unique();
        let mint_y = Pubkey::new_unique();
        let mint_z = Pubkey::new_unique();
        assert_ne!(derive_customizable_pool(&mint_x, &mint_y), derive_customizable_pool(&mint_x, &mint_z));
    }
}
