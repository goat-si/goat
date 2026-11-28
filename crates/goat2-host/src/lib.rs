//! GOAT 2 engine host (`goat2-host`).
//!
//! One process that ties the thread store, the engine drivers and the contracts together:
//! a mailbox and lane per thread, global caps, follow-up modes, child wake, restart settlement,
//! the agent MCP surface and the WebSocket API the UI uses. See `README.md` in this crate,
//! `docs/lanes/PART1.md` and `structure/`.

pub mod api;
pub mod bot;
pub mod config;
pub mod core;
pub mod engine;
pub mod mcp;
pub mod server;
pub mod stall;
pub mod store;
pub mod util;
pub mod ws;
