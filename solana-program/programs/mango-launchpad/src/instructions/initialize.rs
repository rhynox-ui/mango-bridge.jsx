use crate::constants::*;
use crate::state::Global;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = Global::SIZE,
        seeds = [GLOBAL_SEED],
        bump,
    )]
    pub global: Account<'info, Global>,

    pub system_program: Program<'info, System>,
}

/// One-time setup — creates the Global config PDA with real defaults, not
/// placeholders left to be filled in later. `authority` becomes whoever
/// signs this (should be a real, deliberately-chosen multisig or admin key
/// before this ever touches mainnet, not a throwaway wallet).
pub fn handler(ctx: Context<Initialize>) -> Result<()> {
    let global = &mut ctx.accounts.global;

    global.authority = ctx.accounts.authority.key();
    global.protocol_fee_wallet = default_protocol_fee_wallet();
    global.buy_fee_bps = BUY_FEE_BPS;
    global.sell_fee_bps_pre_graduation = SELL_FEE_BPS_PRE_GRADUATION;
    global.sell_fee_bps_post_graduation = SELL_FEE_BPS_POST_GRADUATION;
    global.creator_fee_share_bps = CREATOR_FEE_SHARE_BPS;
    global.protocol_fee_share_bps = PROTOCOL_FEE_SHARE_BPS;
    global.initial_virtual_sol_reserves = INITIAL_VIRTUAL_SOL_RESERVES;
    global.initial_virtual_token_reserves = INITIAL_VIRTUAL_TOKEN_RESERVES;
    global.initial_real_token_reserves = INITIAL_REAL_TOKEN_RESERVES;
    global.token_total_supply = TOKEN_TOTAL_SUPPLY;
    global.graduation_real_sol_lamports = GRADUATION_REAL_SOL_LAMPORTS;
    global.bump = ctx.bumps.global;

    Ok(())
}
