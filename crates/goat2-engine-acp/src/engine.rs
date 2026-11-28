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
    FileSystemCapabilities, HttpHeader, ImageContent, Implementation, InitializeRequest,
    LoadSessionRequest, McpServer, McpServerHttp, NewSessionRequest, PromptRequest,
    ResumeSessionRequest, SetSessionModeRequest, SystemPrompt, TextContent,
};
use agent_client_protocol::{Agent, Client, Lines, Responder, UntypedMessage};
use async_trait::async_trait;
use goat2_contracts::{
    ApprovalDecision, ChatAttachment, ChatAttachmentType, EngineRef, ItemId, ProviderCapabilities,
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
use crate::flavor::{AcpFlavor, AuthPolicy, FlavorEvent, ModelWrite, ResumeMethod, StdoutLine};
use crate::items::{TurnProjector, now_ms, rfc3339_ms, unfinished_stop_message};
use crate::normalize::normalize_v1_session_update;
use crate::policy::{
    Disposition, PermissionChoice, RuntimePolicy, mcp_tool_approval_elicitation_disposition,
    select_auto_approved_option, select_permission_option_id,
};
use crate::process::{ChildProcess, Launch};
use crate::wire::{InitializeInfo, ModeState, SessionSetup, parse_modes, text_field};

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

/// Starts ACP agent processes for one flavor.
#[derive(Clone)]
pub struct AcpEngineFactory {
    flavor: Arc<dyn AcpFlavor>,
    resolver: Option<AttachmentResolver>,
    timeouts: AcpTimeouts,
    client_version: String,
}

impl AcpEngineFactory {
    pub fn new(flavor: Arc<dyn AcpFlavor>) -> Self {
        Self {
            flavor,
            resolver: None,
            timeouts: AcpTimeouts::default(),
            client_version: env!("CARGO_PKG_VERSION").to_owned(),
        }
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
        form: Option<ElicitationForm>,
        /// Legacy `session/elicitation` methods answer with the response nested in `action`.
        nested: bool,
    },
}

struct ActiveTurn {
    turn_id: String,
    projector: TurnProjector,
    /// The latest prompt of this turn; an earlier prompt's answer no longer settles it.
    prompt_seq: u64,
    interrupted: bool,
    settled_tx: watch::Sender<bool>,
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
    model: Option<String>,
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
    pgid: Option<i32>,
    exited: AtomicBool,
    timeouts: AcpTimeouts,
    resolver: Option<AttachmentResolver>,
    shutdown_tx: Mutex<Option<oneshot::Sender<()>>>,
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
        match method {
            "session/update" => {
                let params = self
                    .flavor
                    .normalize_update(normalize_v1_session_update(params));
                self.on_session_update(&params);
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
                prompt_id,
                stop_reason,
            } => {
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
            },
        );
    }

    fn on_session_update(&self, params: &Value) {
        let Some(update) = params.get("update") else {
            return;
        };
        if let Some(session) = text_field(params, "sessionId")
            && self.session_id.get().is_some_and(|own| *own != session)
        {
            return;
        }
        let kind = update
            .get("sessionUpdate")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let mut out = Vec::new();
        {
            let mut state = self.state.lock().expect("state");
            match kind {
                "current_mode_update" => {
                    if let (Some(modes), Some(id)) =
                        (state.modes.as_mut(), text_field(update, "currentModeId"))
                    {
                        modes.current_mode_id = id;
                    }
                }
                "config_option_update" => {
                    if let Some(options) = update.get("configOptions").and_then(Value::as_array) {
                        state.config_options = options.clone();
                    }
                }
                _ => {
                    if let Some(turn) = state.turn.as_mut()
                        && !turn.interrupted
                    {
                        turn.projector.apply(update, &mut out);
                    }
                }
            }
        }
        for event in out {
            emit(self, event);
        }
    }

    fn on_request(&self, method: &str, params: Value, responder: ValueResponder) {
        match method {
            "session/request_permission" => self.on_permission(params, responder),
            "elicitation/create" => self.on_elicitation(params, responder, false),
            "session/elicitation" | "_session/elicitation" => {
                self.on_elicitation(params, responder, true)
            }
            _ => match self.flavor.ext_request(method, &params) {
                Some(result) => {
                    let _ = responder.respond(result);
                }
                None => {
                    let _ = responder
                        .respond_with_error(agent_client_protocol::Error::method_not_found());
                }
            },
        }
    }

    fn on_permission(&self, params: Value, responder: ValueResponder) {
        let options: Vec<Value> = params
            .get("options")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let policy = self.policy.lock().expect("policy").clone();
        let disposition = self.flavor.permission_disposition(&policy, &params);
        let tool_call = params.get("toolCall").cloned().unwrap_or(Value::Null);
        match disposition {
            Disposition::Allow => {
                if let Some(option_id) = select_auto_approved_option(&options) {
                    let _ = responder.respond(selected(&option_id));
                    return;
                }
            }
            Disposition::Deny => {
                let _ = responder.respond(
                    select_permission_option_id(&options, PermissionChoice::Decline)
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
                    options: Some(self.flavor.approval_options(&params)),
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
                respond(responder, json!({"action": "cancel"}));
                return;
            };
            if let Some(turn) = state.turn.as_mut() {
                turn.projector.close_segments(&mut out);
            }
            state.request_counter += 1;
            let key = match &native_id {
                Some(id) => format!("elicitation:{id}"),
                None => format!("elicitation:{}", state.request_counter),
            };
            if mode == "url" {
                let url = text_field(&params, "url");
                drop(state);
                for event in out {
                    emit(self, event);
                }
                // v1 `onUrlElicitation`: a sign-in or consent page; the person opens it.
                self.auth_required(url, Some(message));
                let mut state = self.state.lock().expect("state");
                state.pending.insert(
                    key,
                    Pending::Elicitation {
                        responder,
                        form: None,
                        nested,
                    },
                );
                return;
            }
            let schema = params
                .get("requestedSchema")
                .cloned()
                .unwrap_or(Value::Null);
            let Some(form) = parse_elicitation_form(&schema, &message, false) else {
                drop(state);
                for event in out {
                    emit(self, event);
                }
                respond(responder, json!({"action": "decline"}));
                return;
            };
            let item = self.request_item(
                &mut state,
                &turn_id,
                &key,
                TurnItemBody::UserInputRequest {
                    request_id: RequestId::new(key.as_str()),
                    questions: form.questions.clone(),
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
            }
            out.push(EngineEvent::RequestClosed { key });
        }
    }

    // ---- turns ---------------------------------------------------------------------------

    /// The prompt of `turn_id` answered (or failed). Settles the turn unless a later prompt took over.
    fn settle(self: &Arc<Self>, turn_id: &str, prompt_seq: u64, result: Result<Value, String>) {
        let mut out = Vec::new();
        let mut restart = false;
        {
            let mut state = self.state.lock().expect("state");
            let Some(turn) = state.turn.as_mut() else {
                return;
            };
            if turn.turn_id != turn_id || turn.prompt_seq != prompt_seq {
                return;
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
            turn.projector.finish(tool_status, &mut out);
            let ordinal = turn.projector.next_ordinal();
            let _ = turn.settled_tx.send(true);
            state.ordinal = ordinal;
            state.turn = None;
            self.cancel_pending(&mut state, &mut out);
            if interrupted && self.flavor.restart_after_interrupt() {
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
    }

    fn prompt_blocks(
        &self,
        inputs: &[EngineInput],
        preamble: Option<String>,
    ) -> Result<Vec<ContentBlock>, String> {
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
        // Slash commands must stay first (v1 acpAppContext skips context for them).
        if let Some(preamble) = preamble.filter(|p| !p.trim().is_empty())
            && !text.trim_start().starts_with('/')
        {
            blocks.push(ContentBlock::Text(TextContent::new(preamble)));
        }
        if !text.is_empty() {
            blocks.push(ContentBlock::Text(TextContent::new(text)));
        }
        if self.flavor.supports_image_prompts(&init) {
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
        Ok(blocks)
    }

    /// Send one `session/prompt` for `turn_id`; its answer settles the turn in the background.
    fn send_prompt(
        self: &Arc<Self>,
        turn_id: String,
        prompt_seq: u64,
        blocks: Vec<ContentBlock>,
    ) -> Result<(), String> {
        let conn = self.conn().map_err(|e| e.to_string())?.clone();
        let mut request = PromptRequest::new(self.session_id(), blocks);
        if let Some(meta) = meta_of(self.flavor.prompt_meta(&prompt_id_of(&turn_id, prompt_seq))) {
            request = request.meta(meta);
        }
        let message = UntypedMessage::new("session/prompt", request).map_err(|e| e.to_string())?;
        let sent = conn.send_request(message);
        let shared = Arc::clone(self);
        tokio::spawn(async move {
            let result = sent.block_task().await.map_err(|e| e.to_string());
            shared.settle(&turn_id, prompt_seq, result);
        });
        Ok(())
    }

    async fn apply_settings(&self, settings: &TurnSettings) -> Result<(), String> {
        let (mode_changed, model_changed) = {
            let state = self.state.lock().expect("state");
            (
                state.runtime_mode != Some(settings.runtime_mode),
                state.model.as_deref() != Some(settings.model_selection.model.as_str()),
            )
        };
        if mode_changed {
            self.policy.lock().expect("policy").runtime_mode = settings.runtime_mode;
            let modes = self.state.lock().expect("state").modes.clone();
            if let Some(mode_id) = self
                .flavor
                .session_mode_for(settings.runtime_mode, modes.as_ref())
                && modes
                    .as_ref()
                    .is_some_and(|m| m.has(&mode_id) && m.current_mode_id != mode_id)
            {
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
            self.state.lock().expect("state").runtime_mode = Some(settings.runtime_mode);
        }
        if model_changed {
            let setup = {
                let state = self.state.lock().expect("state");
                let mut setup = state.setup.clone();
                setup.config_options = state.config_options.clone();
                setup
            };
            match self.flavor.model_write(&settings.model_selection, &setup) {
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
            }
            self.state.lock().expect("state").model = Some(settings.model_selection.model.clone());
        }
        Ok(())
    }

    fn terminate(self: &Arc<Self>, reason: String) {
        let shared = Arc::clone(self);
        tokio::spawn(async move {
            shared.stop(reason).await;
        });
    }

    async fn stop(&self, reason: String) {
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
            let mut state = self.state.lock().expect("state");
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
            self.cancel_pending(&mut state, &mut out);
        }
        for event in out {
            emit(self, event);
        }
        emit(self, EngineEvent::Exited { reason });
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

/// The session controller handed to the host.
pub struct AcpSession {
    shared: Arc<Shared>,
}

impl AcpSession {
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
        let preamble = shared.state.lock().expect("state").preamble.clone();
        let blocks = match shared.prompt_blocks(&inputs, preamble) {
            Ok(blocks) => blocks,
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
            );
            state.turn = Some(ActiveTurn {
                turn_id: turn_id.clone(),
                projector,
                prompt_seq: state.prompt_counter,
                interrupted: false,
                settled_tx,
            });
            state.preamble = None;
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
            Ok(blocks) => blocks,
            Err(reason) => return SteerResult::Declined { reason },
        };
        let prompt_seq = {
            let mut state = shared.state.lock().expect("state");
            state.prompt_counter += 1;
            let next = state.prompt_counter;
            match state.turn.as_mut() {
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
                    .and_then(|c| select_permission_option_id(&options, c))
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
                    (RequestOutcome::Answered | RequestOutcome::Accept, Some(form)) => {
                        let answers = answer.answers.unwrap_or_default();
                        match form.content(&answers) {
                            Some(content) => json!({"action": "accept", "content": content}),
                            None => json!({"action": "cancel"}),
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
        let pgid = self.shared.pgid?;
        crate::process::group_rss_bytes_of(pgid as u32).ok()
    }

    fn process_group_id(&self) -> Option<i32> {
        self.shared.pgid
    }

    async fn shutdown(&self) {
        self.shared.stop("shutdown".into()).await;
    }
}

/// Merge the flavor's command with the host's `SessionSpec.launch` overrides.
fn launch_for(flavor: &dyn AcpFlavor, spec: &SessionSpec) -> Result<Launch, EngineError> {
    let mut command = flavor.launch(spec)?;
    if let Some(over) = &spec.launch {
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
    let mut launch = Launch::new(command.program).without_host_identity();
    launch.args = command.args.into_iter().map(Into::into).collect();
    launch.cwd = Some(PathBuf::from(&spec.engine.cwd));
    launch
        .env_remove
        .extend(command.env_remove.into_iter().map(Into::into));
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

#[async_trait]
impl EngineFactory for AcpEngineFactory {
    async fn start(&self, spec: SessionSpec) -> Result<EngineHandle, EngineError> {
        let flavor = Arc::clone(&self.flavor);
        let launch = launch_for(flavor.as_ref(), &spec)?;
        let (events_tx, events_rx) = mpsc::unbounded_channel();

        let shared = Arc::new(Shared {
            flavor: Arc::clone(&flavor),
            thread_id: spec.thread_id.clone(),
            events: events_tx,
            state: Mutex::new(State::default()),
            policy: Mutex::new(RuntimePolicy {
                runtime_mode: spec.engine.runtime_mode,
                cwd: Some(spec.engine.cwd.clone()),
                extra_roots: Vec::new(),
            }),
            session_id: OnceLock::new(),
            init: OnceLock::new(),
            conn: OnceLock::new(),
            child: tokio::sync::Mutex::new(None),
            pgid: None,
            exited: AtomicBool::new(false),
            timeouts: self.timeouts.clone(),
            resolver: self.resolver.clone(),
            shutdown_tx: Mutex::new(None),
        });

        let stderr_hook = {
            let weak = Arc::downgrade(&shared);
            let flavor = Arc::clone(&flavor);
            Arc::new(move |line: &str| {
                if let Some(url) = flavor.stderr_auth_url(line)
                    && let Some(shared) = weak.upgrade()
                {
                    shared.auth_required(Some(url), None);
                }
            }) as crate::process::StderrHook
        };
        let mut child = ChildProcess::spawn_with_stderr(&launch, Some(stderr_hook))
            .map_err(|e| EngineError::Unavailable(format!("{}: {e}", launch.program.display())))?;
        let pgid = i32::try_from(child.pid()).ok();
        let stdin = child
            .take_stdin()
            .ok_or_else(|| EngineError::StartFailed("no stdin".into()))?;
        let stdout = child
            .take_stdout()
            .ok_or_else(|| EngineError::StartFailed("no stdout".into()))?;
        // Safe: nothing else holds `shared` yet except the stderr hook's weak pointer.
        let shared = {
            let mut owned = Arc::try_unwrap(shared)
                .map_err(|_| EngineError::StartFailed("shared state in use".into()))?;
            owned.pgid = pgid;
            Arc::new(owned)
        };
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
                        let mut line = String::new();
                        match reader.read_line(&mut line).await {
                            Ok(0) => return None,
                            Err(error) => return Some((Err(error), reader)),
                            Ok(_) => {}
                        }
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
                    Some(child) => child.stderr_tail(),
                    None => String::new(),
                };
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
            Ok(engine_ref) => Ok(EngineHandle {
                session: Box::new(AcpSession {
                    shared: Arc::clone(&shared),
                }),
                events: events_rx,
                engine_ref,
            }),
            Err(error) => {
                shared.stop("start failed".into()).await;
                Err(error)
            }
        }
    }

    fn capabilities(&self) -> ProviderCapabilities {
        self.flavor.capabilities()
    }
}

impl AcpEngineFactory {
    async fn handshake(
        &self,
        shared: &Arc<Shared>,
        spec: &SessionSpec,
    ) -> Result<EngineRef, EngineError> {
        let flavor = &self.flavor;
        let stderr = || async {
            shared
                .child
                .lock()
                .await
                .as_ref()
                .map(|c| c.stderr_tail())
                .unwrap_or_default()
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

        if let AuthPolicy::Eager { method_id } = flavor.auth_policy() {
            let request = AuthenticateRequest::new(method_id.clone());
            if let Err(error) = shared
                .request(
                    "authenticate",
                    json_or_null(&request),
                    self.timeouts.request,
                )
                .await
            {
                shared.auth_required(
                    None,
                    Some(format!("Sign-in with {method_id} failed: {error}")),
                );
                return Err(EngineError::StartFailed(format!("authenticate: {error}")));
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
        let mcp_servers = mcp_servers_for(&init, spec);

        let resume_id = spec
            .resume
            .as_ref()
            .filter(|r| r.driver == flavor.engine_driver())
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
            Err(error) if is_auth_required(&error) => {
                // v1 authenticateAfterRequired (AcpSessionRuntime.ts:1505-1555).
                let configured = match flavor.auth_policy() {
                    AuthPolicy::OnRequired { method_id } => method_id,
                    AuthPolicy::Eager { .. } => None,
                };
                let method = match &configured {
                    Some(id) => init.auth_methods.iter().find(|m| &m.id == id).cloned(),
                    None => init
                        .auth_methods
                        .iter()
                        .find(|m| m.kind.is_none() || m.kind.as_deref() == Some("agent"))
                        .cloned(),
                };
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
                    shared.auth_required(
                        None,
                        Some(format!("Sign in to {}: {auth_error}", flavor.driver())),
                    );
                    return Err(EngineError::StartFailed(format!(
                        "authenticate {method_id}: {auth_error}"
                    )));
                }
                setup_once().await.map_err(|e| {
                    EngineError::StartFailed(format!("session setup after sign-in: {e}"))
                })?
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
            state.modes = setup.modes.clone().or_else(|| parse_modes(&setup.raw));
            state.config_options = setup.config_options.clone();
            state.setup = setup;
            state.preamble = (!preamble_parts.is_empty()).then(|| preamble_parts.join("\n\n"));
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

/// GOAT's MCP server for this thread: HTTP when the agent takes it (v1 `sessionMcpServers`).
/// v1 bridged stdio-only agents through `goat acp-mcp-bridge`; GOAT 2 has no bridge binary yet,
/// so those agents start without GOAT tools.
fn mcp_servers_for(init: &InitializeInfo, spec: &SessionSpec) -> Vec<McpServer> {
    if spec.mcp.url.is_empty() || !init.mcp_http {
        return Vec::new();
    }
    vec![McpServer::Http(
        McpServerHttp::new("goat", spec.mcp.url.clone()).headers(vec![HttpHeader::new(
            "Authorization",
            format!("Bearer {}", spec.mcp.bearer_token),
        )]),
    )]
}

#[allow(dead_code)]
fn approval_decision_label(decision: ApprovalDecision) -> &'static str {
    match decision {
        ApprovalDecision::Accept => "accept",
        ApprovalDecision::AcceptForSession => "acceptForSession",
        ApprovalDecision::AcceptAlways => "acceptAlways",
        ApprovalDecision::Decline => "decline",
        ApprovalDecision::Cancel => "cancel",
    }
}
