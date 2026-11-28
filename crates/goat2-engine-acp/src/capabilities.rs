//! ACP capability flags, equal to GOAT v1.
//!
//! v1: `packages/provider-acp/src/server/capabilities.ts:15-108` (`AcpProviderCapabilitiesV2`) and
//! `:110-147` (`negotiatedCapabilities`). The literal below is the v1 object with the same keys and
//! values, decoded through `goat2-contracts::ProviderCapabilities` so a typo fails the build's tests.

use goat2_contracts::ProviderCapabilities;
use serde_json::json;

use crate::wire::InitializeInfo;

/// v1 `AcpProviderCapabilitiesV2` (capabilities.ts:15-108), verbatim values.
pub fn acp_base_capabilities() -> ProviderCapabilities {
    serde_json::from_value(json!({
        "sessions": {
            "supportsMultipleProviderThreadsPerSession": false,
            "supportsModelSwitchInSession": false,
            "supportsProviderSwitchingViaHandoff": true,
            "supportsRuntimeModeSwitchInSession": false,
            "pendingRequestsSurviveRestart": false
        },
        "threads": {
            "canCreateEmptyThread": true,
            "canReadThreadSnapshot": false,
            "canRollbackThread": true,
            "canForkThread": false,
            "canForkFromTurn": false,
            "canForkFromSubagentThread": false,
            "exposesNativeThreadId": true
        },
        "turns": {
            "exposesNativeTurnId": false,
            "emitsTurnStarted": true,
            "emitsTurnCompleted": true,
            "supportsInterrupt": true,
            "supportsNativeResume": false,
            "supportsActiveSteering": false,
            "supportsSteeringByInterruptRestart": true,
            "supportsQueuedMessages": true,
            "terminalStatusQuality": "strong"
        },
        "streaming": {
            "streamsAssistantText": true,
            "streamsReasoning": true,
            "streamsToolOutput": true,
            "streamsPlanText": false,
            "emitsMessageCompleted": true
        },
        "tools": {
            "exposesToolItemIds": true,
            "emitsToolStarted": true,
            "emitsToolCompleted": true,
            "emitsToolOutput": true,
            "supportsMcpTools": false,
            "supportsDynamicToolCallbacks": false
        },
        "approvals": {
            "supportsCommandApproval": true,
            "supportsFileReadApproval": true,
            "supportsFileChangeApproval": true,
            "supportsApplyPatchApproval": false,
            "approvalsHaveNativeRequestIds": false,
            "approvalCallbacksAreLiveOnly": true,
            "approvalsCanOriginateFromSubagents": false
        },
        "planning": {
            "emitsPlanUpdated": true,
            "emitsTodoList": true,
            "emitsProposedPlan": false,
            "supportsStructuredQuestions": true,
            "planDeltasHaveItemIds": false
        },
        "subagents": {
            "supportsSubagents": false,
            "exposesSubagentThreadIds": false,
            "emitsSubagentLifecycle": false,
            "canWaitForSubagents": false,
            "canCloseSubagents": false,
            "canForkSubagentThread": false
        },
        "context": {
            "acceptsSystemContext": false,
            "acceptsDeveloperContext": false,
            "acceptsSyntheticUserContext": true,
            "canGenerateSummaries": true,
            "canConsumeHandoffSummaries": true,
            "supportsDeltaHandoff": true,
            "supportsFullThreadHandoff": true,
            "maxRecommendedHandoffChars": null
        },
        "checkpointing": {
            "appCanCheckpointFilesystem": true,
            "supportsNestedCheckpointScopes": true,
            "providerCanRollbackConversation": false,
            "providerRollbackReturnsSnapshot": true,
            "providerCanReadConversationSnapshot": false
        },
        "identity": {
            "nativeThreadIds": "strong",
            "nativeTurnIds": "weak",
            "nativeItemIds": "weak",
            "nativeRequestIds": "weak"
        },
        "runtimePolicy": { "enforcement": "client-boundary" }
    }))
    .expect("v1 ACP capability literal decodes")
}

/// v1 `negotiatedCapabilities` (capabilities.ts:110-147): what the started agent adds.
pub fn negotiated_capabilities(
    base: &ProviderCapabilities,
    init: &InitializeInfo,
    can_switch_model: bool,
    steers_with_prompt: bool,
) -> ProviderCapabilities {
    let mut caps = base.clone();
    caps.sessions.supports_model_switch_in_session = can_switch_model;
    caps.threads.can_read_thread_snapshot = init.load_session;
    caps.threads.can_fork_thread = init.session_fork;
    caps.threads.can_fork_from_turn = false;
    caps.turns.supports_active_steering = base.turns.supports_active_steering || steers_with_prompt;
    // v1: the stdio bridge makes the GOAT MCP toolkit available regardless of http/sse support.
    caps.tools.supports_mcp_tools = true;
    caps.checkpointing.provider_can_read_conversation_snapshot = init.load_session;
    caps
}

/// v1 `ACP_PROMPT_ACTIVITY_UPDATES` (capabilities.ts:208-223).
pub const ACP_PROMPT_ACTIVITY_UPDATES: &[&str] = &[
    "agent_message",
    "agent_message_chunk",
    "agent_thought",
    "agent_thought_chunk",
    "tool_call",
    "tool_call_update",
    "tool_call_content_chunk",
    "terminal_output_chunk",
    "terminal_update",
    "plan",
    "plan_update",
    "plan_removed",
    "compaction_update",
    "compaction_summary_chunk",
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_matches_v1_steering_flags() {
        let caps = acp_base_capabilities();
        assert!(!caps.turns.supports_active_steering);
        assert!(caps.turns.supports_steering_by_interrupt_restart);
        assert_eq!(caps.turns.supports_native_resume, Some(false));
        assert!(caps.threads.can_rollback_thread);
        assert!(caps.turns.supports_queued_messages);
    }

    #[test]
    fn negotiation_follows_agent() {
        let base = acp_base_capabilities();
        let init = InitializeInfo {
            load_session: true,
            session_fork: false,
            ..InitializeInfo::default()
        };
        let caps = negotiated_capabilities(&base, &init, true, true);
        assert!(caps.sessions.supports_model_switch_in_session);
        assert!(caps.threads.can_read_thread_snapshot);
        assert!(caps.turns.supports_active_steering);
        assert!(caps.tools.supports_mcp_tools);
        assert!(caps.checkpointing.provider_can_read_conversation_snapshot);
    }
}
