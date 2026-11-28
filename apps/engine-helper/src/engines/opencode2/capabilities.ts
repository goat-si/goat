// Adapted from provider-opencode/src/server/v2/capabilities.ts at 916b5ccc1b.
import type { ProviderCapabilities } from "@goat2/contracts-rs";

const openCode2Capabilities: ProviderCapabilities = {
  "sessions": {
    "sourceRestriction": "published-ref",
    "executionLocation": "local",
    "followUp": { "supported": true },
    "ownsProcess": false,
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
    "canForkFromSubagentThread": false,
    "exposesNativeThreadId": true
  },
  "turns": {
    "exposesNativeTurnId": false,
    "emitsTurnStarted": true,
    "emitsTurnCompleted": true,
    "supportsInterrupt": true,
    "supportsNativeResume": true,
    "supportsActiveSteering": true,
    "supportsSteeringByInterruptRestart": true,
    "supportsQueuedMessages": true,
    "terminalStatusQuality": "strong"
  },
  "streaming": {
    "streamsAssistantText": true,
    "streamsReasoning": true,
    "streamsToolOutput": false,
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
    "supportsApplyPatchApproval": true,
    "approvalsHaveNativeRequestIds": true,
    "approvalCallbacksAreLiveOnly": true,
    "approvalsCanOriginateFromSubagents": true
  },
  "planning": {
    "emitsPlanUpdated": true,
    "emitsTodoList": true,
    "emitsProposedPlan": false,
    "supportsStructuredQuestions": true,
    "planDeltasHaveItemIds": false
  },
  "subagents": {
    "supportsSubagents": true,
    "exposesSubagentThreadIds": true,
    "emitsSubagentLifecycle": true,
    "canWaitForSubagents": true,
    "canCloseSubagents": false,
    "canForkSubagentThread": false
  },
  "context": {
    "acceptsSystemContext": false,
    "acceptsDeveloperContext": false,
    "acceptsSyntheticUserContext": true,
    "canGenerateSummaries": false,
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
    "nativeTurnIds": "weak",
    "nativeItemIds": "strong",
    "nativeRequestIds": "strong"
  },
  "runtimePolicy": {
    "enforcement": "native"
  }
};

// driver.ts:197-209: native goals were added in OpenCode 2.2.5.
export function capabilitiesForOpenCode2(version: string): ProviderCapabilities {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([^+]+))?(?:\+.*)?$/.exec(version.trim().replace(/^v/, ""));
  const enabled = !!match && (Number(match[1]) > 2 || (Number(match[1]) === 2 && (Number(match[2]) > 2 || (Number(match[2]) === 2 && (Number(match[3]) > 5 || (Number(match[3]) === 5 && !match[4]))))));
  return { ...openCode2Capabilities, turns: { ...openCode2Capabilities.turns, supportsNativeGoals: enabled } };
}
