//! Engines as the host sees them: the seam from `goat2-engine-api`, the Codex driver wiring and
//! the scripted fake engine.
//!
//! [codex::codex_factory] builds lane B's `goat2-engine-codex` driver with the host's
//! attachment lookup. [fake::FakeEngine] is a scripted engine for tests and for UI work without
//! Codex (`GOAT2_ENGINE=fake`).

pub mod claude;
pub mod codex;
pub mod fake;

pub use goat2_engine_api::*;
