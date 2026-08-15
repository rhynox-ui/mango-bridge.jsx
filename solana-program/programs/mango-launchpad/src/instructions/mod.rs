pub mod buy;
pub mod claim_creator_fees;
pub mod claim_protocol_fees;
pub mod create;
pub mod initialize;
pub mod sell;
pub mod update_global;

// Glob re-export IS required here, even though every instruction file
// names its entry point `handler` — Anchor's #[derive(Accounts)] macro
// generates hidden `__client_accounts_*` / `__cpi_client_*` items
// alongside each Accounts struct that the #[program] macro in lib.rs
// expects to reach via exactly this glob-export chain (confirmed: without
// it, `#[program]` fails with an "unresolved import `crate`" error, not
// something worth hand-waving past). The `handler` name collision this
// would otherwise create is avoided in lib.rs instead — it imports only
// the named Accounts structs it needs (Buy, Sell, ...), not `instructions
// ::*`, and calls each handler through its fully qualified module path
// (instructions::buy::handler(...), etc), so the colliding `handler`
// names never actually need to coexist unqualified in the same scope.
pub use buy::*;
pub use claim_creator_fees::*;
pub use claim_protocol_fees::*;
pub use create::*;
pub use initialize::*;
pub use sell::*;
pub use update_global::*;
