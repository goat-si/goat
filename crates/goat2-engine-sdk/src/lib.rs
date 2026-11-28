//! Engine drivers for GOAT v1 providers that only work through a Node SDK or a JSONL RPC mode.
//!
//! - [helper]: Cursor (`@cursor/sdk`), OpenCode (`@opencode-ai/sdk/v2`) and Muse
//!   (`@muse-code/sdk`) run inside `apps/engine-helper`, one Node process per thread, spoken to
//!   over one stdio JSONL shape (`apps/engine-helper/PROTOCOL.md`).
//! - Pi and OmO (`--mode rpc`) are driven from Rust directly: v1 `provider-pi/src/server/rpc.ts` is
//!   plain LF-delimited JSON request/response plus events, so a Node hop would add nothing.
//!
//! One engine process (and its process group) per thread: a crash ends only that thread's run.

pub mod capabilities;
pub mod helper;
mod jsonl;
pub mod pi;
pub mod process;

pub use helper::{HelperEngine, HelperFactory, HelperLaunch};
pub use pi::{PiFactory, PiProfile};
