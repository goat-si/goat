//! Vendor ACP flavors.
pub mod antigravity;
pub mod fx;
pub mod grok;
pub mod xai_requests;

#[cfg(test)]
mod tests {
    use super::{antigravity::Antigravity, fx::Fx, grok::Grok};
    use crate::{
        flavor::{AcpFlavor, AuthPolicy, FlavorEvent, ResumeMethod},
        policy::{Disposition, RuntimePolicy},
        wire::{InitializeInfo, ModeState},
    };
    use goat2_contracts::RuntimeMode;
    use serde_json::json;
    #[test]
    fn flags_match_vendor_overrides() {
        let g = Grok::default().capabilities();
        assert!(
            g.sessions.supports_model_switch_in_session
                && g.threads.can_read_thread_snapshot
                && g.subagents.exposes_subagent_thread_ids
                && g.subagents.emits_subagent_lifecycle
                && g.tools.supports_mcp_tools
                && g.checkpointing.provider_can_read_conversation_snapshot
        );
        let f = Fx.capabilities();
        assert!(
            f.sessions.supports_model_switch_in_session
                && f.threads.can_read_thread_snapshot
                && f.subagents.supports_subagents
                && f.subagents.emits_subagent_lifecycle
                && !f.subagents.exposes_subagent_thread_ids
        );
        let a = Antigravity::default().capabilities();
        assert!(
            a.sessions.supports_runtime_mode_switch_in_session
                && a.tools.supports_mcp_tools
                && a.subagents.supports_subagents
                && !a.threads.can_read_thread_snapshot
                && !a.subagents.emits_subagent_lifecycle
        );
    }
    #[test]
    fn auth_modes_and_grok_completion() {
        let g = Grok::default();
        assert_eq!(
            g.auth_policy(),
            AuthPolicy::OnRequired {
                method_id: Some("cached_token".into())
            }
        );
        assert_eq!(
            Grok { has_api_key: true }.auth_policy(),
            AuthPolicy::OnRequired {
                method_id: Some("xai.api_key".into())
            }
        );
        assert_eq!(
            g.ext_notification(
                "_x.ai/session/prompt_complete",
                &json!({"promptId":"p1","stopReason":"cancelled"})
            ),
            vec![FlavorEvent::PromptComplete {
                prompt_id: Some("p1".into()),
                stop_reason: "cancelled".into()
            }]
        );
        let p = RuntimePolicy {
            runtime_mode: RuntimeMode::Auto,
            cwd: None,
            extra_roots: vec![],
        };
        assert_eq!(g.permission_disposition(&p, &json!({})), Disposition::Ask);
        assert_eq!(Fx.permission_disposition(&p, &json!({})), Disposition::Ask);
        let modes = ModeState {
            current_mode_id: "ask".into(),
            available: vec![("code".into(), "Code".into())],
        };
        assert_eq!(
            Fx.session_mode_for(RuntimeMode::Auto, Some(&modes))
                .as_deref(),
            Some("code")
        );
    }
    #[test]
    fn antigravity_metadata_and_steering() {
        let a = Antigravity::default();
        assert_eq!(a.resume_method(), Some(ResumeMethod::Resume));
        let i = InitializeInfo {
            agent_version: Some("1.4.5".into()),
            ..Default::default()
        };
        assert_eq!(
            a.session_meta(&i, Some("hello")).unwrap()["antigravity"],
            json!({"disabledTools":["run_workflow"],"systemPrompt":{"append":"hello"}})
        );
        assert!(!a.steers_with_prompt(&i));
        let i = InitializeInfo {
            agent_version: Some("v1.5.0".into()),
            ..Default::default()
        };
        assert!(a.steers_with_prompt(&i));
        assert!(!a.instructions_in_session_meta(&i));
    }
    #[test]
    fn launch_arguments_and_approval_scope() {
        use goat2_contracts::{ApprovalDecision, EngineConfig, ModelSelection};
        use goat2_engine_api::{McpEndpoint, SessionSpec};
        let instance = "grok".into();
        let mut spec = SessionSpec {
            thread_id: "t".into(),
            engine: EngineConfig {
                provider_instance_id: instance,
                model_selection: ModelSelection {
                    instance_id: "grok".into(),
                    model: "grok-build".into(),
                    options: None,
                },
                runtime_mode: RuntimeMode::ApprovalRequired,
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
        let g = Grok::default();
        assert_eq!(
            g.launch(&spec).unwrap().args,
            ["--permission-mode", "default", "agent", "stdio"]
        );
        spec.engine.runtime_mode = RuntimeMode::Auto;
        assert_eq!(
            g.launch(&spec).unwrap().args,
            ["--permission-mode", "auto", "agent", "stdio"]
        );
        spec.engine.runtime_mode = RuntimeMode::FullAccess;
        assert_eq!(
            g.launch(&spec).unwrap().args,
            ["agent", "--always-approve", "stdio"]
        );
        assert_eq!(Fx.launch(&spec).unwrap().args, ["acp"]);
        let choices=g.approval_options(&json!({"options":[{"kind":"allow_always","optionId":"persistent"},{"kind":"allow_once","optionId":"once"}]}));
        assert!(
            !choices
                .iter()
                .any(|x| x.decision == ApprovalDecision::AcceptForSession)
        );
        let choices = g.approval_options(
            &json!({"options":[{"kind":"allow_always","optionId":"allow-edits-session"}]}),
        );
        assert!(
            choices
                .iter()
                .any(|x| x.decision == ApprovalDecision::AcceptForSession)
        );
    }
}
