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
use tokio::sync::{Mutex, mpsc};

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
    pub(super) async fn call(&self, mut record: Value) -> Result<Value, CallError> {
        let id = format!("goat-{}", self.next.fetch_add(1, Ordering::Relaxed));
        record["id"] = json!(id);
        self.conn.call(id, &record, TIMEOUT).await
    }
}
struct Shared {
    turn: Option<String>,
    unowned: bool,
    requests: HashMap<String, String>,
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
) {
    while let Some(msg) = inbound.recv().await {
        match msg {
            Inbound::Closed(reason) => {
                let _ = tx.send(EngineEvent::Exited { reason });
                return;
            }
            Inbound::Record(record) => {
                let mut state = shared.lock().await;
                if state.turn.is_none()
                    && record.get("type").and_then(Value::as_str) == Some("agent_start")
                {
                    state.unowned = true;
                }
                if let Some(turn) = state.turn.clone() {
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
            !k.to_string_lossy().starts_with("GOAT_") && !k.to_string_lossy().starts_with("T3CODE_")
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
            unowned: false,
            requests: HashMap::new(),
            translator: Translator::new(
                spec.thread_id,
                engine_ref.clone(),
                self.profile.binary(),
                spec.engine.provider_instance_id.to_string(),
            ),
        }));
        tokio::spawn(pump(inbound, Arc::clone(&shared), tx.clone()));
        let session = PiSession {
            client,
            process: Mutex::new(process),
            pgid,
            shared,
            events: tx,
            next_turn: AtomicU64::new(1),
            turn_prefix: format!("pi-{}-{}", spec.host_generation, spec.process_generation),
            runtime_mode: spec.engine.runtime_mode,
            preamble: Mutex::new(spec.instructions.and_then(|i| i.first_message_preamble)),
            command_lock: Mutex::new(()),
            baseline_model,
            baseline_thinking,
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
        let mut preamble = self.preamble.lock().await;
        if let Some(prefix) = preamble.as_ref() {
            message = format!("{prefix}\n\n{message}");
        }
        let turn = format!(
            "{}-{}",
            self.turn_prefix,
            self.next_turn.fetch_add(1, Ordering::Relaxed)
        );
        {
            let mut state = self.shared.lock().await;
            if state.unowned {
                return TurnStartResult::RefusedUnowned {
                    reason: "Pi has unowned native activity".into(),
                };
            }
            state.translator.start_turn();
            state.turn = Some(turn.clone());
        }
        match self
            .client
            .call(json!({"type":"prompt","message":message}))
            .await
        {
            Ok(_) => {
                *preamble = None;
                TurnStartResult::Accepted { turn_id: turn }
            }
            Err(CallError::Remote(e)) => {
                self.shared.lock().await.turn = None;
                TurnStartResult::Declined { reason: e.message }
            }
            Err(e) => TurnStartResult::Unknown {
                reason: e.to_string(),
            },
        }
    }
    async fn steer(&self, turn_id: &str, inputs: Vec<EngineInput>) -> SteerResult {
        let _guard = self.command_lock.lock().await;
        if self.shared.lock().await.turn.as_deref() != Some(turn_id) {
            return SteerResult::Declined {
                reason: "Pi turn is not active".into(),
            };
        }
        let message = match plain_input(&inputs) {
            Ok(v) => v,
            Err(reason) => return SteerResult::Declined { reason },
        };
        match self
            .client
            .call(json!({"type":"prompt","message":message,"streamingBehavior":"steer"}))
            .await
        {
            Ok(_) => SteerResult::Accepted,
            Err(CallError::Remote(e)) => SteerResult::Declined { reason: e.message },
            Err(e) => SteerResult::Unknown {
                reason: e.to_string(),
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
        }
        self.client
            .call(json!({"type":"abort"}))
            .await
            .map_err(err)?;
        self.client
            .call(json!({"type":"clear_queue"}))
            .await
            .map_err(err)?;
        Ok(())
    }
    async fn answer_request(&self, key: &str, answer: RequestAnswer) -> Result<(), EngineError> {
        let method = self
            .shared
            .lock()
            .await
            .requests
            .get(key)
            .cloned()
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
        let mut shared = self.shared.lock().await;
        shared.requests.remove(key);
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
    // v1 adapter.ts:2550-2621, match reported model pairs before slug splitting.
    async fn apply_config(&self, settings: &TurnSettings) -> Result<(), EngineError> {
        if settings.runtime_mode != self.runtime_mode {
            return Err(EngineError::Unsupported(
                "Pi runtime mode changes require a new session".into(),
            ));
        }
        let slug = &settings.model_selection.model;
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
        if let Some((provider, id)) = selected {
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
            .or_else(|| self.baseline_thinking.clone());
        if let Some(level) = thinking {
            self.client
                .call(json!({"type":"set_thinking_level","level":level}))
                .await
                .map_err(err)?;
        }
        Ok(())
    }
}
