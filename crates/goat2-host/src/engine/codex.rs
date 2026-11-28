//! Codex driver adapter point.
//!
//! `goat2-engine-codex` (lane B) owns the Codex app-server driver. Until it implements the
//! `goat2-engine-api` seam on `goat2`, this factory refuses to start with a clear reason, so runs
//! fail visibly instead of pretending to work. Wire the real driver here and nowhere else.

use async_trait::async_trait;
use goat2_contracts::ProviderCapabilities;

use super::{EngineError, EngineFactory, EngineHandle, SessionSpec};

/// v1 `CodexProviderCapabilitiesV2`, values verbatim from goat-si/goat origin/dev 916b5ccc
/// `apps/server/src/orchestration-v2/Adapters/CodexCapabilities.ts:3-101` (v1 sets no `memory`).
pub fn codex_capabilities() -> ProviderCapabilities {
    serde_json::from_value(serde_json::json!({
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
        "runtimePolicy": { "enforcement": "native" }
    }))
    .expect("v1 Codex capabilities decode as the contract type")
}

#[derive(Debug, Default, Clone)]
pub struct CodexFactory;

#[async_trait]
impl EngineFactory for CodexFactory {
    fn capabilities(&self) -> ProviderCapabilities {
        codex_capabilities()
    }

    async fn start(&self, _spec: SessionSpec) -> Result<EngineHandle, EngineError> {
        Err(EngineError::Unavailable(
            "the Codex driver (goat2-engine-codex) is not on goat2 yet".to_owned(),
        ))
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn v1_codex_capabilities_decode() {
        let caps = super::codex_capabilities();
        assert!(caps.turns.supports_active_steering);
        assert!(caps.sessions.supports_model_switch_in_session);
        assert!(caps.memory.is_none());
    }
}
