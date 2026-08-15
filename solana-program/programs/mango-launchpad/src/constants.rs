use anchor_lang::prelude::*;

// ============================================================================
// Fee schedule — deliberately mirrors Mango's existing, real EVM launchpad
// (MangoLaunchHook.sol on Robinhood Chain) fee-for-fee: 1% on every buy,
// 4% on sells before graduation, flat 1% on sells after graduation, split
// 70/30 creator/protocol. See buy.rs / sell.rs for exactly how these are
// applied — on the EVM side the hook skims its fee from the swap's OUTPUT
// (not the input), and this program does the same for consistency with
// the real, already-live design, not just because it's convenient here.
// ============================================================================
pub const BUY_FEE_BPS: u16 = 100; // 1%
pub const SELL_FEE_BPS_PRE_GRADUATION: u16 = 400; // 4%
// Stored in Global for a future migrate instruction to reference when
// configuring the post-graduation venue's fee tier/creator share — NOT
// applied by this program's own buy/sell handlers. Unlike the EVM design
// (one Uniswap v4 pool for the token's whole life, hook just changes its
// sell rate at graduation), this program follows the standard Solana
// launchpad pattern researched: liquidity migrates to a real external AMM
// (Meteora DAMM v2) at graduation, since a synthetic virtual-reserve curve
// has finite real depth and isn't visible to Jupiter/aggregators the way a
// real AMM pool is. Trading after graduation happens on that migrated pool,
// governed by ITS fee mechanics, not a flag this program checks.
pub const SELL_FEE_BPS_POST_GRADUATION: u16 = 100; // 1%
pub const CREATOR_FEE_SHARE_BPS: u16 = 7000; // 70% of the fee amount
pub const PROTOCOL_FEE_SHARE_BPS: u16 = 3000; // 30% of the fee amount
pub const BPS_DENOMINATOR: u64 = 10_000;

// Real address already in production use — src/relaySdkSolanaExecution.js's
// DEV_FEE_WALLET_SOLANA, which the Bridge already sends its own 1% Solana-
// sourced protocol fee to. Reused here deliberately (per explicit
// instruction) rather than standing up a second fee wallet, at least for
// now. NOT hardcoded into program logic as an unchangeable constant, since
// that would mean a program upgrade to ever change it — it's the default
// written into the Global config at initialize-time instead (see
// instructions/initialize.rs), changeable later by the authority the same
// way the EVM protocol's fee recipient can be.
pub const DEFAULT_PROTOCOL_FEE_WALLET: &str = "CFqNwTuTkqkaVoNZmNE6q5TeV6CcNwGRns2NSEY72Fu2";

// ============================================================================
// Bonding-curve defaults. Deliberately in SOL/lamport terms, not USD — the
// EVM launchpad's graduation trigger is cumulative fees crossing a USD
// threshold, which relies on this app's own off-chain USD-per-ETH estimate.
// Doing the same on-chain here would mean either trusting a price oracle
// (a real, separate trust assumption this program doesn't currently take
// on), or reading it off-chain and passing it in (spoofable by whoever
// calls the instruction). Using real_sol_reserves crossing a fixed lamport
// threshold is simpler, fully on-chain, and unspoofable — the tradeoff is
// it doesn't automatically track SOL's USD price the way the EVM side
// tracks ETH's. Worth revisiting once/if a real, trusted on-chain price
// feed is wired up.
// ============================================================================
pub const INITIAL_VIRTUAL_SOL_RESERVES: u64 = 30_000_000_000; // 30 SOL
pub const INITIAL_VIRTUAL_TOKEN_RESERVES: u64 = 1_073_000_000_000_000; // 1,073,000,000 tokens @ 6 decimals
pub const TOKEN_TOTAL_SUPPLY: u64 = 1_000_000_000_000_000; // 1,000,000,000 tokens @ 6 decimals
// Real tokens actually sellable off the curve — the gap versus total supply
// (1,073,000,000 - 1,000,000,000 = 73,000,000) is never minted into
// circulation; it only exists in the virtual-reserve math to shape the
// curve. Same mechanism pump.fun's own published constants use, confirmed
// against their public docs during research.
pub const INITIAL_REAL_TOKEN_RESERVES: u64 = 1_000_000_000_000_000;
// Graduation threshold in lamports of real SOL raised. 85 SOL is pump.fun's
// own long-used default (their real reserves target before the virtual/
// real gap plus this amount produces their documented ~$69k figure at
// typical SOL prices) — used here as a reasonable, real starting default,
// NOT independently re-derived for Mango's specific $30k USD graduation
// target from the EVM side. Needs a real decision, not just inherited by
// default, before this goes anywhere near mainnet.
pub const GRADUATION_REAL_SOL_LAMPORTS: u64 = 85_000_000_000;

pub const GLOBAL_SEED: &[u8] = b"global";
pub const BONDING_CURVE_SEED: &[u8] = b"bonding-curve";
pub const TOKEN_VAULT_SEED: &[u8] = b"token-vault";

pub fn default_protocol_fee_wallet() -> Pubkey {
    DEFAULT_PROTOCOL_FEE_WALLET
        .parse::<Pubkey>()
        .expect("DEFAULT_PROTOCOL_FEE_WALLET is a valid, real, already-deployed Solana address")
}
