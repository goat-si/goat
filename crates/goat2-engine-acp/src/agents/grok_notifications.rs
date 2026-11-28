//! xAI extension notifications: background task lifecycle, subagent ends, wake turns and
//! prompt completion carried on session notifications.
//!
//! Ported from v1 `packages/provider-grok/src/server/xaiAcpExtension.ts`:
//! `xAiPromptCompleteFromSessionUpdate` (:57-76), `isXAiTaskCompletedWakeNotification` (:78-87),
//! `XAiTaskLifecycleNotification` / `xAiBackgroundTaskLifecycleMutation` /
//! `registerXAiBackgroundTaskTracking` (:382-485), `xAiSubagentFinishedNotice` /
//! `registerXAiSubagentFinished` (:487-524). v1 decodes each payload with an Effect schema and drops
//! a notification that does not decode; GOAT 2 checks the same fields by hand.

use serde_json::{Map, Value};

use goat2_contracts::TurnItemStatus;

use crate::flavor::{BackgroundStatus, FlavorEvent};

use super::grok_tools::non_empty;

/// v1 `xAiSessionNotificationMethods` (xaiAcpExtension.ts:49-53).
pub const SESSION_NOTIFICATION_METHODS: [&str; 3] = [
    "x.ai/session_notification",
    "_x.ai/session_notification",
    "_x.ai/session/update",
];

/// v1 `registerXAiBackgroundTaskTracking` methods (xaiAcpExtension.ts:472-478).
const TASK_LIFECYCLE_METHODS: [(&str, BackgroundStatus); 4] = [
    ("x.ai/task_backgrounded", BackgroundStatus::Running),
    ("_x.ai/task_backgrounded", BackgroundStatus::Running),
    ("x.ai/task_completed", BackgroundStatus::Completed),
    ("_x.ai/task_completed", BackgroundStatus::Completed),
];

/// v1 `XAI_TASK_COMPLETED_PROMPT_ID_PREFIX`.
pub const TASK_COMPLETED_PROMPT_ID_PREFIX: &str = "task-completed-";

/// A string field that may be absent; a present non-string fails the decode.
fn opt_str<'a>(record: &'a Map<String, Value>, key: &str) -> Result<Option<&'a str>, ()> {
    match record.get(key) {
        None => Ok(None),
        Some(Value::String(s)) => Ok(Some(s)),
        Some(_) => Err(()),
    }
}

/// A nullable string field (`Schema.optional(Schema.NullOr(Schema.String))`).
fn opt_null_str<'a>(record: &'a Map<String, Value>, key: &str) -> Result<Option<&'a str>, ()> {
    match record.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s)),
        Some(_) => Err(()),
    }
}

/// The `{sessionId, update: {sessionUpdate}}` envelope every xAI session notification has.
fn envelope(params: &Value) -> Option<(&str, &Map<String, Value>)> {
    let session_id = params.get("sessionId")?.as_str()?;
    let update = params.get("update")?.as_object()?;
    update.get("sessionUpdate")?.as_str()?;
    Some((session_id, update))
}

/// v1 `isXAiTaskCompletedWakeNotification`: Grok answers a finished background command in a turn
/// of its own, tagging every frame with a `task-completed-*` prompt id.
pub fn is_task_completed_wake(params: &Value) -> bool {
    params
        .get("_meta")
        .and_then(|m| m.get("promptId"))
        .and_then(Value::as_str)
        .is_some_and(|id| id.starts_with(TASK_COMPLETED_PROMPT_ID_PREFIX))
}

/// v1 `xAiPromptCompleteFromSessionUpdate`: a root `turn_completed` with a prompt id GOAT sent, as
/// `(promptId, stopReason, agentResult)`.
pub fn prompt_complete_from_session_update(
    params: &Value,
) -> Option<(String, Option<String>, Option<Value>)> {
    let (_, update) = envelope(params)?;
    if update.get("sessionUpdate")?.as_str()? != "turn_completed" {
        return None;
    }
    // Require prompt identity to avoid matching background completions or unrelated turns.
    let prompt_id =
        non_empty(update.get("prompt_id")).or_else(|| non_empty(update.get("promptId")))?;
    if prompt_id.starts_with(TASK_COMPLETED_PROMPT_ID_PREFIX) {
        return None;
    }
    let stop_reason =
        non_empty(update.get("stop_reason")).or_else(|| non_empty(update.get("stopReason")));
    Some((prompt_id, stop_reason, update.get("agent_result").cloned()))
}

/// v1 `xAiBackgroundTaskLifecycleMutation` (xaiAcpExtension.ts:444-465) for one of the
/// `task_backgrounded` / `task_completed` methods. v1's wake `report` has no GOAT 2 consumer.
pub fn background_task_event(method: &str, params: &Value) -> Option<FlavorEvent> {
    let status = TASK_LIFECYCLE_METHODS
        .iter()
        .find(|(name, _)| *name == method)
        .map(|(_, status)| *status)?;
    let (session_id, update) = envelope(params)?;
    let task_id_field = opt_str(update, "task_id").ok()?;
    let tool_call_id = opt_str(update, "tool_call_id").ok()?;
    opt_str(update, "command").ok()?;
    opt_null_str(update, "description").ok()?;
    opt_null_str(update, "monitor_description").ok()?;
    let snapshot = match update.get("task_snapshot") {
        None => None,
        Some(Value::Object(snapshot)) => Some(snapshot),
        Some(_) => return None,
    };
    let (snapshot_task_id, output, exit_code) = match snapshot {
        Some(snapshot) => {
            let exit_code = match snapshot.get("exit_code") {
                None | Some(Value::Null) => None,
                Some(Value::Number(n)) => n.as_f64(),
                Some(_) => return None,
            };
            opt_str(snapshot, "command").ok()?;
            opt_null_str(snapshot, "display_command").ok()?;
            opt_null_str(snapshot, "description").ok()?;
            opt_str(snapshot, "kind").ok()?;
            (
                opt_str(snapshot, "task_id").ok()?,
                opt_str(snapshot, "output").ok()?,
                exit_code,
            )
        }
        None => (None, None, None),
    };
    let nonempty = |s: Option<&str>| {
        s.map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    let task_id = nonempty(snapshot_task_id)
        .or_else(|| nonempty(task_id_field))
        .or_else(|| nonempty(tool_call_id))?;
    let status = match (status, exit_code) {
        (BackgroundStatus::Completed, Some(code)) if code != 0.0 => BackgroundStatus::Failed,
        (status, _) => status,
    };
    Some(FlavorEvent::BackgroundTask {
        session_id: session_id.to_owned(),
        task_id,
        status,
        output: output.map(str::to_owned),
    })
}

/// v1 `xAiSubagentFinishedNotice` (xaiAcpExtension.ts:495-510): sent on the parent session.
pub fn subagent_finished_event(params: &Value) -> Option<FlavorEvent> {
    let (session_id, update) = envelope(params)?;
    for key in [
        "prompt_id",
        "promptId",
        "stop_reason",
        "stopReason",
        "child_session_id",
        "status",
    ] {
        opt_str(update, key).ok()?;
    }
    let output = opt_null_str(update, "output").ok()?;
    let error = opt_null_str(update, "error").ok()?;
    if update.get("sessionUpdate")?.as_str()? != "subagent_finished" {
        return None;
    }
    let child_session_id = non_empty(update.get("child_session_id"))?;
    let status = match update.get("status").and_then(Value::as_str) {
        Some("completed") => TurnItemStatus::Completed,
        Some("failed") => TurnItemStatus::Failed,
        Some("cancelled") => TurnItemStatus::Cancelled,
        _ => return None,
    };
    let text = if status == TurnItemStatus::Completed {
        output
    } else {
        error
    };
    Some(FlavorEvent::FinishSubagent {
        session_id: session_id.to_owned(),
        child_session_id,
        status,
        result: text
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn task_completed_with_a_failing_exit_code_fails_the_task() {
        let params = json!({"sessionId": "s", "update": {"sessionUpdate": "task_completed",
            "task_snapshot": {"task_id": "call-1-0", "output": "boom", "exit_code": 2, "kind": "bash"}}});
        assert_eq!(
            background_task_event("x.ai/task_completed", &params),
            Some(FlavorEvent::BackgroundTask {
                session_id: "s".into(),
                task_id: "call-1-0".into(),
                status: BackgroundStatus::Failed,
                output: Some("boom".into())
            })
        );
        let running = json!({"sessionId": "s", "update": {"sessionUpdate": "task_backgrounded", "tool_call_id": "t9"}});
        assert!(
            matches!(background_task_event("_x.ai/task_backgrounded", &running),
            Some(FlavorEvent::BackgroundTask { status: BackgroundStatus::Running, ref task_id, .. }) if task_id == "t9")
        );
        let malformed =
            json!({"sessionId": "s", "update": {"sessionUpdate": "task_completed", "task_id": 7}});
        assert_eq!(
            background_task_event("x.ai/task_completed", &malformed),
            None
        );
        assert_eq!(background_task_event("x.ai/other", &params), None);
    }

    #[test]
    fn subagent_finished_carries_output_or_error() {
        let done = json!({"sessionId": "s", "update": {"sessionUpdate": "subagent_finished",
            "child_session_id": "c1", "status": "completed", "output": " 42 ", "error": null}});
        assert_eq!(
            subagent_finished_event(&done),
            Some(FlavorEvent::FinishSubagent {
                session_id: "s".into(),
                child_session_id: "c1".into(),
                status: TurnItemStatus::Completed,
                result: Some("42".into())
            })
        );
        let failed = json!({"sessionId": "s", "update": {"sessionUpdate": "subagent_finished",
            "child_session_id": "c1", "status": "failed", "output": "x", "error": "crashed"}});
        assert!(
            matches!(subagent_finished_event(&failed), Some(FlavorEvent::FinishSubagent { result: Some(ref r), .. }) if r == "crashed")
        );
        let unknown = json!({"sessionId": "s", "update": {"sessionUpdate": "subagent_finished", "child_session_id": "c1", "status": "idle"}});
        assert_eq!(subagent_finished_event(&unknown), None);
    }

    #[test]
    fn wake_frames_carry_task_completed_prompt_ids() {
        assert!(is_task_completed_wake(
            &json!({"sessionId": "s", "_meta": {"promptId": "task-completed-call-1"}, "update": {}})
        ));
        assert!(!is_task_completed_wake(
            &json!({"sessionId": "s", "_meta": {"promptId": "acp-turn-s-1:1"}, "update": {}})
        ));
        assert_eq!(
            prompt_complete_from_session_update(
                &json!({"sessionId": "s", "update": {"sessionUpdate": "turn_completed", "prompt_id": "task-completed-1"}})
            ),
            None
        );
    }
}
