//! Pi RPC process and session lifecycle, ported from v1 rpc.ts and adapter.ts.
use super::{events::Translator, extension, resolve_launch_args};
use crate::{
    helper::AttachmentResolver,
    jsonl::{CallError, Connection, Dialect, Inbound, RemoteError},
    process::{ChildProcess, Launch, group_rss_bytes_of},
};
use async_trait::async_trait;
use goat2_contracts::{
    EngineDriver, EngineRef, ProviderCapabilities, ProviderOptionSelectionValue,
    ProviderProbeResult, RequestOutcome, RuntimeMode, ThreadId,
};
use goat2_engine_api::{
    EngineError, EngineEvent, EngineFactory, EngineHandle, EngineInput, EngineSession,
    RequestAnswer, SessionSpec, SteerResult, TurnSettings, TurnStartResult,
};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::sync::{Mutex, mpsc, oneshot};

const TIMEOUT: Duration = Duration::from_secs(30);
static CUSTOM_TOTAL: AtomicU64 = AtomicU64::new(0);
#[derive(Default)]
struct CustomAnswers {
    queues: HashMap<String, VecDeque<String>>,
    total: u64,
}
impl CustomAnswers {
    fn clear(&mut self) {
        CUSTOM_TOTAL.fetch_sub(self.total, Ordering::Relaxed);
        self.total = 0;
        self.queues.clear();
    }
}
impl Drop for CustomAnswers {
    fn drop(&mut self) {
        self.clear();
    }
}
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
    attachments: Option<AttachmentResolver>,
}
impl PiFactory {
    /// Construct a Pi-family factory for the corresponding engine driver.
    pub fn for_driver(driver: EngineDriver) -> Option<Self> {
        match driver {
            EngineDriver::Pi => Some(Self::new(PiProfile::Pi)),
            EngineDriver::Omo => Some(Self::new(PiProfile::Omo)),
            _ => None,
        }
    }
    pub fn new(profile: PiProfile) -> Self {
        Self {
            profile,
            binary: profile.binary().into(),
            cache_dir: None,
            attachments: None,
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
    /// Resolve saved attachments for this session's thread.
    pub fn with_attachment_resolver(mut self, resolver: AttachmentResolver) -> Self {
        self.attachments = Some(resolver);
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
struct UiRequest {
    method: String,
    approval_key: (String, String),
    token: String,
    deadline: Option<tokio::time::Instant>,
    expiry: Option<tokio::task::AbortHandle>,
    route: Option<super::dialog::Route>,
}
impl Drop for UiRequest {
    fn drop(&mut self) {
        if let Some(expiry) = &self.expiry {
            expiry.abort();
        }
    }
}
struct Shared {
    turn: Option<String>,
    last_turn: Option<String>,
    unowned: bool,
    requests: HashMap<String, UiRequest>,
    approvals: HashSet<(String, String)>,
    custom: CustomAnswers,
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
    thread_id: ThreadId,
    cwd: PathBuf,
    attachments: Option<AttachmentResolver>,
}
fn err(error: CallError) -> EngineError {
    EngineError::Transport(error.to_string())
}
fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        output.push(TABLE[((n >> 18) & 63) as usize] as char);
        output.push(TABLE[((n >> 12) & 63) as usize] as char);
        output.push(if chunk.len() > 1 {
            TABLE[((n >> 6) & 63) as usize] as char
        } else {
            '='
        });
        output.push(if chunk.len() > 2 {
            TABLE[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    output
}
async fn prompt_payload(
    inputs: &[EngineInput],
    thread: &ThreadId,
    cwd: &std::path::Path,
    resolver: Option<&AttachmentResolver>,
) -> Result<(String, Vec<Value>), String> {
    let mut message = inputs
        .iter()
        .map(|i| i.text.as_str())
        .collect::<Vec<_>>()
        .join("\n\n");
    let mut images = Vec::new();
    for attachment in inputs.iter().flat_map(|input| &input.attachments) {
        let kind = match attachment.kind {
            goat2_contracts::ChatAttachmentType::Image => "image",
            goat2_contracts::ChatAttachmentType::File => "file",
        };
        let path = resolver
            .and_then(|resolve| resolve(thread, attachment))
            .filter(|path| !path.as_os_str().is_empty())
            .map(|path| {
                if path.is_absolute() {
                    path
                } else {
                    cwd.join(path)
                }
            });
        let context = if let Some(path) = path {
            if attachment.mime_type.starts_with("image/") {
                let bytes = tokio::fs::read(&path).await.map_err(|error| {
                    format!(
                        "Unable to read attachment '{}' at {}: {error}",
                        attachment.name,
                        path.display()
                    )
                })?;
                images.push(
                    json!({"type":"image", "data":base64(&bytes), "mimeType":attachment.mime_type}),
                );
            }
            format!(
                "[Attached {kind} \"{}\" is saved at: {}]",
                attachment.name,
                path.display()
            )
        } else {
            format!(
                "[Attached {kind} \"{}\" is unavailable: could not resolve a saved path for attachment '{}'.]",
                attachment.name, attachment.id
            )
        };
        if !message.is_empty() {
            message.push_str("\n\n");
        }
        message.push_str(&context);
    }
    Ok((message, images))
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
                let mut state = shared.lock().await;
                state.requests.clear();
                state.custom.clear();
                state.pending_prompts.clear();
                state.barriers.clear();
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
                                state.custom.clear();
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
                            state.custom.clear();
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
                        if method == "input"
                            && record.get("placeholder").and_then(Value::as_str) == Some("")
                        {
                            let title = record.get("title").and_then(Value::as_str).unwrap_or("");
                            let prefix = state
                                .custom
                                .queues
                                .keys()
                                .filter(|p| title.starts_with(p.as_str()))
                                .max_by_key(|p| p.len())
                                .cloned();
                            if let Some(prefix) = prefix {
                                let answer = state.custom.queues[&prefix]
                                    .front()
                                    .cloned()
                                    .expect("nonempty custom queue");
                                if let Err(error) = client.conn.send(&json!({"type":"extension_ui_response","id":id,"value":answer})).await {
                                    let _ = tx.send(EngineEvent::Exited { reason: error.to_string() });
                                    return;
                                }
                                let queue =
                                    state.custom.queues.get_mut(&prefix).expect("custom queue");
                                queue.pop_front();
                                if queue.is_empty() {
                                    state.custom.queues.remove(&prefix);
                                }
                                state.custom.total -= 1;
                                CUSTOM_TOTAL.fetch_sub(1, Ordering::Relaxed);
                                continue;
                            }
                        }
                        let approval_key = (
                            record
                                .get("title")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_owned(),
                            record
                                .get("message")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_owned(),
                        );
                        if method == "confirm" && state.approvals.contains(&approval_key) {
                            if let Err(error) = client.conn.send(&json!({"type":"extension_ui_response","id":id,"confirmed":true})).await {
                                let _ = tx.send(EngineEvent::Exited { reason: error.to_string() });
                                return;
                            }
                            continue;
                        }
                        let deadline = record
                            .get("timeout")
                            .and_then(Value::as_f64)
                            .filter(|n| *n != 0.0 && n.is_finite())
                            .and_then(|n| {
                                tokio::time::Instant::now().checked_add(Duration::from_secs_f64(
                                    (n.max(0.0) / 1000.0).min(3153600000.0),
                                ))
                            });
                        let token = client.next_id();
                        let route = state
                            .translator
                            .structured_question(&record)
                            .map(|(_, route)| route);
                        state.requests.insert(
                            id.to_owned(),
                            UiRequest {
                                method: method.to_owned(),
                                approval_key,
                                token: token.clone(),
                                deadline,
                                expiry: None,
                                route,
                            },
                        );
                        if let Some(deadline) = deadline {
                            let shared = shared.clone();
                            let client = client.clone();
                            let tx = tx.clone();
                            let expiry_id = id.to_owned();
                            let task = tokio::spawn(async move {
                                tokio::time::sleep_until(deadline).await;
                                let mut state = shared.lock().await;
                                if state
                                    .requests
                                    .get(&expiry_id)
                                    .is_some_and(|r| r.token == token)
                                {
                                    let _ = client.conn.send(&json!({"type":"extension_ui_response","id":expiry_id,"cancelled":true})).await;
                                    state.requests.remove(&expiry_id);
                                    if let Some(event) = state.translator.close_request(&expiry_id)
                                    {
                                        let _ = tx.send(event);
                                    }
                                }
                            });
                            if let Some(request) = state.requests.get_mut(id) {
                                request.expiry = Some(task.abort_handle());
                            }
                        }
                    }
                    let output = state.translator.translate(&record, &turn);
                    for event in output {
                        if matches!(event, EngineEvent::TurnFinished { .. }) {
                            state.turn = None;
                            state.requests.clear();
                            state.custom.clear();
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
            approvals: HashSet::new(),
            custom: CustomAnswers::default(),
            pending_prompts: HashMap::new(),
            idle_probe: None,
            settled: None,
            saw_activity: false,
            abort_pending: false,
            barriers: HashMap::new(),
            translator: Translator::new(
                spec.thread_id.clone(),
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
            thread_id: spec.thread_id,
            cwd: if std::path::Path::new(&spec.engine.cwd).is_absolute() {
                PathBuf::from(&spec.engine.cwd)
            } else {
                std::env::current_dir()
                    .map_err(|e| EngineError::StartFailed(e.to_string()))?
                    .join(&spec.engine.cwd)
            },
            attachments: self.attachments.clone(),
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
        let (mut message, images) = match prompt_payload(
            &inputs,
            &self.thread_id,
            &self.cwd,
            self.attachments.as_ref(),
        )
        .await
        {
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
            if let Err(error) = self.client.conn.send(&json!({"id": id, "type":"prompt","message":message,"images":images,"streamingBehavior":"steer"})).await {
                return TurnStartResult::Unknown { reason: error.to_string() };
            }
        }
        *preamble = None;
        TurnStartResult::Accepted { turn_id: turn }
    }
    async fn steer(&self, turn_id: &str, inputs: Vec<EngineInput>) -> SteerResult {
        let _guard = self.command_lock.lock().await;
        let (message, images) = match prompt_payload(
            &inputs,
            &self.thread_id,
            &self.cwd,
            self.attachments.as_ref(),
        )
        .await
        {
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
            .send(&json!({"id":id,"type":"prompt","message":message,"images":images,"streamingBehavior":"steer"}))
            .await;
        drop(state);
        drop(_guard);
        if let Err(e) = sent {
            finish_uncertain_steer(&self.shared, &self.client, &id).await;
            return SteerResult::Unknown {
                reason: e.to_string(),
            };
        }
        wait_steer(&self.shared, &self.client, &id, ack_rx, TIMEOUT).await
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
        let request = shared
            .requests
            .get(key)
            .ok_or_else(|| EngineError::Transport("unknown Pi UI request".into()))?;
        if request
            .deadline
            .is_some_and(|deadline| tokio::time::Instant::now() >= deadline)
        {
            return Err(EngineError::Transport("expired Pi UI request".into()));
        }
        let method = request.method.clone();
        let approval_key = request.approval_key.clone();
        let route = request.route.clone();
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
        let mut queued = None;
        if let (Some(route), Some(value)) = (route, body.get("value").and_then(Value::as_str))
            && !value.trim().is_empty()
            && !route.lines.iter().any(|line| line == value)
        {
            if value.encode_utf16().count() > 16384
                || shared.custom.total >= 64
                || shared
                    .custom
                    .queues
                    .get(&route.prefix)
                    .is_some_and(|q| q.len() >= 8)
                || CUSTOM_TOTAL
                    .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |n| {
                        (n < 256).then_some(n + 1)
                    })
                    .is_err()
            {
                return Err(EngineError::Transport("Too many Pi custom answers".into()));
            }
            queued = Some((route.prefix, value.to_owned()));
            body["value"] = json!(route.sentinel);
        }
        if let Err(error) = self.client.conn.send(&body).await {
            if queued.is_some() {
                CUSTOM_TOTAL.fetch_sub(1, Ordering::Relaxed);
            }
            return Err(err(error));
        }
        if let Some((prefix, value)) = queued {
            shared
                .custom
                .queues
                .entry(prefix)
                .or_default()
                .push_back(value);
            shared.custom.total += 1;
        }
        shared.requests.remove(key);
        if method == "confirm" && matches!(answer.outcome, RequestOutcome::AcceptForSession) {
            shared.approvals.insert(approval_key);
        }
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
        let mut state = self.shared.lock().await;
        state.requests.clear();
        state.custom.clear();
        drop(state);
        self.client.conn.close_input().await;
        self.process.lock().await.shutdown().await;
    }
}
async fn finish_uncertain_steer(shared: &Mutex<Shared>, client: &Client, id: &str) {
    let mut state = shared.lock().await;
    if state.pending_prompts.remove(id).is_none() {
        return;
    }
    if state.settled.is_some()
        && state.pending_prompts.is_empty()
        && !state.abort_pending
        && state.turn.is_some()
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
}
async fn wait_steer(
    shared: &Mutex<Shared>,
    client: &Client,
    id: &str,
    ack: oneshot::Receiver<Result<(), String>>,
    timeout: Duration,
) -> SteerResult {
    match tokio::time::timeout(timeout, ack).await {
        Ok(Ok(Ok(()))) => SteerResult::Accepted,
        Ok(Ok(Err(reason))) => SteerResult::Declined { reason },
        _ => {
            finish_uncertain_steer(shared, client, id).await;
            SteerResult::Unknown {
                reason: "Pi did not acknowledge the steer".into(),
            }
        }
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

#[cfg(test)]
mod dialog_lifecycle_tests {
    use super::*;

    fn test_session() -> (PiSession, mpsc::UnboundedReceiver<Inbound>) {
        let (child, client, outbound) = spawn(&Launch::new("/bin/cat")).unwrap();
        let pgid = child.pid();
        let mut translator =
            Translator::new(ThreadId::from("test"), "engine".into(), "pi", "test".into());
        translator.translate(
            &json!({"type":"extension_ui_request","id":"request","method":"select","title":"Pick"}),
            "turn",
        );
        let state = Shared {
            turn: Some("turn".into()),
            last_turn: None,
            unowned: false,
            requests: HashMap::new(),
            approvals: HashSet::new(),
            custom: CustomAnswers::default(),
            pending_prompts: HashMap::new(),
            idle_probe: None,
            settled: None,
            saw_activity: true,
            abort_pending: false,
            barriers: HashMap::new(),
            translator,
        };
        let (events, _) = mpsc::unbounded_channel();
        (
            PiSession {
                client,
                process: Mutex::new(child),
                pgid,
                shared: Arc::new(Mutex::new(state)),
                events,
                next_turn: AtomicU64::new(1),
                turn_prefix: "test".into(),
                runtime_mode: RuntimeMode::FullAccess,
                preamble: Mutex::new(None),
                command_lock: Mutex::new(()),
                baseline_model: None,
                baseline_thinking: None,
                service_tier: Mutex::new(None),
                thread_id: ThreadId::from("test"),
                cwd: PathBuf::from("/"),
                attachments: None,
            },
            outbound,
        )
    }

    fn request(expiry: Option<tokio::task::AbortHandle>) -> UiRequest {
        UiRequest {
            method: "select".into(),
            approval_key: (String::new(), String::new()),
            token: "token".into(),
            deadline: None,
            expiry,
            route: Some(super::super::dialog::Route {
                lines: vec!["option".into()],
                sentinel: "sentinel".into(),
                prefix: "prefix".into(),
            }),
        }
    }

    #[tokio::test]
    async fn send_failure_keeps_request_and_does_not_queue_custom_answer() {
        let (session, _outbound) = test_session();
        session
            .shared
            .lock()
            .await
            .requests
            .insert("request".into(), request(None));
        session.client.conn.close_input().await;
        let answer = RequestAnswer {
            outcome: RequestOutcome::Answered,
            text: Some("custom".into()),
            answers: None,
        };
        assert!(session.answer_request("request", answer).await.is_err());
        let state = session.shared.lock().await;
        assert!(state.requests.contains_key("request"));
        assert_eq!(state.custom.total, 0);
        assert!(state.custom.queues.is_empty());
        drop(state);
        session.shutdown().await;
    }

    #[tokio::test]
    async fn successful_answer_cancels_positive_expiry_task() {
        let (session, mut outbound) = test_session();
        let timer = tokio::spawn(async { tokio::time::sleep(Duration::from_secs(60)).await });
        session
            .shared
            .lock()
            .await
            .requests
            .insert("request".into(), request(Some(timer.abort_handle())));
        session
            .answer_request(
                "request",
                RequestAnswer {
                    outcome: RequestOutcome::Answered,
                    text: Some("option".into()),
                    answers: None,
                },
            )
            .await
            .unwrap();
        assert!(timer.await.unwrap_err().is_cancelled());
        let Inbound::Record(response) = outbound.recv().await.unwrap() else {
            panic!("expected response")
        };
        assert_eq!(
            response,
            json!({"type":"extension_ui_response","id":"request","value":"option"})
        );
        assert!(session.shared.lock().await.requests.is_empty());
        session.shutdown().await;
    }

    #[tokio::test(start_paused = true)]
    async fn positive_deadline_closes_request_and_sends_cancellation() {
        let (session, mut outbound) = test_session();
        let (in_tx, in_rx) = mpsc::unbounded_channel();
        let (event_tx, mut events) = mpsc::unbounded_channel();
        let pump_task = tokio::spawn(pump(
            in_rx,
            session.shared.clone(),
            event_tx,
            session.client.clone(),
        ));
        in_tx.send(Inbound::Record(json!({"type":"extension_ui_request","id":"expiring","method":"input","title":"Question","timeout":1000}))).unwrap();
        assert!(matches!(
            events.recv().await,
            Some(EngineEvent::RequestOpened { .. })
        ));
        tokio::time::advance(Duration::from_millis(999)).await;
        assert!(
            session
                .shared
                .lock()
                .await
                .requests
                .contains_key("expiring")
        );
        tokio::time::advance(Duration::from_millis(1)).await;
        assert!(
            matches!(events.recv().await, Some(EngineEvent::RequestClosed { key }) if key == "expiring")
        );
        let Inbound::Record(response) = outbound.recv().await.unwrap() else {
            panic!("expected cancellation")
        };
        assert_eq!(
            response,
            json!({"type":"extension_ui_response","id":"expiring","cancelled":true})
        );
        assert!(
            session
                .answer_request(
                    "expiring",
                    RequestAnswer {
                        outcome: RequestOutcome::Answered,
                        text: Some("late".into()),
                        answers: None
                    }
                )
                .await
                .is_err()
        );
        drop(in_tx);
        pump_task.await.unwrap();
        session.shutdown().await;
    }

    #[tokio::test]
    async fn uncertain_steer_releases_settlement_after_idle_probe() {
        let launch = Launch::new("/bin/cat");
        let (mut child, client, mut outbound) = spawn(&launch).unwrap();
        let (ack_tx, ack_rx) = oneshot::channel();
        let shared = Arc::new(Mutex::new(Shared {
            turn: Some("turn".into()),
            last_turn: None,
            unowned: false,
            requests: HashMap::new(),
            approvals: HashSet::new(),
            custom: CustomAnswers::default(),
            pending_prompts: HashMap::from([("steer".into(), PendingPrompt::Steer(ack_tx))]),
            idle_probe: None,
            settled: Some(json!({"type":"agent_settled"})),
            saw_activity: true,
            abort_pending: false,
            barriers: HashMap::new(),
            translator: Translator::new(
                ThreadId::from("test"),
                "engine".into(),
                "pi",
                "test".into(),
            ),
        }));
        let outcome = wait_steer(&shared, &client, "steer", ack_rx, Duration::ZERO).await;
        assert!(matches!(outcome, SteerResult::Unknown { .. }));
        let Inbound::Record(probe) = outbound.recv().await.unwrap() else {
            panic!("expected idle probe")
        };
        assert_eq!(probe["type"], "get_state");
        assert!(shared.lock().await.pending_prompts.is_empty());
        let (in_tx, in_rx) = mpsc::unbounded_channel();
        let (event_tx, mut events) = mpsc::unbounded_channel();
        let task = tokio::spawn(pump(in_rx, shared.clone(), event_tx, client.clone()));
        in_tx
            .send(Inbound::Record(
                json!({"type":"response","id":"steer","success":true}),
            ))
            .unwrap();
        in_tx.send(Inbound::Record(json!({"type":"response","id":probe["id"],"success":true,"data":{"isStreaming":false,"isCompacting":false}}))).unwrap();
        assert!(matches!(
            events.recv().await,
            Some(EngineEvent::TurnFinished {
                outcome: goat2_engine_api::TurnOutcome::Done,
                ..
            })
        ));
        assert!(shared.lock().await.turn.is_none());
        drop(in_tx);
        task.await.unwrap();
        client.conn.close_input().await;
        child.shutdown().await;
    }
}
