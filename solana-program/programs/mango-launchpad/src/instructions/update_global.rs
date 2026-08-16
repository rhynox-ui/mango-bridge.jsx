use crate::constants::*;
use crate::errors::MangoLaunchpadError;
use crate::state::Global;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct UpdateGlobal<'info> {
    #[account(
        mut,
        seeds = [GLOBAL_SEED],
        bump = global.bump,
        has_one = authority @ MangoLaunchpadError::NotAuthority,
    )]
    pub global: Account<'info, Global>,

    pub authority: Signer<'info>,
}

/// Every field optional so one call can touch just what's changing —
/// unset fields keep their current value. Deliberately scoped to the
/// OPERATIONAL knobs only (fee schedule, protocol wallet, graduation
/// threshold, authority itself): the curve-shape constants
/// (initial_virtual_sol_reserves, initial_virtual_token_reserves,
/// initial_real_token_reserves, token_total_supply) are NOT updatable
/// here. create.rs mints exactly `token_total_supply` into a new token's
/// vault and seeds its real_token_reserves from
/// `initial_real_token_reserves` — those two MUST stay equal or newly
/// created tokens would have vault tokens that are neither sellable nor
/// claimable as fees, a real, silent accounting bug. Bundling that
/// invariant into a generic "update whatever" instruction is exactly the
/// kind of thing this project's own discipline says not to do without a
/// deliberate, separate decision — so for now, changing curve shape
/// means a new instruction (or a program upgrade), not this one.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct UpdateGlobalParams {
    pub new_authority: Option<Pubkey>,
    pub new_protocol_fee_wallet: Option<Pubkey>,
    pub new_buy_fee_bps: Option<u16>,
    pub new_sell_fee_bps_pre_graduation: Option<u16>,
    pub new_sell_fee_bps_post_graduation: Option<u16>,
    /// Setting this also derives and overwrites protocol_fee_share_bps as
    /// BPS_DENOMINATOR - new_creator_fee_share_bps, keeping them in sync.
    /// split_fee() in curve.rs only ever reads creator_fee_share_bps and
    /// computes the protocol's share as the remainder by subtraction —
    /// protocol_fee_share_bps is a stored mirror for off-chain/UI
    /// consumption, not itself load-bearing for the split math. Letting
    /// the two drift out of sync would make that stored field lie about
    /// the real split, so this instruction is the one place that's
    /// prevented from happening.
    pub new_creator_fee_share_bps: Option<u16>,
    pub new_graduation_real_sol_lamports: Option<u64>,
}

pub fn handler(ctx: Context<UpdateGlobal>, params: UpdateGlobalParams) -> Result<()> {
    let global = &mut ctx.accounts.global;

    if let Some(new_authority) = params.new_authority {
        global.authority = new_authority;
    }
    if let Some(new_protocol_fee_wallet) = params.new_protocol_fee_wallet {
        global.protocol_fee_wallet = new_protocol_fee_wallet;
    }
    if let Some(new_buy_fee_bps) = params.new_buy_fee_bps {
        require!(new_buy_fee_bps <= BPS_DENOMINATOR as u16, MangoLaunchpadError::InvalidFeeBps);
        global.buy_fee_bps = new_buy_fee_bps;
    }
    if let Some(new_sell_fee_bps_pre_graduation) = params.new_sell_fee_bps_pre_graduation {
        require!(
            new_sell_fee_bps_pre_graduation <= BPS_DENOMINATOR as u16,
            MangoLaunchpadError::InvalidFeeBps
        );
        global.sell_fee_bps_pre_graduation = new_sell_fee_bps_pre_graduation;
    }
    if let Some(new_sell_fee_bps_post_graduation) = params.new_sell_fee_bps_post_graduation {
        require!(
            new_sell_fee_bps_post_graduation <= BPS_DENOMINATOR as u16,
            MangoLaunchpadError::InvalidFeeBps
        );
        global.sell_fee_bps_post_graduation = new_sell_fee_bps_post_graduation;
    }
    if let Some(new_creator_fee_share_bps) = params.new_creator_fee_share_bps {
        require!(
            new_creator_fee_share_bps <= BPS_DENOMINATOR as u16,
            MangoLaunchpadError::InvalidFeeBps
        );
        global.creator_fee_share_bps = new_creator_fee_share_bps;
        global.protocol_fee_share_bps = BPS_DENOMINATOR as u16 - new_creator_fee_share_bps;
    }
    if let Some(new_graduation_real_sol_lamports) = params.new_graduation_real_sol_lamports {
        require!(new_graduation_real_sol_lamports > 0, MangoLaunchpadError::ZeroAmount);
        global.graduation_real_sol_lamports = new_graduation_real_sol_lamports;
    }

    Ok(())
}
