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
    /// v1 `xaiMcpToolCall.ts:13-54`; the shared driver must also normalize after merging
    /// tool state to handle input and metadata split across updates.
    fn normalize_update(&self, mut params: Value) -> Value {
        let Some(update) = params.get_mut("update").and_then(Value::as_object_mut) else {
            return params;
        };
        if !matches!(
            update.get("sessionUpdate").and_then(Value::as_str),
            Some("tool_call" | "tool_call_update")
        ) {
            return params;
        }
        let input = update.get("rawInput").and_then(Value::as_object);
        let name = input
            .and_then(|v| v.get("tool_name"))
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or("");
        let use_tool = update
            .get("_meta")
            .and_then(|v| v.get("x.ai/tool"))
            .and_then(|v| v.get("name"))
            .and_then(Value::as_str)
            == Some("use_tool");
        if let Some((server, tool)) = name
            .split_once("__")
            .filter(|(a, b)| !a.is_empty() && !b.is_empty())
            .filter(|_| use_tool)
        {
            let arguments = input
                .and_then(|v| v.get("tool_input"))
                .filter(|v| v.is_object())
                .cloned()
                .unwrap_or_else(|| json!({}));
            let rewritten = json!({"server":server,"tool":tool,"arguments":arguments});
            let mut meta = update
                .get("_meta")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            meta.insert("is_mcp_tool_call".into(), json!(true));
            update.insert("rawInput".into(), rewritten);
            update.insert("_meta".into(), Value::Object(meta));
        }
        if let Some(output) = update
            .get("rawOutput")
            .filter(|v| v.get("type").and_then(Value::as_str) == Some("MCP"))
            .and_then(|v| v.get("output"))
        {
            let error = output.get("Error").and_then(Value::as_str);
            let text = error.or_else(|| output.get("OkayOutput").and_then(Value::as_str));
            if let Some(text) = text {
                let mut result = json!({"content":[{"type":"text","text":text}]});
                if error.is_some() {
                    result["isError"] = json!(true);
                }
                update.insert("rawOutput".into(), result);
            }
        }
        params
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
    /// v1 grok adapter.ts:171-230: plan capture and questions held open for the person.
    fn ext_request_action(&self, method: &str, params: &Value) -> crate::flavor::ExtRequest {
        super::xai_requests::xai_request_action(method, params)
            .unwrap_or(crate::flavor::ExtRequest::Unhandled)
    }
    fn ext_notification(&self, method: &str, p: &Value) -> Vec<FlavorEvent> {
        // v1 xaiAcpExtension.ts:50-78,1464-1473: only identified root completions.
        if matches!(
            method,
            "x.ai/session_notification" | "_x.ai/session_notification" | "_x.ai/session/update"
        ) {
            if p.get("sessionId").and_then(Value::as_str).is_none() {
                return Vec::new();
            }
            let Some(update) = p.get("update").filter(|v| {
                v.get("sessionUpdate").and_then(Value::as_str) == Some("turn_completed")
            }) else {
                return Vec::new();
            };
            let Some(id) = update
                .get("prompt_id")
                .or_else(|| update.get("promptId"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty() && !s.starts_with("task-completed-"))
            else {
                return Vec::new();
            };
            return self.ext_notification("_x.ai/session/prompt_complete", &json!({"promptId":id,"stopReason":update.get("stop_reason").or_else(|| update.get("stopReason")).and_then(Value::as_str).unwrap_or("end_turn")}));
        }
        if method == "x.ai/session/prompt_complete" || method == "_x.ai/session/prompt_complete" {
            let reason = p
                .get("stopReason")
                .and_then(Value::as_str)
                .unwrap_or("end_turn");
            // v1 xAiPromptFailure (xaiAcpExtension.ts:1283-1301) and the adapter's promptFailure
            // (adapter.ts:434-446): the agent's own result text is the message when it sent one.
            let prompt_id = p.get("promptId").and_then(Value::as_str).map(str::to_owned);
            if reason == "rate_limit" {
                return vec![FlavorEvent::PromptFailed {
                    prompt_id,
                    message: "Grok usage limit reached. Try again later.".into(),
                }];
            }
            if reason == "error" {
                let agent_result = p
                    .get("agentResult")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty());
                return vec![FlavorEvent::PromptFailed {
                    prompt_id,
                    message: agent_result
                        .unwrap_or("Grok ended the turn with an error.")
                        .to_owned(),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mcp_use_tool_and_result_are_normalized() {
        let g = Grok::default();
        let p = json!({"sessionId":"s","update":{"sessionUpdate":"tool_call", "_meta":{"x.ai/tool":{"name":"use_tool"}},"rawInput":{"tool_name":"server__read","tool_input":{"path":"x"}},"rawOutput":{"type":"MCP","output":{"Error":"denied"}}}});
        let actual = g.normalize_update(p);
        assert_eq!(
            actual["update"]["rawInput"],
            json!({"server":"server","tool":"read","arguments":{"path":"x"}})
        );
        assert_eq!(actual["update"]["_meta"]["is_mcp_tool_call"], true);
        assert_eq!(
            actual["update"]["rawOutput"],
            json!({"isError":true,"content":[{"type":"text","text":"denied"}]})
        );
        let p = json!({"update":{"sessionUpdate":"tool_call_update","rawOutput":{"type":"MCP","output":{"OkayOutput":"ok"}}}});
        assert_eq!(
            g.normalize_update(p)["update"]["rawOutput"],
            json!({"content":[{"type":"text","text":"ok"}]})
        );
    }

    #[test]
    fn turn_completed_requires_root_identity() {
        let g = Grok::default();
        let method = "_x.ai/session_notification";
        assert!(
            g.ext_notification(
                method,
                &json!({"update":{"sessionUpdate":"turn_completed"}})
            )
            .is_empty()
        );
        assert!(
            g.ext_notification(
                method,
                &json!({"sessionId":"s","update":{"sessionUpdate":"turn_completed","prompt_id":"task-completed-1"}})
            )
            .is_empty()
        );
        assert_eq!(g.ext_notification(method, &json!({"sessionId":"s","update":{"sessionUpdate":"turn_completed","prompt_id":"p1","stop_reason":"cancelled"}})), vec![FlavorEvent::PromptComplete {prompt_id:Some("p1".into()),stop_reason:"cancelled".into()}]);
    }
}
