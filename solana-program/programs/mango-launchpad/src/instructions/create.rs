use crate::constants::*;
use crate::state::{BondingCurve, Global};
use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, MintTo, SetAuthority, Token, TokenAccount};
use anchor_spl::token::spl_token::instruction::AuthorityType;

#[derive(Accounts)]
pub struct CreateLaunch<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    #[account(seeds = [GLOBAL_SEED], bump = global.bump)]
    pub global: Account<'info, Global>,

    // The BondingCurve PDA is BOTH this token's real SOL vault (its own
    // lamport balance beyond rent-exemption) AND the mint/freeze authority
    // — a program-controlled PDA, never a real wallet, so nobody (not even
    // Mango) can mint extra supply or freeze holders after launch.
    #[account(
        init,
        payer = creator,
        space = BondingCurve::SIZE,
        seeds = [BONDING_CURVE_SEED, mint.key().as_ref()],
        bump,
    )]
    pub bonding_curve: Account<'info, BondingCurve>,

    #[account(
        init,
        payer = creator,
        mint::decimals = 6,
        mint::authority = bonding_curve,
        mint::freeze_authority = bonding_curve,
    )]
    pub mint: Account<'info, Mint>,

    // Holds the token side of the curve's real reserves — every token not
    // yet bought, plus any accrued-but-unclaimed creator/protocol token
    // fees from buys. Owned by the bonding_curve PDA, so only this
    // program's instructions (signing with the PDA's seeds) can move
    // tokens out of it.
    #[account(
        init,
        payer = creator,
        associated_token::mint = mint,
        associated_token::authority = bonding_curve,
    )]
    pub token_vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

/// Mints the token's entire real supply once, seeds the bonding curve's
/// starting reserves from Global's configured defaults, and permanently
/// revokes both mint and freeze authority — no further supply can ever be
/// created and no holder can ever be frozen, matching the EVM launchpad's
/// MangoLaunchToken.sol (fixed 1B supply, no owner-only functions).
pub fn handler(ctx: Context<CreateLaunch>) -> Result<()> {
    let global = &ctx.accounts.global;
    let mint_key = ctx.accounts.mint.key();
    let bump = ctx.bumps.bonding_curve;
    let signer_seeds: &[&[&[u8]]] = &[&[BONDING_CURVE_SEED, mint_key.as_ref(), &[bump]]];

    // Mint the real, total, final supply directly into the vault this
    // program controls — nothing pre-allocated to the creator or to Mango
    // itself off the curve, matching the EVM design where the Factory
    // seeds the ENTIRE supply into the pool at launch.
    token::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.token_vault.to_account_info(),
                authority: ctx.accounts.bonding_curve.to_account_info(),
            },
            signer_seeds,
        ),
        global.token_total_supply,
    )?;

    // Revoke mint authority permanently.
    token::set_authority(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            SetAuthority {
                current_authority: ctx.accounts.bonding_curve.to_account_info(),
                account_or_mint: ctx.accounts.mint.to_account_info(),
            },
            signer_seeds,
        ),
        AuthorityType::MintTokens,
        None,
    )?;

    // Revoke freeze authority permanently.
    token::set_authority(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            SetAuthority {
                current_authority: ctx.accounts.bonding_curve.to_account_info(),
                account_or_mint: ctx.accounts.mint.to_account_info(),
            },
            signer_seeds,
        ),
        AuthorityType::FreezeAccount,
        None,
    )?;

    let bonding_curve = &mut ctx.accounts.bonding_curve;
    bonding_curve.mint = mint_key;
    bonding_curve.creator = ctx.accounts.creator.key();
    bonding_curve.virtual_sol_reserves = global.initial_virtual_sol_reserves;
    bonding_curve.virtual_token_reserves = global.initial_virtual_token_reserves;
    bonding_curve.real_sol_reserves = 0;
    bonding_curve.real_token_reserves = global.initial_real_token_reserves;
    bonding_curve.graduated = false;
    bonding_curve.creator_sol_fees_accrued = 0;
    bonding_curve.creator_token_fees_accrued = 0;
    bonding_curve.protocol_sol_fees_accrued = 0;
    bonding_curve.protocol_token_fees_accrued = 0;
    bonding_curve.bump = bump;

    Ok(())
}
