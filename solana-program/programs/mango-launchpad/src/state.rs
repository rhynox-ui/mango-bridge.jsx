use anchor_lang::prelude::*;

// ============================================================================
// Global config — one per deployment, seeds = ["global"]. Holds the fee
// schedule and curve defaults as real, changeable state rather than
// hardcoded program constants, so the authority can tune them (or rotate
// the protocol fee wallet) without a program upgrade. Mirrors the EVM
// launchpad's own pattern of reading fee/threshold config from contract
// storage rather than inlining it.
// ============================================================================
#[account]
pub struct Global {
    pub authority: Pubkey,
    pub protocol_fee_wallet: Pubkey,
    pub buy_fee_bps: u16,
    pub sell_fee_bps_pre_graduation: u16,
    pub sell_fee_bps_post_graduation: u16,
    pub creator_fee_share_bps: u16,
    pub protocol_fee_share_bps: u16,
    pub initial_virtual_sol_reserves: u64,
    pub initial_virtual_token_reserves: u64,
    pub initial_real_token_reserves: u64,
    pub token_total_supply: u64,
    pub graduation_real_sol_lamports: u64,
    pub bump: u8,
}

impl Global {
    pub const SIZE: usize = 8 // discriminator
        + 32 // authority
        + 32 // protocol_fee_wallet
        + 2 // buy_fee_bps
        + 2 // sell_fee_bps_pre_graduation
        + 2 // sell_fee_bps_post_graduation
        + 2 // creator_fee_share_bps
        + 2 // protocol_fee_share_bps
        + 8 // initial_virtual_sol_reserves
        + 8 // initial_virtual_token_reserves
        + 8 // initial_real_token_reserves
        + 8 // token_total_supply
        + 8 // graduation_real_sol_lamports
        + 1; // bump
}

// ============================================================================
// Per-token bonding curve — seeds = ["bonding-curve", mint]. This account IS
// the pool: it holds the virtual/real reserve accounting directly (no
// separate AMM), and its own lamport balance beyond rent-exemption is the
// real SOL vault — real_sol_reserves plus whatever creator/protocol SOL
// fees haven't been claimed yet live in this same account's balance. The
// token side is held in a separate token account (see token_vault in
// buy.rs/sell.rs) since SOL and SPL tokens can't share one account.
//
// Fees are accrued here, not paid out instantly on every trade, unlike the
// EVM hook's flash-accounting settlement — see claim_creator_fees.rs and
// claim_protocol_fees.rs for why (Solana's account model means paying an
// arbitrary wallet on every single trade would require that wallet's
// account to be passed into every buy/sell instruction, which doesn't
// scale the same way v4's PoolManager-mediated settlement does).
// ============================================================================
#[account]
pub struct BondingCurve {
    pub mint: Pubkey,
    pub creator: Pubkey,
    pub virtual_sol_reserves: u64,
    pub virtual_token_reserves: u64,
    pub real_sol_reserves: u64,
    pub real_token_reserves: u64,
    pub graduated: bool,
    pub creator_sol_fees_accrued: u64,
    pub creator_token_fees_accrued: u64,
    pub protocol_sol_fees_accrued: u64,
    pub protocol_token_fees_accrued: u64,
    pub bump: u8,
}

impl BondingCurve {
    pub const SIZE: usize = 8 // discriminator
        + 32 // mint
        + 32 // creator
        + 8 // virtual_sol_reserves
        + 8 // virtual_token_reserves
        + 8 // real_sol_reserves
        + 8 // real_token_reserves
        + 1 // graduated
        + 8 // creator_sol_fees_accrued
        + 8 // creator_token_fees_accrued
        + 8 // protocol_sol_fees_accrued
        + 8 // protocol_token_fees_accrued
        + 1; // bump
}
