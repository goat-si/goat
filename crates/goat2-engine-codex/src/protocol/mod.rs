//! JSON-RPC envelope used by `codex app-server` over stdio: one JSON object per line, no `jsonrpc`
//! field. Requests carry `id` + `method`, notifications only `method`, responses `id` + `result`
//! or `id` + `error`.

pub mod client;
pub mod server;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

/// JSON-RPC method-not-found error code.
pub const METHOD_NOT_FOUND: i64 = -32601;
/// JSON-RPC internal error code.
pub const INTERNAL_ERROR: i64 = -32603;

/// A JSON-RPC request id. Codex uses integers for its own requests; GOAT does too.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RpcId {
    Int(i64),
    Str(String),
}

impl std::fmt::Display for RpcId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Int(value) => write!(f, "{value}"),
            Self::Str(value) => f.write_str(value),
        }
    }
}

/// The `error` member of a JSON-RPC error response.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, thiserror::Error)]
#[error("{message} (code {code})")]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl RpcError {
    pub fn method_not_found(method: &str) -> Self {
        Self {
            code: METHOD_NOT_FOUND,
            message: format!("GOAT does not handle {method}"),
            data: None,
        }
    }
}

/// One frame read from Codex.
#[derive(Debug, Clone, PartialEq)]
pub enum Incoming {
    Response {
        id: RpcId,
        result: Value,
    },
    Error {
        id: RpcId,
        error: RpcError,
    },
    Notification {
        method: String,
        params: Value,
    },
    Request {
        id: RpcId,
        method: String,
        params: Value,
    },
}

/// Why a line could not be read as a frame.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum ProtocolError {
    #[error("line is not JSON: {0}")]
    NotJson(String),
    #[error("frame is not a JSON object")]
    NotObject,
    #[error("frame has neither a method nor a result/error: {0}")]
    Unclassified(String),
    #[error("frame has an invalid id or error member: {0}")]
    BadMember(String),
}

/// Classify one line from Codex.
pub fn parse_incoming(line: &str) -> Result<Incoming, ProtocolError> {
    let value: Value =
        serde_json::from_str(line).map_err(|error| ProtocolError::NotJson(error.to_string()))?;
    classify(value)
}

/// Classify an already parsed frame (used by tests and the transcript tools).
pub fn classify(value: Value) -> Result<Incoming, ProtocolError> {
    let Value::Object(mut object) = value else {
        return Err(ProtocolError::NotObject);
    };
    let id = match object.remove("id") {
        None | Some(Value::Null) => None,
        Some(raw) => Some(
            serde_json::from_value::<RpcId>(raw)
                .map_err(|error| ProtocolError::BadMember(error.to_string()))?,
        ),
    };
    let params = object.remove("params").unwrap_or(Value::Null);
    match (id, object.remove("method")) {
        (Some(id), Some(Value::String(method))) => Ok(Incoming::Request { id, method, params }),
        (None, Some(Value::String(method))) => Ok(Incoming::Notification { method, params }),
        (Some(id), None) => {
            if let Some(error) = object.remove("error") {
                let error = serde_json::from_value::<RpcError>(error)
                    .map_err(|error| ProtocolError::BadMember(error.to_string()))?;
                Ok(Incoming::Error { id, error })
            } else if let Some(result) = object.remove("result") {
                Ok(Incoming::Response { id, result })
            } else {
                Err(ProtocolError::Unclassified(
                    Value::Object(object).to_string(),
                ))
            }
        }
        (_, other) => Err(ProtocolError::Unclassified(format!(
            "method member: {other:?}"
        ))),
    }
}

fn with_params(mut frame: Map<String, Value>, params: Value) -> Value {
    if !params.is_null() {
        frame.insert("params".into(), params);
    }
    Value::Object(frame)
}

/// `{"id", "method", "params"}`.
pub fn request_frame(id: &RpcId, method: &str, params: Value) -> Value {
    let mut frame = Map::new();
    frame.insert("id".into(), json!(id));
    frame.insert("method".into(), json!(method));
    with_params(frame, params)
}

/// `{"method", "params"}`.
pub fn notification_frame(method: &str, params: Value) -> Value {
    let mut frame = Map::new();
    frame.insert("method".into(), json!(method));
    with_params(frame, params)
}

/// `{"id", "result"}`.
pub fn response_frame(id: &RpcId, result: Value) -> Value {
    json!({ "id": id, "result": result })
}

/// `{"id", "error"}`.
pub fn error_frame(id: &RpcId, error: &RpcError) -> Value {
    json!({ "id": id, "error": error })
}

/// Method names GOAT sends or reads.
pub mod methods {
    pub const INITIALIZE: &str = "initialize";
    pub const INITIALIZED: &str = "initialized";
    pub const THREAD_START: &str = "thread/start";
    pub const THREAD_RESUME: &str = "thread/resume";
    pub const THREAD_TURNS_LIST: &str = "thread/turns/list";
    pub const CONFIG_READ: &str = "config/read";
    pub const TURN_START: &str = "turn/start";
    pub const TURN_STEER: &str = "turn/steer";
    pub const TURN_INTERRUPT: &str = "turn/interrupt";

    pub const ERROR: &str = "error";
    pub const THREAD_STARTED: &str = "thread/started";
    pub const THREAD_STATUS_CHANGED: &str = "thread/status/changed";
    pub const THREAD_CLOSED: &str = "thread/closed";
    pub const TURN_STARTED: &str = "turn/started";
    pub const TURN_COMPLETED: &str = "turn/completed";
    pub const TURN_PLAN_UPDATED: &str = "turn/plan/updated";
    pub const ITEM_STARTED: &str = "item/started";
    pub const ITEM_COMPLETED: &str = "item/completed";
    pub const AGENT_MESSAGE_DELTA: &str = "item/agentMessage/delta";
    pub const PLAN_DELTA: &str = "item/plan/delta";
    pub const REASONING_SUMMARY_DELTA: &str = "item/reasoning/summaryTextDelta";
    pub const REASONING_TEXT_DELTA: &str = "item/reasoning/textDelta";
    pub const COMMAND_OUTPUT_DELTA: &str = "item/commandExecution/outputDelta";
    pub const FILE_CHANGE_OUTPUT_DELTA: &str = "item/fileChange/outputDelta";
    pub const SERVER_REQUEST_RESOLVED: &str = "serverRequest/resolved";
    pub const TOKEN_USAGE_UPDATED: &str = "thread/tokenUsage/updated";
    pub const MCP_STARTUP_STATUS: &str = "mcpServer/startupStatus/updated";

    pub const COMMAND_APPROVAL: &str = "item/commandExecution/requestApproval";
    pub const FILE_CHANGE_APPROVAL: &str = "item/fileChange/requestApproval";
    pub const PERMISSIONS_APPROVAL: &str = "item/permissions/requestApproval";
    pub const USER_INPUT: &str = "item/tool/requestUserInput";
    pub const ELICITATION: &str = "mcpServer/elicitation/request";
}
