//! What one ACP agent needs beyond the shared driver.
//!
//! v1: `packages/provider-acp/src/server/adapterFlavor.ts` (`AcpAdapterV2Flavor`) and the runtime
//! options each provider passes to `AcpSessionRuntime.layer` (`AcpSessionRuntime.ts:131-200`).
//! Only hooks with a GOAT 2 consumer are carried; each default is v1's behaviour when the flavor
//! leaves the hook unset.

use std::path::PathBuf;

use goat2_contracts::{
    ApprovalDecision, ApprovalOption, EngineDriver, ModelSelection, ProviderCapabilities,
    RuntimeMode,
};
use goat2_engine_api::{EngineError, SessionSpec};
use serde_json::{Map, Value};

use crate::capabilities::acp_base_capabilities;
use crate::policy::{self, Disposition, RuntimePolicy};
use crate::wire::{
    InitializeInfo, ModeState, SessionSetup, find_model_config_option, select_values,
};

/// The command that starts the agent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchCommand {
    pub program: PathBuf,
    pub args: Vec<String>,
    /// Set on top of the inherited environment (minus the host identity).
    pub env: Vec<(String, String)>,
    /// Removed from the inherited environment.
    pub env_remove: Vec<String>,
}

impl LaunchCommand {
    pub fn new(
        program: impl Into<PathBuf>,
        args: impl IntoIterator<Item = impl Into<String>>,
    ) -> Self {
        Self {
            program: program.into(),
            args: args.into_iter().map(Into::into).collect(),
            env: Vec::new(),
            env_remove: Vec::new(),
        }
    }

    pub fn env(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.env.push((name.into(), value.into()));
        self
    }
}

/// How and when to authenticate (v1 `authMethodId`, `authenticateEagerly`, `authenticateOnAuthRequired`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthPolicy {
    /// Authenticate only when session setup answers -32000, with this method or the first
    /// agent-type method (v1 `selectAcpAgentAuthMethod`).
    OnRequired { method_id: Option<String> },
    /// Authenticate before opening the session (Antigravity picks its credential source this way).
    Eager { method_id: String },
}

/// Which call reopens a saved session (v1 `resumeMethod`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResumeMethod {
    Load,
    Resume,
}

/// What a stdout line is, before JSON-RPC sees it (v1 `transformStdout`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StdoutLine {
    Json,
    Drop,
    /// A sign-in URL the agent printed; the line is dropped.
    AuthUrl(String),
}

/// How the model of a selection is written to the session.
#[derive(Debug, Clone, PartialEq)]
pub enum ModelWrite {
    Keep,
    /// `session/set_config_option` on the model option.
    ConfigOption {
        config_id: String,
        value: String,
    },
    /// `session/set_model` (ACP session models), with optional `_meta`.
    SetModel {
        model_id: String,
        meta: Option<Map<String, Value>>,
    },
    /// The agent does not offer the model.
    Unavailable {
        message: String,
    },
}

/// Something an extension notification means for the turn.
#[derive(Debug, Clone, PartialEq)]
pub enum FlavorEvent {
    /// Treat as a `session/update` params object.
    SessionUpdate(Value),
    Notice {
        message: String,
        warning: bool,
    },
    AuthUrl(String),
    /// The agent finished the prompt by extension (xAI `_x.ai/session/prompt_complete`): settle the
    /// turn as if `session/prompt` answered with `stop_reason`. A `prompt_id` that is not the
    /// turn's latest prompt is stale and ignored.
    PromptComplete {
        prompt_id: Option<String>,
        stop_reason: String,
    },
    /// The agent ended the prompt with a failure by extension (xAI `stopReason` `rate_limit` /
    /// `error`, v1 `xaiAcpExtension.ts:1283-1301`): fail the turn with `message`. Stale prompt ids
    /// are ignored as for [Self::PromptComplete].
    PromptFailed {
        prompt_id: Option<String>,
        message: String,
    },
}

/// Builds the reply to an extension request from the person's answers (None: dismissed or
/// cancelled).
pub type ExtAnswer = Box<dyn FnOnce(Option<&Map<String, Value>>) -> Value + Send>;

/// What the driver does with an agent-to-client extension request (v1 runtime `handleExtRequest`).
pub enum ExtRequest {
    /// Answer "method not found".
    Unhandled,
    /// Answer now.
    Respond(Value),
    /// Ask the person and keep the request open until they answer (xAI `ask_user_question`,
    /// v1 grok `adapter.ts:200-230`). `answer` builds the reply.
    AskUser {
        native_id: String,
        summary: String,
        questions: Vec<goat2_contracts::UserInputQuestion>,
        answer: ExtAnswer,
    },
    /// Record a proposed plan for the turn, then answer with `response` (xAI `exit_plan_mode`,
    /// v1 grok `adapter.ts:171-197`).
    CapturePlan { markdown: String, response: Value },
}

/// Client capabilities a flavor advertises in `initialize`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ClientCaps {
    pub read_text_file: bool,
    pub write_text_file: bool,
    pub terminal: bool,
}

/// One ACP agent's handling. Every method has v1's shared-runtime default.
pub trait AcpFlavor: Send + Sync + 'static {
    /// v1 driver kind: `grok`, `fx`, `antigravity` or `acpRegistry`.
    fn driver(&self) -> &str;
    /// The card's engine driver (`Grok`, `Fx`, `Antigravity` or `AcpRegistry { agent_id }`).
    fn engine_driver(&self) -> EngineDriver;
    fn capabilities(&self) -> ProviderCapabilities {
        acp_base_capabilities()
    }
    /// The command line for this thread's runtime mode. `SessionSpec.launch` overrides are applied
    /// by the driver afterwards (binary replaces the program, args replace, env adds).
    fn launch(&self, spec: &SessionSpec) -> Result<LaunchCommand, EngineError>;
    /// `initialize._meta` (Grok `clientType: extension`).
    fn initialize_meta(&self) -> Option<Map<String, Value>> {
        None
    }
    fn client_capabilities(&self) -> ClientCaps {
        ClientCaps::default()
    }
    fn auth_policy(&self) -> AuthPolicy {
        AuthPolicy::OnRequired { method_id: None }
    }
    /// None: `session/load` when advertised, otherwise `session/resume` (v1 default).
    fn resume_method(&self) -> Option<ResumeMethod> {
        None
    }
    /// `_meta` for session new/load/resume. `instructions` is the GOAT system prompt append.
    fn session_meta(
        &self,
        _init: &InitializeInfo,
        _instructions: Option<&str>,
    ) -> Option<Map<String, Value>> {
        None
    }
    /// Whether [Self::session_meta] already carries the instructions (Antigravity `systemPrompt.append`).
    fn instructions_in_session_meta(&self, _init: &InitializeInfo) -> bool {
        false
    }
    /// `session/cancel._meta` (Grok `cancelTrigger: ctrl_c`).
    fn cancel_meta(&self) -> Option<Map<String, Value>> {
        None
    }
    /// v1 `transformSessionUpdate` / `normalizeSessionUpdate`, after the shared v1 normalization.
    fn normalize_update(&self, params: Value) -> Value {
        params
    }
    fn stdout_line(&self, _line: &str) -> StdoutLine {
        StdoutLine::Json
    }
    fn stderr_auth_url(&self, _line: &str) -> Option<String> {
        None
    }
    /// v1 `permissionDisposition`. `request` is the whole `session/request_permission` params.
    fn permission_disposition(&self, policy: &RuntimePolicy, request: &Value) -> Disposition {
        policy::permission_disposition(policy, request.get("toolCall").unwrap_or(&Value::Null))
    }
    /// v1 `adapterFlavor.ts:266-268`: choices permitted when answering a request.
    fn answerable_permission_options(&self, options: Vec<Value>) -> Vec<Value> {
        options
    }
    /// v1 `approvalOptions`: the choices shown for a permission request.
    fn approval_options(&self, request: &Value) -> Vec<ApprovalOption> {
        default_approval_options(request)
    }
    /// v1 `sessionModeForPolicy`: the ACP session mode for a runtime mode.
    fn session_mode_for(&self, _mode: RuntimeMode, _modes: Option<&ModeState>) -> Option<String> {
        None
    }
    /// How to apply the selected model (v1 `applyModelSelection` / runtime `setModel`).
    fn model_write(&self, selection: &ModelSelection, setup: &SessionSetup) -> ModelWrite {
        default_model_write(selection, setup)
    }
    /// v1 `steersWithPrompt`: a second `session/prompt` steers the running turn.
    fn steers_with_prompt(&self, _init: &InitializeInfo) -> bool {
        false
    }
    /// v1 `restartRuntimeAfterInterrupt` (Grok keeps `task_already_running` until exit).
    fn restart_after_interrupt(&self) -> bool {
        false
    }
    /// A notification that is not `session/update` (vendor extensions).
    fn ext_notification(&self, _method: &str, _params: &Value) -> Vec<FlavorEvent> {
        Vec::new()
    }
    /// A request the shared client does not serve. None answers "method not found".
    fn ext_request(&self, _method: &str, _params: &Value) -> Option<Value> {
        None
    }
    /// A request the shared client does not serve, when the flavor needs more than an immediate
    /// answer. The default answers through [Self::ext_request].
    fn ext_request_action(&self, method: &str, params: &Value) -> ExtRequest {
        match self.ext_request(method, params) {
            Some(value) => ExtRequest::Respond(value),
            None => ExtRequest::Unhandled,
        }
    }
    /// `session/prompt._meta` for the prompt GOAT names `prompt_id` (xAI matches completions to it).
    fn prompt_meta(&self, _prompt_id: &str) -> Option<Map<String, Value>> {
        None
    }
    /// v1 `preferHttpMcp` (`adapterFlavor.ts:126`): hand GOAT's MCP endpoint over HTTP when the agent
    /// advertises `mcpCapabilities.http`; otherwise the stdio bridge (see [crate::mcp]).
    fn prefers_http_mcp(&self) -> bool {
        false
    }
    /// v1 `rewriteUserText`.
    fn rewrite_user_text(&self, text: String) -> String {
        text
    }
    /// v1 `supportsImagePrompts`: send images even when `promptCapabilities.image` is false.
    fn supports_image_prompts(&self, init: &InitializeInfo) -> bool {
        init.prompt_image
    }
}

/// v1 default approval options: what the request's option kinds allow, plus cancel.
pub fn default_approval_options(request: &Value) -> Vec<ApprovalOption> {
    let options = request
        .get("options")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let has = |kind: &str| {
        options
            .iter()
            .any(|o| o.get("kind").and_then(Value::as_str) == Some(kind))
    };
    let mut out = vec![ApprovalOption {
        decision: ApprovalDecision::Cancel,
        label: "Cancel".into(),
        warning: None,
    }];
    if has("reject_once") {
        out.push(ApprovalOption {
            decision: ApprovalDecision::Decline,
            label: "Decline".into(),
            warning: None,
        });
    }
    if has("allow_always") {
        out.push(ApprovalOption {
            decision: ApprovalDecision::AcceptForSession,
            label: "Always allow".into(),
            warning: None,
        });
    }
    if has("allow_once") {
        out.push(ApprovalOption {
            decision: ApprovalDecision::Accept,
            label: "Approve".into(),
            warning: None,
        });
    }
    out
}

/// v1 runtime `setModel`: write the model option when the agent lists the model, else
/// `session/set_model` when the agent reports session models; keep when it is already current.
pub fn default_model_write(selection: &ModelSelection, setup: &SessionSetup) -> ModelWrite {
    let model = selection.model.trim();
    if model.is_empty() || model == "default" {
        return ModelWrite::Keep;
    }
    if let Some(option) = find_model_config_option(&setup.config_options) {
        let current = option.get("currentValue").and_then(Value::as_str);
        if current == Some(model) {
            return ModelWrite::Keep;
        }
        let config_id = crate::wire::config_option_id(option)
            .unwrap_or("model")
            .to_owned();
        if select_values(option)
            .iter()
            .any(|(value, _)| value == model)
        {
            return ModelWrite::ConfigOption {
                config_id,
                value: model.to_owned(),
            };
        }
        return ModelWrite::Unavailable {
            message: format!("Model '{model}' is not offered by this agent."),
        };
    }
    if let Some(models) = &setup.models {
        if models.current_model_id == model {
            return ModelWrite::Keep;
        }
        return ModelWrite::SetModel {
            model_id: model.to_owned(),
            meta: None,
        };
    }
    ModelWrite::Keep
}
