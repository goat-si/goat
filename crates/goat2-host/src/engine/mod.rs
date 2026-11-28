//! Engines as the host sees them: the seam from `goat2-engine-api`, the Codex adapter point and
//! the scripted fake engine.
//!
//! Until `goat2-engine-codex` (lane B) implements the seam, [codex::CodexFactory] reports the
//! engine as unavailable instead of pretending to run. [fake::FakeEngine] is a scripted engine
//! for tests and for UI work without Codex (`GOAT2_ENGINE=fake`).

pub mod codex;
pub mod fake;

pub use goat2_engine_api::*;
