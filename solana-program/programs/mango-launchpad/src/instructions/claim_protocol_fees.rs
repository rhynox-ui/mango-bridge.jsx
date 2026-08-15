use crate::constants::*;
use crate::errors::MangoLaunchpadError;
use crate::state::{BondingCurve, Global};
use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Token, TokenAccount, Transfer as SplTransfer};

#[derive(Accounts)]
pub struct ClaimProtocolFees<'info> {
    // Deliberately NOT required to be any particular signer — this is
    // permissionless, the same way pump.fun's graduation `migrate` call is
    // permissionless. Safe because the destination is hard-constrained to
    // Global's configured protocol_fee_wallet below; whoever pays the
    // transaction fee (and any new ATA rent) gets nothing extra for
    // calling it, but nothing is redirectable either.
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(seeds = [GLOBAL_SEED], bump = global.bump)]
    pub global: Account<'info, Global>,

    #[account(
        mut,
        seeds = [BONDING_CURVE_SEED, bonding_curve.mint.as_ref()],
        bump = bonding_curve.bump,
        has_one = mint,
    )]
    pub bonding_curve: Account<'info, BondingCurve>,

    /// CHECK: constrained via bonding_curve.mint's has_one check above.
    pub mint: UncheckedAccount<'info>,

    #[account(mut, associated_token::mint = mint, associated_token::authority = bonding_curve)]
    pub token_vault: Account<'info, TokenAccount>,

    /// CHECK: must exactly match Global's configured protocol fee wallet —
    /// enforced by the constraint below, not just trusted from whatever's
    /// passed in. This is the same real address (src/relaySdkSolanaExecution
    /// .js's DEV_FEE_WALLET_SOLANA) the Bridge already sends its own SOL
    /// protocol fee to.
    #[account(mut, constraint = protocol_fee_wallet.key() == global.protocol_fee_wallet @ MangoLaunchpadError::WrongProtocolFeeWallet)]
    pub protocol_fee_wallet: UncheckedAccount<'info>,

    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = mint,
        associated_token::authority = protocol_fee_wallet,
    )]
    pub protocol_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Sweeps everything accrued to the protocol's share into the real,
/// configured protocol fee wallet — SOL from sells, tokens from buys, same
/// pairing as claim_creator_fees.rs. See that file's ClaimCreatorFees
/// accounts struct for why this is accrue-then-claim rather than an
/// instant per-trade payout.
pub fn handler(ctx: Context<ClaimProtocolFees>) -> Result<()> {
    let sol_amount = ctx.accounts.bonding_curve.protocol_sol_fees_accrued;
    let token_amount = ctx.accounts.bonding_curve.protocol_token_fees_accrued;
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
        **ctx.accounts.protocol_fee_wallet.to_account_info().try_borrow_mut_lamports()? += sol_amount;
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
                    to: ctx.accounts.protocol_token_account.to_account_info(),
                    authority: bonding_curve_ai.clone(),
                },
                signer_seeds,
            ),
            token_amount,
        )?;
    }

    let bonding_curve = &mut ctx.accounts.bonding_curve;
    bonding_curve.protocol_sol_fees_accrued = 0;
    bonding_curve.protocol_token_fees_accrued = 0;

    Ok(())
}
