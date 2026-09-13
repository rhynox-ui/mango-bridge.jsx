use crate::constants::*;
use crate::errors::MangoLaunchpadError;
use crate::state::BondingCurve;
use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Token, TokenAccount, Transfer as SplTransfer};

#[derive(Accounts)]
pub struct ClaimCreatorFees<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    #[account(
        mut,
        seeds = [BONDING_CURVE_SEED, bonding_curve.mint.as_ref()],
        bump = bonding_curve.bump,
        has_one = mint,
        constraint = bonding_curve.creator == creator.key() @ MangoLaunchpadError::NotCreator,
    )]
    pub bonding_curve: Account<'info, BondingCurve>,

    /// CHECK: constrained via bonding_curve.mint's has_one check above.
    pub mint: UncheckedAccount<'info>,

    #[account(mut, associated_token::mint = mint, associated_token::authority = bonding_curve)]
    pub token_vault: Account<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = creator,
        associated_token::mint = mint,
        associated_token::authority = creator,
    )]
    pub creator_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Pays out everything the real, on-chain registered creator has accrued
/// across every buy/sell against this specific token — both the SOL side
/// (from sells) and the token side (from buys), in one call. This is the
/// closest real equivalent to the EVM hook's instant per-trade payout that
/// Solana's account model allows; see buy.rs/sell.rs for why accrual +
/// claim, not instant payout, is the honest tradeoff here.
pub fn handler(ctx: Context<ClaimCreatorFees>) -> Result<()> {
    let sol_amount = ctx.accounts.bonding_curve.creator_sol_fees_accrued;
    let token_amount = ctx.accounts.bonding_curve.creator_token_fees_accrued;
    require!(sol_amount > 0 || token_amount > 0, MangoLaunchpadError::NothingToClaim);

    let bonding_curve_ai = ctx.accounts.bonding_curve.to_account_info();

    if sol_amount > 0 {
        let rent_exempt_minimum = Rent::get()?.minimum_balance(bonding_curve_ai.data_len());
        let bonding_curve_lamports = bonding_curve_ai.lamports();
        require!(
            bonding_curve_lamports
                .checked_sub(sol_amount)
                .map(|remaining| remaining >= rent_exempt_minimum)
                .unwrap_or(false),
            MangoLaunchpadError::InsufficientReserves
        );
        **bonding_curve_ai.try_borrow_mut_lamports()? -= sol_amount;
        **ctx.accounts.creator.to_account_info().try_borrow_mut_lamports()? += sol_amount;
    }

    if token_amount > 0 {
        let mint_key = ctx.accounts.mint.key();
        let bump = ctx.accounts.bonding_curve.bump;
        let signer_seeds: &[&[&[u8]]] = &[&[BONDING_CURVE_SEED, mint_key.as_ref(), &[bump]]];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                SplTransfer {
                    from: ctx.accounts.token_vault.to_account_info(),
                    to: ctx.accounts.creator_token_account.to_account_info(),
                    authority: bonding_curve_ai.clone(),
                },
                signer_seeds,
            ),
            token_amount,
        )?;
    }

    let bonding_curve = &mut ctx.accounts.bonding_curve;
    bonding_curve.creator_sol_fees_accrued = 0;
    bonding_curve.creator_token_fees_accrued = 0;

    Ok(())
}
