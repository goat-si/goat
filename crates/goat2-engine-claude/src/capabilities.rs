//! Claude capability flags, equal to GOAT v1 `ClaudeProviderCapabilitiesV2`
//! (`apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:436-531` at origin/dev 916b5ccc).
//! Fields v1 leaves out stay `None`.

use goat2_contracts::{
    ApprovalCapabilities, CheckpointCapabilities, CloudSourceRestriction, ContextCapabilities,
    ExecutionLocation, FollowUpSupport, IdentityCapabilities, NativeRefStrength,
    PlanningCapabilities, ProviderCapabilities, RuntimePolicyCapabilities,
    RuntimePolicyEnforcement, SessionCapabilities, StreamingCapabilities, SubagentCapabilities,
    TerminalStatusQuality, ThreadCapabilities, ToolCapabilities, TurnCapabilities,
};

/// v1 `ClaudeProviderCapabilitiesV2`.
pub fn claude_capabilities() -> ProviderCapabilities {
    ProviderCapabilities {
        memory: None,
        sessions: SessionCapabilities {
            source_restriction: CloudSourceRestriction::default(),
            execution_location: ExecutionLocation::default(),
            follow_up: FollowUpSupport::default(),
            owns_process: None,
            supports_multiple_provider_threads_per_session: false,
            supports_model_switch_in_session: true,
            supports_provider_switching_via_handoff: true,
            supports_runtime_mode_switch_in_session: false,
            pending_requests_survive_restart: false,
        },
        threads: ThreadCapabilities {
            can_create_empty_thread: true,
            can_read_thread_snapshot: false,
            can_rollback_thread: true,
            can_fork_thread: true,
            can_fork_from_turn: true,
            can_fork_while_source_running: Some(true),
            can_fork_from_subagent_thread: false,
            exposes_native_thread_id: true,
            fork_honors_target_cwd: None,
        },
        turns: TurnCapabilities {
            supports_native_goals: None,
            exposes_native_turn_id: false,
            emits_turn_started: true,
            emits_turn_completed: true,
            supports_interrupt: true,
            supports_native_resume: Some(true),
            supports_active_steering: true,
            active_steering_interrupts_tools: Some(false),
            active_steering_accepts_attachments: None,
            active_steering_during_compaction: None,
            supports_steering_by_interrupt_restart: false,
            supports_queued_messages: true,
            terminal_status_quality: TerminalStatusQuality::Strong,
        },
        streaming: StreamingCapabilities {
            streams_assistant_text: true,
            streams_reasoning: true,
            streams_tool_output: false,
            streams_plan_text: false,
            emits_message_completed: true,
        },
        tools: ToolCapabilities {
            exposes_tool_item_ids: true,
            emits_tool_started: true,
            emits_tool_completed: true,
            emits_tool_output: true,
            supports_mcp_tools: true,
            supports_dynamic_tool_callbacks: true,
        },
        approvals: ApprovalCapabilities {
            supports_command_approval: true,
            supports_file_read_approval: true,
            supports_file_change_approval: true,
            supports_apply_patch_approval: false,
            approvals_have_native_request_ids: true,
            approval_callbacks_are_live_only: true,
            approvals_can_originate_from_subagents: false,
        },
        planning: PlanningCapabilities {
            emits_plan_updated: true,
            emits_todo_list: true,
            emits_proposed_plan: true,
            supports_structured_questions: true,
            plan_deltas_have_item_ids: false,
        },
        subagents: SubagentCapabilities {
            supports_subagents: true,
            exposes_subagent_thread_ids: false,
            emits_subagent_lifecycle: true,
            can_wait_for_subagents: false,
            can_close_subagents: false,
            can_fork_subagent_thread: false,
        },
        context: ContextCapabilities {
            accepts_system_context: true,
            accepts_developer_context: true,
            accepts_synthetic_user_context: true,
            can_generate_summaries: true,
            can_consume_handoff_summaries: true,
            supports_delta_handoff: true,
            supports_full_thread_handoff: true,
            max_recommended_handoff_chars: None,
        },
        checkpointing: CheckpointCapabilities {
            app_can_checkpoint_filesystem: true,
            supports_nested_checkpoint_scopes: true,
            provider_can_rollback_conversation: true,
            provider_rollback_returns_snapshot: true,
            provider_can_read_conversation_snapshot: false,
        },
        identity: IdentityCapabilities {
            native_thread_ids: NativeRefStrength::Strong,
            native_turn_ids: NativeRefStrength::Weak,
            native_item_ids: NativeRefStrength::Strong,
            native_request_ids: NativeRefStrength::Strong,
        },
        runtime_policy: RuntimePolicyCapabilities {
            enforcement: RuntimePolicyEnforcement::Native,
        },
    }
}
