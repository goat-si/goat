//! Codex driver adapter point.
//!
//! `goat2-engine-codex` (lane B) owns the Codex app-server driver. Until it exposes a driver
//! API on `goat2`, this factory refuses to start with a clear reason, so runs fail visibly
//! instead of pretending to work. Wire the real driver here and nowhere else.

use async_trait::async_trait;

use super::{EngineError, EngineFactory, EngineHandle, SessionSpec};

#[derive(Debug, Default, Clone)]
pub struct CodexFactory;

#[async_trait]
impl EngineFactory for CodexFactory {
    async fn start(&self, _spec: SessionSpec) -> Result<EngineHandle, EngineError> {
        Err(EngineError::Unavailable(
            "the Codex driver (goat2-engine-codex) is not on goat2 yet".to_owned(),
        ))
    }
}
