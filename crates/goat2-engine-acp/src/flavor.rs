//! What one ACP agent needs beyond the shared driver.
//!
//! v1: `packages/provider-acp/src/server/adapterFlavor.ts` (`AcpAdapterV2Flavor`) and the runtime
//! options each provider passes to `AcpSessionRuntime.layer` (`AcpSessionRuntime.ts:131-200`).
//! Only hooks with a GOAT 2 consumer are carried; each default is v1's behaviour when the flavor
//! leaves the hook unset.

use std::path::PathBuf;
use std::sync::Arc;

use futures::future::BoxFuture;
use goat2_contracts::{
    ApprovalDecision, ApprovalOption, ChatAttachment, EngineDriver, ModelSelection,
    ProviderCapabilities, RuntimeMode, TurnItemStatus, UserInputQuestion,
};
use goat2_engine_api::{EngineError, SessionSpec};
use serde_json::{Map, Value};

use crate::capabilities::acp_base_capabilities;
use crate::items::ToolState;
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
    /// The line breaks the protocol: the connection ends with this reason (v1 a `transformStdout`
    /// failure, e.g. Antigravity's invalid sign-in URL).
    Fail(String),
}

/// What a stderr line means (v1 `onStderr`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StderrLine {
    Ignore,
    /// A sign-in URL the agent printed.
    AuthUrl(String),
    /// The agent can no longer run a turn (v1 an `onStderr` transport error): the open turn fails
    /// with this message and the process is replaced on the next turn.
    Fail(String),
}

/// How a failed `authenticate` is reported (v1 `requiresSignIn`, adapter.ts:8419).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthFailure {
    /// The driver's own report.
    Default,
    /// The person must sign in; the message is shown with the sign-in request.
    SignIn(String),
    /// A plain start failure, no sign-in request.
    Plain,
}

/// One `session/set_config_option` write with v1 runtime `setConfigOption` semantics
/// (AcpSessionRuntime.ts:1023-1075, 1363-1420).
#[derive(Debug, Clone, PartialEq)]
pub struct ConfigWrite {
    pub config_id: String,
    /// A string, or a boolean for boolean options.
    pub value: Value,
    /// v1 `allowUnlistedValue`: send a value the select option does not list.
    pub allow_unlisted: bool,
    /// v1 `resendCurrentValue`: send even when the option already holds the value.
    pub resend_current: bool,
    /// v1 `configureSession` option loop (adapter.ts:6076-6113): skip when the live session lacks
    /// the option or does not list the value, and let a -32602 refusal pass.
    pub optional: bool,
}

impl ConfigWrite {
    /// A required write of a listed value, skipped when it is already current.
    pub fn new(config_id: impl Into<String>, value: impl Into<String>) -> Self {
        Self {
            config_id: config_id.into(),
            value: Value::String(value.into()),
            allow_unlisted: false,
            resend_current: false,
            optional: false,
        }
    }

    pub fn allow_unlisted(mut self) -> Self {
        self.allow_unlisted = true;
        self
    }

    pub fn resend_current(mut self) -> Self {
        self.resend_current = true;
        self
    }

    pub fn optional(mut self) -> Self {
        self.optional = true;
        self
    }
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
    /// Config writes in order, each checked against the options the previous one returned (a
    /// model write and then the options that depend on the model, v1 `applyModelSelection` plus
    /// the `configureSession` option loop).
    ConfigOptions(Vec<ConfigWrite>),
    /// Several writes in order (v1 Grok `applyGrokSessionModelSelection`: the model, then the
    /// effort option of the new model).
    Sequence(Vec<ModelWrite>),
    /// Try the first write; when the agent rejects it, apply the second instead (v1 Grok protocol 1:
    /// an effort Grok refuses is skipped and the model is set without it).
    OrElse(Box<ModelWrite>, Box<ModelWrite>),
    /// `session/set_config_option` on the select option of `category`, read when the write runs
    /// (after earlier writes). Skipped when the session has no such option, when the option does not
    /// offer `value` or already holds it, and when the agent rejects it (v1 Grok `thought_level`).
    OptionalConfigByCategory {
        category: String,
        value: String,
    },
}

/// How the session mode for a runtime mode is written.
#[derive(Debug, Clone, PartialEq)]
pub enum ModeWrite {
    Keep,
    /// `session/set_mode`.
    SetMode(String),
    /// `session/set_config_option` on the mode option; the reported mode becomes the value.
    Config(ConfigWrite),
    /// The agent cannot run in the mode; session setup or the turn fails with this message.
    Unavailable(String),
}

/// What the session reports when a mode is written.
#[derive(Debug, Clone, Copy)]
pub struct ModeContext<'a> {
    pub modes: Option<&'a ModeState>,
    pub config_options: &'a [Value],
    /// The first mode write since the session was opened, loaded or resumed.
    pub first_write: bool,
}

/// v1 `AcpSessionRuntime.setMode` (AcpSessionRuntime.ts:2068-2098): nothing when the mode is
/// current; `session/set_mode` for agents that report modes without a `category: "mode"` select
/// option; otherwise a write of that option (or `mode`), refused when the option does not list it.
pub fn runtime_set_mode(mode_id: &str, context: &ModeContext<'_>) -> ModeWrite {
    if context
        .modes
        .is_some_and(|modes| modes.current_mode_id == mode_id)
    {
        return ModeWrite::Keep;
    }
    let option = context.config_options.iter().find(|option| {
        option.get("category").and_then(Value::as_str) == Some("mode")
            && option.get("type").and_then(Value::as_str) == Some("select")
    });
    match option {
        None if context.modes.is_some() => ModeWrite::SetMode(mode_id.to_owned()),
        _ => ModeWrite::Config(ConfigWrite::new(
            option
                .and_then(crate::wire::config_option_id)
                .unwrap_or("mode"),
            mode_id,
        )),
    }
}

/// An attachment of the turn with its saved file, when the host could resolve it.
#[derive(Debug, Clone, Copy)]
pub struct PromptAttachment<'a> {
    pub attachment: &'a ChatAttachment,
    pub path: Option<&'a std::path::Path>,
}

/// The answer to an `fs/read_text_file` request a flavor serves.
pub struct ClientRead {
    /// The response, or a JSON-RPC error code and message.
    pub response: Result<Value, (i32, String)>,
    /// Session updates to project after answering (Antigravity reports a served read as done).
    pub events: Vec<FlavorEvent>,
}

/// A text notice that a subagent ended (v1 `extractSubagentEndNotice`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubagentEndNotice {
    pub child_session_id: String,
    pub status: TurnItemStatus,
}

/// v1 background task status.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackgroundStatus {
    Running,
    Completed,
    Failed,
}

/// A change to a background task's tool (v1 `extractBackgroundTaskCompletion` /
/// `extractBackgroundToolMutation` entries).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackgroundMutation {
    pub task_id: String,
    pub status: BackgroundStatus,
    /// Shared: one injected message can end several tasks with the same text (round 7 part 4.1).
    pub append_output: std::sync::Arc<str>,
}

/// What the driver knows about the session when a flavor rewrites a prompt (v1 `rewriteUserText`
/// receives the session launch and the turn's runtime policy).
#[derive(Debug, Clone, Default)]
pub struct PromptContext {
    pub cwd: String,
    /// The agent program the session launched.
    pub program: PathBuf,
    /// Variables the session set on top of the inherited environment.
    pub launch_env: Vec<(String, String)>,
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
    /// turn's latest prompt is stale and ignored, as is one for another session (v1
    /// xaiAcpExtension.ts:1381-1390 matches `entry.sessionId === notification.sessionId`).
    PromptComplete {
        session_id: String,
        prompt_id: Option<String>,
        stop_reason: String,
    },
    /// The agent ended the prompt with a failure by extension (xAI `stopReason` `rate_limit` /
    /// `error`, v1 `xaiAcpExtension.ts:1283-1301`): fail the turn with `message`. Stale prompt ids
    /// are ignored as for [Self::PromptComplete].
    PromptFailed {
        session_id: String,
        prompt_id: Option<String>,
        message: String,
    },
    /// v1 `AcpAdapterV2ExtensionContext.finishSubagent` (`adapterFlavor.ts:78-83`): an extension
    /// reported that the child session of a native subagent ended (Copilot `subagent.completed`, xAI
    /// `subagent_finished`).
    FinishSubagent {
        session_id: String,
        child_session_id: String,
        status: TurnItemStatus,
        result: Option<String>,
    },
    /// v1 `reportForegroundWork` (`adapterFlavor.ts:91-98`, `adapter.ts:5440-5478`): the agent's
    /// foreground work started (`running`) or went idle. An idle after a `running` seen during
    /// the turn settles it as completed, for agents that hold `session/prompt` past their work.
    ForegroundWork {
        session_id: String,
        running: bool,
    },
    /// A background task started or ended (v1 `applyBackgroundTaskMutation`, xAI
    /// `x.ai/task_backgrounded` / `x.ai/task_completed`). Ignored for another session.
    BackgroundTask {
        session_id: String,
        task_id: String,
        status: BackgroundStatus,
        output: Option<String>,
    },
}

/// v1 `AcpAdapterV2SubagentUpdate`: what a tool call says about an agent-native subagent.
#[derive(Debug, Clone, PartialEq)]
pub struct SubagentUpdate {
    pub native_task_id: String,
    /// The ACP session the child's updates arrive on, when the agent streams them.
    pub child_session_id: Option<String>,
    pub prompt: String,
    pub title: Option<String>,
    pub model: Option<String>,
    /// v1 subagent status (`running`, `completed`, `failed`, ...).
    pub status: TurnItemStatus,
    pub result: Option<String>,
}

/// v1 `AcpSubagentSessionEvent`: a child-session event of agents that report child state
/// (claude-agent-acp `subagent_update` / `session_message`).
#[derive(Debug, Clone, PartialEq)]
pub enum SubagentSessionEvent {
    State {
        child_session_id: String,
        parent_session_id: Option<String>,
        status: TurnItemStatus,
        result: Option<String>,
    },
    /// The parent handed the child its prompt; `delegation_id` is the parent's Agent/Task tool id.
    Delegation {
        child_session_id: String,
        parent_session_id: Option<String>,
        delegation_id: String,
        prompt: String,
    },
}

/// Answers of a question form become the elicitation response (`{action, content}`).
pub type ElicitationRespond = Arc<dyn Fn(&Map<String, Value>) -> Value + Send + Sync>;

/// v1 `ElicitationQuestionForm` returned by a flavor's `extractElicitationForm`: an agent's own
/// question form (Droid, omp, OpenCode) with its own answer mapping.
#[derive(Clone)]
pub struct NativeElicitationForm {
    pub questions: Vec<UserInputQuestion>,
    pub respond: ElicitationRespond,
}

impl std::fmt::Debug for NativeElicitationForm {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NativeElicitationForm")
            .field("questions", &self.questions)
            .finish_non_exhaustive()
    }
}

/// A `session/prompt` error as the agent answered it (v1 `AcpRequestError`).
#[derive(Debug, Clone, PartialEq)]
pub struct PromptError {
    pub code: i32,
    pub message: String,
    pub data: Option<Value>,
}

/// v1 `watchPromptOutcome` check: sees a prompt the agent answered and reports a failure its
/// stop reason hid. May block on file reads; the driver runs it off the async runtime.
pub trait PromptOutcomeCheck: Send {
    fn check(self: Box<Self>, response: &Value) -> Option<String>;
}

/// The environment the agent process runs with: the launch's variables over the inherited ones.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AgentEnv {
    pub set: Vec<(String, String)>,
    pub removed: Vec<String>,
    pub removed_prefixes: Vec<String>,
}

impl AgentEnv {
    pub fn get(&self, name: &str) -> Option<String> {
        if let Some((_, value)) = self.set.iter().rev().find(|(n, _)| n == name) {
            return Some(value.clone());
        }
        if self.removed.iter().any(|n| n == name)
            || self.removed_prefixes.iter().any(|p| name.starts_with(p))
        {
            return None;
        }
        std::env::var(name).ok()
    }
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
    /// v1 grok `adapter.ts:171-197`). Without `markdown` the plan is the last one captured in this
    /// turn (v1 `lastProposedPlanMarkdown`), else `fallback`.
    CapturePlan {
        markdown: Option<String>,
        fallback: String,
        response: Value,
    },
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
    /// Adjust the final command once `SessionSpec.launch` (or a probe's launch settings) has been
    /// merged in. Grok fills a blank merged `XAI_API_KEY` from the stored key here (v1
    /// `applyStoredGrokApiKey` on the merged environment, provider-grok auth.ts:57-64).
    fn finish_launch(&self, _command: &mut LaunchCommand) {}
    /// `initialize._meta` (Grok `clientType: extension`).
    fn initialize_meta(&self) -> Option<Map<String, Value>> {
        None
    }
    fn client_capabilities(&self) -> ClientCaps {
        ClientCaps::default()
    }
    /// v1 `checksVersionAtHandshake` (adapterFlavor.ts:159): refuse the runtime `initialize`
    /// reported, with the message to show. None accepts it.
    fn initialize_refusal(&self, _init: &InitializeInfo) -> Option<String> {
        None
    }
    fn auth_policy(&self) -> AuthPolicy {
        AuthPolicy::OnRequired { method_id: None }
    }
    /// [Self::auth_policy] for one session (Grok picks the API key method when the launch
    /// environment has a key, v1 `resolveGrokAuthMethodId`).
    fn auth_policy_for(&self, _spec: &SessionSpec) -> AuthPolicy {
        self.auth_policy()
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
    /// v1 `onStderr`. The default reports [Self::stderr_auth_url].
    fn stderr_line(&self, line: &str) -> StderrLine {
        match self.stderr_auth_url(line) {
            Some(url) => StderrLine::AuthUrl(url),
            None => StderrLine::Ignore,
        }
    }
    /// v1 `requiresSignIn`: what a failed eager `authenticate` means.
    fn auth_failure(&self, _code: i32, _message: &str) -> AuthFailure {
        AuthFailure::Default
    }
    /// v1 `clientFileSystem.readTextFile` (adapter.ts:5081-5087): serve `fs/read_text_file`. None
    /// answers "method not found". `cwd` is the thread's folder.
    fn read_text_file(&self, _request: &Value, _cwd: Option<&str>) -> Option<ClientRead> {
        None
    }
    /// Called before each `session/prompt` of `session_id` is sent (v1 Antigravity resets its
    /// read repair, AntigravityAdapterV2.ts:197-198).
    fn prompt_sent(&self, _session_id: &str) {}
    /// v1 `buildPrompt`: the content blocks for the turn's attachments, after the text. None keeps
    /// the shared handling (images when [Self::supports_image_prompts]). `config_options` is the
    /// live session's (the current model decides what Antigravity sends).
    fn prompt_attachment_blocks(
        &self,
        _init: &InitializeInfo,
        _config_options: &[Value],
        _attachments: &[PromptAttachment<'_>],
    ) -> Option<Result<Vec<Value>, String>> {
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
    /// v1 `extractPermissionQuestion` (adapter.ts:5128-5147): a permission request that is really a
    /// question. [ExtRequest::AskUser] holds it open for the person; a dismissed or unmatched
    /// answer must build `{"outcome":{"outcome":"cancelled"}}`. `request` carries the answerable
    /// options.
    fn permission_request_action(&self, _request: &Value) -> Option<ExtRequest> {
        None
    }
    /// v1 `approvalOptions`: the choices shown for a permission request.
    fn approval_options(&self, request: &Value) -> Vec<ApprovalOption> {
        default_approval_options(request)
    }
    /// The option that answers `choice` among the request's answerable `options` (v1
    /// `selectPermissionOptionId`, permissionOptions.ts:4-15). A flavor whose session choice is
    /// one specific option overrides this, so a person's "for this session" never selects a
    /// broader grant the agent listed first.
    fn permission_option_id(
        &self,
        options: &[Value],
        choice: policy::PermissionChoice,
    ) -> Option<String> {
        policy::select_permission_option_id(options, choice)
    }
    /// v1 `sessionModeForPolicy`: the ACP session mode for a runtime mode.
    fn session_mode_for(&self, _mode: RuntimeMode, _modes: Option<&ModeState>) -> Option<String> {
        None
    }
    /// How the session mode for `mode` is written. The default writes [Self::session_mode_for]
    /// with `session/set_mode` when the agent offers it and it is not current.
    fn mode_write(&self, mode: RuntimeMode, context: &ModeContext<'_>) -> ModeWrite {
        match self.session_mode_for(mode, context.modes) {
            Some(mode_id)
                if context
                    .modes
                    .is_some_and(|m| m.has(&mode_id) && m.current_mode_id != mode_id) =>
            {
                ModeWrite::SetMode(mode_id)
            }
            _ => ModeWrite::Keep,
        }
    }
    /// How to apply the selected model (v1 `applyModelSelection` / runtime `setModel`).
    fn model_write(&self, selection: &ModelSelection, setup: &SessionSetup) -> ModelWrite {
        default_model_write(selection, setup)
    }
    /// [Self::model_write] with what `initialize` reported (v1 `applyModelSelection` reads the
    /// protocol version).
    fn model_write_for(
        &self,
        selection: &ModelSelection,
        setup: &SessionSetup,
        _init: &InitializeInfo,
    ) -> ModelWrite {
        self.model_write(selection, setup)
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
    /// v1 `rewriteUserText` when the rewrite needs the session (Grok asks `grok inspect` for its
    /// skills). Applied to the start of the message before [Self::rewrite_user_text].
    fn rewrite_user_text_for(
        &self,
        text: String,
        _context: &PromptContext,
    ) -> BoxFuture<'static, String> {
        Box::pin(std::future::ready(text))
    }
    /// v1 `supportsImagePrompts`: send images even when `promptCapabilities.image` is false.
    fn supports_image_prompts(&self, init: &InitializeInfo) -> bool {
        init.prompt_image
    }
    /// v1 `clientCapabilitiesMeta` (`adapter.ts:1018`): `initialize.clientCapabilities._meta`.
    fn client_capabilities_meta(&self) -> Option<Map<String, Value>> {
        None
    }
    /// v1 `normalizeToolCall`: fix a merged tool call before anything reads it.
    fn normalize_tool_call(&self, tool: ToolState) -> ToolState {
        tool
    }
    /// v1 `extractSubagentUpdate`: a tool call that starts or reports an agent-native subagent.
    /// The driver projects it as a subagent instead of a tool.
    fn extract_subagent(&self, _tool: &ToolState) -> Option<SubagentUpdate> {
        None
    }
    /// v1 `followAgentWorkState` together with `extractSubagentSessionEvent`: the agent reports
    /// child sessions itself. v1 turns this on only on negotiated ACP v2 (`adapter.ts:499-502`);
    /// on v1 such a flavor's [Self::extract_subagent] is off (`adapter.ts:465-468`).
    fn follows_agent_work_state(&self) -> bool {
        false
    }
    /// v1 `isProvisionalSubagentTool`: a subagent tool whose input has not arrived yet; held back.
    fn is_provisional_subagent_tool(&self, _tool: &ToolState) -> bool {
        false
    }
    /// v1 `extractSubagentSessionEvent`. `params` is the whole `session/update` params object.
    fn extract_subagent_session_event(&self, _params: &Value) -> Option<SubagentSessionEvent> {
        None
    }
    /// v1 `extractElicitationForm`: the agent's own question form; None uses the generic mapping.
    fn extract_elicitation_form(&self, _params: &Value) -> Option<NativeElicitationForm> {
        None
    }
    /// v1 `restartRuntimeAfterPromptError`: prompt failures after which the agent keeps failing
    /// until its process is replaced.
    fn restart_after_prompt_error(&self, _error: &PromptError) -> bool {
        false
    }
    /// v1 `watchPromptOutcome`: runs before `session/prompt`; a failure the returned check reports
    /// fails the turn and restarts the agent before the next one.
    fn watch_prompt_outcome(
        &self,
        _session_id: &str,
        _env: &AgentEnv,
    ) -> Option<Box<dyn PromptOutcomeCheck>> {
        None
    }
    /// v1 `releaseRuntime`: the agent process of `session_id` ended; drop per-runtime state.
    fn release_runtime(&self, _session_id: &str) {}
    /// v1 `extractSubagentEndNotice`: a subagent end announced in injected user text.
    fn subagent_end_notice(&self, _text: &str) -> Option<SubagentEndNotice> {
        None
    }
    /// v1 `extractProposedPlanMarkdown`: the plan a tool call writes. `Some("")` is an empty plan
    /// write, which is not captured. `launch_env` is the session's launch environment.
    fn proposed_plan_markdown(
        &self,
        _tool: &ToolState,
        _launch_env: &[(String, String)],
    ) -> Option<String> {
        None
    }
    /// v1 `extractBackgroundTaskId`: the background task a tool call runs or watches.
    fn background_task_id(&self, _tool: &ToolState) -> Option<String> {
        None
    }
    /// v1 `isPersistentBackgroundTool`: a background task that must not hold the turn open.
    fn is_persistent_background_tool(&self, _tool: &ToolState) -> bool {
        false
    }
    /// v1 `extractBackgroundTaskCompletion`: background tasks a tool call (a poll or kill) ends.
    fn background_task_completions(&self, _tool: &ToolState) -> Vec<BackgroundMutation> {
        Vec::new()
    }
    /// v1 `extractBackgroundToolMutation`: background task output injected as user text.
    fn background_tool_mutations(&self, _text: &str) -> Vec<BackgroundMutation> {
        Vec::new()
    }
    /// v1 `isProviderWakeNotification`: a `session/update` of a turn the agent started by itself
    /// after a background task ended. `params` is the whole notification.
    fn is_wake_notification(&self, _params: &Value) -> bool {
        false
    }
    /// v1 `deferFinalizeForBackgroundWork`: after the prompt answers, the turn stays open while
    /// background tasks or subagents run.
    fn defers_finalize_for_background_work(&self) -> bool {
        false
    }
    /// v1 `preserveRuntimeOnSettledInterrupt`: interrupting a turn whose prompt already answered
    /// neither cancels nor restarts the agent (its background work keeps running).
    fn preserve_runtime_on_settled_interrupt(&self) -> bool {
        false
    }
    /// v1 xAI `cancel` (`xaiAcpExtension.ts:1323-1357,1553-1560`, `abortPendingPromptCompletions`):
    /// once `session/cancel` is sent the open prompt counts as cancelled, without waiting for an
    /// answer the agent may never send.
    fn settles_prompt_on_cancel(&self) -> bool {
        false
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
    model_write_with_custom(selection, setup, &[])
}

/// [default_model_write] for agents with configured custom models: v1 writes a custom model id
/// without checking the agent's list and lets the agent validate it (`adapter.ts:5936-6016`,
/// `AcpSessionRuntime.ts:1063-1068`). `auto` is left as the agent has it, like `default`.
pub fn model_write_with_custom(
    selection: &ModelSelection,
    setup: &SessionSetup,
    custom_models: &[String],
) -> ModelWrite {
    let model = selection.model.trim();
    if model.is_empty() || model == "default" {
        return ModelWrite::Keep;
    }
    let custom = custom_models.iter().any(|m| m == model);
    if let Some(option) = find_model_config_option(&setup.config_options) {
        let current = option.get("currentValue").and_then(Value::as_str);
        if current == Some(model) {
            return ModelWrite::Keep;
        }
        let config_id = crate::wire::config_option_id(option)
            .unwrap_or("model")
            .to_owned();
        if custom
            || select_values(option)
                .iter()
                .any(|(value, _)| value == model)
        {
            return ModelWrite::ConfigOption {
                config_id,
                value: model.to_owned(),
            };
        }
        if model == "auto" {
            return ModelWrite::Keep;
        }
        return ModelWrite::Unavailable {
            message: format!("Model '{model}' is not offered by this agent."),
        };
    }
    if let Some(models) = &setup.models {
        if models.current_model_id == model {
            return ModelWrite::Keep;
        }
        if !custom && model == "auto" && !models.available.iter().any(|(id, _, _)| id == model) {
            return ModelWrite::Keep;
        }
        return ModelWrite::SetModel {
            model_id: model.to_owned(),
            meta: None,
        };
    }
    ModelWrite::Keep
}
