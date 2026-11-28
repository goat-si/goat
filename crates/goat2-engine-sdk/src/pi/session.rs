//! Pi RPC process and session lifecycle, ported from v1 rpc.ts and adapter.ts.
use super::{events::Translator, extension, resolve_launch_args};
use crate::{
    jsonl::{CallError, Connection, Dialect, Inbound, RemoteError},
    process::{ChildProcess, Launch, group_rss_bytes_of},
};
use async_trait::async_trait;
use goat2_contracts::{
    EngineDriver, EngineRef, ProviderCapabilities, ProviderOptionSelectionValue,
    ProviderProbeResult, RequestOutcome, RuntimeMode,
};
use goat2_engine_api::{
    EngineError, EngineEvent, EngineFactory, EngineHandle, EngineInput, EngineSession,
    RequestAnswer, SessionSpec, SteerResult, TurnSettings, TurnStartResult,
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::sync::{Mutex, mpsc, oneshot};

const TIMEOUT: Duration = Duration::from_secs(30);
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PiProfile {
    Pi,
    Omo,
}
impl PiProfile {
    fn driver(self) -> EngineDriver {
        match self {
            Self::Pi => EngineDriver::Pi,
            Self::Omo => EngineDriver::Omo,
        }
    }
    fn name(self) -> &'static str {
        match self {
            Self::Pi => "Pi",
            Self::Omo => "OmO",
        }
    }
    pub(super) fn binary(self) -> &'static str {
        match self {
            Self::Pi => "pi",
            Self::Omo => "omo",
        }
    }
}
/// A factory for Pi or its OmO profile.
pub struct PiFactory {
    profile: PiProfile,
    binary: PathBuf,
    cache_dir: Option<PathBuf>,
}
impl PiFactory {
    pub fn new(profile: PiProfile) -> Self {
        Self {
            profile,
            binary: profile.binary().into(),
            cache_dir: None,
        }
    }
    /// Override the executable for probes as well as sessions.
    pub fn with_binary(mut self, binary: impl Into<PathBuf>) -> Self {
        self.binary = binary.into();
        self
    }
    /// Use a specific cache directory for the materialized extension.
    pub fn with_cache_dir(mut self, cache_dir: impl Into<PathBuf>) -> Self {
        self.cache_dir = Some(cache_dir.into());
        self
    }
}

// v1 rpc.ts:311-333: string id and type response identify RPC replies.
struct PiDialect;
impl Dialect for PiDialect {
    fn response(&self, record: &Value) -> Option<(String, Result<Value, RemoteError>)> {
        if record.get("type")?.as_str()? != "response" {
            return None;
        }
        let id = record.get("id")?.as_str()?.to_owned();
        let result = if record.get("success").and_then(Value::as_bool) == Some(true) {
            Ok(record.get("data").cloned().unwrap_or(Value::Null))
        } else {
            let error = record.get("error");
            Err(RemoteError {
                code: None,
                message: error
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .unwrap_or_else(|| {
                        error
                            .map(Value::to_string)
                            .unwrap_or_else(|| "Pi request failed".into())
                    }),
            })
        };
        Some((id, result))
    }
}
pub(super) struct Client {
    conn: Arc<Connection>,
    next: AtomicU64,
}
impl Client {
    fn next_id(&self) -> String {
        format!("goat-{}", self.next.fetch_add(1, Ordering::Relaxed))
    }
    pub(super) async fn call(&self, mut record: Value) -> Result<Value, CallError> {
        let id = self.next_id();
        record["id"] = json!(id);
        self.conn.call(id, &record, TIMEOUT).await
    }
}
enum PendingPrompt {
    Start,
    Steer(oneshot::Sender<Result<(), String>>),
}
struct Shared {
    turn: Option<String>,
    last_turn: Option<String>,
    unowned: bool,
    requests: HashMap<String, String>,
    pending_prompts: HashMap<String, PendingPrompt>,
    idle_probe: Option<String>,
    settled: Option<Value>,
    saw_activity: bool,
    abort_pending: bool,
    barriers: HashMap<String, oneshot::Sender<bool>>,
    translator: Translator,
}
struct PiSession {
    client: Arc<Client>,
    process: Mutex<ChildProcess>,
    pgid: u32,
    shared: Arc<Mutex<Shared>>,
    events: mpsc::UnboundedSender<EngineEvent>,
    next_turn: AtomicU64,
    turn_prefix: String,
    runtime_mode: RuntimeMode,
    preamble: Mutex<Option<String>>,
    command_lock: Mutex<()>,
    baseline_model: Option<(String, String)>,
    baseline_thinking: Option<String>,
    service_tier: Mutex<Option<String>>,
}
fn err(error: CallError) -> EngineError {
    EngineError::Transport(error.to_string())
}
fn plain_input(inputs: &[EngineInput]) -> Result<String, String> {
    if inputs.iter().any(|i| !i.attachments.is_empty()) {
        return Err(
            "Pi attachments require image payloads; attachment loading is unavailable".into(),
        );
    }
    Ok(inputs
        .iter()
        .map(|i| i.text.as_str())
        .collect::<Vec<_>>()
        .join("\n\n"))
}
async fn pump(
    mut inbound: mpsc::UnboundedReceiver<Inbound>,
    shared: Arc<Mutex<Shared>>,
    tx: mpsc::UnboundedSender<EngineEvent>,
    client: Arc<Client>,
) {
    while let Some(msg) = inbound.recv().await {
        match msg {
            Inbound::Closed(reason) => {
                let _ = tx.send(EngineEvent::Exited { reason });
                return;
            }
            Inbound::Record(record) => {
                let mut state = shared.lock().await;
                if record.get("type").and_then(Value::as_str) == Some("response") {
                    let id = record.get("id").and_then(Value::as_str).unwrap_or("");
                    if let Some(barrier) = state.barriers.remove(id) {
                        let idle = record.get("success").and_then(Value::as_bool) == Some(true)
                            && record.pointer("/data/isStreaming").and_then(Value::as_bool)
                                == Some(false)
                            && record
                                .pointer("/data/isCompacting")
                                .and_then(Value::as_bool)
                                != Some(true)
                            && !state.unowned;
                        let _ = barrier.send(idle);
                        continue;
                    }
                    if let Some(pending) = state.pending_prompts.remove(id) {
                        let success = record.get("success").and_then(Value::as_bool) == Some(true);
                        let is_start = matches!(pending, PendingPrompt::Start);
                        if let PendingPrompt::Steer(sender) = pending {
                            let reason = record
                                .get("error")
                                .and_then(Value::as_str)
                                .unwrap_or("Pi rejected the steer.");
                            let _ = sender.send(if success {
                                Ok(())
                            } else {
                                Err(reason.to_owned())
                            });
                        }
                        if !success && is_start {
                            if let Some(turn) = state.turn.clone() {
                                if state.saw_activity {
                                    state.unowned = true;
                                }
                                let reason = record
                                    .get("error")
                                    .and_then(Value::as_str)
                                    .unwrap_or("Pi rejected the prompt.");
                                let failure = json!({"type":"message_end","message":{"role":"assistant","stopReason":"error","errorMessage":reason}});
                                let mut events = state.translator.translate(&failure, &turn);
                                events.extend(
                                    state
                                        .translator
                                        .translate(&json!({"type":"agent_settled"}), &turn),
                                );
                                state.turn = None;
                                state.requests.clear();
                                for event in events {
                                    let _ = tx.send(event);
                                }
                            }
                        } else if state.pending_prompts.is_empty()
                            && !state.abort_pending
                            && state.turn.is_some()
                            && (state.settled.is_some()
                                || (is_start
                                    && !state.saw_activity
                                    && record.pointer("/data/disposition").and_then(Value::as_str)
                                        == Some("handled")))
                        {
                            let probe = client.next_id();
                            state.idle_probe = Some(probe.clone());
                            if client
                                .conn
                                .send(&json!({"type":"get_state","id":probe}))
                                .await
                                .is_err()
                            {
                                state.idle_probe = None;
                            }
                        }
                        continue;
                    }
                    if state.idle_probe.as_deref() == Some(id) {
                        state.idle_probe = None;
                        if record.get("success").and_then(Value::as_bool) == Some(true)
                            && record.pointer("/data/isStreaming").and_then(Value::as_bool)
                                == Some(false)
                            && record
                                .pointer("/data/isCompacting")
                                .and_then(Value::as_bool)
                                != Some(true)
                            && state.pending_prompts.is_empty()
                            && !state.abort_pending
                            && let Some(turn) = state.turn.clone()
                        {
                            let settled = state
                                .settled
                                .take()
                                .unwrap_or_else(|| json!({"type":"agent_settled"}));
                            let events = state.translator.translate(&settled, &turn);
                            state.turn = None;
                            state.requests.clear();
                            for event in events {
                                let _ = tx.send(event);
                            }
                        }
                        continue;
                    }
                }
                if state.turn.is_none()
                    && record.get("type").and_then(Value::as_str) == Some("agent_start")
                {
                    state.unowned = true;
                }
                if state.turn.is_none()
                    && record.get("type").and_then(Value::as_str) == Some("extension_ui_request")
                    && record.get("method").and_then(Value::as_str) == Some("setWidget")
                    && let Some(turn) = state.last_turn.clone()
                {
                    for event in state.translator.translate(&record, &turn) {
                        let _ = tx.send(event);
                    }
                    continue;
                }
                if state.turn.is_none()
                    && record.get("type").and_then(Value::as_str) == Some("extension_ui_request")
                    && record
                        .get("method")
                        .and_then(Value::as_str)
                        .is_some_and(|method| {
                            matches!(method, "confirm" | "select" | "input" | "editor")
                        })
                {
                    let _ = tx.send(EngineEvent::Exited { reason: "Pi requested a dialog outside a host-owned turn; a continuation is required".into() });
                    client.conn.close_input().await;
                    return;
                }
                if let Some(turn) = state.turn.clone() {
                    if record.get("type").and_then(Value::as_str) == Some("agent_start") {
                        state.saw_activity = true;
                    }
                    if record.get("type").and_then(Value::as_str) == Some("agent_settled")
                        && (!state.pending_prompts.is_empty() || state.abort_pending)
                    {
                        state.settled = Some(record);
                        continue;
                    }
                    if record.get("type").and_then(Value::as_str) == Some("extension_ui_request")
                        && let (Some(id), Some(method)) = (
                            record.get("id").and_then(Value::as_str),
                            record.get("method").and_then(Value::as_str),
                        )
                        && matches!(method, "select" | "input" | "editor" | "confirm")
                    {
                        state.requests.insert(id.to_owned(), method.to_owned());
                    }
                    let output = state.translator.translate(&record, &turn);
                    for event in output {
                        if matches!(event, EngineEvent::TurnFinished { .. }) {
                            state.turn = None;
                            state.requests.clear();
                        }
                        let _ = tx.send(event);
                    }
                }
            }
        }
    }
}
pub(super) fn spawn(
    launch: &Launch,
) -> Result<(ChildProcess, Arc<Client>, mpsc::UnboundedReceiver<Inbound>), EngineError> {
    let mut child = ChildProcess::spawn(launch)
        .map_err(|e| EngineError::Unavailable(format!("Pi process could not start: {e}")))?;
    let (Some(stdin), Some(stdout)) = (child.take_stdin(), child.take_stdout()) else {
        child.kill_group();
        return Err(EngineError::StartFailed("Pi process has no stdio".into()));
    };
    let (conn, inbound) = Connection::start(stdin, stdout, PiDialect);
    Ok((
        child,
        Arc::new(Client {
            conn,
            next: AtomicU64::new(1),
        }),
        inbound,
    ))
}
pub(super) fn base_launch(binary: PathBuf, profile: PiProfile) -> Launch {
    let mut launch = Launch::new(binary).without_host_identity();
    if profile == PiProfile::Omo {
        launch.env_set.extend([
            ("SENPI_RPC_HOST_IDLE_EXIT_MS".into(), "1".into()),
            ("SENPI_RPC_HOST_EMPTY_EXIT_MS".into(), "1".into()),
        ]);
    }
    launch
}
#[async_trait]
impl EngineFactory for PiFactory {
    async fn start(&self, spec: SessionSpec) -> Result<EngineHandle, EngineError> {
        let args = resolve_launch_args(
            spec.launch
                .as_ref()
                .map(|l| l.args.as_slice())
                .unwrap_or(&[]),
            self.profile.name(),
        )
        .map_err(EngineError::StartFailed)?;
        let binary = spec
            .launch
            .as_ref()
            .and_then(|l| l.binary.clone())
            .unwrap_or_else(|| self.binary.clone());
        let mut launch = base_launch(binary, self.profile);
        launch.cwd = Some(PathBuf::from(&spec.engine.cwd));
        if let Some(config) = &spec.launch {
            launch
                .env_set
                .extend(config.env.iter().map(|(k, v)| (k.into(), v.into())));
        }
        if self.profile == PiProfile::Omo {
            launch.env_set.retain(|(name, _)| {
                name != "SENPI_RPC_HOST_IDLE_EXIT_MS" && name != "SENPI_RPC_HOST_EMPTY_EXIT_MS"
            });
            launch.env_set.extend([
                ("SENPI_RPC_HOST_IDLE_EXIT_MS".into(), "1".into()),
                ("SENPI_RPC_HOST_EMPTY_EXIT_MS".into(), "1".into()),
            ]);
        }
        // A caller-provided environment cannot replace this thread's MCP credentials.
        launch.env_set.retain(|(k, _)| {
            let name = k.to_string_lossy();
            name == "GOAT_SUBAGENT_GATE"
                || (!name.starts_with("GOAT_") && !name.starts_with("T3CODE_"))
        });
        let cache_dir = match &self.cache_dir {
            Some(path) => path.clone(),
            None => PathBuf::from(std::env::var_os("HOME").ok_or_else(|| {
                EngineError::StartFailed("HOME is not set; cannot locate Pi extension cache".into())
            })?)
            .join(".goat2/cache/pi"),
        };
        let ext = extension::materialize_pi_goat_mcp_extension(&cache_dir)
            .map_err(|e| EngineError::StartFailed(format!("Pi extension: {e}")))?;
        launch.args.extend(["--mode".into(), "rpc".into()]);
        if let Some(reference) = &spec.resume {
            if reference.driver != self.profile.driver() {
                return Err(EngineError::StartFailed(
                    "resume driver does not match Pi profile".into(),
                ));
            }
            launch
                .args
                .extend(["--session".into(), reference.id.clone().into()]);
        }
        launch.args.extend(args.into_iter().map(Into::into));
        if let Some(prompt) = spec
            .instructions
            .as_ref()
            .and_then(|i| i.append_system_prompt.as_ref())
        {
            launch
                .args
                .extend(["--append-system-prompt".into(), prompt.into()]);
        }
        launch
            .args
            .extend(["--extension".into(), ext.as_os_str().into()]);
        let mode = match spec.engine.runtime_mode {
            RuntimeMode::ApprovalRequired | RuntimeMode::Auto => "approval-required",
            RuntimeMode::AutoAcceptEdits => "auto-accept-edits",
            RuntimeMode::FullAccess => "full-access",
        };
        launch.env_set.extend([
            ("GOAT_MCP_URL".into(), spec.mcp.url.into()),
            ("GOAT_MCP_BEARER_TOKEN".into(), spec.mcp.bearer_token.into()),
            ("GOAT_PI_PROFILE".into(), self.profile.binary().into()),
            ("GOAT_PI_RUNTIME_MODE".into(), mode.into()),
            ("GOAT_PI_MCP_EXTENSION_PATH".into(), ext.into_os_string()),
        ]);
        let (mut process, client, mut inbound) = spawn(&launch)?;
        if self.profile == PiProfile::Omo
            && let Err(error) = client
                .call(json!({"type":"prompt","message":"/computer off"}))
                .await
        {
            process.shutdown().await;
            return Err(EngineError::StartFailed(error.to_string()));
        }
        let state = match client.call(json!({"type":"get_state"})).await {
            Ok(v) => v,
            Err(e) => {
                process.shutdown().await;
                return Err(EngineError::StartFailed(e.to_string()));
            }
        };
        let engine_ref = match state.get("sessionFile").and_then(Value::as_str) {
            Some(path) if !path.is_empty() => path.to_owned(),
            _ => {
                process.shutdown().await;
                return Err(EngineError::StartFailed(
                    "get_state returned no persisted sessionFile".into(),
                ));
            }
        };
        if let Some(reference) = &spec.resume
            && reference.id != engine_ref
        {
            process.shutdown().await;
            return Err(EngineError::StartFailed(
                "Pi resumed a different session file".into(),
            ));
        }
        if state.get("isStreaming").and_then(Value::as_bool) == Some(true) {
            process.shutdown().await;
            return Err(EngineError::StartFailed(
                "Pi session already has unowned native activity".into(),
            ));
        }
        while let Ok(event) = inbound.try_recv() {
            match event {
                Inbound::Record(record)
                    if record.get("type").and_then(Value::as_str) == Some("agent_start") =>
                {
                    process.shutdown().await;
                    return Err(EngineError::StartFailed(
                        "Pi emitted unowned native activity during startup".into(),
                    ));
                }
                Inbound::Closed(reason) => {
                    process.shutdown().await;
                    return Err(EngineError::StartFailed(reason));
                }
                _ => {}
            }
        }
        let baseline_model = state.get("model").and_then(|m| {
            Some((
                m.get("provider")?.as_str()?.to_owned(),
                m.get("id")?.as_str()?.to_owned(),
            ))
        });
        let baseline_thinking = state
            .get("thinkingLevel")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let pgid = process.pid();
        let (tx, rx) = mpsc::unbounded_channel();
        let shared = Arc::new(Mutex::new(Shared {
            turn: None,
            last_turn: None,
            unowned: false,
            requests: HashMap::new(),
            pending_prompts: HashMap::new(),
            idle_probe: None,
            settled: None,
            saw_activity: false,
            abort_pending: false,
            barriers: HashMap::new(),
            translator: Translator::new(
                spec.thread_id,
                engine_ref.clone(),
                self.profile.binary(),
                spec.engine.provider_instance_id.to_string(),
            ),
        }));
        tokio::spawn(pump(
            inbound,
            Arc::clone(&shared),
            tx.clone(),
            Arc::clone(&client),
        ));
        let session = PiSession {
            client,
            process: Mutex::new(process),
            pgid,
            shared,
            events: tx,
            next_turn: AtomicU64::new(1),
            turn_prefix: format!("pi-{}-{}", spec.host_generation, spec.process_generation),
            runtime_mode: spec.engine.runtime_mode,
            preamble: Mutex::new(if spec.resume.is_none() {
                spec.instructions.and_then(|i| i.first_message_preamble)
            } else {
                None
            }),
            command_lock: Mutex::new(()),
            baseline_model,
            baseline_thinking,
            service_tier: Mutex::new(None),
        };
        Ok(EngineHandle {
            session: Box::new(session),
            events: rx,
            engine_ref: EngineRef {
                driver: self.profile.driver(),
                id: engine_ref,
            },
        })
    }
    fn capabilities(&self) -> ProviderCapabilities {
        crate::capabilities::for_driver(&self.profile.driver()).expect("Pi capabilities")
    }
    async fn probe(&self) -> Result<ProviderProbeResult, EngineError> {
        super::probe::probe(&self.binary, self.profile).await
    }
}
#[async_trait]
impl EngineSession for PiSession {
    async fn start_turn(
        &self,
        inputs: Vec<EngineInput>,
        settings: &TurnSettings,
    ) -> TurnStartResult {
        let _guard = self.command_lock.lock().await;
        let mut message = match plain_input(&inputs) {
            Ok(v) => v,
            Err(reason) => return TurnStartResult::Declined { reason },
        };
        {
            let state = self.shared.lock().await;
            if state.unowned {
                return TurnStartResult::RefusedUnowned {
                    reason: "Pi has unowned native activity".into(),
                };
            }
            if state.turn.is_some() {
                return TurnStartResult::Declined {
                    reason: "Pi turn already active".into(),
                };
            }
        }
        if let Err(error) = self.apply_config(settings).await {
            return TurnStartResult::Declined {
                reason: error.to_string(),
            };
        }
        // The reply is routed through the event pump, behind all earlier native events.
        let barrier_id = self.client.next_id();
        let (barrier_tx, barrier_rx) = oneshot::channel();
        self.shared
            .lock()
            .await
            .barriers
            .insert(barrier_id.clone(), barrier_tx);
        if let Err(error) = self
            .client
            .conn
            .send(&json!({"type":"get_state","id":barrier_id.clone()}))
            .await
        {
            self.shared.lock().await.barriers.remove(&barrier_id);
            return TurnStartResult::Unknown {
                reason: error.to_string(),
            };
        }
        match tokio::time::timeout(TIMEOUT, barrier_rx).await {
            Ok(Ok(true)) => {}
            Ok(Ok(false)) => {
                return TurnStartResult::RefusedUnowned {
                    reason: "Pi is not idle".into(),
                };
            }
            _ => {
                self.shared.lock().await.barriers.remove(&barrier_id);
                return TurnStartResult::Unknown {
                    reason: "Pi idle check did not complete".into(),
                };
            }
        }
        let mut preamble = self.preamble.lock().await;
        if let Some(prefix) = preamble.as_ref() {
            message = format!("{prefix}\n\n{message}");
        }
        let turn = format!(
            "{}-{}",
            self.turn_prefix,
            self.next_turn.fetch_add(1, Ordering::Relaxed)
        );
        let id = self.client.next_id();
        {
            let mut state = self.shared.lock().await;
            if state.unowned {
                return TurnStartResult::RefusedUnowned {
                    reason: "Pi has unowned native activity".into(),
                };
            }
            state.translator.start_turn();
            state.turn = Some(turn.clone());
            state.last_turn = Some(turn.clone());
            state.pending_prompts.clear();
            state
                .pending_prompts
                .insert(id.clone(), PendingPrompt::Start);
            state.idle_probe = None;
            state.settled = None;
            state.saw_activity = false;
            state.abort_pending = false;
            if let Err(error) = self.client.conn.send(&json!({"id": id, "type":"prompt","message":message,"streamingBehavior":"steer"})).await {
                return TurnStartResult::Unknown { reason: error.to_string() };
            }
        }
        *preamble = None;
        TurnStartResult::Accepted { turn_id: turn }
    }
    async fn steer(&self, turn_id: &str, inputs: Vec<EngineInput>) -> SteerResult {
        let _guard = self.command_lock.lock().await;
        let message = match plain_input(&inputs) {
            Ok(v) => v,
            Err(reason) => return SteerResult::Declined { reason },
        };
        let mut state = self.shared.lock().await;
        if state.turn.as_deref() != Some(turn_id) {
            return SteerResult::Declined {
                reason: "Pi turn is not active".into(),
            };
        }
        let id = self.client.next_id();
        let (ack_tx, ack_rx) = oneshot::channel();
        state
            .pending_prompts
            .insert(id.clone(), PendingPrompt::Steer(ack_tx));
        let sent = self
            .client
            .conn
            .send(&json!({"id":id,"type":"prompt","message":message,"streamingBehavior":"steer"}))
            .await;
        drop(state);
        drop(_guard);
        if let Err(e) = sent {
            return SteerResult::Unknown {
                reason: e.to_string(),
            };
        }
        match tokio::time::timeout(TIMEOUT, ack_rx).await {
            Ok(Ok(Ok(()))) => SteerResult::Accepted,
            Ok(Ok(Err(reason))) => SteerResult::Declined { reason },
            _ => SteerResult::Unknown {
                reason: "Pi did not acknowledge the steer".into(),
            },
        }
    }
    async fn interrupt(&self, turn_id: &str) -> Result<(), EngineError> {
        let _guard = self.command_lock.lock().await;
        {
            let mut state = self.shared.lock().await;
            if state.turn.as_deref() != Some(turn_id) {
                return Err(EngineError::Transport("Pi turn is not active".into()));
            }
            state.translator.interrupt();
            state.abort_pending = true;
        }
        if let Err(error) = self.client.call(json!({"type":"abort"})).await {
            self.finish_abort(turn_id, matches!(error, CallError::Remote(_)))
                .await;
            return Err(err(error));
        }
        let cleared = self
            .client
            .call(json!({"type":"clear_queue"}))
            .await
            .map_err(err);
        self.finish_abort(turn_id, false).await;
        cleared.map(|_| ())
    }
    async fn answer_request(&self, key: &str, answer: RequestAnswer) -> Result<(), EngineError> {
        let mut shared = self.shared.lock().await;
        let method = shared
            .requests
            .remove(key)
            .ok_or_else(|| EngineError::Transport("unknown Pi UI request".into()))?;
        let mut body = json!({"type":"extension_ui_response","id":key});
        if method == "confirm" {
            match answer.outcome {
                RequestOutcome::Accept | RequestOutcome::AcceptForSession => {
                    body["confirmed"] = json!(true)
                }
                RequestOutcome::Decline => body["confirmed"] = json!(false),
                _ => body["cancelled"] = json!(true),
            }
        } else if let Some(value) = answer.text.or_else(|| {
            answer
                .answers
                .and_then(|map| map.get(key).and_then(Value::as_str).map(str::to_owned))
        }) {
            body["value"] = json!(value);
        } else {
            body["cancelled"] = json!(true);
        }
        self.client.conn.send(&body).await.map_err(err)?;
        if let Some(event) = shared.translator.close_request(key) {
            let _ = self.events.send(event);
        }
        Ok(())
    }
    async fn set_config(&self, settings: &TurnSettings) -> Result<(), EngineError> {
        let _guard = self.command_lock.lock().await;
        self.apply_config(settings).await
    }
    fn group_rss_bytes(&self) -> Option<u64> {
        group_rss_bytes_of(self.pgid).ok()
    }
    fn process_group_id(&self) -> Option<i32> {
        i32::try_from(self.pgid).ok()
    }
    async fn shutdown(&self) {
        self.client.conn.close_input().await;
        self.process.lock().await.shutdown().await;
    }
}
impl PiSession {
    async fn finish_abort(&self, turn_id: &str, rejected: bool) {
        let mut state = self.shared.lock().await;
        if state.turn.as_deref() != Some(turn_id) {
            return;
        }
        if rejected {
            state.translator.cancel_interrupt();
        }
        state.abort_pending = false;
        if state.settled.is_some() && state.pending_prompts.is_empty() {
            let id = self.client.next_id();
            state.idle_probe = Some(id.clone());
            if self
                .client
                .conn
                .send(&json!({"type":"get_state","id":id}))
                .await
                .is_err()
            {
                state.idle_probe = None;
            }
        }
    }
    // v1 adapter.ts:2550-2621, match reported model pairs before slug splitting.
    async fn apply_config(&self, settings: &TurnSettings) -> Result<(), EngineError> {
        if settings.runtime_mode != self.runtime_mode {
            return Err(EngineError::Unsupported(
                "Pi runtime mode changes require a new session".into(),
            ));
        }
        let slug = &settings.model_selection.model;
        let live = self
            .client
            .call(json!({"type":"get_state"}))
            .await
            .map_err(err)?;
        let selected = if slug == "default" {
            self.baseline_model.clone()
        } else {
            let inventory = self
                .client
                .call(json!({"type":"get_available_models"}))
                .await
                .map_err(err)?;
            let found = inventory
                .get("models")
                .and_then(Value::as_array)
                .and_then(|models| {
                    models.iter().find_map(|m| {
                        let p = m.get("provider")?.as_str()?;
                        let id = m.get("id")?.as_str()?;
                        (format!("{p}/{id}") == *slug).then(|| (p.to_owned(), id.to_owned()))
                    })
                });
            Some(
                found
                    .or_else(|| {
                        slug.split_once('/')
                            .filter(|(a, b)| !a.is_empty() && !b.is_empty())
                            .map(|(a, b)| (a.to_owned(), b.to_owned()))
                    })
                    .ok_or_else(|| {
                        EngineError::Transport(format!(
                            "Pi model '{slug}' must use provider/model format"
                        ))
                    })?,
            )
        };
        let current_model = live
            .get("model")
            .and_then(|m| Some((m.get("provider")?.as_str()?, m.get("id")?.as_str()?)));
        let model_changed = selected
            .as_ref()
            .is_some_and(|(provider, id)| current_model != Some((provider.as_str(), id.as_str())));
        if model_changed && let Some((provider, id)) = selected {
            self.client
                .call(json!({"type":"set_model","provider":provider,"modelId":id}))
                .await
                .map_err(err)?;
        }
        let thinking = settings
            .model_selection
            .options
            .as_ref()
            .and_then(|opts| opts.iter().find(|v| v.id == "thinking"))
            .and_then(|v| match &v.value {
                ProviderOptionSelectionValue::Text(v) => Some(v.clone()),
                _ => None,
            })
            .or_else(|| {
                (slug == "default")
                    .then(|| self.baseline_thinking.clone())
                    .flatten()
            });
        if let Some(level) = thinking
            && ["off", "minimal", "low", "medium", "high", "xhigh", "max"].contains(&level.as_str())
            && (model_changed
                || live.get("thinkingLevel").and_then(Value::as_str) != Some(level.as_str()))
        {
            self.client
                .call(json!({"type":"set_thinking_level","level":level}))
                .await
                .map_err(err)?;
        }
        let tier = settings
            .model_selection
            .options
            .as_ref()
            .and_then(|opts| opts.iter().find(|v| v.id == "serviceTier"))
            .and_then(|v| match &v.value {
                ProviderOptionSelectionValue::Text(v) if v != "default" => Some(v.clone()),
                _ => None,
            });
        let mut applied_tier = self.service_tier.lock().await;
        if tier != *applied_tier {
            let command = format!("/goat-service-tier {}", tier.as_deref().unwrap_or(""));
            let response = self
                .client
                .call(json!({"type":"prompt","message":command.trim_end()}))
                .await
                .map_err(err)?;
            if response
                .get("disposition")
                .and_then(Value::as_str)
                .is_some_and(|v| v != "handled")
            {
                return Err(EngineError::Transport(
                    "Pi extension did not apply the service tier".into(),
                ));
            }
            *applied_tier = tier;
        }
        Ok(())
    }
}
