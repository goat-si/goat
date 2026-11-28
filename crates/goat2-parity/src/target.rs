//! Synchronous external runner boundary.
use crate::{scenario::LoadedScenario, trace::ObservedTrace};
use std::{
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};

#[derive(Debug, thiserror::Error)]
#[error("{message}\nstderr: {stderr}")]
pub struct TargetError {
    pub message: String,
    pub stderr: String,
}
pub trait Target {
    fn name(&self) -> &str;
    fn run(&mut self, scenario: &LoadedScenario) -> Result<TargetRun, TargetError>;
}
#[derive(Debug)]
pub struct TargetRun {
    pub trace: ObservedTrace,
    pub stderr: String,
}
#[derive(Debug)]
pub struct ProcessTarget {
    pub name: String,
    pub program: PathBuf,
    pub args: Vec<String>,
}
static NEXT: AtomicU64 = AtomicU64::new(0);
impl Target for ProcessTarget {
    fn name(&self) -> &str {
        &self.name
    }
    fn run(&mut self, scenario: &LoadedScenario) -> Result<TargetRun, TargetError> {
        let dir = std::env::temp_dir().join(format!(
            "goat2-parity-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&dir).map_err(|e| TargetError {
            message: e.to_string(),
            stderr: String::new(),
        })?;
        let out = dir.join("observed.json");
        let result = self.execute(&scenario.dir, &out);
        let _ = std::fs::remove_dir_all(&dir);
        result
    }
}
impl ProcessTarget {
    fn execute(&self, scenario: &Path, out: &Path) -> Result<TargetRun, TargetError> {
        let output = Command::new(&self.program)
            .args(&self.args)
            .arg("--scenario")
            .arg(scenario)
            .arg("--out")
            .arg(out)
            .output()
            .map_err(|e| TargetError {
                message: e.to_string(),
                stderr: String::new(),
            })?;
        let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
        if !output.status.success() {
            return Err(TargetError {
                message: format!("runner exited {}", output.status),
                stderr,
            });
        }
        let bytes = std::fs::read(out).map_err(|e| TargetError {
            message: format!("missing output: {e}"),
            stderr: stderr.clone(),
        })?;
        let trace: ObservedTrace = serde_json::from_slice(&bytes).map_err(|e| TargetError {
            message: format!("invalid output: {e}"),
            stderr: stderr.clone(),
        })?;
        if trace.v != 1 {
            return Err(TargetError {
                message: "invalid output version".into(),
                stderr,
            });
        }
        if trace.target != self.name {
            return Err(TargetError {
                message: format!(
                    "runner reported target {:?}, invoked as {:?}",
                    trace.target, self.name
                ),
                stderr,
            });
        }
        Ok(TargetRun { trace, stderr })
    }
}
