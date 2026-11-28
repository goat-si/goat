//! Grok ACP behavior from provider-grok/src/server/acpSupport.ts:125-215,247-324
//! and adapter.ts:98-127,350-362 at v1 916b5ccc1b2.
use crate::{
    capabilities::acp_base_capabilities,
    flavor::{AcpFlavor, AuthPolicy, FlavorEvent, LaunchCommand, ModelWrite},
    policy::{Disposition, RuntimePolicy},
    wire::{InitializeInfo, SessionSetup},
};
use goat2_contracts::{
    ApprovalDecision, ApprovalOption, EngineDriver, ModelSelection, ProviderCapabilities,
    ProviderOptionSelectionValue, RuntimeMode,
};
use goat2_engine_api::{EngineError, SessionSpec};
use serde_json::{Map, Value, json};

/// `has_api_key` must reflect the resolved provider environment, without retaining the key.
#[derive(Debug, Default)]
pub struct Grok {
    pub has_api_key: bool,
}
impl AcpFlavor for Grok {
    fn driver(&self) -> &str {
        "grok"
    }
    fn engine_driver(&self) -> EngineDriver {
        EngineDriver::Grok
    }
    fn capabilities(&self) -> ProviderCapabilities {
        let mut c = acp_base_capabilities();
        c.sessions.supports_model_switch_in_session = true;
        c.threads.can_read_thread_snapshot = true;
        c.tools.supports_mcp_tools = true;
        c.checkpointing.provider_can_read_conversation_snapshot = true;
        c.subagents.supports_subagents = true;
        c.subagents.exposes_subagent_thread_ids = true;
        c.subagents.emits_subagent_lifecycle = true;
        c
    }
    fn launch(&self, s: &SessionSpec) -> Result<LaunchCommand, EngineError> {
        let args = match s.engine.runtime_mode {
            RuntimeMode::Auto => vec!["--permission-mode", "auto", "agent", "stdio"],
            RuntimeMode::FullAccess => vec!["agent", "--always-approve", "stdio"],
            _ => vec!["--permission-mode", "default", "agent", "stdio"],
        };
        Ok(LaunchCommand::new("grok", args).env("GROK_OAUTH2_REFERRER", "t3code"))
    }
    fn auth_policy(&self) -> AuthPolicy {
        AuthPolicy::OnRequired {
            method_id: Some(
                if self.has_api_key {
                    "xai.api_key"
                } else {
                    "cached_token"
                }
                .into(),
            ),
        }
    }
    fn initialize_meta(&self) -> Option<Map<String, Value>> {
        Some(
            json!({"clientType":"extension"})
                .as_object()
                .unwrap()
                .clone(),
        )
    }
    fn cancel_meta(&self) -> Option<Map<String, Value>> {
        Some(
            json!({"cancelTrigger":"ctrl_c"})
                .as_object()
                .unwrap()
                .clone(),
        )
    }
    fn restart_after_interrupt(&self) -> bool {
        true
    }
    fn supports_image_prompts(&self, _: &InitializeInfo) -> bool {
        true
    }
    fn permission_disposition(&self, p: &RuntimePolicy, r: &Value) -> Disposition {
        if p.runtime_mode == RuntimeMode::Auto {
            Disposition::Ask
        } else {
            crate::policy::permission_disposition(p, r.get("toolCall").unwrap_or(&Value::Null))
        }
    }
    fn approval_options(&self, r: &Value) -> Vec<ApprovalOption> {
        let mut out = crate::flavor::default_approval_options(r);
        let allow = r.get("options").and_then(Value::as_array).is_some_and(|a| {
            a.iter().any(|x| {
                x.get("kind").and_then(Value::as_str) == Some("allow_always")
                    && x.get("optionId")
                        .and_then(Value::as_str)
                        .is_some_and(|s| s.trim() == "allow-edits-session")
            })
        });
        out.retain(|o| o.decision != ApprovalDecision::AcceptForSession || allow);
        for o in &mut out {
            if o.decision == ApprovalDecision::AcceptForSession {
                o.label = "Allow all edits this session".into();
            }
        }
        out
    }
    fn model_write(&self, s: &ModelSelection, setup: &SessionSetup) -> ModelWrite {
        let current = setup
            .models
            .as_ref()
            .map(|m| m.current_model_id.trim())
            .filter(|v| !v.is_empty());
        let model = s.model.trim();
        let requested = if model.is_empty() || model == "grok-build" {
            None
        } else {
            Some(model)
        };
        let effort = s
            .options
            .as_ref()
            .and_then(|a| a.iter().find(|o| o.id == "reasoningEffort"))
            .and_then(|o| match &o.value {
                ProviderOptionSelectionValue::Text(v) => Some(v.trim()),
                _ => None,
            });
        let valid = effort.filter(|v| {
            !v.is_empty()
                && v.len() <= 32
                && v.bytes().enumerate().all(|(i, b)| {
                    b.is_ascii_alphanumeric() || (i > 0 && matches!(b, b'.' | b'_' | b'-'))
                })
        });
        let old = setup
            .models
            .as_ref()
            .and_then(|m| {
                m.available
                    .iter()
                    .find(|(id, _, _)| Some(id.trim()) == current)
            })
            .and_then(|(_, _, meta)| meta.as_ref())
            .and_then(|v| v.get("reasoningEffort"))
            .and_then(Value::as_str);
        if requested.is_none_or(|v| Some(v) == current) && (effort.is_none() || valid == old) {
            return ModelWrite::Keep;
        }
        match requested.or(current) {
            Some(id) => ModelWrite::SetModel {
                model_id: id.into(),
                meta: valid.map(|e| json!({"reasoningEffort":e}).as_object().unwrap().clone()),
            },
            None => ModelWrite::Keep,
        }
    }
    fn prompt_meta(&self, prompt_id: &str) -> Option<Map<String, Value>> {
        Some(
            json!({"promptId":prompt_id,"requestId":prompt_id})
                .as_object()
                .unwrap()
                .clone(),
        )
    }
    fn ext_notification(&self, method: &str, p: &Value) -> Vec<FlavorEvent> {
        if method == "x.ai/session/prompt_complete" || method == "_x.ai/session/prompt_complete" {
            let reason = p
                .get("stopReason")
                .and_then(Value::as_str)
                .unwrap_or("end_turn");
            if reason == "rate_limit" || reason == "error" {
                return vec![FlavorEvent::Notice {
                    message: if reason == "rate_limit" {
                        "Grok usage limit reached. Try again later."
                    } else {
                        "Grok ended the turn with an error."
                    }
                    .into(),
                    warning: true,
                }];
            }
            return vec![FlavorEvent::PromptComplete {
                prompt_id: p.get("promptId").and_then(Value::as_str).map(str::to_owned),
                stop_reason: match reason {
                    "cancelled" | "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" => {
                        reason
                    }
                    _ => "end_turn",
                }
                .into(),
            }];
        }
        Vec::new()
    }
}
