//! Scenario loading and validation.
pub use crate::scenario::LoadedScenario;

pub fn load(dir: &std::path::Path) -> Result<LoadedScenario, String> {
    LoadedScenario::load(dir)
}
