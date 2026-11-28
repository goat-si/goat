//! Codex app-server driver for the GOAT 2 host. One `codex app-server` process per thread.
//!
//! Wire types are hand-written for the subset GOAT uses and checked against the pinned schema in
//! `schema/codex-0.167.0/` (see `PROVENANCE.md`). Unknown notifications and fields are skipped;
//! unknown server requests get JSON-RPC error -32601 so Codex never waits for an answer.

pub mod approvals;
pub mod attachments;
pub mod auth;
pub mod capabilities;
pub mod contract;
pub mod engine;
pub mod home_layout;
pub mod items;
pub mod probe;
pub mod process;
pub mod protocol;
pub mod runtime;
pub mod transcript;
pub mod transport;

pub use engine::{CodexEngineFactory, CodexEngineOptions, CodexSession};

/// The codex version whose schema is pinned in `schema/`.
pub const CODEX_SCHEMA_VERSION: &str = "0.167.0";
