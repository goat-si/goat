import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { PositiveInt } from "./baseSchemas.ts";

export const OrchestrationV2ToolCapabilities = Schema.Struct({
  exposesToolItemIds: Schema.Boolean,
  emitsToolStarted: Schema.Boolean,
  emitsToolCompleted: Schema.Boolean,
  emitsToolOutput: Schema.Boolean,
  supportsMcpTools: Schema.Boolean,
  supportsDynamicToolCallbacks: Schema.Boolean,
});
export type OrchestrationV2ToolCapabilities = typeof OrchestrationV2ToolCapabilities.Type;

export const OrchestrationV2ApprovalCapabilities = Schema.Struct({
  supportsCommandApproval: Schema.Boolean,
  supportsFileReadApproval: Schema.Boolean,
  supportsFileChangeApproval: Schema.Boolean,
  supportsApplyPatchApproval: Schema.Boolean,
  approvalsHaveNativeRequestIds: Schema.Boolean,
  approvalCallbacksAreLiveOnly: Schema.Boolean,
  approvalsCanOriginateFromSubagents: Schema.Boolean,
});
export type OrchestrationV2ApprovalCapabilities = typeof OrchestrationV2ApprovalCapabilities.Type;

export const OrchestrationV2PlanningCapabilities = Schema.Struct({
  emitsPlanUpdated: Schema.Boolean,
  emitsTodoList: Schema.Boolean,
  emitsProposedPlan: Schema.Boolean,
  supportsStructuredQuestions: Schema.Boolean,
  planDeltasHaveItemIds: Schema.Boolean,
});
export type OrchestrationV2PlanningCapabilities = typeof OrchestrationV2PlanningCapabilities.Type;

export const OrchestrationV2SubagentCapabilities = Schema.Struct({
  supportsSubagents: Schema.Boolean,
  exposesSubagentThreadIds: Schema.Boolean,
  emitsSubagentLifecycle: Schema.Boolean,
  canWaitForSubagents: Schema.Boolean,
  canCloseSubagents: Schema.Boolean,
  canForkSubagentThread: Schema.Boolean,
});
export type OrchestrationV2SubagentCapabilities = typeof OrchestrationV2SubagentCapabilities.Type;

export const OrchestrationV2ContextCapabilities = Schema.Struct({
  acceptsSystemContext: Schema.Boolean,
  acceptsDeveloperContext: Schema.Boolean,
  acceptsSyntheticUserContext: Schema.Boolean,
  canGenerateSummaries: Schema.Boolean,
  canConsumeHandoffSummaries: Schema.Boolean,
  supportsDeltaHandoff: Schema.Boolean,
  supportsFullThreadHandoff: Schema.Boolean,
  maxRecommendedHandoffChars: Schema.NullOr(PositiveInt),
});
export type OrchestrationV2ContextCapabilities = typeof OrchestrationV2ContextCapabilities.Type;

export const OrchestrationV2CloudSourceRestriction = Schema.Literals([
  "published-ref",
  "clean-pushed-sha",
  "project-folder",
]);
export type OrchestrationV2CloudSourceRestriction =
  typeof OrchestrationV2CloudSourceRestriction.Type;

export const OrchestrationV2SessionCapabilities = Schema.Struct({
  sourceRestriction: Schema.optional(OrchestrationV2CloudSourceRestriction).pipe(
    Schema.withDecodingDefault(Effect.succeed("published-ref" as const)),
  ),
  executionLocation: Schema.optional(Schema.Literals(["local", "cloud"])).pipe(
    Schema.withDecodingDefault(Effect.succeed("local" as const)),
  ),
  followUp: Schema.optional(
    Schema.Struct({
      supported: Schema.Boolean,
      reason: Schema.optional(Schema.String),
    }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed({ supported: true }))),
  supportsMultipleProviderThreadsPerSession: Schema.Boolean,
  supportsModelSwitchInSession: Schema.Boolean,
  supportsProviderSwitchingViaHandoff: Schema.Boolean,
  supportsRuntimeModeSwitchInSession: Schema.Boolean,
  pendingRequestsSurviveRestart: Schema.Boolean,
});
export type OrchestrationV2SessionCapabilities = typeof OrchestrationV2SessionCapabilities.Type;

export const OrchestrationV2ThreadCapabilities = Schema.Struct({
  canCreateEmptyThread: Schema.Boolean,
  canReadThreadSnapshot: Schema.Boolean,
  canRollbackThread: Schema.Boolean,
  canForkThread: Schema.Boolean,
  canForkFromTurn: Schema.Boolean,
  canForkFromSubagentThread: Schema.Boolean,
  exposesNativeThreadId: Schema.Boolean,
  /** Native fork starts the new provider thread in the target thread's cwd. */
  forkHonorsTargetCwd: Schema.optionalKey(Schema.Boolean),
});
export type OrchestrationV2ThreadCapabilities = typeof OrchestrationV2ThreadCapabilities.Type;

export const OrchestrationV2TurnCapabilities = Schema.Struct({
  supportsNativeGoals: Schema.optional(Schema.Boolean),
  exposesNativeTurnId: Schema.Boolean,
  emitsTurnStarted: Schema.Boolean,
  emitsTurnCompleted: Schema.Boolean,
  supportsInterrupt: Schema.Boolean,
  supportsActiveSteering: Schema.Boolean,
  // Some native steering mechanisms cancel pending tools before consuming the message.
  activeSteeringInterruptsTools: Schema.optional(Schema.Boolean),
  // Some take text only, so a steer with attachments restarts the turn instead.
  activeSteeringAcceptsAttachments: Schema.optional(Schema.Boolean),
  // Only where a steer leaves a running automatic compaction intact; otherwise clients queue.
  activeSteeringDuringCompaction: Schema.optional(Schema.Boolean),
  supportsSteeringByInterruptRestart: Schema.Boolean,
  supportsQueuedMessages: Schema.Boolean,
  terminalStatusQuality: Schema.Literals(["strong", "weak", "none"]),
});
export type OrchestrationV2TurnCapabilities = typeof OrchestrationV2TurnCapabilities.Type;

export const OrchestrationV2StreamingCapabilities = Schema.Struct({
  streamsAssistantText: Schema.Boolean,
  streamsReasoning: Schema.Boolean,
  streamsToolOutput: Schema.Boolean,
  streamsPlanText: Schema.Boolean,
  emitsMessageCompleted: Schema.Boolean,
});
export type OrchestrationV2StreamingCapabilities = typeof OrchestrationV2StreamingCapabilities.Type;
