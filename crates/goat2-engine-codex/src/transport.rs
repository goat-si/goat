//! JSON-RPC over the child's stdio: a writer task, a reader task, pending calls keyed by id, and
//! a channel of inbound notifications and server requests.
//!
//! Request deadlines and liveness are ported from GOAT v1 (`apps/server/src/orchestration-v2/
//! Adapters/CodexRequestDeadline.ts:10-55` and `packages/provider-core/src/server/
//! finiteProviderRequest.ts:7-120` at goat origin/dev 0916b5cc):
//! - per-method deadlines (see [deadline_for]); a call past its deadline fails with
//!   [CallError::Deadline], but its slot is kept so a late answer still arrives as
//!   [Inbound::LateResponse] (at most [MAX_LATE_SLOTS] kept slots);
//! - `initialize` past its deadline retires the connection at once;
//! - any other deadline with no frame heard since the call was sent starts a `config/read`
//!   probe; if neither the probe nor any frame answers within the liveness window, the
//!   connection is retired ([Inbound::Retired]); the owner then ends the process.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot, watch};

use crate::protocol::server::{
    Notification, ParsedRequest, ServerRequest, parse_notification, parse_server_request,
};
use crate::protocol::{
    INTERNAL_ERROR, Incoming, RpcError, RpcId, error_frame, notification_frame, parse_incoming,
    request_frame, response_frame,
};

/// Direction of a frame seen by a [Tap].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    /// GOAT -> Codex.
    Outbound,
    /// Codex -> GOAT.
    Inbound,
}

/// Sees every frame in both directions (the recorder uses it).
pub type Tap = Arc<dyn Fn(Direction, &Value) + Send + Sync>;

/// Something read from Codex that is not a timely reply to one of GOAT's calls.
#[derive(Debug, Clone, PartialEq)]
pub enum Inbound {
    Notification(Notification),
    Request {
        id: RpcId,
        request: ServerRequest,
    },
    /// The answer to a call that already failed with [CallError::Deadline].
    LateResponse {
        id: RpcId,
        method: String,
        result: Result<Value, RpcError>,
    },
    /// The connection gave up on a silent server (v1 "retired"); treat as process exit.
    Retired {
        method: String,
    },
    Diagnostic(String),
}

/// Why a call has no usable answer.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum CallError {
    /// Codex answered with an error.
    #[error("codex refused: {0}")]
    Rpc(RpcError),
    /// The connection closed or was retired before an answer.
    #[error("connection closed before an answer")]
    Closed,
    /// No answer within the method's deadline; a late answer may still arrive.
    #[error("no answer to {method} within its deadline")]
    Deadline { method: String },
    /// Codex answered success with a body GOAT cannot read.
    #[error("answer could not be decoded: {0}")]
    Decode(String),
}

/// v1 `CodexRequestDeadline.ts:24-46`.
pub fn deadline_for(method: &str) -> Option<Duration> {
    match method {
        "initialize" | "turn/start" => Some(Duration::from_secs(60)),
        "thread/start" | "thread/resume" | "thread/fork" => Some(Duration::from_secs(90)),
        "config/read"
        | "thread/read"
        | "turn/steer"
        | "turn/interrupt"
        | "thread/unsubscribe"
        | "thread/goal/set"
        | "thread/goal/clear"
        | "thread/settings/update"
        | "thread/compact/start" => Some(Duration::from_secs(30)),
        _ => None,
    }
}

/// v1 `finiteProviderRequest.ts`: at most 1024 abandoned calls keep waiting for a late answer.
pub const MAX_LATE_SLOTS: usize = 1024;
/// v1 `CodexRequestDeadline.ts:16`.
pub const LIVENESS_WINDOW: Duration = Duration::from_secs(60);

/// Deadline and liveness settings (tests shorten them).
#[derive(Clone)]
pub struct TransportConfig {
    pub deadline_for: DeadlineFn,
    pub liveness_window: Duration,
}

/// Per-method deadline lookup.
pub type DeadlineFn = Arc<dyn Fn(&str) -> Option<Duration> + Send + Sync>;

impl Default for TransportConfig {
    fn default() -> Self {
        Self {
            deadline_for: Arc::new(deadline_for),
            liveness_window: LIVENESS_WINDOW,
        }
    }
}

enum Slot {
    Waiting(oneshot::Sender<Result<Value, RpcError>>),
    Late { method: String },
}

struct Shared {
    pending: Mutex<HashMap<RpcId, Slot>>,
    late_slots: AtomicUsize,
    closed: watch::Sender<bool>,
    heard: watch::Sender<u64>,
    probing: AtomicBool,
    retired: AtomicBool,
    inbound: mpsc::UnboundedSender<Inbound>,
}

impl Shared {
    /// Close: under the pending lock, so no call can be inserted afterwards.
    fn close(&self) {
        if let Ok(mut pending) = self.pending.lock() {
            self.closed.send_replace(true);
            pending.clear();
            self.late_slots.store(0, Ordering::Relaxed);
        } else {
            self.closed.send_replace(true);
        }
    }

    fn retire(&self, method: &str) {
        if !self.retired.swap(true, Ordering::SeqCst) {
            self.close();
            let _ = self.inbound.send(Inbound::Retired {
                method: method.to_string(),
            });
        }
    }
}

/// A JSON-RPC connection to one Codex process.
#[derive(Clone)]
pub struct Connection {
    writer: mpsc::UnboundedSender<Out>,
    shared: Arc<Shared>,
    next_id: Arc<AtomicI64>,
    tap: Option<Tap>,
    config: TransportConfig,
}

/// What the writer task writes.
enum Out {
    Frame(Value),
    /// Close Codex's stdin (orderly shutdown).
    Close,
}

impl Connection {
    /// Start reader and writer tasks with v1 deadlines.
    pub fn start<W, R>(
        stdin: W,
        stdout: R,
        tap: Option<Tap>,
    ) -> (Self, mpsc::UnboundedReceiver<Inbound>)
    where
        W: AsyncWrite + Unpin + Send + 'static,
        R: AsyncRead + Unpin + Send + 'static,
    {
        Self::start_with(stdin, stdout, tap, TransportConfig::default())
    }

    pub fn start_with<W, R>(
        stdin: W,
        stdout: R,
        tap: Option<Tap>,
        config: TransportConfig,
    ) -> (Self, mpsc::UnboundedReceiver<Inbound>)
    where
        W: AsyncWrite + Unpin + Send + 'static,
        R: AsyncRead + Unpin + Send + 'static,
    {
        let (writer, mut outbox) = mpsc::unbounded_channel::<Out>();
        let (inbound_tx, inbound_rx) = mpsc::unbounded_channel();
        let shared = Arc::new(Shared {
            pending: Mutex::new(HashMap::new()),
            late_slots: AtomicUsize::new(0),
            closed: watch::channel(false).0,
            heard: watch::channel(0).0,
            probing: AtomicBool::new(false),
            retired: AtomicBool::new(false),
            inbound: inbound_tx,
        });

        let mut stdin = stdin;
        tokio::spawn(async move {
            while let Some(Out::Frame(frame)) = outbox.recv().await {
                let mut line = frame.to_string();
                line.push('\n');
                if stdin.write_all(line.as_bytes()).await.is_err() || stdin.flush().await.is_err() {
                    break;
                }
            }
            let _ = stdin.shutdown().await;
        });

        let reader_shared = Arc::clone(&shared);
        let reader_writer = writer.clone();
        let reader_tap = tap.clone();
        tokio::spawn(async move {
            let shared = reader_shared;
            let mut lines = BufReader::new(stdout).lines();
            loop {
                let line = match lines.next_line().await {
                    Ok(Some(line)) => line,
                    Ok(None) => break,
                    Err(error) => {
                        let _ = shared
                            .inbound
                            .send(Inbound::Diagnostic(format!("stdout read failed: {error}")));
                        break;
                    }
                };
                if line.trim().is_empty() {
                    continue;
                }
                if shared.retired.load(Ordering::SeqCst) {
                    continue;
                }
                shared.heard.send_modify(|n| *n += 1);
                if let Some(tap) = &reader_tap
                    && let Ok(value) = serde_json::from_str::<Value>(&line)
                {
                    tap(Direction::Inbound, &value);
                }
                match parse_incoming(&line) {
                    Ok(Incoming::Response { id, result }) => resolve(&shared, id, Ok(result)),
                    Ok(Incoming::Error { id, error }) => resolve(&shared, id, Err(error)),
                    Ok(Incoming::Notification { method, params }) => {
                        let _ = shared
                            .inbound
                            .send(Inbound::Notification(parse_notification(&method, params)));
                    }
                    Ok(Incoming::Request { id, method, params }) => {
                        match parse_server_request(&method, params) {
                            ParsedRequest::Known(request) => {
                                let _ = shared.inbound.send(Inbound::Request { id, request });
                            }
                            ParsedRequest::Unknown => {
                                let error = RpcError::method_not_found(&method);
                                send_frame(
                                    &reader_writer,
                                    reader_tap.as_ref(),
                                    error_frame(&id, &error),
                                );
                                let _ = shared.inbound.send(Inbound::Diagnostic(format!(
                                    "answered unknown server request {method} with -32601"
                                )));
                            }
                            ParsedRequest::Malformed(reason) => {
                                let error = RpcError {
                                    code: INTERNAL_ERROR,
                                    message: format!("GOAT could not read {method}: {reason}"),
                                    data: None,
                                };
                                send_frame(
                                    &reader_writer,
                                    reader_tap.as_ref(),
                                    error_frame(&id, &error),
                                );
                                let _ = shared.inbound.send(Inbound::Diagnostic(format!(
                                    "malformed server request {method}: {reason}"
                                )));
                            }
                        }
                    }
                    Err(error) => {
                        let _ = shared
                            .inbound
                            .send(Inbound::Diagnostic(format!("skipped a line: {error}")));
                    }
                }
            }
            shared.close();
        });

        (
            Self {
                writer,
                shared,
                next_id: Arc::new(AtomicI64::new(1)),
                tap,
                config,
            },
            inbound_rx,
        )
    }

    /// Whether the reader has seen EOF or the connection was retired.
    pub fn is_closed(&self) -> bool {
        *self.shared.closed.borrow()
    }

    /// Close Codex's stdin after the frames already queued. Codex exits on EOF.
    pub fn close_input(&self) {
        let _ = self.writer.send(Out::Close);
    }

    /// Wait until the connection closes.
    pub async fn closed(&self) {
        let mut closed = self.shared.closed.subscribe();
        let _ = closed.wait_for(|closed| *closed).await;
    }

    /// Send a request with the method's v1 deadline and wait for its answer.
    pub async fn request<P: Serialize, R: DeserializeOwned>(
        &self,
        method: &str,
        params: &P,
    ) -> Result<R, CallError> {
        let value = self.request_value(method, params).await?;
        serde_json::from_value(value).map_err(|error| CallError::Decode(error.to_string()))
    }

    /// Like [Self::request] but returns the raw result.
    pub async fn request_value<P: Serialize>(
        &self,
        method: &str,
        params: &P,
    ) -> Result<Value, CallError> {
        let deadline = (self.config.deadline_for)(method);
        self.call(method, params, deadline).await
    }

    async fn call<P: Serialize>(
        &self,
        method: &str,
        params: &P,
        deadline: Option<Duration>,
    ) -> Result<Value, CallError> {
        let params =
            serde_json::to_value(params).map_err(|error| CallError::Decode(error.to_string()))?;
        let id = RpcId::Int(self.next_id.fetch_add(1, Ordering::Relaxed));
        let (tx, mut rx) = oneshot::channel();
        let sent_at = *self.shared.heard.borrow();
        {
            let mut pending = self.shared.pending.lock().map_err(|_| CallError::Closed)?;
            if self.is_closed() {
                return Err(CallError::Closed);
            }
            pending.insert(id.clone(), Slot::Waiting(tx));
        }
        if !send_frame(
            &self.writer,
            self.tap.as_ref(),
            request_frame(&id, method, params),
        ) {
            self.forget(&id);
            return Err(CallError::Closed);
        }
        let answer = match deadline {
            None => (&mut rx).await,
            Some(limit) => match tokio::time::timeout(limit, &mut rx).await {
                Ok(answer) => answer,
                Err(_) => return self.past_deadline(&id, method, sent_at, rx),
            },
        };
        match answer {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(error)) => Err(CallError::Rpc(error)),
            Err(_) => Err(CallError::Closed),
        }
    }

    fn past_deadline(
        &self,
        id: &RpcId,
        method: &str,
        sent_at: u64,
        mut rx: oneshot::Receiver<Result<Value, RpcError>>,
    ) -> Result<Value, CallError> {
        let retires_alone = method == "initialize";
        if let Ok(mut pending) = self.shared.pending.lock()
            && let Some(Slot::Waiting(_)) = pending.remove(id)
            && !retires_alone
            && self.shared.late_slots.load(Ordering::Relaxed) < MAX_LATE_SLOTS
        {
            self.shared.late_slots.fetch_add(1, Ordering::Relaxed);
            pending.insert(
                id.clone(),
                Slot::Late {
                    method: method.to_string(),
                },
            );
        }
        // The answer may have landed between the timeout and taking the lock.
        if let Ok(answer) = rx.try_recv() {
            return answer.map_err(CallError::Rpc);
        }
        if retires_alone {
            self.shared.retire(method);
        } else if *self.shared.heard.borrow() == sent_at
            && !self.shared.probing.swap(true, Ordering::SeqCst)
        {
            self.start_probe(method.to_string());
        }
        Err(CallError::Deadline {
            method: method.to_string(),
        })
    }

    /// v1 liveness probe: `config/read`, or any frame, within the window; else retire.
    fn start_probe(&self, method: String) {
        let connection = self.clone();
        let window = self.config.liveness_window;
        tokio::spawn(async move {
            let mut heard = connection.shared.heard.subscribe();
            heard.mark_unchanged();
            let params = json!({ "cwd": null, "includeLayers": false });
            let probe = connection.call("config/read", &params, None);
            let alive = tokio::time::timeout(window, async {
                tokio::select! {
                    result = probe => !matches!(result, Err(CallError::Closed)),
                    changed = heard.changed() => changed.is_ok(),
                }
            })
            .await
            .unwrap_or(false);
            connection.shared.probing.store(false, Ordering::SeqCst);
            if !alive {
                connection.shared.retire(&method);
            }
        });
    }

    /// Send a notification.
    pub fn notify<P: Serialize>(&self, method: &str, params: &P) -> Result<(), CallError> {
        let params =
            serde_json::to_value(params).map_err(|error| CallError::Decode(error.to_string()))?;
        if send_frame(
            &self.writer,
            self.tap.as_ref(),
            notification_frame(method, params),
        ) {
            Ok(())
        } else {
            Err(CallError::Closed)
        }
    }

    /// Answer a server request.
    pub fn respond(&self, id: &RpcId, result: Value) -> Result<(), CallError> {
        if send_frame(&self.writer, self.tap.as_ref(), response_frame(id, result)) {
            Ok(())
        } else {
            Err(CallError::Closed)
        }
    }

    /// Answer a server request with an error.
    pub fn respond_error(&self, id: &RpcId, error: &RpcError) -> Result<(), CallError> {
        if send_frame(&self.writer, self.tap.as_ref(), error_frame(id, error)) {
            Ok(())
        } else {
            Err(CallError::Closed)
        }
    }

    fn forget(&self, id: &RpcId) {
        if let Ok(mut pending) = self.shared.pending.lock() {
            pending.remove(id);
        }
    }
}

fn send_frame(writer: &mpsc::UnboundedSender<Out>, tap: Option<&Tap>, frame: Value) -> bool {
    if let Some(tap) = tap {
        tap(Direction::Outbound, &frame);
    }
    writer.send(Out::Frame(frame)).is_ok()
}

fn resolve(shared: &Shared, id: RpcId, answer: Result<Value, RpcError>) {
    let slot = shared
        .pending
        .lock()
        .ok()
        .and_then(|mut pending| pending.remove(&id));
    match slot {
        Some(Slot::Waiting(sender)) => {
            let _ = sender.send(answer);
        }
        Some(Slot::Late { method }) => {
            shared.late_slots.fetch_sub(1, Ordering::Relaxed);
            let _ = shared.inbound.send(Inbound::LateResponse {
                id,
                method,
                result: answer,
            });
        }
        None => {
            let _ = shared.inbound.send(Inbound::Diagnostic(format!(
                "answer for id {id} that no call is waiting for"
            )));
        }
    }
}
