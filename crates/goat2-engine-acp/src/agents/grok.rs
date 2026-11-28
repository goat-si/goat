//! Grok (xAI `grok agent stdio`) on the shared ACP driver.
//!
//! v1 (goat-si/goat 916b5ccc1b2): `packages/provider-grok/src/server/adapter.ts:92-475`
//! (`makeGrokAcpAdapterFlavor`: capabilities, launch, permission disposition, approval options,
//! prompt failure, extensions, subagent / background / plan hooks), `acpSupport.ts:113-245`
//! (launch arguments, OAuth referrer, auth method, initialize and cancel metadata,
//! `grokApprovalOptions`), `xaiAcpExtension.ts:1236-1563` (prompt completion by extension) and the
//! modules next to this one (`grok_tools`, `grok_notifications`, `grok_plan`, `grok_model`,
//! `grok_skills`, `grok_auth`).

use std::path::PathBuf;

use crate::{
    capabilities::acp_base_capabilities,
    flavor::{
        AcpFlavor, AuthPolicy, BackgroundMutation, ExtRequest, FlavorEvent, LaunchCommand,
        ModelWrite, PromptContext, SubagentEndNotice, SubagentUpdate,
    },
    items::ToolState,
    policy::{Disposition, RuntimePolicy},
    wire::{InitializeInfo, SessionSetup},
};
use futures::future::BoxFuture;
use goat2_contracts::{
    ApprovalDecision, ApprovalOption, EngineDriver, ModelSelection, ProviderCapabilities,
    RuntimeMode,
};
use goat2_engine_api::{EngineError, SessionSpec};
use serde_json::{Map, Value, json};

use super::grok_auth::{self, StoredApiKey};
use super::grok_plan::{GrokPlanPathHost, plan_markdown_from_tool_call};
use super::{grok_model, grok_notifications, grok_skills, grok_tools, xai_requests};

/// v1 `GROK_OAUTH2_REFERRER_ENV` / `GOAT_OAUTH_REFERRER` (acpSupport.ts:30-31).
const GROK_OAUTH2_REFERRER_ENV: &str = "GROK_OAUTH2_REFERRER";
const GOAT_OAUTH_REFERRER: &str = "t3code";
/// v1 `GROK_ALLOW_EDITS_SESSION_OPTION_ID` (acpSupport.ts:197): only this `allow_always` choice is
/// session-scoped; the others persist project grants.
const GROK_ALLOW_EDITS_SESSION_OPTION_ID: &str = "allow-edits-session";

/// The Grok flavor. `has_api_key` says the resolved provider environment holds `XAI_API_KEY`
/// (the key itself is not kept); `stored_api_key` reads the key saved in GOAT at each launch.
#[derive(Clone, Default)]
pub struct Grok {
    pub has_api_key: bool,
    /// v1 `GrokSettings.binaryPath`; `grok` on PATH when unset.
    pub binary_path: Option<PathBuf>,
    pub stored_api_key: Option<StoredApiKey>,
}

impl std::fmt::Debug for Grok {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Grok")
            .field("has_api_key", &self.has_api_key)
            .field("binary_path", &self.binary_path)
            .field("stored_api_key", &self.stored_api_key.is_some())
            .finish()
    }
}

/// v1 `grokLaunchRuntimeMode` (adapter.ts:232-243): explicit approval or sandbox overrides launch
/// Grok asking. GOAT 2's runtime policy has no such overrides, so the thread's mode is the launch
/// mode.
pub fn grok_launch_runtime_mode(policy: &RuntimePolicy) -> RuntimeMode {
    policy.runtime_mode
}

/// v1 `grokAcpSpawnArgs` (acpSupport.ts:125-144): argv overrides Grok's config so Supervised cannot
/// inherit always-approve; Grok has no auto-accept-edits launch mode, which asks like Supervised.
pub fn grok_spawn_args(mode: RuntimeMode) -> Vec<&'static str> {
    match mode {
        RuntimeMode::Auto => vec!["--permission-mode", "auto", "agent", "stdio"],
        RuntimeMode::FullAccess => vec!["agent", "--always-approve", "stdio"],
        RuntimeMode::ApprovalRequired | RuntimeMode::AutoAcceptEdits => {
            vec!["--permission-mode", "default", "agent", "stdio"]
        }
    }
}

/// v1 `grokApprovalOptions` (acpSupport.ts:199-215).
pub fn grok_approval_options(request: &Value) -> Vec<ApprovalOption> {
    let options = request
        .get("options")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let has = |kind: &str, option_id: Option<&str>| {
        options.iter().any(|o| {
            o.get("kind").and_then(Value::as_str) == Some(kind)
                && option_id.is_none_or(|id| {
                    o.get("optionId").and_then(Value::as_str).map(str::trim) == Some(id)
                })
        })
    };
    let option = |decision, label: &str| ApprovalOption {
        decision,
        label: label.into(),
        warning: None,
    };
    let mut out = vec![option(ApprovalDecision::Cancel, "Cancel")];
    if has("reject_once", None) {
        out.push(option(ApprovalDecision::Decline, "Decline"));
    }
    if has("allow_always", Some(GROK_ALLOW_EDITS_SESSION_OPTION_ID)) {
        out.push(option(
            ApprovalDecision::AcceptForSession,
            "Allow all edits this session",
        ));
    }
    if has("allow_once", None) {
        out.push(option(ApprovalDecision::Accept, "Approve"));
    }
    out
}

fn object(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

/// v1 `normalizeXAiStopReason` (xaiAcpExtension.ts:1245-1256).
fn normalize_stop_reason(reason: Option<&str>) -> &'static str {
    match reason {
        Some("cancelled") => "cancelled",
        Some("max_tokens") => "max_tokens",
        Some("max_turn_requests") => "max_turn_requests",
        Some("refusal") => "refusal",
        _ => "end_turn",
    }
}

/// v1 `resolveXAiPromptCompletionFallback` with `xAiPromptFailure` (xaiAcpExtension.ts:1281-1301)
/// and the adapter's `promptFailure` message choice (adapter.ts:433-446).
fn prompt_completion(
    prompt_id: Option<String>,
    stop_reason: Option<&str>,
    agent_result: Option<&Value>,
) -> FlavorEvent {
    match stop_reason {
        Some("rate_limit") => FlavorEvent::PromptFailed {
            prompt_id,
            message: "Grok usage limit reached. Try again later.".into(),
        },
        Some("error") => FlavorEvent::PromptFailed {
            prompt_id,
            message: grok_tools::non_empty(agent_result)
                .unwrap_or_else(|| "Grok ended the turn with an error.".into()),
        },
        other => FlavorEvent::PromptComplete {
            prompt_id,
            stop_reason: normalize_stop_reason(other).into(),
        },
    }
}

impl AcpFlavor for Grok {
    fn driver(&self) -> &str {
        "grok"
    }
    fn engine_driver(&self) -> EngineDriver {
        EngineDriver::Grok
    }
    /// v1 `GrokProviderCapabilitiesV2` (adapter.ts:98-127).
    fn capabilities(&self) -> ProviderCapabilities {
        let mut c = acp_base_capabilities();
        c.sessions.supports_model_switch_in_session = true;
        c.sessions.supports_runtime_mode_switch_in_session = false;
        c.threads.can_read_thread_snapshot = true;
        c.threads.can_fork_thread = false;
        c.threads.can_fork_from_turn = false;
        c.tools.supports_mcp_tools = true;
        c.checkpointing.provider_can_read_conversation_snapshot = true;
        c.subagents.supports_subagents = true;
        c.subagents.exposes_subagent_thread_ids = true;
        c.subagents.emits_subagent_lifecycle = true;
        c
    }
    /// v1 `buildGrokAcpSpawnInput` (acpSupport.ts:146-162) and `resolveSessionLaunch`
    /// (adapter.ts:400-416).
    fn launch(&self, spec: &SessionSpec) -> Result<LaunchCommand, EngineError> {
        let mode = grok_launch_runtime_mode(&RuntimePolicy {
            runtime_mode: spec.engine.runtime_mode,
            cwd: None,
            extra_roots: Vec::new(),
        });
        let program = self
            .binary_path
            .clone()
            .unwrap_or_else(|| PathBuf::from("grok"));
        let mut command = LaunchCommand::new(program, grok_spawn_args(mode))
            .env(GROK_OAUTH2_REFERRER_ENV, GOAT_OAUTH_REFERRER);
        if let Some(key) = grok_auth::stored_key_variable(spec, self.stored_api_key.as_ref()) {
            command = command.env(grok_auth::GROK_API_KEY_ENV, key);
        }
        Ok(command)
    }
    fn auth_policy(&self) -> AuthPolicy {
        AuthPolicy::OnRequired {
            method_id: Some(grok_auth::auth_method_id(self.has_api_key).into()),
        }
    }
    /// v1 `resolveGrokAuthMethodId(launch.environment)` (acpSupport.ts:164-168,234).
    fn auth_policy_for(&self, spec: &SessionSpec) -> AuthPolicy {
        let has_key = self.has_api_key
            || grok_auth::launch_environment_has_key(spec)
            || grok_auth::stored_key_variable(spec, self.stored_api_key.as_ref()).is_some();
        AuthPolicy::OnRequired {
            method_id: Some(grok_auth::auth_method_id(has_key).into()),
        }
    }
    /// v1 `GROK_ACP_INITIALIZE_META` (acpSupport.ts:187-194): `extension` clients get Auto-mode
    /// classifier refusals as prompts instead of silent denials.
    fn initialize_meta(&self) -> Option<Map<String, Value>> {
        Some(object(json!({"clientType": "extension"})))
    }
    /// v1 `GROK_ACP_CANCEL_META` (acpSupport.ts:184-185): Ctrl+C blocks stale background wakes
    /// until the next genuine user turn.
    fn cancel_meta(&self) -> Option<Map<String, Value>> {
        Some(object(json!({"cancelTrigger": "ctrl_c"})))
    }
    /// v1 `restartRuntimeAfterInterrupt` (adapter.ts:356-357).
    fn restart_after_interrupt(&self) -> bool {
        true
    }
    /// v1 `preserveRuntimeOnSettledInterrupt` (adapter.ts:359-360).
    fn preserve_runtime_on_settled_interrupt(&self) -> bool {
        true
    }
    /// v1 `makeXAiPromptCompletionRuntime.cancel` (xaiAcpExtension.ts:1553-1560).
    fn settles_prompt_on_cancel(&self) -> bool {
        true
    }
    /// v1 `deferFinalizeForBackgroundWork` (adapter.ts:471).
    fn defers_finalize_for_background_work(&self) -> bool {
        true
    }
    /// v1 `supportsImagePrompts` (adapter.ts:361-362): Grok takes images despite advertising
    /// `promptCapabilities.image: false`.
    fn supports_image_prompts(&self, _: &InitializeInfo) -> bool {
        true
    }
    /// v1 `rewriteUserText` (adapter.ts:365-383).
    fn rewrite_user_text_for(
        &self,
        text: String,
        context: &PromptContext,
    ) -> BoxFuture<'static, String> {
        if grok_skills::leading_skill_mention(&text).is_none() {
            return Box::pin(std::future::ready(text));
        }
        Box::pin(grok_skills::rewrite_skill_mention(text, context.clone()))
    }
    /// v1 auto mode (adapter.ts:429-431): Auto prompts are classifier refusals and must reach the
    /// user.
    fn permission_disposition(&self, p: &RuntimePolicy, r: &Value) -> Disposition {
        if grok_launch_runtime_mode(p) == RuntimeMode::Auto {
            Disposition::Ask
        } else {
            crate::policy::permission_disposition(p, r.get("toolCall").unwrap_or(&Value::Null))
        }
    }
    fn approval_options(&self, r: &Value) -> Vec<ApprovalOption> {
        grok_approval_options(r)
    }
    fn model_write(&self, selection: &ModelSelection, setup: &SessionSetup) -> ModelWrite {
        grok_model::grok_model_write(
            selection,
            setup,
            &InitializeInfo {
                protocol_version: 1,
                ..Default::default()
            },
        )
    }
    /// v1 `applyGrokSessionModelSelection` (adapter.ts:263-345).
    fn model_write_for(
        &self,
        selection: &ModelSelection,
        setup: &SessionSetup,
        init: &InitializeInfo,
    ) -> ModelWrite {
        grok_model::grok_model_write(selection, setup, init)
    }
    /// v1 `makeXAiPromptCompletionRuntime` prompt metadata (xaiAcpExtension.ts:1517-1527).
    fn prompt_meta(&self, prompt_id: &str) -> Option<Map<String, Value>> {
        Some(object(
            json!({"promptId": prompt_id, "requestId": prompt_id}),
        ))
    }
    /// v1 grok adapter.ts:171-230: plan capture and questions held open for the person.
    fn ext_request_action(&self, method: &str, params: &Value) -> ExtRequest {
        xai_requests::xai_request_action(method, params).unwrap_or(ExtRequest::Unhandled)
    }
    /// v1 `normalizeToolCall: normalizeXAiAcpToolCallState` (adapter.ts:450).
    fn normalize_tool_call(&self, tool: &mut ToolState) {
        grok_tools::normalize_tool_call_state(tool);
    }
    /// v1 `extractSubagentUpdate: extractXAiAcpSubagentUpdate` (adapter.ts:448).
    fn subagent_update(&self, tool: &ToolState) -> Option<SubagentUpdate> {
        grok_tools::subagent_update(tool)
    }
    /// v1 `extractSubagentEndNotice: extractXAiAcpSubagentEndNotice` (adapter.ts:449).
    fn subagent_end_notice(&self, text: &str) -> Option<SubagentEndNotice> {
        grok_tools::subagent_end_notice(text)
    }
    /// v1 `extractProposedPlanMarkdown` (adapter.ts:451-461).
    fn proposed_plan_markdown(
        &self,
        tool: &ToolState,
        launch_env: &[(String, String)],
    ) -> Option<String> {
        plan_markdown_from_tool_call(tool, &GrokPlanPathHost::for_session(launch_env))
    }
    /// v1 `extractBackgroundTaskId: extractXAiMonitorTaskId` (adapter.ts:462).
    fn background_task_id(&self, tool: &ToolState) -> Option<String> {
        grok_tools::monitor_task_id(tool)
    }
    /// v1 `isPersistentBackgroundTool: isXAiPersistentMonitor` (adapter.ts:469).
    fn is_persistent_background_tool(&self, tool: &ToolState) -> bool {
        grok_tools::is_persistent_monitor(tool)
    }
    /// v1 adapter.ts:465-468.
    fn background_task_completions(&self, tool: &ToolState) -> Vec<BackgroundMutation> {
        let mut out = grok_tools::background_task_completion(tool);
        out.extend(grok_tools::killed_background_tasks(tool));
        out
    }
    /// v1 `extractBackgroundToolMutation: extractXAiAcpBackgroundToolMutation` (adapter.ts:464).
    fn background_tool_mutations(&self, text: &str) -> Vec<BackgroundMutation> {
        grok_tools::background_tool_mutations(text)
    }
    /// v1 `isProviderWakeNotification: isXAiTaskCompletedWakeNotification` (adapter.ts:470).
    fn is_wake_notification(&self, params: &Value) -> bool {
        grok_notifications::is_task_completed_wake(params)
    }
    fn ext_notification(&self, method: &str, p: &Value) -> Vec<FlavorEvent> {
        if grok_notifications::SESSION_NOTIFICATION_METHODS.contains(&method) {
            // v1 xaiAcpExtension.ts:1464-1482: the completion fallback first, then the registered
            // session notification handler (`registerXAiSubagentFinished`, :512-524).
            let mut events = Vec::new();
            if let Some((prompt_id, stop_reason, agent_result)) =
                grok_notifications::prompt_complete_from_session_update(p)
            {
                events.push(prompt_completion(
                    Some(prompt_id),
                    stop_reason.as_deref(),
                    agent_result.as_ref(),
                ));
            }
            events.extend(grok_notifications::subagent_finished_event(p));
            return events;
        }
        if method == "x.ai/session/prompt_complete" || method == "_x.ai/session/prompt_complete" {
            // v1 `XAiPromptCompleteNotification` requires `sessionId`.
            if p.get("sessionId").and_then(Value::as_str).is_none() {
                return Vec::new();
            }
            let prompt_id = p.get("promptId").and_then(Value::as_str).map(str::to_owned);
            return vec![prompt_completion(
                prompt_id,
                p.get("stopReason").and_then(Value::as_str),
                p.get("agentResult"),
            )];
        }
        grok_notifications::background_task_event(method, p)
            .into_iter()
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flavor::{BackgroundStatus, SubagentStatus};

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
        assert_eq!(
            g.ext_notification(method, &json!({"sessionId":"s","update":{"sessionUpdate":"turn_completed","prompt_id":"p1","stop_reason":"cancelled"}})),
            vec![FlavorEvent::PromptComplete { prompt_id: Some("p1".into()), stop_reason: "cancelled".into() }]
        );
        assert_eq!(
            g.ext_notification(method, &json!({"sessionId":"s","update":{"sessionUpdate":"turn_completed","promptId":"p2","stopReason":"error","agent_result":"oops"}})),
            vec![FlavorEvent::PromptFailed { prompt_id: Some("p2".into()), message: "oops".into() }]
        );
    }

    #[test]
    fn lifecycle_and_subagent_notifications_become_events() {
        let g = Grok::default();
        assert!(matches!(
            g.ext_notification("x.ai/task_completed", &json!({"sessionId": "s", "update": {"sessionUpdate": "task_completed", "task_id": "call-1-0"}}))[..],
            [FlavorEvent::BackgroundTask { status: BackgroundStatus::Completed, .. }]
        ));
        assert!(matches!(
            g.ext_notification("_x.ai/session/update", &json!({"sessionId": "s", "update": {"sessionUpdate": "subagent_finished", "child_session_id": "c", "status": "cancelled", "error": "stopped"}}))[..],
            [FlavorEvent::SubagentFinished { status: SubagentStatus::Cancelled, .. }]
        ));
    }

    #[test]
    fn stored_key_fills_only_an_empty_environment() {
        use goat2_contracts::EngineConfig;
        use goat2_engine_api::{LaunchSpec, McpEndpoint};
        let mut spec = SessionSpec {
            thread_id: "t".into(),
            engine: EngineConfig {
                provider_instance_id: "grok".into(),
                model_selection: ModelSelection {
                    instance_id: "grok".into(),
                    model: "grok-build".into(),
                    options: None,
                },
                runtime_mode: RuntimeMode::AutoAcceptEdits,
                cwd: "/tmp".into(),
            },
            resume: None,
            mcp: McpEndpoint {
                url: String::new(),
                bearer_token: String::new(),
            },
            host_generation: 0,
            process_generation: 0,
            instructions: None,
            launch: None,
        };
        let g = Grok {
            binary_path: Some("/opt/grok".into()),
            stored_api_key: Some(std::sync::Arc::new(|| Some(" stored ".into()))),
            ..Default::default()
        };
        if std::env::var(grok_auth::GROK_API_KEY_ENV).is_err() {
            let command = g.launch(&spec).unwrap();
            assert_eq!(command.program, PathBuf::from("/opt/grok"));
            assert_eq!(
                command.args,
                ["--permission-mode", "default", "agent", "stdio"]
            );
            assert!(
                command
                    .env
                    .contains(&("XAI_API_KEY".into(), "stored".into()))
            );
            assert_eq!(
                g.auth_policy_for(&spec),
                AuthPolicy::OnRequired {
                    method_id: Some("xai.api_key".into())
                }
            );
            assert_eq!(
                Grok::default().auth_policy_for(&spec),
                AuthPolicy::OnRequired {
                    method_id: Some("cached_token".into())
                }
            );
        }
        spec.launch = Some(LaunchSpec {
            binary: None,
            args: vec![],
            env: [("XAI_API_KEY".to_string(), "instance".to_string())].into(),
        });
        let command = g.launch(&spec).unwrap();
        assert!(!command.env.iter().any(|(k, _)| k == "XAI_API_KEY"));
        assert_eq!(
            Grok::default().auth_policy_for(&spec),
            AuthPolicy::OnRequired {
                method_id: Some("xai.api_key".into())
            }
        );
    }
}
