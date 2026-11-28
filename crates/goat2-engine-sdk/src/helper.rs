//! Driver over `apps/engine-helper`: one Node helper process per thread (own process group,
//! `nice` +10), spoken to with the JSONL shape in `apps/engine-helper/PROTOCOL.md`.

use std::collections::VecDeque;
use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use goat2_contracts::{
    ChatAttachment, EngineDriver, EngineItemLocator, EngineRef, InputId, ItemId,
    ProviderCapabilities, ProviderProbeResult, RequestKind, ServerProviderState, ThreadId,
    TurnItem,
};
use goat2_engine_api::{
    EngineError, EngineEvent, EngineFactory, EngineHandle, EngineInput, EngineSession,
    RequestAnswer, SessionSpec, SteerResult, SteerStatus, TurnOutcome, TurnSettings,
    TurnStartResult,
};
use serde_json::{Map, Value, json};
use tokio::sync::mpsc;

use crate::jsonl::{CallError, Connection, Dialect, Inbound, RemoteError};
use crate::process::{ChildProcess, Launch, group_rss_bytes_of};

const PROTOCOL_VERSION: u64 = 1;
/// Starting an engine can include starting its own server (OpenCode) or loading a large SDK.
const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(90);
const CALL_TIMEOUT: Duration = Duration::from_secs(60);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);
const PROBE_TIMEOUT: Duration = Duration::from_secs(30);
const LOG_TAIL_LINES: usize = 200;

/// The engines the helper runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum HelperEngine {
    Cursor,
    Opencode,
    Muse,
    /// The scripted test engine (`apps/engine-helper/src/engines/fake.ts`).
    Fake,
}

impl HelperEngine {
    pub fn wire_name(self) -> &'static str {
        match self {
            Self::Cursor => "cursor",
            Self::Opencode => "opencode",
            Self::Muse => "muse",
            Self::Fake => "fake",
        }
    }

    /// The helper engine for a driver kind, if the helper runs it.
    pub fn for_driver(driver: &EngineDriver) -> Option<Self> {
        match driver {
            EngineDriver::Cursor => Some(Self::Cursor),
            EngineDriver::Opencode => Some(Self::Opencode),
            EngineDriver::Muse => Some(Self::Muse),
            _ => None,
        }
    }
}

/// How to start the helper: a Node binary and the helper's entry file.
#[derive(Debug, Clone)]
pub struct HelperLaunch {
    pub node: PathBuf,
    pub entry: PathBuf,
    /// Extra variables for the helper process (test fakes, `NODE_OPTIONS`).
    pub env: Vec<(OsString, OsString)>,
}

impl HelperLaunch {
    pub fn new(node: impl Into<PathBuf>, entry: impl Into<PathBuf>) -> Self {
        Self {
            node: node.into(),
            entry: entry.into(),
            env: Vec::new(),
        }
    }

    /// `GOAT2_ENGINE_HELPER_ENTRY` (required) and `GOAT2_ENGINE_HELPER_NODE` (default `node`),
    /// as lane G's app bundle sets them. `GOAT2_ENGINE_HELPER_RUN_AS_NODE=1` (the Dev app uses its
    /// Electron binary as Node) sets `ELECTRON_RUN_AS_NODE=1` on the helper child only; the host's
    /// own env never carries it, so Electron apps that agents launch keep working.
    pub fn from_env() -> Option<Self> {
        let entry = std::env::var_os("GOAT2_ENGINE_HELPER_ENTRY")?;
        let node = std::env::var_os("GOAT2_ENGINE_HELPER_NODE").unwrap_or_else(|| "node".into());
        let mut launch = Self::new(node, entry);
        if std::env::var_os("GOAT2_ENGINE_HELPER_RUN_AS_NODE").is_some_and(|value| value == "1") {
            launch = launch.with_env("ELECTRON_RUN_AS_NODE", "1");
        }
        Some(launch)
    }

    pub fn with_env(mut self, name: impl Into<OsString>, value: impl Into<OsString>) -> Self {
        self.env.push((name.into(), value.into()));
        self
    }
}

/// [EngineFactory] for one helper engine.
pub struct HelperFactory {
    engine: HelperEngine,
    driver: EngineDriver,
    launch: HelperLaunch,
    attachments: Option<AttachmentResolver>,
    /// Capabilities the engine reported from its last successful probe (v1 OpenCode: the selected
    /// generation's flags, driver.ts "Hot reads use the last successful probe"). None = static.
    probed_capabilities: Arc<std::sync::Mutex<Option<ProviderCapabilities>>>,
}

/// Finds the saved file of an attachment; the host knows the thread folder (same shape as lane
/// B's `goat2-engine-codex` resolver, v1 `resolveAttachmentPath`). `None` = not found.
pub type AttachmentResolver =
    Arc<dyn Fn(&ThreadId, &ChatAttachment) -> Option<PathBuf> + Send + Sync>;

impl HelperFactory {
    /// A factory for a real engine; `None` when the helper does not run this driver.
    pub fn new(driver: EngineDriver, launch: HelperLaunch) -> Option<Self> {
        let engine = HelperEngine::for_driver(&driver)?;
        Some(Self {
            engine,
            driver,
            launch,
            attachments: None,
            probed_capabilities: Arc::default(),
        })
    }

    /// The scripted fake engine, reporting as `driver` (tests).
    pub fn fake(driver: EngineDriver, launch: HelperLaunch) -> Self {
        Self {
            engine: HelperEngine::Fake,
            driver,
            launch,
            attachments: None,
            probed_capabilities: Arc::default(),
        }
    }

    /// Resolve attachment files so the helper gets an absolute `path` for each one it can find.
    pub fn with_attachment_resolver(mut self, resolver: AttachmentResolver) -> Self {
        self.attachments = Some(resolver);
        self
    }

    /// Start a helper process with its stdio connected.
    fn spawn(&self, cwd: Option<PathBuf>) -> Result<Spawned, EngineError> {
        let mut launch = Launch::new(&self.launch.node)
            .arg(&self.launch.entry)
            .without_host_identity();
        launch.cwd = cwd;
        launch.env_set.extend(self.launch.env.iter().cloned());
        let mut process = ChildProcess::spawn(&launch).map_err(|error| {
            EngineError::Unavailable(format!(
                "engine helper could not start ({}): {error}",
                self.launch.node.display()
            ))
        })?;
        let (Some(stdin), Some(stdout)) = (process.take_stdin(), process.take_stdout()) else {
            process.kill_group();
            return Err(EngineError::StartFailed(
                "engine helper has no stdio".into(),
            ));
        };
        let (connection, inbound) = Connection::start(stdin, stdout, HelperDialect);
        let client = Client {
            connection,
            next_id: AtomicU64::new(1),
        };
        Ok((process, client, inbound))
    }

    fn initialize_params(&self, spec: &SessionSpec) -> Value {
        let resume = spec
            .resume
            .as_ref()
            .filter(|reference| reference.driver == self.driver)
            .map(|reference| reference.id.clone());
        let instructions = spec.instructions.as_ref().map(|instructions| {
            json!({
                "appendSystemPrompt": instructions.append_system_prompt,
                "firstMessagePreamble": instructions.first_message_preamble,
            })
        });
        let launch = spec.launch.as_ref().map(|launch| {
            json!({
                "binary": launch.binary.as_ref().map(|path| path.to_string_lossy().into_owned()),
                "args": launch.args,
                "env": launch.env,
            })
        });
        json!({
            "protocol": PROTOCOL_VERSION,
            "engine": self.engine.wire_name(),
            "threadId": spec.thread_id,
            "cwd": spec.engine.cwd,
            "resume": resume,
            "modelSelection": spec.engine.model_selection,
            "runtimeMode": spec.engine.runtime_mode,
            "mcp": { "url": spec.mcp.url, "bearerToken": spec.mcp.bearer_token },
            "instructions": instructions,
            "launch": launch,
        })
    }
}

#[async_trait]
impl EngineFactory for HelperFactory {
    async fn start(&self, spec: SessionSpec) -> Result<EngineHandle, EngineError> {
        let (mut process, client, inbound) = self.spawn(Some(PathBuf::from(&spec.engine.cwd)))?;
        let pgid = process.pid();
        let params = self.initialize_params(&spec);
        let engine_ref = match client.call("initialize", params, INITIALIZE_TIMEOUT).await {
            Ok(result) => match result.get("engineRef").and_then(Value::as_str) {
                Some(id) if !id.is_empty() => id.to_string(),
                _ => {
                    process.shutdown().await;
                    return Err(EngineError::StartFailed(
                        "engine helper answered initialize without engineRef".into(),
                    ));
                }
            },
            Err(error) => {
                let tail = process.stderr_tail();
                process.shutdown().await;
                return Err(start_error(error, &tail));
            }
        };
        let (events_tx, events) = mpsc::unbounded_channel();
        let logs = Arc::new(Mutex::new(VecDeque::new()));
        let translator = Translator {
            thread_id: spec.thread_id.clone(),
            engine_ref: engine_ref.clone(),
            ordinal: AtomicU32::new(0),
            logs: Arc::clone(&logs),
        };
        tokio::spawn(translator.run(inbound, events_tx));
        let session = HelperSession {
            thread_id: spec.thread_id.clone(),
            attachments: self.attachments.clone(),
            client,
            process: tokio::sync::Mutex::new(process),
            pgid,
            logs,
        };
        Ok(EngineHandle {
            session: Box::new(session),
            events,
            engine_ref: EngineRef {
                driver: self.driver.clone(),
                id: engine_ref,
            },
        })
    }

    fn capabilities(&self) -> ProviderCapabilities {
        if let Some(probed) = self
            .probed_capabilities
            .lock()
            .ok()
            .and_then(|probed| probed.clone())
        {
            return probed;
        }
        crate::capabilities::for_driver(&self.driver)
            .or_else(|| crate::capabilities::for_driver(&EngineDriver::Cursor))
            .expect("cursor capabilities exist")
    }

    /// One short-lived helper answers `probe` (the engine's own install, version, sign-in and
    /// model checks) and exits. A `capabilities` field next to the probe result replaces the
    /// static capabilities until the next successful probe says otherwise.
    async fn probe(&self) -> Result<ProviderProbeResult, EngineError> {
        let (mut process, client, _inbound) = self.spawn(None)?;
        let params = json!({
            "protocol": PROTOCOL_VERSION,
            "engine": self.engine.wire_name(),
            "cwd": Value::Null,
            "launch": Value::Null,
        });
        let answer = client.call("probe", params, PROBE_TIMEOUT).await;
        let _ = client.call("shutdown", json!({}), SHUTDOWN_TIMEOUT).await;
        client.connection.close_input().await;
        let tail = process.stderr_tail();
        process.shutdown().await;
        match answer {
            Ok(mut value) => {
                let reported = value
                    .as_object_mut()
                    .and_then(|map| map.remove("capabilities"))
                    .filter(|capabilities| !capabilities.is_null());
                let result: ProviderProbeResult =
                    serde_json::from_value(value).map_err(|error| {
                        EngineError::Transport(format!("invalid probe result: {error}"))
                    })?;
                let reported = match reported {
                    Some(raw) => Some(
                        serde_json::from_value::<ProviderCapabilities>(raw).map_err(|error| {
                            EngineError::Transport(format!("invalid probe capabilities: {error}"))
                        })?,
                    ),
                    None => None,
                };
                // Only a successful probe (ready or warning) changes what the factory reports; an
                // error or disabled answer keeps the last successful one (v1 OpenCode driver.ts).
                let succeeded = matches!(
                    result.status,
                    ServerProviderState::Ready | ServerProviderState::Warning
                );
                if succeeded && let Ok(mut probed) = self.probed_capabilities.lock() {
                    *probed = reported;
                }
                Ok(result)
            }
            Err(CallError::Remote(RemoteError { code, message }))
                if code.as_deref() == Some("unavailable") =>
            {
                Err(EngineError::Unavailable(message))
            }
            Err(error) => Err(start_error(error, &tail)),
        }
    }
}

type Spawned = (ChildProcess, Client, mpsc::UnboundedReceiver<Inbound>);

fn start_error(error: CallError, stderr_tail: &str) -> EngineError {
    match error {
        CallError::Remote(RemoteError { code, message }) => match code.as_deref() {
            Some("unavailable") => EngineError::Unavailable(message),
            _ => EngineError::StartFailed(message),
        },
        CallError::Transport(reason) => {
            // The helper died before answering: usually Node missing a module or a bad entry path.
            // Only the last line is kept; stderr can carry prompts or tokens.
            let last = stderr_tail
                .lines()
                .rev()
                .find(|line| !line.trim().is_empty())
                .map(|line| line.chars().take(300).collect::<String>())
                .unwrap_or_default();
            EngineError::StartFailed(if last.is_empty() {
                reason
            } else {
                format!("{reason}: {last}")
            })
        }
        CallError::Timeout(after) => {
            EngineError::StartFailed(format!("engine did not start within {after:?}"))
        }
    }
}

/// Helper responses: `{id: number, result}` or `{id: number, error: {code, message}}`.
struct HelperDialect;

impl Dialect for HelperDialect {
    fn response(&self, record: &Value) -> Option<(String, Result<Value, RemoteError>)> {
        let id = record.get("id")?.as_u64()?;
        if let Some(result) = record.get("result") {
            return Some((id.to_string(), Ok(result.clone())));
        }
        let error = record.get("error")?;
        Some((
            id.to_string(),
            Err(RemoteError {
                code: error
                    .get("code")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                message: error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("engine helper error")
                    .to_string(),
            }),
        ))
    }
}

struct Client {
    connection: Arc<Connection>,
    next_id: AtomicU64,
}

impl Client {
    async fn call(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, CallError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let frame = json!({ "id": id, "method": method, "params": params });
        self.connection.call(id.to_string(), &frame, timeout).await
    }
}

struct HelperSession {
    thread_id: ThreadId,
    attachments: Option<AttachmentResolver>,
    client: Client,
    process: tokio::sync::Mutex<ChildProcess>,
    pgid: u32,
    logs: Arc<Mutex<VecDeque<String>>>,
}

impl HelperSession {
    /// The helper's recent `log` lines (diagnostics only).
    #[allow(dead_code)]
    fn recent_logs(&self) -> Vec<String> {
        self.logs
            .lock()
            .map(|logs| logs.iter().cloned().collect())
            .unwrap_or_default()
    }
}

/// Inputs as the helper reads them: each attachment gains `path` (absolute, or null when the
/// file cannot be found).
fn inputs_json(
    inputs: &[EngineInput],
    thread: &ThreadId,
    resolver: Option<&AttachmentResolver>,
) -> Value {
    Value::Array(
        inputs
            .iter()
            .map(|input| {
                let attachments: Vec<Value> = input
                    .attachments
                    .iter()
                    .map(|attachment| {
                        let mut value = serde_json::to_value(attachment).unwrap_or(Value::Null);
                        let path = resolver
                            .and_then(|resolve| resolve(thread, attachment))
                            .map(|path| path.to_string_lossy().into_owned());
                        if let Value::Object(map) = &mut value {
                            map.insert("path".into(), json!(path));
                        }
                        value
                    })
                    .collect();
                json!({
                    "inputId": input.input_id,
                    "text": input.text,
                    "attachments": attachments,
                })
            })
            .collect(),
    )
}

fn settings_json(settings: &TurnSettings) -> Value {
    json!({
        "modelSelection": settings.model_selection,
        "runtimeMode": settings.runtime_mode,
    })
}

/// Map a `turn.start` / `turn.continue` answer. A request the helper rejected outright never
/// reached the engine (Declined); a transport failure may have (Unknown).
fn turn_start_result(answer: Result<Value, CallError>) -> TurnStartResult {
    match answer {
        Ok(result) => match status_reason(&result) {
            (status, _) if status == "accepted" => {
                match result.get("turnId").and_then(Value::as_str) {
                    Some(turn_id) => TurnStartResult::Accepted {
                        turn_id: turn_id.to_string(),
                    },
                    None => TurnStartResult::Unknown {
                        reason: "engine accepted the turn without a turn id".into(),
                    },
                }
            }
            (status, reason) if status == "declined" => TurnStartResult::Declined { reason },
            (status, reason) if status == "refused_unowned" => {
                TurnStartResult::RefusedUnowned { reason }
            }
            (_, reason) => TurnStartResult::Unknown { reason },
        },
        Err(CallError::Remote(remote)) => TurnStartResult::Declined {
            reason: remote.message,
        },
        Err(error) => TurnStartResult::Unknown {
            reason: error.to_string(),
        },
    }
}

fn request_kind(kind: &str) -> Result<RequestKind, String> {
    match kind {
        "approval" => Ok(RequestKind::Approval),
        "question" => Ok(RequestKind::Question),
        "signin" => Ok(RequestKind::Signin),
        other => Err(format!("unknown request kind {other}")),
    }
}

fn status_reason(result: &Value) -> (String, String) {
    let status = result
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let reason = result
        .get("reason")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    (status, reason)
}

fn transport_error(error: CallError) -> EngineError {
    match error {
        CallError::Remote(remote) => EngineError::Transport(remote.message),
        other => EngineError::Transport(other.to_string()),
    }
}

#[async_trait]
impl EngineSession for HelperSession {
    async fn start_turn(
        &self,
        inputs: Vec<EngineInput>,
        settings: &TurnSettings,
    ) -> TurnStartResult {
        let params = json!({ "inputs": inputs_json(&inputs, &self.thread_id, self.attachments.as_ref()), "settings": settings_json(settings) });
        turn_start_result(self.client.call("turn.start", params, CALL_TIMEOUT).await)
    }

    /// `turn.continue`: run a continuation the engine offered; declined when it no longer holds it.
    async fn start_continuation(
        &self,
        key: &str,
        inputs: Vec<EngineInput>,
        settings: &TurnSettings,
    ) -> TurnStartResult {
        let params = json!({ "key": key, "inputs": inputs_json(&inputs, &self.thread_id, self.attachments.as_ref()), "settings": settings_json(settings) });
        turn_start_result(
            self.client
                .call("turn.continue", params, CALL_TIMEOUT)
                .await,
        )
    }

    async fn steer(&self, turn_id: &str, inputs: Vec<EngineInput>) -> SteerResult {
        let params = json!({ "turnId": turn_id, "inputs": inputs_json(&inputs, &self.thread_id, self.attachments.as_ref()) });
        match self.client.call("turn.steer", params, CALL_TIMEOUT).await {
            Ok(result) => match status_reason(&result) {
                (status, _) if status == "accepted" => SteerResult::Accepted,
                (status, reason) if status == "declined" => SteerResult::Declined { reason },
                (status, reason) if status == "refused_unowned" => {
                    SteerResult::RefusedUnowned { reason }
                }
                (_, reason) => SteerResult::Unknown { reason },
            },
            Err(CallError::Remote(remote)) => SteerResult::Declined {
                reason: remote.message,
            },
            Err(error) => SteerResult::Unknown {
                reason: error.to_string(),
            },
        }
    }

    async fn interrupt(&self, turn_id: &str) -> Result<(), EngineError> {
        self.client
            .call("turn.interrupt", json!({ "turnId": turn_id }), CALL_TIMEOUT)
            .await
            .map(|_| ())
            .map_err(transport_error)
    }

    /// `session.set_config`: engines without an in-session switch answer `unsupported`.
    async fn set_config(&self, settings: &TurnSettings) -> Result<(), EngineError> {
        match self
            .client
            .call(
                "session.set_config",
                json!({ "settings": settings_json(settings) }),
                CALL_TIMEOUT,
            )
            .await
        {
            Ok(_) => Ok(()),
            Err(CallError::Remote(RemoteError { code, message }))
                if code.as_deref() == Some("unsupported") =>
            {
                Err(EngineError::Unsupported(message))
            }
            Err(error) => Err(transport_error(error)),
        }
    }

    async fn answer_request(&self, key: &str, answer: RequestAnswer) -> Result<(), EngineError> {
        let mut body = Map::new();
        body.insert(
            "outcome".into(),
            serde_json::to_value(answer.outcome).unwrap_or(Value::Null),
        );
        if let Some(text) = answer.text {
            body.insert("text".into(), Value::String(text));
        }
        if let Some(answers) = answer.answers {
            body.insert("answers".into(), Value::Object(answers));
        }
        self.client
            .call(
                "request.answer",
                json!({ "key": key, "answer": Value::Object(body) }),
                CALL_TIMEOUT,
            )
            .await
            .map(|_| ())
            .map_err(transport_error)
    }

    fn group_rss_bytes(&self) -> Option<u64> {
        group_rss_bytes_of(self.pgid).ok()
    }

    fn process_group_id(&self) -> Option<i32> {
        i32::try_from(self.pgid).ok()
    }

    async fn shutdown(&self) {
        let _ = self
            .client
            .call("shutdown", json!({}), SHUTDOWN_TIMEOUT)
            .await;
        self.client.connection.close_input().await;
        self.process.lock().await.shutdown().await;
    }
}

/// Turns helper `event` lines into [EngineEvent]s and fills the TurnItem fields only the host
/// side knows.
struct Translator {
    thread_id: goat2_contracts::ThreadId,
    engine_ref: String,
    ordinal: AtomicU32,
    logs: Arc<Mutex<VecDeque<String>>>,
}

impl Translator {
    async fn run(
        self,
        mut inbound: mpsc::UnboundedReceiver<Inbound>,
        events: mpsc::UnboundedSender<EngineEvent>,
    ) {
        let mut exited = false;
        while let Some(message) = inbound.recv().await {
            match message {
                Inbound::Record(record) => {
                    if let Some(event) = record.get("event") {
                        match self.translate(event) {
                            Ok(event) => {
                                exited |= matches!(event, EngineEvent::Exited { .. });
                                let _ = events.send(event);
                            }
                            Err(problem) => self.remember(format!("dropped event: {problem}")),
                        }
                    } else if let Some(log) = record.get("log") {
                        let level = log.get("level").and_then(Value::as_str).unwrap_or("info");
                        let message = log.get("message").and_then(Value::as_str).unwrap_or("");
                        self.remember(format!("{level}: {message}"));
                    }
                }
                Inbound::Closed(reason) => {
                    if !exited {
                        let _ = events.send(EngineEvent::Exited { reason });
                    }
                    return;
                }
            }
        }
    }

    fn remember(&self, line: String) {
        if let Ok(mut logs) = self.logs.lock() {
            if logs.len() == LOG_TAIL_LINES {
                logs.pop_front();
            }
            logs.push_back(line);
        }
    }

    fn translate(&self, event: &Value) -> Result<EngineEvent, String> {
        let text = |key: &str| -> Result<String, String> {
            event
                .get(key)
                .and_then(Value::as_str)
                .map(str::to_string)
                .ok_or_else(|| format!("missing {key}"))
        };
        let optional_text = |key: &str| event.get(key).and_then(Value::as_str).map(str::to_string);
        let kind = event.get("type").and_then(Value::as_str).unwrap_or("");
        Ok(match kind {
            "text_delta" => EngineEvent::TextDelta {
                turn_id: text("turnId")?,
                item_id: ItemId::from(text("itemId")?),
                text: text("text")?,
            },
            "content_delta" => EngineEvent::ContentDelta {
                turn_id: text("turnId")?,
                item_id: ItemId::from(text("itemId")?),
                stream_kind: serde_json::from_value(
                    event.get("streamKind").cloned().unwrap_or(Value::Null),
                )
                .map_err(|error| format!("bad streamKind: {error}"))?,
                text: text("text")?,
            },
            "item_completed" => {
                let turn_id = text("turnId")?;
                let item = self.item(event.get("item").ok_or("missing item")?)?;
                let locator = event
                    .get("locator")
                    .filter(|locator| !locator.is_null())
                    .map(|locator| -> Result<EngineItemLocator, String> {
                        Ok(EngineItemLocator {
                            turn_id: locator
                                .get("turnId")
                                .and_then(Value::as_str)
                                .ok_or("locator without turnId")?
                                .to_string(),
                            item_id: locator
                                .get("itemId")
                                .and_then(Value::as_str)
                                .ok_or("locator without itemId")?
                                .to_string(),
                        })
                    })
                    .transpose()?;
                EngineEvent::ItemCompleted {
                    turn_id,
                    item: Box::new(item),
                    locator,
                }
            }
            "request_opened" => {
                let kind = request_kind(&text("kind")?)?;
                let item = match event.get("item").filter(|item| !item.is_null()) {
                    Some(item) => Some(Box::new(self.item(item)?)),
                    None => None,
                };
                EngineEvent::RequestOpened {
                    turn_id: text("turnId")?,
                    key: text("key")?,
                    item_id: optional_text("itemId").map(ItemId::from),
                    kind,
                    summary: text("summary")?,
                    item,
                }
            }
            "request_closed" => EngineEvent::RequestClosed { key: text("key")? },
            "session_request_opened" => EngineEvent::SessionRequestOpened {
                key: text("key")?,
                item_id: optional_text("itemId").map(ItemId::from),
                kind: request_kind(&text("kind")?)?,
                summary: text("summary")?,
                item: match event.get("item").filter(|item| !item.is_null()) {
                    Some(item) => Some(Box::new(self.item(item)?)),
                    None => None,
                },
            },
            "continuation_requested" => EngineEvent::ContinuationRequested {
                key: text("key")?,
                text: text("text")?,
            },
            "continuation_withdrawn" => EngineEvent::ContinuationWithdrawn { key: text("key")? },
            "auth_required" => EngineEvent::AuthRequired {
                key: optional_text("key"),
                turn_id: optional_text("turnId"),
                url: optional_text("url"),
                message: text("message")?,
            },
            "token_usage" => EngineEvent::TokenUsage {
                turn_id: optional_text("turnId"),
                usage: serde_json::from_value(event.get("usage").cloned().unwrap_or(Value::Null))
                    .map_err(|error| format!("bad token usage: {error}"))?,
            },
            "subagent_update" => EngineEvent::SubagentUpdate {
                turn_id: optional_text("turnId"),
                subagent_id: text("subagentId")?,
                status: serde_json::from_value(event.get("status").cloned().unwrap_or(Value::Null))
                    .map_err(|error| format!("bad subagent status: {error}"))?,
                title: optional_text("title"),
                progress: optional_text("progress"),
            },
            "turn_finished" => {
                let outcome = event.get("outcome").ok_or("missing outcome")?;
                let outcome = match outcome.get("type").and_then(Value::as_str) {
                    Some("done") => TurnOutcome::Done,
                    Some("interrupted") => TurnOutcome::Interrupted,
                    Some("failed") => TurnOutcome::Failed {
                        reason: outcome
                            .get("reason")
                            .and_then(Value::as_str)
                            .unwrap_or("engine reported a failure")
                            .to_string(),
                    },
                    other => return Err(format!("unknown outcome {other:?}")),
                };
                EngineEvent::TurnFinished {
                    turn_id: text("turnId")?,
                    outcome,
                }
            }
            "steer_updated" => {
                let input_ids = event
                    .get("inputIds")
                    .and_then(Value::as_array)
                    .ok_or("missing inputIds")?
                    .iter()
                    .map(|id| {
                        id.as_str()
                            .map(InputId::from)
                            .ok_or("inputIds holds a non-string")
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                let status = event.get("status").ok_or("missing status")?;
                let status = match status.get("type").and_then(Value::as_str) {
                    Some("completed") => SteerStatus::Completed,
                    Some("cancelled") => SteerStatus::Cancelled {
                        reason: status
                            .get("reason")
                            .and_then(Value::as_str)
                            .unwrap_or("the engine cancelled the steer")
                            .to_string(),
                    },
                    other => return Err(format!("unknown steer status {other:?}")),
                };
                EngineEvent::SteerUpdated {
                    turn_id: text("turnId")?,
                    input_ids,
                    status,
                }
            }
            "exited" => EngineEvent::Exited {
                reason: text("reason")?,
            },
            other => return Err(format!("unknown event type {other:?}")),
        })
    }

    /// Fill `threadId`, `runId`, `ordinal`, `providerThreadId` and validate against TurnItem.
    fn item(&self, raw: &Value) -> Result<TurnItem, String> {
        let Value::Object(mut map) = raw.clone() else {
            return Err("item is not an object".into());
        };
        let ordinal = self.ordinal.fetch_add(1, Ordering::Relaxed);
        map.insert("threadId".into(), json!(self.thread_id));
        map.insert("runId".into(), Value::Null);
        map.insert("ordinal".into(), json!(ordinal));
        map.insert("providerThreadId".into(), json!(self.engine_ref));
        serde_json::from_value(Value::Object(map)).map_err(|error| format!("invalid item: {error}"))
    }
}
