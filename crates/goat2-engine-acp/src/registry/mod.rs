//! ACP registry pieces ported from GOAT v1 at 916b5ccc1b2.
//!
//! Installation, discovery and agent-specific protocol handling are not yet implemented.

pub mod agents;
pub mod index;
pub mod resolve;

use goat2_contracts::{EngineDriver, ModelSelection, ProviderCapabilities};
use goat2_engine_api::{EngineError, SessionSpec};
use serde_json::Value;

use crate::capabilities::acp_base_capabilities;
use crate::flavor::{AcpFlavor, LaunchCommand, ModelWrite, default_model_write};
use crate::wire::SessionSetup;

/// A command resolved by the registry owner; this type does not install or discover it.
#[derive(Debug, Clone)]
pub struct RegistryAgentFlavor {
    pub agent_id: String,
    pub command: LaunchCommand,
    /// Local commands are identified by their executable name in v1.
    pub local: bool,
}

impl RegistryAgentFlavor {
    // v1 adapter.ts:232-237: local Devin accepts .exe, but not .cmd.
    fn is_devin(&self) -> bool {
        if !self.local {
            return self.agent_id == "devin";
        }
        let name = self.command.program.to_string_lossy();
        matches!(
            name.rsplit(['/', '\\'])
                .next()
                .unwrap_or("")
                .to_ascii_lowercase()
                .as_str(),
            "devin" | "devin.exe"
        )
    }
    // v1 adapter.ts:213-215,234-238: local agents have no registry ID for matching.
    fn is_copilot(&self) -> bool {
        if !self.local {
            return self.agent_id == "github-copilot-cli";
        }
        let program = self.command.program.to_string_lossy();
        let name = program
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or("")
            .to_ascii_lowercase();
        matches!(name.as_str(), "copilot" | "copilot.exe" | "copilot.cmd")
    }
}

impl AcpFlavor for RegistryAgentFlavor {
    fn driver(&self) -> &str {
        "acpRegistry"
    }
    fn engine_driver(&self) -> EngineDriver {
        EngineDriver::AcpRegistry {
            agent_id: self.agent_id.clone(),
        }
    }
    fn launch(&self, _spec: &SessionSpec) -> Result<LaunchCommand, EngineError> {
        Ok(self.command.clone())
    }
    fn normalize_update(&self, params: Value) -> Value {
        if self.is_devin() {
            agents::normalize_devin_session_update(params)
        } else {
            params
        }
    }
    fn answerable_permission_options(&self, options: Vec<Value>) -> Vec<Value> {
        if self.is_devin() {
            agents::devin_answerable_permission_options(&options)
        } else {
            options
        }
    }
    fn model_write(&self, selection: &ModelSelection, setup: &SessionSetup) -> ModelWrite {
        // v1 adapter.ts:359-361,6002: Copilot's reported default may not be its active model.
        if !self.is_copilot() || matches!(selection.model.trim(), "" | "default") {
            return default_model_write(selection, setup);
        }
        let mut setup = setup.clone();
        for option in &mut setup.config_options {
            if let Some(object) = option.as_object_mut() {
                object.remove("currentValue");
            }
        }
        default_model_write(selection, &setup)
    }
    fn capabilities(&self) -> ProviderCapabilities {
        let mut caps = acp_base_capabilities();
        // v1 adapter.ts:275-282: cancellation kills Copilot's background agents.
        if self.is_copilot() {
            caps.turns.supports_steering_by_interrupt_restart = false;
        }
        caps
    }
}

/// v1 localPresets.ts:1-6,13-17. Returns launch details only.
pub fn local_preset(id: &str) -> Option<LaunchCommand> {
    match id {
        "omp" => Some(LaunchCommand::new(
            "omp",
            ["acp", "--approval-mode", "always-ask"],
        )),
        "minimax-code" => Some(LaunchCommand::new("mcode", ["acp"])),
        _ => None,
    }
}

/// v1 registryPlatformTarget.ts:9-23. Inputs use Node platform and architecture names.
pub fn platform_target(platform: &str, architecture: &str) -> Option<&'static str> {
    match (platform, architecture) {
        ("darwin", "arm64") => Some("darwin-aarch64"),
        ("darwin", "x64") => Some("darwin-x86_64"),
        ("linux", "arm64") => Some("linux-aarch64"),
        ("linux", "x64") => Some("linux-x86_64"),
        ("win32", "arm64") => Some("windows-aarch64"),
        ("win32", "x64") => Some("windows-x86_64"),
        _ => None,
    }
}

/// v1 registryPlatformTarget.ts:25-33: Windows ARM can emulate x86_64.
pub fn platform_candidates(target: Option<&str>) -> Vec<&str> {
    match target {
        Some("windows-aarch64") => vec!["windows-aarch64", "windows-x86_64"],
        Some(target) => vec![target],
        None => vec![],
    }
}

/// v1 registryPackageCommand.ts:4-25: ordered, deduplicated safe command names.
pub fn package_command_candidates(agent_id: &str, package_name: &str) -> Vec<String> {
    let unscoped = package_name.rsplit('/').next().unwrap_or(package_name);
    let mut candidates = Vec::new();
    for candidate in [
        agent_id,
        unscoped,
        unscoped.strip_suffix("-acp").unwrap_or(unscoped),
    ] {
        let mut bytes = candidate.bytes();
        let valid = candidate.len() <= 128
            && bytes.next().is_some_and(|c| c.is_ascii_alphanumeric())
            && bytes.all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c));
        if valid && !candidates.iter().any(|s| s == candidate) {
            candidates.push(candidate.to_owned());
        }
    }
    candidates
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn local_and_registry_agent_matching_matches_v1() {
        let flavor = |agent: &str, path: &str, local: bool| RegistryAgentFlavor {
            agent_id: agent.into(),
            command: LaunchCommand::new(path, Vec::<String>::new()),
            local,
        };
        assert!(flavor("devin", "other", false).is_devin());
        assert!(flavor("", r"C:\\bin\\DEVIN.EXE", true).is_devin());
        assert!(!flavor("devin", "devin.cmd", true).is_devin());
        assert!(flavor("", "/bin/COPILOT.cmd", true).is_copilot());
        assert!(!flavor("github-copilot-cli", "other", true).is_copilot());
    }
    #[test]
    fn platforms_and_fallback() {
        for os in ["darwin", "linux", "win32"] {
            for arch in ["arm64", "x64"] {
                assert!(platform_target(os, arch).is_some());
            }
        }
        assert_eq!(platform_target("freebsd", "x64"), None);
        assert_eq!(
            platform_candidates(platform_target("win32", "arm64")),
            ["windows-aarch64", "windows-x86_64"]
        );
        assert!(platform_candidates(None).is_empty());
    }
    #[test]
    fn presets_and_candidates() {
        let omp = local_preset("omp").unwrap();
        assert_eq!(omp.program.to_str(), Some("omp"));
        assert_eq!(omp.args, ["acp", "--approval-mode", "always-ask"]);
        assert_eq!(local_preset("minimax-code").unwrap().args, ["acp"]);
        assert!(local_preset("other").is_none());
        assert_eq!(
            package_command_candidates("foo", "@scope/foo-acp"),
            ["foo", "foo-acp"]
        );
        assert!(package_command_candidates("../bad", "@s/!bad").is_empty());
    }
    #[test]
    fn copilot_only_disables_restart_steering() {
        let mut f = RegistryAgentFlavor {
            agent_id: "github-copilot-cli".into(),
            command: LaunchCommand::new("some-command", [] as [&str; 0]),
            local: false,
        };
        assert!(
            !f.capabilities()
                .turns
                .supports_steering_by_interrupt_restart
        );
        f.local = true;
        assert!(
            f.capabilities()
                .turns
                .supports_steering_by_interrupt_restart
        );
        f.command = LaunchCommand::new("C:\\bin\\COPILOT.CMD", [] as [&str; 0]);
        assert!(
            !f.capabilities()
                .turns
                .supports_steering_by_interrupt_restart
        );
        assert_eq!(f.driver(), "acpRegistry");
    }
}
