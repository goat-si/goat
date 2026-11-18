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
