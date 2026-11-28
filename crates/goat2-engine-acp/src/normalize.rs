//! v1 `effect-acp` session update normalization, plus the extra rules the shared runtime applies.
//!
//! v1: `packages/effect-acp/src/_internal/normalizeV1SessionUpdate.ts:1-59`. Updates are normalized as
//! JSON before anything reads them, so the per-agent flavors see the same shape v1 flavors saw.

use serde_json::{Map, Value, json};

/// Marker for updates GOAT does not understand (v1 `_t3_unknown`).
pub const UNKNOWN_UPDATE: &str = "_t3_unknown";

fn valid_notice(update: &Map<String, Value>) -> bool {
    // v1 decodeNoticeUpdate: severity string, non-empty title, optional nullable description/_meta.
    let severity_ok = update.get("severity").is_some_and(Value::is_string);
    let title_ok = update
        .get("title")
        .and_then(Value::as_str)
        .is_some_and(|t| !t.is_empty());
    let description_ok = match update.get("description") {
        None | Some(Value::Null) | Some(Value::String(_)) => true,
        Some(_) => false,
    };
    let meta_ok = match update.get("_meta") {
        None | Some(Value::Null) | Some(Value::Object(_)) => true,
        Some(_) => false,
    };
    severity_ok && title_ok && description_ok && meta_ok
}

/// v1 `normalizeV1SessionUpdate`: takes the whole `session/update` params and returns them fixed.
pub fn normalize_v1_session_update(mut params: Value) -> Value {
    let Some(update) = params.get_mut("update").and_then(Value::as_object_mut) else {
        return params;
    };
    let kind = update
        .get("sessionUpdate")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    match kind.as_str() {
        // A malformed notice must not reach consumers as one.
        "notice" if !valid_notice(update) => {
            let raw = Value::Object(update.clone());
            *update = Map::new();
            update.insert("sessionUpdate".into(), json!(UNKNOWN_UPDATE));
            update.insert("originalSessionUpdate".into(), json!("notice"));
            update.insert("raw".into(), raw);
        }
        // v1 defines a null tool name as unchanged; v2 consumers read null as a clear.
        "tool_call" | "tool_call_update" if update.get("name").is_some_and(Value::is_null) => {
            update.remove("name");
        }
        "available_commands_update" => {
            if let Some(commands) = update
                .get_mut("availableCommands")
                .and_then(Value::as_array_mut)
            {
                for command in commands.iter_mut().filter_map(Value::as_object_mut) {
                    match command.remove("input") {
                        Some(Value::Null) | None => {}
                        Some(input) => {
                            let hint = input.get("hint").cloned().unwrap_or(Value::Null);
                            command.insert("input".into(), json!({"type": "text", "hint": hint}));
                        }
                    }
                }
            }
        }
        _ => {}
    }
    params
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn malformed_notice_becomes_unknown() {
        let out = normalize_v1_session_update(json!({
            "sessionId": "s", "update": {"sessionUpdate": "notice", "severity": "info", "title": ""}
        }));
        assert_eq!(out["update"]["sessionUpdate"], UNKNOWN_UPDATE);
        assert_eq!(out["update"]["originalSessionUpdate"], "notice");
    }

    #[test]
    fn valid_notice_is_kept() {
        let out = normalize_v1_session_update(json!({
            "sessionId": "s", "update": {"sessionUpdate": "notice", "severity": "warning", "title": "Low quota"}
        }));
        assert_eq!(out["update"]["sessionUpdate"], "notice");
    }

    #[test]
    fn null_tool_name_is_dropped() {
        let out = normalize_v1_session_update(json!({
            "sessionId": "s", "update": {"sessionUpdate": "tool_call_update", "toolCallId": "t", "name": null}
        }));
        assert!(out["update"].get("name").is_none());
    }

    #[test]
    fn command_input_becomes_text_hint() {
        let out = normalize_v1_session_update(json!({
            "sessionId": "s", "update": {"sessionUpdate": "available_commands_update",
            "availableCommands": [{"name": "plan", "description": "d", "input": {"hint": "goal"}}, {"name": "x", "description": "d", "input": null}]}
        }));
        assert_eq!(
            out["update"]["availableCommands"][0]["input"],
            json!({"type": "text", "hint": "goal"})
        );
        assert!(out["update"]["availableCommands"][1].get("input").is_none());
    }
}
