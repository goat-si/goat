//! ACP registry pieces ported from GOAT v1 at 916b5ccc1b2: the index and its cache, settings and
//! contracts, managed installs (npm, uv, binary archives), command resolution and the catalog the
//! host factory uses ([catalog::AcpRegistryCatalog::launch]). [RegistryAgentFlavor] carries every
//! per-agent hook v1 `packages/provider-acp-registry/src/server/adapter.ts` sets (see [agents]).

pub mod agents;
pub mod archive;
pub mod catalog;
pub mod command_path;
pub mod contracts;
pub mod coordinator;
pub mod environment;
pub mod index;
pub mod install;
pub mod local_presets;
pub mod package;
pub mod runtime_temp;
pub mod schema;
pub mod settings;

#[cfg(all(test, unix))]
mod catalog_tests;

pub use catalog::{AcpRegistryCatalog, CatalogOptions, HostContext, RegistryLaunch};
pub use install::{ArchiveDownload, HttpsDownload, RegistryError};
pub use settings::RegistrySettings;

use goat2_contracts::{EngineDriver, ModelSelection, ProviderCapabilities};
use goat2_engine_api::{EngineError, SessionSpec};
use serde_json::{Map, Value};

use crate::capabilities::acp_base_capabilities;
use crate::flavor::{
    AcpFlavor, AgentEnv, AuthPolicy, FlavorEvent, LaunchCommand, ModelWrite, NativeElicitationForm,
    PromptError, PromptOutcomeCheck, SubagentSessionEvent, SubagentUpdate, model_write_with_custom,
};
use crate::items::ToolState;
use crate::wire::SessionSetup;
use agents::AgentKind;
use agents::copilot::CopilotRouting;
use agents::kimi::KimiOutcomeWatch;

/// A registry or local ACP agent, launched with a command the registry owner resolved.
///
/// Build it with [RegistryAgentFlavor::new]; the per-agent state (Copilot attribution, Kimi log
/// cursors) is v1's per-adapter state (`adapter.ts:243,270`).
#[derive(Debug)]
pub struct RegistryAgentFlavor {
    pub agent_id: String,
    pub command: LaunchCommand,
    /// Local commands are identified by their executable name in v1.
    pub local: bool,
    /// v1 settings `authMethodId` (`adapter.ts:185`): the method to sign in with on -32000.
    auth_method_id: Option<String>,
    /// v1 settings `customModels` slugs (`adapter.ts:186-188,281`).
    custom_models: Vec<String>,
    copilot: CopilotRouting,
    kimi: KimiOutcomeWatch,
}

impl RegistryAgentFlavor {
    pub fn new(agent_id: impl Into<String>, command: LaunchCommand, local: bool) -> Self {
        Self {
            agent_id: agent_id.into(),
            command,
            local,
            auth_method_id: None,
            custom_models: Vec::new(),
            copilot: CopilotRouting::default(),
            kimi: KimiOutcomeWatch::default(),
        }
    }

    /// v1 settings `authMethodId`; blank means the first agent-managed method.
    pub fn with_auth_method_id(mut self, method_id: Option<String>) -> Self {
        self.auth_method_id = method_id
            .map(|id| id.trim().to_owned())
            .filter(|id| !id.is_empty());
        self
    }

    /// v1 settings `customModels`: model ids written without checking the agent's list.
    pub fn with_custom_models(mut self, models: Vec<String>) -> Self {
        self.custom_models = models;
        self
    }

    /// v1 `adapter.ts:213-267`.
    pub fn kind(&self) -> AgentKind {
        agents::agent_kind(
            &self.agent_id,
            &self.command.program.to_string_lossy(),
            self.local,
        )
    }

    fn is_devin(&self) -> bool {
        self.kind() == AgentKind::Devin
    }

    fn is_copilot(&self) -> bool {
        self.kind() == AgentKind::Copilot
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
        let mut command = self.command.clone();
        // v1 sessionEnvironmentKey.ts:13-22: claude-agent-acp runs its v2 protocol unless told not to.
        // A command with its complete environment says alone whether the variable is set.
        let name = agents::claude::CLAUDE_AGENT_ACP_EXPERIMENTAL_V2;
        let complete = command
            .env_remove
            .iter()
            .any(|n| n == crate::process::REMOVE_INHERITED);
        if self.kind() == AgentKind::Claude
            && !command.env.iter().any(|(n, _)| n == name)
            && (complete || std::env::var_os(name).is_none())
        {
            command.env.push((name.to_owned(), "1".to_owned()));
        }
        Ok(command)
    }
    fn auth_policy(&self) -> AuthPolicy {
        AuthPolicy::OnRequired {
            method_id: self.auth_method_id.clone(),
        }
    }
    fn prefers_http_mcp(&self) -> bool {
        agents::prefers_http_mcp_transport(
            self.local,
            &self.command.program.to_string_lossy(),
            &self.command.args,
        )
    }
    fn normalize_update(&self, params: Value) -> Value {
        match self.kind() {
            AgentKind::Devin => agents::normalize_devin_session_update(params),
            AgentKind::Copilot => self.copilot.normalize_session_update(params),
            _ => params,
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
        // v1 adapter.ts:347-348,6002: Copilot's reported default may not be its active model
        // (github/copilot-cli#5363), so the model is always written.
        if !self.is_copilot() || matches!(selection.model.trim(), "" | "default") {
            return model_write_with_custom(selection, setup, &self.custom_models);
        }
        let mut setup = setup.clone();
        for option in &mut setup.config_options {
            if let Some(object) = option.as_object_mut() {
                object.remove("currentValue");
            }
        }
        model_write_with_custom(selection, &setup, &self.custom_models)
    }
    fn capabilities(&self) -> ProviderCapabilities {
        let mut caps = acp_base_capabilities();
        // v1 adapter.ts:274-280: cancelling a Copilot prompt also kills its background agents.
        if self.is_copilot() {
            caps.turns.supports_steering_by_interrupt_restart = false;
        }
        caps
    }
    fn client_capabilities_meta(&self) -> Option<Map<String, Value>> {
        match self.kind() {
            AgentKind::Devin => Some(agents::devin::devin_client_capabilities_meta()),
            AgentKind::Copilot => Some(agents::copilot::copilot_client_capabilities_meta()),
            _ => None,
        }
    }
    fn normalize_tool_call(&self, tool: ToolState) -> ToolState {
        if self.is_devin() {
            agents::devin::normalize_devin_tool_call(tool)
        } else {
            tool
        }
    }
    fn extract_subagent(&self, tool: &ToolState) -> Option<SubagentUpdate> {
        match self.kind() {
            AgentKind::Devin => agents::devin::extract_devin_subagent(tool),
            AgentKind::Copilot => agents::copilot::extract_copilot_subagent(tool),
            AgentKind::Claude => agents::claude::extract_claude_subagent(tool),
            _ => None,
        }
    }
    fn follows_agent_work_state(&self) -> bool {
        self.kind() == AgentKind::Claude
    }
    fn is_provisional_subagent_tool(&self, tool: &ToolState) -> bool {
        self.kind() == AgentKind::Claude
            && agents::claude::is_claude_provisional_subagent_tool(tool)
    }
    fn extract_subagent_session_event(&self, params: &Value) -> Option<SubagentSessionEvent> {
        if self.kind() == AgentKind::Claude {
            agents::claude::extract_claude_subagent_session_event(params)
        } else {
            None
        }
    }
    fn extract_elicitation_form(&self, params: &Value) -> Option<NativeElicitationForm> {
        // v1 adapter.ts:299-305.
        match self.kind() {
            AgentKind::Droid => agents::droid::extract_droid_elicitation_form(params),
            AgentKind::Omp => agents::omp::extract_omp_elicitation_form(params),
            AgentKind::OpenCode => agents::opencode::extract_opencode_elicitation_form(params),
            _ => None,
        }
    }
    fn restart_after_prompt_error(&self, error: &PromptError) -> bool {
        self.is_copilot() && agents::copilot::is_copilot_lost_session_error(error)
    }
    fn watch_prompt_outcome(
        &self,
        session_id: &str,
        env: &AgentEnv,
    ) -> Option<Box<dyn PromptOutcomeCheck>> {
        if self.kind() == AgentKind::Kimi {
            self.kimi.watch(session_id, env)
        } else {
            None
        }
    }
    fn ext_notification(&self, method: &str, params: &Value) -> Vec<FlavorEvent> {
        match (self.kind(), method) {
            (AgentKind::Copilot, agents::copilot::COPILOT_SESSION_EVENT) => {
                self.copilot.on_session_event(params)
            }
            (AgentKind::Vibe, agents::vibe::MISTRAL_VIBE_RETRYING) => {
                agents::vibe::mistral_vibe_retry_notice(params)
            }
            _ => Vec::new(),
        }
    }
    fn release_runtime(&self, session_id: &str) {
        if self.is_copilot() {
            self.copilot.release(session_id);
        }
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
        let flavor = |agent: &str, path: &str, local: bool| {
            RegistryAgentFlavor::new(agent, LaunchCommand::new(path, Vec::<String>::new()), local)
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
        let mut f = RegistryAgentFlavor::new(
            "github-copilot-cli",
            LaunchCommand::new("some-command", [] as [&str; 0]),
            false,
        );
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
