//! Engine capability flags, equal in shape to GOAT v1.
//!
//! Source: goat-si/goat dev `packages/contracts/src/providerCapabilityParts.ts` and the
//! `OrchestrationV2ProviderCapabilities`, checkpoint, runtime-policy and identity structs in
//! `orchestrationV2.ts`. Field names are unchanged. v1 `Schema.optional` fields are
//! `Option<T>` and omitted when absent; v1 decoding defaults are serde defaults.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::turn_item::NativeRefStrength;

/// All capability groups for one engine driver.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCapabilities {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub memory: Option<MemoryCapabilities>,
    pub sessions: SessionCapabilities,
    pub threads: ThreadCapabilities,
    pub turns: TurnCapabilities,
    pub streaming: StreamingCapabilities,
    pub tools: ToolCapabilities,
    pub approvals: ApprovalCapabilities,
    pub planning: PlanningCapabilities,
    pub subagents: SubagentCapabilities,
    pub context: ContextCapabilities,
    pub checkpointing: CheckpointCapabilities,
    pub identity: IdentityCapabilities,
    /// v1 decodes a missing value as `{enforcement: "client-boundary"}`.
    #[serde(default)]
    pub runtime_policy: RuntimePolicyCapabilities,
}

/// v1 `MemoryProviderCapabilities`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MemoryCapabilities {
    pub snapshot: bool,
    pub mcp: bool,
    pub resolve_memory_conflict: bool,
    pub generate_memory_summary: bool,
}

/// v1 `OrchestrationV2ToolCapabilities`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ToolCapabilities {
    pub exposes_tool_item_ids: bool,
    pub emits_tool_started: bool,
    pub emits_tool_completed: bool,
    pub emits_tool_output: bool,
    pub supports_mcp_tools: bool,
    pub supports_dynamic_tool_callbacks: bool,
}

/// v1 `OrchestrationV2ApprovalCapabilities`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalCapabilities {
    pub supports_command_approval: bool,
    pub supports_file_read_approval: bool,
    pub supports_file_change_approval: bool,
    pub supports_apply_patch_approval: bool,
    pub approvals_have_native_request_ids: bool,
    pub approval_callbacks_are_live_only: bool,
    pub approvals_can_originate_from_subagents: bool,
}

/// v1 `OrchestrationV2PlanningCapabilities`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PlanningCapabilities {
    pub emits_plan_updated: bool,
    pub emits_todo_list: bool,
    pub emits_proposed_plan: bool,
    pub supports_structured_questions: bool,
    pub plan_deltas_have_item_ids: bool,
}

/// v1 `OrchestrationV2SubagentCapabilities`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SubagentCapabilities {
    pub supports_subagents: bool,
    pub exposes_subagent_thread_ids: bool,
    pub emits_subagent_lifecycle: bool,
    pub can_wait_for_subagents: bool,
    pub can_close_subagents: bool,
    pub can_fork_subagent_thread: bool,
}

/// v1 `OrchestrationV2ContextCapabilities`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ContextCapabilities {
    pub accepts_system_context: bool,
    pub accepts_developer_context: bool,
    pub accepts_synthetic_user_context: bool,
    pub can_generate_summaries: bool,
    pub can_consume_handoff_summaries: bool,
    pub supports_delta_handoff: bool,
    pub supports_full_thread_handoff: bool,
    /// v1 `NullOr(PositiveInt)`: zero is rejected.
    pub max_recommended_handoff_chars: Option<std::num::NonZeroU32>,
}

/// v1 `OrchestrationV2CloudSourceRestriction`.
#[derive(
    Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema,
)]
#[serde(rename_all = "kebab-case")]
pub enum CloudSourceRestriction {
    #[default]
    PublishedRef,
    CleanPushedSha,
    ProjectFolder,
}

/// v1 session `executionLocation`.
#[derive(
    Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionLocation {
    #[default]
    Local,
    Cloud,
}

/// v1 session `followUp`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FollowUpSupport {
    pub supported: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reason: Option<String>,
}

impl Default for FollowUpSupport {
    fn default() -> Self {
        Self {
            supported: true,
            reason: None,
        }
    }
}

/// v1 `OrchestrationV2SessionCapabilities`. `sourceRestriction`, `executionLocation` and
/// `followUp` decode with v1's defaults when missing and are always written.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionCapabilities {
    #[serde(default)]
    pub source_restriction: CloudSourceRestriction,
    #[serde(default)]
    pub execution_location: ExecutionLocation,
    #[serde(default)]
    pub follow_up: FollowUpSupport,
    /// Whether this session controls the lifetime of its native process.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub owns_process: Option<bool>,
    pub supports_multiple_provider_threads_per_session: bool,
    pub supports_model_switch_in_session: bool,
    pub supports_provider_switching_via_handoff: bool,
    pub supports_runtime_mode_switch_in_session: bool,
    pub pending_requests_survive_restart: bool,
}

/// v1 `OrchestrationV2ThreadCapabilities`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadCapabilities {
    pub can_create_empty_thread: bool,
    pub can_read_thread_snapshot: bool,
    pub can_rollback_thread: bool,
    pub can_fork_thread: bool,
    pub can_fork_from_turn: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub can_fork_while_source_running: Option<bool>,
    pub can_fork_from_subagent_thread: bool,
    pub exposes_native_thread_id: bool,
    /// Native fork starts the new provider thread in the target thread's cwd.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub fork_honors_target_cwd: Option<bool>,
}

/// v1 turn `terminalStatusQuality`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TerminalStatusQuality {
    Strong,
    Weak,
    None,
}

/// v1 `OrchestrationV2TurnCapabilities`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TurnCapabilities {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub supports_native_goals: Option<bool>,
    pub exposes_native_turn_id: bool,
    pub emits_turn_started: bool,
    pub emits_turn_completed: bool,
    pub supports_interrupt: bool,
    /// Continues an interrupted turn without a new message.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub supports_native_resume: Option<bool>,
    pub supports_active_steering: bool,
    /// Some native steering mechanisms cancel pending tools before consuming the message.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub active_steering_interrupts_tools: Option<bool>,
    /// Some take text only, so a steer with attachments restarts the turn instead.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub active_steering_accepts_attachments: Option<bool>,
    /// Only where a steer leaves a running automatic compaction intact.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub active_steering_during_compaction: Option<bool>,
    pub supports_steering_by_interrupt_restart: bool,
    pub supports_queued_messages: bool,
    pub terminal_status_quality: TerminalStatusQuality,
}

/// v1 `OrchestrationV2StreamingCapabilities`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StreamingCapabilities {
    pub streams_assistant_text: bool,
    pub streams_reasoning: bool,
    pub streams_tool_output: bool,
    pub streams_plan_text: bool,
    pub emits_message_completed: bool,
}

/// v1 `OrchestrationV2CheckpointCapabilities`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointCapabilities {
    pub app_can_checkpoint_filesystem: bool,
    pub supports_nested_checkpoint_scopes: bool,
    pub provider_can_rollback_conversation: bool,
    pub provider_rollback_returns_snapshot: bool,
    pub provider_can_read_conversation_snapshot: bool,
}

/// v1 runtime policy `enforcement`.
#[derive(
    Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema,
)]
#[serde(rename_all = "kebab-case")]
pub enum RuntimePolicyEnforcement {
    Native,
    #[default]
    ClientBoundary,
}

/// v1 `OrchestrationV2RuntimePolicyCapabilities`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RuntimePolicyCapabilities {
    pub enforcement: RuntimePolicyEnforcement,
}

/// v1 `OrchestrationV2IdentityCapabilities`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct IdentityCapabilities {
    pub native_thread_ids: NativeRefStrength,
    pub native_turn_ids: NativeRefStrength,
    pub native_item_ids: NativeRefStrength,
    pub native_request_ids: NativeRefStrength,
}
