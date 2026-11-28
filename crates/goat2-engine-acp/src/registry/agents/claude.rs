//! claude-agent-acp (registry `claude-acp`). v1
//! `packages/provider-acp-registry/src/server/claudeAcp.ts@916b5ccc1b2` and the session environment
//! of `sessionEnvironmentKey.ts:7-22`.
//!
//! v1 reads these only while following the agent's work state, which needs negotiated ACP v2
//! (`adapter.ts:499-502`); on ACP v1 Agent/Task calls stay ordinary tools (`adapter.ts:465-468`).

use serde_json::{Map, Value};

use crate::flavor::{SubagentSessionEvent, SubagentUpdate};
use crate::items::{ToolState, unfinished_stop_message};
use goat2_contracts::TurnItemStatus;

/// v1 `sessionEnvironmentKey.ts:20`: claude-agent-acp's v2 protocol switch, on unless set.
pub const CLAUDE_AGENT_ACP_EXPERIMENTAL_V2: &str = "CLAUDE_AGENT_ACP_EXPERIMENTAL_V2";

struct AgentInput {
    prompt: String,
    description: Option<String>,
    model: Option<String>,
    run_in_background: Option<bool>,
}

fn optional_string(object: &Map<String, Value>, key: &str) -> Result<Option<String>, ()> {
    match object.get(key) {
        None => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        Some(_) => Err(()),
    }
}

/// v1 `claudeAcp.ts:11-18` (`decodeAgentInput`).
fn decode_agent_input(raw: Option<&Value>) -> Option<AgentInput> {
    let object = raw?.as_object()?;
    let prompt = object.get("prompt")?.as_str()?.to_owned();
    let run_in_background = match object.get("run_in_background") {
        None => None,
        Some(Value::Bool(b)) => Some(*b),
        Some(_) => return None,
    };
    Some(AgentInput {
        prompt,
        description: optional_string(object, "description").ok()?,
        model: optional_string(object, "model").ok()?,
        run_in_background,
    })
}

fn is_agent_tool(tool: &ToolState) -> bool {
    matches!(tool.name.as_deref(), Some("Agent" | "Task"))
}

/// v1 `claudeAcp.ts:25-32`.
pub fn is_claude_provisional_subagent_tool(tool: &ToolState) -> bool {
    is_agent_tool(tool)
        && !matches!(tool.status.as_deref(), Some("failed" | "completed"))
        && decode_agent_input(tool.raw_input.as_ref()).is_none()
}

/// v1 `claudeAcp.ts:34-58`.
pub fn extract_claude_subagent(tool: &ToolState) -> Option<SubagentUpdate> {
    if !is_agent_tool(tool) {
        return None;
    }
    let input = decode_agent_input(tool.raw_input.as_ref())?;
    let is_async = tool
        .meta
        .as_ref()
        .and_then(|m| m.get("claudeCode"))
        .and_then(|c| c.get("toolResponse"))
        .and_then(|r| r.get("isAsync"))
        .and_then(Value::as_bool);
    let background = input.run_in_background == Some(true) || is_async == Some(true);
    Some(SubagentUpdate {
        native_task_id: tool.tool_call_id.clone(),
        child_session_id: None,
        prompt: input.prompt,
        title: input.description,
        model: input.model,
        status: match tool.status.as_deref() {
            Some("failed") => TurnItemStatus::Failed,
            Some("completed") if !background => TurnItemStatus::Completed,
            _ => TurnItemStatus::Running,
        },
        result: None,
    })
}

/// v1 `claudeAcp.ts:80-119`: `subagent_update` (child state) and `session_message` (delegation;
/// its id is the Agent/Task or SendMessage tool-use id). `params` is the `session/update` params.
pub fn extract_claude_subagent_session_event(params: &Value) -> Option<SubagentSessionEvent> {
    let update = params.get("update")?;
    let session = params.get("sessionId").and_then(Value::as_str);
    match update.get("sessionUpdate").and_then(Value::as_str)? {
        "subagent_update" => {
            let child = update.get("sessionId")?.as_str()?.to_owned();
            let state = update.get("state")?.as_object()?;
            let kind = state.get("state")?.as_str()?;
            let stop = match state.get("stopReason") {
                None | Some(Value::Null) => None,
                Some(Value::String(s)) => Some(s.as_str()),
                Some(_) => return None,
            };
            let error = match state.get("error") {
                None | Some(Value::Null) => None,
                Some(error) => Some(error.get("message")?.as_str()?.to_owned()),
            };
            let unfinished = stop.and_then(unfinished_stop_message);
            let status = if kind == "running" || kind == "requires_action" {
                TurnItemStatus::Running
            } else if stop == Some("error") || unfinished.is_some() {
                TurnItemStatus::Failed
            } else if stop == Some("cancelled") || kind == "unknown" {
                TurnItemStatus::Cancelled
            } else {
                TurnItemStatus::Completed
            };
            Some(SubagentSessionEvent::State {
                child_session_id: child,
                parent_session_id: session.map(str::to_owned),
                status,
                result: error.or_else(|| unfinished.map(str::to_owned)),
            })
        }
        "session_message" => {
            let delegation_id = update.get("messageId")?.as_str()?.to_owned();
            let parent = optional_string(update.as_object()?, "senderSessionId").ok()?;
            let blocks = update.get("content")?.as_array()?;
            let mut texts = Vec::new();
            for block in blocks {
                let kind = block.get("type")?.as_str()?;
                let text = match block.get("text") {
                    None => None,
                    Some(Value::String(s)) => Some(s.clone()),
                    Some(_) => return None,
                };
                if kind == "text"
                    && let Some(text) = text
                {
                    texts.push(text);
                }
            }
            Some(SubagentSessionEvent::Delegation {
                child_session_id: session?.to_owned(),
                parent_session_id: parent,
                delegation_id,
                prompt: texts.join("\n"),
            })
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn agent(status: &str, input: Value, meta: Option<Value>) -> ToolState {
        ToolState {
            tool_call_id: "toolu_1".into(),
            name: Some("Agent".into()),
            status: Some(status.into()),
            raw_input: Some(input),
            meta,
            ..ToolState::default()
        }
    }

    #[test]
    fn agent_tools_become_subagents_once_their_input_arrives() {
        assert!(is_claude_provisional_subagent_tool(&agent(
            "pending",
            json!({}),
            None
        )));
        assert!(!is_claude_provisional_subagent_tool(&agent(
            "completed",
            json!({}),
            None
        )));
        let input = json!({"prompt": "find", "description": "Find it", "model": "haiku"});
        let running = extract_claude_subagent(&agent("in_progress", input.clone(), None)).unwrap();
        assert_eq!(running.native_task_id, "toolu_1");
        assert_eq!(running.title.as_deref(), Some("Find it"));
        assert_eq!(running.status, TurnItemStatus::Running);
        assert_eq!(
            extract_claude_subagent(&agent("completed", input.clone(), None))
                .unwrap()
                .status,
            TurnItemStatus::Completed
        );
        let async_meta = json!({"claudeCode": {"toolResponse": {"isAsync": true}}});
        assert_eq!(
            extract_claude_subagent(&agent("completed", input.clone(), Some(async_meta)))
                .unwrap()
                .status,
            TurnItemStatus::Running
        );
        assert!(extract_claude_subagent(&agent("completed", json!({"prompt": 1}), None)).is_none());
        let mut other = agent("completed", input, None);
        other.name = Some("Bash".into());
        assert!(extract_claude_subagent(&other).is_none());
    }

    #[test]
    fn child_state_and_delegation_events() {
        let state = |state: Value| json!({"sessionId": "root", "update": {"sessionUpdate": "subagent_update", "sessionId": "child", "state": state}});
        let event = |s| match extract_claude_subagent_session_event(&state(s)).unwrap() {
            SubagentSessionEvent::State { status, result, .. } => (status, result),
            other => panic!("{other:?}"),
        };
        assert_eq!(
            event(json!({"state": "running"})).0,
            TurnItemStatus::Running
        );
        assert_eq!(
            event(json!({"state": "idle", "stopReason": "end_turn"})).0,
            TurnItemStatus::Completed
        );
        assert_eq!(
            event(json!({"state": "idle", "stopReason": "cancelled"})).0,
            TurnItemStatus::Cancelled
        );
        assert_eq!(
            event(json!({"state": "unknown"})).0,
            TurnItemStatus::Cancelled
        );
        let failed =
            event(json!({"state": "idle", "stopReason": "error", "error": {"message": "boom"}}));
        assert_eq!(failed, (TurnItemStatus::Failed, Some("boom".into())));
        let refused = event(json!({"state": "idle", "stopReason": "refusal"}));
        assert_eq!(refused.0, TurnItemStatus::Failed);
        assert!(refused.1.is_some());
        let delegation = json!({"sessionId": "child", "update": {"sessionUpdate": "session_message", "messageId": "toolu_1", "senderSessionId": "root", "content": [{"type": "text", "text": "a"}, {"type": "image"}, {"type": "text", "text": "b"}]}});
        assert_eq!(
            extract_claude_subagent_session_event(&delegation),
            Some(SubagentSessionEvent::Delegation {
                child_session_id: "child".into(),
                parent_session_id: Some("root".into()),
                delegation_id: "toolu_1".into(),
                prompt: "a\nb".into(),
            })
        );
        assert!(
            extract_claude_subagent_session_event(
                &json!({"sessionId": "s", "update": {"sessionUpdate": "agent_message_chunk"}})
            )
            .is_none()
        );
    }
}
