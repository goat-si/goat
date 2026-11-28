//! Helpers shared by the agents' own elicitation forms (Droid, omp, OpenCode).

use std::sync::OnceLock;

use goat2_contracts::UserInputOption;
use regex::Regex;
use serde_json::{Map, Value};

/// v1 `TrimmedNonEmptyString` as `Schema.is` checks it: a string that is not blank.
pub(super) fn non_blank(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
}

/// `Schema.optional(Schema.String)`: absent is fine, present must be a string.
pub(super) fn optional_str<'a>(
    object: &'a Map<String, Value>,
    key: &str,
) -> Result<Option<&'a str>, ()> {
    match object.get(key) {
        None => Ok(None),
        Some(Value::String(s)) => Ok(Some(s)),
        Some(_) => Err(()),
    }
}

/// v1 `request.mode !== "form"` and `requestedSchema.properties`.
pub(super) fn form_properties(params: &Value) -> Option<&Map<String, Value>> {
    if params.get("mode").and_then(Value::as_str).unwrap_or("form") != "form" {
        return None;
    }
    params
        .get("requestedSchema")?
        .get("properties")?
        .as_object()
}

pub(super) fn option(label: &str, description: &str, value: &str) -> UserInputOption {
    UserInputOption {
        label: label.to_owned(),
        description: description.to_owned(),
        value: Some(value.to_owned()),
        preview: None,
    }
}

/// Intake appends server attachment references to an answer (v1 droidAcp.ts:66-77,
/// opencodeAcp.ts:40-47): `\n\nAttached image|file "<name>": "...`.
pub(super) fn split_attachments(value: &str) -> Option<(&str, &str)> {
    static SUFFIX: OnceLock<Regex> = OnceLock::new();
    let suffix = SUFFIX.get_or_init(|| {
        Regex::new(r#"^\n\nAttached (?:image|file) "(?:\\.|[^"\\\r\n])*": ""#).expect("regex")
    });
    let marker = value.find("\n\n")?;
    let (prefix, rest) = value.split_at(marker);
    suffix.is_match(rest).then_some((prefix, rest))
}

pub(super) fn accept(content: Map<String, Value>) -> Value {
    serde_json::json!({"action": "accept", "content": content})
}

pub(super) fn cancel() -> Value {
    serde_json::json!({"action": "cancel"})
}
