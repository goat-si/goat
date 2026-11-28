//! Claude Code stream-json frames: one JSON object per line on stdin and stdout.
//!
//! Shapes follow the TypeScript Agent SDK the GOAT v1 adapter runs
//! (`@anthropic-ai/claude-agent-sdk@0.3.276` `sdk.d.ts`, `sdk.mjs` `ProcessTransport`/`Query`) and lane D's
//! notes (`docs/parity/claude-stream-json.md` R7, R9, R13, R18-R19, R30): control requests are
//! `{type:"control_request",request_id,request:{subtype,...}}`, answers are
//! `{type:"control_response",response:{subtype:"success"|"error",request_id,response|error}}`,
//! either side may withdraw its own request with `control_cancel_request`, and everything else is an
//! SDK message (`system`, `assistant`, `user`, `result`, `stream_event`, ...).

use serde_json::{Map, Value, json};

/// One line read from the CLI.
#[derive(Debug, Clone, PartialEq)]
pub enum Inbound {
    /// Answer to a request this side sent.
    ControlResponse {
        request_id: String,
        result: Result<Value, String>,
    },
    /// A request from the CLI (`can_use_tool`, `elicitation`, `hook_callback`, ...).
    ControlRequest { request_id: String, request: Value },
    /// The CLI no longer needs the answer to one of its requests (R13).
    ControlCancel { request_id: String },
    /// `keep_alive`: ignored (R30).
    KeepAlive,
    /// Any SDK message.
    Message(Value),
}

/// Parse one stdout line. Unknown message types are kept as [Inbound::Message] (R31).
pub fn parse_line(line: &str) -> Result<Inbound, String> {
    let value: Value = serde_json::from_str(line).map_err(|error| error.to_string())?;
    let Some(kind) = value.get("type").and_then(Value::as_str) else {
        return Err("frame without a type".to_string());
    };
    Ok(match kind {
        "control_response" => {
            let response = value.get("response").cloned().unwrap_or(Value::Null);
            let request_id = str_field(&response, "request_id").unwrap_or_default();
            let result = if response.get("subtype").and_then(Value::as_str) == Some("success") {
                Ok(response.get("response").cloned().unwrap_or(Value::Null))
            } else {
                Err(str_field(&response, "error")
                    .unwrap_or_else(|| "control request failed".into()))
            };
            Inbound::ControlResponse { request_id, result }
        }
        "control_request" => Inbound::ControlRequest {
            request_id: str_field(&value, "request_id").unwrap_or_default(),
            request: value.get("request").cloned().unwrap_or(Value::Null),
        },
        "control_cancel_request" => Inbound::ControlCancel {
            request_id: str_field(&value, "request_id").unwrap_or_default(),
        },
        "keep_alive" => Inbound::KeepAlive,
        _ => Inbound::Message(value),
    })
}

/// A string field of an object, if present.
pub fn str_field(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

/// `{type:"control_request",request_id,request}`.
pub fn control_request(request_id: &str, request: Value) -> Value {
    json!({"type": "control_request", "request_id": request_id, "request": request})
}

/// Success answer to a CLI request.
pub fn control_success(request_id: &str, response: Value) -> Value {
    json!({"type": "control_response", "response": {
        "subtype": "success", "request_id": request_id, "response": response
    }})
}

/// Error answer to a CLI request.
pub fn control_error(request_id: &str, error: &str) -> Value {
    json!({"type": "control_response", "response": {
        "subtype": "error", "request_id": request_id, "error": error
    }})
}

/// v1 `makeClaudeUserMessage` (`ClaudeUserMessage.ts:8-41`): a root user frame with optional
/// `priority` and `uuid`.
pub fn user_message(content: Value, uuid: Option<&str>, priority: Option<&str>) -> Value {
    let mut frame = Map::new();
    frame.insert("type".into(), json!("user"));
    frame.insert(
        "message".into(),
        json!({"role": "user", "content": content}),
    );
    frame.insert("parent_tool_use_id".into(), Value::Null);
    if let Some(priority) = priority {
        frame.insert("priority".into(), json!(priority));
    }
    if let Some(uuid) = uuid {
        frame.insert("uuid".into(), json!(uuid));
    }
    Value::Object(frame)
}

/// v1 `claudeEchoedPromptUuids` (`ClaudePromptFrames.ts:32-39`).
pub fn echoed_prompt_uuids(message: &Value) -> Vec<String> {
    if let Some(uuids) = message.get("user_message_uuids").and_then(Value::as_array) {
        return uuids
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect();
    }
    str_field(message, "user_message_uuid")
        .into_iter()
        .collect()
}

/// `parent_tool_use_id` of an assistant/user/stream frame; `None` for root frames.
pub fn parent_tool_use_id(message: &Value) -> Option<&str> {
    message.get("parent_tool_use_id").and_then(Value::as_str)
}
