//! The Claude driver: one `claude` process per thread, driven over the stream-json control
//! protocol (`goat2-engine-api` `EngineFactory`/`EngineSession`).
//!
//! Behaviour lifted from GOAT v1 (origin/dev 916b5ccc), cited at each rule:
//! - boot: initialize with the appended system prompt (the SDK sends `systemPrompt.append` as
//!   initialize `appendSystemPrompt`; v1 `ClaudeAdapterV2.ts:719-735`), 5 minute boot deadline, then
//!   the GOAT MCP server through `mcp_set_servers` with a 90 second deadline, so the credential
//!   stays out of argv and the environment (`ClaudeAgentSdkQueryRunner.ts:75-76,500-540`).
//! - turns: one root user frame per turn with a uuid (`ClaudeUserMessage.ts`); Claude has no native
//!   turn ids, so turn ids are synthetic `turn:<uuid>` (`ClaudeTurnCursor.ts:3-4`).
//! - steering: an extra user frame with `priority:"next"` and its own uuid; Claude's
//!   `command_lifecycle` / echo is the acceptance evidence, and a result that arrives while a
//!   steer is still queued is held until the steer's own result (`ClaudeAdapterV2.ts:9899-10061`,
//!   `ClaudeSteerLifecycle.ts`, `ClaudePromptFrames.ts:41-84`).
//! - interrupt: only the active turn; the `interrupt` control (10 s), then the CLI is closed and
//!   the turn settles as interrupted when it exits. A CLI that does not confirm within the stop
//!   deadline leaves the turn open and the interrupt fails (`ClaudeAdapterV2.ts:9755-9818`,
//!   `ClaudeStopTeardown.ts`, `CLAUDE_STOP_CONFIRM_TIMEOUT_MS`).
//! - exit: one idempotent settlement closes open requests, settles the active turn, ends retained
//!   background subagents (interrupted when stopping, failed otherwise; v1
//!   `endSubagentCallsOfClosedQuery`), reaps the process group, then reports `Exited`.
//! - `can_use_tool`: AskUserQuestion becomes a `user_input_request`, ExitPlanMode a proposed plan
//!   plus a denial, the removal check under bypass a denial, everything else an approval
//!   (`ClaudeAdapterV2.ts:8241-8520`, `ClaudeApproval.ts`).
//! - result status and failure text: `ClaudeResultFailure.ts`; sign-in failures as
//!   `claudeSignedOutMessage` (`provider/Drivers/ClaudeHome.ts:131-140`).
//! - model and runtime mode: a model change uses `set_model` on the live process; a runtime mode
//!   change reopens the session with `--resume` (v1 keys the query on its permission policy,
//!   `claudeRuntimeQueryPolicyKey`, and declares no runtime-mode switch in session).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use async_trait::async_trait;
use goat2_contracts::{
    AssistantMessagePhase, ChatAttachment, ChatAttachmentType, EngineDriver, EngineItemLocator,
    EngineRef, ItemId, MessageId, NativeItemRef, NativeRefStrength, PlanId, ProviderCapabilities,
    ProviderProbeResult, RequestId, RequestKind, RequestOutcome, SubagentOrigin, ThreadId,
    TurnItem, TurnItemBody, TurnItemStatus,
};
use goat2_engine_api::{
    EngineError, EngineEvent, EngineFactory, EngineHandle, EngineInput, EngineSession,
    RequestAnswer, SessionSpec, SteerResult, TurnOutcome, TurnSettings, TurnStartResult,
};
use serde_json::{Map, Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{Notify, mpsc, oneshot};

use crate::items;
use crate::launch::{
    CompiledModel, LaunchOptions, LaunchRequest, PermissionMode, SessionIdentity, build_launch,
};
use crate::process::{ChildProcess, StderrTail, group_rss_bytes_of};
use crate::protocol::{self, Inbound};
use crate::util;

/// v1 `ProviderDriverKind` slug for Claude.
pub const DRIVER: &str = "claudeAgent";

/// Finds the saved file of an attachment (the host knows the thread folder).
pub type AttachmentResolver =
    Arc<dyn Fn(&ThreadId, &ChatAttachment) -> Option<PathBuf> + Send + Sync>;

/// Driver options. Defaults carry v1's values.
#[derive(Clone)]
pub struct ClaudeEngineOptions {
    pub launch: LaunchOptions,
    /// v1 `CLAUDE_BOOT_TIMEOUT` (5 minutes).
    pub boot_timeout: Duration,
    /// v1 `CLAUDE_MCP_REGISTRATION_TIMEOUT` (90 seconds).
    pub mcp_registration_timeout: Duration,
    /// Deadline for `set_model`, `set_permission_mode` and `interrupt` answers (the Python SDK's
    /// 60 second default; the TS SDK has none).
    pub control_timeout: Duration,
    /// v1 `CLAUDE_STOP_CONFIRM_TIMEOUT_MS` (10 seconds): the deadline for the `interrupt` answer
    /// and, after the CLI is closed, for the stop to be confirmed.
    pub interrupt_settle_timeout: Duration,
    /// How long a steer waits for Claude's `command_lifecycle` acknowledgement.
    pub steer_ack_timeout: Duration,
    /// v1 `CLAUDE_GOAT_MCP_TOOL_TIMEOUT_MS` (65 minutes): GOAT's wait tools block up to an hour.
    pub mcp_tool_timeout_ms: u64,
    pub attachments: Option<AttachmentResolver>,
}

impl Default for ClaudeEngineOptions {
    fn default() -> Self {
        Self {
            launch: LaunchOptions::default(),
            boot_timeout: Duration::from_secs(5 * 60),
            mcp_registration_timeout: Duration::from_secs(90),
            control_timeout: Duration::from_secs(60),
            interrupt_settle_timeout: Duration::from_secs(10),
            steer_ack_timeout: Duration::from_secs(10),
            mcp_tool_timeout_ms: 65 * 60 * 1000,
            attachments: None,
        }
    }
}

impl std::fmt::Debug for ClaudeEngineOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ClaudeEngineOptions")
            .field("launch", &self.launch)
            .finish_non_exhaustive()
    }
}

/// Starts one `claude` process per thread.
#[derive(Debug, Clone, Default)]
pub struct ClaudeEngineFactory {
    pub options: ClaudeEngineOptions,
}

impl ClaudeEngineFactory {
    pub fn new(options: ClaudeEngineOptions) -> Self {
        Self { options }
    }
}

#[async_trait]
impl EngineFactory for ClaudeEngineFactory {
    async fn start(&self, spec: SessionSpec) -> Result<EngineHandle, EngineError> {
        start_session(self.options.clone(), spec).await
    }

    fn capabilities(&self) -> ProviderCapabilities {
        crate::capabilities::claude_capabilities()
    }

    async fn probe(&self) -> Result<ProviderProbeResult, EngineError> {
        Ok(crate::probe::probe(&self.options.launch).await)
    }
}

/// One live question or approval from `can_use_tool`, keyed by the CLI's request id.
#[derive(Debug, Clone)]
enum Pending {
    Approval {
        tool_name: String,
        tool_use_id: String,
        input: Value,
        suggestions: Option<Value>,
    },
    Question {
        tool_use_id: String,
        input: Value,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SteerPhase {
    Sent,
    Queued,
    Consumed,
}

#[derive(Debug, Clone)]
struct ToolCall {
    name: String,
    input: Value,
}

#[derive(Debug)]
struct Turn {
    id: String,
    /// The root prompt reached Claude's stdin; only then does an exit settle the turn.
    confirmed: bool,
    interrupted: bool,
    steers: HashMap<String, SteerPhase>,
    tools: HashMap<String, ToolCall>,
    /// The latest assistant text: commentary if more follows, the final answer at the result.
    held_text: Option<(String, String)>,
    /// Next content-block index per assistant message id.
    blocks: HashMap<String, u32>,
    /// Message id of the message being streamed.
    stream_message: Option<String>,
    /// Claude's result, held while the answer to an interrupt of this turn is pending; that
    /// answer decides whether the result is a completion or the interrupt.
    held_for_interrupt: Option<Value>,
    saw_text: bool,
    auth_failure: bool,
    usage_limit: bool,
    held_result: Option<Value>,
    /// A result Claude sent before a queued steer ran; the turn continues.
    absorbed_result: bool,
}

/// Whether this CLI reports `command_lifecycle` for prompts (2.1.332 does, right after reading
/// the root prompt and before `system:init`; 2.1.111 never does).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Lifecycle {
    Unknown,
    Reported,
    Absent,
}

/// A background subagent whose launch Claude acknowledged, with the turn that started it.
#[derive(Debug, Clone)]
struct BackgroundSubagent {
    call: ToolCall,
    turn_id: String,
}

#[derive(Debug)]
struct State {
    session_id: String,
    model: CompiledModel,
    permission_mode: PermissionMode,
    /// The launch args pin the permission mode (v1 folds `--permission-mode`).
    pinned_mode: Option<PermissionMode>,
    turn: Option<Turn>,
    pending: HashMap<String, Pending>,
    /// Steer acknowledgements waiting for `command_lifecycle`.
    steer_waiters: HashMap<String, oneshot::Sender<Result<(), String>>>,
    /// Without `command_lifecycle` steers are accepted on write.
    lifecycle: Lifecycle,
    /// Subagent tool_use id per Claude task id.
    tasks: HashMap<String, String>,
    /// Background subagents, kept past their turn until `task_notification` or exit
    /// (v1 `sessionSubagentsByTaskId`, `ClaudeAdapterV2.ts:2572-2574`).
    async_subagents: HashMap<String, BackgroundSubagent>,
    ordinal: u32,
    exited: bool,
    shutting_down: bool,
    /// The process is being stopped on purpose (interrupt or shutdown).
    stopping: bool,
    /// The interrupt control in flight: request id and the turn it stops.
    interrupt_request: Option<(String, String)>,
    /// Why the process is going away when it is not the CLI's own doing.
    exit_hint: Option<String>,
}

struct Process {
    child: ChildProcess,
    generation: u64,
}

/// A stdin line and, for frames whose delivery matters, who to tell once it was written.
type Outgoing = (String, Option<oneshot::Sender<Result<(), String>>>);

/// How a frame that needs delivery fared.
enum Delivery {
    Written,
    NotRunning,
    Failed(String),
}

struct Inner {
    options: ClaudeEngineOptions,
    launch: LaunchOptions,
    thread_id: ThreadId,
    provider_instance_id: String,
    cwd: String,
    mcp_url: String,
    mcp_token: String,
    append_system_prompt: Option<String>,
    state: Mutex<State>,
    events: mpsc::UnboundedSender<EngineEvent>,
    controls: Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>,
    writer: Mutex<Option<mpsc::UnboundedSender<Outgoing>>>,
    process: tokio::sync::Mutex<Option<Process>>,
    stderr: Mutex<Option<(u64, Arc<Mutex<StderrTail>>)>>,
    /// Woken whenever the active turn settles.
    settled: Notify,
    /// Held for the whole of an interrupt and of a turn start, so no turn starts on a process an
    /// interrupt is closing.
    stop_gate: tokio::sync::Mutex<()>,
    generation: AtomicU64,
    next_request: AtomicU64,
    pgid: AtomicU32,
}

/// A started Claude session (one thread).
pub struct ClaudeSession {
    inner: Arc<Inner>,
}

async fn start_session(
    options: ClaudeEngineOptions,
    spec: SessionSpec,
) -> Result<EngineHandle, EngineError> {
    let mut launch = options.launch.clone();
    if let Some(spec_launch) = &spec.launch {
        if let Some(binary) = &spec_launch.binary {
            launch.binary = binary.clone();
        }
        launch.launch_args.extend(spec_launch.args.iter().cloned());
        launch
            .env
            .extend(spec_launch.env.iter().map(|(k, v)| (k.clone(), v.clone())));
    }
    let identity = match &spec.resume {
        Some(reference) if reference.driver == EngineDriver::ClaudeAgent => {
            SessionIdentity::Resume(reference.id.clone())
        }
        Some(reference) => {
            return Err(EngineError::StartFailed(format!(
                "cannot resume a {} session with the Claude driver",
                reference.driver.driver_kind()
            )));
        }
        None => SessionIdentity::New(util::uuid()),
    };
    let model = CompiledModel::compile(&spec.engine.model_selection);
    let permission_mode = PermissionMode::for_runtime_mode(spec.engine.runtime_mode);
    let (events, events_rx) = mpsc::unbounded_channel();
    let inner = Arc::new(Inner {
        options,
        launch,
        thread_id: spec.thread_id.clone(),
        provider_instance_id: spec.engine.provider_instance_id.to_string(),
        cwd: spec.engine.cwd.clone(),
        mcp_url: spec.mcp.url.clone(),
        mcp_token: spec.mcp.bearer_token.clone(),
        append_system_prompt: spec
            .instructions
            .as_ref()
            .and_then(|i| i.append_system_prompt.clone())
            .filter(|text| !text.is_empty()),
        state: Mutex::new(State {
            session_id: identity.id().to_string(),
            model: model.clone(),
            permission_mode,
            pinned_mode: None,
            turn: None,
            pending: HashMap::new(),
            steer_waiters: HashMap::new(),
            lifecycle: Lifecycle::Unknown,
            tasks: HashMap::new(),
            async_subagents: HashMap::new(),
            ordinal: 0,
            exited: false,
            shutting_down: false,
            stopping: false,
            interrupt_request: None,
            exit_hint: None,
        }),
        events,
        controls: Mutex::new(HashMap::new()),
        writer: Mutex::new(None),
        process: tokio::sync::Mutex::new(None),
        stderr: Mutex::new(None),
        settled: Notify::new(),
        stop_gate: tokio::sync::Mutex::new(()),
        generation: AtomicU64::new(0),
        next_request: AtomicU64::new(0),
        pgid: AtomicU32::new(0),
    });
    if let Err(error) = inner.spawn(&identity, &model, permission_mode).await {
        inner.kill_process().await;
        return Err(EngineError::StartFailed(error));
    }
    Ok(EngineHandle {
        session: Box::new(ClaudeSession {
            inner: Arc::clone(&inner),
        }),
        events: events_rx,
        engine_ref: EngineRef {
            driver: EngineDriver::ClaudeAgent,
            id: identity.id().to_string(),
        },
    })
}

impl Inner {
    fn emit(&self, event: EngineEvent) {
        let _ = self.events.send(event);
    }

    fn write(&self, frame: &Value) -> bool {
        let writer = self.writer.lock().map(|w| w.clone()).ok().flatten();
        match writer {
            Some(tx) => tx.send((frame.to_string(), None)).is_ok(),
            None => false,
        }
    }

    /// Write a frame and wait until it is on Claude's stdin (or the write failed).
    async fn deliver(&self, frame: &Value) -> Delivery {
        let writer = self.writer.lock().map(|w| w.clone()).ok().flatten();
        let Some(tx) = writer else {
            return Delivery::NotRunning;
        };
        let (ack, written) = oneshot::channel();
        if tx.send((frame.to_string(), Some(ack))).is_err() {
            return Delivery::NotRunning;
        }
        match written.await {
            Ok(Ok(())) => Delivery::Written,
            Ok(Err(error)) => Delivery::Failed(error),
            Err(_) => Delivery::Failed("Claude's input closed before the write".into()),
        }
    }

    fn request_id(&self) -> String {
        let n = self.next_request.fetch_add(1, Ordering::Relaxed) + 1;
        let tag = &util::uuid()[..8];
        format!("req_{n}_{tag}")
    }

    /// Send a control request and wait for its answer (R9-R11). A timed-out request is withdrawn
    /// with `control_cancel_request` (R13).
    async fn control(&self, request: Value, timeout: Duration) -> Result<Value, String> {
        let id = self.request_id();
        self.control_with_id(id, request, timeout).await
    }

    async fn control_with_id(
        &self,
        id: String,
        request: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        let subtype = request
            .get("subtype")
            .and_then(Value::as_str)
            .unwrap_or("control")
            .to_string();
        let (tx, rx) = oneshot::channel();
        if let Ok(mut controls) = self.controls.lock() {
            controls.insert(id.clone(), tx);
        }
        if !self.write(&protocol::control_request(&id, request)) {
            if let Ok(mut controls) = self.controls.lock() {
                controls.remove(&id);
            }
            return Err("Claude is not running".to_string());
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("Claude exited before answering".to_string()),
            Err(_) => {
                if let Ok(mut controls) = self.controls.lock() {
                    controls.remove(&id);
                }
                self.write(&json!({"type": "control_cancel_request", "request_id": id}));
                Err(format!("Control request timeout: {subtype}"))
            }
        }
    }

    /// Start (or restart) the CLI, initialize it and attach the GOAT MCP server.
    async fn spawn(
        self: &Arc<Self>,
        identity: &SessionIdentity,
        model: &CompiledModel,
        permission_mode: PermissionMode,
    ) -> Result<(), String> {
        if self.state.lock().map(|s| s.shutting_down).unwrap_or(true) {
            return Err("Claude is shutting down".into());
        }
        let (launch, folds, effective_mode) = build_launch(
            &self.launch,
            &LaunchRequest {
                cwd: &self.cwd,
                model,
                permission_mode,
                identity,
                mcp_url: Some(&self.mcp_url),
            },
        )?;
        let mut child = ChildProcess::spawn(&launch).map_err(|error| {
            format!("could not start {}: {error}", self.launch.binary.display())
        })?;
        let stdin = child.take_stdin().ok_or("claude stdin unavailable")?;
        let stdout = child.take_stdout().ok_or("claude stdout unavailable")?;
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.pgid.store(child.pid(), Ordering::SeqCst);
        if let Ok(mut stderr) = self.stderr.lock() {
            *stderr = Some((generation, child.stderr_handle()));
        }
        let (tx, mut rx) = mpsc::unbounded_channel::<Outgoing>();
        if let Ok(mut writer) = self.writer.lock() {
            *writer = Some(tx);
        }
        let owner: Weak<Self> = Arc::downgrade(self);
        tokio::spawn(async move {
            let mut stdin = stdin;
            while let Some((line, ack)) = rx.recv().await {
                let written = async {
                    stdin.write_all(line.as_bytes()).await?;
                    stdin.write_all(b"\n").await?;
                    stdin.flush().await
                }
                .await;
                match written {
                    Ok(()) => {
                        if let Some(ack) = ack {
                            let _ = ack.send(Ok(()));
                        }
                    }
                    Err(error) => {
                        let reason = format!("Claude stopped reading its input: {error}");
                        if let Some(ack) = ack {
                            let _ = ack.send(Err(reason.clone()));
                        }
                        rx.close();
                        while let Some((_, ack)) = rx.recv().await {
                            if let Some(ack) = ack {
                                let _ = ack.send(Err(reason.clone()));
                            }
                        }
                        if let Some(inner) = owner.upgrade() {
                            inner.close_process(generation, reason).await;
                        }
                        return;
                    }
                }
            }
        });
        {
            // Checked under the process lock: either shutdown sees this process and ends it, or
            // this sees the shutdown and starts nothing.
            let mut slot = self.process.lock().await;
            let admitted = match self.state.lock() {
                Ok(mut state) if !state.shutting_down => {
                    state.permission_mode = effective_mode;
                    state.pinned_mode = folds.permission_mode;
                    state.model = model.clone();
                    state.exited = false;
                    state.stopping = false;
                    state.exit_hint = None;
                    true
                }
                _ => false,
            };
            if !admitted {
                if let Ok(mut writer) = self.writer.lock() {
                    writer.take();
                }
                child.shutdown().await;
                return Err("Claude is shutting down".into());
            }
            *slot = Some(Process { child, generation });
        }
        let reader = Arc::clone(self);
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if line.trim().is_empty() {
                    continue;
                }
                reader.on_line(generation, &line);
            }
            reader.on_eof(generation).await;
        });

        let mut append: Vec<String> = Vec::new();
        append.extend(self.append_system_prompt.clone());
        append.extend(folds.append_system_prompt.iter().cloned());
        let mut initialize = Map::new();
        initialize.insert("subtype".into(), json!("initialize"));
        if !append.is_empty() {
            initialize.insert("appendSystemPrompt".into(), json!(append.join("\n\n")));
        }
        self.control(Value::Object(initialize), self.options.boot_timeout)
            .await
            .map_err(|error| format!("Claude did not initialize: {error}"))?;
        if !self.mcp_url.is_empty() {
            let servers = json!({"goat": {
                "type": "http",
                "url": self.mcp_url,
                "headers": {"Authorization": format!("Bearer {}", self.mcp_token)},
                "timeout": self.options.mcp_tool_timeout_ms,
            }});
            // v1 logs the failed server names and carries on; only the deadline fails the open.
            if let Err(error) = self
                .control(
                    json!({"subtype": "mcp_set_servers", "servers": servers}),
                    self.options.mcp_registration_timeout,
                )
                .await
                && error.starts_with("Control request timeout")
            {
                return Err(format!(
                    "Claude did not register the GOAT MCP server: {error}"
                ));
            }
        }
        Ok(())
    }

    async fn kill_process(&self) {
        if let Ok(mut writer) = self.writer.lock() {
            writer.take();
        }
        if let Some(mut process) = self.process.lock().await.take() {
            process.child.shutdown().await;
        }
    }

    fn on_line(&self, generation: u64, line: &str) {
        if generation != self.generation.load(Ordering::SeqCst) {
            return;
        }
        let Ok(frame) = protocol::parse_line(line) else {
            return;
        };
        match frame {
            Inbound::ControlResponse { request_id, result } => {
                // A refused interrupt is undone before any later frame is read, so the turn's own
                // result decides its outcome; a result held for this answer is applied now.
                if let Ok(mut state) = self.state.lock()
                    && let Some((id, turn_id)) = state.interrupt_request.take()
                {
                    if id != request_id {
                        state.interrupt_request = Some((id, turn_id));
                    } else if let Some(turn) = state.turn.as_mut()
                        && turn.id == turn_id
                    {
                        if result.is_err() {
                            turn.interrupted = false;
                        }
                        if let Some(held) = turn.held_for_interrupt.take() {
                            self.on_result(&mut state, &held);
                        }
                    }
                }
                let waiter = self
                    .controls
                    .lock()
                    .ok()
                    .and_then(|mut controls| controls.remove(&request_id));
                if let Some(waiter) = waiter {
                    let _ = waiter.send(result);
                }
            }
            Inbound::ControlRequest {
                request_id,
                request,
            } => self.on_control_request(&request_id, &request),
            Inbound::ControlCancel { request_id } => {
                let removed = self
                    .state
                    .lock()
                    .map(|mut state| state.pending.remove(&request_id).is_some())
                    .unwrap_or(false);
                if removed {
                    self.emit(EngineEvent::RequestClosed { key: request_id });
                }
            }
            Inbound::KeepAlive => {}
            Inbound::Message(message) => {
                if let Ok(mut state) = self.state.lock() {
                    self.on_message(&mut state, &message);
                }
            }
        }
    }

    async fn on_eof(&self, generation: u64) {
        if generation != self.generation.load(Ordering::SeqCst) {
            return;
        }
        let stderr = self
            .stderr
            .lock()
            .ok()
            .and_then(|s| {
                s.as_ref()
                    .filter(|(g, _)| *g == generation)
                    .map(|(_, t)| Arc::clone(t))
            })
            .and_then(|tail| tail.lock().ok().map(|t| t.text()))
            .unwrap_or_default();
        let last = stderr
            .lines()
            .rev()
            .find(|line| !line.trim().is_empty())
            .unwrap_or_default()
            .trim()
            .to_string();
        let reason = if last.is_empty() {
            "Claude exited".to_string()
        } else {
            format!("Claude exited: {}", items::truncate(&last, 500))
        };
        let exited = self.settle_exit(&reason);
        // Reap the leader and end its group before saying nothing more follows. A shutdown or
        // close holding the process finishes its own stop first.
        self.reap(generation).await;
        if let Some(reason) = exited {
            self.emit(EngineEvent::Exited { reason });
        }
    }

    /// The one exit settlement (idempotent): stop writing, fail waiting controls and steers,
    /// close open requests, settle the active turn and end retained background subagents.
    /// Returns the `Exited` reason when this call settled, None when the session had already.
    fn settle_exit(&self, observed: &str) -> Option<String> {
        if let Ok(mut writer) = self.writer.lock() {
            writer.take();
        }
        if let Ok(mut controls) = self.controls.lock() {
            controls.clear();
        }
        let mut state = self.state.lock().ok()?;
        if state.exited {
            return None;
        }
        state.exited = true;
        let reason = if state.shutting_down {
            "shutdown".to_string()
        } else {
            state
                .exit_hint
                .clone()
                .unwrap_or_else(|| observed.to_string())
        };
        for (key, _) in state.pending.drain() {
            self.emit(EngineEvent::RequestClosed { key });
        }
        for (_, waiter) in state.steer_waiters.drain() {
            let _ = waiter.send(Err(reason.clone()));
        }
        self.flush_text(&mut state, AssistantMessagePhase::Commentary);
        let stopping = state.stopping || state.shutting_down;
        if let Some(turn) = state.turn.take()
            && turn.confirmed
        {
            let outcome = if turn.interrupted || stopping {
                TurnOutcome::Interrupted
            } else {
                TurnOutcome::Failed {
                    reason: reason.clone(),
                }
            };
            self.emit(EngineEvent::TurnFinished {
                turn_id: turn.id,
                outcome,
            });
        }
        let status = if stopping {
            TurnItemStatus::Interrupted
        } else {
            TurnItemStatus::Failed
        };
        let mut background: Vec<(String, BackgroundSubagent)> =
            state.async_subagents.drain().collect();
        background.sort_by(|a, b| a.0.cmp(&b.0));
        for (tool_use_id, subagent) in background {
            self.emit(EngineEvent::SubagentUpdate {
                turn_id: Some(subagent.turn_id.clone()),
                subagent_id: tool_use_id.clone(),
                status,
                title: None,
                progress: None,
            });
            let body = self.subagent_body(&tool_use_id, &subagent.call, None);
            let item = self.item(
                &mut state,
                &subagent.turn_id,
                &tool_use_id,
                Some(&tool_use_id),
                status,
                body,
            );
            self.complete(&mut state, &subagent.turn_id, item, Some(&tool_use_id));
        }
        drop(state);
        self.settled.notify_waiters();
        Some(reason)
    }

    /// Wait for and end the process of `generation` (leader and group), if it is still held.
    async fn reap(&self, generation: u64) {
        let mut process = self.process.lock().await;
        if process.as_ref().is_some_and(|p| p.generation == generation)
            && let Some(mut process) = process.take()
        {
            process.child.shutdown().await;
        }
    }

    /// Stop the process of `generation` now (TERM, then KILL after the grace): a broken stdin, or
    /// the close after an interrupt (v1 `interruptUnlessClosed` closes the query). The reader's
    /// EOF then settles the session.
    async fn close_process(&self, generation: u64, reason: String) {
        if generation != self.generation.load(Ordering::SeqCst) {
            return;
        }
        if let Ok(mut state) = self.state.lock()
            && state.exit_hint.is_none()
        {
            state.exit_hint = Some(reason);
        }
        if let Ok(mut writer) = self.writer.lock() {
            writer.take();
        }
        let mut process = self.process.lock().await;
        if process.as_ref().is_some_and(|p| p.generation == generation)
            && let Some(mut process) = process.take()
        {
            process.child.terminate_group().await;
        }
    }

    fn item(
        &self,
        state: &mut State,
        turn_id: &str,
        id: &str,
        native_id: Option<&str>,
        status: TurnItemStatus,
        body: TurnItemBody,
    ) -> TurnItem {
        let now = util::now_rfc3339();
        state.ordinal += 1;
        TurnItem {
            id: ItemId::from(id),
            thread_id: self.thread_id.clone(),
            run_id: None,
            provider_thread_id: Some(state.session_id.clone()),
            provider_turn_id: Some(turn_id.to_string()),
            native_item_ref: Some(NativeItemRef {
                driver: DRIVER.to_string(),
                native_id: native_id.map(str::to_owned),
                strength: NativeRefStrength::Strong,
                fingerprint: None,
                ordinal: None,
            }),
            parent_item_id: None,
            ordinal: state.ordinal,
            status,
            title: None,
            started_at: None,
            completed_at: Some(now.clone()),
            updated_at: now,
            body,
        }
    }

    fn complete(&self, state: &mut State, turn_id: &str, item: TurnItem, native: Option<&str>) {
        let locator = native.map(|native| EngineItemLocator {
            turn_id: turn_id.to_string(),
            item_id: native.to_string(),
        });
        self.emit(EngineEvent::ItemCompleted {
            turn_id: turn_id.to_string(),
            item: Box::new(item),
            locator,
        });
        let _ = state;
    }

    /// Emit the held assistant text with this phase.
    fn flush_text(&self, state: &mut State, phase: AssistantMessagePhase) {
        let Some(turn) = state.turn.as_mut() else {
            return;
        };
        let Some((id, text)) = turn.held_text.take() else {
            return;
        };
        let turn_id = turn.id.clone();
        let item = self.item(
            state,
            &turn_id,
            &id,
            Some(&id),
            TurnItemStatus::Completed,
            TurnItemBody::AssistantMessage {
                phase: Some(phase),
                delivery: None,
                message_id: MessageId::from(id.as_str()),
                text,
                attachments: None,
                streaming: false,
            },
        );
        self.complete(state, &turn_id, item, Some(&id));
    }

    fn on_message(&self, state: &mut State, message: &Value) {
        let kind = message.get("type").and_then(Value::as_str).unwrap_or("");
        // A lifecycle-capable CLI answers the root prompt with `command_lifecycle` before anything
        // else (2.1.332 capture: queued, started, then system:init). Any other first frame after a
        // prompt means this CLI never reports it, so steers waiting on it are accepted on write.
        if state.lifecycle == Lifecycle::Unknown && state.turn.is_some() {
            if kind == "command_lifecycle" {
                state.lifecycle = Lifecycle::Reported;
            } else {
                state.lifecycle = Lifecycle::Absent;
                for (_, waiter) in state.steer_waiters.drain() {
                    let _ = waiter.send(Ok(()));
                }
            }
        }
        if let Some(session_id) = message.get("session_id").and_then(Value::as_str)
            && !session_id.is_empty()
            && kind == "system"
        {
            state.session_id = session_id.to_string();
        }
        match kind {
            "system" => self.on_system(state, message),
            "command_lifecycle" => self.on_lifecycle(state, message),
            "stream_event" if protocol::parent_tool_use_id(message).is_none() => {
                self.on_stream_event(state, message)
            }
            "assistant" if protocol::parent_tool_use_id(message).is_none() => {
                self.on_assistant(state, message)
            }
            "user" if protocol::parent_tool_use_id(message).is_none() => {
                self.on_user(state, message)
            }
            "result" => {
                let awaiting_interrupt = matches!(
                    (&state.interrupt_request, state.turn.as_ref()),
                    (Some((_, stopping)), Some(turn)) if *stopping == turn.id
                );
                if awaiting_interrupt {
                    if let Some(turn) = state.turn.as_mut() {
                        turn.held_for_interrupt = Some(message.clone());
                    }
                } else {
                    self.on_result(state, message)
                }
            }
            "rate_limit_event" => {
                let rejected = message
                    .get("rate_limit_info")
                    .and_then(|info| info.get("status"))
                    .and_then(Value::as_str)
                    == Some("rejected");
                if rejected && let Some(turn) = state.turn.as_mut() {
                    turn.usage_limit = true;
                }
            }
            _ => {}
        }
        // Any frame echoing a steer's uuid shows Claude read it.
        let echoed = protocol::echoed_prompt_uuids(message);
        if !echoed.is_empty() {
            for uuid in echoed {
                self.mark_steer(state, &uuid, SteerPhase::Consumed);
            }
        }
    }

    fn mark_steer(&self, state: &mut State, uuid: &str, phase: SteerPhase) {
        if let Some(turn) = state.turn.as_mut()
            && let Some(current) = turn.steers.get_mut(uuid)
            && *current != SteerPhase::Consumed
        {
            *current = phase;
            if let Some(waiter) = state.steer_waiters.remove(uuid) {
                let _ = waiter.send(Ok(()));
            }
        }
    }

    fn on_lifecycle(&self, state: &mut State, message: &Value) {
        state.lifecycle = Lifecycle::Reported;
        let (Some(uuid), Some(phase)) = (
            message.get("command_uuid").and_then(Value::as_str),
            message.get("state").and_then(Value::as_str),
        ) else {
            return;
        };
        match phase {
            "queued" => self.mark_steer(state, uuid, SteerPhase::Queued),
            // v1 markSteersAccepted (ClaudeAdapterV2.ts:5241-5249): completed alone is no proof,
            // Claude also completes prompts it never started.
            "started" => self.mark_steer(state, uuid, SteerPhase::Consumed),
            "cancelled" | "discarded" | "refused" => {
                // v1 dropUnreadSteer: the steer never reached Claude.
                let dropped = state
                    .turn
                    .as_mut()
                    .and_then(|turn| turn.steers.remove(uuid))
                    .is_some();
                if let Some(waiter) = state.steer_waiters.remove(uuid) {
                    let _ = waiter.send(Err(format!("Claude {phase} the message")));
                }
                if dropped {
                    let release = state.turn.as_ref().is_some_and(|turn| {
                        turn.held_result.is_some() && !Self::steers_outstanding(turn)
                    });
                    if release
                        && let Some(result) = state.turn.as_mut().and_then(|t| t.held_result.take())
                    {
                        self.finish(state, &result);
                    }
                }
            }
            _ => {}
        }
    }

    fn steers_outstanding(turn: &Turn) -> bool {
        turn.steers
            .values()
            .any(|phase| *phase != SteerPhase::Consumed)
    }

    fn on_system(&self, state: &mut State, message: &Value) {
        let subtype = message.get("subtype").and_then(Value::as_str).unwrap_or("");
        // A new CLI turn after a held or absorbed result is the queued steer running (v1 keeps the
        // steered turn open across Claude's own result, ClaudeSteerLifecycle.ts).
        if subtype == "init"
            && let Some(turn) = state.turn.as_mut()
            && turn.absorbed_result
        {
            for phase in turn.steers.values_mut() {
                *phase = SteerPhase::Consumed;
            }
            turn.absorbed_result = false;
            turn.held_result = None;
        }
        match subtype {
            "task_started" | "task_progress" | "task_updated" | "task_notification" => {
                self.on_task(state, subtype, message)
            }
            "compact_boundary" => {
                let Some(turn_id) = state.turn.as_ref().map(|t| t.id.clone()) else {
                    return;
                };
                let id = protocol::str_field(message, "uuid").unwrap_or_else(util::uuid);
                let metadata = message.get("compact_metadata");
                let before = metadata
                    .and_then(|m| m.get("pre_tokens"))
                    .and_then(Value::as_u64);
                let after = metadata
                    .and_then(|m| m.get("post_tokens"))
                    .and_then(Value::as_u64);
                let item = self.item(
                    state,
                    &turn_id,
                    &id,
                    Some(&id),
                    TurnItemStatus::Completed,
                    TurnItemBody::Compaction {
                        driver: Some(DRIVER.to_string()),
                        summary: None,
                        before_token_count: before,
                        after_token_count: after,
                    },
                );
                self.complete(state, &turn_id, item, Some(&id));
            }
            _ => {}
        }
    }

    /// Claude `task_*` frames for subagents (v1 `ClaudeAdapterV2.ts` task lifecycle; R32-R33).
    fn on_task(&self, state: &mut State, subtype: &str, message: &Value) {
        let Some(task_id) = protocol::str_field(message, "task_id") else {
            return;
        };
        let tool_use_id = protocol::str_field(message, "tool_use_id")
            .or_else(|| state.tasks.get(&task_id).cloned());
        let Some(tool_use_id) = tool_use_id else {
            return;
        };
        // Only Agent-tool tasks are subagents; shell and monitor tasks are not (v1
        // `isClaudeOpaqueBackgroundTaskType`).
        let is_subagent = state
            .turn
            .as_ref()
            .and_then(|turn| turn.tools.get(&tool_use_id))
            .map(|tool| items::is_subagent_tool(&tool.name))
            .unwrap_or(false)
            || state.async_subagents.contains_key(&tool_use_id)
            || state.tasks.contains_key(&task_id);
        if !is_subagent {
            return;
        }
        state.tasks.insert(task_id.clone(), tool_use_id.clone());
        // A background subagent belongs to the turn that started it, even when another turn (or
        // none) is active now.
        let turn_id = state
            .async_subagents
            .get(&tool_use_id)
            .map(|subagent| subagent.turn_id.clone())
            .or_else(|| state.turn.as_ref().map(|turn| turn.id.clone()));
        let description = protocol::str_field(message, "description");
        let status = match subtype {
            "task_notification" => match message.get("status").and_then(Value::as_str) {
                Some("completed") => TurnItemStatus::Completed,
                Some("failed") => TurnItemStatus::Failed,
                _ => TurnItemStatus::Cancelled,
            },
            "task_updated" => match message
                .get("patch")
                .and_then(|p| p.get("status"))
                .and_then(Value::as_str)
            {
                Some("completed") => TurnItemStatus::Completed,
                Some("failed") => TurnItemStatus::Failed,
                Some("killed") => TurnItemStatus::Cancelled,
                Some("pending") => TurnItemStatus::Pending,
                _ => TurnItemStatus::Running,
            },
            _ => TurnItemStatus::Running,
        };
        let progress = match subtype {
            "task_notification" => protocol::str_field(message, "summary"),
            "task_progress" => description.clone(),
            _ => None,
        };
        self.emit(EngineEvent::SubagentUpdate {
            turn_id: turn_id.clone(),
            subagent_id: tool_use_id.clone(),
            status,
            title: if subtype == "task_started" {
                description
            } else {
                None
            },
            progress: progress.clone(),
        });
        if subtype == "task_notification"
            && let Some(subagent) = state.async_subagents.remove(&tool_use_id)
        {
            let turn_id = subagent.turn_id;
            let body = self.subagent_body(&tool_use_id, &subagent.call, progress);
            let item = self.item(
                state,
                &turn_id,
                &tool_use_id,
                Some(&tool_use_id),
                status,
                body,
            );
            self.complete(state, &turn_id, item, Some(&tool_use_id));
        }
    }

    fn subagent_body(
        &self,
        tool_use_id: &str,
        call: &ToolCall,
        result: Option<String>,
    ) -> TurnItemBody {
        let prompt = call
            .input
            .get("prompt")
            .or_else(|| call.input.get("description"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        TurnItemBody::Subagent {
            subagent_id: tool_use_id.to_string(),
            origin: SubagentOrigin::ProviderNative,
            driver: DRIVER.to_string(),
            provider_instance_id: self.provider_instance_id.clone(),
            child_thread_id: None,
            prompt,
            progress: call
                .input
                .get("description")
                .and_then(Value::as_str)
                .map(str::to_owned),
            result,
        }
    }

    fn on_stream_event(&self, state: &mut State, message: &Value) {
        let Some(turn) = state.turn.as_mut() else {
            return;
        };
        let Some(event) = message.get("event") else {
            return;
        };
        match event.get("type").and_then(Value::as_str) {
            Some("message_start") => {
                turn.stream_message = event
                    .get("message")
                    .and_then(|m| m.get("id"))
                    .and_then(Value::as_str)
                    .map(str::to_owned);
            }
            Some("content_block_delta") => {
                let delta = event.get("delta");
                if delta.and_then(|d| d.get("type")).and_then(Value::as_str) != Some("text_delta") {
                    return;
                }
                let (Some(message_id), Some(index), Some(text)) = (
                    turn.stream_message.clone(),
                    event.get("index").and_then(Value::as_u64),
                    delta.and_then(|d| d.get("text")).and_then(Value::as_str),
                ) else {
                    return;
                };
                self.emit(EngineEvent::TextDelta {
                    turn_id: turn.id.clone(),
                    item_id: ItemId::from(format!("{message_id}:{index}")),
                    text: text.to_string(),
                });
            }
            _ => {}
        }
    }

    fn on_assistant(&self, state: &mut State, message: &Value) {
        let Some(turn) = state.turn.as_mut() else {
            return;
        };
        let body = message.get("message").cloned().unwrap_or(Value::Null);
        // Claude's own error frames ("<synthetic>" model with an `error`) are not model output.
        if let Some(error) = message.get("error").and_then(Value::as_str) {
            if error == "authentication_failed" {
                turn.auth_failure = true;
            }
            if error == "rate_limit" {
                turn.usage_limit = true;
            }
            if body.get("model").and_then(Value::as_str) == Some("<synthetic>") {
                return;
            }
        }
        let message_id = body
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(util::uuid);
        let Some(content) = body.get("content").and_then(Value::as_array) else {
            return;
        };
        let turn_id = turn.id.clone();
        for block in content {
            let index = {
                let Some(turn) = state.turn.as_mut() else {
                    return;
                };
                let next = turn.blocks.entry(message_id.clone()).or_insert(0);
                let index = *next;
                *next += 1;
                index
            };
            let id = format!("{message_id}:{index}");
            match block.get("type").and_then(Value::as_str) {
                Some("text") => {
                    let text = block
                        .get("text")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    if text.trim().is_empty() {
                        continue;
                    }
                    self.flush_text(state, AssistantMessagePhase::Commentary);
                    if let Some(turn) = state.turn.as_mut() {
                        turn.held_text = Some((id, text.to_string()));
                        turn.saw_text = true;
                    }
                }
                Some("thinking") => {
                    let text = block
                        .get("thinking")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    if text.trim().is_empty() {
                        continue;
                    }
                    let item = self.item(
                        state,
                        &turn_id,
                        &id,
                        Some(&id),
                        TurnItemStatus::Completed,
                        TurnItemBody::Reasoning {
                            text: text.to_string(),
                            streaming: false,
                        },
                    );
                    self.complete(state, &turn_id, item, Some(&id));
                }
                Some("tool_use") | Some("server_tool_use") | Some("mcp_tool_use") => {
                    let (Some(tool_id), Some(name)) = (
                        block.get("id").and_then(Value::as_str),
                        block.get("name").and_then(Value::as_str),
                    ) else {
                        continue;
                    };
                    self.flush_text(state, AssistantMessagePhase::Commentary);
                    let input = block.get("input").cloned().unwrap_or(json!({}));
                    // v1 projects a root TodoWrite as the todo list (ClaudeAdapterV2.ts:7553).
                    if name == "TodoWrite" {
                        let steps = items::todo_steps(&input);
                        let item = self.item(
                            state,
                            &turn_id,
                            tool_id,
                            Some(tool_id),
                            TurnItemStatus::Completed,
                            TurnItemBody::TodoList {
                                plan_id: PlanId::from(tool_id),
                                steps,
                                explanation: None,
                            },
                        );
                        self.complete(state, &turn_id, item, Some(tool_id));
                    }
                    if let Some(turn) = state.turn.as_mut() {
                        turn.tools.insert(
                            tool_id.to_string(),
                            ToolCall {
                                name: name.to_string(),
                                input,
                            },
                        );
                    }
                }
                Some(other) if other.ends_with("_tool_result") => {
                    if let Some(tool_id) = block.get("tool_use_id").and_then(Value::as_str) {
                        let is_error = block
                            .get("content")
                            .and_then(|c| c.get("type"))
                            .and_then(Value::as_str)
                            .is_some_and(|t| t.ends_with("_error"));
                        self.complete_tool(state, tool_id, block.get("content"), None, is_error);
                    }
                }
                _ => {}
            }
        }
    }

    fn on_user(&self, state: &mut State, message: &Value) {
        if state.turn.is_none() || message.get("isReplay").and_then(Value::as_bool) == Some(true) {
            return;
        }
        let Some(content) = message
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(Value::as_array)
        else {
            return;
        };
        let results: Vec<&Value> = content
            .iter()
            .filter(|part| part.get("tool_use_id").and_then(Value::as_str).is_some())
            .collect();
        let structured = if results.len() == 1 {
            message.get("tool_use_result")
        } else {
            None
        };
        for result in results {
            let tool_id = result
                .get("tool_use_id")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let is_error = result.get("is_error").and_then(Value::as_bool) == Some(true);
            self.complete_tool(state, tool_id, result.get("content"), structured, is_error);
        }
    }

    fn complete_tool(
        &self,
        state: &mut State,
        tool_id: &str,
        content: Option<&Value>,
        structured: Option<&Value>,
        is_error: bool,
    ) {
        let Some(turn) = state.turn.as_mut() else {
            return;
        };
        let Some(call) = turn.tools.remove(tool_id) else {
            return;
        };
        let turn_id = turn.id.clone();
        // Projected when they were requested or used.
        if matches!(
            call.name.as_str(),
            "AskUserQuestion" | "ExitPlanMode" | "TodoWrite"
        ) {
            return;
        }
        let status = if is_error {
            TurnItemStatus::Failed
        } else {
            TurnItemStatus::Completed
        };
        if items::is_subagent_tool(&call.name) {
            let text = content.map(items::tool_result_text).unwrap_or_default();
            if !is_error && items::is_async_launch_ack(structured, &text) {
                state.async_subagents.insert(
                    tool_id.to_string(),
                    BackgroundSubagent {
                        call,
                        turn_id: turn_id.clone(),
                    },
                );
                return;
            }
            let body = self.subagent_body(tool_id, &call, Some(items::subagent_result_text(&text)));
            self.emit(EngineEvent::SubagentUpdate {
                turn_id: Some(turn_id.clone()),
                subagent_id: tool_id.to_string(),
                status,
                title: None,
                progress: None,
            });
            let item = self.item(state, &turn_id, tool_id, Some(tool_id), status, body);
            self.complete(state, &turn_id, item, Some(tool_id));
            return;
        }
        let body = items::tool_body(&call.name, &call.input, structured, is_error);
        let mut item = self.item(state, &turn_id, tool_id, Some(tool_id), status, body);
        item.title = Some(call.name.clone());
        self.complete(state, &turn_id, item, Some(tool_id));
    }

    fn on_result(&self, state: &mut State, message: &Value) {
        let Some(turn) = state.turn.as_mut() else {
            return;
        };
        for uuid in protocol::echoed_prompt_uuids(message) {
            if let Some(phase) = turn.steers.get_mut(&uuid) {
                *phase = SteerPhase::Consumed;
            }
        }
        let completed = !turn.interrupted
            && message.get("subtype").and_then(Value::as_str) == Some("success")
            && message.get("is_error").and_then(Value::as_bool) != Some(true);
        // v1 isClaudeActiveSteeringAbortResult: a steer that cut the stream ends Claude's segment
        // with aborted_streaming/aborted_tools; the turn goes on with the steer.
        let steer_abort = !turn.interrupted
            && matches!(
                message.get("terminal_reason").and_then(Value::as_str),
                Some("aborted_streaming" | "aborted_tools")
            );
        // v1 holdSuccessfulResult: a steer still queued runs as the continuation of this turn.
        if (completed || steer_abort) && Self::steers_outstanding(turn) {
            turn.held_result = Some(message.clone());
            turn.absorbed_result = true;
            self.flush_text(state, AssistantMessagePhase::Commentary);
            return;
        }
        self.finish(state, message);
    }

    /// Settle the active turn from a result frame.
    fn finish(&self, state: &mut State, message: &Value) {
        let Some(turn) = state.turn.as_ref() else {
            return;
        };
        let turn_id = turn.id.clone();
        let interrupted = turn.interrupted;
        let auth_failure = turn.auth_failure
            || (message.get("is_error").and_then(Value::as_bool) == Some(true)
                && message
                    .get("result")
                    .and_then(Value::as_str)
                    .is_some_and(|text| text.starts_with("Failed to authenticate")));
        let usage_limit = turn.usage_limit;
        let saw_text = turn.saw_text;
        let mut outcome = result_outcome(message, interrupted, usage_limit);
        if auth_failure && !matches!(outcome, TurnOutcome::Interrupted) {
            let text = signed_out_message(
                &self.cwd,
                self.launch
                    .env
                    .iter()
                    .rev()
                    .find(|(k, _)| k == "CLAUDE_CONFIG_DIR")
                    .map(|(_, v)| v.as_str()),
            );
            self.emit(EngineEvent::AuthRequired {
                turn_id: Some(turn_id.clone()),
                url: None,
                message: text.clone(),
            });
            outcome = TurnOutcome::Failed { reason: text };
        }
        if matches!(outcome, TurnOutcome::Done) {
            if state.turn.as_ref().is_some_and(|t| t.held_text.is_some()) {
                self.flush_text(state, AssistantMessagePhase::FinalAnswer);
            } else if !saw_text
                && let Some(text) = message
                    .get("result")
                    .and_then(Value::as_str)
                    .filter(|t| !t.trim().is_empty())
            {
                // v1 fallbackText: the result carries the answer when no text frame did.
                if let Some(turn) = state.turn.as_mut() {
                    turn.held_text = Some((format!("{turn_id}:result"), text.to_string()));
                }
                self.flush_text(state, AssistantMessagePhase::FinalAnswer);
            }
        } else {
            self.flush_text(state, AssistantMessagePhase::Commentary);
        }
        for (key, _) in state.pending.drain() {
            self.emit(EngineEvent::RequestClosed { key });
        }
        state.turn = None;
        self.emit(EngineEvent::TurnFinished { turn_id, outcome });
        self.settled.notify_waiters();
    }

    fn on_control_request(&self, request_id: &str, request: &Value) {
        let subtype = request.get("subtype").and_then(Value::as_str).unwrap_or("");
        match subtype {
            "can_use_tool" => self.on_can_use_tool(request_id, request),
            // GOAT declares no SDK hooks, SDK MCP servers or dialog kinds (R21-R23, R41).
            "hook_callback" => {
                let id = protocol::str_field(request, "callback_id").unwrap_or_default();
                self.write(&protocol::control_error(
                    request_id,
                    &format!("No hook callback found for ID: {id}"),
                ));
            }
            "mcp_message" => {
                let name = protocol::str_field(request, "server_name").unwrap_or_default();
                self.write(&protocol::control_error(
                    request_id,
                    &format!("SDK MCP server not found: {name}"),
                ));
            }
            // The SDK declines an elicitation it has no handler for.
            "elicitation" => {
                self.write(&protocol::control_success(
                    request_id,
                    json!({"action": "decline"}),
                ));
            }
            other => {
                self.write(&protocol::control_error(
                    request_id,
                    &format!("Unsupported control request subtype: {other}"),
                ));
            }
        }
    }

    fn deny(&self, request_id: &str, tool_use_id: &str, message: &str, interrupt: bool) {
        let mut response = json!({
            "behavior": "deny",
            "message": message,
            "toolUseID": tool_use_id,
        });
        if interrupt {
            response["interrupt"] = json!(true);
        }
        self.write(&protocol::control_success(request_id, response));
    }

    fn allow(&self, request_id: &str, tool_use_id: &str, input: Value) {
        self.write(&protocol::control_success(
            request_id,
            json!({"behavior": "allow", "updatedInput": input, "toolUseID": tool_use_id}),
        ));
    }

    fn on_can_use_tool(&self, request_id: &str, request: &Value) {
        let tool_name = protocol::str_field(request, "tool_name").unwrap_or_default();
        let tool_use_id = protocol::str_field(request, "tool_use_id").unwrap_or_default();
        let input = request.get("input").cloned().unwrap_or(json!({}));
        let Ok(mut guard) = self.state.lock() else {
            return;
        };
        let state = &mut *guard;
        let Some(turn_id) = state.turn.as_ref().map(|t| t.id.clone()) else {
            drop(guard);
            self.deny(
                request_id,
                &tool_use_id,
                "Claude V2 adapter has no active turn for this tool request.",
                false,
            );
            return;
        };
        if tool_name.starts_with("mcp__goat__") {
            drop(guard);
            self.allow(request_id, &tool_use_id, input);
            return;
        }
        if tool_name.starts_with("mcp__cua__") {
            drop(guard);
            self.deny(
                request_id,
                &tool_use_id,
                "Computer use is not attached to this thread.",
                false,
            );
            return;
        }
        if let Some(turn) = state.turn.as_mut() {
            turn.tools
                .entry(tool_use_id.clone())
                .or_insert_with(|| ToolCall {
                    name: tool_name.clone(),
                    input: input.clone(),
                });
        }
        let now_turn = turn_id.clone();
        match tool_name.as_str() {
            "AskUserQuestion" => {
                let questions = items::user_input_questions(&input);
                let summary = questions
                    .first()
                    .map(|q| q.question.clone())
                    .unwrap_or_else(|| "Claude has a question".into());
                let item = self.item(
                    state,
                    &now_turn,
                    &tool_use_id,
                    Some(&tool_use_id),
                    TurnItemStatus::Waiting,
                    TurnItemBody::UserInputRequest {
                        request_id: RequestId::from(tool_use_id.as_str()),
                        questions,
                    },
                );
                state.pending.insert(
                    request_id.to_string(),
                    Pending::Question {
                        tool_use_id: tool_use_id.clone(),
                        input,
                    },
                );
                self.emit(EngineEvent::RequestOpened {
                    turn_id: now_turn,
                    key: request_id.to_string(),
                    item_id: Some(ItemId::from(tool_use_id.as_str())),
                    kind: RequestKind::Question,
                    summary: items::truncate(&summary, 200),
                    item: Some(Box::new(item)),
                });
            }
            "ExitPlanMode" => {
                if let Some(markdown) = items::proposed_plan(&input) {
                    let item = self.item(
                        state,
                        &now_turn,
                        &tool_use_id,
                        Some(&tool_use_id),
                        TurnItemStatus::Completed,
                        TurnItemBody::ProposedPlan {
                            plan_id: PlanId::from(tool_use_id.as_str()),
                            markdown,
                            streaming: false,
                        },
                    );
                    self.complete(state, &now_turn, item, Some(&tool_use_id));
                }
                drop(guard);
                self.deny(
                    request_id,
                    &tool_use_id,
                    "The client captured your proposed plan. Stop here and wait for the user's feedback or implementation request in a later turn.",
                    false,
                );
            }
            _ => {
                let decision_reason = protocol::str_field(request, "decision_reason");
                if let Some(message) = items::removal_denial(
                    &tool_name,
                    state.permission_mode == PermissionMode::BypassPermissions,
                    request.get("matched_ask_rule").is_some(),
                    decision_reason.as_deref(),
                ) {
                    drop(guard);
                    self.deny(request_id, &tool_use_id, &message, false);
                    return;
                }
                let request_kind = items::classify_tool(&tool_name).1;
                let command = input
                    .get("command")
                    .and_then(Value::as_str)
                    .filter(|c| !c.trim().is_empty())
                    .map(str::to_owned);
                let prompt = command
                    .or_else(|| protocol::str_field(request, "title"))
                    .or_else(|| protocol::str_field(request, "description"))
                    .or_else(|| decision_reason.clone())
                    .unwrap_or_else(|| items::summarize_tool_request(&tool_name, &input));
                let (reason, options) = items::approval_presentation(
                    &prompt,
                    decision_reason.as_deref(),
                    request
                        .get("suppress_always_allow_rule")
                        .and_then(Value::as_bool)
                        == Some(true),
                );
                let item = self.item(
                    state,
                    &now_turn,
                    &tool_use_id,
                    Some(&tool_use_id),
                    TurnItemStatus::Waiting,
                    TurnItemBody::ApprovalRequest {
                        request_id: RequestId::from(tool_use_id.as_str()),
                        request_kind,
                        prompt: Some(prompt.clone()),
                        reason,
                        options,
                    },
                );
                state.pending.insert(
                    request_id.to_string(),
                    Pending::Approval {
                        tool_name,
                        tool_use_id: tool_use_id.clone(),
                        input,
                        suggestions: request.get("permission_suggestions").cloned(),
                    },
                );
                self.emit(EngineEvent::RequestOpened {
                    turn_id: now_turn,
                    key: request_id.to_string(),
                    item_id: Some(ItemId::from(tool_use_id.as_str())),
                    kind: RequestKind::Approval,
                    summary: items::truncate(&prompt, 200),
                    item: Some(Box::new(item)),
                });
            }
        }
    }

    /// The user frame content for these inputs: text with attachment paths, then images
    /// (v1 `providerMessageTextWithAttachmentPaths` and the Claude image blocks,
    /// `ClaudeAdapterV2.attachments`).
    fn content(&self, inputs: &[EngineInput]) -> Result<Value, String> {
        let mut text = inputs
            .iter()
            .map(|input| input.text.as_str())
            .collect::<Vec<_>>()
            .join("\n\n");
        let attachments: Vec<&ChatAttachment> =
            inputs.iter().flat_map(|i| i.attachments.iter()).collect();
        if attachments.is_empty() {
            return Ok(json!(text));
        }
        let resolve = |a: &ChatAttachment| {
            self.options
                .attachments
                .as_ref()
                .and_then(|resolver| resolver(&self.thread_id, a))
        };
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
        let mut blocks = vec![json!({"type": "text", "text": text})];
        for attachment in attachments {
            if attachment.kind != ChatAttachmentType::Image
                || !["image/gif", "image/jpeg", "image/png", "image/webp"]
                    .contains(&attachment.mime_type.as_str())
            {
                continue;
            }
            let Some(path) = resolve(attachment) else {
                return Err(format!(
                    "Image attachment '{}' could not be found.",
                    attachment.name
                ));
            };
            let bytes = std::fs::read(&path).map_err(|error| {
                format!(
                    "Image attachment '{}' could not be read: {error}",
                    attachment.name
                )
            })?;
            blocks.push(json!({"type": "image", "source": {
                "type": "base64",
                "media_type": attachment.mime_type,
                "data": util::base64(&bytes),
            }}));
        }
        Ok(Value::Array(blocks))
    }

    async fn apply_settings(self: &Arc<Self>, settings: &TurnSettings) -> Result<(), String> {
        let model = CompiledModel::compile(&settings.model_selection);
        let (current_model, current_mode, pinned, session_id) = {
            let state = self.state.lock().map_err(|_| "state poisoned")?;
            (
                state.model.clone(),
                state.permission_mode,
                state.pinned_mode,
                state.session_id.clone(),
            )
        };
        let mode = pinned.unwrap_or(PermissionMode::for_runtime_mode(settings.runtime_mode));
        let relaunch = mode != current_mode
            || model.effort != current_model.effort
            || model.settings != current_model.settings;
        if relaunch {
            // v1 reopens the query when its policy or model identity changes.
            self.generation.fetch_add(1, Ordering::SeqCst);
            self.kill_process().await;
            let identity = SessionIdentity::Resume(session_id);
            if let Err(error) = self.spawn(&identity, &model, mode).await {
                self.kill_process().await;
                self.mark_exited(&error);
                return Err(error);
            }
            return Ok(());
        }
        if model.api_model_id != current_model.api_model_id && !model.api_model_id.is_empty() {
            self.control(
                json!({"subtype": "set_model", "model": model.api_model_id}),
                self.options.control_timeout,
            )
            .await?;
            if let Ok(mut state) = self.state.lock() {
                state.model = model;
            }
        }
        Ok(())
    }

    /// Settle the session after its process is gone for a reason Claude did not report.
    fn mark_exited(&self, reason: &str) {
        if let Some(reason) = self.settle_exit(reason) {
            self.emit(EngineEvent::Exited { reason });
        }
    }

    fn turn_active(&self, turn_id: &str) -> bool {
        self.state
            .lock()
            .map(|state| state.turn.as_ref().is_some_and(|t| t.id == turn_id))
            .unwrap_or(false)
    }
}

/// v1 `terminalStatusFromResult` + `providerFailureFromResult` message choice.
fn result_outcome(message: &Value, interrupted: bool, usage_limit: bool) -> TurnOutcome {
    let terminal = message.get("terminal_reason").and_then(Value::as_str);
    if interrupted || matches!(terminal, Some("aborted_tools" | "aborted_streaming")) {
        return TurnOutcome::Interrupted;
    }
    let subtype = message.get("subtype").and_then(Value::as_str).unwrap_or("");
    let is_error = message.get("is_error").and_then(Value::as_bool) == Some(true);
    let status = message.get("api_error_status").and_then(Value::as_u64);
    let errors: Vec<String> = message
        .get("errors")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let listed = errors
        .iter()
        .find(|error| !error.starts_with("[ede_diagnostic]"))
        .cloned();
    if subtype != "success" {
        let joined = errors.join("\n").to_lowercase();
        if joined.contains("interrupt") || joined.contains("cancel") {
            return TurnOutcome::Interrupted;
        }
        return TurnOutcome::Failed {
            reason: listed
                .or_else(|| terminal_error(terminal))
                .unwrap_or_else(|| errors.join("\n"))
                .if_empty(subtype),
        };
    }
    let structured = if status == Some(529) {
        Some("Claude API is overloaded (529). Try again shortly.".to_string())
    } else if status == Some(429) || usage_limit && is_error {
        Some("Claude API rate limit reached. Try again later.".to_string())
    } else {
        terminal_error(terminal)
    };
    if !is_error && structured.is_none() {
        return TurnOutcome::Done;
    }
    let result_text = message
        .get("result")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    TurnOutcome::Failed {
        reason: listed
            .or(structured)
            .unwrap_or(result_text)
            .if_empty("Claude reported an error"),
    }
}

trait IfEmpty {
    fn if_empty(self, fallback: &str) -> String;
}

impl IfEmpty for String {
    fn if_empty(self, fallback: &str) -> String {
        if self.trim().is_empty() {
            fallback.to_string()
        } else {
            self
        }
    }
}

/// v1 `terminalResultError` (`ClaudeResultFailure.ts:25-58`).
fn terminal_error(reason: Option<&str>) -> Option<String> {
    const CONTEXT_FULL: &str = "Claude stopped: the prompt exceeds the model's context window. Run /compact or start a new thread.";
    Some(
        match reason? {
            "api_error" => "Claude gave up after repeated API errors.",
            "malformed_tool_use_exhausted" => "Claude gave up after repeated malformed tool calls.",
            "budget_exhausted" => "Claude stopped: the turn's token budget was exhausted.",
            "structured_output_retry_exhausted" => {
                "Claude could not produce the requested structured output."
            }
            "tool_deferred_unavailable" => {
                "Claude could not resume a deferred tool call: the tool is no longer available."
            }
            "turn_setup_failed" => "Claude could not start the turn.",
            "blocking_limit" | "prompt_too_long" => CONTEXT_FULL,
            "rapid_refill_breaker" => {
                "Claude stopped: the context refilled too quickly after compaction."
            }
            "image_error" => "Claude stopped: an image in the conversation could not be processed.",
            "model_error" => "Claude stopped: the model returned an error.",
            _ => return None,
        }
        .to_string(),
    )
}

/// v1 `claudeSignedOutMessage` (`provider/Drivers/ClaudeHome.ts:131-140`).
pub fn signed_out_message(cwd: &str, config_dir: Option<&str>) -> String {
    let configuration = match config_dir {
        Some(dir) => format!(
            " from {}, with CLAUDE_CONFIG_DIR set to {}",
            json!(cwd),
            json!(dir)
        ),
        None => String::new(),
    };
    format!(
        "Claude could not authenticate. For subscription login, run `claude auth login` on this environment's machine{configuration}, then start a new thread. For API-key authentication, check this instance's configured credentials."
    )
}

/// v1 `permissionResultFromDecision` + `toSessionPermissionUpdates` (`ClaudeApproval.ts:54-103`).
fn permission_result(
    tool_name: &str,
    tool_use_id: &str,
    input: &Value,
    suggestions: Option<&Value>,
    answer: &RequestAnswer,
) -> Value {
    match answer.outcome {
        RequestOutcome::Accept => json!({
            "behavior": "allow",
            "updatedInput": input,
            "toolUseID": tool_use_id,
            "decisionClassification": "user_temporary",
        }),
        // Claude offers no "always" grant; v1 never lists it, so it is read as this session.
        RequestOutcome::AcceptForSession | RequestOutcome::AcceptAlways => {
            let mut updates: Vec<Value> = suggestions
                .and_then(Value::as_array)
                .map(|list| {
                    list.iter()
                        .map(|suggestion| {
                            let mut suggestion = suggestion.clone();
                            if let Some(object) = suggestion.as_object_mut() {
                                object.insert("destination".into(), json!("session"));
                            }
                            suggestion
                        })
                        .collect()
                })
                .unwrap_or_default();
            if updates.is_empty() {
                updates.push(json!({
                    "type": "addRules",
                    "rules": [{"toolName": tool_name}],
                    "behavior": "allow",
                    "destination": "session",
                }));
            }
            json!({
                "behavior": "allow",
                "updatedInput": input,
                "toolUseID": tool_use_id,
                "decisionClassification": "user_permanent",
                "updatedPermissions": updates,
            })
        }
        _ => {
            let cancel = answer.outcome == RequestOutcome::Cancel;
            let feedback = answer
                .text
                .as_deref()
                .map(str::trim)
                .filter(|text| !text.is_empty());
            let message = match feedback {
                Some(text) => format!("The user declined this tool call and said:\n{text}"),
                None if cancel => "User cancelled tool execution.".to_string(),
                None => "User declined tool execution.".to_string(),
            };
            let mut result = json!({
                "behavior": "deny",
                "message": message,
                "toolUseID": tool_use_id,
                "decisionClassification": "user_reject",
            });
            if cancel {
                result["interrupt"] = json!(true);
            }
            result
        }
    }
}

#[async_trait]
impl EngineSession for ClaudeSession {
    async fn start_turn(
        &self,
        inputs: Vec<EngineInput>,
        settings: &TurnSettings,
    ) -> TurnStartResult {
        let inner = &self.inner;
        let _gate = inner.stop_gate.lock().await;
        {
            let Ok(state) = inner.state.lock() else {
                return TurnStartResult::Declined {
                    reason: "Claude session state is unavailable".into(),
                };
            };
            if state.exited || state.shutting_down {
                return TurnStartResult::Declined {
                    reason: "Claude is not running".into(),
                };
            }
            if state.turn.is_some() {
                return TurnStartResult::Declined {
                    reason: "A Claude turn is already running".into(),
                };
            }
        }
        if let Err(reason) = inner.apply_settings(settings).await {
            return TurnStartResult::Declined { reason };
        }
        let content = match inner.content(&inputs) {
            Ok(content) => content,
            Err(reason) => return TurnStartResult::Declined { reason },
        };
        let turn_id = format!("turn:{}", util::uuid());
        let prompt_uuid = util::uuid();
        {
            let Ok(mut state) = inner.state.lock() else {
                return TurnStartResult::Declined {
                    reason: "Claude session state is unavailable".into(),
                };
            };
            if state.turn.is_some() {
                return TurnStartResult::Declined {
                    reason: "A Claude turn is already running".into(),
                };
            }
            state.turn = Some(Turn {
                id: turn_id.clone(),
                confirmed: false,
                interrupted: false,
                steers: HashMap::new(),
                tools: HashMap::new(),
                held_text: None,
                blocks: HashMap::new(),
                stream_message: None,
                held_for_interrupt: None,
                saw_text: false,
                auth_failure: false,
                usage_limit: false,
                held_result: None,
                absorbed_result: false,
            });
        }
        let delivery = inner
            .deliver(&protocol::user_message(content, Some(&prompt_uuid), None))
            .await;
        let Ok(mut state) = inner.state.lock() else {
            return TurnStartResult::Unknown {
                reason: "Claude session state is unavailable".into(),
            };
        };
        let ours = state.turn.as_ref().is_some_and(|t| t.id == turn_id);
        match delivery {
            Delivery::Written if ours => {
                if let Some(turn) = state.turn.as_mut() {
                    turn.confirmed = true;
                }
                TurnStartResult::Accepted { turn_id }
            }
            // Written, but Claude exited before the turn could be confirmed.
            Delivery::Written => TurnStartResult::Unknown {
                reason: "Claude exited right after the message was sent".into(),
            },
            Delivery::NotRunning => {
                if ours {
                    state.turn = None;
                }
                TurnStartResult::Declined {
                    reason: "Claude is not running".into(),
                }
            }
            Delivery::Failed(reason) => {
                if ours {
                    state.turn = None;
                }
                TurnStartResult::Unknown { reason }
            }
        }
    }

    async fn steer(&self, turn_id: &str, inputs: Vec<EngineInput>) -> SteerResult {
        let inner = &self.inner;
        let content = match inner.content(&inputs) {
            Ok(content) => content,
            Err(reason) => return SteerResult::Declined { reason },
        };
        let uuid = util::uuid();
        let (tx, rx) = oneshot::channel();
        let wait = {
            let Ok(mut state) = inner.state.lock() else {
                return SteerResult::Declined {
                    reason: "Claude session state is unavailable".into(),
                };
            };
            let lifecycle = state.lifecycle;
            let Some(turn) = state.turn.as_mut() else {
                return SteerResult::Declined {
                    reason: "The Claude turn already ended".into(),
                };
            };
            if turn.id != turn_id {
                return SteerResult::Declined {
                    reason: "The Claude turn already ended".into(),
                };
            }
            if turn.interrupted {
                return SteerResult::Declined {
                    reason: "The Claude turn is stopping".into(),
                };
            }
            turn.steers.insert(uuid.clone(), SteerPhase::Sent);
            // Until this CLI is known to lack `command_lifecycle`, wait for Claude's verdict.
            let wait = lifecycle != Lifecycle::Absent;
            if wait {
                state.steer_waiters.insert(uuid.clone(), tx);
            }
            wait
        };
        let delivery = inner
            .deliver(&protocol::user_message(content, Some(&uuid), Some("next")))
            .await;
        let undelivered = match delivery {
            Delivery::Written => None,
            Delivery::NotRunning => Some(SteerResult::Declined {
                reason: "Claude is not running".into(),
            }),
            Delivery::Failed(reason) => Some(SteerResult::Unknown { reason }),
        };
        if let Some(result) = undelivered {
            if let Ok(mut state) = inner.state.lock() {
                state.steer_waiters.remove(&uuid);
                if let Some(turn) = state.turn.as_mut() {
                    turn.steers.remove(&uuid);
                }
            }
            return result;
        }
        if !wait {
            return SteerResult::Accepted;
        }
        match tokio::time::timeout(inner.options.steer_ack_timeout, rx).await {
            Ok(Ok(Ok(()))) => SteerResult::Accepted,
            Ok(Ok(Err(reason))) => SteerResult::Declined { reason },
            Ok(Err(_)) => SteerResult::Unknown {
                reason: "Claude closed before acknowledging the message".into(),
            },
            Err(_) => {
                if let Ok(mut state) = inner.state.lock() {
                    state.steer_waiters.remove(&uuid);
                }
                SteerResult::Unknown {
                    reason: "Claude did not acknowledge the message".into(),
                }
            }
        }
    }

    async fn interrupt(&self, turn_id: &str) -> Result<(), EngineError> {
        let inner = Arc::clone(&self.inner);
        let _gate = inner.stop_gate.lock().await;
        {
            let Ok(mut state) = inner.state.lock() else {
                return Err(EngineError::Transport("state poisoned".into()));
            };
            if state.exited {
                return Ok(());
            }
            match state.turn.as_mut() {
                Some(turn) if turn.id == turn_id => turn.interrupted = true,
                // No such active turn: nothing to stop.
                _ => return Ok(()),
            }
        }
        let deadline = inner.options.interrupt_settle_timeout;
        let generation = inner.generation.load(Ordering::SeqCst);
        // v1 `interruptUnlessClosed`: the interrupt control (10 s; a timeout still closes), then
        // close. A refused interrupt while Claude is still running fails and keeps the turn.
        let request_id = inner.request_id();
        if let Ok(mut state) = inner.state.lock() {
            state.interrupt_request = Some((request_id.clone(), turn_id.to_string()));
        }
        let answer = inner
            .control_with_id(request_id, json!({"subtype": "interrupt"}), deadline)
            .await;
        if let Ok(mut state) = inner.state.lock() {
            state.interrupt_request = None;
            // No answer came (timeout or exit): a held result settles as the interrupt.
            let held = state
                .turn
                .as_mut()
                .filter(|turn| turn.id == turn_id)
                .and_then(|turn| turn.held_for_interrupt.take());
            if let Some(held) = held {
                inner.on_result(&mut state, &held);
            }
        }
        if let Err(error) = answer {
            let exited = inner.state.lock().map(|s| s.exited).unwrap_or(true);
            if !exited && !error.starts_with("Control request timeout") {
                // Claude refused: the turn goes on and its own result decides the outcome.
                if let Ok(mut state) = inner.state.lock()
                    && let Some(turn) = state.turn.as_mut()
                    && turn.id == turn_id
                {
                    turn.interrupted = false;
                }
                return Err(EngineError::Transport(error));
            }
        }
        if let Ok(mut state) = inner.state.lock() {
            state.stopping = true;
        }
        inner
            .close_process(generation, "Claude was stopped".into())
            .await;
        // v1 awaits the closed query for CLAUDE_STOP_CONFIRM_TIMEOUT_MS; unconfirmed, the turn
        // stays open (the CLI may still be working) and the interrupt reports the timeout.
        let confirmed = tokio::time::timeout(deadline, async {
            loop {
                let settled = inner.settled.notified();
                tokio::pin!(settled);
                settled.as_mut().enable();
                if !inner.turn_active(turn_id) {
                    return;
                }
                settled.await;
            }
        })
        .await;
        match confirmed {
            Ok(()) => Ok(()),
            Err(_) => Err(EngineError::Transport(format!(
                "Claude did not confirm the stop within {} ms",
                deadline.as_millis()
            ))),
        }
    }

    async fn answer_request(&self, key: &str, answer: RequestAnswer) -> Result<(), EngineError> {
        let inner = &self.inner;
        let pending = inner
            .state
            .lock()
            .ok()
            .and_then(|mut state| state.pending.remove(key));
        let Some(pending) = pending else {
            return Err(EngineError::Unavailable(format!(
                "Claude request {key} is no longer open"
            )));
        };
        let response = match pending {
            Pending::Approval {
                tool_name,
                tool_use_id,
                input,
                suggestions,
            } => permission_result(
                &tool_name,
                &tool_use_id,
                &input,
                suggestions.as_ref(),
                &answer,
            ),
            Pending::Question { tool_use_id, input } => match (&answer.outcome, &answer.answers) {
                (RequestOutcome::Answered, Some(answers)) => json!({
                    "behavior": "allow",
                    "updatedInput": {
                        "questions": input.get("questions").cloned().unwrap_or(json!([])),
                        "answers": items::sdk_answers(answers),
                    },
                    "toolUseID": tool_use_id,
                }),
                _ => json!({
                    "behavior": "deny",
                    "message": "User cancelled tool execution.",
                    "toolUseID": tool_use_id,
                }),
            },
        };
        match inner
            .deliver(&protocol::control_success(key, response))
            .await
        {
            Delivery::Written => Ok(()),
            Delivery::NotRunning => Err(EngineError::Transport("Claude is not running".into())),
            Delivery::Failed(reason) => Err(EngineError::Transport(reason)),
        }
    }

    async fn set_config(&self, settings: &TurnSettings) -> Result<(), EngineError> {
        let inner = &self.inner;
        let model = CompiledModel::compile(&settings.model_selection);
        let (current_model, current_mode, pinned) = {
            let state = inner
                .state
                .lock()
                .map_err(|_| EngineError::Transport("state poisoned".into()))?;
            (
                state.model.clone(),
                state.permission_mode,
                state.pinned_mode,
            )
        };
        if model.api_model_id != current_model.api_model_id && !model.api_model_id.is_empty() {
            inner
                .control(
                    json!({"subtype": "set_model", "model": model.api_model_id}),
                    inner.options.control_timeout,
                )
                .await
                .map_err(EngineError::Transport)?;
            if let Ok(mut state) = inner.state.lock() {
                state.model.api_model_id = model.api_model_id.clone();
            }
        }
        let mode = pinned.unwrap_or(PermissionMode::for_runtime_mode(settings.runtime_mode));
        if mode != current_mode {
            if mode == PermissionMode::BypassPermissions
                || current_mode == PermissionMode::BypassPermissions
            {
                return Err(EngineError::Unsupported(
                    "switching to or from full access needs a new Claude process".into(),
                ));
            }
            inner
                .control(
                    json!({"subtype": "set_permission_mode", "mode": mode.as_str()}),
                    inner.options.control_timeout,
                )
                .await
                .map_err(EngineError::Transport)?;
            if let Ok(mut state) = inner.state.lock() {
                state.permission_mode = mode;
            }
        }
        Ok(())
    }

    fn group_rss_bytes(&self) -> Option<u64> {
        let pgid = self.inner.pgid.load(Ordering::SeqCst);
        if pgid == 0 {
            return None;
        }
        group_rss_bytes_of(pgid).ok()
    }

    fn process_group_id(&self) -> Option<i32> {
        let pgid = self.inner.pgid.load(Ordering::SeqCst);
        (pgid != 0).then_some(pgid as i32)
    }

    async fn shutdown(&self) {
        let inner = &self.inner;
        if let Ok(mut state) = inner.state.lock() {
            state.shutting_down = true;
        }
        if let Ok(mut writer) = inner.writer.lock() {
            writer.take();
        }
        // Hold the process while it stops: the reader's EOF settles the session meanwhile and
        // reports Exited once this returns. Settle here too in case no reader is left.
        {
            let mut process = inner.process.lock().await;
            if let Some(mut process) = process.take() {
                process.child.shutdown().await;
            }
        }
        inner.mark_exited("shutdown");
    }
}
