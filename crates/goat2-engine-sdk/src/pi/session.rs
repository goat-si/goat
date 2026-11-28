//! Pi RPC process and session lifecycle, ported from v1 rpc.ts and adapter.ts.
use super::{events::Translator, extension, resolve_launch_args};
use crate::{
    helper::AttachmentResolver,
    jsonl::{CallError, Connection, Dialect, Inbound, RemoteError},
    process::{ChildProcess, Launch, group_rss_bytes_of},
};
use async_trait::async_trait;
use goat2_contracts::{
    EngineDriver, EngineRef, InputId, ProviderCapabilities, ProviderOptionSelectionValue,
    ProviderProbeResult, RequestOutcome, RuntimeMode, ThreadId,
};
use goat2_engine_api::{
    EngineError, EngineEvent, EngineFactory, EngineHandle, EngineInput, EngineSession,
    ProviderTarget, RequestAnswer, SessionSpec, SteerResult, SteerStatus, TurnSettings,
    TurnStartResult,
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
const PROBE_TIMEOUT: Duration = Duration::from_secs(2);
const PROBE_RETRY_DELAY: Duration = Duration::from_millis(100);
const PROBE_ATTEMPTS: u8 = 3;
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
    CompactStart,
    CompactSteer(oneshot::Sender<Result<(), String>>),
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
    session_file: String,
    turn: Option<String>,
    last_turn: Option<String>,
    unowned: bool,
    requests: HashMap<String, UiRequest>,
    approvals: HashSet<(String, String)>,
    custom: CustomAnswers,
    pending_prompts: HashMap<String, PendingPrompt>,
    steer_inputs: HashMap<String, Vec<InputId>>,
    unread_steers: VecDeque<Vec<InputId>>,
    idle_probe: Option<String>,
    probe_attempt: u8,
    probe_failed: bool,
    process: Arc<Mutex<ChildProcess>>,
    settled: Option<Value>,
    saw_activity: bool,
    command_candidate: bool,
    compacting: bool,
    abort_pending: bool,
    barriers: HashMap<String, oneshot::Sender<bool>>,
    translator: Translator,
}
impl Shared {
    fn cancel_unread(&mut self, tx: &mpsc::UnboundedSender<EngineEvent>) {
        if let Some(turn_id) = &self.turn {
            for input_ids in self.unread_steers.drain(..) {
                let _ = tx.send(EngineEvent::SteerUpdated {
                    turn_id: turn_id.clone(),
                    input_ids,
                    status: SteerStatus::Cancelled {
                        reason: "Pi turn ended before reading the steer".into(),
                    },
                });
            }
        }
    }
}
fn compact_command(message: &str) -> Option<Option<String>> {
    let text = message.trim();
    let rest = text.strip_prefix("/compact")?;
    if !rest.is_empty() && !rest.starts_with(char::is_whitespace) {
        return None;
    }
    let instructions = rest.trim();
    Some((!instructions.is_empty()).then(|| instructions.to_owned()))
}
fn compact_record(id: &str, instructions: Option<String>) -> Value {
    let mut record = json!({"id":id,"type":"compact"});
    if let Some(instructions) = instructions {
        record["customInstructions"] = json!(instructions);
    }
    record
}

fn changed_session(state: &Shared, data: &Value) -> bool {
    data.get("sessionFile")
        .and_then(Value::as_str)
        .is_some_and(|file| !file.is_empty() && file != state.session_file)
}

fn watch_start_ack(shared: Arc<Mutex<Shared>>, tx: mpsc::UnboundedSender<EngineEvent>, id: String) {
    let deadline = tokio::time::Instant::now() + TIMEOUT;
    tokio::spawn(async move {
        let mut deadline = deadline;
        loop {
            tokio::time::sleep_until(deadline).await;
            let mut state = shared.lock().await;
            if !matches!(
                state.pending_prompts.get(&id),
                Some(PendingPrompt::Start | PendingPrompt::CompactStart)
            ) {
                return;
            }
            if !state.requests.is_empty() {
                deadline = tokio::time::Instant::now() + TIMEOUT;
                continue;
            }
            state.pending_prompts.clear();
            state.probe_failed = true;
            state.cancel_unread(&tx);
            let process = state.process.clone();
            drop(state);
            let _ = tx.send(EngineEvent::Exited {
                reason: "Pi did not acknowledge the prompt; delivery is unknown".into(),
            });
            process.lock().await.kill_group();
            return;
        }
    });
}
struct PiSession {
    client: Arc<Client>,
    process: Arc<Mutex<ChildProcess>>,
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

fn retry_probe(
    shared: Arc<Mutex<Shared>>,
    client: Arc<Client>,
    tx: mpsc::UnboundedSender<EngineEvent>,
    marker: String,
    attempt: u8,
    delay: Duration,
) {
    let deadline = tokio::time::Instant::now() + delay;
    tokio::spawn(async move {
        tokio::time::sleep_until(deadline).await;
        let mut state = shared.lock().await;
        if state.idle_probe.as_deref() != Some(&marker) || state.turn.is_none() {
            return;
        }
        if attempt >= PROBE_ATTEMPTS {
            state.idle_probe = None;
            state.probe_failed = true;
            state.cancel_unread(&tx);
            let process = state.process.clone();
            drop(state);
            let _ = tx.send(EngineEvent::Exited {
                reason: "Pi settlement state check failed after retries".into(),
            });
            process.lock().await.kill_group();
            return;
        }
        let id = client.next_id();
        state.idle_probe = Some(id.clone());
        state.probe_attempt = attempt + 1;
        let sent = client.conn.send(&json!({"type":"get_state","id":id})).await;
        if sent.is_ok() {
            watch_probe(shared.clone(), client.clone(), tx.clone(), id, attempt + 1);
        } else {
            retry_probe(
                shared.clone(),
                client.clone(),
                tx.clone(),
                id,
                attempt + 1,
                PROBE_RETRY_DELAY,
            );
        }
    });
}

fn watch_probe(
    shared: Arc<Mutex<Shared>>,
    client: Arc<Client>,
    tx: mpsc::UnboundedSender<EngineEvent>,
    id: String,
    attempt: u8,
) {
    let deadline = tokio::time::Instant::now() + PROBE_TIMEOUT;
    tokio::spawn(async move {
        tokio::time::sleep_until(deadline).await;
        let mut state = shared.lock().await;
        if state.idle_probe.as_deref() != Some(&id) || state.turn.is_none() {
            return;
        }
        let marker = client.next_id();
        state.idle_probe = Some(marker.clone());
        retry_probe(
            shared.clone(),
            client.clone(),
            tx.clone(),
            marker,
            attempt,
            PROBE_RETRY_DELAY,
        );
    });
}

async fn start_probe(
    state: &mut Shared,
    shared: Arc<Mutex<Shared>>,
    client: Arc<Client>,
    tx: mpsc::UnboundedSender<EngineEvent>,
) {
    let id = client.next_id();
    state.idle_probe = Some(id.clone());
    state.probe_attempt = 1;
    let sent = client.conn.send(&json!({"type":"get_state","id":id})).await;
    if sent.is_ok() {
        watch_probe(shared, client, tx, id, 1);
    } else {
        retry_probe(shared, client, tx, id, 1, PROBE_RETRY_DELAY);
    }
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
                state.cancel_unread(&tx);
                state.idle_probe = None;
                state.requests.clear();
                state.custom.clear();
                state.pending_prompts.clear();
                state.barriers.clear();
                if !state.probe_failed {
                    let _ = tx.send(EngineEvent::Exited { reason });
                }
                return;
            }
            Inbound::Record(record) => {
                let mut state = shared.lock().await;
                if record.get("type").and_then(Value::as_str) == Some("response") {
                    let id = record.get("id").and_then(Value::as_str).unwrap_or("");
                    if (state.barriers.contains_key(id) || state.idle_probe.as_deref() == Some(id))
                        && record.get("success").and_then(Value::as_bool) == Some(true)
                        && changed_session(&state, &record["data"])
                    {
                        state.probe_failed = true;
                        state.barriers.clear();
                        state.pending_prompts.clear();
                        state.requests.clear();
                        state.cancel_unread(&tx);
                        let process = state.process.clone();
                        drop(state);
                        let _ = tx.send(EngineEvent::Exited {
                            reason: "Pi session file changed; cannot safely resume this session"
                                .into(),
                        });
                        process.lock().await.kill_group();
                        return;
                    }
                    if let Some(barrier) = state.barriers.remove(id) {
                        let idle = record.get("success").and_then(Value::as_bool) == Some(true)
                            && record.pointer("/data/isStreaming").and_then(Value::as_bool)
                                == Some(false)
                            && record
                                .pointer("/data/isCompacting")
                                .and_then(Value::as_bool)
                                != Some(true)
                            && record
                                .pointer("/data/pendingMessageCount")
                                .and_then(Value::as_u64)
                                .unwrap_or(0)
                                == 0
                            && !state.unowned;
                        let _ = barrier.send(idle);
                        continue;
                    }
                    if let Some(pending) = state.pending_prompts.remove(id) {
                        let success = record.get("success").and_then(Value::as_bool) == Some(true);
                        if let Some(input_ids) = state.steer_inputs.remove(id)
                            && success
                            && let Some(turn_id) = state.turn.clone()
                        {
                            if record.pointer("/data/disposition").and_then(Value::as_str)
                                == Some("queued")
                            {
                                state.unread_steers.push_back(input_ids);
                            } else {
                                let _ = tx.send(EngineEvent::SteerUpdated {
                                    turn_id,
                                    input_ids,
                                    status: SteerStatus::Completed,
                                });
                            }
                        }
                        let is_start =
                            matches!(pending, PendingPrompt::Start | PendingPrompt::CompactStart);
                        let is_compact = matches!(
                            pending,
                            PendingPrompt::CompactStart | PendingPrompt::CompactSteer(_)
                        );
                        if let PendingPrompt::Steer(sender) | PendingPrompt::CompactSteer(sender) =
                            pending
                        {
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
                        if !success && is_start && !(is_compact && state.compacting) {
                            if let Some(turn) = state.turn.clone() {
                                if state.saw_activity {
                                    state.unowned = true;
                                }
                                let reason = record.get("error").and_then(Value::as_str).unwrap_or(
                                    if is_compact {
                                        "Pi compact failed."
                                    } else {
                                        "Pi rejected the prompt."
                                    },
                                );
                                let failure = json!({"type":"message_end","message":{"role":"assistant","stopReason":"error","errorMessage":reason}});
                                let mut events = state.translator.translate(&failure, &turn);
                                events.extend(
                                    state
                                        .translator
                                        .translate(&json!({"type":"agent_settled"}), &turn),
                                );
                                state.cancel_unread(&tx);
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
                                || ((is_start || is_compact)
                                    && !state.saw_activity
                                    && (state.command_candidate
                                        || record
                                            .pointer("/data/disposition")
                                            .and_then(Value::as_str)
                                            == Some("handled"))))
                        {
                            if state.settled.is_none() {
                                state.settled = Some(json!({"type":"agent_settled"}));
                            }
                            start_probe(&mut state, shared.clone(), client.clone(), tx.clone())
                                .await;
                        }
                        continue;
                    }
                    if state.idle_probe.as_deref() == Some(id) {
                        if record.get("success").and_then(Value::as_bool) != Some(true) {
                            let marker = client.next_id();
                            state.idle_probe = Some(marker.clone());
                            retry_probe(
                                shared.clone(),
                                client.clone(),
                                tx.clone(),
                                marker,
                                state.probe_attempt,
                                PROBE_RETRY_DELAY,
                            );
                            continue;
                        }
                        state.idle_probe = None;
                        if record.get("success").and_then(Value::as_bool) == Some(true)
                            && record.pointer("/data/isStreaming").and_then(Value::as_bool)
                                == Some(false)
                            && record
                                .pointer("/data/isCompacting")
                                .and_then(Value::as_bool)
                                != Some(true)
                            && record
                                .pointer("/data/pendingMessageCount")
                                .and_then(Value::as_u64)
                                .unwrap_or(0)
                                == 0
                            && state.pending_prompts.is_empty()
                            && !state.abort_pending
                            && !state.compacting
                            && let Some(turn) = state.turn.clone()
                        {
                            let settled = state
                                .settled
                                .take()
                                .unwrap_or_else(|| json!({"type":"agent_settled"}));
                            let stats_id = client.next_id();
                            if let Ok(stats) = client
                                .conn
                                .call(
                                    stats_id.clone(),
                                    &json!({"type":"get_session_stats","id":stats_id}),
                                    Duration::from_secs(2),
                                )
                                .await
                                && let Some(event) = state.translator.stats_usage(&stats, &turn)
                            {
                                let _ = tx.send(event);
                            }
                            let events = state.translator.translate(&settled, &turn);
                            state.cancel_unread(&tx);
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
                    if record.get("type").and_then(Value::as_str) == Some("message_start")
                        && record.pointer("/message/role").and_then(Value::as_str) == Some("user")
                        && let Some(input_ids) = state.unread_steers.pop_front()
                    {
                        let _ = tx.send(EngineEvent::SteerUpdated {
                            turn_id: turn.clone(),
                            input_ids,
                            status: SteerStatus::Completed,
                        });
                    }
                    if record.get("type").and_then(Value::as_str) == Some("agent_start") {
                        state.saw_activity = true;
                        state.idle_probe = None;
                    }
                    if record.get("type").and_then(Value::as_str) == Some("compaction_start") {
                        state.idle_probe = None;
                        state.compacting = true;
                    }
                    if record.get("type").and_then(Value::as_str) == Some("agent_settled") {
                        state.settled = Some(record);
                        if state.pending_prompts.is_empty() && !state.abort_pending {
                            start_probe(&mut state, shared.clone(), client.clone(), tx.clone())
                                .await;
                        }
                        continue;
                    }
                    if record.get("type").and_then(Value::as_str) == Some("compaction_end") {
                        state.compacting = false;
                        if state.settled.is_some()
                            && state.pending_prompts.is_empty()
                            && !state.abort_pending
                        {
                            start_probe(&mut state, shared.clone(), client.clone(), tx.clone())
                                .await;
                        }
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
                                    state.cancel_unread(&tx);
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
                                state.cancel_unread(&tx);
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
                            state.cancel_unread(&tx);
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
            spec.launch().map(|l| l.args.as_slice()).unwrap_or(&[]),
            self.profile.name(),
        )
        .map_err(EngineError::StartFailed)?;
        let binary = spec
            .launch()
            .and_then(|l| l.binary.clone())
            .unwrap_or_else(|| self.binary.clone());
        let mut launch = base_launch(binary, self.profile);
        launch.cwd = Some(PathBuf::from(&spec.engine.cwd));
        if let Some(config) = spec.launch() {
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
        let process = Arc::new(Mutex::new(process));
        let (tx, rx) = mpsc::unbounded_channel();
        let shared = Arc::new(Mutex::new(Shared {
            session_file: engine_ref.clone(),
            turn: None,
            last_turn: None,
            unowned: false,
            requests: HashMap::new(),
            approvals: HashSet::new(),
            custom: CustomAnswers::default(),
            pending_prompts: HashMap::new(),
            steer_inputs: HashMap::new(),
            unread_steers: VecDeque::new(),
            idle_probe: None,
            probe_attempt: 0,
            probe_failed: false,
            process: process.clone(),
            settled: None,
            saw_activity: false,
            command_candidate: false,
            compacting: false,
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
            process,
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
        super::probe::probe(&self.binary, self.profile, &Default::default()).await
    }

    /// Probe one provider instance with its own binary and environment (the host probes every
    /// instance this way), so a non-default instance's install and sign-in are what it reports.
    async fn probe_instance(
        &self,
        target: &ProviderTarget,
    ) -> Result<ProviderProbeResult, EngineError> {
        let launch = target.launch.as_ref();
        let binary = launch
            .and_then(|l| l.binary.clone())
            .unwrap_or_else(|| self.binary.clone());
        let env = launch.map(|l| l.env.clone()).unwrap_or_default();
        super::probe::probe(&binary, self.profile, &env).await
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
        let raw_message = inputs
            .iter()
            .map(|i| i.text.as_str())
            .collect::<Vec<_>>()
            .join("\n\n");
        let compact = compact_command(&raw_message);
        let payload = if compact.is_some() {
            Ok((raw_message, Vec::new()))
        } else {
            prompt_payload(
                &inputs,
                &self.thread_id,
                &self.cwd,
                self.attachments.as_ref(),
            )
            .await
        };
        let (mut message, images) = match payload {
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
        let command_candidate = message.trim_start().starts_with('/');
        let mut preamble = self.preamble.lock().await;
        if compact.is_none()
            && let Some(prefix) = preamble.as_ref()
        {
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
            state.pending_prompts.insert(
                id.clone(),
                if compact.is_some() {
                    PendingPrompt::CompactStart
                } else {
                    PendingPrompt::Start
                },
            );
            state.idle_probe = None;
            state.settled = None;
            state.saw_activity = false;
            state.command_candidate = command_candidate;
            state.compacting = false;
            state.abort_pending = false;
            let request = match compact.clone() {
                Some(instructions) => compact_record(&id, instructions),
                None => {
                    json!({"id": id, "type":"prompt","message":message,"images":images,"streamingBehavior":"steer"})
                }
            };
            if let Err(error) = self.client.conn.send(&request).await {
                return TurnStartResult::Unknown {
                    reason: error.to_string(),
                };
            }
        }
        watch_start_ack(self.shared.clone(), self.events.clone(), id);
        if compact.is_none() {
            *preamble = None;
        }
        TurnStartResult::Accepted { turn_id: turn }
    }
    async fn steer(&self, turn_id: &str, inputs: Vec<EngineInput>) -> SteerResult {
        let _guard = self.command_lock.lock().await;
        let raw_message = inputs
            .iter()
            .map(|i| i.text.as_str())
            .collect::<Vec<_>>()
            .join("\n\n");
        let compact = compact_command(&raw_message);
        let payload = if compact.is_some() {
            Ok((raw_message, Vec::new()))
        } else {
            prompt_payload(
                &inputs,
                &self.thread_id,
                &self.cwd,
                self.attachments.as_ref(),
            )
            .await
        };
        let (message, images) = match payload {
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
        state.steer_inputs.insert(
            id.clone(),
            inputs.iter().map(|input| input.input_id.clone()).collect(),
        );
        state.idle_probe = None;
        state.pending_prompts.insert(
            id.clone(),
            if compact.is_some() {
                PendingPrompt::CompactSteer(ack_tx)
            } else {
                PendingPrompt::Steer(ack_tx)
            },
        );
        let request = match compact {
            Some(instructions) => compact_record(&id, instructions),
            None => {
                json!({"id":id,"type":"prompt","message":message,"images":images,"streamingBehavior":"steer"})
            }
        };
        let sent = self.client.conn.send(&request).await;
        drop(state);
        drop(_guard);
        if let Err(e) = sent {
            finish_uncertain_steer(&self.shared, &self.client, &self.events, &id).await;
            return SteerResult::Unknown {
                reason: e.to_string(),
            };
        }
        wait_steer(
            &self.shared,
            &self.client,
            &self.events,
            &id,
            ack_rx,
            TIMEOUT,
        )
        .await
    }
    async fn interrupt(&self, turn_id: &str) -> Result<(), EngineError> {
        let _guard = self.command_lock.lock().await;
        {
            let mut state = self.shared.lock().await;
            if state.turn.as_deref() != Some(turn_id) {
                return Err(EngineError::Transport("Pi turn is not active".into()));
            }
            state.translator.interrupt();
            if state.compacting
                || state.pending_prompts.values().any(|pending| {
                    matches!(
                        pending,
                        PendingPrompt::CompactStart | PendingPrompt::CompactSteer(_)
                    )
                })
            {
                state.probe_failed = true;
                state.pending_prompts.clear();
                state.requests.clear();
                state.custom.clear();
                state.cancel_unread(&self.events);
                state.turn = None;
                let events = state
                    .translator
                    .translate(&json!({"type":"agent_settled"}), turn_id);
                let process = state.process.clone();
                drop(state);
                for event in events {
                    let _ = self.events.send(event);
                }
                let _ = self.events.send(EngineEvent::Exited {
                    reason: "Pi stopped during compaction".into(),
                });
                process.lock().await.kill_group();
                return Ok(());
            }
            state.abort_pending = true;
            state.idle_probe = None;
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
        state.idle_probe = None;
        state.pending_prompts.clear();
        state.requests.clear();
        state.custom.clear();
        drop(state);
        self.client.conn.close_input().await;
        self.process.lock().await.shutdown().await;
    }
}
async fn finish_uncertain_steer(
    shared: &Arc<Mutex<Shared>>,
    client: &Arc<Client>,
    tx: &mpsc::UnboundedSender<EngineEvent>,
    id: &str,
) {
    let mut state = shared.lock().await;
    let Some(pending) = state.pending_prompts.remove(id) else {
        return;
    };
    state.steer_inputs.remove(id);
    if matches!(pending, PendingPrompt::CompactSteer(_)) {
        state.probe_failed = true;
        state.pending_prompts.clear();
        state.cancel_unread(tx);
        let process = state.process.clone();
        drop(state);
        let _ = tx.send(EngineEvent::Exited {
            reason: "Pi did not acknowledge compact; delivery is unknown".into(),
        });
        process.lock().await.kill_group();
        return;
    }
    if state.settled.is_some()
        && state.pending_prompts.is_empty()
        && !state.abort_pending
        && state.turn.is_some()
    {
        start_probe(&mut state, shared.clone(), client.clone(), tx.clone()).await;
    }
}
async fn wait_steer(
    shared: &Arc<Mutex<Shared>>,
    client: &Arc<Client>,
    tx: &mpsc::UnboundedSender<EngineEvent>,
    id: &str,
    mut ack: oneshot::Receiver<Result<(), String>>,
    timeout: Duration,
) -> SteerResult {
    loop {
        return match tokio::time::timeout(timeout, &mut ack).await {
            Ok(Ok(Ok(()))) => SteerResult::Accepted,
            Ok(Ok(Err(reason))) => SteerResult::Declined { reason },
            Err(_)
                if {
                    let state = shared.lock().await;
                    matches!(
                        state.pending_prompts.get(id),
                        Some(PendingPrompt::CompactSteer(_))
                    ) && !state.requests.is_empty()
                } =>
            {
                continue;
            }
            _ => {
                finish_uncertain_steer(shared, client, tx, id).await;
                SteerResult::Unknown {
                    reason: "Pi did not acknowledge the steer".into(),
                }
            }
        };
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
            start_probe(
                &mut state,
                self.shared.clone(),
                self.client.clone(),
                self.events.clone(),
            )
            .await;
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
        {
            let mut state = self.shared.lock().await;
            if changed_session(&state, &live) {
                state.probe_failed = true;
                state.pending_prompts.clear();
                state.requests.clear();
                state.cancel_unread(&self.events);
                let process = state.process.clone();
                drop(state);
                let _ = self.events.send(EngineEvent::Exited {
                    reason: "Pi session file changed; cannot safely resume this session".into(),
                });
                process.lock().await.kill_group();
                return Err(EngineError::Transport(
                    "Pi session file changed; cannot safely resume this session".into(),
                ));
            }
        }
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
        let reported_model = if model_changed && let Some((provider, id)) = selected {
            self.client
                .call(json!({"type":"set_model","provider":provider,"modelId":id}))
                .await
                .map_err(err)?
        } else {
            live["model"].clone()
        };
        self.shared
            .lock()
            .await
            .translator
            .set_model(&reported_model);
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

    #[tokio::test]
    async fn failed_settlement_probe_retries_then_finishes() {
        let (session, mut outbound) = test_session();
        let (in_tx, in_rx) = mpsc::unbounded_channel();
        let (event_tx, mut events) = mpsc::unbounded_channel();
        let task = tokio::spawn(pump(
            in_rx,
            session.shared.clone(),
            event_tx,
            session.client.clone(),
        ));
        in_tx
            .send(Inbound::Record(json!({"type":"agent_settled"})))
            .unwrap();
        let Inbound::Record(first) = outbound.recv().await.unwrap() else {
            panic!("expected probe")
        };
        tokio::time::pause();
        let (barrier_tx, barrier_rx) = oneshot::channel();
        session
            .shared
            .lock()
            .await
            .barriers
            .insert("sync".into(), barrier_tx);
        in_tx
            .send(Inbound::Record(
                json!({"type":"response","id":first["id"],"success":false,"error":"unavailable"}),
            ))
            .unwrap();
        in_tx
            .send(Inbound::Record(
                json!({"type":"response","id":"sync","success":true,"data":{"isStreaming":false}}),
            ))
            .unwrap();
        barrier_rx.await.unwrap();
        tokio::time::advance(PROBE_RETRY_DELAY).await;
        tokio::time::resume();
        let Inbound::Record(retry) = tokio::time::timeout(Duration::from_secs(3), outbound.recv())
            .await
            .expect("retry required")
            .unwrap()
        else {
            panic!("expected retry")
        };
        assert_eq!(retry["type"], "get_state");
        in_tx.send(Inbound::Record(json!({"type":"response","id":retry["id"],"success":true,"data":{"isStreaming":false,"isCompacting":false,"pendingMessageCount":0}}))).unwrap();
        loop {
            match events.recv().await.expect("event") {
                EngineEvent::TurnFinished { .. } => break,
                EngineEvent::Exited { reason } => panic!("unexpected exit: {reason}"),
                _ => {}
            }
        }
        drop(in_tx);
        task.await.unwrap();
        session.shutdown().await;
    }

    #[tokio::test]
    async fn settlement_probe_exhaustion_exits_and_terminates_process() {
        let (session, mut outbound) = test_session();
        let (in_tx, in_rx) = mpsc::unbounded_channel();
        let (event_tx, mut events) = mpsc::unbounded_channel();
        let task = tokio::spawn(pump(
            in_rx,
            session.shared.clone(),
            event_tx,
            session.client.clone(),
        ));
        in_tx
            .send(Inbound::Record(json!({"type":"agent_settled"})))
            .unwrap();
        for attempt in 0..3 {
            let Inbound::Record(probe) = outbound.recv().await.unwrap() else {
                panic!("expected probe {attempt}")
            };
            tokio::time::pause();
            let (barrier_tx, barrier_rx) = oneshot::channel();
            session
                .shared
                .lock()
                .await
                .barriers
                .insert("sync".into(), barrier_tx);
            in_tx
                .send(Inbound::Record(
                    json!({"type":"response","id":probe["id"],"success":false}),
                ))
                .unwrap();
            in_tx.send(Inbound::Record(json!({"type":"response","id":"sync","success":true,"data":{"isStreaming":false}}))).unwrap();
            barrier_rx.await.unwrap();
            tokio::time::advance(PROBE_RETRY_DELAY).await;
            tokio::time::resume();
        }
        assert!(
            matches!(events.recv().await, Some(EngineEvent::Exited { reason }) if reason.contains("settlement state check failed"))
        );
        assert!(matches!(outbound.recv().await, Some(Inbound::Closed(_))));
        drop(in_tx);
        task.await.unwrap();
        session.shutdown().await;
    }

    #[tokio::test]
    async fn lost_settlement_probe_retries_after_timeout() {
        let (session, mut outbound) = test_session();
        let (in_tx, in_rx) = mpsc::unbounded_channel();
        let (event_tx, mut events) = mpsc::unbounded_channel();
        let task = tokio::spawn(pump(
            in_rx,
            session.shared.clone(),
            event_tx,
            session.client.clone(),
        ));
        in_tx
            .send(Inbound::Record(json!({"type":"agent_settled"})))
            .unwrap();
        let Inbound::Record(first) = outbound.recv().await.unwrap() else {
            panic!("expected probe")
        };
        tokio::time::pause();
        tokio::time::advance(PROBE_TIMEOUT).await;
        tokio::time::advance(PROBE_RETRY_DELAY).await;
        tokio::time::resume();
        let Inbound::Record(retry) = outbound.recv().await.unwrap() else {
            panic!("expected retry")
        };
        assert_ne!(first["id"], retry["id"]);
        in_tx.send(Inbound::Record(json!({"type":"response","id":retry["id"],"success":true,"data":{"isStreaming":false,"isCompacting":false}}))).unwrap();
        loop {
            match events.recv().await.expect("event") {
                EngineEvent::TurnFinished { .. } => break,
                EngineEvent::Exited { reason } => panic!("unexpected exit: {reason}"),
                _ => {}
            }
        }
        drop(in_tx);
        task.await.unwrap();
        session.shutdown().await;
    }

    #[tokio::test(start_paused = true)]
    async fn settlement_probe_send_failure_is_visible() {
        let (session, _) = test_session();
        session.client.conn.close_input().await;
        let (in_tx, in_rx) = mpsc::unbounded_channel();
        let (event_tx, mut events) = mpsc::unbounded_channel();
        let task = tokio::spawn(pump(
            in_rx,
            session.shared.clone(),
            event_tx,
            session.client.clone(),
        ));
        in_tx
            .send(Inbound::Record(json!({"type":"agent_settled"})))
            .unwrap();
        assert!(
            matches!(events.recv().await, Some(EngineEvent::Exited { reason }) if reason.contains("settlement state check failed"))
        );
        drop(in_tx);
        task.await.unwrap();
        session.shutdown().await;
    }

    #[tokio::test]
    async fn admission_barrier_rejects_pending_messages() {
        let (session, _) = test_session();
        let (in_tx, in_rx) = mpsc::unbounded_channel();
        let (event_tx, _) = mpsc::unbounded_channel();
        let task = tokio::spawn(pump(
            in_rx,
            session.shared.clone(),
            event_tx,
            session.client.clone(),
        ));
        let (barrier_tx, barrier_rx) = oneshot::channel();
        session
            .shared
            .lock()
            .await
            .barriers
            .insert("barrier".into(), barrier_tx);
        in_tx.send(Inbound::Record(json!({"type":"response","id":"barrier","success":true,"data":{"isStreaming":false,"isCompacting":false,"pendingMessageCount":1}}))).unwrap();
        assert!(!barrier_rx.await.unwrap());
        drop(in_tx);
        task.await.unwrap();
        session.shutdown().await;
    }

    #[tokio::test]
    async fn busy_probe_waits_and_new_activity_invalidates_retry() {
        for activity in [false, true] {
            let (session, mut outbound) = test_session();
            let (in_tx, in_rx) = mpsc::unbounded_channel();
            let (event_tx, _) = mpsc::unbounded_channel();
            let task = tokio::spawn(pump(
                in_rx,
                session.shared.clone(),
                event_tx,
                session.client.clone(),
            ));
            in_tx
                .send(Inbound::Record(json!({"type":"agent_settled"})))
                .unwrap();
            let Inbound::Record(probe) = outbound.recv().await.unwrap() else {
                panic!("expected probe")
            };
            tokio::time::pause();
            let (barrier_tx, barrier_rx) = oneshot::channel();
            session
                .shared
                .lock()
                .await
                .barriers
                .insert("sync".into(), barrier_tx);
            in_tx.send(Inbound::Record(if activity {
                json!({"type":"response","id":probe["id"],"success":false})
            } else {
                json!({"type":"response","id":probe["id"],"success":true,"data":{"isStreaming":true}})
            })).unwrap();
            if activity {
                in_tx
                    .send(Inbound::Record(json!({"type":"agent_start"})))
                    .unwrap();
            }
            in_tx.send(Inbound::Record(json!({"type":"response","id":"sync","success":true,"data":{"isStreaming":false}}))).unwrap();
            barrier_rx.await.unwrap();
            tokio::time::advance(Duration::from_secs(10)).await;
            assert!(session.shared.lock().await.idle_probe.is_none());
            assert!(outbound.try_recv().is_err());
            tokio::time::resume();
            drop(in_tx);
            task.await.unwrap();
            session.shutdown().await;
        }
    }

    fn test_session() -> (PiSession, mpsc::UnboundedReceiver<Inbound>) {
        let (child, client, outbound) = spawn(&Launch::new("/bin/cat")).unwrap();
        let pgid = child.pid();
        let child = Arc::new(Mutex::new(child));
        let mut translator =
            Translator::new(ThreadId::from("test"), "engine".into(), "pi", "test".into());
        translator.translate(
            &json!({"type":"extension_ui_request","id":"request","method":"select","title":"Pick"}),
            "turn",
        );
        let state = Shared {
            session_file: "/tmp/test".into(),
            turn: Some("turn".into()),
            last_turn: None,
            unowned: false,
            requests: HashMap::new(),
            approvals: HashSet::new(),
            custom: CustomAnswers::default(),
            pending_prompts: HashMap::new(),
            steer_inputs: HashMap::new(),
            unread_steers: VecDeque::new(),
            idle_probe: None,
            probe_attempt: 0,
            probe_failed: false,
            process: child.clone(),
            settled: None,
            saw_activity: true,
            command_candidate: false,
            compacting: false,
            abort_pending: false,
            barriers: HashMap::new(),
            translator,
        };
        let (events, _) = mpsc::unbounded_channel();
        (
            PiSession {
                client,
                process: child,
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
        let (child, client, mut outbound) = spawn(&launch).unwrap();
        let child = Arc::new(Mutex::new(child));
        let (probe_tx, _) = mpsc::unbounded_channel();
        let (ack_tx, ack_rx) = oneshot::channel();
        let shared = Arc::new(Mutex::new(Shared {
            session_file: "/tmp/test".into(),
            turn: Some("turn".into()),
            last_turn: None,
            unowned: false,
            requests: HashMap::new(),
            approvals: HashSet::new(),
            custom: CustomAnswers::default(),
            pending_prompts: HashMap::from([("steer".into(), PendingPrompt::Steer(ack_tx))]),
            steer_inputs: HashMap::new(),
            unread_steers: VecDeque::new(),
            idle_probe: None,
            probe_attempt: 0,
            probe_failed: false,
            process: child.clone(),
            settled: Some(json!({"type":"agent_settled"})),
            saw_activity: true,
            command_candidate: false,
            compacting: false,
            abort_pending: false,
            barriers: HashMap::new(),
            translator: Translator::new(
                ThreadId::from("test"),
                "engine".into(),
                "pi",
                "test".into(),
            ),
        }));
        let outcome =
            wait_steer(&shared, &client, &probe_tx, "steer", ack_rx, Duration::ZERO).await;
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
        child.lock().await.shutdown().await;
    }

    #[tokio::test(start_paused = true)]
    async fn missing_start_ack_exits_after_bounded_wait() {
        let (session, _inbound) = test_session();
        let (tx, mut rx) = mpsc::unbounded_channel();
        session
            .shared
            .lock()
            .await
            .pending_prompts
            .insert("start".into(), PendingPrompt::Start);
        watch_start_ack(session.shared.clone(), tx, "start".into());
        tokio::time::advance(TIMEOUT).await;
        tokio::task::yield_now().await;
        assert!(
            matches!(rx.try_recv(), Ok(EngineEvent::Exited { reason }) if reason.contains("delivery is unknown"))
        );
        session.shutdown().await;
    }

    #[tokio::test(start_paused = true)]
    async fn start_ack_watch_preserves_open_dialog_and_ignores_late_timer_after_ack() {
        let (session, _inbound) = test_session();
        let (tx, mut rx) = mpsc::unbounded_channel();
        {
            let mut state = session.shared.lock().await;
            state
                .pending_prompts
                .insert("start".into(), PendingPrompt::Start);
            state.requests.insert(
                "dialog".into(),
                UiRequest {
                    method: "input".into(),
                    approval_key: (String::new(), String::new()),
                    token: "token".into(),
                    deadline: None,
                    expiry: None,
                    route: None,
                },
            );
        }
        watch_start_ack(session.shared.clone(), tx, "start".into());
        tokio::time::advance(TIMEOUT).await;
        tokio::task::yield_now().await;
        assert!(rx.try_recv().is_err());
        {
            let mut state = session.shared.lock().await;
            state.requests.clear();
            state.pending_prompts.remove("start");
        }
        tokio::time::advance(TIMEOUT).await;
        tokio::task::yield_now().await;
        assert!(rx.try_recv().is_err());
        session.shutdown().await;
    }
}
