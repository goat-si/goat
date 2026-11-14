import { it, expect } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  OrchestrationV2ProviderCapabilities,
  OrchestrationV2TurnCapabilities,
} from "./orchestrationV2.ts";

const decodeOrchestrationV2ProviderCapabilities = Schema.decodeUnknownSync(
  OrchestrationV2ProviderCapabilities,
);

const legacyCapabilities = {
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: false,
    supportsProviderSwitchingViaHandoff: true,
    supportsRuntimeModeSwitchInSession: false,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: false,
    canRollbackThread: true,
    canForkThread: false,
    canForkFromTurn: false,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: false,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsActiveSteering: false,
    supportsSteeringByInterruptRestart: true,
    supportsQueuedMessages: true,
    terminalStatusQuality: "strong",
  },
  streaming: {
    streamsAssistantText: true,
    streamsReasoning: true,
    streamsToolOutput: true,
    streamsPlanText: false,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: true,
    emitsToolStarted: true,
    emitsToolCompleted: true,
    emitsToolOutput: true,
    supportsMcpTools: false,
    supportsDynamicToolCallbacks: false,
  },
  approvals: {
    supportsCommandApproval: true,
    supportsFileReadApproval: true,
    supportsFileChangeApproval: true,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: false,
    approvalCallbacksAreLiveOnly: true,
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    emitsPlanUpdated: true,
    emitsTodoList: true,
    emitsProposedPlan: false,
    supportsStructuredQuestions: true,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    supportsSubagents: false,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: false,
    canWaitForSubagents: false,
    canCloseSubagents: false,
    canForkSubagentThread: false,
  },
  context: {
    acceptsSystemContext: false,
    acceptsDeveloperContext: false,
    acceptsSyntheticUserContext: true,
    canGenerateSummaries: true,
    canConsumeHandoffSummaries: true,
    supportsDeltaHandoff: true,
    supportsFullThreadHandoff: true,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: true,
    supportsNestedCheckpointScopes: true,
    providerCanRollbackConversation: true,
    providerRollbackReturnsSnapshot: true,
    providerCanReadConversationSnapshot: false,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "weak",
    nativeItemIds: "weak",
    nativeRequestIds: "weak",
  },
};

it("decodes persisted capability snapshots that predate runtimePolicy", () => {
  const decoded = decodeOrchestrationV2ProviderCapabilities(legacyCapabilities);
  expect(decoded.runtimePolicy).toEqual({ enforcement: "client-boundary" });
  expect(decoded.turns.supportsNativeGoals).toBeUndefined();
  expect(() =>
    decodeOrchestrationV2ProviderCapabilities({
      ...legacyCapabilities,
      turns: { ...legacyCapabilities.turns, supportsNativeGoals: "yes" },
    }),
  ).toThrow();

  const explicit = decodeOrchestrationV2ProviderCapabilities({
    ...legacyCapabilities,
    runtimePolicy: { enforcement: "native" },
  });
  expect(explicit.runtimePolicy).toEqual({ enforcement: "native" });
});

// A peer built from dev before supportsNativeGoals: the same contract minus that one field.
const { supportsNativeGoals: _addedField, ...turnFieldsBeforeNativeGoals } =
  OrchestrationV2TurnCapabilities.fields;
const decodeWithPeerBeforeNativeGoals = Schema.decodeUnknownSync(
  Schema.Struct({
    ...OrchestrationV2ProviderCapabilities.fields,
    turns: Schema.Struct(turnFieldsBeforeNativeGoals),
  }),
);

it("an older peer accepts a snapshot that advertises supportsNativeGoals and drops the unknown key", () => {
  expect(Object.keys(turnFieldsBeforeNativeGoals)).not.toContain("supportsNativeGoals");

  for (const supportsNativeGoals of [true, false]) {
    const snapshot = JSON.parse(
      JSON.stringify({
        ...legacyCapabilities,
        turns: { ...legacyCapabilities.turns, supportsNativeGoals },
      }),
    );

    const decoded = decodeWithPeerBeforeNativeGoals(snapshot);
    expect(decoded.turns).toEqual(legacyCapabilities.turns);
    expect(Object.hasOwn(decoded.turns, "supportsNativeGoals")).toBe(false);
    expect(decodeOrchestrationV2ProviderCapabilities(snapshot).turns.supportsNativeGoals).toBe(
      supportsNativeGoals,
    );
  }
});
