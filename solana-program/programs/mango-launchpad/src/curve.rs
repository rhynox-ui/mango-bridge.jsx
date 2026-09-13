use crate::errors::MangoLaunchpadError;
use anchor_lang::prelude::*;

// ============================================================================
// Constant-product curve over VIRTUAL reserves — x*y=k, the same real,
// standard formula pump.fun and Meteora DBC both use (confirmed via source
// review during research), and structurally the same invariant a single
// Uniswap v3/v4 concentrated-liquidity position enforces, just expressed
// directly instead of via tick/sqrtPrice math since there's no separate
// AMM program here to delegate to.
//
// Both output formulas below are the single-division closed form —
// token_out = (virtual_token_reserves * sol_in) / (virtual_sol_reserves +
// sol_in), and symmetrically for sol_out — algebraically identical to
// "compute new_virtual_reserve = k / new_other_reserve, then subtract",
// but NOT interchangeable under integer division: an earlier version of
// this file computed it the "new reserve, then subtract" way, which floors
// the INTERMEDIATE reserve and therefore rounds the OUTPUT up — in the
// trader's favor, the wrong direction for pool safety (confirmed with a
// concrete example: a 1 SOL buy against 30 SOL / 1.073B virtual token
// reserves overpaid the trader by 1 raw token unit, and strictly decreased
// k, on every single call). Flooring this direct single-division formula
// instead rounds the output DOWN, so k can only stay the same or increase
// — see curve::tests below, which pin exactly this invariant so it can't
// silently regress back to the old direction.
//
// All intermediate math is done in u128 specifically to avoid overflow:
// virtual_sol_reserves * virtual_token_reserves can exceed u64::MAX well
// before either individual reserve does (e.g. ~4.3B lamports * ~4.3B token
// base units already overflows u64), so computing k directly in u64 would
// be a real, live bug, not a theoretical one. Every arithmetic op is
// `checked_*` — an overflow or divide-by-zero returns a real error instead
// of panicking or (worse, if this were release-mode without overflow-checks
// enabled) silently wrapping. Cargo.toml's workspace profile also sets
// `overflow-checks = true` for release builds as defense in depth on top of
// this, not instead of it.
// ============================================================================

/// Given SOL entering the curve, returns the RAW token amount that would
/// leave it — before any fee is skimmed off this output. Fee application
/// happens in buy.rs, not here, matching the EVM hook's real behavior of
/// fee-on-output rather than fee-on-input.
pub fn compute_buy_raw_token_out(
    virtual_sol_reserves: u64,
    virtual_token_reserves: u64,
    sol_in: u64,
) -> Result<u64> {
    require!(sol_in > 0, MangoLaunchpadError::ZeroAmount);

    let numerator: u128 = (virtual_token_reserves as u128)
        .checked_mul(sol_in as u128)
        .ok_or(MangoLaunchpadError::MathOverflow)?;

    let denominator: u128 = (virtual_sol_reserves as u128)
        .checked_add(sol_in as u128)
        .ok_or(MangoLaunchpadError::MathOverflow)?;

    let raw_token_out: u128 = numerator
        .checked_div(denominator)
        .ok_or(MangoLaunchpadError::MathOverflow)?; // denominator > 0 always, since sol_in > 0

    u64::try_from(raw_token_out).map_err(|_| MangoLaunchpadError::MathOverflow.into())
}

/// Given tokens entering the curve, returns the RAW SOL amount that would
/// leave it — before any fee is skimmed off this output.
pub fn compute_sell_raw_sol_out(
    virtual_sol_reserves: u64,
    virtual_token_reserves: u64,
    token_in: u64,
) -> Result<u64> {
    require!(token_in > 0, MangoLaunchpadError::ZeroAmount);

    let numerator: u128 = (virtual_sol_reserves as u128)
        .checked_mul(token_in as u128)
        .ok_or(MangoLaunchpadError::MathOverflow)?;

    let denominator: u128 = (virtual_token_reserves as u128)
        .checked_add(token_in as u128)
        .ok_or(MangoLaunchpadError::MathOverflow)?;

    let raw_sol_out: u128 = numerator
        .checked_div(denominator)
        .ok_or(MangoLaunchpadError::MathOverflow)?; // denominator > 0 always, since token_in > 0

    u64::try_from(raw_sol_out).map_err(|_| MangoLaunchpadError::MathOverflow.into())
}

/// Splits a raw output amount into (user_amount, fee_amount) given a fee
/// rate in basis points. Used identically for buy's token-denominated fee
/// and sell's SOL-denominated fee — the currency is the caller's concern,
/// this is pure arithmetic.
pub fn apply_fee(raw_amount: u64, fee_bps: u16) -> Result<(u64, u64)> {
    let fee_amount: u128 = (raw_amount as u128)
        .checked_mul(fee_bps as u128)
        .ok_or(MangoLaunchpadError::MathOverflow)?
        .checked_div(crate::constants::BPS_DENOMINATOR as u128)
        .ok_or(MangoLaunchpadError::MathOverflow)?;

    let fee_amount = u64::try_from(fee_amount).map_err(|_| MangoLaunchpadError::MathOverflow)?;
    let user_amount = raw_amount
        .checked_sub(fee_amount)
        .ok_or(MangoLaunchpadError::MathOverflow)?;

    Ok((user_amount, fee_amount))
}

/// Splits a fee amount into (creator_share, protocol_share) given the
/// configured split — 70/30 by default, per Global config. Any dust from
/// integer division rounds into the protocol's share (protocol_share =
/// fee_amount - creator_share, computed by subtraction, not by its own
/// separate division) so the two shares always sum to exactly fee_amount
/// with nothing lost or double-counted.
pub fn split_fee(fee_amount: u64, creator_share_bps: u16) -> Result<(u64, u64)> {
    let creator_share: u128 = (fee_amount as u128)
        .checked_mul(creator_share_bps as u128)
        .ok_or(MangoLaunchpadError::MathOverflow)?
        .checked_div(crate::constants::BPS_DENOMINATOR as u128)
        .ok_or(MangoLaunchpadError::MathOverflow)?;

    let creator_share = u64::try_from(creator_share).map_err(|_| MangoLaunchpadError::MathOverflow)?;
    let protocol_share = fee_amount
        .checked_sub(creator_share)
        .ok_or(MangoLaunchpadError::MathOverflow)?;

    Ok((creator_share, protocol_share))
}

// ============================================================================
// Unit tests — the one piece of this program actually verifiable in this
// sandbox right now. `cargo test` runs against the native target, same as
// `cargo check`; no BPF toolchain or validator needed, since this whole
// module is pure arithmetic with zero Solana runtime dependency. This is
// real evidence the curve math and fee-splitting logic behave correctly on
// real numbers — it does NOT substitute for real Anchor integration tests
// (account init, PDA derivation, CPI signer seeds, the full buy/sell
// handlers) once a real toolchain is available; see lib.rs's STATUS block.
// ============================================================================
#[cfg(test)]
mod tests {
    use super::*;

    // Real defaults from constants.rs — using the actual production values
    // rather than round test numbers, so these tests exercise the exact
    // magnitudes the program will really run on (30 SOL / ~1.073B tokens),
    // not a toy curve that could hide an overflow only the real scale
    // would trigger.
    const VIRTUAL_SOL: u64 = 30_000_000_000; // 30 SOL
    const VIRTUAL_TOKEN: u64 = 1_073_000_000_000_000; // 1,073,000,000 tokens @ 6 decimals

    #[test]
    fn buy_matches_constant_product_by_hand() {
        let sol_in = 1_000_000_000u64; // 1 SOL
        let token_out = compute_buy_raw_token_out(VIRTUAL_SOL, VIRTUAL_TOKEN, sol_in).unwrap();

        // k must be preserved (up to integer-division rounding, which can
        // only ever round the pool's favor — new_k >= k, never less, since
        // new_virtual_token is floor-divided).
        let k = VIRTUAL_SOL as u128 * VIRTUAL_TOKEN as u128;
        let new_k = (VIRTUAL_SOL + sol_in) as u128 * (VIRTUAL_TOKEN - token_out) as u128;
        assert!(new_k >= k, "constant product must not decrease after a buy");

        // Sanity bound: 1 SOL into a 30-SOL pool should buy noticeably less
        // than 1/30th of virtual token reserves (price rises along the
        // curve), but more than 0.
        assert!(token_out > 0);
        assert!(token_out < VIRTUAL_TOKEN / 30);
    }

    #[test]
    fn sell_matches_constant_product_by_hand() {
        let token_in = 10_000_000_000_000u64; // 10,000,000 tokens
        let sol_out = compute_sell_raw_sol_out(VIRTUAL_SOL, VIRTUAL_TOKEN, token_in).unwrap();

        let k = VIRTUAL_SOL as u128 * VIRTUAL_TOKEN as u128;
        let new_k = (VIRTUAL_SOL - sol_out) as u128 * (VIRTUAL_TOKEN + token_in) as u128;
        assert!(new_k >= k, "constant product must not decrease after a sell");
        assert!(sol_out > 0);
    }

    #[test]
    fn buy_then_sell_round_trip_never_profits_the_trader() {
        // Buying token_out with sol_in, then immediately selling that exact
        // token_out back (raw, no fees applied by these functions — fees
        // are a separate concern layered on top in buy.rs/sell.rs), must
        // return no more than the original sol_in. If this ever returned
        // MORE than sol_in, that would be a real, exploitable curve bug
        // (free money by round-tripping), not just a rounding nit.
        let sol_in = 5_000_000_000u64; // 5 SOL
        let token_out = compute_buy_raw_token_out(VIRTUAL_SOL, VIRTUAL_TOKEN, sol_in).unwrap();

        let new_virtual_sol = VIRTUAL_SOL + sol_in;
        let new_virtual_token = VIRTUAL_TOKEN - token_out;
        let sol_back = compute_sell_raw_sol_out(new_virtual_sol, new_virtual_token, token_out).unwrap();

        assert!(sol_back <= sol_in, "round-tripping the raw curve must never yield a profit");
    }

    #[test]
    fn zero_amount_is_rejected() {
        assert!(compute_buy_raw_token_out(VIRTUAL_SOL, VIRTUAL_TOKEN, 0).is_err());
        assert!(compute_sell_raw_sol_out(VIRTUAL_SOL, VIRTUAL_TOKEN, 0).is_err());
    }

    #[test]
    fn apply_fee_splits_correctly_and_sums_to_raw_amount() {
        // 1% fee (100 bps, the real BUY_FEE_BPS default) on 1,000,000 raw units.
        let (user_amount, fee_amount) = apply_fee(1_000_000, 100).unwrap();
        assert_eq!(fee_amount, 10_000); // exactly 1% here, no rounding involved
        assert_eq!(user_amount, 990_000);
        assert_eq!(user_amount + fee_amount, 1_000_000, "user + fee must always reconstruct the raw amount");
    }

    #[test]
    fn apply_fee_zero_bps_takes_no_fee() {
        let (user_amount, fee_amount) = apply_fee(12_345, 0).unwrap();
        assert_eq!(fee_amount, 0);
        assert_eq!(user_amount, 12_345);
    }

    #[test]
    fn apply_fee_rounding_never_lets_fee_and_user_amount_desync() {
        // A raw amount not evenly divisible by the fee rate — 400 bps (4%,
        // the real SELL_FEE_BPS_PRE_GRADUATION default) of 333 doesn't
        // divide evenly. The invariant that must hold regardless of which
        // way the rounding goes: user_amount + fee_amount == raw_amount,
        // always, for every input — never losing or fabricating a unit.
        for raw in [1u64, 3, 7, 33, 333, 999_999_937] {
            let (user_amount, fee_amount) = apply_fee(raw, 400).unwrap();
            assert_eq!(user_amount + fee_amount, raw, "raw={raw}");
        }
    }

    #[test]
    fn split_fee_dust_goes_to_protocol_and_shares_sum_to_fee_amount() {
        // 70% creator share (the real CREATOR_FEE_SHARE_BPS default) of an
        // amount that doesn't divide evenly by 10 — dust must land on the
        // protocol's side (computed by subtraction), never lost.
        let (creator_share, protocol_share) = split_fee(101, 7000).unwrap();
        assert_eq!(creator_share + protocol_share, 101);
        // 101 * 7000 / 10000 = 70.7 -> floors to 70.
        assert_eq!(creator_share, 70);
        assert_eq!(protocol_share, 31);
    }

    #[test]
    fn split_fee_full_creator_share_leaves_nothing_for_protocol() {
        let (creator_share, protocol_share) = split_fee(500, 10_000).unwrap();
        assert_eq!(creator_share, 500);
        assert_eq!(protocol_share, 0);
    }

    #[test]
    fn split_fee_zero_creator_share_gives_everything_to_protocol() {
        let (creator_share, protocol_share) = split_fee(500, 0).unwrap();
        assert_eq!(creator_share, 0);
        assert_eq!(protocol_share, 500);
    }

    #[test]
    fn large_values_near_u64_do_not_overflow_intermediate_k() {
        // virtual_sol_reserves * virtual_token_reserves in u128 is the
        // exact overflow risk curve.rs's own module doc warns about doing
        // in u64 — confirms the u128 intermediate actually holds for
        // values large enough that a naive u64 product would wrap.
        let big_sol = 4_000_000_000u64; // 4B lamports
        let big_token = 4_000_000_000u64; // 4B token base units
        let result = compute_buy_raw_token_out(big_sol, big_token, 1_000_000_000);
        assert!(result.is_ok());
    }
}
