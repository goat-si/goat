//! GitHub Copilot CLI (`github-copilot-cli`, local `copilot`). v1
//! `packages/provider-acp-registry/src/server/copilotAcp.ts@916b5ccc1b2` (whole file).
//!
//! Copilot reports background agents through its opt-in raw feed (`github.com/copilot/sessionEvent`).
//! Each `agent_*_chunk` is attributed to a task by the `assistant.*_delta` event just before it,
//! tool calls by their `_meta` agent id, and routed to the task's child session
//! `copilot-task:<toolCallId>`. v1 keeps this state per runtime; GOAT 2 runs one runtime per ACP
//! session, so it is kept per session id and released when the process ends.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Mutex;

use goat2_contracts::TurnItemStatus;
use serde_json::{Map, Value, json};

use crate::flavor::{FlavorEvent, PromptError, SubagentUpdate};
use crate::items::ToolState;

const COPILOT_META_KEY: &str = "github.com/copilot";
/// The raw-feed extension notification.
pub const COPILOT_SESSION_EVENT: &str = "github.com/copilot/sessionEvent";

/// v1 `copilotAcp.ts:16-29`.
pub fn copilot_client_capabilities_meta() -> Map<String, Value> {
    let mut meta = Map::new();
    meta.insert(
        COPILOT_META_KEY.into(),
        json!({"events": [
            "subagent.started",
            "subagent.completed",
            "subagent.failed",
            "assistant.message_delta",
            "assistant.reasoning_delta",
            "assistant.turn_start",
            "assistant.idle",
            "tool.execution_start",
        ]}),
    );
    meta
}

/// v1 `copilotAcp.ts:33-37`: Copilot keeps failing every prompt with these until replaced.
const COPILOT_LOST_SESSION_MARKERS: [&str; 2] = [
    "session event delivery failed: session not found: ",
    "session lock unavailable during is_session_generation_current: acquisition timed out",
];

/// v1 `copilotAcp.ts:39-49` (the driver calls it for `session/prompt` errors only).
pub fn is_copilot_lost_session_error(error: &PromptError) -> bool {
    if error.code != -32603 {
        return false;
    }
    // Older Copilot reports the cause in data.details; its native ACP layer (1.0.105) in the message.
    let details = error
        .data
        .as_ref()
        .and_then(Value::as_object)
        .and_then(|d| d.get("details"))
        .and_then(Value::as_str);
    [Some(error.message.as_str()), details]
        .into_iter()
        .flatten()
        .any(|text| {
            COPILOT_LOST_SESSION_MARKERS
                .iter()
                .any(|m| text.contains(m))
        })
}

/// v1 `copilotAcp.ts:64`.
pub fn copilot_child_session_id(task_tool_call_id: &str) -> String {
    format!("copilot-task:{task_tool_call_id}")
}

#[derive(Debug, Clone, PartialEq)]
enum ToolIdentity {
    Mcp { server: String, tool: String },
    Search,
}

const COPILOT_SEARCH_TOOLS: [&str; 3] = ["glob", "grep", "rg"];
const COPILOT_MAX_SEEN_CALLS: usize = 8192;
const COPILOT_MAX_SESSION_CALLS: usize = 256;
const COPILOT_MAX_TOTAL_CALLS: usize = 4096;

#[derive(Debug, Clone)]
struct Delta {
    kind: String,
    text: String,
    task: Option<String>,
}

#[derive(Debug, Default)]
struct Attribution {
    delta: Option<Delta>,
    task_by_agent_id: HashMap<String, String>,
    /// Insertion ordered (v1 Map order), oldest first.
    tool_identity_by_call_id: Vec<(String, ToolIdentity)>,
    seen_calls: HashSet<String>,
    disabled: bool,
}

/// v1 `copilotAcp.ts:84-91`.
fn copilot_tool_identity(data: &Map<String, Value>) -> Option<ToolIdentity> {
    let text = |key: &str| {
        data.get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default()
            .to_owned()
    };
    let (server, tool) = (text("mcpServerName"), text("mcpToolName"));
    if !server.is_empty() && !tool.is_empty() {
        return Some(ToolIdentity::Mcp { server, tool });
    }
    data.get("toolName")
        .and_then(Value::as_str)
        .filter(|name| COPILOT_SEARCH_TOOLS.contains(name))
        .map(|_| ToolIdentity::Search)
}

#[derive(Debug, Default)]
struct Routing {
    sessions: HashMap<String, Attribution>,
    /// Remembered identities across sessions, oldest first (v1 `pending`).
    pending: VecDeque<(String, String)>,
}

impl Routing {
    fn session(&mut self, session_id: &str) -> &mut Attribution {
        self.sessions.entry(session_id.to_owned()).or_default()
    }

    fn remove_identity(&mut self, session_id: &str, call_id: &str) {
        if let Some(current) = self.sessions.get_mut(session_id) {
            current
                .tool_identity_by_call_id
                .retain(|(id, _)| id != call_id);
        }
        self.pending
            .retain(|(session, call)| !(session == session_id && call == call_id));
    }

    /// v1 `remember` (:128-138).
    fn remember(&mut self, session_id: &str, call_id: &str) -> bool {
        let current = self.session(session_id);
        if current.disabled || current.seen_calls.contains(call_id) {
            return false;
        }
        if current.seen_calls.len() >= COPILOT_MAX_SEEN_CALLS {
            current.disabled = true;
            let ids: Vec<String> = current
                .tool_identity_by_call_id
                .iter()
                .map(|(id, _)| id.clone())
                .collect();
            for id in ids {
                self.remove_identity(session_id, &id);
            }
            return false;
        }
        current.seen_calls.insert(call_id.to_owned());
        true
    }
}

/// v1 `makeCopilotSubagentRouting` (:93-301).
#[derive(Debug, Default)]
pub struct CopilotRouting {
    routing: Mutex<Routing>,
}

impl CopilotRouting {
    /// v1 `registerExtensions` (:151-240): one `github.com/copilot/sessionEvent` notification.
    pub fn on_session_event(&self, params: &Value) -> Vec<FlavorEvent> {
        let Some(object) = params.as_object() else {
            return vec![];
        };
        let (Some(session_id), Some(kind)) = (
            object.get("sessionId").and_then(Value::as_str),
            object.get("type").and_then(Value::as_str),
        ) else {
            return vec![];
        };
        let agent_id = match object.get("agentId") {
            None => None,
            Some(Value::String(id)) => Some(id.as_str()),
            Some(_) => return vec![],
        };
        let empty = Map::new();
        let data = match object.get("data") {
            None => &empty,
            Some(Value::Object(data)) => data,
            Some(_) => return vec![],
        };
        let mut routing = self.routing.lock().expect("copilot routing");
        match kind {
            "assistant.message_delta" | "assistant.reasoning_delta" => {
                let Some(text) = data.get("deltaContent").and_then(Value::as_str) else {
                    return vec![];
                };
                let current = routing.session(session_id);
                // Copilot 1.0.114+ names a subagent's deltas only by agentId, without parentToolCallId.
                let task = match data.get("parentToolCallId").and_then(Value::as_str) {
                    Some(task) => Some(task.to_owned()),
                    None => agent_id.and_then(|a| current.task_by_agent_id.get(a).cloned()),
                };
                current.delta = Some(Delta {
                    kind: kind.to_owned(),
                    text: text.to_owned(),
                    task,
                });
                vec![]
            }
            "subagent.started" => {
                if let (Some(agent), Some(call)) =
                    (agent_id, data.get("toolCallId").and_then(Value::as_str))
                {
                    routing
                        .session(session_id)
                        .task_by_agent_id
                        .insert(agent.to_owned(), call.to_owned());
                }
                vec![]
            }
            "tool.execution_start" => {
                let identity = copilot_tool_identity(data);
                let id = data
                    .get("toolCallId")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if !id.is_empty()
                    && routing.remember(session_id, id)
                    && let Some(identity) = identity
                {
                    while routing.session(session_id).tool_identity_by_call_id.len()
                        >= COPILOT_MAX_SESSION_CALLS
                    {
                        let oldest = routing.session(session_id).tool_identity_by_call_id[0]
                            .0
                            .clone();
                        routing.remove_identity(session_id, &oldest);
                    }
                    while routing.pending.len() >= COPILOT_MAX_TOTAL_CALLS {
                        let Some((session, call)) = routing.pending.front().cloned() else {
                            break;
                        };
                        routing.remove_identity(&session, &call);
                    }
                    routing
                        .session(session_id)
                        .tool_identity_by_call_id
                        .push((id.to_owned(), identity));
                    routing
                        .pending
                        .push_back((session_id.to_owned(), id.to_owned()));
                }
                vec![]
            }
            "subagent.completed" | "subagent.failed" => {
                if let (Some(current), Some(agent)) =
                    (routing.sessions.get_mut(session_id), agent_id)
                {
                    current.task_by_agent_id.remove(agent);
                }
                let Some(call) = data.get("toolCallId").and_then(Value::as_str) else {
                    return vec![];
                };
                // Background tasks end only here; their tool call settles at launch.
                vec![FlavorEvent::FinishSubagent {
                    session_id: session_id.to_owned(),
                    child_session_id: copilot_child_session_id(call),
                    status: if kind == "subagent.failed" {
                        TurnItemStatus::Failed
                    } else {
                        TurnItemStatus::Completed
                    },
                    result: data.get("error").and_then(Value::as_str).map(str::to_owned),
                }]
            }
            // Copilot holds session/prompt while an attached async shell runs (github/copilot-cli#5293).
            "assistant.turn_start" | "assistant.idle" => {
                if agent_id.is_some() || data.get("aborted") == Some(&Value::Bool(true)) {
                    return vec![];
                }
                vec![FlavorEvent::ForegroundWork {
                    session_id: session_id.to_owned(),
                    running: kind == "assistant.turn_start",
                }]
            }
            _ => vec![],
        }
    }

    /// v1 `normalizeSessionUpdate` (:242-299).
    pub fn normalize_session_update(&self, notification: Value) -> Value {
        let Some(session_id) = notification
            .get("sessionId")
            .and_then(Value::as_str)
            .map(str::to_owned)
        else {
            return notification;
        };
        let Some(update) = notification.get("update") else {
            return notification;
        };
        let kind = update
            .get("sessionUpdate")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let is_tool = kind == "tool_call" || kind == "tool_call_update";
        let mut routing = self.routing.lock().expect("copilot routing");
        if !is_tool && !routing.sessions.contains_key(&session_id) {
            return notification;
        }
        let mut task = None;
        let mut normalized = notification.clone();
        if kind == "agent_message_chunk" || kind == "agent_thought_chunk" {
            let delta = routing.session(&session_id).delta.take();
            let want = if kind == "agent_message_chunk" {
                "assistant.message_delta"
            } else {
                "assistant.reasoning_delta"
            };
            let content = update.get("content");
            if let Some(delta) = delta
                && delta.kind == want
                && content.and_then(|c| c.get("type")).and_then(Value::as_str) == Some("text")
                && content.and_then(|c| c.get("text")).and_then(Value::as_str)
                    == Some(delta.text.as_str())
            {
                task = delta.task;
            }
        } else if is_tool {
            let agent = update
                .get("_meta")
                .and_then(|m| m.get(COPILOT_META_KEY))
                .and_then(|c| c.get("agentId"))
                .and_then(Value::as_str);
            let current = routing.session(&session_id);
            task = agent.and_then(|a| current.task_by_agent_id.get(a).cloned());
            let call = update
                .get("toolCallId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            let identity = current
                .tool_identity_by_call_id
                .iter()
                .find(|(id, _)| *id == call)
                .map(|(_, identity)| identity.clone());
            if !current.seen_calls.contains(&call) {
                routing.remember(&session_id, &call);
            }
            if let Some(identity) = identity {
                if matches!(
                    update.get("status").and_then(Value::as_str),
                    Some("completed" | "failed")
                ) {
                    routing.remove_identity(&session_id, &call);
                }
                match identity {
                    ToolIdentity::Search => {
                        normalized["update"]["kind"] = json!("search");
                    }
                    ToolIdentity::Mcp { server, tool } => {
                        let mut meta = update
                            .get("_meta")
                            .and_then(Value::as_object)
                            .cloned()
                            .unwrap_or_default();
                        meta.insert("serverId".into(), json!(server));
                        meta.insert("toolName".into(), json!(tool));
                        normalized["update"]["_meta"] = Value::Object(meta);
                    }
                }
            }
        }
        if let Some(task) = task {
            normalized["sessionId"] = json!(copilot_child_session_id(&task));
        }
        normalized
    }

    /// v1 `releaseRuntime` (:139-149) clears the whole runtime: every session and remembered
    /// identity. A flavor serves one agent process (catalog launch), so releasing its session
    /// releases them all (round 7 part 7.2).
    pub fn release(&self, _session_id: &str) {
        let mut routing = self.routing.lock().expect("copilot routing");
        routing.sessions.clear();
        routing.pending.clear();
    }
}

/// v1 `extractCopilotSubagentUpdate` (:304-326): Copilot's `task` tool.
pub fn extract_copilot_subagent(tool: &ToolState) -> Option<SubagentUpdate> {
    let input = tool.raw_input.as_ref()?.as_object()?;
    let agent_type = input.get("agent_type")?.as_str();
    let prompt = input.get("prompt")?.as_str();
    let (Some(_), Some(prompt)) = (agent_type, prompt) else {
        return None;
    };
    let output = tool
        .raw_output
        .as_ref()
        .and_then(Value::as_object)
        .and_then(|o| o.get("content"))
        .and_then(Value::as_str);
    let background = input.get("mode").and_then(Value::as_str) == Some("background");
    let status = match tool.status.as_deref() {
        Some("failed") => TurnItemStatus::Failed,
        Some("completed") if !background => TurnItemStatus::Completed,
        _ => TurnItemStatus::Running,
    };
    Some(SubagentUpdate {
        native_task_id: tool.tool_call_id.clone(),
        child_session_id: Some(copilot_child_session_id(&tool.tool_call_id)),
        prompt: prompt.to_owned(),
        title: input
            .get("description")
            .and_then(Value::as_str)
            .map(str::to_owned),
        model: input
            .get("model")
            .and_then(Value::as_str)
            .map(str::to_owned),
        status,
        result: if status != TurnItemStatus::Running {
            output.map(str::to_owned)
        } else {
            None
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(kind: &str, agent: Option<&str>, data: Value) -> Value {
        let mut event = json!({"sessionId": "s", "type": kind, "data": data});
        if let Some(agent) = agent {
            event["agentId"] = json!(agent);
        }
        event
    }

    fn chunk(kind: &str, text: &str) -> Value {
        json!({"sessionId": "s", "update": {"sessionUpdate": kind, "content": {"type": "text", "text": text}}})
    }

    #[test]
    fn deltas_route_the_next_matching_chunk_to_the_task() {
        let routing = CopilotRouting::default();
        // Unknown sessions pass through untouched.
        assert_eq!(
            routing.normalize_session_update(chunk("agent_message_chunk", "x")),
            chunk("agent_message_chunk", "x")
        );
        routing.on_session_event(&event(
            "subagent.started",
            Some("agent-1"),
            json!({"toolCallId": "task-1"}),
        ));
        routing.on_session_event(&event(
            "assistant.message_delta",
            Some("agent-1"),
            json!({"deltaContent": "hi"}),
        ));
        let routed = routing.normalize_session_update(chunk("agent_message_chunk", "hi"));
        assert_eq!(routed["sessionId"], "copilot-task:task-1");
        // The delta is used once; a mismatched kind or text stays on the root.
        assert_eq!(
            routing.normalize_session_update(chunk("agent_message_chunk", "hi"))["sessionId"],
            "s"
        );
        routing.on_session_event(&event(
            "assistant.reasoning_delta",
            None,
            json!({"deltaContent": "t", "parentToolCallId": "task-2"}),
        ));
        assert_eq!(
            routing.normalize_session_update(chunk("agent_message_chunk", "t"))["sessionId"],
            "s"
        );
        routing.on_session_event(&event(
            "assistant.reasoning_delta",
            None,
            json!({"deltaContent": "t", "parentToolCallId": "task-2"}),
        ));
        assert_eq!(
            routing.normalize_session_update(chunk("agent_thought_chunk", "t"))["sessionId"],
            "copilot-task:task-2"
        );
    }

    #[test]
    fn tools_are_attributed_and_identified() {
        let routing = CopilotRouting::default();
        routing.on_session_event(&event(
            "subagent.started",
            Some("agent-1"),
            json!({"toolCallId": "task-1"}),
        ));
        routing.on_session_event(&event(
            "tool.execution_start",
            None,
            json!({"toolCallId": "c1", "mcpServerName": " goat ", "mcpToolName": "thread.send"}),
        ));
        routing.on_session_event(&event(
            "tool.execution_start",
            None,
            json!({"toolCallId": "c2", "toolName": "rg"}),
        ));
        let mcp = routing.normalize_session_update(json!({"sessionId": "s", "update": {"sessionUpdate": "tool_call", "toolCallId": "c1", "kind": "read", "_meta": {"github.com/copilot": {"agentId": "agent-1"}}}}));
        assert_eq!(mcp["sessionId"], "copilot-task:task-1");
        assert_eq!(mcp["update"]["_meta"]["serverId"], "goat");
        assert_eq!(mcp["update"]["_meta"]["toolName"], "thread.send");
        let search = routing.normalize_session_update(json!({"sessionId": "s", "update": {"sessionUpdate": "tool_call_update", "toolCallId": "c2", "status": "completed", "kind": "read"}}));
        assert_eq!(search["update"]["kind"], "search");
        assert_eq!(search["sessionId"], "s");
        // A finished call forgets its identity.
        let again = routing.normalize_session_update(json!({"sessionId": "s", "update": {"sessionUpdate": "tool_call_update", "toolCallId": "c2", "kind": "read"}}));
        assert_eq!(again["update"]["kind"], "read");
        routing.release("s");
        assert_eq!(
            routing.normalize_session_update(chunk("agent_message_chunk", "x"))["sessionId"],
            "s"
        );
        // Round 7 part 7.2: every session of the runtime is forgotten.
        {
            let state = routing.routing.lock().unwrap();
            assert!(state.sessions.is_empty() && state.pending.is_empty());
        }
    }

    #[test]
    fn subagent_end_and_foreground_events() {
        let routing = CopilotRouting::default();
        assert_eq!(
            routing.on_session_event(&event(
                "subagent.failed",
                Some("a"),
                json!({"toolCallId": "task-1", "error": "boom"})
            )),
            vec![FlavorEvent::FinishSubagent {
                session_id: "s".into(),
                child_session_id: "copilot-task:task-1".into(),
                status: TurnItemStatus::Failed,
                result: Some("boom".into())
            }]
        );
        assert_eq!(
            routing.on_session_event(&event("assistant.turn_start", None, json!({}))),
            vec![FlavorEvent::ForegroundWork {
                session_id: "s".into(),
                running: true
            }]
        );
        assert!(
            routing
                .on_session_event(&event("assistant.idle", Some("a"), json!({})))
                .is_empty()
        );
        assert!(
            routing
                .on_session_event(&event("assistant.idle", None, json!({"aborted": true})))
                .is_empty()
        );
        assert!(
            routing
                .on_session_event(&json!({"sessionId": "s", "type": "x", "agentId": 3}))
                .is_empty()
        );
    }

    #[test]
    fn session_identity_budget_drops_the_oldest() {
        let routing = CopilotRouting::default();
        for index in 0..(COPILOT_MAX_SESSION_CALLS + 1) {
            routing.on_session_event(&event(
                "tool.execution_start",
                None,
                json!({"toolCallId": format!("c{index}"), "toolName": "glob"}),
            ));
        }
        let oldest = routing.normalize_session_update(json!({"sessionId": "s", "update": {"sessionUpdate": "tool_call", "toolCallId": "c0", "kind": "read"}}));
        assert_eq!(oldest["update"]["kind"], "read");
        let newest = routing.normalize_session_update(json!({"sessionId": "s", "update": {"sessionUpdate": "tool_call", "toolCallId": format!("c{COPILOT_MAX_SESSION_CALLS}"), "kind": "read"}}));
        assert_eq!(newest["update"]["kind"], "search");
    }

    #[test]
    fn lost_session_and_task_tool() {
        let lost = |code, message: &str, data| PromptError {
            code,
            message: message.into(),
            data,
        };
        assert!(is_copilot_lost_session_error(&lost(
            -32603,
            "session event delivery failed: session not found: abc",
            None
        )));
        assert!(is_copilot_lost_session_error(&lost(
            -32603,
            "Internal error",
            Some(
                json!({"details": "session lock unavailable during is_session_generation_current: acquisition timed out"})
            )
        )));
        assert!(!is_copilot_lost_session_error(&lost(
            -32602,
            "session event delivery failed: session not found: abc",
            None
        )));
        let tool = |status: &str, mode: &str| ToolState {
            tool_call_id: "task-1".into(),
            status: Some(status.into()),
            raw_input: Some(
                json!({"agent_type": "explore", "prompt": "look", "description": "Look", "mode": mode}),
            ),
            raw_output: Some(json!({"content": "found"})),
            ..ToolState::default()
        };
        let done = extract_copilot_subagent(&tool("completed", "sync")).unwrap();
        assert_eq!(
            (done.status, done.result.as_deref()),
            (TurnItemStatus::Completed, Some("found"))
        );
        assert_eq!(
            done.child_session_id.as_deref(),
            Some("copilot-task:task-1")
        );
        let background = extract_copilot_subagent(&tool("completed", "background")).unwrap();
        assert_eq!(
            (background.status, background.result),
            (TurnItemStatus::Running, None)
        );
    }
}
