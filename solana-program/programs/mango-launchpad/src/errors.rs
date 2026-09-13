use anchor_lang::prelude::*;

#[error_code]
pub enum MangoLaunchpadError {
    #[msg("Bonding curve has already graduated — trade on the migrated AMM pool instead")]
    AlreadyGraduated,
    #[msg("Trade amount must be greater than zero")]
    ZeroAmount,
    #[msg("Slippage exceeded — output amount is below the caller's minimum")]
    SlippageExceeded,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Not enough real reserves to fulfill this trade")]
    InsufficientReserves,
    #[msg("No fees available to claim")]
    NothingToClaim,
    #[msg("Only the token's real, registered creator can claim this")]
    NotCreator,
    #[msg("Protocol fee destination does not match the Global config's configured wallet")]
    WrongProtocolFeeWallet,
    #[msg("Only the Global config's authority can perform this action")]
    NotAuthority,
    #[msg("Fee basis points must not exceed 100%")]
    InvalidFeeBps,
}
