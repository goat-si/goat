//! Capability flags equal to GOAT v1 `CodexProviderCapabilitiesV2`
//! (`apps/server/src/orchestration-v2/Adapters/CodexCapabilities.ts:3-101`, goat origin/dev 916b5ccc).
//!
//! The flags describe Codex itself, as v1 declares them. Part 1's driver implements a subset of
//! the operations they imply; callers check [IMPLEMENTED_OPERATIONS] before using one, and the
//! host never infers an operation from a flag alone (fork, rollback, snapshot reads and dynamic
//! tool callbacks are not implemented in Part 1).

use serde_json::json;

use crate::contract::ProviderCapabilities;

/// Operations the Part 1 driver implements.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Operation {
    ThreadStart,
    ThreadResume,
    TurnStart,
    TurnSteer,
    TurnInterrupt,
    AnswerRequest,
    Shutdown,
}

pub const IMPLEMENTED_OPERATIONS: &[Operation] = &[
    Operation::ThreadStart,
    Operation::ThreadResume,
    Operation::TurnStart,
    Operation::TurnSteer,
    Operation::TurnInterrupt,
    Operation::AnswerRequest,
    Operation::Shutdown,
];

/// v1 `CodexProviderCapabilitiesV2`.
pub fn codex_capabilities() -> ProviderCapabilities {
    serde_json::from_value(json!({
        "sessions": {
            "supportsMultipleProviderThreadsPerSession": true,
            "supportsModelSwitchInSession": true,
            "supportsProviderSwitchingViaHandoff": true,
            "supportsRuntimeModeSwitchInSession": true,
            "pendingRequestsSurviveRestart": false
        },
        "threads": {
            "canCreateEmptyThread": true,
            "canReadThreadSnapshot": true,
            "canRollbackThread": true,
            "canForkThread": true,
            "canForkFromTurn": true,
            "canForkWhileSourceRunning": true,
            "canForkFromSubagentThread": true,
            "exposesNativeThreadId": true,
            "forkHonorsTargetCwd": true
        },
        "turns": {
            "exposesNativeTurnId": true,
            "emitsTurnStarted": true,
            "emitsTurnCompleted": true,
            "supportsInterrupt": true,
            "supportsNativeResume": true,
            "supportsActiveSteering": true,
            "activeSteeringDuringCompaction": true,
            "supportsSteeringByInterruptRestart": true,
            "supportsQueuedMessages": true,
            "terminalStatusQuality": "strong"
        },
        "streaming": {
            "streamsAssistantText": true,
            "streamsReasoning": true,
            "streamsToolOutput": true,
            "streamsPlanText": true,
            "emitsMessageCompleted": true
        },
        "tools": {
            "exposesToolItemIds": true,
            "emitsToolStarted": true,
            "emitsToolCompleted": true,
            "emitsToolOutput": true,
            "supportsMcpTools": true,
            "supportsDynamicToolCallbacks": true
        },
        "approvals": {
            "supportsCommandApproval": true,
            "supportsFileReadApproval": true,
            "supportsFileChangeApproval": true,
            "supportsApplyPatchApproval": true,
            "approvalsHaveNativeRequestIds": true,
            "approvalCallbacksAreLiveOnly": true,
            "approvalsCanOriginateFromSubagents": true
        },
        "planning": {
            "emitsPlanUpdated": true,
            "emitsTodoList": true,
            "emitsProposedPlan": true,
            "supportsStructuredQuestions": true,
            "planDeltasHaveItemIds": true
        },
        "subagents": {
            "supportsSubagents": true,
            "exposesSubagentThreadIds": true,
            "emitsSubagentLifecycle": true,
            "canWaitForSubagents": true,
            "canCloseSubagents": true,
            "canForkSubagentThread": true
        },
        "context": {
            "acceptsSystemContext": true,
            "acceptsDeveloperContext": true,
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
            "providerCanRollbackConversation": true,
            "providerRollbackReturnsSnapshot": true,
            "providerCanReadConversationSnapshot": true
        },
        "identity": {
            "nativeThreadIds": "strong",
            "nativeTurnIds": "strong",
            "nativeItemIds": "strong",
            "nativeRequestIds": "strong"
        },
        "runtimePolicy": {
            "enforcement": "native"
        }
    }))
    .expect("v1 Codex capabilities decode into ProviderCapabilities")
}
