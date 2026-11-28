//! Stdio-to-HTTP MCP bridge spawned by the ACP driver for agents without HTTP MCP.
//! GOAT 2 (Dev) must bundle this binary next to goat2-host.
//! v1: packages/provider-acp/src/server/AcpSessionRuntime.ts:1475-1494 and mcpContext.ts.

use serde_json::{Value, json};
use std::{
    fmt, io,
    sync::{Arc, Mutex},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader},
    sync::{mpsc, watch},
    task::JoinSet,
};

const MAX_MESSAGE_BYTES: usize = 16 * 1024 * 1024;
const MAX_SSE_EVENT_SIZE: usize = 8 * 1024 * 1024;

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
    /// Send a JSON-RPC message and collect HTTP response payloads.
    pub async fn send(&self, message: &Value) -> Result<Vec<Value>, BridgeError> {
        let (sender, mut receiver) = mpsc::unbounded_channel();
        let relay = self.clone();
        let line = message.to_string();
        let task = tokio::spawn(async move {
            relay
                .send_raw(&line, |payload| {
                    let _ = sender.send(payload);
                })
                .await
        });
        let mut entries = Vec::new();
        while let Some(payload) = receiver.recv().await {
            if payload.get("id").is_some()
                && payload.get("method").and_then(Value::as_str).is_some()
            {
                let id = payload["id"].clone();
                let reply = if payload["method"] == "ping" {
                    json!({"jsonrpc":"2.0","id":id,"result":{}})
                } else {
                    json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"Method not found"}})
                };
                Box::pin(self.send(&reply)).await?;
            } else {
                entries.push(payload);
            }
        }
        task.await
            .map_err(|e| BridgeError::new(ErrorKind::Transport, e.to_string()))??;
        Ok(entries)
    }
    /// Send a raw JSON line, delivering SSE events as they arrive.
    pub async fn send_raw<F: FnMut(Value)>(
        &self,
        line: &str,
        mut emit: F,
    ) -> Result<(), BridgeError> {
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
                            emit(value);
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
            emit(value);
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
    /// Initialize a reusable tool session. v1 AcpMcpStdioBridge.ts:208-230.
    pub async fn initialize(&self, client_name: &str) -> Result<(), BridgeError> {
        let id = "t3-acp-cli-initialize";
        let responses = self.send(&json!({"jsonrpc":"2.0","id":id,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":client_name,"version":"0.0.0"}}})).await?;
        if !responses
            .iter()
            .any(|v| v.get("id") == Some(&json!(id)) && v.get("error").is_none())
        {
            let mut err = BridgeError::new(
                ErrorKind::Protocol,
                "GOAT MCP endpoint rejected initialization.",
            );
            err.stage = Some("initialize");
            return Err(err);
        }
        self.send(&json!({"jsonrpc":"2.0","method":"notifications/initialized"}))
            .await?;
        Ok(())
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
    let (output, mut rx) = mpsc::unbounded_channel::<Value>();
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
    let mut tasks = JoinSet::new();
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
                );
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
            );
            buffer.clear();
            oversized = false;
        }
    }
    while tasks.join_next().await.is_some() {}
    drop(output);
    match writer_task.await {
        Ok(result) => result,
        Err(e) => Err(io::Error::other(e)),
    }
}
fn dispatch(
    tasks: &mut JoinSet<()>,
    relay: &HttpRelay,
    output: &mpsc::UnboundedSender<Value>,
    barrier: &mut watch::Receiver<bool>,
    bytes: &[u8],
    oversized: bool,
) {
    if oversized {
        let _ = output.send(error(Value::Null, -32600, "Message too large"));
        return;
    }
    let line = String::from_utf8_lossy(bytes)
        .trim_end_matches('\r')
        .to_string();
    if line.trim().is_empty() {
        return;
    }
    let Ok(value) = serde_json::from_str::<Value>(&line) else {
        let _ = output.send(error(Value::Null, -32700, "Parse error"));
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
    tasks.spawn(async move {
        if !response {
            while !*prior.borrow_and_update() {
                if prior.changed().await.is_err() {
                    break;
                }
            }
        }
        let result = relay
            .send_raw(&line, |payload| {
                for entry in payload
                    .as_array()
                    .map(Vec::as_slice)
                    .unwrap_or(std::slice::from_ref(&payload))
                {
                    let _ = output.send(entry.clone());
                }
            })
            .await;
        if let (Err(e), Some(id)) = (result, id) {
            let message = if e.kind == ErrorKind::Http {
                e.message
            } else {
                format!("GOAT MCP bridge request failed: {e}")
            };
            let _ = output.send(error(id, -32603, &message));
        }
        if let Some(tx) = finish {
            let _ = tx.send(true);
        }
    });
}
