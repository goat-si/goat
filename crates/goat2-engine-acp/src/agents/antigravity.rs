//! Antigravity: Google's `agy` CLI (`agy acp`) or the managed `agy_acp_server` with its harness.
//!
//! v1 at 916b5ccc1b2:
//! - `apps/server/src/orchestration-v2/Adapters/AntigravityAdapterV2.ts:67-84` (capabilities),
//!   `:227-359` (the flavor: resume, prompt steering, model selection, session mode, permission
//!   disposition, client file reads, approval options, permission questions, elicitation forms,
//!   image prompts, sign-in errors), `:156-217` (read repair and `update_steps` plans per runtime).
//! - `apps/server/src/provider/acp/AntigravityAcpSupport.ts:66-145` (versions, `run_workflow`,
//!   `systemPrompt.append`), `:147-187` (runtime options: eager auth with the configured method,
//!   resume, client capabilities, stdout/stderr sign-in handling, update normalization),
//!   `:189-263` (permission and session modes), `:265-354` (model selection).
//! - `apps/server/src/provider/Drivers/AntigravityDriver.ts:397-461` (the `agy` CLI maps
//!   permission modes onto its session modes; the harness takes them as they are).
//! - `apps/server/src/provider/antigravityAuthSupport.ts` (see [super::antigravity_auth]).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};

use goat2_contracts::{
    EngineDriver, ModelSelection, ProviderCapabilities, ProviderOptionSelectionValue, RuntimeMode,
    UserInputQuestion,
};
use goat2_engine_api::{EngineError, SessionSpec};
use regex::Regex;
use serde_json::{Map, Value, json};

use super::antigravity_auth::{
    self, ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE, AntigravityAuthConfig, AntigravityProfile,
    REMOVED_ENVIRONMENT_KEYS,
};
use super::{antigravity_files, antigravity_prompt, antigravity_protocol, antigravity_subagent};
use crate::{
    capabilities::acp_base_capabilities,
    flavor::{
        AcpFlavor, AuthFailure, AuthPolicy, ClientCaps, ClientRead, ConfigWrite, ExtRequest,
        FlavorEvent, LaunchCommand, ModeContext, ModeWrite, ModelWrite, PromptAttachment,
        ResumeMethod, StderrLine, StdoutLine, SubagentToolUpdate, runtime_set_mode,
    },
    items::ToolState,
    policy::{Disposition, RuntimePolicy},
    wire::{InitializeInfo, ModeState, SessionSetup, config_option_id, select_values},
};

/// v1 `ANTIGRAVITY_DEFAULT_MODEL` (contracts model.ts:136): the account default.
pub const ANTIGRAVITY_DEFAULT_MODEL: &str = "antigravity-default";
/// v1 `ACP_SESSION_MODE_OPTION_ID`: a picked session mode, written apart from config options.
const ACP_SESSION_MODE_OPTION_ID: &str = "_t3/session-mode";
/// v1 `PROMPT_STEERING_RELEASE` (AntigravityAcpSupport.ts:102-103): 1.5.0 steers with the next
/// prompt; the 1.4 harness queues it.
const PROMPT_STEERING_RELEASE: (u64, u64, u64) = (1, 5, 0);
/// v1 `OPEN_MODEL_ACCESS_RELEASE` (:100-101): 1.5.1 offers every model to every ACP client.
pub const OPEN_MODEL_ACCESS_RELEASE: (u64, u64, u64) = (1, 5, 1);

static VERSION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:v|agy_acp_server_)?(\d+)\.(\d+)\.(\d+)").expect("version pattern")
});

/// v1 `parseAntigravityVersion` (AntigravityAcpSupport.ts:66-69).
pub fn parse_version(version: Option<&str>) -> Option<(u64, u64, u64)> {
    let captures = VERSION.captures(version?.trim())?;
    Some((
        captures[1].parse().ok()?,
        captures[2].parse().ok()?,
        captures[3].parse().ok()?,
    ))
}

/// v1 `antigravityServesGoat` (:112-116): a runtime that reported its version serves GOAT.
pub fn serves_goat(version: &str) -> bool {
    parse_version(Some(version)).is_none_or(|v| v >= OPEN_MODEL_ACCESS_RELEASE)
}

/// v1 `antigravityWritesRunWorkflowSkill` (:79-90): 1.4.2 through 1.4.5 overwrite
/// `skills/system/run-workflow/SKILL.md` unless `run_workflow` is disabled.
fn writes_run_workflow_skill(version: Option<&str>) -> bool {
    parse_version(version).is_some_and(|v| ((1, 4, 2)..=(1, 4, 5)).contains(&v))
}

/// v1 `antigravityAppendsSystemPrompt` (:118-130).
fn appends_system_prompt(init: &InitializeInfo) -> bool {
    antigravity_prompt::is_qualified_release(init.agent_version.as_deref())
        || init
            .capabilities_meta
            .as_ref()
            .and_then(|m| m.pointer("/antigravity/systemPrompt/append"))
            .and_then(Value::as_bool)
            == Some(true)
}

/// v1 `antigravityPermissionMode` (:189-200).
pub fn permission_mode(mode: RuntimeMode) -> &'static str {
    match mode {
        RuntimeMode::FullAccess => "yolo",
        RuntimeMode::AutoAcceptEdits => "auto_edit",
        RuntimeMode::Auto => "auto",
        RuntimeMode::ApprovalRequired => "default",
    }
}

/// v1 `antigravitySessionMode` (:202-211): the `agy` CLI has `default` and maybe `auto`.
pub fn cli_session_mode(mode_id: &str, modes: Option<&ModeState>) -> String {
    match mode_id {
        "auto" if modes.is_some_and(|m| m.has("auto")) => "auto".into(),
        "auto" | "yolo" | "auto_edit" => "default".into(),
        other => other.into(),
    }
}

/// v1 `antigravityRuntimeModeForSessionMode` (:250-263).
pub fn runtime_mode_for_session_mode(mode_id: &str) -> Option<RuntimeMode> {
    match mode_id {
        "yolo" => Some(RuntimeMode::FullAccess),
        "auto_edit" => Some(RuntimeMode::AutoAcceptEdits),
        "auto" => Some(RuntimeMode::Auto),
        "default" => Some(RuntimeMode::ApprovalRequired),
        _ => None,
    }
}

/// The installed runtime (v1 `AntigravityInstallation` `executablePath`, `harnessPath`, `version`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AntigravityInstallation {
    pub executable_path: PathBuf,
    /// The managed harness beside `agy_acp_server`; None for the `agy` CLI.
    pub harness_path: Option<PathBuf>,
    /// Known before `initialize`; it picks the file reader.
    pub version: Option<String>,
    /// Installed and updated by GOAT (v1 `source: "managed"`), or the person's own executable.
    pub managed: bool,
}

/// How GOAT starts the runtime for one instance.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AntigravityLaunch {
    pub installation: AntigravityInstallation,
    pub profile: AntigravityProfile,
    /// v1 `runtimeTempDirectory`: GOAT-owned temp beside the profile.
    pub runtime_temp_directory: Option<PathBuf>,
    /// The inherited environment; None reads the host's.
    pub base_env: Option<HashMap<String, String>>,
}

/// Per-session state v1 keeps per runtime (AntigravityAdapterV2.ts:168-172).
#[derive(Debug, Default)]
struct SessionRepairs {
    reads: antigravity_protocol::ReadRepair,
    plans: antigravity_protocol::UpdateStepsPlans,
}

/// The read repair and `update_steps` plans of each open session.
#[derive(Debug, Default)]
pub struct AntigravitySessions(Mutex<HashMap<String, SessionRepairs>>);

#[derive(Debug, Default)]
pub struct Antigravity {
    pub auth: AntigravityAuthConfig,
    /// None starts `agy_acp_server` from PATH with no profile (the host normally resolves one).
    pub launch: Option<AntigravityLaunch>,
    /// v1 `defaultModel`: what "default" selects when the session offers it.
    pub default_model: Option<String>,
    /// GOAT's attachments folder, readable through `fs/read_text_file` with the thread's folder.
    pub attachments_dir: Option<PathBuf>,
    pub sessions: AntigravitySessions,
}

impl Antigravity {
    fn is_cli(&self) -> bool {
        self.launch
            .as_ref()
            .is_some_and(|l| l.installation.harness_path.is_none())
    }

    fn runtime_version(&self) -> Option<&str> {
        self.launch
            .as_ref()
            .and_then(|l| l.installation.version.as_deref())
    }

    fn with_session<T>(&self, session_id: &str, f: impl FnOnce(&mut SessionRepairs) -> T) -> T {
        let mut sessions = self.sessions.0.lock().expect("antigravity sessions");
        f(sessions.entry(session_id.to_owned()).or_default())
    }
}

fn model_option(config_options: &[Value]) -> Option<&Value> {
    config_options.iter().find(|option| {
        config_option_id(option) == Some("model")
            && option.get("type").and_then(Value::as_str) == Some("select")
    })
}

/// v1 `legacyAntigravityFamily` (:281-293): runtime 1.4 lists `gemini-3.8-flash` where 1.3 listed
/// `gemini-3.8-flash-high`, and still takes the old id.
fn legacy_family(config_options: &[Value], model: &str) -> Option<String> {
    let option = model_option(config_options)?;
    select_values(option)
        .into_iter()
        .map(|(value, _)| value)
        .filter(|family| model.starts_with(&format!("{family}-")))
        .max_by_key(String::len)
}

/// v1 the `configureSession` option loop (adapter.ts:6037-6113) for options the selection carries:
/// written when the live session offers the option and lists the value. Mode options and picked
/// session modes stay with the runtime mode.
pub(crate) fn selection_option_writes(
    selection: &ModelSelection,
    config_options: &[Value],
    owned: &[&str],
) -> Vec<ConfigWrite> {
    selection
        .options
        .iter()
        .flatten()
        .filter(|option| {
            option.id != ACP_SESSION_MODE_OPTION_ID && !owned.contains(&option.id.as_str())
        })
        .filter(|option| {
            !config_options.iter().any(|live| {
                config_option_id(live) == Some(option.id.as_str())
                    && live.get("category").and_then(Value::as_str) == Some("mode")
            })
        })
        .map(|option| ConfigWrite {
            config_id: option.id.clone(),
            value: match &option.value {
                ProviderOptionSelectionValue::Text(text) => Value::String(text.clone()),
                ProviderOptionSelectionValue::Flag(flag) => Value::Bool(*flag),
            },
            allow_unlisted: false,
            resend_current: false,
            optional: true,
        })
        .collect()
}

impl AcpFlavor for Antigravity {
    fn driver(&self) -> &str {
        "antigravity"
    }
    fn engine_driver(&self) -> EngineDriver {
        EngineDriver::Antigravity
    }
    fn capabilities(&self) -> ProviderCapabilities {
        let mut c = acp_base_capabilities();
        c.sessions.supports_model_switch_in_session = true;
        c.sessions.supports_runtime_mode_switch_in_session = true;
        c.tools.supports_mcp_tools = true;
        c.subagents.supports_subagents = true;
        c
    }
    /// v1 `buildAntigravityAcpSpawnInput` (antigravityAuthSupport.ts:513-554) with the credential
    /// source of the configured method; a configuration the method cannot use refuses to start
    /// (v1 `antigravityAuthConfigIssue`, AntigravityDriver.ts:666-672).
    fn launch(&self, _: &SessionSpec) -> Result<LaunchCommand, EngineError> {
        if let Some(issue) = self.auth.issue() {
            return Err(EngineError::Unavailable(issue.to_owned()));
        }
        let Some(launch) = &self.launch else {
            let mut command = LaunchCommand::new(
                if cfg!(windows) {
                    "agy_acp_server.exe"
                } else {
                    "agy_acp_server"
                },
                Vec::<String>::new(),
            );
            command.env_remove = REMOVED_ENVIRONMENT_KEYS.map(str::to_owned).to_vec();
            match self.auth.auth_method {
                antigravity_auth::AntigravityAuthMethod::GeminiApiKey => {
                    command = command.env("GEMINI_API_KEY", self.auth.api_key.clone());
                }
                antigravity_auth::AntigravityAuthMethod::AgentPlatform
                    if !self.auth.api_key.is_empty() =>
                {
                    command = command.env("GOOGLE_API_KEY", self.auth.api_key.clone());
                }
                _ => {}
            }
            return Ok(command);
        };
        let base_env = launch
            .base_env
            .clone()
            .unwrap_or_else(|| std::env::vars().collect());
        let environment = antigravity_auth::antigravity_environment(
            &launch.profile,
            &base_env,
            &self.auth,
            launch.runtime_temp_directory.as_deref(),
        );
        let mut command = LaunchCommand::new(
            launch.installation.executable_path.clone(),
            antigravity_auth::spawn_args(
                launch.installation.harness_path.as_deref(),
                &launch.profile,
            ),
        );
        command.env = environment.set;
        if let Some(harness) = &launch.installation.harness_path {
            command = command.env("ANTIGRAVITY_HARNESS_PATH", harness.display().to_string());
        }
        command.env_remove = environment.remove;
        Ok(command)
    }
    /// v1 `clientCapabilities` (AntigravityAcpSupport.ts:164-172): reads unless the runtime is the
    /// qualified release; never writes (advertising writes swaps diff edits for whole files).
    fn client_capabilities(&self) -> ClientCaps {
        ClientCaps {
            read_text_file: !antigravity_prompt::is_qualified_release(self.runtime_version()),
            write_text_file: false,
            terminal: false,
        }
    }
    /// v1 `runtimeIncompatibility` (AntigravityDriver.ts:346-371, 408-427): a resolved runtime
    /// older than 1.5.1 only serves allowlisted editors. The compatibility advisory of the
    /// installer is not carried.
    fn initialize_refusal(&self, init: &InitializeInfo) -> Option<String> {
        let installation = &self.launch.as_ref()?.installation;
        let version = init.agent_version.as_deref()?;
        if serves_goat(version) {
            return None;
        }
        let action = if installation.managed {
            "Update it in Antigravity setup".to_owned()
        } else {
            format!(
                "Update the Antigravity executable at {}",
                installation.executable_path.display()
            )
        };
        let (major, minor, patch) = OPEN_MODEL_ACCESS_RELEASE;
        Some(format!(
            "Antigravity {version} only serves allowlisted editors, not GOAT. {action} to {major}.{minor}.{patch} or newer, then retry."
        ))
    }
    fn auth_policy(&self) -> AuthPolicy {
        AuthPolicy::Eager {
            method_id: self.auth.auth_method.id().to_owned(),
        }
    }
    fn auth_failure(&self, code: i32, message: &str) -> AuthFailure {
        if antigravity_auth::is_sign_in_required(code, message) {
            AuthFailure::SignIn(ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE.to_owned())
        } else {
            AuthFailure::Plain
        }
    }
    /// v1 `preferResumeSession`: loading history replays tool calls.
    fn resume_method(&self) -> Option<ResumeMethod> {
        Some(ResumeMethod::Resume)
    }
    /// v1 `antigravitySessionMeta` (:132-145).
    fn session_meta(
        &self,
        init: &InitializeInfo,
        instructions: Option<&str>,
    ) -> Option<Map<String, Value>> {
        let mut antigravity = Map::new();
        if writes_run_workflow_skill(init.agent_version.as_deref()) {
            antigravity.insert("disabledTools".into(), json!(["run_workflow"]));
        }
        if let Some(append) = instructions
            && appends_system_prompt(init)
        {
            antigravity.insert("systemPrompt".into(), json!({ "append": append }));
        }
        let mut meta = Map::new();
        (!antigravity.is_empty()).then(|| {
            meta.insert("antigravity".into(), Value::Object(antigravity));
            meta
        })
    }
    fn instructions_in_session_meta(&self, init: &InitializeInfo) -> bool {
        appends_system_prompt(init)
    }
    /// v1 `antigravitySteersWithPrompt` (:105-110).
    fn steers_with_prompt(&self, init: &InitializeInfo) -> bool {
        parse_version(init.agent_version.as_deref()).is_some_and(|v| v >= PROMPT_STEERING_RELEASE)
    }
    /// v1 `transformSessionUpdate` then the adapter's read repair and `update_steps` plans
    /// (AntigravityAdapterV2.ts:199-205), then the native command fields.
    fn normalize_update(&self, params: Value) -> Value {
        let params = antigravity_protocol::normalize_session_update(params);
        let session = params
            .get("sessionId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let repaired = self.with_session(&session, |s| {
            let params = s.reads.repair(params);
            s.plans.apply(params)
        });
        match repaired {
            Some(params) => antigravity_protocol::normalize_tool_command(params),
            // Dropped: an update_steps call without steps.
            None => json!({}),
        }
    }
    fn stdout_line(&self, line: &str) -> StdoutLine {
        antigravity_auth::stdout_line(line)
    }
    /// v1 `extractSubagentUpdate` (AntigravityAdapterV2.ts:117-141, 314).
    fn subagent_update(&self, tool: &ToolState) -> Option<SubagentToolUpdate> {
        antigravity_subagent::subagent_update(tool)
    }
    fn stderr_line(&self, line: &str) -> StderrLine {
        antigravity_auth::stderr_line(line)
    }
    fn permission_disposition(&self, policy: &RuntimePolicy, request: &Value) -> Disposition {
        antigravity_protocol::permission_disposition(policy, request)
    }
    fn permission_request_action(&self, request: &Value) -> Option<ExtRequest> {
        antigravity_protocol::permission_question(request)
    }
    fn approval_options(&self, request: &Value) -> Vec<goat2_contracts::ApprovalOption> {
        antigravity_protocol::approval_options(request)
    }
    fn elicitation_questions(
        &self,
        request: &Value,
        questions: Vec<UserInputQuestion>,
    ) -> Vec<UserInputQuestion> {
        antigravity_protocol::elicitation_questions(request, questions)
    }
    /// v1 `sessionModeForPolicy` = `antigravityPermissionMode`; the `agy` CLI maps it onto its own
    /// modes (AntigravityDriver.ts:441-450).
    fn session_mode_for(&self, mode: RuntimeMode, modes: Option<&ModeState>) -> Option<String> {
        let permission = permission_mode(mode);
        Some(if self.is_cli() {
            cli_session_mode(permission, modes)
        } else {
            permission.to_owned()
        })
    }
    /// v1 `runtime.setMode(policyMode)` (adapter.ts:6114-6116).
    fn mode_write(&self, mode: RuntimeMode, context: &ModeContext<'_>) -> ModeWrite {
        match self.session_mode_for(mode, context.modes) {
            Some(mode_id) => runtime_set_mode(&mode_id, context),
            None => ModeWrite::Keep,
        }
    }
    /// v1 `applyAntigravityAcpModelSelection` (:311-354) and the option loop: an explicit model is
    /// written even over a cold resume's default; "default" picks the configured default when the
    /// session offers it; an old family id is passed through unlisted; then the options that
    /// depend on the model (thinking level), against the options the model write returned.
    fn model_write(&self, selection: &ModelSelection, setup: &SessionSetup) -> ModelWrite {
        let options = &setup.config_options;
        let model = selection.model.trim();
        let explicit =
            !model.is_empty() && model != ANTIGRAVITY_DEFAULT_MODEL && model != "default";
        let option = model_option(options);
        let current = option
            .and_then(|o| o.get("currentValue"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        let listed =
            |value: &str| option.is_some_and(|o| select_values(o).iter().any(|(v, _)| v == value));
        let resolved = if explicit {
            Some(model.to_owned())
        } else {
            match &self.default_model {
                Some(default) if listed(default) || legacy_family(options, default).is_some() => {
                    Some(default.clone())
                }
                _ => current.clone(),
            }
        };
        let mut writes = Vec::new();
        if let Some(resolved) = resolved
            && (explicit || Some(&resolved) != current.as_ref())
        {
            if !listed(&resolved) && legacy_family(options, &resolved).is_some() {
                writes.push(ConfigWrite::new("model", resolved).allow_unlisted());
            } else if !listed(&resolved) {
                return ModelWrite::Unavailable {
                    message: format!(
                        "Antigravity model '{resolved}' is unavailable for this Google account. Select an available model."
                    ),
                };
            } else {
                writes.push(ConfigWrite::new("model", resolved));
            }
        }
        writes.extend(selection_option_writes(selection, options, &[]));
        if writes.is_empty() {
            ModelWrite::Keep
        } else {
            ModelWrite::ConfigOptions(writes)
        }
    }
    fn supports_image_prompts(&self, _init: &InitializeInfo) -> bool {
        true
    }
    /// v1 `clientFileSystem.readTextFile` (AntigravityAdapterV2.ts:154-155, 176-196, 294-302): the
    /// thread's folder and the attachments folder; a served read completes its tool call.
    fn read_text_file(&self, request: &Value, cwd: Option<&str>) -> Option<ClientRead> {
        let roots: Vec<PathBuf> = cwd
            .map(PathBuf::from)
            .into_iter()
            .chain(self.attachments_dir.clone())
            .collect();
        let response = antigravity_files::read_client_text_file(&roots, request);
        let session = request
            .get("sessionId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let path = request
            .get("path")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let served = self.with_session(&session, |s| s.reads.attempted(path, response.is_ok()));
        let events = served
            .map(|tool_call_id| {
                FlavorEvent::SessionUpdate(json!({
                    "sessionId": session,
                    "update": {"sessionUpdate": "tool_call_update", "toolCallId": tool_call_id, "status": "completed"}
                }))
            })
            .into_iter()
            .collect();
        Some(ClientRead { response, events })
    }
    fn prompt_sent(&self, session_id: &str) {
        self.with_session(session_id, |s| s.reads.reset());
    }
    fn prompt_attachment_blocks(
        &self,
        init: &InitializeInfo,
        config_options: &[Value],
        attachments: &[PromptAttachment<'_>],
    ) -> Option<Result<Vec<Value>, String>> {
        let current = model_option(config_options).and_then(|option| {
            let id = option.get("currentValue")?.as_str()?;
            let name = select_values(option)
                .into_iter()
                .find(|(value, _)| value == id)
                .map(|(_, name)| name);
            Some((id.to_owned(), name))
        });
        Some(antigravity_prompt::attachment_blocks(
            init,
            current
                .as_ref()
                .map(|(id, name)| (id.as_str(), name.as_deref())),
            attachments,
            cfg!(windows),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use goat2_contracts::ProviderOptionSelection;

    fn setup() -> SessionSetup {
        SessionSetup {
            config_options: vec![
                json!({"id":"model", "type":"select", "category":"model", "currentValue":"gemini-3.8-flash", "options":[{"value":"gemini-3.8-flash", "name":"Flash"}, {"value":"gemini-3.8-pro", "name":"Pro"}]}),
                json!({"id":"thought_level", "type":"select", "category":"thought_level", "currentValue":"high", "options":[{"value":"low"}, {"value":"high"}]}),
            ],
            ..Default::default()
        }
    }

    fn selection(model: &str) -> ModelSelection {
        ModelSelection {
            instance_id: "agy".into(),
            model: model.into(),
            options: None,
        }
    }

    #[test]
    fn model_selection_writes_listed_legacy_and_dependent_options() {
        let a = Antigravity::default();
        assert_eq!(
            a.model_write(&selection("gemini-3.8-pro"), &setup()),
            ModelWrite::ConfigOptions(vec![ConfigWrite::new("model", "gemini-3.8-pro")])
        );
        assert_eq!(
            a.model_write(&selection("gemini-3.8-flash-high"), &setup()),
            ModelWrite::ConfigOptions(vec![
                ConfigWrite::new("model", "gemini-3.8-flash-high").allow_unlisted()
            ])
        );
        assert!(matches!(
            a.model_write(&selection("claude-x"), &setup()),
            ModelWrite::Unavailable { message } if message == "Antigravity model 'claude-x' is unavailable for this Google account. Select an available model."
        ));
        assert_eq!(
            a.model_write(&selection(ANTIGRAVITY_DEFAULT_MODEL), &setup()),
            ModelWrite::Keep
        );
        let with_default = Antigravity {
            default_model: Some("gemini-3.8-pro".into()),
            ..Default::default()
        };
        assert_eq!(
            with_default.model_write(&selection("default"), &setup()),
            ModelWrite::ConfigOptions(vec![ConfigWrite::new("model", "gemini-3.8-pro")])
        );
        let mut thinking = selection("gemini-3.8-pro");
        thinking.options = Some(vec![ProviderOptionSelection {
            id: "thought_level".into(),
            value: ProviderOptionSelectionValue::Text("low".into()),
        }]);
        assert_eq!(
            a.model_write(&thinking, &setup()),
            ModelWrite::ConfigOptions(vec![
                ConfigWrite::new("model", "gemini-3.8-pro"),
                ConfigWrite::new("thought_level", "low").optional()
            ])
        );
    }

    #[test]
    fn harness_takes_permission_modes_and_the_cli_its_own() {
        let modes = ModeState {
            current_mode_id: "default".into(),
            available: vec![("default".into(), "Default".into())],
        };
        let harness = Antigravity::default();
        assert_eq!(
            harness
                .session_mode_for(RuntimeMode::FullAccess, Some(&modes))
                .as_deref(),
            Some("yolo")
        );
        let cli = Antigravity {
            launch: Some(AntigravityLaunch {
                installation: AntigravityInstallation {
                    executable_path: "agy".into(),
                    harness_path: None,
                    version: Some("1.5.1".into()),
                    managed: false,
                },
                profile: AntigravityProfile::new(std::path::Path::new("/p"), String::new()),
                runtime_temp_directory: None,
                base_env: Some(HashMap::new()),
            }),
            ..Default::default()
        };
        for mode in [
            RuntimeMode::FullAccess,
            RuntimeMode::AutoAcceptEdits,
            RuntimeMode::Auto,
        ] {
            assert_eq!(
                cli.session_mode_for(mode, Some(&modes)).as_deref(),
                Some("default")
            );
        }
        assert_eq!(
            runtime_mode_for_session_mode("auto_edit"),
            Some(RuntimeMode::AutoAcceptEdits)
        );
        let config = [
            json!({"id":"mode", "category":"mode", "type":"select", "currentValue":"default", "options":[{"value":"default"},{"value":"yolo"}]}),
        ];
        let context = ModeContext {
            modes: Some(&modes),
            config_options: &config,
            first_write: true,
        };
        assert_eq!(
            harness.mode_write(RuntimeMode::FullAccess, &context),
            ModeWrite::Config(ConfigWrite::new("mode", "yolo"))
        );
        assert_eq!(
            harness.mode_write(RuntimeMode::ApprovalRequired, &context),
            ModeWrite::Keep
        );
    }

    #[test]
    fn versions_and_metadata() {
        assert_eq!(parse_version(Some("agy_acp_server_1.4.3")), Some((1, 4, 3)));
        assert_eq!(parse_version(Some("v1.5.0-rc1")), Some((1, 5, 0)));
        assert_eq!(parse_version(Some("dev")), None);
        assert!(serves_goat("dev") && serves_goat("1.5.1") && !serves_goat("1.5.0"));
        let old = InitializeInfo {
            agent_version: Some("1.4.3".into()),
            ..Default::default()
        };
        assert_eq!(
            Antigravity::default()
                .session_meta(&old, Some("x"))
                .unwrap()["antigravity"],
            json!({"disabledTools":["run_workflow"]})
        );
        let advertised = InitializeInfo {
            agent_version: Some("1.6.0".into()),
            capabilities_meta: Some(json!({"antigravity": {"systemPrompt": {"append": true}}})),
            ..Default::default()
        };
        assert!(Antigravity::default().instructions_in_session_meta(&advertised));
        assert!(Antigravity::default().steers_with_prompt(&advertised));
        assert!(!Antigravity::default().client_capabilities().write_text_file);
    }
}
