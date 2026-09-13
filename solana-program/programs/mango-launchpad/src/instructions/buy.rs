use crate::constants::*;
use crate::curve;
use crate::errors::MangoLaunchpadError;
use crate::state::{BondingCurve, Global};
use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Token, TokenAccount, Transfer as SplTransfer};

#[derive(Accounts)]
pub struct Buy<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

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

    #[account(
        init_if_needed,
        payer = buyer,
        associated_token::mint = mint,
        associated_token::authority = buyer,
    )]
    pub buyer_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Buys tokens with SOL. Fee is skimmed from the OUTPUT (tokens), not the
/// input — matching the EVM hook's real, verified behavior, not a
/// simplification made for convenience here. `min_token_out` is this
/// program's slippage guard, filling the same role sqrtPriceLimitX96 +
/// minAmountOut serve together on the EVM side; there's no separate
/// price-limit concept here since there's no tick/sqrtPrice representation
/// to bound — the constant-product formula only has one output for a given
/// input, so a plain minimum-output check is the complete guard.
pub fn handler(ctx: Context<Buy>, sol_in: u64, min_token_out: u64) -> Result<()> {
    require!(sol_in > 0, MangoLaunchpadError::ZeroAmount);

    let bonding_curve = &ctx.accounts.bonding_curve;
    require!(!bonding_curve.graduated, MangoLaunchpadError::AlreadyGraduated);

    let raw_token_out = curve::compute_buy_raw_token_out(
        bonding_curve.virtual_sol_reserves,
        bonding_curve.virtual_token_reserves,
        sol_in,
    )?;
    require!(
        raw_token_out <= bonding_curve.real_token_reserves,
        MangoLaunchpadError::InsufficientReserves
    );

    let (user_token_out, fee_tokens) = curve::apply_fee(raw_token_out, ctx.accounts.global.buy_fee_bps)?;
    require!(user_token_out >= min_token_out, MangoLaunchpadError::SlippageExceeded);

    let (creator_token_fee, protocol_token_fee) =
        curve::split_fee(fee_tokens, ctx.accounts.global.creator_fee_share_bps)?;

    // 1. Move the buyer's SOL into the curve's vault (the bonding_curve
    // PDA's own lamport balance) via a real system transfer, signed by the
    // buyer.
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            Transfer {
                from: ctx.accounts.buyer.to_account_info(),
                to: ctx.accounts.bonding_curve.to_account_info(),
            },
        ),
        sol_in,
    )?;

    // 2. Send the buyer their tokens (net of fee) from the token vault,
    // signed by the bonding_curve PDA.
    let mint_key = ctx.accounts.mint.key();
    let bump = ctx.accounts.bonding_curve.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[BONDING_CURVE_SEED, mint_key.as_ref(), &[bump]]];

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            SplTransfer {
                from: ctx.accounts.token_vault.to_account_info(),
                to: ctx.accounts.buyer_token_account.to_account_info(),
                authority: ctx.accounts.bonding_curve.to_account_info(),
            },
            signer_seeds,
        ),
        user_token_out,
    )?;

    // 3. Update reserve + fee-accrual accounting. The fee tokens (creator's
    // + protocol's share) stay in token_vault for now — they're still real
    // tokens the vault holds, just earmarked as claimable rather than part
    // of the tradeable curve, tracked via these accrued counters rather
    // than moved anywhere yet. See claim_creator_fees.rs / claim_protocol_
    // fees.rs for how they're actually paid out.
    let bonding_curve = &mut ctx.accounts.bonding_curve;
    bonding_curve.virtual_sol_reserves = bonding_curve
        .virtual_sol_reserves
        .checked_add(sol_in)
        .ok_or(MangoLaunchpadError::MathOverflow)?;
    bonding_curve.virtual_token_reserves = bonding_curve
        .virtual_token_reserves
        .checked_sub(raw_token_out)
        .ok_or(MangoLaunchpadError::MathOverflow)?;
    bonding_curve.real_sol_reserves = bonding_curve
        .real_sol_reserves
        .checked_add(sol_in)
        .ok_or(MangoLaunchpadError::MathOverflow)?;
    bonding_curve.real_token_reserves = bonding_curve
        .real_token_reserves
        .checked_sub(raw_token_out)
        .ok_or(MangoLaunchpadError::MathOverflow)?;
    bonding_curve.creator_token_fees_accrued = bonding_curve
        .creator_token_fees_accrued
        .checked_add(creator_token_fee)
        .ok_or(MangoLaunchpadError::MathOverflow)?;
    bonding_curve.protocol_token_fees_accrued = bonding_curve
        .protocol_token_fees_accrued
        .checked_add(protocol_token_fee)
        .ok_or(MangoLaunchpadError::MathOverflow)?;

    if bonding_curve.real_sol_reserves >= ctx.accounts.global.graduation_real_sol_lamports {
        bonding_curve.graduated = true;
    }

    Ok(())
}
