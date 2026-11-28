//! Devin (`devin acp`). v1 `packages/provider-acp-registry/src/server/devinAcp.ts@916b5ccc1b2`.

use serde_json::{Map, Value, json};

use crate::flavor::SubagentUpdate;
use crate::items::ToolState;
use goat2_contracts::TurnItemStatus;

fn record(value: Option<&Value>) -> Option<&Map<String, Value>> {
    value.and_then(Value::as_object)
}

/// v1 `adapter.ts:323-328`: Devin streams subagents and groups chunks only for clients that opt in.
pub fn devin_client_capabilities_meta() -> Map<String, Value> {
    let mut meta = Map::new();
    meta.insert("cognition.ai/subagentSupport".into(), json!(true));
    meta.insert("cognition.ai/messageGrouping".into(), json!(true));
    meta
}

/// Devin routes child updates to the child agent's session, and assigns streaming chunks a
/// message ID. v1 `devinAcp.ts:11-30`.
pub fn normalize_devin_session_update(mut notification: Value) -> Value {
    let Some(update) = notification.get("update") else {
        return notification;
    };
    let meta = update.get("_meta");
    let parent = meta
        .and_then(|m| m.get("cognition.ai/subagent_context"))
        .and_then(|c| c.get("parentAgentId"))
        .and_then(Value::as_str)
        .filter(|p| *p != "root")
        .map(str::to_owned);
    let message = match update.get("sessionUpdate").and_then(Value::as_str) {
        Some("agent_message_chunk" | "agent_thought_chunk") => meta
            .and_then(|m| m.get("cognition.ai/streamingMessageId"))
            .and_then(Value::as_str)
            .map(str::to_owned),
        _ => None,
    };
    if let Some(parent) = parent {
        notification["sessionId"] = parent.into();
    }
    if let Some(message) = message {
        notification["update"]["messageId"] = message.into();
    }
    notification
}

/// v1 `devinAcp.ts:32-37`: a missing, empty or generic `Tool` title takes Devin's inference tool
/// name (v1 `!tool.title` is true for "", devinAcp.ts:34; round 7 part 7.4).
pub fn normalize_devin_tool_call(mut tool: ToolState) -> ToolState {
    let name = record(tool.meta.as_ref())
        .and_then(|m| m.get("cognition.ai/inferenceToolName"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    if let Some(name) = name
        && tool
            .title
            .as_deref()
            .is_none_or(|t| t.is_empty() || t == "Tool")
    {
        tool.title = Some(name);
    }
    tool
}

/// v1 `devinAcp.ts:39-56`: a tool call carrying `subagent_started` / `subagent_completed`.
pub fn extract_devin_subagent(tool: &ToolState) -> Option<SubagentUpdate> {
    let meta = record(tool.meta.as_ref());
    let completed = record(meta.and_then(|m| m.get("cognition.ai/subagent_completed")));
    let started = record(meta.and_then(|m| m.get("cognition.ai/subagent_started")));
    let data = completed.or(started)?;
    let agent_id = data.get("agentId")?.as_str()?;
    let text = |key: &str| {
        started
            .and_then(|s| s.get(key))
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    Some(SubagentUpdate {
        native_task_id: agent_id.to_owned(),
        child_session_id: Some(agent_id.to_owned()),
        prompt: text("task").unwrap_or_default(),
        title: text("title"),
        model: text("model"),
        status: match completed {
            Some(c) if c.get("success") == Some(&Value::Bool(false)) => TurnItemStatus::Failed,
            Some(_) => TurnItemStatus::Completed,
            None => TurnItemStatus::Running,
        },
        result: completed
            .and_then(|c| c.get("summary"))
            .and_then(Value::as_str)
            .map(str::to_owned),
    })
}

/// v1 `devinAcp.ts:58-63`: exclude the plan bypass option before selecting a response.
pub fn devin_answerable_permission_options(options: &[Value]) -> Vec<Value> {
    options
        .iter()
        .filter(|option| {
            option
                .get("optionId")
                .and_then(Value::as_str)
                .is_none_or(|id| id.trim() != "plan_bypass")
        })
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn devin_routes_child_and_groups_chunks_without_rewriting_other_updates() {
        let update = json!({"sessionId":"session", "update": {"sessionUpdate":"agent_message_chunk", "_meta": {"cognition.ai/subagent_context":{"parentAgentId":"child"}, "cognition.ai/streamingMessageId":"m1"}}});
        let result = normalize_devin_session_update(update.clone());
        assert_eq!(result["sessionId"], "child");
        assert_eq!(result["update"]["messageId"], "m1");
        let root = json!({"sessionId":"session", "update":{"sessionUpdate":"tool_call", "_meta":{"cognition.ai/subagent_context":{"parentAgentId":"root"}, "cognition.ai/streamingMessageId":"m1"}}});
        assert_eq!(normalize_devin_session_update(root.clone()), root);
        assert_eq!(normalize_devin_session_update(Value::Null), Value::Null);
    }

    #[test]
    fn devin_filters_bypass_regardless_of_order() {
        let options = vec![
            json!({"optionId":" plan_bypass ","kind":"allow_once"}),
            json!({"optionId":"safe", "kind":"allow_once"}),
        ];
        assert_eq!(
            devin_answerable_permission_options(&options),
            vec![options[1].clone()]
        );
    }

    fn tool(meta: Value, title: Option<&str>) -> ToolState {
        ToolState {
            tool_call_id: "t1".into(),
            title: title.map(str::to_owned),
            meta: Some(meta),
            ..ToolState::default()
        }
    }

    #[test]
    fn devin_tool_titles_and_subagents() {
        let named = json!({"cognition.ai/inferenceToolName": "grep"});
        assert_eq!(
            normalize_devin_tool_call(tool(named.clone(), None))
                .title
                .as_deref(),
            Some("grep")
        );
        assert_eq!(
            normalize_devin_tool_call(tool(named.clone(), Some("Tool")))
                .title
                .as_deref(),
            Some("grep")
        );
        assert_eq!(
            normalize_devin_tool_call(tool(named.clone(), Some("")))
                .title
                .as_deref(),
            Some("grep")
        );
        assert_eq!(
            normalize_devin_tool_call(tool(named, Some("Search")))
                .title
                .as_deref(),
            Some("Search")
        );

        let started = extract_devin_subagent(&tool(json!({"cognition.ai/subagent_started": {"agentId": "a1", "task": "look", "title": "Look", "model": "m"}}), None)).unwrap();
        assert_eq!(started.native_task_id, "a1");
        assert_eq!(started.child_session_id.as_deref(), Some("a1"));
        assert_eq!(started.prompt, "look");
        assert_eq!(started.status, TurnItemStatus::Running);
        let failed = extract_devin_subagent(&tool(json!({"cognition.ai/subagent_completed": {"agentId": "a1", "success": false, "summary": "no"}}), None)).unwrap();
        assert_eq!(failed.status, TurnItemStatus::Failed);
        assert_eq!(failed.result.as_deref(), Some("no"));
        assert_eq!(failed.prompt, "");
        let done = extract_devin_subagent(&tool(
            json!({"cognition.ai/subagent_completed": {"agentId": "a1"}}),
            None,
        ))
        .unwrap();
        assert_eq!(done.status, TurnItemStatus::Completed);
        assert!(
            extract_devin_subagent(&tool(
                json!({"cognition.ai/subagent_started": {"task": "x"}}),
                None
            ))
            .is_none()
        );
    }
}
