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
const DISCONNECT_TIMEOUT: Duration = Duration::from_secs(5);

struct Connection {
    relay: HttpRelay,
    /// Held while the MCP session is not negotiated yet, so initialization stays ordered.
    negotiation: tokio::sync::Mutex<()>,
    negotiated: AtomicBool,
    next_request_id: AtomicU64,
}

pub struct McpOverAcp {
    endpoint: String,
    authorization: String,
    connections: Mutex<HashMap<String, Arc<Connection>>>,
    next_connection: AtomicU64,
    /// Bumped by [McpOverAcp::stop_calls]; every call in flight races it (v1 `callsStopped`).
    stop: tokio::sync::watch::Sender<u64>,
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
        }
    }

    /// v1 `stopCalls` (mcpOverAcpBridge.ts:273-276, called when a turn is interrupted,
    /// adapter.ts:4459-4466): every call in flight fails now; later calls run normally.
    pub fn stop_calls(&self) {
        self.stop.send_modify(|n| *n += 1);
    }

    fn connection(&self, params: &Value) -> Result<Arc<Connection>, String> {
        let id = params
            .get("connectionId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        self.connections
            .lock()
            .expect("connections")
            .get(id)
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
        let mut payloads = Vec::new();
        connection
            .relay
            .send_raw(&body, |payload| {
                for entry in payload
                    .as_array()
                    .cloned()
                    .unwrap_or_else(|| vec![payload.clone()])
                {
                    payloads.push(entry);
                }
            })
            .await
            .map_err(|e| e.to_string())?;
        if payloads.iter().any(protocol_version) {
            connection.negotiated.store(true, Ordering::SeqCst);
        }
        Ok(payloads)
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
        let connection = self.connection(params)?;
        self.send(&connection, Self::envelope(params, None))
            .await
            .map(|_| ())
    }

    /// `mcp/disconnect`: end the HTTP session, then forget the connection.
    pub async fn disconnect(&self, params: &Value) -> Result<Value, String> {
        let connection = self.connection(params)?;
        let id = params
            .get("connectionId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        tokio::time::timeout(DISCONNECT_TIMEOUT, connection.relay.terminate())
            .await
            .map_err(|_| "GOAT MCP endpoint did not answer disconnect.".to_owned())?;
        self.connections.lock().expect("connections").remove(&id);
        Ok(json!({}))
    }

    /// v1 `dispose`: end every session (session shutdown).
    pub async fn dispose(&self) {
        let ids: Vec<String> = self
            .connections
            .lock()
            .expect("connections")
            .keys()
            .cloned()
            .collect();
        for id in ids {
            let _ = self.disconnect(&json!({ "connectionId": id })).await;
        }
    }
}
