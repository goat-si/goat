//! The ACP engine: one agent process per thread, driven through Zed's `agent-client-protocol` crate.
//!
//! v1 sources (goat-si/goat origin/dev 916b5ccc):
//! - `packages/provider-acp/src/server/AcpSessionRuntime.ts`: spawn, `initialize` with client
//!   capabilities (:995-1009, notices always advertised), auth on -32000 (:1505-1555), session
//!   new/load/resume choice (:1557-1613), cancel with a 15 s wait (:117-120).
//! - `packages/provider-acp/src/server/adapter.ts`: prompt settle by stop reason (:6850-6925),
//!   permission requests through the flavor's disposition, elicitation forms, steering by a second
//!   prompt only for flavors with `steersWithPrompt` (:7788), otherwise the host interrupts and
//!   restarts (capabilities.ts `supportsSteeringByInterruptRestart`).
//! - `packages/provider-acp/src/server/acpAppContext.ts`: context the session has not seen goes in
//!   front of the next prompt; GOAT 2 sends `Instructions.first_message_preamble` and, for agents
//!   without a system prompt channel, `append_system_prompt` that way.
//! - Background work (v1 `deferredBackground.ts:13-233`, `adapter.ts:3880-3899,7874-8082`): a flavor
//!   with `defers_finalize_for_background_work` keeps the turn open after its prompt answers while
//!   background tasks or subagents run, finishes it a debounce after the work ends, finishes it at
//!   once on the agent's own wake turn, and with `preserve_runtime_on_settled_interrupt` ends it on
//!   interrupt without cancelling or restarting the agent. v1's post-settle continuation runs (wake
//!   frames replayed as a new run) need host support and are not carried.
//!
//! Requests are built from `agent_client_protocol::v1::schema` types. Inbound traffic is taken as
//! `UntypedMessage` so v1's normalization (`normalize.rs`) and each flavor's fixes run on the JSON
//! before anything reads it, as v1 `effect-acp` does.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::v1::schema::{
    AuthenticateRequest, CancelNotification, ClientCapabilities, ContentBlock,
    FileSystemCapabilities, ImageContent, Implementation, InitializeRequest, LoadSessionRequest,
    NewSessionRequest, PromptRequest, ResumeSessionRequest, SetSessionModeRequest, SystemPrompt,
    TextContent,
};
use agent_client_protocol::{Agent, Client, Lines, Responder, UntypedMessage};
use async_trait::async_trait;
use futures::future::BoxFuture;
use goat2_contracts::{
    ChatAttachment, ChatAttachmentType, EngineRef, ItemId, ModelSelection, ProviderCapabilities,
    ProviderRequestKind, RequestId, RequestKind, RequestOutcome, ThreadId, TurnItem, TurnItemBody,
    TurnItemStatus,
};
use goat2_engine_api::{
    EngineError, EngineEvent, EngineFactory, EngineHandle, EngineInput, EngineSession,
    RequestAnswer, SessionSpec, SteerResult, TurnOutcome, TurnSettings, TurnStartResult,
};
use serde_json::{Map, Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot, watch};

use crate::elicitation::{ElicitationForm, parse_elicitation_form};
use crate::flavor::{
    AcpFlavor, AgentEnv, AuthFailure, AuthPolicy, ConfigWrite, ExtAnswer, ExtRequest, FlavorEvent,
    ModeContext, ModeWrite, ModelWrite, NativeElicitationForm, PromptAttachment, PromptContext,
    PromptError, ResumeMethod, StderrLine, StdoutLine,
};
use crate::items::{TurnProjector, now_ms, rfc3339_ms, unfinished_stop_message};
use crate::mcp::McpBridgeCommand;
use crate::normalize::normalize_v1_session_update;
use crate::policy::{
    Disposition, PermissionChoice, RuntimePolicy, UnreadToolCalls, auto_accept_policy_request,
    mcp_tool_approval_elicitation_disposition, unread_tool_call_update,
};
use crate::process::{ChildProcess, Launch};
use crate::subagents::{SubagentTracker, ToolRoute, TurnRef};
use crate::wire::{
    InitializeInfo, ModeState, SessionSetup, config_option_id, parse_modes, select_values,
    str_field, text_field,
};

type Conn = agent_client_protocol::v1::ConnectionTo<Agent>;
type ValueResponder = Responder<Value, agent_client_protocol::V1>;

/// Finds the saved file of an attachment (the host knows the thread folder; v1
/// `resolveAttachmentPath`).
pub type AttachmentResolver =
    Arc<dyn Fn(&ThreadId, &ChatAttachment) -> Option<PathBuf> + Send + Sync>;

/// Timeouts (v1 `AcpSessionRuntime.ts:117-120`).
#[derive(Debug, Clone)]
pub struct AcpTimeouts {
    /// `initialize`, `authenticate`, `session/new`, mode and model writes.
    pub request: Duration,
    /// `session/load` (replays history; v1 90 s).
    pub session_load: Duration,
    /// How long `interrupt` waits for the prompt to settle after `session/cancel` (v1 15 s).
    pub cancel: Duration,
}

impl Default for AcpTimeouts {
    fn default() -> Self {
        Self {
            request: Duration::from_secs(60),
            session_load: Duration::from_secs(90),
            cancel: Duration::from_secs(15),
        }
    }
}

/// v1 `ACP_DEFERRED_FINALIZE_DEBOUNCE` (deferredBackground.ts:45-47): Grok summaries can trail
/// hydrated tools by over two seconds.
pub const DEFERRED_FINALIZE_DEBOUNCE: Duration = Duration::from_millis(3000);

/// Starts ACP agent processes for one flavor.
#[derive(Clone)]
pub struct AcpEngineFactory {
    flavor: Arc<dyn AcpFlavor>,
    resolver: Option<AttachmentResolver>,
    timeouts: AcpTimeouts,
    client_version: String,
    /// GOAT's stdio MCP bridge for agents that do not take HTTP MCP (see [crate::mcp]).
    mcp_bridge: Option<McpBridgeCommand>,
    /// A provider probe: never sign in when the agent asks (v1 probe.ts `authenticateOnAuthRequired: false`).
    probe: bool,
    /// Instance settings for [EngineFactory::probe] (see [crate::probe::ProbeConfig]).
    pub(crate) probe_config: Arc<crate::probe::ProbeConfig>,
    /// How long a deferred turn waits after its background work ended before it finishes.
    deferred_finalize: Duration,
    /// How long a probe waits for the model catalog and the command list (v1 probe.ts:500-516;
    /// [crate::probe::MODEL_ADVERTISEMENT_GRACE], [crate::probe::COMMAND_ADVERTISEMENT_GRACE]).
    pub(crate) advertisement_graces: (Duration, Duration),
}

impl AcpEngineFactory {
    pub fn new(flavor: Arc<dyn AcpFlavor>) -> Self {
        Self {
            flavor,
            resolver: None,
            timeouts: AcpTimeouts::default(),
            client_version: env!("CARGO_PKG_VERSION").to_owned(),
            mcp_bridge: McpBridgeCommand::locate(),
            probe: false,
            probe_config: Arc::default(),
            deferred_finalize: DEFERRED_FINALIZE_DEBOUNCE,
            advertisement_graces: (
                crate::probe::MODEL_ADVERTISEMENT_GRACE,
                crate::probe::COMMAND_ADVERTISEMENT_GRACE,
            ),
        }
    }

    /// Use this debounce instead of [DEFERRED_FINALIZE_DEBOUNCE] (tests).
    pub fn with_deferred_finalize(mut self, debounce: Duration) -> Self {
        self.deferred_finalize = debounce;
        self
    }

    /// Use these advertisement waits instead of v1's (tests: a wait far longer than the probe
    /// deadline shows the deadline bounds it, round 7 part 8a.3).
    pub fn with_advertisement_graces(mut self, models: Duration, commands: Duration) -> Self {
        self.advertisement_graces = (models, commands);
        self
    }

    /// The factory for provider probes (see [crate::probe]): session setup that answers
    /// "authentication required" fails instead of signing in.
    pub fn for_probe(mut self) -> Self {
        self.probe = true;
        self
    }

    /// Use this bridge command instead of [McpBridgeCommand::locate].
    pub fn with_mcp_bridge(mut self, bridge: McpBridgeCommand) -> Self {
        self.mcp_bridge = Some(bridge);
        self
    }

    /// No stdio bridge: agents that need it fail to start (tests of the fail-closed path).
    pub fn without_mcp_bridge(mut self) -> Self {
        self.mcp_bridge = None;
        self
    }

    pub fn with_attachment_resolver(mut self, resolver: AttachmentResolver) -> Self {
        self.resolver = Some(resolver);
        self
    }

    pub fn with_timeouts(mut self, timeouts: AcpTimeouts) -> Self {
        self.timeouts = timeouts;
        self
    }

    pub fn flavor(&self) -> &Arc<dyn AcpFlavor> {
        &self.flavor
    }
}

impl std::fmt::Debug for AcpEngineFactory {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AcpEngineFactory")
            .field("driver", &self.flavor.driver())
            .finish_non_exhaustive()
    }
}

enum Pending {
    Permission {
        responder: ValueResponder,
        options: Vec<Value>,
    },
    Elicitation {
        responder: ValueResponder,
        form: Option<QuestionForm>,
        /// Legacy `session/elicitation` methods answer with the response nested in `action`.
        nested: bool,
    },
    /// A flavor's extension request waiting for the person (see [ExtRequest::AskUser]).
    ExtQuestion {
        responder: ValueResponder,
        answer: ExtAnswer,
    },
}

/// A question form: the generic mapping, or the flavor's own (v1 `extractElicitationForm`).
enum QuestionForm {
    Parsed(ElicitationForm),
    /// With the schema's `required` ids (v1 `withOptionalChoices`, `elicitationForm.ts:196-220`).
    Native(NativeElicitationForm, Vec<String>),
}

struct ActiveTurn {
    turn_id: String,
    projector: TurnProjector,
    /// The latest prompt of this turn; an earlier prompt's answer no longer settles it.
    prompt_seq: u64,
    interrupted: bool,
    settled_tx: watch::Sender<bool>,
    /// v1 `workAccepted`: the agent reported foreground work running during this turn.
    work_accepted: bool,
    /// The prompt answered while background work ran (v1 `promptSettled` with
    /// `deferFinalizeForBackgroundWork`): the turn finishes with this answer once the work ends.
    prompt_settled: Option<Result<Value, String>>,
    /// Bumped by every update during the deferral; a scheduled finalize runs only if current.
    finalize_generation: u64,
    /// An interrupt of a settled prompt keeps the agent running (v1 settled soft interrupt).
    preserve_runtime: bool,
}

#[derive(Default)]
struct State {
    turn: Option<ActiveTurn>,
    turn_counter: u64,
    prompt_counter: u64,
    request_counter: u64,
    ordinal: u32,
    pending: HashMap<String, Pending>,
    modes: Option<ModeState>,
    config_options: Vec<Value>,
    setup: SessionSetup,
    /// Text that goes in front of the next prompt (preamble, instructions without a system channel).
    preamble: Option<String>,
    runtime_mode: Option<goat2_contracts::RuntimeMode>,
    /// The whole selection last written (model options such as reasoning effort included); any
    /// change (model or options) is written again.
    model_selection: Option<ModelSelection>,
    /// The latest `available_commands_update` list (probes read it; v1 probe.ts:470-476).
    available_commands: Option<Vec<Value>>,
    /// Agent-native subagents (see [crate::subagents]).
    subagents: SubagentTracker,
    /// A `config_option_update` arrived; it replaces the setup response's options even when it
    /// is handled first (v1 probe.ts:545-547 prefers the update).
    config_options_from_update: bool,
    /// Tool calls with an update the driver could not read (see [UnreadToolCalls]).
    unread_tool_calls: UnreadToolCalls,
}

struct Shared {
    flavor: Arc<dyn AcpFlavor>,
    thread_id: ThreadId,
    events: mpsc::UnboundedSender<EngineEvent>,
    state: Mutex<State>,
    policy: Mutex<RuntimePolicy>,
    session_id: OnceLock<String>,
    init: OnceLock<InitializeInfo>,
    conn: OnceLock<Conn>,
    child: tokio::sync::Mutex<Option<ChildProcess>>,
    /// The agent's process group, set once it is spawned (the stderr hook must already point
    /// at this state).
    pgid: OnceLock<i32>,
    /// Why the flavor ended the connection ([StdoutLine::Fail]); reported with handshake errors.
    transport_failure: Mutex<Option<String>>,
    exited: AtomicBool,
    timeouts: AcpTimeouts,
    resolver: Option<AttachmentResolver>,
    shutdown_tx: Mutex<Option<oneshot::Sender<()>>>,
    /// Bumped when the agent advertises commands or config options (probes wait on it).
    advertised: watch::Sender<u64>,
    /// A provider probe (see [AcpEngineFactory::for_probe]).
    probe: bool,
    /// The sanitized stderr tail of an agent that exited (the process is gone by then).
    last_stderr: Mutex<String>,
    /// GOAT's MCP endpoint served over this connection, when the agent took it that way.
    mcp_over_acp: OnceLock<Arc<crate::mcp_over_acp::McpOverAcp>>,
    /// The environment the agent process runs with (v1 `watchPromptOutcome` reads it).
    agent_env: AgentEnv,
    deferred_finalize: Duration,
    cwd: String,
    /// The agent program the session launched (v1 Grok runs `grok inspect` with it).
    program: PathBuf,
}

fn emit(shared: &Shared, event: EngineEvent) {
    let _ = shared.events.send(event);
}

fn json_or_null<T: serde::Serialize>(value: &T) -> Value {
    serde_json::to_value(value).unwrap_or(Value::Null)
}

fn meta_of(map: Option<Map<String, Value>>) -> Option<agent_client_protocol::v1::schema::Meta> {
    map.and_then(|m| serde_json::from_value(Value::Object(m)).ok())
}

/// v1 `hasAcpDeferredBackgroundWork` (deferredBackground.ts:13-43): background tasks the turn
/// waits for, or subagents it started that still run.
fn deferred_work(state: &State, turn: &ActiveTurn) -> bool {
    turn.projector.has_deferred_background_work() || state.subagents.blocks_turn(&turn.turn_id)
}

impl Shared {
    fn conn(&self) -> Result<&Conn, EngineError> {
        self.conn
            .get()
            .ok_or_else(|| EngineError::Transport("ACP connection is not open".into()))
    }

    fn session_id(&self) -> String {
        self.session_id.get().cloned().unwrap_or_default()
    }

    /// Send a request and wait for its JSON answer.
    async fn request(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, agent_client_protocol::Error> {
        let conn = self
            .conn
            .get()
            .ok_or_else(agent_client_protocol::Error::internal_error)?;
        let message = UntypedMessage::new(method, params)?;
        match tokio::time::timeout(timeout, conn.send_request(message).block_task()).await {
            Ok(result) => result,
            Err(_) => Err(agent_client_protocol::Error::new(
                agent_client_protocol::ErrorCode::INTERNAL_ERROR,
                format!("{method} timed out after {} s", timeout.as_secs()),
            )),
        }
    }

    fn notify(&self, method: &str, params: Value) -> Result<(), EngineError> {
        let message = UntypedMessage::new(method, params)
            .map_err(|e| EngineError::Transport(e.to_string()))?;
        self.conn()?
            .send_notification(message)
            .map_err(|e| EngineError::Transport(e.to_string()))
    }

    // ---- inbound -------------------------------------------------------------------------

    fn on_notification(self: &Arc<Self>, method: &str, params: Value) {
        if let ("mcp/message", Some(bridge)) = (method, self.mcp_over_acp.get().cloned()) {
            tokio::spawn(async move {
                let _ = bridge.notify(&params).await;
            });
            return;
        }
        match method {
            "session/update" => {
                let params = self
                    .flavor
                    .normalize_update(normalize_v1_session_update(params));
                self.on_session_update(&params);
                self.rearm_deferred_finalize();
            }
            "elicitation/complete" | "session/elicitation/complete" => {
                if let Some(id) = text_field(&params, "elicitationId") {
                    let key = format!("elicitation:{id}");
                    if self
                        .state
                        .lock()
                        .expect("state")
                        .pending
                        .remove(&key)
                        .is_some()
                    {
                        emit(self, EngineEvent::RequestClosed { key });
                    }
                }
            }
            _ => {
                for event in self.flavor.ext_notification(method, &params) {
                    self.on_flavor_event(event);
                }
                self.rearm_deferred_finalize();
            }
        }
    }

    fn on_flavor_event(self: &Arc<Self>, event: FlavorEvent) {
        match event {
            FlavorEvent::SessionUpdate(params) => self.on_session_update(&params),
            FlavorEvent::Notice { message, warning } => {
                let mut out = Vec::new();
                {
                    let mut state = self.state.lock().expect("state");
                    if let Some(turn) = state.turn.as_mut() {
                        turn.projector.notice(message, warning, &mut out);
                    }
                }
                for event in out {
                    emit(self, event);
                }
            }
            FlavorEvent::AuthUrl(url) => self.auth_required(Some(url), None),
            FlavorEvent::PromptComplete {
                session_id,
                prompt_id,
                stop_reason,
            } => {
                // v1 xaiAcpExtension.ts:1381-1390: only a pending prompt of this session settles
                // (round 7 part 4.2). One session has at most one prompt pending here, which is
                // v1's "exactly one pending" rule for a notification without a prompt id.
                if self.session_id.get() != Some(&session_id) {
                    return;
                }
                let current = self
                    .state
                    .lock()
                    .expect("state")
                    .turn
                    .as_ref()
                    .map(|t| (t.turn_id.clone(), t.prompt_seq));
                if let Some((turn_id, seq)) = current
                    && prompt_id.is_none_or(|id| id == prompt_id_of(&turn_id, seq))
                {
                    self.settle(&turn_id, seq, Ok(json!({ "stopReason": stop_reason })));
                }
            }
            FlavorEvent::PromptFailed {
                session_id,
                prompt_id,
                message,
            } => {
                if self.session_id.get() != Some(&session_id) {
                    return;
                }
                let current = self
                    .state
                    .lock()
                    .expect("state")
                    .turn
                    .as_ref()
                    .map(|t| (t.turn_id.clone(), t.prompt_seq));
                if let Some((turn_id, seq)) = current
                    && prompt_id.is_none_or(|id| id == prompt_id_of(&turn_id, seq))
                {
                    self.settle(&turn_id, seq, Err(message));
                }
            }
            FlavorEvent::FinishSubagent {
                session_id,
                child_session_id,
                status,
                result,
            } => {
                // v1 adapter.ts:5431-5439: only for the session this runtime serves.
                if self.session_id.get() != Some(&session_id) {
                    return;
                }
                let mut out = Vec::new();
                {
                    let mut guard = self.state.lock().expect("state");
                    let state = &mut *guard;
                    let mut turn = state.turn.as_mut().map(|t| TurnRef {
                        turn_id: &t.turn_id,
                        projector: &mut t.projector,
                    });
                    state.subagents.finish(
                        self.flavor.as_ref(),
                        &child_session_id,
                        status,
                        result,
                        &mut turn,
                        &mut out,
                    );
                }
                for event in out {
                    emit(self, event);
                }
            }
            FlavorEvent::BackgroundTask {
                session_id,
                task_id,
                status,
                output,
            } => {
                if self.session_id.get() != Some(&session_id) {
                    return;
                }
                let mut out = Vec::new();
                if let Some(turn) = self.state.lock().expect("state").turn.as_mut() {
                    turn.projector
                        .background_task(&task_id, status, output.as_deref(), &mut out);
                }
                for event in out {
                    emit(self, event);
                }
            }
            FlavorEvent::ForegroundWork {
                session_id,
                running,
            } => {
                // v1 adapter.ts:5440-5478: idle after running during the turn completes it.
                if self.session_id.get() != Some(&session_id) {
                    return;
                }
                let settle = {
                    let mut state = self.state.lock().expect("state");
                    match state.turn.as_mut() {
                        Some(turn) if !turn.interrupted => {
                            if running {
                                turn.work_accepted = true;
                                None
                            } else if turn.work_accepted {
                                Some((turn.turn_id.clone(), turn.prompt_seq))
                            } else {
                                None
                            }
                        }
                        _ => None,
                    }
                };
                if let Some((turn_id, seq)) = settle {
                    self.settle(&turn_id, seq, Ok(json!({ "stopReason": "end_turn" })));
                }
            }
        }
    }

    fn auth_required(&self, url: Option<String>, message: Option<String>) {
        let turn_id = self
            .state
            .lock()
            .expect("state")
            .turn
            .as_ref()
            .map(|t| t.turn_id.clone());
        let message =
            message.unwrap_or_else(|| format!("Sign in to {} to continue.", self.flavor.driver()));
        emit(
            self,
            EngineEvent::AuthRequired {
                turn_id,
                url,
                message,
                key: None,
            },
        );
    }

    /// v1 `followsAgentWorkState` (adapter.ts:499-502): only on negotiated ACP v2.
    fn native_children(&self) -> bool {
        self.flavor.follows_agent_work_state()
            && self.init.get().is_some_and(|i| i.protocol_version == 2)
    }

    fn on_session_update(self: &Arc<Self>, params: &Value) {
        // v1 makeUndecodableNotificationHandler (autoAcceptEdits.ts:133-155): what an unreadable
        // update may have changed stays unknown to auto-accept (final review finding 2).
        if let Some((session, tool_call)) = unread_tool_call_update(params) {
            self.state
                .lock()
                .expect("state")
                .unread_tool_calls
                .add(session.as_deref(), tool_call.as_deref());
        }
        let Some(update) = params.get("update") else {
            return;
        };
        // Updates of other sessions are the agent's subagents (v1 adapter.ts:3817-3879).
        let child = text_field(params, "sessionId")
            .filter(|session| self.session_id.get().is_some_and(|own| own != session));
        // v1 adapter.ts:3880-3899: a frame of the agent's own wake turn after the prompt answered.
        // With background work still running it waits for a continuation run (which GOAT 2 does not
        // start); otherwise the turn finishes now. Either way it is not part of this turn.
        if child.is_none() && self.flavor.is_wake_notification(params) {
            let finish = {
                let state = self.state.lock().expect("state");
                match state.turn.as_ref() {
                    Some(turn) if turn.prompt_settled.is_some() => Some((
                        turn.turn_id.clone(),
                        turn.prompt_seq,
                        (!deferred_work(&state, turn))
                            .then(|| turn.prompt_settled.clone())
                            .flatten(),
                    )),
                    _ => None,
                }
            };
            if let Some((turn_id, seq, result)) = finish {
                if let Some(result) = result {
                    self.finalize(&turn_id, seq, result);
                }
                return;
            }
        }
        let native_children = self.native_children();
        let flavor = self.flavor.as_ref();
        let kind = update
            .get("sessionUpdate")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let mut out = Vec::new();
        {
            let mut guard = self.state.lock().expect("state");
            let state = &mut *guard;
            // ACP: after session/cancel the agent may still report what it was doing until it
            // answers the prompt; those updates belong to the turn.
            let mut turn = state.turn.as_mut().map(|t| TurnRef {
                turn_id: &t.turn_id,
                projector: &mut t.projector,
            });
            if let Some(event) = native_children
                .then(|| flavor.extract_subagent_session_event(params))
                .flatten()
            {
                state
                    .subagents
                    .session_event(flavor, event, &mut turn, &mut out);
            } else if let Some(child) = &child {
                state.subagents.child_update(
                    flavor,
                    native_children,
                    child,
                    update,
                    &mut turn,
                    &mut out,
                );
            } else {
                match kind {
                    "current_mode_update" => {
                        if let (Some(modes), Some(id)) =
                            (state.modes.as_mut(), text_field(update, "currentModeId"))
                        {
                            modes.current_mode_id = id;
                        }
                    }
                    "config_option_update" => {
                        if let Some(options) = update.get("configOptions").and_then(Value::as_array)
                        {
                            state.config_options = options.clone();
                            state.config_options_from_update = true;
                        }
                        self.advertised.send_modify(|n| *n += 1);
                    }
                    "available_commands_update" => {
                        state.available_commands = Some(
                            update
                                .get("availableCommands")
                                .and_then(Value::as_array)
                                .cloned()
                                .unwrap_or_default(),
                        );
                        self.advertised.send_modify(|n| *n += 1);
                        // The turn still shows the commands (v1 projects them too).
                        if let Some(turn) = turn.as_mut() {
                            turn.projector.apply(update, &mut out);
                        }
                    }
                    "tool_call" | "tool_call_update" => {
                        let route = state.subagents.root_tool(
                            flavor,
                            native_children,
                            update,
                            &mut turn,
                            &mut out,
                        );
                        if let (ToolRoute::Project(update), Some(turn)) = (route, turn.as_mut()) {
                            turn.projector.apply(&update, &mut out);
                        }
                    }
                    // v1 adapter.ts:4047-4111: injected user text carries background output (the
                    // projector's) and subagent ends (the tracker's, also after the turn).
                    "user_message_chunk" => {
                        if let Some(turn) = turn.as_mut() {
                            turn.projector.apply(update, &mut out);
                        }
                        let content = update.get("content");
                        if content.and_then(|c| c.get("type")).and_then(Value::as_str)
                            == Some("text")
                            && let Some(text) =
                                content.and_then(|c| c.get("text")).and_then(Value::as_str)
                        {
                            state
                                .subagents
                                .injected_user_text(flavor, text, &mut turn, &mut out);
                        }
                    }
                    _ => {
                        if let Some(turn) = turn.as_mut() {
                            turn.projector.apply(update, &mut out);
                        }
                    }
                }
            }
        }
        for event in out {
            emit(self, event);
        }
    }

    fn on_request(self: &Arc<Self>, method: &str, params: Value, responder: ValueResponder) {
        if let ("mcp/connect" | "mcp/message" | "mcp/disconnect", Some(bridge)) =
            (method, self.mcp_over_acp.get().cloned())
        {
            let method = method.to_owned();
            tokio::spawn(async move {
                let result = match method.as_str() {
                    "mcp/connect" => bridge.connect(&params),
                    "mcp/message" => bridge.message(&params).await,
                    _ => bridge.disconnect(&params).await,
                };
                let _ = match result {
                    Ok(value) => responder.respond(value),
                    Err(message) => {
                        responder.respond_with_error(agent_client_protocol::Error::new(
                            agent_client_protocol::ErrorCode::INTERNAL_ERROR,
                            message,
                        ))
                    }
                };
            });
            return;
        }
        match method {
            "session/request_permission" => self.on_permission(params, responder),
            "elicitation/create" => self.on_elicitation(params, responder, false),
            "session/elicitation" | "_session/elicitation" => {
                self.on_elicitation(params, responder, true)
            }
            // v1 adapter.ts:5081-5087: the flavor's client file reader, with the thread's folder.
            "fs/read_text_file" => {
                let cwd = self.policy.lock().expect("policy").cwd.clone();
                match self.flavor.read_text_file(&params, cwd.as_deref()) {
                    None => {
                        let _ = responder
                            .respond_with_error(agent_client_protocol::Error::method_not_found());
                    }
                    Some(read) => {
                        let _ = match read.response {
                            Ok(value) => responder.respond(value),
                            Err((code, message)) => responder.respond_with_error(
                                agent_client_protocol::Error::new(code, message),
                            ),
                        };
                        for event in read.events {
                            self.on_flavor_event(event);
                        }
                    }
                }
            }
            _ => match self.flavor.ext_request_action(method, &params) {
                ExtRequest::Respond(result) => {
                    let _ = responder.respond(result);
                }
                ExtRequest::Unhandled => {
                    let _ = responder
                        .respond_with_error(agent_client_protocol::Error::method_not_found());
                }
                ExtRequest::CapturePlan {
                    markdown,
                    fallback,
                    response,
                } => {
                    let mut out = Vec::new();
                    if let Some(turn) = self.state.lock().expect("state").turn.as_mut() {
                        // v1 `extractXAiExitPlanMarkdown(params, lastProposedPlanMarkdown)`.
                        let markdown = markdown
                            .or_else(|| turn.projector.last_proposed_plan())
                            .unwrap_or(fallback);
                        turn.projector.proposed_plan(markdown, &mut out);
                    }
                    for event in out {
                        emit(self, event);
                    }
                    let _ = responder.respond(response);
                }
                ExtRequest::AskUser {
                    native_id,
                    summary,
                    questions,
                    answer,
                } => self.on_ext_question(native_id, summary, questions, answer, responder),
            },
        }
    }

    fn on_permission(&self, params: Value, responder: ValueResponder) {
        let options: Vec<Value> = self.flavor.answerable_permission_options(
            params
                .get("options")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
        );
        let mut answerable_params = params.clone();
        if let Some(object) = answerable_params.as_object_mut() {
            object.insert("options".into(), Value::Array(options.clone()));
        }
        // v1 adapter.ts:5128-5147: a question asked through the permission method.
        match self.flavor.permission_request_action(&answerable_params) {
            None => {}
            Some(ExtRequest::AskUser {
                native_id,
                summary,
                questions,
                answer,
            }) => {
                self.on_ext_question(native_id, summary, questions, answer, responder);
                return;
            }
            Some(ExtRequest::Respond(value)) => {
                let _ = responder.respond(value);
                return;
            }
            Some(ExtRequest::Unhandled | ExtRequest::CapturePlan { .. }) => {
                let _ = responder.respond(cancelled());
                return;
            }
        }
        let policy = self.policy.lock().expect("policy").clone();
        let tool_call = params.get("toolCall").cloned().unwrap_or(Value::Null);
        // v1 adapter.ts:5148-5175 with autoAcceptPolicyRequest (autoAcceptEdits.ts:148-160): policy
        // reads every path this call's updates named, not only the request's (final review
        // finding 2). Tracked calls are the root session's.
        let policy_request = {
            let state = self.state.lock().expect("state");
            let session = text_field(&params, "sessionId");
            let own = session
                .as_deref()
                .is_none_or(|s| self.session_id.get().is_some_and(|own| own == s));
            let id = text_field(&tool_call, "toolCallId");
            let (kind, paths) = match (&id, state.turn.as_ref()) {
                (Some(id), Some(turn)) if own => turn.projector.tracked_call(id),
                _ => (None, None),
            };
            let unread = id.as_deref().is_some_and(|id| {
                state
                    .unread_tool_calls
                    .has(session.as_deref().unwrap_or_default(), id)
            });
            auto_accept_policy_request(&params, kind.as_deref(), paths.as_ref(), unread)
        };
        let disposition = self.flavor.permission_disposition(&policy, &policy_request);
        match disposition {
            Disposition::Allow => {
                // v1 `selectAutoApprovedPermissionOption`: allow-once first, then the flavor's
                // session choice (never a broader grant listed before it, final review finding 1).
                if let Some(option_id) = self
                    .flavor
                    .permission_option_id(&options, PermissionChoice::Accept)
                    .or_else(|| {
                        self.flavor
                            .permission_option_id(&options, PermissionChoice::AcceptForSession)
                    })
                {
                    let _ = responder.respond(selected(&option_id));
                    return;
                }
            }
            Disposition::Deny => {
                let _ = responder.respond(
                    self.flavor
                        .permission_option_id(&options, PermissionChoice::Decline)
                        .map(|id| selected(&id))
                        .unwrap_or_else(cancelled),
                );
                return;
            }
            Disposition::Ask => {}
        }
        let mut out = Vec::new();
        {
            let mut state = self.state.lock().expect("state");
            let Some(turn) = state.turn.as_mut() else {
                drop(state);
                let _ = responder.respond(cancelled());
                return;
            };
            let tool = turn.projector.observe_tool_call(&tool_call);
            turn.projector.close_segments(&mut out);
            let turn_id = turn.turn_id.clone();
            let tool_item = tool
                .as_ref()
                .map(|t| turn.projector.tool_item_id(&t.tool_call_id));
            state.request_counter += 1;
            let key = format!("permission:{}", state.request_counter);
            let kind = tool.as_ref().and_then(|t| t.kind.clone());
            let request_kind = match kind.as_deref() {
                Some("execute") => ProviderRequestKind::Command,
                Some("edit" | "delete" | "move") => ProviderRequestKind::FileChange,
                Some("read") => ProviderRequestKind::FileRead,
                _ => ProviderRequestKind::Permission,
            };
            let title = tool
                .as_ref()
                .and_then(|t| t.title.clone())
                .unwrap_or_else(|| "Permission requested".to_owned());
            let item = self.request_item(
                &mut state,
                &turn_id,
                &key,
                TurnItemBody::ApprovalRequest {
                    request_id: RequestId::new(key.as_str()),
                    request_kind,
                    prompt: Some(title.clone()),
                    reason: None,
                    options: Some(self.flavor.approval_options(&answerable_params)),
                },
            );
            state
                .pending
                .insert(key.clone(), Pending::Permission { responder, options });
            out.push(EngineEvent::RequestOpened {
                turn_id,
                key,
                item_id: tool_item,
                kind: RequestKind::Approval,
                summary: title,
                item: Some(Box::new(item)),
            });
        }
        for event in out {
            emit(self, event);
        }
    }

    fn request_item(
        &self,
        state: &mut State,
        turn_id: &str,
        key: &str,
        body: TurnItemBody,
    ) -> TurnItem {
        let now = rfc3339_ms(now_ms());
        let ordinal = state
            .turn
            .as_ref()
            .map(|t| t.projector.next_ordinal())
            .unwrap_or(state.ordinal);
        TurnItem {
            id: ItemId::new(format!("{turn_id}:request:{key}")),
            thread_id: self.thread_id.clone(),
            run_id: None,
            provider_thread_id: Some(self.session_id()),
            provider_turn_id: Some(turn_id.to_owned()),
            native_item_ref: None,
            parent_item_id: None,
            ordinal,
            status: TurnItemStatus::Waiting,
            title: None,
            started_at: Some(now.clone()),
            completed_at: None,
            updated_at: now,
            body,
        }
    }

    /// v1 `requestUserInput` for a flavor's extension request: open a question on the turn and keep
    /// the agent's request until the person answers; outside a turn it is dismissed.
    fn on_ext_question(
        &self,
        native_id: String,
        summary: String,
        questions: Vec<goat2_contracts::UserInputQuestion>,
        answer: ExtAnswer,
        responder: ValueResponder,
    ) {
        let mut out = Vec::new();
        {
            let mut state = self.state.lock().expect("state");
            let Some(turn_id) = state.turn.as_ref().map(|t| t.turn_id.clone()) else {
                drop(state);
                let _ = responder.respond(answer(None));
                return;
            };
            if let Some(turn) = state.turn.as_mut() {
                turn.projector.close_segments(&mut out);
            }
            // An id the agent reuses while its first request is open gets a unique key, so it
            // never replaces that request (final review 7-1 finding 3).
            let mut key = format!("question:{native_id}");
            if state.pending.contains_key(&key) {
                state.request_counter += 1;
                key = format!("{key}:{}", state.request_counter);
            }
            let item = self.request_item(
                &mut state,
                &turn_id,
                &key,
                TurnItemBody::UserInputRequest {
                    request_id: RequestId::new(key.as_str()),
                    questions,
                },
            );
            state
                .pending
                .insert(key.clone(), Pending::ExtQuestion { responder, answer });
            out.push(EngineEvent::RequestOpened {
                turn_id,
                key,
                item_id: None,
                kind: RequestKind::Question,
                summary,
                item: Some(Box::new(item)),
            });
        }
        for event in out {
            emit(self, event);
        }
    }

    fn on_elicitation(&self, params: Value, responder: ValueResponder, nested: bool) {
        let respond = |responder: ValueResponder, response: Value| {
            let value = if nested {
                json!({ "action": response })
            } else {
                response
            };
            let _ = responder.respond(value);
        };
        let mode = params.get("mode").and_then(Value::as_str).unwrap_or("form");
        let message = text_field(&params, "message").unwrap_or_default();
        let policy = self.policy.lock().expect("policy").clone();
        let native_id = text_field(&params, "elicitationId");
        if let Some(disposition) =
            mcp_tool_approval_elicitation_disposition(&policy, &params, native_id.as_deref())
            && disposition == Disposition::Allow
        {
            respond(responder, json!({"action": "accept", "content": {}}));
            return;
        }
        let mut out = Vec::new();
        {
            let mut state = self.state.lock().expect("state");
            let Some(turn_id) = state.turn.as_ref().map(|t| t.turn_id.clone()) else {
                drop(state);
                if mode == "url" {
                    // Outside a turn: the link goes to the host's session sign-in (kept in memory
                    // only) and the agent is told the person has it. A probe declines: nobody can
                    // consent there (v1 probe.ts:440-466 without a coordinator).
                    let url = text_field(&params, "url");
                    let action = if self.probe || url.is_none() {
                        "decline"
                    } else {
                        "accept"
                    };
                    self.auth_required(url, Some(message));
                    respond(responder, json!({ "action": action }));
                } else {
                    respond(responder, json!({"action": "cancel"}));
                }
                return;
            };
            if let Some(turn) = state.turn.as_mut() {
                turn.projector.close_segments(&mut out);
            }
            state.request_counter += 1;
            let key = match &native_id {
                // A reused id while the first is open gets a unique key (final review 7-1 finding 3).
                Some(id) if state.pending.contains_key(&format!("elicitation:{id}")) => {
                    format!("elicitation:{id}:{}", state.request_counter)
                }
                Some(id) => format!("elicitation:{id}"),
                None => format!("elicitation:{}", state.request_counter),
            };
            if mode == "url" {
                // v1 registry onUrlElicitation (adapter.ts:5329-5362, coordinator
                // requestUrlAuthentication): the agent's request stays open until the person
                // accepts or declines. The link goes only through AuthRequired, which the host
                // keeps in memory (SigninLink: links carry one-time codes and never enter the
                // thread log); its key is this request, answered by answer_request(key,
                // Accept | Decline) (engine-api step 3a). It names the turn, so the host ties it to
                // the run and declines it when the run ends (lane C): the agent then hears decline
                // and no session-level sign-in is left waiting.
                let Some(url) = text_field(&params, "url") else {
                    drop(state);
                    for event in out {
                        emit(self, event);
                    }
                    respond(responder, json!({"action": "decline"}));
                    return;
                };
                state.pending.insert(
                    key.clone(),
                    Pending::Elicitation {
                        responder,
                        form: None,
                        nested,
                    },
                );
                drop(state);
                for event in out {
                    emit(self, event);
                }
                emit(
                    self,
                    EngineEvent::AuthRequired {
                        turn_id: Some(turn_id),
                        url: Some(url),
                        message: if message.is_empty() {
                            format!("Sign in to {} to continue.", self.flavor.driver())
                        } else {
                            message
                        },
                        key: Some(key),
                    },
                );
                return;
            }
            let schema = params
                .get("requestedSchema")
                .cloned()
                .unwrap_or(Value::Null);
            // v1 adapter.ts:5367-5388: the flavor's own form first, then the generic mapping
            // (Devin's `cognition.ai/allowOther` lets a single choice take free text).
            let allow_other = params
                .get("_meta")
                .and_then(|m| m.get("cognition.ai/allowOther"))
                == Some(&Value::Bool(true));
            let form = match self.flavor.extract_elicitation_form(&params) {
                Some(native) => Some(QuestionForm::Native(
                    with_optional_choices(native, &schema),
                    required_ids(&schema),
                )),
                None => {
                    parse_elicitation_form(&schema, &message, allow_other).map(QuestionForm::Parsed)
                }
            };
            let Some(form) = form else {
                drop(state);
                for event in out {
                    emit(self, event);
                }
                respond(responder, json!({"action": "decline"}));
                return;
            };
            let questions = match &form {
                QuestionForm::Parsed(form) => form.questions.clone(),
                QuestionForm::Native(form, _) => form.questions.clone(),
            };
            let item = self.request_item(
                &mut state,
                &turn_id,
                &key,
                TurnItemBody::UserInputRequest {
                    request_id: RequestId::new(key.as_str()),
                    questions,
                },
            );
            state.pending.insert(
                key.clone(),
                Pending::Elicitation {
                    responder,
                    form: Some(form),
                    nested,
                },
            );
            out.push(EngineEvent::RequestOpened {
                turn_id,
                key,
                item_id: None,
                kind: RequestKind::Question,
                summary: if message.is_empty() {
                    "The agent has a question".into()
                } else {
                    message
                },
                item: Some(Box::new(item)),
            });
        }
        for event in out {
            emit(self, event);
        }
    }

    /// Answer every open request as cancelled (ACP: a cancelled prompt cancels its requests).
    fn cancel_pending(&self, state: &mut State, out: &mut Vec<EngineEvent>) {
        for (key, pending) in state.pending.drain() {
            match pending {
                Pending::Permission { responder, .. } => {
                    let _ = responder.respond(cancelled());
                }
                Pending::Elicitation {
                    responder, nested, ..
                } => {
                    let response = json!({"action": "cancel"});
                    let _ = responder.respond(if nested {
                        json!({ "action": response })
                    } else {
                        response
                    });
                }
                Pending::ExtQuestion { responder, answer } => {
                    let _ = responder.respond(answer(None));
                }
            }
            out.push(EngineEvent::RequestClosed { key });
        }
    }

    // ---- turns ---------------------------------------------------------------------------

    /// The prompt of `turn_id` answered (or failed). Settles the turn unless a later prompt took over.
    /// Returns whether the answer was the turn's (it settled the turn, or the turn now waits for
    /// its background work with this answer).
    fn settle(
        self: &Arc<Self>,
        turn_id: &str,
        prompt_seq: u64,
        result: Result<Value, String>,
    ) -> bool {
        {
            let mut guard = self.state.lock().expect("state");
            let state = &mut *guard;
            let Some(turn) = state.turn.as_ref() else {
                return false;
            };
            if turn.turn_id != turn_id
                || turn.prompt_seq != prompt_seq
                || turn.prompt_settled.is_some()
            {
                return false;
            }
            // v1 `deferFinalizeForBackgroundWork`: a finished prompt with background tasks or
            // subagents still running keeps the turn open until they end.
            let finished = match &result {
                Ok(response) => {
                    let stop = response
                        .get("stopReason")
                        .and_then(Value::as_str)
                        .unwrap_or("end_turn");
                    stop != "cancelled" && unfinished_stop_message(stop).is_none()
                }
                Err(_) => false,
            };
            if finished
                && !turn.interrupted
                && self.flavor.defers_finalize_for_background_work()
                && deferred_work(state, turn)
            {
                state.turn.as_mut().expect("turn").prompt_settled = Some(result);
                return true;
            }
        }
        self.finalize(turn_id, prompt_seq, result)
    }

    /// v1 `makeRearmDeferredFinalize` / `makeDeferredFinalizeScheduler` (deferredBackground.ts:
    /// 131-181, 224-233): once a deferred turn's background work has ended, finish it after the
    /// debounce unless another update arrives first.
    fn rearm_deferred_finalize(self: &Arc<Self>) {
        let (turn_id, prompt_seq, generation) = {
            let mut guard = self.state.lock().expect("state");
            let state = &mut *guard;
            let Some(turn) = state.turn.as_ref() else {
                return;
            };
            if turn.prompt_settled.is_none() || turn.interrupted || deferred_work(state, turn) {
                return;
            }
            let turn = state.turn.as_mut().expect("turn");
            turn.finalize_generation += 1;
            (
                turn.turn_id.clone(),
                turn.prompt_seq,
                turn.finalize_generation,
            )
        };
        let shared = Arc::clone(self);
        let debounce = self.deferred_finalize;
        tokio::spawn(async move {
            // The debounce is v1's settling window, not a synchronization: a newer update bumps the
            // generation and this run does nothing.
            if !debounce.is_zero() {
                tokio::time::sleep(debounce).await;
            }
            let result = {
                let state = shared.state.lock().expect("state");
                match state.turn.as_ref() {
                    Some(turn)
                        if turn.turn_id == turn_id
                            && turn.prompt_seq == prompt_seq
                            && turn.finalize_generation == generation
                            && !turn.interrupted
                            && !deferred_work(&state, turn) =>
                    {
                        turn.prompt_settled.clone()
                    }
                    _ => None,
                }
            };
            if let Some(result) = result {
                shared.finalize(&turn_id, prompt_seq, result);
            }
        });
    }

    /// End the turn with its prompt's answer. Returns whether it ended the turn.
    fn finalize(
        self: &Arc<Self>,
        turn_id: &str,
        prompt_seq: u64,
        result: Result<Value, String>,
    ) -> bool {
        let mut out = Vec::new();
        let mut restart = false;
        {
            let mut guard = self.state.lock().expect("state");
            let state = &mut *guard;
            let Some(turn) = state.turn.as_mut() else {
                return false;
            };
            if turn.turn_id != turn_id || turn.prompt_seq != prompt_seq {
                return false;
            }
            let interrupted = turn.interrupted;
            let (outcome, tool_status) = match &result {
                Ok(response) => {
                    let stop = response
                        .get("stopReason")
                        .and_then(Value::as_str)
                        .unwrap_or("end_turn");
                    if interrupted || stop == "cancelled" {
                        (TurnOutcome::Interrupted, TurnItemStatus::Interrupted)
                    } else if let Some(message) = unfinished_stop_message(stop) {
                        turn.projector.notice(message.to_owned(), true, &mut out);
                        (
                            TurnOutcome::Failed {
                                reason: message.to_owned(),
                            },
                            TurnItemStatus::Failed,
                        )
                    } else {
                        (TurnOutcome::Done, TurnItemStatus::Completed)
                    }
                }
                Err(_) if interrupted => (TurnOutcome::Interrupted, TurnItemStatus::Interrupted),
                Err(reason) => (
                    TurnOutcome::Failed {
                        reason: reason.clone(),
                    },
                    TurnItemStatus::Failed,
                ),
            };
            let preserve_runtime = turn.preserve_runtime;
            state.subagents.release_held_tools(&mut turn.projector);
            turn.projector.finish(tool_status, &mut out);
            state.subagents.turn_settled(
                turn_id,
                matches!(outcome, TurnOutcome::Done),
                preserve_runtime,
                &mut out,
            );
            let turn = state.turn.as_mut().expect("turn");
            let ordinal = turn.projector.next_ordinal();
            let _ = turn.settled_tx.send(true);
            state.ordinal = ordinal;
            state.turn = None;
            self.cancel_pending(state, &mut out);
            if interrupted && self.flavor.restart_after_interrupt() && !preserve_runtime {
                restart = true;
            }
            out.push(EngineEvent::TurnFinished {
                turn_id: turn_id.to_owned(),
                outcome,
            });
        }
        for event in out {
            emit(self, event);
        }
        if restart {
            // v1 `restartRuntimeAfterInterrupt`: the next turn starts a fresh process.
            self.terminate("restart after interrupt".into());
        }
        true
    }

    /// The prompt's content blocks, and whether `preamble` went in front of them.
    fn prompt_blocks(
        &self,
        inputs: &[EngineInput],
        preamble: Option<String>,
    ) -> Result<(Vec<ContentBlock>, bool), String> {
        let init = self.init.get().cloned().unwrap_or_default();
        let resolve =
            |a: &ChatAttachment| self.resolver.as_ref().and_then(|r| r(&self.thread_id, a));
        let mut text = inputs
            .iter()
            .map(|i| i.text.as_str())
            .collect::<Vec<_>>()
            .join("\n\n");
        text = self.flavor.rewrite_user_text(text);
        let attachments: Vec<&ChatAttachment> =
            inputs.iter().flat_map(|i| i.attachments.iter()).collect();
        // v1 providerMessageTextWithAttachmentPaths (attachmentPrompt.ts:154-176).
        for attachment in &attachments {
            let kind = match attachment.kind {
                ChatAttachmentType::Image => "image",
                ChatAttachmentType::File => "file",
            };
            let context = match resolve(attachment) {
                Some(path) => format!(
                    "[Attached {kind} \"{}\" is saved at: {}]",
                    attachment.name,
                    path.display()
                ),
                None => format!(
                    "[Attached {kind} \"{}\" is unavailable: could not resolve a saved path for attachment '{}'.]",
                    attachment.name, attachment.id
                ),
            };
            text = if text.is_empty() {
                context
            } else {
                format!("{text}\n\n{context}")
            };
        }
        let mut blocks = Vec::new();
        // Slash commands must stay first: v1 acpAppContext.ts:63-64 skips the context for them and
        // does not commit it, so the next prompt still carries it (final review finding 10).
        let mut sent_preamble = false;
        if let Some(preamble) = preamble.filter(|p| !p.trim().is_empty())
            && !text.trim_start().starts_with('/')
        {
            blocks.push(ContentBlock::Text(TextContent::new(preamble)));
            sent_preamble = true;
        }
        if !text.is_empty() {
            blocks.push(ContentBlock::Text(TextContent::new(text)));
        }
        let resolved: Vec<(&ChatAttachment, Option<PathBuf>)> =
            attachments.iter().map(|a| (*a, resolve(a))).collect();
        let prompt_attachments: Vec<PromptAttachment<'_>> = resolved
            .iter()
            .map(|(attachment, path)| PromptAttachment {
                attachment,
                path: path.as_deref(),
            })
            .collect();
        let config_options = self.state.lock().expect("state").config_options.clone();
        if let Some(result) =
            self.flavor
                .prompt_attachment_blocks(&init, &config_options, &prompt_attachments)
        {
            for value in result? {
                blocks.push(
                    serde_json::from_value::<ContentBlock>(value)
                        .map_err(|e| format!("Invalid attachment content: {e}"))?,
                );
            }
        } else if self.flavor.supports_image_prompts(&init) {
            for attachment in attachments.iter().filter(|a| {
                a.kind == ChatAttachmentType::Image
                    && ["image/gif", "image/jpeg", "image/png", "image/webp"]
                        .contains(&a.mime_type.as_str())
            }) {
                let path = resolve(attachment)
                    .ok_or_else(|| format!("Invalid attachment id '{}'", attachment.id))?;
                let bytes = std::fs::read(&path)
                    .map_err(|_| format!("Failed to read attachment '{}'", attachment.id))?;
                use base64::Engine as _;
                let data = base64::engine::general_purpose::STANDARD.encode(bytes);
                blocks.push(ContentBlock::Image(ImageContent::new(
                    data,
                    attachment.mime_type.clone(),
                )));
            }
        }
        if blocks.is_empty() {
            return Err("A turn requires text or supported attachments.".into());
        }
        Ok((blocks, sent_preamble))
    }

    /// Send one `session/prompt` for `turn_id`; its answer settles the turn in the background.
    fn send_prompt(
        self: &Arc<Self>,
        turn_id: String,
        prompt_seq: u64,
        blocks: Vec<ContentBlock>,
    ) -> Result<(), String> {
        let conn = self.conn().map_err(|e| e.to_string())?.clone();
        self.flavor.prompt_sent(&self.session_id());
        let mut request = PromptRequest::new(self.session_id(), blocks);
        if let Some(meta) = meta_of(self.flavor.prompt_meta(&prompt_id_of(&turn_id, prompt_seq))) {
            request = request.meta(meta);
        }
        let message = UntypedMessage::new("session/prompt", request).map_err(|e| e.to_string())?;
        // v1 `watchPromptOutcome` (adapter.ts:6812-6830) starts before the prompt is sent.
        let watch = self
            .flavor
            .watch_prompt_outcome(&self.session_id(), &self.agent_env);
        let sent = conn.send_request(message);
        let shared = Arc::clone(self);
        tokio::spawn(async move {
            match sent.block_task().await {
                Ok(response) => {
                    let failure = match watch {
                        Some(check) => {
                            let seen = response.clone();
                            tokio::task::spawn_blocking(move || check.check(&seen))
                                .await
                                .ok()
                                .flatten()
                        }
                        None => None,
                    };
                    match failure {
                        // A failure the stop reason hid restarts the agent before the next turn.
                        Some(message) => {
                            if shared.settle(&turn_id, prompt_seq, Err(message)) {
                                shared.terminate("restart after a failed prompt outcome".into());
                            }
                        }
                        None => {
                            shared.settle(&turn_id, prompt_seq, Ok(response));
                        }
                    }
                }
                Err(error) => {
                    // v1 `restartRuntimeAfterPromptError` (adapter.ts:6982-6989).
                    let restart = shared.flavor.restart_after_prompt_error(&PromptError {
                        code: error.code.into(),
                        message: error.message.clone(),
                        data: error.data.clone(),
                    });
                    if shared.settle(&turn_id, prompt_seq, Err(error.to_string())) && restart {
                        shared.terminate("restart after a prompt error".into());
                    }
                }
            }
        });
        Ok(())
    }

    async fn apply_settings(&self, settings: &TurnSettings) -> Result<(), String> {
        let (mode_changed, first_mode_write, model_changed) = {
            let state = self.state.lock().expect("state");
            (
                state.runtime_mode != Some(settings.runtime_mode),
                state.runtime_mode.is_none(),
                state.model_selection.as_ref() != Some(&settings.model_selection),
            )
        };
        if mode_changed {
            self.policy.lock().expect("policy").runtime_mode = settings.runtime_mode;
            let (modes, config_options) = {
                let state = self.state.lock().expect("state");
                (state.modes.clone(), state.config_options.clone())
            };
            let context = ModeContext {
                modes: modes.as_ref(),
                config_options: &config_options,
                first_write: first_mode_write,
            };
            match self.flavor.mode_write(settings.runtime_mode, &context) {
                ModeWrite::Keep => {}
                ModeWrite::Unavailable(message) => return Err(message),
                ModeWrite::SetMode(mode_id) => {
                    let request = SetSessionModeRequest::new(self.session_id(), mode_id.clone());
                    self.request(
                        "session/set_mode",
                        json_or_null(&request),
                        self.timeouts.request,
                    )
                    .await
                    .map_err(|e| format!("session/set_mode {mode_id}: {e}"))?;
                    if let Some(modes) = self.state.lock().expect("state").modes.as_mut() {
                        modes.current_mode_id = mode_id;
                    }
                }
                ModeWrite::Config(write) => {
                    self.write_config(&write).await?;
                    if let (Some(modes), Some(mode_id)) = (
                        self.state.lock().expect("state").modes.as_mut(),
                        write.value.as_str(),
                    ) {
                        modes.current_mode_id = mode_id.to_owned();
                    }
                }
            }
            self.state.lock().expect("state").runtime_mode = Some(settings.runtime_mode);
        }
        if model_changed {
            let setup = {
                let state = self.state.lock().expect("state");
                let mut setup = state.setup.clone();
                setup.config_options = state.config_options.clone();
                setup
            };
            let init = self.init.get().cloned().unwrap_or_default();
            let write = self
                .flavor
                .model_write_for(&settings.model_selection, &setup, &init);
            self.apply_model_write(write).await?;
            self.state.lock().expect("state").model_selection =
                Some(settings.model_selection.clone());
        }
        Ok(())
    }

    /// Run one [ModelWrite].
    fn apply_model_write(&self, write: ModelWrite) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            match write {
                ModelWrite::Keep => {}
                ModelWrite::Unavailable { message } => return Err(message),
                ModelWrite::ConfigOption { config_id, value } => {
                    let request = json!({
                        "sessionId": self.session_id(),
                        "configId": config_id,
                        "value": value,
                    });
                    let response = self
                        .request("session/set_config_option", request, self.timeouts.request)
                        .await
                        .map_err(|e| {
                            format!("session/set_config_option {config_id}={value}: {e}")
                        })?;
                    if let Some(options) = response.get("configOptions").and_then(Value::as_array) {
                        self.state.lock().expect("state").config_options = options.clone();
                    }
                }
                ModelWrite::SetModel { model_id, meta } => {
                    let mut params = json!({"sessionId": self.session_id(), "modelId": model_id});
                    if let Some(meta) = meta {
                        params["_meta"] = Value::Object(meta);
                    }
                    self.request("session/set_model", params, self.timeouts.request)
                        .await
                        .map_err(|e| format!("session/set_model {model_id}: {e}"))?;
                }
                ModelWrite::ConfigOptions(writes) => {
                    for write in &writes {
                        self.write_config(write).await?;
                    }
                }
                ModelWrite::Sequence(writes) => {
                    for write in writes {
                        self.apply_model_write(write).await?;
                    }
                }
                ModelWrite::OrElse(first, second) => {
                    if self.apply_model_write(*first).await.is_err() {
                        self.apply_model_write(*second).await?;
                    }
                }
                ModelWrite::OptionalConfigByCategory { category, value } => {
                    let option = self
                        .state
                        .lock()
                        .expect("state")
                        .config_options
                        .iter()
                        .find(|o| {
                            str_field(o, "type") == Some("select")
                                && str_field(o, "category") == Some(category.as_str())
                        })
                        .cloned();
                    let Some(option) = option else {
                        return Ok(());
                    };
                    let offered = select_values(&option).iter().any(|(v, _)| *v == value);
                    if !offered || str_field(&option, "currentValue") == Some(value.as_str()) {
                        return Ok(());
                    }
                    let Some(config_id) = config_option_id(&option).map(str::to_owned) else {
                        return Ok(());
                    };
                    // A rejected effort is skipped and the agent's default applies.
                    let _ = self
                        .apply_model_write(ModelWrite::ConfigOption { config_id, value })
                        .await;
                }
            }
            Ok(())
        })
    }

    /// v1 runtime `setConfigOption` (AcpSessionRuntime.ts:1023-1075, 1363-1420) and the
    /// `configureSession` option loop's skips (adapter.ts:6076-6113).
    async fn write_config(&self, write: &ConfigWrite) -> Result<(), String> {
        let shown = match &write.value {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        };
        let options = self.state.lock().expect("state").config_options.clone();
        let option = options
            .iter()
            .find(|o| crate::wire::config_option_id(o) == Some(write.config_id.as_str()));
        match option {
            None if write.optional => return Ok(()),
            None => {}
            Some(option) => {
                let kind = option.get("type").and_then(Value::as_str);
                if kind == Some("boolean") && !write.value.is_boolean() {
                    if write.optional {
                        return Ok(());
                    }
                    return Err(format!(
                        "Invalid value \"{shown}\" for session config option \"{}\": expected boolean",
                        write.config_id
                    ));
                }
                if kind != Some("boolean") {
                    let Some(value) = write.value.as_str() else {
                        if write.optional {
                            return Ok(());
                        }
                        return Err(format!(
                            "Invalid value {shown} for session config option \"{}\": expected string",
                            write.config_id
                        ));
                    };
                    let allowed: Vec<String> = crate::wire::select_values(option)
                        .into_iter()
                        .map(|(value, _)| value)
                        .collect();
                    if kind == Some("select") && !allowed.iter().any(|a| a == value) {
                        if write.optional {
                            return Ok(());
                        }
                        if !write.allow_unlisted {
                            return Err(format!(
                                "Invalid value \"{value}\" for session config option \"{}\": expected one of {}",
                                write.config_id,
                                allowed.join(", ")
                            ));
                        }
                    }
                }
                if !write.resend_current && option.get("currentValue") == Some(&write.value) {
                    return Ok(());
                }
            }
        }
        let mut request = json!({
            "sessionId": self.session_id(),
            "configId": write.config_id,
            "value": write.value,
        });
        if write.value.is_boolean() {
            request["type"] = json!("boolean");
        }
        match self
            .request("session/set_config_option", request, self.timeouts.request)
            .await
        {
            Ok(response) => {
                if let Some(options) = response.get("configOptions").and_then(Value::as_array) {
                    self.state.lock().expect("state").config_options = options.clone();
                }
                Ok(())
            }
            Err(error)
                if write.optional
                    && error.code == agent_client_protocol::ErrorCode::INVALID_PARAMS =>
            {
                Ok(())
            }
            Err(error) => Err(format!(
                "session/set_config_option {}={shown}: {error}",
                write.config_id
            )),
        }
    }

    /// v1 an `onStderr` transport error: the open turn fails with `message` and the process ends,
    /// so the next turn starts a fresh one.
    fn fail_process(self: &Arc<Self>, message: String) {
        let current = self
            .state
            .lock()
            .expect("state")
            .turn
            .as_ref()
            .map(|t| (t.turn_id.clone(), t.prompt_seq));
        if let Some((turn_id, seq)) = current {
            self.settle(&turn_id, seq, Err(message.clone()));
        }
        self.terminate(message);
    }

    fn terminate(self: &Arc<Self>, reason: String) {
        let shared = Arc::clone(self);
        tokio::spawn(async move {
            shared.stop(reason).await;
        });
    }

    async fn stop(&self, reason: String) {
        if let Some(bridge) = self.mcp_over_acp.get() {
            bridge.dispose().await;
        }
        if let Some(tx) = self.shutdown_tx.lock().expect("shutdown").take() {
            let _ = tx.send(());
        }
        if let Some(mut child) = self.child.lock().await.take() {
            child.shutdown().await;
        }
        self.on_exit(reason);
    }

    /// The process or connection ended: fail an open turn, then `Exited` once.
    fn on_exit(&self, reason: String) {
        if self.exited.swap(true, Ordering::SeqCst) {
            return;
        }
        let mut out = Vec::new();
        {
            let mut guard = self.state.lock().expect("state");
            let state = &mut *guard;
            state.subagents.exited(&mut out);
            if let Some(mut turn) = state.turn.take() {
                let status = if turn.interrupted {
                    TurnItemStatus::Interrupted
                } else {
                    TurnItemStatus::Failed
                };
                turn.projector.finish(status, &mut out);
                let _ = turn.settled_tx.send(true);
                out.push(EngineEvent::TurnFinished {
                    turn_id: turn.turn_id.clone(),
                    outcome: if turn.interrupted {
                        TurnOutcome::Interrupted
                    } else {
                        TurnOutcome::Failed {
                            reason: format!("agent exited: {reason}"),
                        }
                    },
                });
            }
            self.cancel_pending(state, &mut out);
        }
        for event in out {
            emit(self, event);
        }
        if let Some(session) = self.session_id.get() {
            self.flavor.release_runtime(session);
        }
        emit(self, EngineEvent::Exited { reason });
    }
}

/// v1 `makeStrictNdJsonRpcParser` (effect-acp strictParser.ts:18-30): the longest stdout line, in
/// characters (v1 counts UTF-16 units; this counts Unicode scalar values).
const MAX_FRAME_CHARS: usize = 16 * 1024 * 1024;

/// A line's bytes are capped at four times [MAX_FRAME_CHARS] while it is read, so memory stays
/// bounded however the bytes decode (final review 7-1 finding 1).
const MAX_FRAME_BYTES: usize = 4 * MAX_FRAME_CHARS;

/// Characters `String::from_utf8_lossy` makes of `bytes`: each valid character, plus one U+FFFD per
/// invalid sequence, as v1's `TextDecoder` output that strictParser counts.
fn lossy_char_count(bytes: &[u8]) -> usize {
    bytes
        .utf8_chunks()
        .map(|chunk| chunk.valid().chars().count() + usize::from(!chunk.invalid().is_empty()))
        .sum()
}

/// Read one stdout line (newline included), at most [MAX_FRAME_CHARS] characters as decoded: a
/// longer line fails the connection (final review finding 5; v1 effect-acp strictParser.ts:17-30
/// decodes, then counts). Invalid UTF-8 is replaced, as v1's `TextDecoder` does, and counts as one
/// character per invalid sequence. None at end of file.
pub(crate) async fn read_frame<R: tokio::io::AsyncBufRead + Unpin>(
    reader: &mut R,
) -> std::io::Result<Option<String>> {
    let too_big = || {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "ACP frame exceeds the maximum size",
        )
    };
    let mut line: Vec<u8> = Vec::new();
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            if line.is_empty() {
                return Ok(None);
            }
            if lossy_char_count(&line) > MAX_FRAME_CHARS {
                return Err(too_big());
            }
            return Ok(Some(String::from_utf8_lossy(&line).into_owned()));
        }
        let newline = available.iter().position(|b| *b == b'\n');
        let take = newline.map_or(available.len(), |i| i + 1);
        if line.len() + take > MAX_FRAME_BYTES + 1 {
            return Err(too_big());
        }
        line.extend_from_slice(&available[..take]);
        reader.consume(take);
        if newline.is_some() {
            if lossy_char_count(&line[..line.len() - 1]) > MAX_FRAME_CHARS {
                return Err(too_big());
            }
            return Ok(Some(String::from_utf8_lossy(&line).into_owned()));
        }
    }
}

/// The id GOAT gives each `session/prompt` of a turn.
pub fn prompt_id_of(turn_id: &str, prompt_seq: u64) -> String {
    format!("{turn_id}:{prompt_seq}")
}

fn selected(option_id: &str) -> Value {
    json!({"outcome": {"outcome": "selected", "optionId": option_id}})
}

fn cancelled() -> Value {
    json!({"outcome": {"outcome": "cancelled"}})
}

fn is_auth_required(error: &agent_client_protocol::Error) -> bool {
    error.code == agent_client_protocol::ErrorCode::AUTH_REQUIRED
}

/// The schema's `required` ids.
fn required_ids(schema: &Value) -> Vec<String> {
    schema
        .get("required")
        .and_then(Value::as_array)
        .map(|ids| {
            ids.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

/// v1 `withOptionalChoices` (elicitationForm.ts:196-220): a single-choice question the schema
/// does not require is optional.
fn with_optional_choices(mut form: NativeElicitationForm, schema: &Value) -> NativeElicitationForm {
    let required = required_ids(schema);
    let properties = schema.get("properties").and_then(Value::as_object);
    for question in &mut form.questions {
        if question.required.is_none()
            && question.multi_select != Some(true)
            && !question.options.is_empty()
            && properties.is_some_and(|p| p.contains_key(&question.id))
            && !required.contains(&question.id)
        {
            question.required = Some(false);
        }
    }
    form
}

/// The session controller handed to the host.
pub struct AcpSession {
    shared: Arc<Shared>,
}

impl AcpSession {
    /// What `initialize` reported.
    pub fn initialize_info(&self) -> InitializeInfo {
        self.shared.init.get().cloned().unwrap_or_default()
    }

    /// The session setup with the latest config options and modes.
    pub fn session_setup(&self) -> SessionSetup {
        let state = self.shared.state.lock().expect("state");
        let mut setup = state.setup.clone();
        setup.config_options = state.config_options.clone();
        setup.modes = state.modes.clone();
        setup
    }

    /// The latest `available_commands_update` list, if the agent sent one.
    pub fn available_commands(&self) -> Option<Vec<Value>> {
        self.shared
            .state
            .lock()
            .expect("state")
            .available_commands
            .clone()
    }

    /// Wait up to `models_grace` for a model catalog (when setup had none) and up to
    /// `commands_grace` for the command list, concurrently (v1 probe.ts:500-516).
    pub async fn wait_for_advertisements(&self, models_grace: Duration, commands_grace: Duration) {
        fn has_models(shared: &Shared) -> bool {
            let state = shared.state.lock().expect("state");
            state.setup.models.is_some()
                || crate::wire::find_model_config_option(&state.config_options).is_some()
        }
        fn has_commands(shared: &Shared) -> bool {
            shared
                .state
                .lock()
                .expect("state")
                .available_commands
                .is_some()
        }
        async fn until(shared: &Shared, grace: Duration, ready: fn(&Shared) -> bool) {
            let mut rx = shared.advertised.subscribe();
            if ready(shared) {
                return;
            }
            let _ = tokio::time::timeout(grace, async {
                while rx.changed().await.is_ok() {
                    if ready(shared) {
                        return;
                    }
                }
            })
            .await;
        }
        tokio::join!(
            until(&self.shared, models_grace, has_models),
            until(&self.shared, commands_grace, has_commands)
        );
    }

    /// v1 `AcpSessionRuntime.setConfigOption` (AcpSessionRuntime.ts:1023-1075): one config write
    /// as given, without the model-selection rules of [EngineSession::set_config] (model discovery
    /// writes the agent's own values, `default` included, modelDiscovery.ts:33-91).
    pub async fn set_config_option(&self, write: &ConfigWrite) -> Result<(), EngineError> {
        self.shared
            .write_config(write)
            .await
            .map_err(EngineError::Unavailable)
    }

    /// `session/delete` when the agent advertises it (v1 probe.ts:493-498); otherwise nothing.
    pub async fn delete_session(&self, timeout: Duration) -> Result<(), EngineError> {
        let init = self.shared.init.get().cloned().unwrap_or_default();
        if !init.session_delete {
            return Ok(());
        }
        let Some(session_id) = self.shared.session_id.get().cloned() else {
            return Ok(());
        };
        self.shared
            .request(
                "session/delete",
                json!({ "sessionId": session_id }),
                timeout,
            )
            .await
            .map(|_| ())
            .map_err(|e| EngineError::Transport(e.to_string()))
    }

    /// The capabilities negotiated with the started agent (v1 `negotiatedCapabilities`).
    pub fn negotiated_capabilities(&self) -> ProviderCapabilities {
        let init = self.shared.init.get().cloned().unwrap_or_default();
        let state = self.shared.state.lock().expect("state");
        let can_switch = crate::wire::find_model_config_option(&state.config_options).is_some()
            || state.setup.models.is_some();
        crate::capabilities::negotiated_capabilities(
            &self.shared.flavor.capabilities(),
            &init,
            can_switch,
            self.shared.flavor.steers_with_prompt(&init),
        )
    }
}

#[async_trait]
impl EngineSession for AcpSession {
    async fn start_turn(
        &self,
        inputs: Vec<EngineInput>,
        settings: &TurnSettings,
    ) -> TurnStartResult {
        let shared = &self.shared;
        if shared.exited.load(Ordering::SeqCst) {
            return TurnStartResult::Declined {
                reason: "the agent process has ended".into(),
            };
        }
        if shared.state.lock().expect("state").turn.is_some() {
            return TurnStartResult::Declined {
                reason: "a turn is already running".into(),
            };
        }
        if let Err(reason) = shared.apply_settings(settings).await {
            return TurnStartResult::Declined { reason };
        }
        let mut inputs = inputs;
        if let Some(first) = inputs.first_mut() {
            let context = PromptContext {
                cwd: shared.cwd.clone(),
                program: shared.program.clone(),
                launch_env: shared.agent_env.set.clone(),
            };
            first.text = shared
                .flavor
                .rewrite_user_text_for(std::mem::take(&mut first.text), &context)
                .await;
        }
        let preamble = shared.state.lock().expect("state").preamble.clone();
        let (blocks, sent_preamble) = match shared.prompt_blocks(&inputs, preamble) {
            Ok(prompt) => prompt,
            Err(reason) => return TurnStartResult::Declined { reason },
        };
        let (turn_id, prompt_seq) = {
            let mut state = shared.state.lock().expect("state");
            if state.turn.is_some() {
                return TurnStartResult::Declined {
                    reason: "a turn is already running".into(),
                };
            }
            state.turn_counter += 1;
            state.prompt_counter += 1;
            let turn_id = format!("acp-turn-{}-{}", shared.session_id(), state.turn_counter);
            let (settled_tx, _) = watch::channel(false);
            let projector = TurnProjector::new(
                shared.thread_id.clone(),
                shared.flavor.driver(),
                shared.session_id(),
                turn_id.clone(),
                state.ordinal,
            )
            .with_flavor(Arc::clone(&shared.flavor), shared.agent_env.set.clone());
            state.turn = Some(ActiveTurn {
                turn_id: turn_id.clone(),
                projector,
                prompt_seq: state.prompt_counter,
                interrupted: false,
                settled_tx,
                work_accepted: false,
                prompt_settled: None,
                finalize_generation: 0,
                preserve_runtime: false,
            });
            if sent_preamble {
                state.preamble = None;
            }
            (turn_id, state.prompt_counter)
        };
        match shared.send_prompt(turn_id.clone(), prompt_seq, blocks) {
            Ok(()) => TurnStartResult::Accepted { turn_id },
            Err(reason) => {
                let mut state = shared.state.lock().expect("state");
                state.turn = None;
                TurnStartResult::Unknown { reason }
            }
        }
    }

    async fn steer(&self, turn_id: &str, inputs: Vec<EngineInput>) -> SteerResult {
        let shared = &self.shared;
        let init = shared.init.get().cloned().unwrap_or_default();
        if !shared.flavor.steers_with_prompt(&init) {
            // ACP steers by interrupt and restart (capabilities.ts:39); the host does that.
            return SteerResult::Declined {
                reason: "this agent takes a new message only between turns".into(),
            };
        }
        let blocks = match shared.prompt_blocks(&inputs, None) {
            Ok((blocks, _)) => blocks,
            Err(reason) => return SteerResult::Declined { reason },
        };
        let prompt_seq = {
            let mut state = shared.state.lock().expect("state");
            state.prompt_counter += 1;
            let next = state.prompt_counter;
            match state.turn.as_mut() {
                // A prompt already answered and waiting to finish (deferred finalize) takes no steer:
                // its next prompt's answer would be ignored (final review 7-1 finding 4).
                Some(turn) if turn.turn_id == turn_id && turn.prompt_settled.is_some() => {
                    return SteerResult::Declined {
                        reason: format!("turn {turn_id} is finishing"),
                    };
                }
                Some(turn) if turn.turn_id == turn_id && !turn.interrupted => {
                    turn.prompt_seq = next;
                    next
                }
                Some(_) => {
                    return SteerResult::RefusedUnowned {
                        reason: format!("turn {turn_id} is not the running turn"),
                    };
                }
                None => {
                    return SteerResult::Declined {
                        reason: format!("turn {turn_id} ended before it could be steered"),
                    };
                }
            }
        };
        match shared.send_prompt(turn_id.to_owned(), prompt_seq, blocks) {
            Ok(()) => SteerResult::Accepted,
            Err(reason) => SteerResult::Unknown { reason },
        }
    }

    async fn interrupt(&self, turn_id: &str) -> Result<(), EngineError> {
        let shared = &self.shared;
        // v1 adapter.ts:7874-8082: the prompt already answered and the turn waits for background
        // work. There is no prompt to cancel, so the turn ends here; with
        // `preserveRuntimeOnSettledInterrupt` the agent is neither cancelled nor restarted and its
        // MCP calls keep running (`stopMcpCalls: !settledSoftInterrupt`), so its background work
        // goes on.
        let settled = {
            let mut out = Vec::new();
            let settled = {
                let mut state = shared.state.lock().expect("state");
                match state.turn.as_mut() {
                    Some(turn) if turn.turn_id == turn_id && turn.prompt_settled.is_some() => {
                        turn.interrupted = true;
                        turn.preserve_runtime =
                            shared.flavor.preserve_runtime_on_settled_interrupt();
                        let settled = (
                            turn.prompt_seq,
                            turn.prompt_settled.clone(),
                            turn.preserve_runtime,
                        );
                        shared.cancel_pending(&mut state, &mut out);
                        if !settled.2
                            && let Some(bridge) = shared.mcp_over_acp.get()
                        {
                            bridge.stop_calls();
                        }
                        Some(settled)
                    }
                    _ => None,
                }
            };
            for event in out {
                emit(shared, event);
            }
            settled
        };
        if let Some((prompt_seq, Some(result), preserve)) = settled {
            if !preserve {
                let mut cancel = CancelNotification::new(shared.session_id());
                if let Some(meta) = meta_of(shared.flavor.cancel_meta()) {
                    cancel = cancel.meta(meta);
                }
                let _ = shared.notify("session/cancel", json_or_null(&cancel));
            }
            shared.finalize(turn_id, prompt_seq, result);
            return Ok(());
        }
        let mut settled_rx = {
            let mut out = Vec::new();
            let rx = {
                let mut state = shared.state.lock().expect("state");
                let Some(turn) = state.turn.as_mut() else {
                    return Ok(());
                };
                if turn.turn_id != turn_id {
                    return Ok(());
                }
                turn.interrupted = true;
                let rx = turn.settled_tx.subscribe();
                shared.cancel_pending(&mut state, &mut out);
                // v1 cancelPendingRuntimeRequests: MCP calls the agent made over ACP stop too.
                if let Some(bridge) = shared.mcp_over_acp.get() {
                    bridge.stop_calls();
                }
                rx
            };
            for event in out {
                emit(shared, event);
            }
            rx
        };
        let mut cancel = CancelNotification::new(shared.session_id());
        if let Some(meta) = meta_of(shared.flavor.cancel_meta()) {
            cancel = cancel.meta(meta);
        }
        let _ = shared.notify("session/cancel", json_or_null(&cancel));
        if shared.flavor.settles_prompt_on_cancel() {
            let prompt_seq = shared
                .state
                .lock()
                .expect("state")
                .turn
                .as_ref()
                .filter(|t| t.turn_id == turn_id)
                .map(|t| t.prompt_seq);
            if let Some(seq) = prompt_seq {
                shared.settle(turn_id, seq, Ok(json!({"stopReason": "cancelled"})));
            }
        }
        let waited = tokio::time::timeout(shared.timeouts.cancel, async {
            while !*settled_rx.borrow() {
                if settled_rx.changed().await.is_err() {
                    break;
                }
            }
        })
        .await;
        if waited.is_err() {
            // The agent did not settle its prompt: end the turn here and replace the process.
            let prompt_seq = shared
                .state
                .lock()
                .expect("state")
                .turn
                .as_ref()
                .map(|t| t.prompt_seq);
            if let Some(seq) = prompt_seq {
                shared.settle(turn_id, seq, Err("cancel timed out".into()));
            }
            shared.terminate("the agent did not stop after session/cancel".into());
        }
        Ok(())
    }

    async fn answer_request(&self, key: &str, answer: RequestAnswer) -> Result<(), EngineError> {
        let pending = self
            .shared
            .state
            .lock()
            .expect("state")
            .pending
            .remove(key)
            .ok_or_else(|| EngineError::Unavailable(format!("no open request {key}")))?;
        match pending {
            Pending::Permission { responder, options } => {
                let choice = match answer.outcome {
                    RequestOutcome::Accept => Some(PermissionChoice::Accept),
                    RequestOutcome::AcceptForSession | RequestOutcome::AcceptAlways => {
                        Some(PermissionChoice::AcceptForSession)
                    }
                    RequestOutcome::Decline => Some(PermissionChoice::Decline),
                    _ => None,
                };
                let response = choice
                    .and_then(|c| self.shared.flavor.permission_option_id(&options, c))
                    .map(|id| selected(&id))
                    .unwrap_or_else(cancelled);
                responder
                    .respond(response)
                    .map_err(|e| EngineError::Transport(e.to_string()))?;
            }
            Pending::Elicitation {
                responder,
                form,
                nested,
            } => {
                let response = match (answer.outcome, form) {
                    (
                        RequestOutcome::Answered | RequestOutcome::Accept,
                        Some(QuestionForm::Parsed(form)),
                    ) => {
                        let answers = answer.answers.unwrap_or_default();
                        match form.content(&answers) {
                            Some(content) => json!({"action": "accept", "content": content}),
                            None => json!({"action": "cancel"}),
                        }
                    }
                    (
                        RequestOutcome::Answered | RequestOutcome::Accept,
                        Some(QuestionForm::Native(form, required)),
                    ) => {
                        let answers = answer.answers.unwrap_or_default();
                        // v1 withOptionalChoices: a required question left unanswered cancels.
                        if form
                            .questions
                            .iter()
                            .any(|q| required.contains(&q.id) && !answers.contains_key(&q.id))
                        {
                            json!({"action": "cancel"})
                        } else {
                            (form.respond)(&answers)
                        }
                    }
                    (RequestOutcome::Answered | RequestOutcome::Accept, None) => {
                        json!({"action": "accept"})
                    }
                    (RequestOutcome::Decline, _) => json!({"action": "decline"}),
                    _ => json!({"action": "cancel"}),
                };
                responder
                    .respond(if nested {
                        json!({ "action": response })
                    } else {
                        response
                    })
                    .map_err(|e| EngineError::Transport(e.to_string()))?;
            }
            Pending::ExtQuestion {
                responder,
                answer: build,
            } => {
                let reply = match answer.outcome {
                    RequestOutcome::Answered | RequestOutcome::Accept => {
                        build(Some(&answer.answers.unwrap_or_default()))
                    }
                    _ => build(None),
                };
                responder
                    .respond(reply)
                    .map_err(|e| EngineError::Transport(e.to_string()))?;
            }
        }
        Ok(())
    }

    async fn set_config(&self, settings: &TurnSettings) -> Result<(), EngineError> {
        self.shared
            .apply_settings(settings)
            .await
            .map_err(EngineError::Unavailable)
    }

    fn group_rss_bytes(&self) -> Option<u64> {
        let pgid = self.shared.pgid.get().copied()?;
        crate::process::group_rss_bytes_of(pgid as u32).ok()
    }

    fn process_group_id(&self) -> Option<i32> {
        self.shared.pgid.get().copied()
    }

    async fn shutdown(&self) {
        self.shared.stop("shutdown".into()).await;
    }
}

/// Merge the flavor's command with the host's `SessionSpec.launch` overrides.
fn launch_for(flavor: &dyn AcpFlavor, spec: &SessionSpec) -> Result<Launch, EngineError> {
    let mut command = flavor.launch(spec)?;
    if let Some(over) = spec.launch() {
        if let Some(binary) = &over.binary {
            command.program = binary.clone();
        }
        if !over.args.is_empty() {
            command.args = over.args.clone();
        }
        for (name, value) in &over.env {
            command.env.retain(|(n, _)| n != name);
            command.env.push((name.clone(), value.clone()));
        }
    }
    flavor.finish_launch(&mut command);
    let mut launch = Launch::new(command.program).without_host_identity();
    launch.args = command.args.into_iter().map(Into::into).collect();
    launch.cwd = Some(PathBuf::from(&spec.engine.cwd));
    launch.remove_env(command.env_remove);
    launch.env_set = command
        .env
        .into_iter()
        .map(|(k, v)| (k.into(), v.into()))
        .collect();
    Ok(launch)
}

fn handshake_error(step: &str, error: agent_client_protocol::Error, stderr: &str) -> EngineError {
    let tail: String = stderr
        .lines()
        .rev()
        .take(5)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join("\n");
    if tail.is_empty() {
        EngineError::StartFailed(format!("{step}: {error}"))
    } else {
        EngineError::StartFailed(format!("{step}: {error}\n{tail}"))
    }
}

/// A started session with its concrete controller (probes read the negotiated state from it).
/// A failed start, with the initialize result when the agent got that far.
pub(crate) struct StartFailure {
    pub error: EngineError,
    pub init: Option<InitializeInfo>,
    /// What the agent emitted before failing (sign-in URLs); None when it never started.
    pub events: Option<mpsc::UnboundedReceiver<EngineEvent>>,
}

impl StartFailure {
    fn new(
        error: EngineError,
        init: Option<InitializeInfo>,
        events: mpsc::UnboundedReceiver<EngineEvent>,
    ) -> Self {
        Self {
            error,
            init,
            events: Some(events),
        }
    }
}

impl From<EngineError> for StartFailure {
    fn from(error: EngineError) -> Self {
        Self {
            error,
            init: None,
            events: None,
        }
    }
}

/// How a probe's start failure names an agent that wants a sign-in.
pub(crate) const AUTH_REQUIRED_PREFIX: &str = "authentication required";

/// The sign-in links a failed start sent (session-scoped `AuthRequired` with a URL), in order.
/// Link-less sign-in notices are left out: the host would let one replace the link.
fn signin_links(events: Option<mpsc::UnboundedReceiver<EngineEvent>>) -> Vec<EngineEvent> {
    let Some(mut events) = events else {
        return Vec::new();
    };
    let mut links = Vec::new();
    while let Ok(event) = events.try_recv() {
        if let EngineEvent::AuthRequired {
            url: Some(url),
            message,
            ..
        } = event
        {
            // The agent that asked is gone, so there is nothing to answer.
            links.push(EngineEvent::AuthRequired {
                turn_id: None,
                url: Some(url),
                message,
                key: None,
            });
        }
    }
    links
}

/// A start that failed after the agent sent the person a sign-in link (final review finding 7).
/// v1 hands such a link to the provider's runtime coordinator, which outlives the failed start
/// (registry adapter.ts:425-436; the probe keeps it too, probe.ts:461-487). GOAT 2 hands it to
/// the host as a session-scoped `AuthRequired` on this handle, so it stays until the person
/// resolves it or the session stops. The turn that caused the start is declined with the start
/// error; a later turn starts the agent again and then runs on it.
struct SigninPending {
    factory: AcpEngineFactory,
    spec: SessionSpec,
    events: mpsc::UnboundedSender<EngineEvent>,
    /// The start error, answered to the first turn.
    error: Mutex<Option<String>>,
    /// The agent once a later start worked.
    live: Mutex<Option<Arc<AcpSession>>>,
    stopped: AtomicBool,
    /// One start at a time.
    starting: tokio::sync::Mutex<()>,
}

impl SigninPending {
    fn handle(
        factory: AcpEngineFactory,
        spec: SessionSpec,
        error: EngineError,
        links: Vec<EngineEvent>,
    ) -> EngineHandle {
        let (events, rx) = mpsc::unbounded_channel();
        for link in links {
            let _ = events.send(link);
        }
        // A resumable session stays the card's pointer; without one there is none yet.
        let engine_ref = spec.resume.clone().unwrap_or_else(|| EngineRef {
            driver: factory.flavor.engine_driver(),
            id: String::new(),
        });
        EngineHandle {
            session: Box::new(Self {
                factory,
                spec,
                events,
                error: Mutex::new(Some(error.to_string())),
                live: Mutex::new(None),
                stopped: AtomicBool::new(false),
                starting: tokio::sync::Mutex::new(()),
            }),
            events: rx,
            engine_ref,
        }
    }

    fn live(&self) -> Option<Arc<AcpSession>> {
        self.live.lock().expect("live").clone()
    }
}

#[async_trait]
impl EngineSession for SigninPending {
    async fn start_turn(
        &self,
        inputs: Vec<EngineInput>,
        settings: &TurnSettings,
    ) -> TurnStartResult {
        let starting = self.starting.lock().await;
        if self.stopped.load(Ordering::SeqCst) {
            return TurnStartResult::Declined {
                reason: "the agent process has ended".into(),
            };
        }
        if let Some(live) = self.live() {
            drop(starting);
            return live.start_turn(inputs, settings).await;
        }
        if let Some(reason) = self.error.lock().expect("error").take() {
            return TurnStartResult::Declined { reason };
        }
        match self.factory.start_inner(self.spec.clone()).await {
            Ok(started) => {
                let live = Arc::new(started.session);
                *self.live.lock().expect("live") = Some(Arc::clone(&live));
                let mut agent_events = started.events;
                let events = self.events.clone();
                tokio::spawn(async move {
                    while let Some(event) = agent_events.recv().await {
                        if events.send(event).is_err() {
                            return;
                        }
                    }
                });
                drop(starting);
                live.start_turn(inputs, settings).await
            }
            Err(failure) => {
                for link in signin_links(failure.events) {
                    let _ = self.events.send(link);
                }
                TurnStartResult::Declined {
                    reason: failure.error.to_string(),
                }
            }
        }
    }

    async fn steer(&self, turn_id: &str, inputs: Vec<EngineInput>) -> SteerResult {
        match self.live() {
            Some(live) => live.steer(turn_id, inputs).await,
            None => SteerResult::Declined {
                reason: "the agent has not started".into(),
            },
        }
    }

    async fn interrupt(&self, turn_id: &str) -> Result<(), EngineError> {
        match self.live() {
            Some(live) => live.interrupt(turn_id).await,
            None => Ok(()),
        }
    }

    async fn answer_request(&self, key: &str, answer: RequestAnswer) -> Result<(), EngineError> {
        match self.live() {
            Some(live) => live.answer_request(key, answer).await,
            None => Err(EngineError::Unavailable(format!("no open request {key}"))),
        }
    }

    async fn set_config(&self, settings: &TurnSettings) -> Result<(), EngineError> {
        match self.live() {
            Some(live) => live.set_config(settings).await,
            // The next start applies the turn's settings.
            None => Ok(()),
        }
    }

    fn group_rss_bytes(&self) -> Option<u64> {
        self.live().and_then(|live| live.group_rss_bytes())
    }

    fn process_group_id(&self) -> Option<i32> {
        self.live().and_then(|live| live.process_group_id())
    }

    async fn shutdown(&self) {
        let _starting = self.starting.lock().await;
        if self.stopped.swap(true, Ordering::SeqCst) {
            return;
        }
        match self.live() {
            Some(live) => live.shutdown().await,
            None => {
                let _ = self.events.send(EngineEvent::Exited {
                    reason: "shutdown".into(),
                });
            }
        }
    }
}

pub struct StartedAcp {
    pub session: AcpSession,
    pub events: mpsc::UnboundedReceiver<EngineEvent>,
    pub engine_ref: EngineRef,
}

#[async_trait]
impl EngineFactory for AcpEngineFactory {
    async fn start(&self, spec: SessionSpec) -> Result<EngineHandle, EngineError> {
        match self.start_inner(spec.clone()).await {
            Ok(started) => Ok(EngineHandle {
                session: Box::new(started.session),
                events: started.events,
                engine_ref: started.engine_ref,
            }),
            Err(failure) => {
                let links = signin_links(failure.events);
                if links.is_empty() || self.probe {
                    return Err(failure.error);
                }
                Ok(SigninPending::handle(
                    self.clone(),
                    spec,
                    failure.error,
                    links,
                ))
            }
        }
    }

    fn capabilities(&self) -> ProviderCapabilities {
        self.flavor.capabilities()
    }

    /// v1's status check for the flavor's driver kind (see [crate::probe::probe_provider]): Grok
    /// and fx read their CLIs, Antigravity resolves its runtime without starting it, registry
    /// agents open a probe session. Failures are reported in the result, as v1 snapshots do.
    async fn probe(&self) -> Result<goat2_contracts::ProviderProbeResult, EngineError> {
        Ok(crate::probe::probe_provider(self).await)
    }
}

impl AcpEngineFactory {
    /// [EngineFactory::start] returning the concrete [AcpSession].
    pub async fn start_acp(&self, spec: SessionSpec) -> Result<StartedAcp, EngineError> {
        self.start_inner(spec)
            .await
            .map_err(|failure| failure.error)
    }

    /// [Self::start_acp], keeping what a probe needs when the start fails.
    pub(crate) async fn start_inner(&self, spec: SessionSpec) -> Result<StartedAcp, StartFailure> {
        let flavor = Arc::clone(&self.flavor);
        let (events_tx, events_rx) = mpsc::unbounded_channel();
        let launch = match launch_for(flavor.as_ref(), &spec) {
            Ok(launch) => launch,
            Err(error) => return Err(StartFailure::new(error, None, events_rx)),
        };
        let agent_env = AgentEnv {
            set: launch
                .env_set
                .iter()
                .map(|(k, v)| {
                    (
                        k.to_string_lossy().into_owned(),
                        v.to_string_lossy().into_owned(),
                    )
                })
                .collect(),
            removed: launch
                .env_remove
                .iter()
                .map(|k| k.to_string_lossy().into_owned())
                .collect(),
            removed_prefixes: launch.env_remove_prefixes.clone(),
        };
        let mut state = State::default();
        state.subagents.configure(
            spec.thread_id.clone(),
            flavor.driver(),
            spec.engine.provider_instance_id.as_str(),
        );

        let shared = Arc::new(Shared {
            flavor: Arc::clone(&flavor),
            thread_id: spec.thread_id.clone(),
            events: events_tx,
            state: Mutex::new(state),
            policy: Mutex::new(RuntimePolicy {
                runtime_mode: spec.engine.runtime_mode,
                cwd: Some(spec.engine.cwd.clone()),
                extra_roots: Vec::new(),
            }),
            session_id: OnceLock::new(),
            init: OnceLock::new(),
            conn: OnceLock::new(),
            child: tokio::sync::Mutex::new(None),
            pgid: OnceLock::new(),
            transport_failure: Mutex::new(None),
            exited: AtomicBool::new(false),
            timeouts: self.timeouts.clone(),
            resolver: self.resolver.clone(),
            shutdown_tx: Mutex::new(None),
            advertised: watch::channel(0).0,
            mcp_over_acp: OnceLock::new(),
            probe: self.probe,
            last_stderr: Mutex::new(String::new()),
            agent_env,
            deferred_finalize: self.deferred_finalize,
            cwd: spec.engine.cwd.clone(),
            program: launch.program.clone(),
        });

        let stderr_hook = {
            let weak = Arc::downgrade(&shared);
            let flavor = Arc::clone(&flavor);
            Arc::new(move |line: &str| {
                let event = flavor.stderr_line(line);
                if event == StderrLine::Ignore {
                    return;
                }
                if let Some(shared) = weak.upgrade() {
                    match event {
                        StderrLine::Ignore => {}
                        StderrLine::AuthUrl(url) => shared.auth_required(Some(url), None),
                        StderrLine::Fail(message) => shared.fail_process(message),
                    }
                }
            }) as crate::process::StderrHook
        };
        let mut child =
            ChildProcess::spawn_with_stderr(&launch, Some(stderr_hook)).map_err(|e| {
                // Home folders as ~ (final review 7-1 finding 2; the D2 rule for probe errors).
                EngineError::Unavailable(format!(
                    "{}: {e}",
                    crate::probe::support::redact_home(
                        &launch.program.display().to_string(),
                        &crate::stderr::home_directories(),
                    )
                ))
            })?;
        if let Ok(pgid) = i32::try_from(child.pid()) {
            let _ = shared.pgid.set(pgid);
        }
        let stdin = child
            .take_stdin()
            .ok_or_else(|| EngineError::StartFailed("no stdin".into()))?;
        let stdout = child
            .take_stdout()
            .ok_or_else(|| EngineError::StartFailed("no stdout".into()))?;
        *shared.child.lock().await = Some(child);

        // Transport: newline-delimited JSON with the flavor looking at every stdout line first.
        let outgoing = futures::sink::unfold(stdin, |mut stdin, line: String| async move {
            stdin.write_all(line.as_bytes()).await?;
            stdin.write_all(b"\n").await?;
            stdin.flush().await?;
            Ok::<_, std::io::Error>(stdin)
        });
        let incoming = {
            let weak = Arc::downgrade(&shared);
            let flavor = Arc::clone(&flavor);
            let reader = tokio::io::BufReader::new(stdout);
            futures::stream::unfold(reader, move |mut reader| {
                let weak = weak.clone();
                let flavor = Arc::clone(&flavor);
                async move {
                    loop {
                        let line = match read_frame(&mut reader).await {
                            Ok(Some(line)) => line,
                            Ok(None) => return None,
                            Err(error) => {
                                if error.kind() == std::io::ErrorKind::InvalidData
                                    && let Some(shared) = weak.upgrade()
                                {
                                    *shared.transport_failure.lock().expect("failure") =
                                        Some(error.to_string());
                                }
                                return Some((Err(error), reader));
                            }
                        };
                        let line = line.trim_end_matches(['\r', '\n']).to_owned();
                        if line.trim().is_empty() {
                            continue;
                        }
                        match flavor.stdout_line(&line) {
                            StdoutLine::Json => {
                                if line.trim_start().starts_with('{') {
                                    return Some((Ok(line), reader));
                                }
                                // Not JSON-RPC (a log line): v1 drops these before decoding.
                            }
                            StdoutLine::Drop => {}
                            StdoutLine::AuthUrl(url) => {
                                if let Some(shared) = weak.upgrade() {
                                    shared.auth_required(Some(url), None);
                                }
                            }
                            StdoutLine::Fail(message) => {
                                if let Some(shared) = weak.upgrade() {
                                    *shared.transport_failure.lock().expect("failure") =
                                        Some(message.clone());
                                }
                                return Some((Err(std::io::Error::other(message)), reader));
                            }
                        }
                    }
                }
            })
        };
        let transport = Lines::new(Box::pin(outgoing), Box::pin(incoming));

        let (conn_tx, conn_rx) = oneshot::channel::<Conn>();
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        *shared.shutdown_tx.lock().expect("shutdown") = Some(shutdown_tx);
        let notif_shared = Arc::downgrade(&shared);
        let req_shared = Arc::downgrade(&shared);
        let builder = Client
            .v1()
            .name("goat")
            .on_receive_notification(
                async move |message: UntypedMessage, _cx| {
                    if let Some(shared) = notif_shared.upgrade() {
                        let (method, params) = message.into_parts();
                        shared.on_notification(&method, params);
                    }
                    Ok(())
                },
                agent_client_protocol::on_receive_notification!(),
            )
            .on_receive_request(
                async move |message: UntypedMessage, responder: ValueResponder, _cx| {
                    match req_shared.upgrade() {
                        Some(shared) => {
                            let (method, params) = message.into_parts();
                            shared.on_request(&method, params, responder);
                            Ok(())
                        }
                        None => responder
                            .respond_with_error(agent_client_protocol::Error::internal_error()),
                    }
                },
                agent_client_protocol::on_receive_request!(),
            );
        let exit_shared = Arc::downgrade(&shared);
        tokio::spawn(async move {
            let result = builder
                .connect_with(transport, async move |cx: Conn| {
                    let _ = conn_tx.send(cx.clone());
                    tokio::select! {
                        _ = shutdown_rx => {}
                        _ = cx.incoming_closed() => {}
                    }
                    Ok(())
                })
                .await;
            if let Some(shared) = exit_shared.upgrade() {
                let stderr = match shared.child.lock().await.as_ref() {
                    Some(child) => {
                        child.wait_stderr_closed(Duration::from_secs(2)).await;
                        child.stderr_tail()
                    }
                    None => String::new(),
                };
                // Kept for a handshake that fails because of this exit (sanitized already).
                *shared.last_stderr.lock().expect("stderr") = stderr.clone();
                let reason = match result {
                    Ok(()) => "the agent closed its connection".to_owned(),
                    Err(error) => format!("connection failed: {error}"),
                };
                let tail = stderr.lines().last().unwrap_or_default().to_owned();
                if let Some(mut child) = shared.child.lock().await.take() {
                    child.shutdown().await;
                }
                shared.on_exit(if tail.is_empty() {
                    reason
                } else {
                    format!("{reason} ({tail})")
                });
            }
        });
        let conn = conn_rx
            .await
            .map_err(|_| EngineError::StartFailed("ACP connection did not open".into()))?;
        let _ = shared.conn.set(conn);

        match self.handshake(&shared, &spec).await {
            Ok(engine_ref) => Ok(StartedAcp {
                session: AcpSession {
                    shared: Arc::clone(&shared),
                },
                events: events_rx,
                engine_ref,
            }),
            Err(error) => {
                shared.stop("start failed".into()).await;
                Err(StartFailure::new(
                    error,
                    shared.init.get().cloned(),
                    events_rx,
                ))
            }
        }
    }

    async fn handshake(
        &self,
        shared: &Arc<Shared>,
        spec: &SessionSpec,
    ) -> Result<EngineRef, EngineError> {
        let flavor = &self.flavor;
        // A failed handshake usually means the agent exited: its stderr is read to the end first
        // (bounded) so the error carries its last words, sanitized (v1 AcpProcessExitedError).
        let stderr = || async {
            let tail = {
                let child = shared.child.lock().await;
                match child.as_ref() {
                    Some(child) => {
                        child.wait_stderr_closed(Duration::from_secs(2)).await;
                        child.stderr_tail()
                    }
                    // The exit task already took the process; it kept the tail.
                    None => shared.last_stderr.lock().expect("stderr").clone(),
                }
            };
            // The flavor's reason for ending the connection goes last, so it is never cut off.
            match shared.transport_failure.lock().expect("failure").clone() {
                Some(failure) if tail.is_empty() => failure,
                Some(failure) => format!("{tail}\n{failure}"),
                None => tail,
            }
        };
        // initialize (v1 AcpSessionRuntime.ts:995-1009, :1427-1442).
        let caps = flavor.client_capabilities();
        let client_caps = ClientCapabilities::new()
            .fs(FileSystemCapabilities::new()
                .read_text_file(caps.read_text_file)
                .write_text_file(caps.write_text_file))
            .terminal(caps.terminal);
        let mut init_params = {
            let mut request = InitializeRequest::new(ProtocolVersion::V1).client_info(
                Implementation::new("goat", self.client_version.clone()).title("GOAT".to_owned()),
            );
            if let Some(meta) = meta_of(flavor.initialize_meta()) {
                request = request.meta(meta);
            }
            request = request.client_capabilities(client_caps);
            json_or_null(&request)
        };
        // v1 clientCapabilitiesMeta (adapter.ts:1018): agent-specific opt-ins (Devin, Copilot).
        if let Some(meta) = flavor.client_capabilities_meta()
            && let Some(caps) = init_params
                .get_mut("clientCapabilities")
                .and_then(Value::as_object_mut)
        {
            caps.insert("_meta".into(), Value::Object(meta));
        }
        // ACP v1 agents send notices only to clients that advertise them; GOAT answers form and
        // url elicitations (v1 clientCapabilities.elicitation).
        if let Some(caps) = init_params
            .get_mut("clientCapabilities")
            .and_then(Value::as_object_mut)
        {
            let session = caps.entry("session").or_insert_with(|| json!({}));
            if let Some(session) = session.as_object_mut() {
                session.insert("notices".into(), json!({}));
            }
            caps.insert("elicitation".into(), json!({"form": {}, "url": {}}));
        }
        let init_value = match shared
            .request("initialize", init_params, self.timeouts.request)
            .await
        {
            Ok(value) => value,
            Err(error) => return Err(handshake_error("initialize", error, &stderr().await)),
        };
        let init = InitializeInfo::from_value(&init_value);
        let _ = shared.init.set(init.clone());
        if let Some(message) = flavor.initialize_refusal(&init) {
            return Err(EngineError::StartFailed(message));
        }

        // A probe never signs in, eagerly or on demand (v1 probe.ts:418-432; review 1 finding 3).
        if let (false, AuthPolicy::Eager { method_id }) = (self.probe, flavor.auth_policy_for(spec))
        {
            let request = AuthenticateRequest::new(method_id.clone());
            if let Err(error) = shared
                .request(
                    "authenticate",
                    json_or_null(&request),
                    self.timeouts.request,
                )
                .await
            {
                match flavor.auth_failure(i32::from(error.code), &error.message) {
                    AuthFailure::Default => {
                        shared.auth_required(
                            None,
                            Some(format!("Sign-in with {method_id} failed: {error}")),
                        );
                        return Err(EngineError::StartFailed(format!("authenticate: {error}")));
                    }
                    AuthFailure::SignIn(message) => {
                        shared.auth_required(None, Some(message.clone()));
                        return Err(EngineError::StartFailed(message));
                    }
                    AuthFailure::Plain => {
                        return Err(handshake_error("authenticate", error, &stderr().await));
                    }
                }
            }
        }

        // Instructions: the ACP system prompt when the agent takes one, the flavor's own channel,
        // otherwise in front of the first prompt (with the preamble).
        let instructions = spec.instructions.clone().unwrap_or_default();
        let append = instructions
            .append_system_prompt
            .clone()
            .filter(|s| !s.trim().is_empty());
        let via_meta = append.is_some() && flavor.instructions_in_session_meta(&init);
        let via_system_prompt = append.is_some() && !via_meta && init.system_prompt;
        let mut preamble_parts = Vec::new();
        if let Some(text) = &append
            && !via_meta
            && !via_system_prompt
        {
            preamble_parts.push(text.clone());
        }
        if let Some(text) = instructions
            .first_message_preamble
            .clone()
            .filter(|s| !s.trim().is_empty())
        {
            preamble_parts.push(text);
        }
        let meta = meta_of(flavor.session_meta(&init, append.as_deref()));
        let system_prompt = via_system_prompt.then(|| {
            SystemPrompt::new(vec![ContentBlock::Text(TextContent::new(
                append.clone().unwrap_or_default(),
            ))])
        });
        let mcp_servers =
            crate::mcp::mcp_servers_for(&init, spec, flavor.as_ref(), self.mcp_bridge.as_ref())?;
        if mcp_servers
            .iter()
            .any(|s| matches!(s, agent_client_protocol::v1::schema::McpServer::Acp(_)))
        {
            let _ = shared
                .mcp_over_acp
                .set(Arc::new(crate::mcp_over_acp::McpOverAcp::new(
                    spec.mcp.url.clone(),
                    crate::mcp::authorization(spec),
                )));
        }

        let resume_id = spec
            .resume
            .as_ref()
            // An empty id is no session (a start that never opened one, [SigninPending]).
            .filter(|r| r.driver == flavor.engine_driver() && !r.id.is_empty())
            .map(|r| r.id.clone());
        let setup_once = || async {
            if let Some(session_id) = &resume_id {
                let method = match flavor.resume_method() {
                    Some(ResumeMethod::Resume) if init.session_resume => "session/resume",
                    Some(ResumeMethod::Load) if init.load_session => "session/load",
                    _ if init.load_session => "session/load",
                    _ if init.session_resume => "session/resume",
                    _ => {
                        return Err(agent_client_protocol::Error::new(
                            agent_client_protocol::ErrorCode::METHOD_NOT_FOUND,
                            "ACP agent does not advertise session/load or session/resume support",
                        ));
                    }
                };
                let params = if method == "session/load" {
                    let mut request =
                        LoadSessionRequest::new(session_id.clone(), spec.engine.cwd.clone())
                            .mcp_servers(mcp_servers.clone());
                    if let Some(prompt) = system_prompt.clone() {
                        request = request.system_prompt(prompt);
                    }
                    if let Some(meta) = meta.clone() {
                        request = request.meta(meta);
                    }
                    json_or_null(&request)
                } else {
                    let mut request =
                        ResumeSessionRequest::new(session_id.clone(), spec.engine.cwd.clone())
                            .mcp_servers(mcp_servers.clone());
                    if let Some(prompt) = system_prompt.clone() {
                        request = request.system_prompt(prompt);
                    }
                    if let Some(meta) = meta.clone() {
                        request = request.meta(meta);
                    }
                    json_or_null(&request)
                };
                let timeout = if method == "session/load" {
                    self.timeouts.session_load
                } else {
                    self.timeouts.request
                };
                let value = shared.request(method, params, timeout).await?;
                Ok(SessionSetup::from_value(&value, Some(session_id)).unwrap_or_default())
            } else {
                let mut request = NewSessionRequest::new(spec.engine.cwd.clone())
                    .mcp_servers(mcp_servers.clone());
                if let Some(prompt) = system_prompt.clone() {
                    request = request.system_prompt(prompt);
                }
                if let Some(meta) = meta.clone() {
                    request = request.meta(meta);
                }
                let value = shared
                    .request("session/new", json_or_null(&request), self.timeouts.request)
                    .await?;
                SessionSetup::from_value(&value, None).ok_or_else(|| {
                    agent_client_protocol::Error::new(
                        agent_client_protocol::ErrorCode::INTERNAL_ERROR,
                        "session/new returned no sessionId",
                    )
                })
            }
        };
        let setup = match setup_once().await {
            Ok(setup) => setup,
            Err(error) if is_auth_required(&error) && self.probe => {
                return Err(EngineError::StartFailed(format!(
                    "{AUTH_REQUIRED_PREFIX}: {error}"
                )));
            }
            Err(error) if is_auth_required(&error) => {
                // v1 authenticateAfterRequired (AcpSessionRuntime.ts:1505-1555).
                // v1 uses the configured `authMethodId` whether or not it authenticated eagerly.
                let configured = match flavor.auth_policy_for(spec) {
                    AuthPolicy::OnRequired { method_id } => method_id,
                    AuthPolicy::Eager { method_id } => Some(method_id),
                };
                let method = match &configured {
                    Some(id) => init.auth_methods.iter().find(|m| &m.id == id).cloned(),
                    None => init
                        .auth_methods
                        .iter()
                        .find(|m| m.kind.is_none() || m.kind.as_deref() == Some("agent"))
                        .cloned(),
                };
                // v1 AcpSessionRuntime.ts:1514-1527: when the agent lists its sign-in methods, a
                // configured method it does not name is refused before any authenticate; only an
                // agent without a list gets the configured id as is (final review finding 11).
                if let Some(id) = &configured
                    && method.is_none()
                    && init.raw.get("authMethods").is_some_and(Value::is_array)
                {
                    return Err(EngineError::StartFailed(format!(
                        "authenticate {id}: ACP agent did not advertise configured authentication method \"{id}\""
                    )));
                }
                let method_id = method.as_ref().map(|m| m.id.clone()).or(configured);
                let Some(method_id) = method_id else {
                    shared.auth_required(
                        None,
                        Some(format!("{} needs you to sign in: {error}", flavor.driver())),
                    );
                    return Err(EngineError::StartFailed(format!(
                        "authentication required: {error}"
                    )));
                };
                if let Some(kind) = method.as_ref().and_then(|m| m.kind.clone())
                    && kind != "agent"
                {
                    shared.auth_required(None, Some(format!(
                        "ACP authentication method \"{method_id}\" requires {kind} authentication, which cannot run inside a headless provider session"
                    )));
                    return Err(EngineError::StartFailed(format!(
                        "authentication method {method_id} needs {kind}"
                    )));
                }
                let request = AuthenticateRequest::new(method_id.clone());
                if let Err(auth_error) = shared
                    .request(
                        "authenticate",
                        json_or_null(&request),
                        self.timeouts.request,
                    )
                    .await
                {
                    if let AuthFailure::SignIn(message) =
                        flavor.auth_failure(i32::from(auth_error.code), &auth_error.message)
                    {
                        shared.auth_required(None, Some(message.clone()));
                        return Err(EngineError::StartFailed(message));
                    }
                    shared.auth_required(
                        None,
                        Some(format!("Sign in to {}: {auth_error}", flavor.driver())),
                    );
                    return Err(EngineError::StartFailed(format!(
                        "authenticate {method_id}: {auth_error}"
                    )));
                }
                match setup_once().await {
                    Ok(setup) => setup,
                    Err(e) => {
                        // v1 `requiresSignIn` (adapter.ts:8419): still unsigned after sign-in.
                        if let AuthFailure::SignIn(message) =
                            flavor.auth_failure(i32::from(e.code), &e.message)
                        {
                            shared.auth_required(None, Some(message.clone()));
                            return Err(EngineError::StartFailed(message));
                        }
                        return Err(EngineError::StartFailed(format!(
                            "session setup after sign-in: {e}"
                        )));
                    }
                }
            }
            Err(error) => {
                let tail = stderr().await;
                return Err(handshake_error("session setup", error, &tail));
            }
        };
        let session_id = setup.session_id.clone();
        let _ = shared.session_id.set(session_id.clone());
        {
            let mut state = shared.state.lock().expect("state");
            state.subagents.set_session(&session_id);
            state.modes = setup.modes.clone().or_else(|| parse_modes(&setup.raw));
            if !state.config_options_from_update {
                state.config_options = setup.config_options.clone();
            }
            state.setup = setup;
            // A resumed session already holds what its first prompt carried.
            state.preamble = (resume_id.is_none() && !preamble_parts.is_empty())
                .then(|| preamble_parts.join("\n\n"));
        }
        let settings = TurnSettings {
            model_selection: spec.engine.model_selection.clone(),
            runtime_mode: spec.engine.runtime_mode,
        };
        shared
            .apply_settings(&settings)
            .await
            .map_err(EngineError::StartFailed)?;
        Ok(EngineRef {
            driver: flavor.engine_driver(),
            id: session_id,
        })
    }
}
