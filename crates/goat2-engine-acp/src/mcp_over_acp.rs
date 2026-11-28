//! MCP-over-ACP: GOAT's MCP endpoint served through the ACP connection to agents that advertise
//! `mcpCapabilities.acp`.
//!
//! v1 `packages/provider-acp/src/server/mcpOverAcpBridge.ts` (wire: `mcp/connect` {serverId} ->
//! {connectionId}; `mcp/message` {connectionId, method, params} -> the MCP result; `mcp/message`
//! notifications; `mcp/disconnect` {connectionId}). GOAT 2 keeps v1's wire even though the Rust ACP
//! schema has since moved to a connection-less `mcp/message` (owner rule: lift v1 once). Each connection
//! is one MCP session on the HTTP endpoint, relayed by `goat2_acp_mcp_bridge::HttpRelay`.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use goat2_acp_mcp_bridge::HttpRelay;
use serde_json::{Value, json};

/// v1 mcpOverAcpBridge.ts:11-12.
const MAX_CONNECTIONS: usize = 16;
const MAX_MESSAGE_BYTES: usize = 8 * 1024 * 1024;
/// Calls the agent may have in flight at once (the stdio bridge's limit, goat2-acp-mcp-bridge
/// MAX_CONCURRENT_REQUESTS).
pub const MAX_IN_FLIGHT: usize = 64;
/// Total size of one response the relay collects (the bridge's JSON body cap).
pub const MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
const DISCONNECT_TIMEOUT: Duration = Duration::from_secs(5);

struct Connection {
    relay: HttpRelay,
    /// Held while the MCP session is not negotiated yet, so initialization stays ordered.
    negotiation: tokio::sync::Mutex<()>,
    negotiated: AtomicBool,
    next_request_id: AtomicU64,
    /// Set while `mcp/disconnect` runs; new calls on the connection are refused (v1 `closing`).
    closing: AtomicBool,
}

pub struct McpOverAcp {
    endpoint: String,
    authorization: String,
    connections: Mutex<HashMap<String, Arc<Connection>>>,
    next_connection: AtomicU64,
    /// Requests and notifications in flight (final review 6A finding 1): beyond
    /// [MAX_IN_FLIGHT] the agent is refused at once instead of piling up waiting tasks.
    in_flight: Arc<tokio::sync::Semaphore>,
    /// Bumped by [McpOverAcp::stop_calls]; every call in flight races it (v1 `callsStopped`).
    stop: tokio::sync::watch::Sender<u64>,
    /// Set by [McpOverAcp::dispose]: the session stopped, nothing connects or calls any more (v1's
    /// handlers end with the runtime scope, adapter.ts:5547).
    disposed: AtomicBool,
}

fn protocol_version(payload: &Value) -> bool {
    payload
        .pointer("/result/protocolVersion")
        .and_then(Value::as_str)
        .is_some_and(|v| !v.is_empty())
}

/// v1 `errorMessage`.
fn error_message(error: &Value) -> String {
    error
        .get("message")
        .and_then(Value::as_str)
        .filter(|m| !m.is_empty())
        .unwrap_or("The MCP server returned an error.")
        .to_owned()
}

impl McpOverAcp {
    pub fn new(endpoint: impl Into<String>, authorization: impl Into<String>) -> Self {
        Self {
            endpoint: endpoint.into(),
            authorization: authorization.into(),
            connections: Mutex::new(HashMap::new()),
            next_connection: AtomicU64::new(0),
            stop: tokio::sync::watch::channel(0).0,
            in_flight: Arc::new(tokio::sync::Semaphore::new(MAX_IN_FLIGHT)),
            disposed: AtomicBool::new(false),
        }
    }

    /// v1 `stopCalls` (mcpOverAcpBridge.ts:273-276, called when a turn is interrupted,
    /// adapter.ts:4459-4466): every call in flight fails now; later calls run normally.
    pub fn stop_calls(&self) {
        self.stop.send_modify(|n| *n += 1);
    }

    fn connection(&self, params: &Value) -> Result<Arc<Connection>, String> {
        if self.disposed.load(Ordering::SeqCst) {
            return Err(Self::unknown(params));
        }
        self.open_connection(params)
    }

    fn unknown(params: &Value) -> String {
        let id = params
            .get("connectionId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        format!("Unknown MCP-over-ACP connection \"{id}\".")
    }

    /// A connection that is not closing, also during [Self::dispose] (which ends them).
    fn open_connection(&self, params: &Value) -> Result<Arc<Connection>, String> {
        let id = params
            .get("connectionId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        self.connections
            .lock()
            .expect("connections")
            .get(id)
            .filter(|c| !c.closing.load(Ordering::SeqCst))
            .cloned()
            .ok_or_else(|| format!("Unknown MCP-over-ACP connection \"{id}\"."))
    }

    /// v1 `send` (mcpOverAcpBridge.ts:158-165): the call races the stop signal.
    async fn send(&self, connection: &Connection, message: Value) -> Result<Vec<Value>, String> {
        let mut stopped = self.stop.subscribe();
        stopped.borrow_and_update();
        tokio::select! {
            result = self.send_now(connection, message) => result,
            _ = stopped.changed() => Err("The MCP call was stopped.".into()),
        }
    }

    async fn send_now(
        &self,
        connection: &Connection,
        message: Value,
    ) -> Result<Vec<Value>, String> {
        let body = message.to_string();
        if body.len() > MAX_MESSAGE_BYTES {
            return Err("MCP-over-ACP message exceeds 8 MiB.".into());
        }
        let _ordered = if connection.negotiated.load(Ordering::SeqCst) {
            None
        } else {
            Some(connection.negotiation.lock().await)
        };
        // Bounded: an endpoint cannot grow host memory with many small SSE events (final review 5
        // finding 1; v1 mcpOverAcpBridge.ts:150 collected the whole stream).
        let payloads = connection
            .relay
            .send_collect(&body, MAX_RESPONSE_BYTES)
            .await
            .map_err(|e| e.to_string())?;
        if payloads.iter().any(protocol_version) {
            connection.negotiated.store(true, Ordering::SeqCst);
        }
        Ok(payloads)
    }

    fn admit(&self) -> Result<tokio::sync::OwnedSemaphorePermit, String> {
        Arc::clone(&self.in_flight)
            .try_acquire_owned()
            .map_err(|_| "Too many MCP-over-ACP calls in flight.".to_owned())
    }

    /// `mcp/connect`.
    pub fn connect(&self, params: &Value) -> Result<Value, String> {
        let server = params
            .get("serverId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if server != crate::mcp::SERVER_NAME {
            return Err(format!("Unknown ACP MCP server \"{server}\"."));
        }
        if self.disposed.load(Ordering::SeqCst) {
            return Err("The MCP-over-ACP session has ended.".into());
        }
        let mut connections = self.connections.lock().expect("connections");
        if connections.len() >= MAX_CONNECTIONS {
            return Err("Too many MCP-over-ACP connections.".into());
        }
        let id = format!(
            "goat-mcp-{}",
            self.next_connection.fetch_add(1, Ordering::SeqCst) + 1
        );
        connections.insert(
            id.clone(),
            Arc::new(Connection {
                relay: HttpRelay::new(self.endpoint.clone(), self.authorization.clone()),
                negotiation: tokio::sync::Mutex::new(()),
                negotiated: AtomicBool::new(false),
                next_request_id: AtomicU64::new(0),
                closing: AtomicBool::new(false),
            }),
        );
        Ok(json!({ "connectionId": id }))
    }

    fn envelope(params: &Value, id: Option<u64>) -> Value {
        let mut message = json!({"jsonrpc": "2.0", "method": params.get("method").cloned().unwrap_or(Value::Null)});
        if let Some(id) = id {
            message["id"] = json!(id);
        }
        if let Some(inner) = params.get("params").filter(|p| !p.is_null()) {
            message["params"] = inner.clone();
        }
        message
    }

    /// `mcp/message` request: the MCP result of the matching response.
    pub async fn message(&self, params: &Value) -> Result<Value, String> {
        let _admitted = self.admit()?;
        let connection = self.connection(params)?;
        let id = connection.next_request_id.fetch_add(1, Ordering::SeqCst) + 1;
        let payloads = self
            .send(&connection, Self::envelope(params, Some(id)))
            .await?;
        let response = payloads
            .iter()
            .find(|p| p.get("id") == Some(&json!(id)))
            .ok_or("MCP server did not return a matching response.")?;
        if let Some(error) = response.get("error") {
            return Err(error_message(error));
        }
        Ok(response.get("result").cloned().unwrap_or(Value::Null))
    }

    /// `mcp/message` notification.
    pub async fn notify(&self, params: &Value) -> Result<(), String> {
        let _admitted = self.admit()?;
        let connection = self.connection(params)?;
        self.send(&connection, Self::envelope(params, None))
            .await
            .map(|_| ())
    }

    /// `mcp/disconnect` (v1 mcpOverAcpBridge.ts:168-187): mark the connection closing, end the
    /// HTTP session, and forget the connection only when that worked; on failure it stays usable
    /// so the agent can retry.
    pub async fn disconnect(&self, params: &Value) -> Result<Value, String> {
        if self.disposed.load(Ordering::SeqCst) {
            return Err(Self::unknown(params));
        }
        self.end_connection(params).await
    }

    async fn end_connection(&self, params: &Value) -> Result<Value, String> {
        let connection = self.open_connection(params)?;
        if connection
            .closing
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            let id = params
                .get("connectionId")
                .and_then(Value::as_str)
                .unwrap_or_default();
            return Err(format!("Unknown MCP-over-ACP connection \"{id}\"."));
        }
        let id = params
            .get("connectionId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let result =
            match tokio::time::timeout(DISCONNECT_TIMEOUT, connection.relay.terminate_checked())
                .await
            {
                Err(_) => Err("GOAT MCP endpoint did not answer disconnect.".to_owned()),
                Ok(result) => result.map_err(|e| e.to_string()),
            };
        match result {
            Ok(()) => {
                self.connections.lock().expect("connections").remove(&id);
                Ok(json!({}))
            }
            Err(message) => {
                connection.closing.store(false, Ordering::SeqCst);
                Err(message)
            }
        }
    }

    /// v1 `dispose` (mcpOverAcpBridge.ts:278-283): end every session at once (`concurrency:
    /// "unbounded"`) and forget them all afterwards (`ensuring connections.clear()`). The whole
    /// shutdown has one [DISCONNECT_TIMEOUT] deadline, so the agent process is stopped after at
    /// most that long however many connections hang (final review finding 17).
    /// Calls in flight end first with "The MCP call was stopped." and later connects and calls
    /// are refused: v1's handlers are interrupted when the runtime scope closes and their fetch
    /// is aborted (adapter.ts:5547, mcpOverAcpBridge.ts:121-123; round 7 part 3.3).
    pub async fn dispose(&self) {
        self.disposed.store(true, Ordering::SeqCst);
        self.stop_calls();
        let params: Vec<Value> = self
            .connections
            .lock()
            .expect("connections")
            .keys()
            .map(|id| json!({ "connectionId": id }))
            .collect();
        let all = futures::future::join_all(params.iter().map(|p| self.end_connection(p)));
        let _ = tokio::time::timeout(DISCONNECT_TIMEOUT, all).await;
        self.connections.lock().expect("connections").clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::{SocketAddr, TcpListener, TcpStream};

    /// A test MCP endpoint on 127.0.0.1, served by one thread. Connections the handler keeps stay
    /// open while the endpoint lives; dropping it stops the thread (a wake-up connection ends its
    /// accept), which closes every connection it held, and joins it, so no socket or thread
    /// outlives the test.
    struct Endpoint {
        url: String,
        addr: SocketAddr,
        stop: Arc<AtomicBool>,
        thread: Option<std::thread::JoinHandle<()>>,
    }

    impl Endpoint {
        fn serve(mut handle: impl FnMut(TcpStream, &mut Vec<TcpStream>) + Send + 'static) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let addr = listener.local_addr().unwrap();
            let stop = Arc::new(AtomicBool::new(false));
            let stopped = Arc::clone(&stop);
            let thread = std::thread::spawn(move || {
                let mut held = Vec::new();
                for stream in listener.incoming() {
                    if stopped.load(Ordering::SeqCst) {
                        break;
                    }
                    let Ok(stream) = stream else { break };
                    handle(stream, &mut held);
                }
            });
            Self {
                url: format!("http://{addr}/mcp"),
                addr,
                stop,
                thread: Some(thread),
            }
        }
    }

    impl Drop for Endpoint {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::SeqCst);
            let _ = TcpStream::connect(self.addr);
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
        }
    }

    /// Read one request: its first line and body.
    fn read_request(stream: &TcpStream) -> (String, Vec<u8>) {
        let mut reader = BufReader::new(stream);
        let mut request_line = String::new();
        if reader.read_line(&mut request_line).unwrap_or(0) == 0 {
            return (request_line, Vec::new());
        }
        let mut length = 0usize;
        loop {
            let mut line = String::new();
            if reader.read_line(&mut line).unwrap_or(0) == 0 {
                break;
            }
            let line = line.trim_end().to_owned();
            if line.is_empty() {
                break;
            }
            if let Some((name, value)) = line.split_once(':')
                && name.eq_ignore_ascii_case("content-length")
            {
                length = value.trim().parse().unwrap_or(0);
            }
        }
        let mut body = vec![0; length];
        let _ = reader.read_exact(&mut body);
        (request_line, body)
    }

    /// An MCP endpoint that opens sessions and never answers a DELETE (held connections).
    fn endpoint_that_hangs_on_delete() -> Endpoint {
        Endpoint::serve(|mut stream, held| {
            let (request_line, body) = read_request(&stream);
            if request_line.is_empty() {
                return;
            }
            if request_line.starts_with("DELETE") {
                held.push(stream);
                return;
            }
            let message: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
            let reply = json!({"jsonrpc": "2.0", "id": message["id"], "result": {"protocolVersion": "2025-06-18", "capabilities": {}, "serverInfo": {"name": "goat", "version": "0"}}}).to_string();
            let _ = write!(
                stream,
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\nmcp-session-id: s-1\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{reply}",
                reply.len()
            );
        })
    }

    /// Final review finding 17 (v1 mcpOverAcpBridge.ts:278-283): session shutdown ends every
    /// connection at once under one deadline, and forgets them even when the endpoint never
    /// answers.
    #[tokio::test]
    async fn dispose_ends_connections_in_parallel_under_one_deadline() {
        let endpoint = endpoint_that_hangs_on_delete();
        let bridge = McpOverAcp::new(endpoint.url.clone(), "Bearer t");
        for _ in 0..3 {
            let connected = bridge
                .connect(&json!({"serverId": crate::mcp::SERVER_NAME}))
                .unwrap();
            let id = connected["connectionId"].as_str().unwrap().to_owned();
            bridge
                .message(&json!({"connectionId": id, "method": "initialize", "params": {}}))
                .await
                .unwrap();
        }
        // Virtual time from here: each DELETE waits out its 5 s timeout.
        tokio::time::pause();
        let started = tokio::time::Instant::now();
        bridge.dispose().await;
        let elapsed = started.elapsed();
        assert!(
            elapsed <= DISCONNECT_TIMEOUT + Duration::from_millis(100),
            "dispose took {elapsed:?}"
        );
        assert!(bridge.connections.lock().unwrap().is_empty());
    }

    /// An MCP endpoint whose answer is an SSE stream of small events that never ends: past the
    /// response cap it stops writing but keeps the stream open (held until the endpoint is
    /// dropped), so only the cap can end the call, and no thread spins writing or waits on the
    /// client.
    fn endpoint_with_endless_sse() -> Endpoint {
        Endpoint::serve(|mut stream, held| {
            if read_request(&stream).0.is_empty() {
                return;
            }
            let _ = stream.write_all(
                b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n",
            );
            let payload = json!({"jsonrpc": "2.0", "method": "notifications/progress", "params": {"pad": "x".repeat(1000)}}).to_string();
            let event = format!("data: {payload}\n\n");
            // The cap counts serialized payloads: write a few events past it.
            let mut written = 0;
            while written <= MAX_RESPONSE_BYTES + 2 * payload.len()
                && stream.write_all(event.as_bytes()).is_ok()
            {
                written += payload.len();
            }
            held.push(stream);
        })
    }

    /// Final review 5 finding 1: many small SSE events cannot grow host memory without bound; the
    /// call fails once the collected response passes the cap.
    #[tokio::test]
    async fn an_endless_sse_answer_fails_at_the_size_cap() {
        let endpoint = endpoint_with_endless_sse();
        let bridge = McpOverAcp::new(endpoint.url.clone(), "Bearer t");
        let connected = bridge
            .connect(&json!({"serverId": crate::mcp::SERVER_NAME}))
            .unwrap();
        let id = connected["connectionId"].as_str().unwrap().to_owned();
        let result = tokio::time::timeout(
            Duration::from_secs(30),
            bridge.message(&json!({"connectionId": id, "method": "tools/list"})),
        )
        .await
        .expect("the call ends instead of collecting forever");
        let error = result.expect_err("an oversized answer fails");
        assert!(error.contains("exceeds"), "{error}");
    }

    /// An MCP endpoint that accepts requests and never answers them.
    fn endpoint_that_never_answers() -> Endpoint {
        Endpoint::serve(|stream, held| held.push(stream))
    }

    /// Final review 6A finding 1: past [MAX_IN_FLIGHT] calls the agent is refused at once
    /// instead of piling up waiting tasks and request bodies.
    #[tokio::test]
    async fn calls_beyond_the_in_flight_limit_are_refused() {
        let endpoint = endpoint_that_never_answers();
        let bridge = Arc::new(McpOverAcp::new(endpoint.url.clone(), "Bearer t"));
        let connected = bridge
            .connect(&json!({"serverId": crate::mcp::SERVER_NAME}))
            .unwrap();
        let id = connected["connectionId"].as_str().unwrap().to_owned();
        let mut waiting = Vec::new();
        // A fixed 64 (the documented limit), so the test does not follow a changed constant.
        for _ in 0..64 {
            let bridge = Arc::clone(&bridge);
            let id = id.clone();
            waiting.push(tokio::spawn(async move {
                bridge
                    .message(&json!({"connectionId": id, "method": "tools/list"}))
                    .await
            }));
        }
        // Every earlier call holds its slot once it has started.
        // Let every spawned call start (single-threaded test runtime: each runs to its first wait).
        for _ in 0..8 {
            tokio::task::yield_now().await;
        }
        let refused = tokio::time::timeout(
            Duration::from_secs(5),
            bridge.message(&json!({"connectionId": id, "method": "tools/list"})),
        )
        .await
        .expect("refused at once, not queued");
        assert_eq!(
            refused.unwrap_err(),
            "Too many MCP-over-ACP calls in flight."
        );
        bridge.stop_calls();
        for call in waiting {
            assert!(call.await.unwrap().is_err());
        }
    }

    /// v1 closes the runtime scope with `dispose` (adapter.ts:5547), which interrupts the request
    /// handlers and aborts their fetch (mcpOverAcpBridge.ts:121-123): a call in flight ends when
    /// the session stops, and nothing connects afterwards (round 7 part 3.3).
    #[tokio::test]
    async fn dispose_stops_calls_in_flight_and_later_connects() {
        // Opens a session on initialize, then holds every other request and the DELETE.
        let endpoint = Endpoint::serve(|mut stream, held| {
            let (request_line, body) = read_request(&stream);
            let message: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
            if request_line.is_empty() {
                return;
            }
            if request_line.starts_with("DELETE") || message["method"] != "initialize" {
                held.push(stream);
                return;
            }
            let reply = json!({"jsonrpc": "2.0", "id": message["id"], "result": {"protocolVersion": "2025-06-18", "capabilities": {}, "serverInfo": {"name": "goat", "version": "0"}}}).to_string();
            let _ = write!(
                stream,
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\nmcp-session-id: s-1\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{reply}",
                reply.len()
            );
        });
        let bridge = Arc::new(McpOverAcp::new(endpoint.url.clone(), "Bearer t"));
        let connected = bridge
            .connect(&json!({"serverId": crate::mcp::SERVER_NAME}))
            .unwrap();
        let id = connected["connectionId"].as_str().unwrap().to_owned();
        bridge
            .message(&json!({"connectionId": id, "method": "initialize", "params": {}}))
            .await
            .unwrap();
        let call = {
            let bridge = Arc::clone(&bridge);
            tokio::spawn(async move {
                bridge
                    .message(&json!({"connectionId": id, "method": "tools/call"}))
                    .await
            })
        };
        // Single-threaded test runtime: the call runs to its first wait, inside the relay.
        for _ in 0..8 {
            tokio::task::yield_now().await;
        }
        // Virtual time from here: the DELETE of the never-answering endpoint waits out its timeout.
        tokio::time::pause();
        let started = tokio::time::Instant::now();
        bridge.dispose().await;
        assert!(
            started.elapsed() >= DISCONNECT_TIMEOUT,
            "dispose did not wait for the session's DELETE"
        );
        let result = tokio::time::timeout(Duration::from_secs(1), call)
            .await
            .expect("the call ended when the session was disposed")
            .unwrap();
        assert_eq!(result.unwrap_err(), "The MCP call was stopped.");
        assert!(
            bridge
                .connect(&json!({"serverId": crate::mcp::SERVER_NAME}))
                .is_err(),
            "a connect after dispose was accepted"
        );
    }
}
