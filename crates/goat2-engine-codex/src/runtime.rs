//! Turn settings ported from GOAT v1 `apps/server/src/orchestration-v2/Adapters/
//! CodexTurnStartParams.ts` (goat origin/dev 916b5ccc): the runtime-mode table (:46-92) and the
//! per-turn fields built from the model selection (:107-127, :183-208).

use serde_json::{Value, json};

use crate::contract::{ModelSelection, ProviderOptionSelectionValue, RuntimeMode};

/// Approval policy, reviewer and sandbox policy a runtime mode sends with every turn.
#[derive(Debug, Clone, PartialEq)]
pub struct RuntimeDefaults {
    pub approval_policy: Value,
    pub approvals_reviewer: &'static str,
    pub sandbox_policy: Value,
}

/// v1 `codexRuntimeModeTurnDefaults` (CodexTurnStartParams.ts:46-92).
pub fn runtime_defaults(mode: RuntimeMode) -> RuntimeDefaults {
    match mode {
        RuntimeMode::ApprovalRequired => RuntimeDefaults {
            approval_policy: json!("untrusted"),
            approvals_reviewer: "user",
            sandbox_policy: json!({ "type": "readOnly" }),
        },
        RuntimeMode::AutoAcceptEdits => RuntimeDefaults {
            approval_policy: json!("on-request"),
            approvals_reviewer: "user",
            sandbox_policy: json!({ "type": "workspaceWrite" }),
        },
        RuntimeMode::Auto => RuntimeDefaults {
            approval_policy: json!("on-request"),
            approvals_reviewer: "auto_review",
            sandbox_policy: json!({ "type": "workspaceWrite" }),
        },
        RuntimeMode::FullAccess => RuntimeDefaults {
            approval_policy: json!({
                "granular": {
                    "mcp_elicitations": true,
                    "request_permissions": false,
                    "rules": false,
                    "sandbox_approval": false,
                    "skill_approval": false,
                }
            }),
            approvals_reviewer: "user",
            sandbox_policy: json!({ "type": "dangerFullAccess" }),
        },
    }
}

/// v1 `getModelSelectionStringOptionValue` (packages/shared/src/model.ts:71).
pub fn string_option<'a>(selection: &'a ModelSelection, id: &str) -> Option<&'a str> {
    option(selection, id).and_then(|value| match value {
        ProviderOptionSelectionValue::Text(text) => Some(text.as_str()),
        ProviderOptionSelectionValue::Flag(_) => None,
    })
}

/// v1 `getModelSelectionBooleanOptionValue`.
pub fn bool_option(selection: &ModelSelection, id: &str) -> Option<bool> {
    option(selection, id).and_then(|value| match value {
        ProviderOptionSelectionValue::Flag(flag) => Some(*flag),
        ProviderOptionSelectionValue::Text(_) => None,
    })
}

fn option<'a>(selection: &'a ModelSelection, id: &str) -> Option<&'a ProviderOptionSelectionValue> {
    selection
        .options
        .as_ref()?
        .iter()
        .find(|option| option.id == id)
        .map(|option| &option.value)
}

/// v1 `codexModelFamily` (packages/shared/src/model.ts:387).
fn codex_model_family(slug: &str) -> &str {
    match slug.strip_prefix("openai.") {
        Some(rest) if rest.starts_with("gpt-") => rest,
        _ => slug,
    }
}

/// v1 `codexDefaultReasoningEffortOverride` (provider/CodexProvider.ts:170).
pub fn default_effort_override(model: &str) -> Option<&'static str> {
    (codex_model_family(model) == "gpt-6-astra").then_some("medium")
}

/// v1 CodexTurnStartParams.ts:107-111: the selected effort, else the model's override.
pub fn reasoning_effort(selection: &ModelSelection) -> Option<String> {
    string_option(selection, "reasoningEffort")
        .map(str::to_string)
        .or_else(|| default_effort_override(&selection.model).map(str::to_string))
}

/// v1 `getCodexServiceTierOptionValue` (apps/server/src/codexModelOptions.ts:7-13).
pub fn service_tier(selection: &ModelSelection) -> Option<String> {
    string_option(selection, "serviceTier")
        .map(str::to_string)
        .or_else(|| (bool_option(selection, "fastMode") == Some(true)).then(|| "fast".to_string()))
}

/// v1 CodexTurnStartParams.ts:201-207: Codex keeps no per-thread choice, so every turn sends
/// the collaboration mode with the model and effort. Part 1 has no Plan interaction mode.
pub fn collaboration_mode(model: &str, effort: Option<&str>) -> Value {
    let mut settings = json!({ "model": model });
    if let Some(effort) = effort {
        settings["reasoning_effort"] = json!(effort);
    }
    json!({ "mode": "default", "settings": settings })
}
