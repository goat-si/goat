//! Mistral Vibe (`mistral-vibe`, local `vibe` / `mistral-vibe` / `vibe-acp`). v1
//! `packages/provider-acp-registry/src/server/adapter.ts@916b5ccc1b2` (100-145).

use serde_json::Value;

use crate::flavor::FlavorEvent;

/// Mistral Vibe (v2.25.5) reports SDK backoff through this ACP extension.
pub const MISTRAL_VIBE_RETRYING: &str = "_session/retrying";

/// v1 `registerMistralVibeAcpExtensions` (:109-129). v1 reports a retryable provider failure on
/// the run (`reportProviderRetry`); GOAT 2 has no retry event, so the detail becomes a warning
/// notice in the turn.
pub fn mistral_vibe_retry_notice(params: &Value) -> Vec<FlavorEvent> {
    let (Some(_session), Some(category), Some(detail)) = (
        params.get("sessionId").and_then(Value::as_str),
        params.get("category").and_then(Value::as_str),
        params.get("detail").and_then(Value::as_str),
    ) else {
        return vec![];
    };
    if !matches!(
        category,
        "rate_limited" | "server_error" | "timed_out" | "connection" | "unknown"
    ) {
        return vec![];
    }
    vec![FlavorEvent::Notice {
        message: detail.to_owned(),
        warning: true,
    }]
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn retry_notices() {
        assert_eq!(
            mistral_vibe_retry_notice(
                &json!({"sessionId": "s", "category": "rate_limited", "detail": "Rate limited, retrying"})
            ),
            vec![FlavorEvent::Notice {
                message: "Rate limited, retrying".into(),
                warning: true
            }]
        );
        assert!(
            mistral_vibe_retry_notice(
                &json!({"sessionId": "s", "category": "other", "detail": "x"})
            )
            .is_empty()
        );
    }
}
