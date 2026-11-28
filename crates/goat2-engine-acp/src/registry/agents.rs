//! Registry-agent protocol helpers. These helpers are not yet wired into the shared driver.

use serde_json::Value;

/// Devin routes child updates to the parent agent, and assigns streaming chunks a message ID.
/// v1 `packages/provider-acp-registry/src/server/devinAcp.ts:11-30`.
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
    use serde_json::json;

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
}
