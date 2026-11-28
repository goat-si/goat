//! The Codex driver behind `goat2-engine-api`: one `codex app-server` process per thread.
//!
//! Behaviour is ported from GOAT v1 (goat origin/dev 916b5ccc) with path:line references:
//! the turn-start guard (`CodexTurnStartGuard.ts`), late turn/start answers
//! (`CodexAdapterV2.ts:6611-6640`), request handlers and session allowance
//! (`CodexAdapterV2.ts:1150-1170, 4851-5339`), turn settings (`CodexTurnStartParams.ts`), launch
//! (`codexLaunchArgs.ts`, `CodexClientIdentity.ts`) and exit (`CodexAppServerExit.ts`). The host
//! writes every log event from the values returned here and from [EngineEvent]s.

use std::collections::{HashMap, HashSet, VecDeque};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

use async_trait::async_trait;
use goat2_engine_api::{
    EngineError, EngineEvent, EngineFactory, EngineHandle, EngineInput, EngineSession, LaunchSpec,
    ProviderTarget, RequestAnswer, SessionSpec, SteerResult, TurnOutcome, TurnSettings,
    TurnStartResult,
};
use serde_json::{Map, Value, json};
use tokio::sync::{mpsc, oneshot};
use tokio::time::Instant;

use crate::approvals::{self, SessionAllowance, WaitingCtx};
use crate::attachments::{self, AttachmentResolver};
use crate::contract::{
    EngineDriver, EngineItemLocator, EngineRef, ItemId, ProviderRequestKind, RequestId,
    RequestKind, RequestOutcome, RuntimeMode, ThreadId,
};
use crate::home_layout::{self, HomeLayout, Redactor};
use crate::items::{self, ItemContext};
use crate::process::{ChildProcess, Launch, group_rss_bytes_of};
use crate::protocol::client::{
    CODEX_CLIENT_NAME, InitializeParams, ThreadOpenResponse, ThreadOptions, ThreadStatusWire,
    ThreadTurnsListParams, TurnInterruptParams, TurnStatusWire, TurnsListResponse, UserInput,
    turn_start_params, turn_steer_params,
};
use crate::protocol::server::{Notification, ServerRequest};
use crate::protocol::{INTERNAL_ERROR, RpcError, RpcId, methods};
use crate::runtime;
use crate::transport::{CallError, Connection, Inbound, Tap, TransportConfig};

/// Settings for every session a [CodexEngineFactory] starts.
#[derive(Clone)]
pub struct CodexEngineOptions {
    /// The codex binary (default `codex` on PATH).
    pub program: PathBuf,
    /// Extra launch arguments after v1's `app-server -c thread_unload_delay_secs=0`.
    pub extra_args: Vec<OsString>,
    /// Extra environment for the process (applied after v1's originator override).
    pub env_set: Vec<(OsString, OsString)>,
    /// Stop the process after this long without a run or pending request (PRD: 10 min).
    pub idle_timeout: Option<Duration>,
    /// v1 forces a kill 5 s after asking the process to stop.
    pub kill_grace: Duration,
    /// How long an explicit stop may take before the group is killed; also the wait for a
    /// stopped turn to end before a new start (v1 CodexTurnStartGuard.ts: 10 s).
    pub stop_grace: Duration,
    /// How long a steer waits for its turn's native start (v1 CodexTurnStartGuard.ts:207-219).
    pub steer_start_wait: Duration,
    /// Bound on the guard's thread/turns/list call (v1 CodexTurnStartGuard.ts:58-75: 5 s).
    pub guard_list_timeout: Duration,
    /// Sees every frame (the session recorder uses it).
    pub tap: Option<Tap>,
    pub transport: TransportConfig,
    /// `clientInfo.version` sent in initialize.
    pub client_version: String,
    /// Finds an attachment's saved file (the host owns the thread folder). Without it every
    /// attachment is named unavailable in the text and an image declines the turn, as v1 does
    /// for an unresolvable attachment (CodexAdapterV2.ts:2639-2645).
    pub attachment_resolver: Option<AttachmentResolver>,
    /// How long a sign-in flow may take from start to end (v1 providerAuthFlow: 300 s).
    pub auth_timeout: Duration,
}

impl Default for CodexEngineOptions {
    fn default() -> Self {
        Self {
            program: PathBuf::from("codex"),
            extra_args: Vec::new(),
            env_set: Vec::new(),
            idle_timeout: Some(Duration::from_secs(600)),
            kill_grace: Duration::from_secs(5),
            stop_grace: Duration::from_secs(10),
            steer_start_wait: Duration::from_secs(10),
            guard_list_timeout: Duration::from_secs(5),
            tap: None,
            transport: TransportConfig::default(),
            client_version: env!("CARGO_PKG_VERSION").to_string(),
            attachment_resolver: None,
            auth_timeout: Duration::from_secs(300),
        }
    }
}

/// Starts one `codex app-server` per thread.
#[derive(Clone, Default)]
pub struct CodexEngineFactory {
    pub options: CodexEngineOptions,
    /// Sign-in flows by provider instance (src/auth.rs).
    auth: std::sync::Arc<crate::auth::AuthFlows>,
}

impl CodexEngineFactory {
    pub fn new(options: CodexEngineOptions) -> Self {
        Self {
            options,
            auth: Default::default(),
        }
    }

    /// Answers a sign-in interaction (the API key of the api-key method), as v1
    /// provider.auth.respond. Becomes the EngineFactory::auth_respond override once lane E adds it.
    pub async fn auth_respond(
        &self,
        target: &ProviderTarget,
        flow_id: &str,
        interaction_id: &str,
        response: goat2_contracts::ProviderAuthResponse,
    ) -> Result<goat2_contracts::ProviderAuthState, EngineError> {
        self.auth
            .respond(target, flow_id, interaction_id, response)
            .await
    }
}

#[async_trait]
impl EngineFactory for CodexEngineFactory {
    async fn start(&self, spec: SessionSpec) -> Result<EngineHandle, EngineError> {
        start_session(self.options.clone(), spec).await
    }

    /// v1 `CodexProviderCapabilitiesV2` (src/capabilities.rs, compared whole by a test).
    fn capabilities(&self) -> crate::contract::ProviderCapabilities {
        crate::capabilities::codex_capabilities()
    }

    /// v1 `checkCodexProviderStatus` (src/probe.rs): install, version, sign-in and Codex's own
    /// model catalog, from a short-lived app-server.
    async fn probe(&self) -> Result<goat2_contracts::ProviderProbeResult, EngineError> {
        Ok(crate::probe::probe(&self.options).await)
    }

    /// [Self::probe] for one instance: its launch settings and its own Codex home (v1 probes each
    /// instance with its CODEX_HOME; a second account's sign-in differs from the first).
    async fn probe_instance(
        &self,
        target: &goat2_engine_api::ProviderTarget,
    ) -> Result<goat2_contracts::ProviderProbeResult, EngineError> {
        Ok(crate::probe::probe_instance(&self.options, target).await)
    }

    /// GOAT signs in to Codex through Codex's own login (src/auth.rs); install comes later.
    fn setup(&self) -> goat2_contracts::ProviderSetup {
        goat2_contracts::ProviderSetup {
            can_authenticate: true,
            can_install: false,
            documentation_url: None,
        }
    }

    async fn auth_methods(
        &self,
        target: &ProviderTarget,
    ) -> Result<Vec<goat2_contracts::ProviderAuthMethod>, EngineError> {
        Ok(self.auth.methods(&self.options, target).await)
    }

    async fn auth_start(
        &self,
        target: &ProviderTarget,
        method_id: Option<String>,
        updates: mpsc::UnboundedSender<goat2_contracts::ProviderAuthState>,
    ) -> Result<goat2_contracts::ProviderAuthState, EngineError> {
        self.auth
            .start(&self.options, target, method_id, updates)
            .await
    }

    async fn auth_cancel(
        &self,
        target: &ProviderTarget,
        flow_id: &str,
    ) -> Result<goat2_contracts::ProviderAuthState, EngineError> {
        self.auth.cancel(&self.options, target, flow_id).await
    }

    async fn auth_logout(
        &self,
        target: &ProviderTarget,
    ) -> Result<goat2_contracts::ProviderAuthState, EngineError> {
        self.auth.logout(&self.options, target).await
    }
}

/// v1 `codexAppServerArgs(launchArgs, routeArgs, unloadImmediately = true)` with v1's client
/// identity: the factory's binary, arguments and environment.
/// With an instance home layout, v1 `codexHomeLaunchArgs` go before the launch arguments (so an
/// explicit source still wins) and its CODEX_HOME is set last.
pub(crate) fn base_launch(
    options: &CodexEngineOptions,
    program: &Path,
    cwd: PathBuf,
    layout: Option<&HomeLayout>,
) -> Launch {
    let mut launch = Launch::new(program).without_host_identity();
    for arg in ["app-server", "-c", "thread_unload_delay_secs=0"] {
        launch = launch.arg(arg);
    }
    if let Some(layout) = layout {
        launch.args.extend(layout.launch_args());
    }
    launch.args.extend(options.extra_args.iter().cloned());
    launch.cwd = Some(cwd);
    launch.kill_grace = options.kill_grace;
    // v1 codexAppServerEnvironment: the originator first, the supplied environment may override.
    launch.env_set.push((
        "CODEX_INTERNAL_ORIGINATOR_OVERRIDE".into(),
        CODEX_CLIENT_NAME.into(),
    ));
    launch.env_set.extend(options.env_set.iter().cloned());
    if let Some(home) = layout.and_then(HomeLayout::codex_home) {
        launch
            .env_set
            .push(("CODEX_HOME".into(), home.as_os_str().to_owned()));
    }
    launch
}

/// The factory's options for one provider instance: its binary, and its arguments and
/// environment after the factory's (v1 `codexAppServerArgs` puts the instance's launch arguments
/// after GOAT's own).
pub(crate) fn instance_options(
    options: &CodexEngineOptions,
    launch: Option<&LaunchSpec>,
) -> CodexEngineOptions {
    let mut out = options.clone();
    if let Some(launch) = launch {
        if let Some(binary) = &launch.binary {
            out.program = binary.clone();
        }
        out.extra_args
            .extend(launch.args.iter().map(OsString::from));
        out.env_set.extend(
            launch
                .env
                .iter()
                .map(|(k, v)| (OsString::from(k), OsString::from(v))),
        );
    }
    out
}

/// v1 `resolveManagedCodexHomeLayout` for a provider instance (src/home_layout.rs). `None` when the
/// target names neither a private home nor a shared one: the default instance runs as today.
/// The shared home is the one the default instance uses: the target's `shared_home` (v1 `homePath`),
/// else the factory's or the host's CODEX_HOME, else `~/.codex`.
pub(crate) fn instance_layout(
    options: &CodexEngineOptions,
    target: Option<&ProviderTarget>,
) -> Option<HomeLayout> {
    let target = target?;
    if target.home.is_none() && target.shared_home.is_none() {
        return None;
    }
    let env = |name: &str| {
        options
            .env_set
            .iter()
            .rev()
            .find(|(k, _)| k == name)
            .map(|(_, v)| PathBuf::from(v))
            .or_else(|| std::env::var_os(name).map(PathBuf::from))
            .filter(|p| !p.as_os_str().is_empty())
    };
    let shared = target.shared_home.clone().or_else(|| env("CODEX_HOME"));
    let user_home = env("HOME").unwrap_or_default();
    Some(home_layout::resolve(
        shared.as_deref(),
        target.home.as_deref(),
        &user_home,
    ))
}

/// v1 materializes the instance's home before it starts or probes it (CodexAdapterV2.ts:598-608,
/// CodexDriver.ts:310); the message names no path (home paths are never shown or logged).
pub(crate) fn materialize(layout: &HomeLayout) -> Result<(), String> {
    layout
        .materialize()
        .map(|_| ())
        .map_err(|e| format!("Failed to materialize the Codex shadow home: {e}."))
}

/// The launch for one session: the instance's home ([instance_layout], from the factory's own
/// settings so an instance's environment cannot move the shared home) and options
/// ([instance_options]) through [base_launch], with the redactor for its private home.
fn launch_for(
    options: &CodexEngineOptions,
    spec: &SessionSpec,
) -> Result<(Launch, Redactor), EngineError> {
    let layout = instance_layout(options, spec.instance.as_ref());
    if let Some(layout) = &layout {
        materialize(layout).map_err(EngineError::StartFailed)?;
    }
    // After the layout, so the home exists and its canonical spelling is known too.
    let redact = Redactor::for_layout(layout.as_ref());
    let options = instance_options(options, spec.launch());
    let launch = base_launch(
        &options,
        &options.program,
        PathBuf::from(&spec.engine.cwd),
        layout.as_ref(),
    );
    Ok((launch, redact))
}

/// [EngineEvent] with an instance's private home replaced in every text and item. Exhaustive,
/// so a new event kind needs a decision here.
fn redact_event(redact: &Redactor, event: EngineEvent) -> EngineEvent {
    let text = |t: String| redact.apply(&t);
    let item = |i: Box<goat2_contracts::TurnItem>| Box::new(redact.value(*i));
    match event {
        EngineEvent::TextDelta {
            turn_id,
            item_id,
            text: t,
        } => EngineEvent::TextDelta {
            turn_id,
            item_id,
            text: text(t),
        },
        EngineEvent::ContentDelta {
            turn_id,
            item_id,
            stream_kind,
            text: t,
        } => EngineEvent::ContentDelta {
            turn_id,
            item_id,
            stream_kind,
            text: text(t),
        },
        EngineEvent::ItemCompleted {
            turn_id,
            item: i,
            locator,
        } => EngineEvent::ItemCompleted {
            turn_id,
            item: item(i),
            locator,
        },
        EngineEvent::RequestOpened {
            turn_id,
            key,
            item_id,
            kind,
            summary,
            item: i,
        } => EngineEvent::RequestOpened {
            turn_id,
            key,
            item_id,
            kind,
            summary: text(summary),
            item: i.map(item),
        },
        EngineEvent::SessionRequestOpened {
            key,
            item_id,
            kind,
            summary,
            item: i,
        } => EngineEvent::SessionRequestOpened {
            key,
            item_id,
            kind,
            summary: text(summary),
            item: i.map(item),
        },
        EngineEvent::RequestClosed { key } => EngineEvent::RequestClosed { key },
        EngineEvent::ContinuationWithdrawn { key } => EngineEvent::ContinuationWithdrawn { key },
        EngineEvent::AuthRequired {
            key,
            turn_id,
            url,
            message,
        } => EngineEvent::AuthRequired {
            key,
            turn_id,
            url: url.map(text),
            message: text(message),
        },
        EngineEvent::TokenUsage { turn_id, usage } => EngineEvent::TokenUsage { turn_id, usage },
        EngineEvent::SubagentUpdate {
            turn_id,
            subagent_id,
            status,
            title,
            progress,
        } => EngineEvent::SubagentUpdate {
            turn_id,
            subagent_id,
            status,
            title: title.map(text),
            progress: progress.map(text),
        },
        EngineEvent::SteerUpdated {
            turn_id,
            input_ids,
            status,
        } => EngineEvent::SteerUpdated {
            turn_id,
            input_ids,
            status,
        },
        EngineEvent::TurnFinished { turn_id, outcome } => EngineEvent::TurnFinished {
            turn_id,
            outcome: match outcome {
                TurnOutcome::Failed { reason } => TurnOutcome::Failed {
                    reason: text(reason),
                },
                other => other,
            },
        },
        EngineEvent::ContinuationRequested { key, text: t } => {
            EngineEvent::ContinuationRequested { key, text: text(t) }
        }
        EngineEvent::Exited { reason } => EngineEvent::Exited {
            reason: text(reason),
        },
    }
}

/// [EngineError] with an instance's private home replaced.
fn redact_error(redact: &Redactor, error: EngineError) -> EngineError {
    match error {
        EngineError::Unavailable(m) => EngineError::Unavailable(redact.apply(&m)),
        EngineError::StartFailed(m) => EngineError::StartFailed(redact.apply(&m)),
        EngineError::Transport(m) => EngineError::Transport(redact.apply(&m)),
        EngineError::Unsupported(m) => EngineError::Unsupported(redact.apply(&m)),
    }
}

/// GOAT's instructions go into Codex's developer instructions (its system slot) on thread/start
/// and thread/resume. Codex has a system slot, so a first-message preamble goes there too.
fn developer_instructions(spec: &SessionSpec) -> Option<String> {
    let parts: Vec<&str> = spec
        .instructions
        .iter()
        .flat_map(|i| {
            [
                i.append_system_prompt.as_deref(),
                i.first_message_preamble.as_deref(),
            ]
        })
        .flatten()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    (!parts.is_empty()).then(|| parts.join("\n\n"))
}

async fn start_session(
    options: CodexEngineOptions,
    spec: SessionSpec,
) -> Result<EngineHandle, EngineError> {
    let (launch, redact) = launch_for(&options, &spec)?;
    start_launched(options, spec, launch, redact.clone())
        .await
        .map_err(|e| redact_error(&redact, e))
}

async fn start_launched(
    options: CodexEngineOptions,
    spec: SessionSpec,
    launch: Launch,
    redact: Redactor,
) -> Result<EngineHandle, EngineError> {
    let mut child = ChildProcess::spawn(&launch).map_err(|error| {
        EngineError::StartFailed(format!("spawn {}: {error}", launch.program.display()))
    })?;
    let (Some(stdin), Some(stdout)) = (child.take_stdin(), child.take_stdout()) else {
        child.kill_group();
        return Err(EngineError::StartFailed("codex stdio unavailable".into()));
    };
    let (conn, inbound) = Connection::start_with(
        stdin,
        stdout,
        options.tap.clone(),
        options.transport.clone(),
    );

    let opened = open_thread(&conn, &options, &spec).await;
    let (codex_thread_id, opened_active) = match opened {
        Ok(opened) => opened,
        Err((stage, error)) => {
            conn.close_input();
            child.terminate_group().await;
            return Err(EngineError::StartFailed(format!(
                "{stage}: {error}; stderr: {}",
                tail(&child.stderr_tail(), 2000)
            )));
        }
    };

    let pgid = child.pid();
    let (commands, command_rx) = mpsc::unbounded_channel();
    let (events, event_rx) = mpsc::unbounded_channel();
    let (internal, internal_rx) = mpsc::unbounded_channel();
    let actor = Actor {
        redact: redact.clone(),
        options,
        spec_thread: spec.thread_id.clone(),
        cwd: spec.engine.cwd.clone(),
        process_generation: spec.process_generation,
        codex_thread: codex_thread_id.clone(),
        runtime_mode: spec.engine.runtime_mode,
        child: Some(child),
        conn,
        inbound,
        commands: command_rx,
        internal,
        internal_rx,
        events,
        owned: None,
        settled: VecDeque::new(),
        dispatch: None,
        next_attempt: 0,
        interrupt_pending: false,
        native_running: None,
        // A resumed thread can already be running a turn GOAT does not own; the start guard
        // lists turns before sending (v1 CodexTurnStartGuard.ts:58-73,113-116).
        thread_active: opened_active,
        allowance_epoch: 0,
        resume_busy: opened_active,
        status_gen: 0,
        stopped_turns: HashSet::new(),
        early: Vec::new(),
        pending: HashMap::new(),
        allowance: SessionAllowance::default(),
        file_change_kinds: HashMap::new(),
        steers: HashMap::new(),
        next_steer: 0,
        stop_deadline: None,
        idle_deadline: None,
        exited: false,
    };
    let mut actor = actor;
    actor.arm_idle();
    tokio::spawn(actor.run());
    Ok(EngineHandle {
        session: Box::new(CodexSession {
            commands,
            pgid,
            redact,
        }),
        events: event_rx,
        engine_ref: EngineRef {
            driver: EngineDriver::Codex,
            id: codex_thread_id,
        },
    })
}

/// initialize, initialized, config/read (reasoning summary), thread/start or thread/resume.
async fn open_thread(
    conn: &Connection,
    options: &CodexEngineOptions,
    spec: &SessionSpec,
) -> Result<(String, bool), (&'static str, String)> {
    let _: Value = conn
        .request(
            methods::INITIALIZE,
            &InitializeParams::goat(&options.client_version),
        )
        .await
        .map_err(|e| ("initialize", e.to_string()))?;
    conn.notify(methods::INITIALIZED, &Value::Null)
        .map_err(|e| ("initialized", e.to_string()))?;
    let thread = ThreadOptions {
        model: Some(spec.engine.model_selection.model.clone()),
        cwd: spec.engine.cwd.clone(),
        approval_policy: None,
        sandbox: None,
        developer_instructions: developer_instructions(spec),
        goat_mcp: Some((spec.mcp.url.clone(), spec.mcp.bearer_token.clone())),
    };
    let opened: ThreadOpenResponse = match &spec.resume {
        Some(engine_ref) => conn
            .request(
                methods::THREAD_RESUME,
                &thread.resume_params(&engine_ref.id),
            )
            .await
            .map_err(|e| ("thread/resume", e.to_string()))?,
        None => conn
            .request(methods::THREAD_START, &thread.start_params())
            .await
            .map_err(|e| ("thread/start", e.to_string()))?,
    };
    let active = opened
        .thread
        .status
        .as_ref()
        .is_some_and(ThreadStatusWire::is_active);
    Ok((opened.thread.id, active))
}

fn tail(text: &str, max: usize) -> &str {
    let start = text.len().saturating_sub(max);
    let start = (start..=text.len())
        .find(|i| text.is_char_boundary(*i))
        .unwrap_or(text.len());
    &text[start..]
}

enum Command {
    StartTurn {
        inputs: Vec<EngineInput>,
        settings: TurnSettings,
        reply: oneshot::Sender<TurnStartResult>,
    },
    Steer {
        turn_id: String,
        inputs: Vec<EngineInput>,
        reply: oneshot::Sender<SteerResult>,
    },
    Interrupt {
        turn_id: String,
        reply: oneshot::Sender<Result<(), EngineError>>,
    },
    Answer {
        key: String,
        answer: RequestAnswer,
        reply: oneshot::Sender<Result<(), EngineError>>,
    },
    Shutdown {
        reply: oneshot::Sender<()>,
    },
}

/// The handle the host holds.
pub struct CodexSession {
    commands: mpsc::UnboundedSender<Command>,
    pgid: u32,
    /// The instance's private home never leaves in a reason or error.
    redact: Redactor,
}

impl CodexSession {
    fn redact_start(&self, result: TurnStartResult) -> TurnStartResult {
        let r = |reason: String| self.redact.apply(&reason);
        match result {
            TurnStartResult::Accepted { turn_id } => TurnStartResult::Accepted { turn_id },
            TurnStartResult::RefusedUnowned { reason } => {
                TurnStartResult::RefusedUnowned { reason: r(reason) }
            }
            TurnStartResult::Declined { reason } => TurnStartResult::Declined { reason: r(reason) },
            TurnStartResult::Unknown { reason } => TurnStartResult::Unknown { reason: r(reason) },
        }
    }

    fn redact_steer(&self, result: SteerResult) -> SteerResult {
        let r = |reason: String| self.redact.apply(&reason);
        match result {
            SteerResult::Accepted => SteerResult::Accepted,
            SteerResult::Declined { reason } => SteerResult::Declined { reason: r(reason) },
            SteerResult::RefusedUnowned { reason } => {
                SteerResult::RefusedUnowned { reason: r(reason) }
            }
            SteerResult::Unknown { reason } => SteerResult::Unknown { reason: r(reason) },
        }
    }
}

#[async_trait]
impl EngineSession for CodexSession {
    async fn start_turn(
        &self,
        inputs: Vec<EngineInput>,
        settings: &TurnSettings,
    ) -> TurnStartResult {
        let (reply, answer) = oneshot::channel();
        let sent = self.commands.send(Command::StartTurn {
            inputs,
            settings: settings.clone(),
            reply,
        });
        if sent.is_err() {
            return TurnStartResult::Declined {
                reason: "the Codex process has ended".into(),
            };
        }
        self.redact_start(answer.await.unwrap_or(TurnStartResult::Unknown {
            reason: "the Codex driver stopped before answering".into(),
        }))
    }

    async fn steer(&self, turn_id: &str, inputs: Vec<EngineInput>) -> SteerResult {
        let (reply, answer) = oneshot::channel();
        let sent = self.commands.send(Command::Steer {
            turn_id: turn_id.to_string(),
            inputs,
            reply,
        });
        if sent.is_err() {
            return SteerResult::Declined {
                reason: "the Codex process has ended".into(),
            };
        }
        self.redact_steer(answer.await.unwrap_or(SteerResult::Unknown {
            reason: "the Codex driver stopped before answering".into(),
        }))
    }

    async fn interrupt(&self, turn_id: &str) -> Result<(), EngineError> {
        let (reply, answer) = oneshot::channel();
        if self
            .commands
            .send(Command::Interrupt {
                turn_id: turn_id.to_string(),
                reply,
            })
            .is_err()
        {
            return Ok(());
        }
        answer
            .await
            .unwrap_or(Ok(()))
            .map_err(|e| redact_error(&self.redact, e))
    }

    async fn answer_request(&self, key: &str, answer: RequestAnswer) -> Result<(), EngineError> {
        let (reply, result) = oneshot::channel();
        self.commands
            .send(Command::Answer {
                key: key.to_string(),
                answer,
                reply,
            })
            .map_err(|_| EngineError::Transport("the Codex process has ended".into()))?;
        result
            .await
            .unwrap_or_else(|_| Err(EngineError::Transport("the Codex driver stopped".into())))
            .map_err(|e| redact_error(&self.redact, e))
    }

    /// Codex takes the model and runtime mode with every turn/start (v1 CodexTurnStartParams), so
    /// a switch in session (v1 capabilities: supportsModelSwitchInSession and
    /// supportsRuntimeModeSwitchInSession) needs nothing sent now: the host's next start_turn
    /// carries the new TurnSettings, and a mode change ends the session allowances there.
    async fn set_config(&self, _settings: &TurnSettings) -> Result<(), EngineError> {
        Ok(())
    }

    fn group_rss_bytes(&self) -> Option<u64> {
        group_rss_bytes_of(self.pgid).ok()
    }

    fn process_group_id(&self) -> Option<i32> {
        if cfg!(unix) {
            i32::try_from(self.pgid).ok()
        } else {
            None
        }
    }

    async fn shutdown(&self) {
        let (reply, done) = oneshot::channel();
        if self.commands.send(Command::Shutdown { reply }).is_ok() {
            let _ = done.await;
        }
    }
}

enum Internal {
    /// `status_gen` when the list was asked for: a status change since then makes it stale.
    TurnsListed {
        status_gen: u64,
        result: Result<Value, CallError>,
    },
    /// config/read before a start (v1 CodexAdapterV2.ts:6597-6606); None when unread.
    ConfigRead {
        attempt: u64,
        summary: Option<String>,
    },
    TurnStartAnswered {
        attempt: u64,
        result: Result<Value, CallError>,
    },
    SteerAnswered {
        steer: u64,
        result: Result<Value, CallError>,
    },
}

struct Owned {
    turn_id: String,
    started: bool,
    interrupting: bool,
    ordinal: u32,
}

enum DispatchPhase {
    /// Deciding whether the thread is free (may be listing turns or waiting for a stopped turn).
    Guarding {
        listed: bool,
        quiet_wait: Option<(String, Instant)>,
    },
    /// The thread is free; reading the reasoning-summary setting. Nothing sent yet.
    Configuring,
    /// turn/start sent.
    Sending,
}

struct Dispatch {
    attempt: u64,
    inputs: Vec<EngineInput>,
    /// Codex input items, built before anything is sent.
    input: Vec<UserInput>,
    settings: TurnSettings,
    reply: Option<oneshot::Sender<TurnStartResult>>,
    phase: DispatchPhase,
}

struct WaitingSteer {
    turn_id: String,
    inputs: Vec<EngineInput>,
    input: Vec<UserInput>,
    reply: Option<oneshot::Sender<SteerResult>>,
    /// Waiting for the turn's native start until this instant; None once sent.
    start_deadline: Option<Instant>,
}

enum PendingKind {
    Command,
    FileChange,
    Permissions { requested: Value },
    UserInput { ids: Vec<(String, String)> },
    Elicitation { raw: Value },
}

struct Pending {
    rpc_id: RpcId,
    kind: PendingKind,
    /// The allowance set current when the request opened; an answer records a session
    /// allowance only into that same set, so A -> B -> A cannot revive it (v1 binds answers to
    /// the request's approval set, CodexAdapterV2.ts:1144-1170).
    allowance_epoch: u64,
}

const SETTLED_RING: usize = 64;

struct Actor {
    /// The instance's private home never leaves in an event reason.
    redact: Redactor,
    options: CodexEngineOptions,
    spec_thread: ThreadId,
    cwd: String,
    process_generation: u64,
    codex_thread: String,
    runtime_mode: RuntimeMode,
    child: Option<ChildProcess>,
    conn: Connection,
    inbound: mpsc::UnboundedReceiver<Inbound>,
    commands: mpsc::UnboundedReceiver<Command>,
    internal: mpsc::UnboundedSender<Internal>,
    internal_rx: mpsc::UnboundedReceiver<Internal>,
    events: mpsc::UnboundedSender<EngineEvent>,
    owned: Option<Owned>,
    settled: VecDeque<String>,
    dispatch: Option<Dispatch>,
    next_attempt: u64,
    interrupt_pending: bool,
    native_running: Option<String>,
    thread_active: bool,
    /// Bumped on every runtime-mode change, which ends the session allowances.
    allowance_epoch: u64,
    /// thread/start or thread/resume answered with a busy thread. The first start then always
    /// lists turns before sending (v1 CodexTurnStartGuard.ts:58-73), whatever status
    /// notifications were queued around that answer.
    resume_busy: bool,
    /// Bumped on every thread status and turn start/completion notification.
    status_gen: u64,
    stopped_turns: HashSet<String>,
    early: Vec<Inbound>,
    pending: HashMap<String, Pending>,
    allowance: SessionAllowance,
    file_change_kinds: HashMap<String, Vec<(String, Value)>>,
    steers: HashMap<u64, WaitingSteer>,
    next_steer: u64,
    stop_deadline: Option<Instant>,
    idle_deadline: Option<Instant>,
    exited: bool,
}

fn far_future() -> Instant {
    Instant::now() + Duration::from_secs(86_400 * 365)
}

impl Actor {
    async fn run(mut self) {
        // Everything Codex sent before its thread/start or thread/resume answer is already
        // queued; handle it before any host command, so a status notification older than that
        // answer is never taken for a newer one.
        while let Ok(inbound) = self.inbound.try_recv() {
            self.on_inbound_event(Some(inbound)).await;
            if self.exited {
                break;
            }
        }
        loop {
            if self.exited {
                // Answer whatever is still asked, then stop.
                while let Ok(command) = self.commands.try_recv() {
                    self.refuse_after_exit(command);
                }
                break;
            }
            let deadline = self.next_deadline();
            tokio::select! {
                command = self.commands.recv() => match command {
                    Some(command) => self.on_command(command).await,
                    None => self.exit("the GOAT session was dropped", true).await,
                },
                inbound = self.inbound.recv() => self.on_inbound_event(inbound).await,
                Some(internal) = self.internal_rx.recv() => self.on_internal(internal).await,
                _ = tokio::time::sleep_until(deadline) => self.on_timer().await,
            }
            // A quiet session starts its idle clock (it is reset only by a host command).
            if self.idle_deadline.is_none() {
                self.arm_idle();
            }
        }
    }

    /// Codex closed its output: end the group and read stderr to its end first, so the exit
    /// reason carries Codex's last lines.
    async fn exit_after_close(&mut self) {
        let mut reason = "codex app-server exited".to_string();
        if let Some(mut child) = self.child.take() {
            self.conn.close_input();
            child.terminate_group().await;
            let stderr = tail(&child.stderr_tail(), 2000).to_string();
            if !stderr.trim().is_empty() {
                reason = format!("codex app-server exited; stderr: {stderr}");
            }
        }
        self.exit(&reason, false).await;
    }

    async fn on_inbound_event(&mut self, inbound: Option<Inbound>) {
        match inbound {
            Some(Inbound::Retired { method }) => {
                self.exit(
                    &format!("Codex stopped answering ({method} past its deadline)"),
                    false,
                )
                .await;
            }
            Some(Inbound::Closed) | None => self.exit_after_close().await,
            Some(inbound) => self.on_inbound(inbound).await,
        }
    }

    fn next_deadline(&self) -> Instant {
        let mut deadline = far_future();
        let mut take = |at: Option<Instant>| {
            if let Some(at) = at {
                deadline = deadline.min(at);
            }
        };
        take(self.stop_deadline);
        take(self.idle_deadline);
        if let Some(Dispatch {
            phase:
                DispatchPhase::Guarding {
                    quiet_wait: Some((_, at)),
                    ..
                },
            ..
        }) = &self.dispatch
        {
            take(Some(*at));
        }
        for steer in self.steers.values() {
            take(steer.start_deadline);
        }
        deadline
    }

    /// Every event reaching the host has the instance's private home replaced (never shown or
    /// logged): reasons and Codex's text, request summaries and the waiting and completed
    /// items with their commands, file paths and prompts.
    fn emit(&self, event: EngineEvent) {
        let _ = self.events.send(redact_event(&self.redact, event));
    }

    fn arm_idle(&mut self) {
        self.idle_deadline = match self.options.idle_timeout {
            Some(idle) if self.is_quiet() => Some(Instant::now() + idle),
            _ => None,
        };
    }

    /// Nothing runs or waits. A native turn GOAT does not own keeps the process too: stopping
    /// it would kill that turn (v1 treats a working thread as busy, CodexTurnStartGuard.ts:78-105).
    fn is_quiet(&self) -> bool {
        self.owned.is_none()
            && self.dispatch.is_none()
            && self.pending.is_empty()
            && self.steers.is_empty()
            && !self.thread_active
            && self.native_running.is_none()
    }

    // ---- commands ----

    async fn on_command(&mut self, command: Command) {
        self.idle_deadline = None;
        match command {
            Command::StartTurn {
                inputs,
                settings,
                reply,
            } => self.start_turn(inputs, settings, reply).await,
            Command::Steer {
                turn_id,
                inputs,
                reply,
            } => self.steer(turn_id, inputs, reply),
            Command::Interrupt { turn_id, reply } => {
                let _ = reply.send(self.interrupt(&turn_id));
            }
            Command::Answer { key, answer, reply } => {
                let _ = reply.send(self.answer(&key, answer));
            }
            Command::Shutdown { reply } => {
                self.exit("shut down by GOAT", true).await;
                let _ = reply.send(());
            }
        }
        self.arm_idle();
    }

    fn refuse_after_exit(&self, command: Command) {
        let reason = "the Codex process has ended".to_string();
        match command {
            Command::StartTurn { reply, .. } => {
                let _ = reply.send(TurnStartResult::Declined { reason });
            }
            Command::Steer { reply, .. } => {
                let _ = reply.send(SteerResult::Declined { reason });
            }
            Command::Interrupt { reply, .. } => {
                let _ = reply.send(Ok(()));
            }
            Command::Answer { reply, .. } => {
                let _ = reply.send(Err(EngineError::Transport(reason)));
            }
            Command::Shutdown { reply } => {
                let _ = reply.send(());
            }
        }
    }

    async fn start_turn(
        &mut self,
        inputs: Vec<EngineInput>,
        settings: TurnSettings,
        reply: oneshot::Sender<TurnStartResult>,
    ) {
        if self.owned.is_some() || self.dispatch.is_some() {
            let _ = reply.send(TurnStartResult::Declined {
                reason: "a turn is already running in this thread".into(),
            });
            return;
        }
        let input = match attachments::codex_input(
            &self.spec_thread,
            &inputs,
            self.options.attachment_resolver.as_ref(),
        ) {
            Ok(input) => input,
            Err(reason) => {
                let _ = reply.send(TurnStartResult::Declined { reason });
                return;
            }
        };
        // v1 endSessionApprovalsOnModeChange (CodexAdapterV2.ts:1150-1158): a mode change ends
        // every session allowance, so A -> B -> A does not bring A's allowances back.
        if settings.runtime_mode != self.runtime_mode {
            self.allowance = SessionAllowance::default();
            self.allowance_epoch += 1;
        }
        self.runtime_mode = settings.runtime_mode;
        self.next_attempt += 1;
        self.dispatch = Some(Dispatch {
            attempt: self.next_attempt,
            inputs,
            input,
            settings,
            reply: Some(reply),
            phase: DispatchPhase::Guarding {
                listed: false,
                quiet_wait: None,
            },
        });
        self.advance_dispatch().await;
    }

    /// v1 CodexTurnStartGuard.ts:77-105 classify + 113-172 dispatch, for a start (not a steer).
    async fn advance_dispatch(&mut self) {
        let Some(dispatch) = self.dispatch.as_mut() else {
            return;
        };
        let DispatchPhase::Guarding { listed, quiet_wait } = &mut dispatch.phase else {
            return;
        };
        let busy_turn = self.native_running.clone();
        if !self.thread_active && busy_turn.is_none() && !self.resume_busy {
            self.send_turn_start();
            return;
        }
        match busy_turn {
            Some(turn) if self.stopped_turns.contains(&turn) => {
                if let Some((_, at)) = quiet_wait {
                    if Instant::now() >= *at {
                        self.finish_dispatch(TurnStartResult::Declined {
                            reason: "A turn GOAT already stopped is still running in Codex and did not stop within 10 seconds, so this message was not sent. Stop the thread and send it again.".into(),
                        });
                    }
                    return;
                }
                *quiet_wait = Some((turn.clone(), Instant::now() + self.options.stop_grace));
                self.spawn_interrupt(&turn);
            }
            Some(turn) => {
                let _ = turn;
                self.finish_dispatch(TurnStartResult::RefusedUnowned {
                    reason: "Codex is running a turn on this conversation that GOAT did not start, so this could not start. Try again when that turn ends.".into(),
                });
            }
            None if !*listed => {
                *listed = true;
                self.spawn_turns_list();
            }
            None => {
                self.finish_dispatch(TurnStartResult::RefusedUnowned {
                    reason: "Codex is running a turn on this conversation that GOAT did not start, so this could not start. Try again when that turn ends.".into(),
                });
            }
        }
    }

    fn finish_dispatch(&mut self, result: TurnStartResult) {
        // A start that ran nothing (refused or declined) leaves no turn for a pending stop.
        if std::mem::take(&mut self.interrupt_pending)
            && self.owned.is_none()
            && matches!(
                result,
                TurnStartResult::Declined { .. } | TurnStartResult::RefusedUnowned { .. }
            )
        {
            self.stop_deadline = None;
        }
        if let Some(mut dispatch) = self.dispatch.take()
            && let Some(reply) = dispatch.reply.take()
        {
            let _ = reply.send(result);
        }
        self.interrupt_pending = false;
    }

    /// v1 listedRunningTurn (CodexTurnStartGuard.ts:58-73): newest turns, 5 s bound.
    fn spawn_turns_list(&self) {
        let conn = self.conn.clone();
        let internal = self.internal.clone();
        let thread = self.codex_thread.clone();
        let limit = self.options.guard_list_timeout;
        let status_gen = self.status_gen;
        tokio::spawn(async move {
            let params = ThreadTurnsListParams::recent(&thread);
            let call = conn.request_value(methods::THREAD_TURNS_LIST, &params);
            let result =
                tokio::time::timeout(limit, call)
                    .await
                    .unwrap_or(Err(CallError::Deadline {
                        method: methods::THREAD_TURNS_LIST.into(),
                    }));
            let _ = internal.send(Internal::TurnsListed { status_gen, result });
        });
    }

    /// The thread is free: read the reasoning-summary setting for this start, then send it
    /// (v1 reads it once the start is admitted, CodexAdapterV2.ts:6597-6606; a failed read
    /// leaves the setting unset).
    fn send_turn_start(&mut self) {
        let Some(dispatch) = self.dispatch.as_mut() else {
            return;
        };
        dispatch.phase = DispatchPhase::Configuring;
        let attempt = dispatch.attempt;
        let conn = self.conn.clone();
        let internal = self.internal.clone();
        let cwd = self.cwd.clone();
        tokio::spawn(async move {
            let summary = conn
                .request_value(
                    methods::CONFIG_READ,
                    &json!({ "cwd": cwd, "includeLayers": false }),
                )
                .await
                .ok()
                .and_then(|v| {
                    v.pointer("/config/model_reasoning_summary")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                });
            let _ = internal.send(Internal::ConfigRead { attempt, summary });
        });
    }

    fn send_configured_turn_start(&mut self, attempt: u64, summary: Option<String>) {
        let Some(dispatch) = self.dispatch.as_mut() else {
            return;
        };
        if dispatch.attempt != attempt || !matches!(dispatch.phase, DispatchPhase::Configuring) {
            return;
        }
        dispatch.phase = DispatchPhase::Sending;
        let settings = &dispatch.settings;
        let selection = &settings.model_selection;
        let defaults = runtime::runtime_defaults(settings.runtime_mode);
        let effort = runtime::reasoning_effort(selection);
        let client_id = dispatch.inputs.first().map(|i| i.input_id.to_string());
        let mut params = turn_start_params(
            &self.codex_thread,
            dispatch.input.clone(),
            client_id.as_deref(),
            Some(&selection.model),
            effort.as_deref(),
        );
        params.cwd = Some(PathBuf::from(&self.cwd));
        params.approval_policy = Some(defaults.approval_policy);
        params.approvals_reviewer = Some(defaults.approvals_reviewer.to_string());
        params.sandbox_policy = Some(defaults.sandbox_policy);
        params.summary = Some(summary.unwrap_or_else(|| "auto".into()));
        params.service_tier = runtime::service_tier(selection);
        params.collaboration_mode = Some(runtime::collaboration_mode(
            &selection.model,
            effort.as_deref(),
        ));
        let attempt = dispatch.attempt;
        let conn = self.conn.clone();
        let internal = self.internal.clone();
        tokio::spawn(async move {
            let result = conn.request_value(methods::TURN_START, &params).await;
            let _ = internal.send(Internal::TurnStartAnswered { attempt, result });
        });
    }

    fn steer(
        &mut self,
        turn_id: String,
        inputs: Vec<EngineInput>,
        reply: oneshot::Sender<SteerResult>,
    ) {
        match &self.owned {
            Some(owned) if owned.turn_id == turn_id => {}
            Some(_) => {
                let _ = reply.send(SteerResult::RefusedUnowned {
                    reason: format!("turn {turn_id} is not the turn GOAT is running"),
                });
                return;
            }
            None if self.native_running.as_deref() == Some(turn_id.as_str()) => {
                let _ = reply.send(SteerResult::RefusedUnowned {
                    reason: "Codex is running a turn GOAT did not start".into(),
                });
                return;
            }
            None => {
                let _ = reply.send(SteerResult::Declined {
                    reason: format!("turn {turn_id} is not active and cannot be steered"),
                });
                return;
            }
        }
        let input = match attachments::codex_input(
            &self.spec_thread,
            &inputs,
            self.options.attachment_resolver.as_ref(),
        ) {
            Ok(input) => input,
            Err(reason) => {
                let _ = reply.send(SteerResult::Declined { reason });
                return;
            }
        };
        self.next_steer += 1;
        let id = self.next_steer;
        let started = self.owned.as_ref().is_some_and(|o| o.started);
        self.steers.insert(
            id,
            WaitingSteer {
                turn_id,
                inputs,
                input,
                reply: Some(reply),
                start_deadline: (!started).then(|| Instant::now() + self.options.steer_start_wait),
            },
        );
        if started {
            self.send_steer(id);
        }
    }

    fn send_steer(&mut self, id: u64) {
        let Some(steer) = self.steers.get_mut(&id) else {
            return;
        };
        steer.start_deadline = None;
        let client_id = steer.inputs.first().map(|i| i.input_id.to_string());
        let params = turn_steer_params(
            &self.codex_thread,
            &steer.turn_id,
            steer.input.clone(),
            client_id.as_deref(),
        );
        let conn = self.conn.clone();
        let internal = self.internal.clone();
        tokio::spawn(async move {
            let result = conn.request_value(methods::TURN_STEER, &params).await;
            let _ = internal.send(Internal::SteerAnswered { steer: id, result });
        });
    }

    fn interrupt(&mut self, turn_id: &str) -> Result<(), EngineError> {
        if let Some(owned) = self.owned.as_mut()
            && owned.turn_id == turn_id
        {
            owned.interrupting = true;
            self.stopped_turns.insert(turn_id.to_string());
            self.stop_deadline = Some(Instant::now() + self.options.stop_grace);
            let turn = turn_id.to_string();
            self.spawn_interrupt(&turn);
            return Ok(());
        }
        match self.dispatch.as_ref().map(|d| &d.phase) {
            // Nothing was sent yet: the stop cancels the start; there is nothing to kill.
            Some(DispatchPhase::Guarding { .. } | DispatchPhase::Configuring) => {
                self.finish_dispatch(TurnStartResult::Declined {
                    reason: "GOAT stopped this before it was sent to Codex".into(),
                });
            }
            // turn/start is out: stop the turn once Codex answers, or end the process if it
            // does not answer within the stop grace (the turn may be running).
            Some(_) => {
                self.interrupt_pending = true;
                self.stop_deadline = Some(Instant::now() + self.options.stop_grace);
            }
            None => {}
        }
        Ok(())
    }

    fn spawn_interrupt(&self, turn_id: &str) {
        let conn = self.conn.clone();
        let params = TurnInterruptParams {
            thread_id: self.codex_thread.clone(),
            turn_id: turn_id.to_string(),
        };
        tokio::spawn(async move {
            let _ = conn.request_value(methods::TURN_INTERRUPT, &params).await;
        });
    }

    fn answer(&mut self, key: &str, answer: RequestAnswer) -> Result<(), EngineError> {
        let generation = key
            .strip_prefix("codex:")
            .and_then(|rest| rest.split(':').next())
            .and_then(|g| g.parse::<u64>().ok());
        if generation != Some(self.process_generation) {
            return Err(EngineError::Transport(format!(
                "request {key} belongs to another Codex process"
            )));
        }
        let Some(pending) = self.pending.get(key) else {
            return Err(EngineError::Transport(format!("no open request {key}")));
        };
        let outcome = answer.outcome;
        let mode = self.runtime_mode;
        let body: Result<Value, String> = match &pending.kind {
            PendingKind::Command => approvals::command_decision(outcome)
                .map(|decision| json!({ "decision": decision.to_value() }))
                .map_err(|e| e.to_string()),
            PendingKind::FileChange => approvals::file_change_decision(outcome)
                .map(|decision| json!({ "decision": decision }))
                .map_err(|e| e.to_string()),
            PendingKind::Permissions { requested } => {
                approvals::permissions_response(outcome, requested).map_err(|e| e.to_string())
            }
            PendingKind::UserInput { ids } => match outcome {
                RequestOutcome::Answered => Ok(approvals::user_input_answers(
                    &answer.answers.clone().unwrap_or_default(),
                    ids,
                )),
                RequestOutcome::Cancel => Ok(approvals::user_input_answers(&Map::new(), ids)),
                other => Err(format!("a question is answered, not {other:?}")),
            },
            PendingKind::Elicitation { raw } => {
                approvals::elicitation::response(raw, outcome).map_err(|e| e.to_string())
            }
        };
        let body = body.map_err(EngineError::Transport)?;
        let allowance_kind = match pending.kind {
            PendingKind::Command => Some(ProviderRequestKind::Command),
            PendingKind::FileChange => Some(ProviderRequestKind::FileChange),
            _ => None,
        };
        self.conn
            .respond(&pending.rpc_id, body)
            .map_err(|e| EngineError::Transport(e.to_string()))?;
        if let Some(kind) = allowance_kind
            && approvals::records_session_allowance(outcome)
            && pending.allowance_epoch == self.allowance_epoch
        {
            self.allowance.kinds_for(mode).insert(kind);
        }
        self.pending.remove(key);
        Ok(())
    }

    // ---- inbound ----

    async fn on_inbound(&mut self, inbound: Inbound) {
        // While turn/start is unanswered, frames for turns not yet claimed wait for the answer.
        if matches!(
            self.dispatch,
            Some(Dispatch {
                phase: DispatchPhase::Sending,
                ..
            })
        ) && self.is_unclaimed(&inbound)
        {
            self.early.push(inbound);
            return;
        }
        self.handle_inbound(inbound).await;
    }

    fn is_unclaimed(&self, inbound: &Inbound) -> bool {
        // v1 awaits the registered turn for an elicitation that names none
        // (CodexAdapterV2.ts:5061-5066): hold it until the start answer registers ours.
        if let Inbound::Request {
            request: ServerRequest::Elicitation(p),
            ..
        } = inbound
            && p.turn_id.is_none()
        {
            return self.owned.is_none();
        }
        let turn = match inbound {
            Inbound::Notification(n) => n.turn_id().map(str::to_string),
            Inbound::Request { request, .. } => request.turn_id().map(str::to_string),
            _ => None,
        };
        turn.is_some_and(|t| self.owned.as_ref().is_none_or(|o| o.turn_id != t))
    }

    async fn handle_inbound(&mut self, inbound: Inbound) {
        match inbound {
            Inbound::Notification(notification) => self.on_notification(notification).await,
            Inbound::Request { id, request } => self.on_request(id, request),
            Inbound::LateResponse { method, result, .. } => {
                if method == methods::TURN_START {
                    self.on_late_turn_start(result);
                }
            }
            Inbound::Retired { .. } | Inbound::Closed | Inbound::Diagnostic(_) => {}
        }
    }

    /// v1 CodexAdapterV2.ts:6611-6640: stop a turn Codex started after its start timed out,
    /// unless a run owns it or a newer start is on its way.
    fn on_late_turn_start(&mut self, result: Result<Value, RpcError>) {
        let Some(turn) = result.ok().and_then(|v| {
            v.pointer("/turn/id")
                .and_then(Value::as_str)
                .map(str::to_string)
        }) else {
            return;
        };
        let owned = self.owned.as_ref().is_some_and(|o| o.turn_id == turn);
        if owned || self.settled.contains(&turn) || self.dispatch.is_some() {
            return;
        }
        self.stopped_turns.insert(turn.clone());
        self.spawn_interrupt(&turn);
    }

    async fn on_notification(&mut self, notification: Notification) {
        if matches!(
            notification,
            Notification::ThreadStatusChanged { .. }
                | Notification::TurnStarted(_)
                | Notification::TurnCompleted(_)
        ) {
            self.status_gen += 1;
        }
        match notification {
            Notification::ThreadStatusChanged { status, .. } => {
                self.thread_active = status.is_active();
                if matches!(status, ThreadStatusWire::Idle | ThreadStatusWire::NotLoaded) {
                    self.native_running = None;
                }
                self.after_quiet().await;
            }
            Notification::TurnStarted(n) => {
                let turn = n.turn.id;
                match self.owned.as_mut() {
                    Some(owned) if owned.turn_id == turn => {
                        owned.started = true;
                        let ready: Vec<u64> = self
                            .steers
                            .iter()
                            .filter(|(_, s)| s.start_deadline.is_some() && s.turn_id == turn)
                            .map(|(id, _)| *id)
                            .collect();
                        for id in ready {
                            self.send_steer(id);
                        }
                    }
                    _ => self.native_running = Some(turn),
                }
            }
            Notification::TurnCompleted(n) => {
                let turn = n.turn.id.clone();
                if self.owned.as_ref().is_some_and(|o| o.turn_id == turn) {
                    let owned = self.owned.take().expect("owned turn");
                    let outcome = match n.turn.status {
                        Some(TurnStatusWire::Completed) if owned.interrupting => {
                            TurnOutcome::Interrupted
                        }
                        Some(TurnStatusWire::Completed) => TurnOutcome::Done,
                        Some(TurnStatusWire::Interrupted) => TurnOutcome::Interrupted,
                        Some(TurnStatusWire::Failed) => TurnOutcome::Failed {
                            reason: n
                                .turn
                                .error
                                .as_ref()
                                .map(|e| e.message.clone())
                                .unwrap_or_else(|| "the turn failed".into()),
                        },
                        _ => TurnOutcome::Failed {
                            reason: "Codex ended the turn without a final status".into(),
                        },
                    };
                    // A steer still waiting on this turn can no longer reach it.
                    let stale: Vec<u64> = self
                        .steers
                        .iter()
                        .filter(|(_, s)| s.turn_id == turn && s.start_deadline.is_some())
                        .map(|(id, _)| *id)
                        .collect();
                    for id in stale {
                        if let Some(mut s) = self.steers.remove(&id)
                            && let Some(reply) = s.reply.take()
                        {
                            let _ = reply.send(SteerResult::Declined {
                                reason: "the turn ended before the steer was sent".into(),
                            });
                        }
                    }
                    self.stopped_turns.remove(&turn);
                    self.remember_settled(turn.clone());
                    self.stop_deadline = None;
                    self.emit(EngineEvent::TurnFinished {
                        turn_id: turn,
                        outcome,
                    });
                } else {
                    if self.native_running.as_deref() == Some(turn.as_str()) {
                        self.native_running = None;
                    }
                    self.stopped_turns.remove(&turn);
                }
                self.after_quiet().await;
            }
            Notification::ItemStarted(n) => {
                if let crate::protocol::server::ThreadItem::FileChange { id, changes, .. } = &n.item
                {
                    self.file_change_kinds.insert(
                        id.clone(),
                        changes
                            .iter()
                            .map(|c| (c.path.clone(), c.kind.clone()))
                            .collect(),
                    );
                }
            }
            Notification::ItemCompleted(n) => {
                let Some(owned) = self.owned.as_mut().filter(|o| o.turn_id == n.turn_id) else {
                    return;
                };
                if let Some(id) = n.item.id() {
                    self.file_change_kinds.remove(id);
                }
                let ctx = ItemContext {
                    thread_id: &self.spec_thread,
                    codex_thread_id: &self.codex_thread,
                    turn_id: &n.turn_id,
                    ordinal: owned.ordinal,
                    started_at_ms: n.started_at_ms,
                    completed_at_ms: n.completed_at_ms.unwrap_or_else(now_ms),
                };
                if let Some(item) = items::completed_item(&n.item, &ctx) {
                    owned.ordinal += 1;
                    let locator = n.item.id().map(|item_id| EngineItemLocator {
                        turn_id: n.turn_id.clone(),
                        item_id: item_id.to_string(),
                    });
                    self.emit(EngineEvent::ItemCompleted {
                        turn_id: n.turn_id,
                        item: Box::new(item),
                        locator,
                    });
                }
            }
            Notification::AgentMessageDelta(d)
                if self.owned.as_ref().is_some_and(|o| o.turn_id == d.turn_id) =>
            {
                self.emit(EngineEvent::TextDelta {
                    turn_id: d.turn_id,
                    item_id: ItemId::new(d.item_id),
                    text: d.delta,
                });
            }
            Notification::ServerRequestResolved { request_id, .. } => {
                let key = self
                    .pending
                    .iter()
                    .find(|(_, p)| p.rpc_id == request_id)
                    .map(|(k, _)| k.clone());
                if let Some(key) = key {
                    self.pending.remove(&key);
                    self.emit(EngineEvent::RequestClosed { key });
                }
            }
            _ => {}
        }
    }

    /// Called when a turn ends or the thread goes idle: a start waiting for a stopped turn may go.
    async fn after_quiet(&mut self) {
        let waiting = matches!(
            &self.dispatch,
            Some(Dispatch {
                phase: DispatchPhase::Guarding {
                    quiet_wait: Some(_),
                    ..
                },
                ..
            })
        );
        if waiting {
            if let Some(Dispatch {
                phase: DispatchPhase::Guarding { quiet_wait, .. },
                ..
            }) = self.dispatch.as_mut()
                && let Some((turn, _)) = quiet_wait.as_ref()
                && self.native_running.as_deref() != Some(turn.as_str())
            {
                *quiet_wait = None;
            }
            self.advance_dispatch().await;
        }
    }

    fn remember_settled(&mut self, turn: String) {
        self.settled.push_back(turn);
        while self.settled.len() > SETTLED_RING {
            self.settled.pop_front();
        }
    }

    fn on_request(&mut self, id: RpcId, request: ServerRequest) {
        let turn = request.turn_id().map(str::to_string);
        let owned_turn = self.owned.as_ref().map(|o| o.turn_id.clone());
        // v1: requests are handled in the context of the active turn they name (elicitations
        // without a turn use the thread's active turn).
        let context = match (&turn, &owned_turn) {
            (Some(t), Some(o)) if t == o => Some(o.clone()),
            (None, Some(o)) if matches!(request, ServerRequest::Elicitation(_)) => Some(o.clone()),
            _ => None,
        };
        let Some(turn_id) = context else {
            match request {
                ServerRequest::Elicitation(_) => {
                    let _ = self.conn.respond(&id, json!({ "action": "cancel" }));
                }
                other => {
                    let _ = self.conn.respond_error(
                        &id,
                        &RpcError {
                            code: INTERNAL_ERROR,
                            message: format!(
                                "No active Codex turn context for {} turn {}.",
                                other.method(),
                                turn.as_deref().unwrap_or("?")
                            ),
                            data: None,
                        },
                    );
                }
            }
            return;
        };
        let mode = self.runtime_mode;
        let key = format!("codex:{}:{id}", self.process_generation);
        let request_id = RequestId::new(key.clone());
        let ordinal = self.owned.as_ref().map(|o| o.ordinal).unwrap_or(0);
        let now = now_ms();
        let (item, kind, pending_kind) = match request {
            ServerRequest::CommandApproval(p) => {
                if approvals::full_access_accepts_command(mode, &p) {
                    let _ = self.conn.respond(&id, json!({ "decision": "accept" }));
                    return;
                }
                if self
                    .allowance
                    .kinds_for(mode)
                    .contains(&ProviderRequestKind::Command)
                {
                    let _ = self
                        .conn
                        .respond(&id, json!({ "decision": "acceptForSession" }));
                    return;
                }
                let native = p.approval_id.clone().unwrap_or_else(|| p.item_id.clone());
                let ctx = waiting_ctx(
                    &self.spec_thread,
                    &turn_id,
                    &native,
                    &request_id,
                    ordinal,
                    now,
                );
                let item = approvals::approval_item(
                    &ctx,
                    ProviderRequestKind::Command,
                    approvals::command_prompt(&p),
                    p.reason.as_deref(),
                    None,
                    None,
                );
                (item, RequestKind::Approval, PendingKind::Command)
            }
            ServerRequest::FileChangeApproval(p) => {
                if self
                    .allowance
                    .kinds_for(mode)
                    .contains(&ProviderRequestKind::FileChange)
                {
                    let _ = self
                        .conn
                        .respond(&id, json!({ "decision": "acceptForSession" }));
                    return;
                }
                let changes = self
                    .file_change_kinds
                    .get(&p.item_id)
                    .cloned()
                    .unwrap_or_default();
                let ctx = waiting_ctx(
                    &self.spec_thread,
                    &turn_id,
                    &p.item_id,
                    &request_id,
                    ordinal,
                    now,
                );
                let item = approvals::approval_item(
                    &ctx,
                    ProviderRequestKind::FileChange,
                    approvals::file_change_prompt(&changes, p.grant_root.as_deref()),
                    p.reason.as_deref(),
                    None,
                    None,
                );
                (item, RequestKind::Approval, PendingKind::FileChange)
            }
            ServerRequest::PermissionsApproval(p) => {
                let ctx = waiting_ctx(
                    &self.spec_thread,
                    &turn_id,
                    &p.item_id,
                    &request_id,
                    ordinal,
                    now,
                );
                let item = approvals::approval_item(
                    &ctx,
                    approvals::request_kind_from_permissions(&p.permissions),
                    approvals::permissions_prompt(&p.permissions),
                    p.reason.as_deref(),
                    None,
                    None,
                );
                (
                    item,
                    RequestKind::Approval,
                    PendingKind::Permissions {
                        requested: p.permissions.clone(),
                    },
                )
            }
            ServerRequest::UserInput(p) => {
                let ctx = waiting_ctx(
                    &self.spec_thread,
                    &turn_id,
                    &p.item_id,
                    &request_id,
                    ordinal,
                    now,
                );
                let (item, ids) = approvals::user_input_item(&ctx, &p.questions);
                (item, RequestKind::Question, PendingKind::UserInput { ids })
            }
            ServerRequest::Elicitation(p) => {
                if mode == RuntimeMode::FullAccess {
                    let _ = self
                        .conn
                        .respond(&id, approvals::elicitation::auto_approve(&p.raw));
                    return;
                }
                // v1 CodexAdapterV2.ts:5080-5081: refuse what an ordinary accept cannot encode.
                let accept = approvals::elicitation::response(&p.raw, RequestOutcome::Accept);
                if !matches!(&accept, Ok(v) if v["action"] == "accept") {
                    let _ = self.conn.respond(&id, json!({ "action": "cancel" }));
                    return;
                }
                let native = if p.mode.as_deref() == Some("url") {
                    p.elicitation_id
                        .clone()
                        .unwrap_or_else(|| format!("mcp-elicitation:{}", p.server_name))
                } else {
                    format!("mcp-elicitation:{}", p.server_name)
                };
                let (app_name, options) = approvals::elicitation::describe(&p.raw);
                let ctx = waiting_ctx(
                    &self.spec_thread,
                    &turn_id,
                    &native,
                    &request_id,
                    ordinal,
                    now,
                );
                let item = approvals::approval_item(
                    &ctx,
                    ProviderRequestKind::McpElicitation,
                    p.message.clone(),
                    None,
                    Some(app_name),
                    Some(options),
                );
                (
                    item,
                    RequestKind::Approval,
                    PendingKind::Elicitation { raw: p.raw.clone() },
                )
            }
        };
        if let Some(owned) = self.owned.as_mut() {
            owned.ordinal += 1;
        }
        self.idle_deadline = None;
        self.pending.insert(
            key.clone(),
            Pending {
                rpc_id: id,
                kind: pending_kind,
                allowance_epoch: self.allowance_epoch,
            },
        );
        let summary = approvals::summary(&item);
        self.emit(EngineEvent::RequestOpened {
            turn_id,
            key,
            item_id: Some(item.id.clone()),
            kind,
            summary,
            item: Some(Box::new(item)),
        });
    }

    // ---- internal completions ----

    async fn on_internal(&mut self, internal: Internal) {
        match internal {
            Internal::TurnsListed { status_gen, result } => {
                // Notifications Codex sent before answering the list are queued: apply them
                // first, so the list is judged against the state at its answer (v1 re-checks
                // after the list, CodexTurnStartGuard.ts:78-86).
                while let Ok(inbound) = self.inbound.try_recv() {
                    Box::pin(self.on_inbound_event(Some(inbound))).await;
                    if self.exited {
                        return;
                    }
                }
                let list = result
                    .ok()
                    .and_then(|value| serde_json::from_value::<TurnsListResponse>(value).ok())
                    // The schema requires every turn's status; one without it cannot be judged.
                    .filter(|list| list.data.iter().all(|turn| turn.status.is_some()));
                if status_gen != self.status_gen {
                    // A status or turn notification came after the list was asked for (so after
                    // the open answer too): the live status is current and settles a busy
                    // resume. As v1 re-checks after the list (CodexTurnStartGuard.ts:78-86), the
                    // listed turn counts only while the thread is still working.
                    self.resume_busy = false;
                    if self.thread_active
                        && self.native_running.is_none()
                        && let Some(list) = list
                    {
                        self.native_running = list
                            .data
                            .into_iter()
                            .find(|t| t.status == Some(TurnStatusWire::InProgress))
                            .map(|t| t.id);
                    }
                    self.advance_dispatch().await;
                    return;
                }
                match list {
                    Some(list) => {
                        // Only a readable list settles a busy resume.
                        self.resume_busy = false;
                        if self.native_running.is_none() {
                            self.native_running = list
                                .data
                                .into_iter()
                                .find(|t| t.status == Some(TurnStatusWire::InProgress))
                                .map(|t| t.id);
                        }
                    }
                    None if self.resume_busy && self.native_running.is_none() => {
                        // v1 classify: busy with no turn named is "unknown" and fails closed;
                        // the busy resume stays unsettled, so a retry lists again.
                        self.finish_dispatch(TurnStartResult::RefusedUnowned {
                            reason: "Codex reported this conversation busy and its turns could not be listed, so this could not start. Try again when that turn ends.".into(),
                        });
                        return;
                    }
                    None => {}
                }
                self.advance_dispatch().await;
            }
            Internal::TurnStartAnswered { attempt, result } => {
                self.on_turn_start_answer(attempt, result).await;
            }
            Internal::ConfigRead { attempt, summary } => {
                // What Codex sent before answering config/read is queued: apply it first.
                while let Ok(inbound) = self.inbound.try_recv() {
                    Box::pin(self.on_inbound_event(Some(inbound))).await;
                    if self.exited {
                        return;
                    }
                }
                let current = self.dispatch.as_ref().is_some_and(|d| {
                    d.attempt == attempt && matches!(d.phase, DispatchPhase::Configuring)
                });
                if !current {
                    return;
                }
                if self.thread_active || self.native_running.is_some() || self.resume_busy {
                    // A turn GOAT does not own appeared while the setting was read: judge the
                    // start again before anything is sent (v1 CodexTurnStartGuard.ts:113-116).
                    if let Some(dispatch) = self.dispatch.as_mut() {
                        dispatch.phase = DispatchPhase::Guarding {
                            listed: false,
                            quiet_wait: None,
                        };
                    }
                    self.advance_dispatch().await;
                    return;
                }
                self.send_configured_turn_start(attempt, summary);
            }
            Internal::SteerAnswered { steer, result } => {
                let Some(mut waiting) = self.steers.remove(&steer) else {
                    return;
                };
                let answer = match result {
                    Ok(value) => {
                        if value.get("turnId").and_then(Value::as_str).is_some() {
                            SteerResult::Accepted
                        } else {
                            // Codex accepted something GOAT cannot confirm (v1 treats it as maybe-taken).
                            self.decode_failure("turn/steer answered without a turnId")
                                .await;
                            SteerResult::Unknown {
                                reason: "Codex answered the steer with a body GOAT cannot read"
                                    .into(),
                            }
                        }
                    }
                    Err(CallError::Rpc(error)) => SteerResult::Declined {
                        reason: error.message,
                    },
                    Err(error) => SteerResult::Unknown {
                        reason: error.to_string(),
                    },
                };
                if let Some(reply) = waiting.reply.take() {
                    let _ = reply.send(answer);
                }
            }
        }
    }

    async fn on_turn_start_answer(&mut self, attempt: u64, result: Result<Value, CallError>) {
        if self.dispatch.as_ref().map(|d| d.attempt) != Some(attempt) {
            return;
        }
        let early = std::mem::take(&mut self.early);
        match result {
            Ok(value) => match value.pointer("/turn/id").and_then(Value::as_str) {
                Some(turn) => {
                    let started = value.pointer("/turn/status").and_then(Value::as_str)
                        == Some("inProgress")
                        || self.native_running.as_deref() == Some(turn);
                    if self.native_running.as_deref() == Some(turn) {
                        self.native_running = None;
                    }
                    self.owned = Some(Owned {
                        turn_id: turn.to_string(),
                        started,
                        interrupting: false,
                        ordinal: 0,
                    });
                    let interrupt = std::mem::take(&mut self.interrupt_pending);
                    self.finish_dispatch(TurnStartResult::Accepted {
                        turn_id: turn.to_string(),
                    });
                    if interrupt {
                        let turn = turn.to_string();
                        let _ = self.interrupt(&turn);
                    }
                }
                None => {
                    self.finish_dispatch(TurnStartResult::Unknown {
                        reason: "Codex answered turn/start with a body GOAT cannot read".into(),
                    });
                    self.decode_failure("turn/start answered without a turn id")
                        .await;
                    return;
                }
            },
            Err(CallError::Rpc(error)) => self.finish_dispatch(TurnStartResult::Declined {
                reason: error.message,
            }),
            Err(error) => self.finish_dispatch(TurnStartResult::Unknown {
                reason: error.to_string(),
            }),
        }
        for inbound in early {
            Box::pin(self.handle_inbound(inbound)).await;
        }
    }

    async fn decode_failure(&mut self, what: &str) {
        self.exit(&format!("{what}; GOAT stopped the Codex process"), false)
            .await;
    }

    // ---- timers ----

    async fn on_timer(&mut self) {
        let now = Instant::now();
        if self.stop_deadline.is_some_and(|at| now >= at) {
            self.stop_deadline = None;
            self.exit(
                "the stop did not finish within the grace period; GOAT ended the Codex process",
                false,
            )
            .await;
            return;
        }
        if self.idle_deadline.is_some_and(|at| now >= at) {
            self.idle_deadline = None;
            if !self.is_quiet() {
                // Became busy after the clock was armed; the loop re-arms once quiet again.
                return;
            }
            if self.resume_busy {
                // The resume answered busy and nothing has settled it yet: list turns instead of
                // stopping; a running turn keeps the process, an idle thread re-arms the clock.
                self.spawn_turns_list();
                return;
            }
            self.exit("idle", true).await;
            return;
        }
        let quiet_due = matches!(
            &self.dispatch,
            Some(Dispatch {
                phase: DispatchPhase::Guarding {
                    quiet_wait: Some((_, at)),
                    ..
                },
                ..
            }) if now >= *at
        );
        if quiet_due {
            self.advance_dispatch().await;
        }
        let expired: Vec<u64> = self
            .steers
            .iter()
            .filter(|(_, s)| s.start_deadline.is_some_and(|at| now >= at))
            .map(|(id, _)| *id)
            .collect();
        for id in expired {
            if let Some(mut s) = self.steers.remove(&id)
                && let Some(reply) = s.reply.take()
            {
                let _ = reply.send(SteerResult::Declined {
                    reason: "the turn has not started in Codex, so the steer was not sent".into(),
                });
            }
        }
    }

    // ---- exit ----

    /// End the process once: close open requests, answer waiting calls, kill the group, emit
    /// Exited (v1 CodexAppServerExit.ts: the session ends and the next open starts a fresh one).
    async fn exit(&mut self, reason: &str, orderly: bool) {
        if self.exited {
            return;
        }
        self.exited = true;
        let keys: Vec<String> = self.pending.drain().map(|(key, _)| key).collect();
        for key in keys {
            self.emit(EngineEvent::RequestClosed { key });
        }
        self.finish_dispatch(TurnStartResult::Unknown {
            reason: reason.to_string(),
        });
        for (_, mut steer) in self.steers.drain() {
            if let Some(reply) = steer.reply.take() {
                let _ = reply.send(SteerResult::Unknown {
                    reason: reason.to_string(),
                });
            }
        }
        self.conn.close_input();
        if let Some(mut child) = self.child.take() {
            if orderly {
                child.shutdown().await;
            } else {
                child.terminate_group().await;
            }
        }
        self.emit(EngineEvent::Exited {
            reason: reason.to_string(),
        });
    }
}

fn waiting_ctx<'a>(
    thread_id: &'a ThreadId,
    turn_id: &'a str,
    native_item_id: &'a str,
    request_id: &'a RequestId,
    ordinal: u32,
    now_ms: i64,
) -> WaitingCtx<'a> {
    WaitingCtx {
        thread_id,
        turn_id,
        native_item_id,
        request_id,
        ordinal,
        now_ms,
    }
}

/// Inputs batched into one turn are separate messages; v1 sends each as its own text input.
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[allow(dead_code)]
fn _assert_user_input(_: UserInput) {}
