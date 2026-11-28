//! Smoke round trips for the nested flatten + internally tagged shapes.

use goat2_contracts::*;
use serde_json::json;

#[test]
fn item_completed_line_round_trips_with_v1_field_names() {
    let line_json = json!({
        "v": 1,
        "seq": 7,
        "at": "2026-11-28T10:00:00Z",
        "type": "item.completed",
        "runId": "run-1",
        "item": {
            "id": "item-1",
            "threadId": "thr-1",
            "runId": "run-1",
            "providerThreadId": null,
            "providerTurnId": "turn-1",
            "nativeItemRef": null,
            "parentItemId": null,
            "ordinal": 3,
            "status": "completed",
            "title": null,
            "startedAt": null,
            "completedAt": "2026-11-28T10:00:00Z",
            "updatedAt": "2026-11-28T10:00:00Z",
            "type": "command_execution",
            "input": "cargo test",
            "outputOmitted": true,
            "exitCode": 0
        },
        "engineLocator": { "turnId": "turn-1", "itemId": "call-1" }
    });
    let line: LogLine = serde_json::from_value(line_json.clone()).expect("decode");
    assert_eq!(line.event.type_tag(), "item.completed");
    let LogEvent::ItemCompleted(event) = &line.event else {
        panic!("wrong variant")
    };
    assert_eq!(event.item.body.type_tag(), "command_execution");
    assert_eq!(serde_json::to_value(&line).expect("encode"), line_json);
}

#[test]
fn capabilities_apply_v1_decoding_defaults() {
    let mut value = json!({
        "sessions": {
            "supportsMultipleProviderThreadsPerSession": false,
            "supportsModelSwitchInSession": true,
            "supportsProviderSwitchingViaHandoff": false,
            "supportsRuntimeModeSwitchInSession": true,
            "pendingRequestsSurviveRestart": false
        },
        "threads": {
            "canCreateEmptyThread": true, "canReadThreadSnapshot": true, "canRollbackThread": true,
            "canForkThread": true, "canForkFromTurn": false, "canForkFromSubagentThread": false,
            "exposesNativeThreadId": true
        },
        "turns": {
            "exposesNativeTurnId": true, "emitsTurnStarted": true, "emitsTurnCompleted": true,
            "supportsInterrupt": true, "supportsActiveSteering": true,
            "supportsSteeringByInterruptRestart": true, "supportsQueuedMessages": true,
            "terminalStatusQuality": "strong"
        },
        "streaming": {
            "streamsAssistantText": true, "streamsReasoning": true, "streamsToolOutput": true,
            "streamsPlanText": true, "emitsMessageCompleted": true
        },
        "tools": {
            "exposesToolItemIds": true, "emitsToolStarted": true, "emitsToolCompleted": true,
            "emitsToolOutput": true, "supportsMcpTools": true, "supportsDynamicToolCallbacks": true
        },
        "approvals": {
            "supportsCommandApproval": true, "supportsFileReadApproval": false,
            "supportsFileChangeApproval": true, "supportsApplyPatchApproval": true,
            "approvalsHaveNativeRequestIds": true, "approvalCallbacksAreLiveOnly": true,
            "approvalsCanOriginateFromSubagents": true
        },
        "planning": {
            "emitsPlanUpdated": true, "emitsTodoList": true, "emitsProposedPlan": true,
            "supportsStructuredQuestions": true, "planDeltasHaveItemIds": true
        },
        "subagents": {
            "supportsSubagents": true, "exposesSubagentThreadIds": true,
            "emitsSubagentLifecycle": true, "canWaitForSubagents": true,
            "canCloseSubagents": true, "canForkSubagentThread": false
        },
        "context": {
            "acceptsSystemContext": false, "acceptsDeveloperContext": true,
            "acceptsSyntheticUserContext": true, "canGenerateSummaries": true,
            "canConsumeHandoffSummaries": true, "supportsDeltaHandoff": true,
            "supportsFullThreadHandoff": true, "maxRecommendedHandoffChars": null
        },
        "checkpointing": {
            "appCanCheckpointFilesystem": true, "supportsNestedCheckpointScopes": false,
            "providerCanRollbackConversation": true, "providerRollbackReturnsSnapshot": false,
            "providerCanReadConversationSnapshot": true
        },
        "identity": {
            "nativeThreadIds": "strong", "nativeTurnIds": "strong",
            "nativeItemIds": "strong", "nativeRequestIds": "strong"
        }
    });
    let caps: ProviderCapabilities = serde_json::from_value(value.clone()).expect("decode");
    assert_eq!(
        caps.sessions.source_restriction,
        CloudSourceRestriction::PublishedRef
    );
    assert_eq!(caps.sessions.execution_location, ExecutionLocation::Local);
    assert!(caps.sessions.follow_up.supported);
    assert_eq!(
        caps.runtime_policy.enforcement,
        RuntimePolicyEnforcement::ClientBoundary
    );

    let sessions = value["sessions"].as_object_mut().expect("object");
    sessions.insert("sourceRestriction".into(), json!("published-ref"));
    sessions.insert("executionLocation".into(), json!("local"));
    sessions.insert("followUp".into(), json!({ "supported": true }));
    value["runtimePolicy"] = json!({ "enforcement": "client-boundary" });
    assert_eq!(serde_json::to_value(&caps).expect("encode"), value);
}
