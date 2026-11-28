//! Wire and disk contracts shared by the GOAT 2 host and the TypeScript UI.
//!
//! Every type here derives serde, [ts_rs::TS] and [schemars::JsonSchema]. The generated
//! TypeScript and JSON Schema live in `packages/contracts-rs/` and are checked for drift by
//! `cargo test -p goat2-contracts` (set `GOAT2_CONTRACTS_BLESS=1` to rewrite them).
//!
//! Design source: goat-si/goat2-design `prd-src/part1/{model,storage,runtime}.md`.
//! Behaviour reference: goat-si/goat dev `packages/contracts/src/orchestrationV2.ts` and
//! `providerCapabilityParts.ts` (see `PROVENANCE.md` in this crate).

pub mod attention;
pub mod bot;
pub mod capabilities;
pub mod card;
pub mod codegen;
pub mod decision;
pub mod ids;
pub mod limits;
pub mod log;
pub mod model;
pub mod probe;
pub mod serde_util;
pub mod subscribe;
pub mod text;
pub mod turn_item;

pub use attention::*;
pub use bot::*;
pub use capabilities::*;
pub use card::*;
pub use decision::*;
pub use ids::*;
pub use log::*;
pub use model::*;
pub use probe::*;
pub use subscribe::*;
pub use turn_item::*;
