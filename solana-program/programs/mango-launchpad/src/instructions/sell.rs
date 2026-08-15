use crate::constants::*;
use crate::curve;
use crate::errors::MangoLaunchpadError;
use crate::state::{BondingCurve, Global};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer as SplTransfer};

#[derive(Accounts)]
pub struct Sell<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,

    #[account(seeds = [GLOBAL_SEED], bump = global.bump)]
    pub global: Account<'info, Global>,

    #[account(
        mut,
        seeds = [BONDING_CURVE_SEED, bonding_curve.mint.as_ref()],
        bump = bonding_curve.bump,
        has_one = mint,
    )]
    pub bonding_curve: Account<'info, BondingCurve>,

    /// CHECK: address is constrained via bonding_curve.mint in the has_one
    /// check above; only used here to derive/validate token accounts.
    pub mint: UncheckedAccount<'info>,

    #[account(mut, associated_token::mint = mint, associated_token::authority = bonding_curve)]
    pub token_vault: Account<'info, TokenAccount>,

    #[account(mut, associated_token::mint = mint, associated_token::authority = seller)]
    pub seller_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

/// Sells tokens for SOL. Fee is skimmed from the OUTPUT (SOL), matching the
/// EVM hook's real behavior — same fee-on-output pattern as buy.rs, just
/// the other currency. Only ever charges the PRE-graduation rate: once
/// graduated, trading has migrated off this program entirely (see
/// constants.rs's note on SELL_FEE_BPS_POST_GRADUATION), so this handler
/// simply refuses to run rather than attempt to charge a rate that no
/// longer applies to a curve that shouldn't be trading anymore.
pub fn handler(ctx: Context<Sell>, token_in: u64, min_sol_out: u64) -> Result<()> {
    require!(token_in > 0, MangoLaunchpadError::ZeroAmount);

    let bonding_curve = &ctx.accounts.bonding_curve;
    require!(!bonding_curve.graduated, MangoLaunchpadError::AlreadyGraduated);

    let raw_sol_out = curve::compute_sell_raw_sol_out(
        bonding_curve.virtual_sol_reserves,
        bonding_curve.virtual_token_reserves,
        token_in,
    )?;
    require!(
        raw_sol_out <= bonding_curve.real_sol_reserves,
        MangoLaunchpadError::InsufficientReserves
    );

    let (user_sol_out, fee_sol) =
        curve::apply_fee(raw_sol_out, ctx.accounts.global.sell_fee_bps_pre_graduation)?;
    require!(user_sol_out >= min_sol_out, MangoLaunchpadError::SlippageExceeded);

    let (creator_sol_fee, protocol_sol_fee) =
        curve::split_fee(fee_sol, ctx.accounts.global.creator_fee_share_bps)?;

    // 1. Move the seller's tokens into the vault — a plain SPL transfer,
    // signed by the seller (the token owner), no PDA involved on this side.
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            SplTransfer {
                from: ctx.accounts.seller_token_account.to_account_info(),
                to: ctx.accounts.token_vault.to_account_info(),
                authority: ctx.accounts.seller.to_account_info(),
            },
        ),
        token_in,
    )?;

    // 2. Pay the seller their SOL (net of fee) directly out of the
    // bonding_curve PDA's own lamport balance. This is NOT a System
    // Program CPI — System Program's transfer instruction requires the
    // source account to be owned by System Program itself, and
    // bonding_curve is owned by this program (it holds real state data,
    // not just lamports). Programs are allowed to directly debit/credit
    // lamports on accounts THEY own, which is exactly what this is; the
    // total lamports across the transaction still balances, Solana's
    // runtime just doesn't require routing same-program-owned transfers
    // through System Program's CPI.
    //
    // Explicit, checked rent-exemption guard: bonding_curve must keep
    // enough lamports to remain rent-exempt after paying out, or this
    // transaction — and every future instruction touching this account —
    // would fail. real_sol_reserves already tracks exactly what's owed to
    // future sellers/claimants, so this check is a real invariant, not a
    // defensive-but-unreachable one: if it ever trips, real_sol_reserves
    // accounting has drifted from the account's actual balance, which is
    // itself a bug worth surfacing loudly rather than silently underpaying
    // someone later.
    let rent_exempt_minimum = Rent::get()?.minimum_balance(bonding_curve.to_account_info().data_len());
    let bonding_curve_lamports = bonding_curve.to_account_info().lamports();
    require!(
        bonding_curve_lamports
            .checked_sub(user_sol_out)
            .map(|remaining| remaining >= rent_exempt_minimum)
            .unwrap_or(false),
        MangoLaunchpadError::InsufficientReserves
    );

    **ctx.accounts.bonding_curve.to_account_info().try_borrow_mut_lamports()? -= user_sol_out;
    **ctx.accounts.seller.to_account_info().try_borrow_mut_lamports()? += user_sol_out;

    // 3. Update reserve + fee-accrual accounting. Fee SOL stays in the
    // bonding_curve account's own balance for now, earmarked via these
    // accrued counters — see claim_creator_fees.rs / claim_protocol_fees.rs.
    let bonding_curve = &mut ctx.accounts.bonding_curve;
    bonding_curve.virtual_token_reserves = bonding_curve
        .virtual_token_reserves
        .checked_add(token_in)
        .ok_or(MangoLaunchpadError::MathOverflow)?;
    bonding_curve.virtual_sol_reserves = bonding_curve
        .virtual_sol_reserves
        .checked_sub(raw_sol_out)
        .ok_or(MangoLaunchpadError::MathOverflow)?;
    bonding_curve.real_token_reserves = bonding_curve
        .real_token_reserves
        .checked_add(token_in)
        .ok_or(MangoLaunchpadError::MathOverflow)?;
    bonding_curve.real_sol_reserves = bonding_curve
        .real_sol_reserves
        .checked_sub(raw_sol_out)
        .ok_or(MangoLaunchpadError::MathOverflow)?;
    bonding_curve.creator_sol_fees_accrued = bonding_curve
        .creator_sol_fees_accrued
        .checked_add(creator_sol_fee)
        .ok_or(MangoLaunchpadError::MathOverflow)?;
    bonding_curve.protocol_sol_fees_accrued = bonding_curve
        .protocol_sol_fees_accrued
        .checked_add(protocol_sol_fee)
        .ok_or(MangoLaunchpadError::MathOverflow)?;

    Ok(())
}
