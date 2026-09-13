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
// 2. RESOLVED (as of the second research pass): DAMM v2's `BaseFeeParameters
//    { data: [u8; 27] }` looked opaque at first, but Meteora's own
//    base_fee_serde.rs shows `data` is just Borsh-serialized as one of three
//    plain structs, selected by a mode byte at offset 26. The simplest one,
//    `BorshFeeTimeScheduler` (cliff_fee_numerator: u64, number_of_period:
//    u16, period_frequency: u64, reduction_factor: u64, base_fee_mode: u8 —
//    verified via their own `static_assertions::const_assert_eq!` to total
//    exactly 27 bytes), collapses into a genuinely static fee when
//    number_of_period = 0. encode_static_base_fee_parameters() below builds
//    this by hand — no crate dependency needed, matching the manual-CPI
//    approach from point 1. Still real, source-verified — not published/
//    stable API, so re-check against Meteora's current source if this is
//    ever touched again after enough time has passed.
//
// 3. STILL unsolved, but the SHAPE of the problem is now known (third
//    research pass, into liquidity_handler/concentrated_liquidity.rs).
//    DAMM v2's real formula, confirmed from source, not guessed:
//      token_a_amount = liquidity * (1/sqrt_price - 1/sqrt_max_price)
//      token_b_amount = liquidity * (sqrt_price - sqrt_min_price)
//    (token_a = the new project token, token_b = SOL/WSOL — matches the
//    Uniswap v3 amount0/amount1 shape exactly, and confirms
//    sqrt_price = sqrt(token_b/token_a), same as Meteora's own doc
//    comment on InitializeCustomizablePoolParameters.sqrt_price said).
//    For a full-range position (sqrt_min/max_price at the protocol's
//    own MIN_SQRT_PRICE/MAX_SQRT_PRICE constants), this reduces to the
//    familiar liquidity ≈ sqrt(token_a_amount * token_b_amount) and
//    sqrt_price ≈ sqrt(token_b_amount/token_a_amount) — but "reduces to,
//    approximately" is exactly the problem: getting this bit-exact
//    requires 256-bit integer arithmetic (Meteora's own implementation
//    uses the `ruint` crate's U256 for their sqrt_u256 and
//    mul_div_u256), spanning an enormous dynamic range (MIN_SQRT_PRICE
//    ≈ 4.3e9 to MAX_SQRT_PRICE ≈ 7.9e28) where a rounding mismatch of
//    even one unit could make the CPI's deposit fail or leave dust.
//    Reimplementing that by hand (to avoid the Anchor-version dependency
//    conflict from point 1) is a real, large, precision-critical
//    undertaking — a genuinely different kind of task than point 2's
//    byte-layout replication, and not something to ship without a real
//    way to test each step against the actual deployed DAMM v2 program
//    as it's built, which this sandbox still doesn't have (see lib.rs's
//    STATUS block — devnet access exists only via an external Codespace
//    session, not here).
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

// DAMM v2's own fee-numerator convention — verified from
// programs/cp-amm/src/constants.rs's `fee` module. Deliberately a
// separate constant from this program's own BPS_DENOMINATOR (10_000,
// see constants.rs) — these are two different programs' two different
// fee conventions, not interchangeable.
pub const DAMM_V2_FEE_DENOMINATOR: u64 = 1_000_000_000;
// BaseFeeMode::FeeTimeSchedulerLinear — first variant, so Rust's default
// enum discriminant is 0. Verified against state/fee.rs's enum
// definition, not assumed.
pub const BASE_FEE_MODE_TIME_SCHEDULER_LINEAR: u8 = 0;

/// Builds DAMM v2's `BaseFeeParameters.data` (a `[u8; 27]`) for a
/// genuinely static, non-decaying fee — no time-scheduler decay, no
/// rate-limiter, no market-cap tie-in. `fee_bps` uses the SAME basis-
/// point convention as this program's own fee constants (e.g. 100 =
/// 1%, matching SELL_FEE_BPS_POST_GRADUATION), converted internally to
/// DAMM v2's own numerator/DAMM_V2_FEE_DENOMINATOR convention.
///
/// Byte layout (Borsh field order from BorshFeeTimeScheduler, verified
/// against Meteora's own source — see the module doc above):
///   [0..8)   cliff_fee_numerator: u64 LE
///   [8..10)  number_of_period: u16 LE — 0 here, so no decay ever applies
///   [10..18) period_frequency: u64 LE — 0, irrelevant when period=0
///   [18..26) reduction_factor: u64 LE — 0, irrelevant when period=0
///   [26]     base_fee_mode: u8
pub fn encode_static_base_fee_parameters(fee_bps: u16) -> [u8; 27] {
    let cliff_fee_numerator: u64 = (fee_bps as u64) * DAMM_V2_FEE_DENOMINATOR / 10_000;
    let mut bytes = [0u8; 27];
    bytes[0..8].copy_from_slice(&cliff_fee_numerator.to_le_bytes());
    bytes[26] = BASE_FEE_MODE_TIME_SCHEDULER_LINEAR;
    bytes
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

    #[test]
    fn static_base_fee_matches_hand_computed_layout() {
        // 100 bps (1%) — same convention as SELL_FEE_BPS_POST_GRADUATION.
        let bytes = encode_static_base_fee_parameters(100);
        assert_eq!(bytes.len(), 27);

        let cliff_fee_numerator = u64::from_le_bytes(bytes[0..8].try_into().unwrap());
        assert_eq!(cliff_fee_numerator, 10_000_000); // 1% of 1_000_000_000

        let number_of_period = u16::from_le_bytes(bytes[8..10].try_into().unwrap());
        assert_eq!(number_of_period, 0, "must be 0 so the decay math never applies — this is a flat fee, not a schedule");

        // period_frequency and reduction_factor: irrelevant when
        // number_of_period is 0, but pinned at 0 anyway for a clean,
        // unambiguous encoding rather than leaving them undefined.
        assert_eq!(&bytes[10..18], &[0u8; 8]);
        assert_eq!(&bytes[18..26], &[0u8; 8]);

        assert_eq!(bytes[26], BASE_FEE_MODE_TIME_SCHEDULER_LINEAR);
    }

    #[test]
    fn static_base_fee_zero_bps_is_a_real_zero_fee() {
        let bytes = encode_static_base_fee_parameters(0);
        let cliff_fee_numerator = u64::from_le_bytes(bytes[0..8].try_into().unwrap());
        assert_eq!(cliff_fee_numerator, 0);
    }

    #[test]
    fn static_base_fee_max_bps_does_not_overflow() {
        // 10_000 bps = 100% — the ceiling this program's own InvalidFeeBps
        // check allows elsewhere (see update_global.rs). Confirms the u64
        // arithmetic here has no overflow risk even at the extreme.
        let bytes = encode_static_base_fee_parameters(10_000);
        let cliff_fee_numerator = u64::from_le_bytes(bytes[0..8].try_into().unwrap());
        assert_eq!(cliff_fee_numerator, DAMM_V2_FEE_DENOMINATOR);
    }
}
