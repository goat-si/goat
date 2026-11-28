//! Stdio-to-HTTP MCP bridge spawned by the ACP driver for agents without HTTP MCP.
//! GOAT 2 (Dev) must bundle this binary next to goat2-host.
//! v1: packages/provider-acp/src/server/AcpSessionRuntime.ts:1475-1494 and mcpContext.ts.

use serde_json::{Value, json};
use std::{
    fmt,
    future::{Future, Ready, ready},
    io,
    sync::{Arc, Mutex},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader},
    sync::{mpsc, watch},
    task::JoinSet,
};

const MAX_MESSAGE_BYTES: usize = 16 * 1024 * 1024;
const MAX_SSE_EVENT_SIZE: usize = 8 * 1024 * 1024;
/// A plain JSON response body is bounded like an input line (v1 reads it whole,
/// mcpResponsePayloads.ts:50-58; GOAT 2 bounds it, final review finding 18).
const MAX_RESPONSE_BYTES: usize = MAX_MESSAGE_BYTES;
/// Requests and notifications in flight at once; one more request is refused at once, a
/// notification beyond it is dropped. Reading input never waits for a slot, so an agent reply
/// that an open request needs is always read (v1 AcpMcpStdioBridge.ts:496-556 forks each line
/// without a bound).
pub const MAX_CONCURRENT_REQUESTS: usize = 64;
/// Replies to the server's requests in flight at once, on top of [MAX_CONCURRENT_REQUESTS].
pub const MAX_CONCURRENT_REPLIES: usize = 64;
/// Messages waiting for stdout; a full queue makes the requests producing them wait.
pub const OUTPUT_QUEUE_CAPACITY: usize = 256;

/// v1 AcpMcpStdioBridge.ts:18-65.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorKind {
    Transport,
    Http,
    Protocol,
    Rpc,
}

/// v1 AcpMcpStdioBridge.ts:25-65, 259-285.
#[derive(Debug)]
pub struct BridgeError {
    pub kind: ErrorKind,
    pub message: String,
    pub status: Option<u16>,
    pub rpc_code: Option<i64>,
    pub rpc_message: Option<String>,
    pub rpc_may_have_started: bool,
    pub stage: Option<&'static str>,
}
impl BridgeError {
    fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            status: None,
            rpc_code: None,
            rpc_message: None,
            rpc_may_have_started: false,
            stage: None,
        }
    }
}
impl fmt::Display for BridgeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for BridgeError {}

#[derive(Default)]
struct State {
    session: Option<String>,
    version: Option<String>,
}
/// Authenticated session relay. v1 AcpMcpStdioBridge.ts:126-207.
#[derive(Clone)]
pub struct HttpRelay {
    client: reqwest::Client,
    endpoint: String,
    authorization: String,
    state: Arc<Mutex<State>>,
}
impl HttpRelay {
    pub fn new(endpoint: impl Into<String>, authorization: impl Into<String>) -> Self {
        Self {
            client: reqwest::Client::new(),
            endpoint: endpoint.into(),
            authorization: authorization.into(),
            state: Arc::new(Mutex::new(State::default())),
        }
    }
    fn headers(&self, mut request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        let state = self.state.lock().unwrap();
        request = request
            .header("accept", "application/json, text/event-stream")
            .header("authorization", &self.authorization);
        if let Some(id) = &state.session {
            request = request.header("mcp-session-id", id);
        }
        if let Some(version) = &state.version {
            request = request.header("mcp-protocol-version", version);
        }
        request
    }
    /// Send a raw JSON line, delivering SSE events as they arrive.
    pub async fn send_raw<F: FnMut(Value)>(
        &self,
        line: &str,
        mut emit: F,
    ) -> Result<(), BridgeError> {
        self.send_raw_with(line, |value| -> Ready<Result<(), BridgeError>> {
            emit(value);
            ready(Ok(()))
        })
        .await
    }

    /// Send a JSON-RPC message and collect the response payloads, failing once they pass
    /// `max_bytes` in total (serialized), so a stream of many small SSE events cannot grow
    /// memory without bound. v1 `mcpOverAcpBridge.ts:150` collected the whole stream; GOAT 2 bounds
    /// it (final review 5 finding 1).
    pub async fn send_collect(
        &self,
        line: &str,
        max_bytes: usize,
    ) -> Result<Vec<Value>, BridgeError> {
        let mut payloads = Vec::new();
        let mut total = 0usize;
        self.send_raw_with(line, |payload| {
            total += payload.to_string().len();
            let over = total > max_bytes;
            if !over {
                match payload {
                    Value::Array(entries) => payloads.extend(entries),
                    other => payloads.push(other),
                }
            }
            ready(if over {
                Err(BridgeError::new(
                    ErrorKind::Protocol,
                    format!("GOAT MCP endpoint response exceeds {max_bytes} bytes."),
                ))
            } else {
                Ok(())
            })
        })
        .await?;
        Ok(payloads)
    }
    /// [Self::send_raw] waiting on `emit` for each payload, so a slow consumer slows the read.
    pub async fn send_raw_with<F, Fut>(&self, line: &str, mut emit: F) -> Result<(), BridgeError>
    where
        F: FnMut(Value) -> Fut,
        Fut: Future<Output = Result<(), BridgeError>>,
    {
        let req = self
            .headers(self.client.post(&self.endpoint))
            .header("content-type", "application/json")
            .body(line.to_owned());
        let mut response = req
            .send()
            .await
            .map_err(|e| BridgeError::new(ErrorKind::Transport, e.to_string()))?;
        if let Some(id) = response
            .headers()
            .get("mcp-session-id")
            .and_then(|v| v.to_str().ok())
        {
            self.state.lock().unwrap().session = Some(id.to_owned());
        }
        let status = response.status();
        if !status.is_success() {
            let mut e = BridgeError::new(
                ErrorKind::Http,
                format!("GOAT MCP endpoint responded with HTTP {}.", status.as_u16()),
            );
            e.status = Some(status.as_u16());
            return Err(e);
        }
        if status.as_u16() == 202 || status.as_u16() == 204 {
            return Ok(());
        }
        let sse = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .eq_ignore_ascii_case("text/event-stream");
        let mut bytes = Vec::new();
        let mut data = Vec::<String>::new();
        let mut event_size = 0usize;
        let mut skip_lf = false;
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|e| BridgeError::new(ErrorKind::Transport, e.to_string()))?
        {
            if !sse {
                if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
                    return Err(BridgeError::new(
                        ErrorKind::Transport,
                        "GOAT MCP endpoint response exceeds the maximum size",
                    ));
                }
                bytes.extend_from_slice(&chunk);
                continue;
            }
            for &byte in &chunk {
                if skip_lf {
                    skip_lf = false;
                    if byte == b'\n' {
                        continue;
                    }
                }
                if byte == b'\r' || byte == b'\n' {
                    if byte == b'\r' {
                        skip_lf = true;
                    }
                    let line = String::from_utf8_lossy(&bytes).into_owned();
                    bytes.clear();
                    if line.is_empty() {
                        let joined = data.join("\n");
                        data.clear();
                        event_size = 0;
                        if !joined.is_empty() {
                            let value = serde_json::from_str(&joined).map_err(|e| {
                                BridgeError::new(ErrorKind::Transport, e.to_string())
                            })?;
                            self.observe(&value);
                            emit(value).await?;
                        }
                    } else if let Some(value) = line.strip_prefix("data:") {
                        data.push(value.trim_start().to_owned());
                    }
                } else {
                    bytes.push(byte);
                    event_size += 1;
                    if event_size > MAX_SSE_EVENT_SIZE {
                        return Err(BridgeError::new(
                            ErrorKind::Transport,
                            "SSE event exceeds the maximum size",
                        ));
                    }
                }
            }
        }
        if !sse && !String::from_utf8_lossy(&bytes).trim().is_empty() {
            let value = serde_json::from_slice(&bytes)
                .map_err(|e| BridgeError::new(ErrorKind::Transport, e.to_string()))?;
            self.observe(&value);
            emit(value).await?;
        }
        Ok(())
    }
    fn observe(&self, value: &Value) {
        for entry in value
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or(std::slice::from_ref(value))
        {
            if let Some(version) = entry
                .pointer("/result/protocolVersion")
                .and_then(Value::as_str)
                .filter(|v| !v.is_empty())
            {
                self.state.lock().unwrap().version = Some(version.to_owned());
            }
        }
    }
    /// Best-effort DELETE of the session. v1 AcpMcpStdioBridge.ts:195-205.
    pub async fn terminate(&self) {
        if self.state.lock().unwrap().session.is_none() {
            return;
        }
        let _ = self
            .headers(self.client.delete(&self.endpoint))
            .send()
            .await;
    }
    /// DELETE the session and report the outcome (v1 mcpOverAcpBridge.ts:189-221): a transport
    /// failure or a status other than 2xx/404 is an error, so the caller can keep the session and
    /// retry. Without a session there is nothing to end.
    pub async fn terminate_checked(&self) -> Result<(), BridgeError> {
        if self.state.lock().unwrap().session.is_none() {
            return Ok(());
        }
        let response = self
            .headers(self.client.delete(&self.endpoint))
            .send()
            .await
            .map_err(|e| BridgeError::new(ErrorKind::Transport, e.to_string()))?;
        let status = response.status();
        if status.is_success() || status.as_u16() == 404 {
            return Ok(());
        }
        let mut error = BridgeError::new(
            ErrorKind::Http,
            format!(
                "GOAT MCP endpoint rejected disconnect with HTTP {}.",
                status.as_u16()
            ),
        );
        error.status = Some(status.as_u16());
        Err(error)
    }
}
/// Extract the matching result. v1 AcpMcpStdioBridge.ts:259-285.
pub fn request_result(
    responses: &[Value],
    id: &Value,
    describe: &str,
) -> Result<Value, BridgeError> {
    let found = responses.iter().find(|v| v.get("id") == Some(id));
    if let Some(value) = found
        && value.get("error").is_none()
    {
        return Ok(value.get("result").cloned().unwrap_or(Value::Null));
    }
    let error = found.and_then(|v| v.get("error"));
    let mut e = BridgeError::new(
        if found.is_some() {
            ErrorKind::Rpc
        } else {
            ErrorKind::Protocol
        },
        match error {
            Some(v) => format!("{describe} failed: {v}"),
            None => format!("{describe} failed."),
        },
    );
    e.rpc_code = error.and_then(|v| v.get("code")).and_then(Value::as_i64);
    e.rpc_message = error
        .and_then(|v| v.get("message"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    e.rpc_may_have_started = error
        .and_then(|v| v.pointer("/data/mayHaveStarted"))
        .and_then(Value::as_bool)
        == Some(true);
    Err(e)
}

fn error(id: Value, code: i32, message: &str) -> Value {
    json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}})
}

/// The bridge's work in flight: forwarded requests and notifications, and forwarded replies.
#[derive(Default)]
struct InFlight {
    requests: JoinSet<()>,
    replies: JoinSet<()>,
}
impl InFlight {
    /// Drop finished work so its slot is free again (v1 AcpMcpStdioBridge.ts:500-510 removes a
    /// fiber when it ends, not at end of input; final review finding 18).
    fn reap(&mut self) {
        while self.requests.try_join_next().is_some() {}
        while self.replies.try_join_next().is_some() {}
    }
    async fn drain(&mut self) {
        while self.requests.join_next().await.is_some() {}
        while self.replies.join_next().await.is_some() {}
    }
}

/// Stdio bridge, preserving input lines and allowing server responses through the handshake barrier.
/// v1 AcpMcpStdioBridge.ts:419-563; AcpMcpLineReader.ts:1-42.
pub async fn run_stdio_bridge<R, W>(
    endpoint: impl Into<String>,
    authorization: impl Into<String>,
    reader: R,
    mut writer: W,
) -> io::Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let relay = HttpRelay::new(endpoint, authorization);
    let (output, mut rx) = mpsc::channel::<Value>(OUTPUT_QUEUE_CAPACITY);
    let writer_task = tokio::spawn(async move {
        while let Some(value) = rx.recv().await {
            let mut line = value.to_string();
            line.push('\n');
            if let Err(e) = writer.write_all(line.as_bytes()).await {
                if e.kind() == io::ErrorKind::BrokenPipe {
                    return Ok(());
                }
                return Err(e);
            }
            if let Err(e) = writer.flush().await {
                if e.kind() == io::ErrorKind::BrokenPipe {
                    return Ok(());
                }
                return Err(e);
            }
        }
        Ok(())
    });
    let mut reader = BufReader::new(reader);
    let mut buffer = Vec::new();
    let mut oversized = false;
    let mut tasks = InFlight::default();
    let (initial, _) = watch::channel(true);
    let mut barrier = initial.subscribe();
    while let Ok(chunk) = reader.fill_buf().await {
        if chunk.is_empty() {
            if !buffer.is_empty() || oversized {
                dispatch(
                    &mut tasks,
                    &relay,
                    &output,
                    &mut barrier,
                    &buffer,
                    oversized,
                )
                .await;
            }
            break;
        }
        let end = chunk.iter().position(|&b| b == b'\n');
        let n = end.unwrap_or(chunk.len());
        if n > MAX_MESSAGE_BYTES.saturating_sub(buffer.len()) {
            oversized = true;
        }
        if !oversized {
            buffer.extend_from_slice(&chunk[..n]);
        }
        let consumed = n + usize::from(end.is_some());
        reader.consume(consumed);
        if end.is_some() {
            dispatch(
                &mut tasks,
                &relay,
                &output,
                &mut barrier,
                &buffer,
                oversized,
            )
            .await;
            buffer.clear();
            oversized = false;
        }
    }
    tasks.drain().await;
    drop(output);
    match writer_task.await {
        Ok(result) => result,
        Err(e) => Err(io::Error::other(e)),
    }
}
async fn dispatch(
    tasks: &mut InFlight,
    relay: &HttpRelay,
    output: &mpsc::Sender<Value>,
    barrier: &mut watch::Receiver<bool>,
    bytes: &[u8],
    oversized: bool,
) {
    if oversized {
        let _ = output
            .send(error(Value::Null, -32600, "Message too large"))
            .await;
        return;
    }
    let line = String::from_utf8_lossy(bytes)
        .trim_end_matches('\r')
        .to_string();
    if line.trim().is_empty() {
        return;
    }
    let Ok(value) = serde_json::from_str::<Value>(&line) else {
        let _ = output.send(error(Value::Null, -32700, "Parse error")).await;
        return;
    };
    if !value.is_object() && !value.is_array() {
        return;
    }
    let id = value.get("id").cloned();
    let response = id.is_some() && (value.get("result").is_some() || value.get("error").is_some());
    let handshake = matches!(
        value.get("method").and_then(Value::as_str),
        Some("initialize" | "notifications/initialized")
    );
    tasks.reap();
    let full = if response {
        tasks.replies.len() >= MAX_CONCURRENT_REPLIES
    } else {
        tasks.requests.len() >= MAX_CONCURRENT_REQUESTS
    };
    if full {
        match id {
            Some(id) if !response => {
                let _ = output
                    .send(error(
                        id,
                        -32603,
                        "GOAT MCP bridge is busy: too many requests are in flight.",
                    ))
                    .await;
            }
            _ => eprintln!("acp-mcp-bridge: too many messages in flight; one was dropped."),
        }
        return;
    }
    let mut prior = barrier.clone();
    let finish = if handshake {
        let (tx, rx) = watch::channel(false);
        *barrier = rx;
        Some(tx)
    } else {
        None
    };
    let relay = relay.clone();
    let output = output.clone();
    let work = async move {
        if !response {
            while !*prior.borrow_and_update() {
                if prior.changed().await.is_err() {
                    break;
                }
            }
        }
        let result = relay
            .send_raw_with(&line, |payload| {
                let output = output.clone();
                async move {
                    let entries = match payload {
                        Value::Array(entries) => entries,
                        other => vec![other],
                    };
                    for entry in entries {
                        let _ = output.send(entry).await;
                    }
                    Ok(())
                }
            })
            .await;
        if let (Err(e), Some(id)) = (result, id) {
            let message = if e.kind == ErrorKind::Http {
                e.message
            } else {
                format!("GOAT MCP bridge request failed: {e}")
            };
            let _ = output.send(error(id, -32603, &message)).await;
        }
        if let Some(tx) = finish {
            let _ = tx.send(true);
        }
    };
    if response {
        tasks.replies.spawn(work);
    } else {
        tasks.requests.spawn(work);
    }
}
