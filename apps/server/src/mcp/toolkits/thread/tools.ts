import { withClientRequestId } from "../keyedParameters.ts";
import {
  IsoDateTime,
  ModelSelection,
  NonNegativeInt,
  OrchestrationV2ContextTransfer,
  OrchestrationV2DispatchCommandResult,
  OrchestrationV2ThreadForkSourcePoint,
  OrchestratorMcpFailure,
  OrchestratorMcpPendingRequestListInput,
  OrchestratorMcpPendingRequestListResult,
  OrchestratorMcpPendingRequestReadInput,
  OrchestratorMcpPendingRequestReadResult,
  OrchestratorMcpPendingRequestRespondInput,
  OrchestratorMcpPendingRequestRespondResult,
  OrchestratorMcpThreadSearchInput,
  OrchestratorMcpThreadSearchResult,
  ProviderInteractionMode,
  RunId,
  RuntimeMode,
  ScheduledTask,
  ScheduledTaskId,
  ThreadId,
  ThreadResult,
  ThreadResultReport,
  TrimmedNonEmptyString,
} from "@goat/contracts";
import { agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import { agentSurfaceAnnotations } from "../../agentSurface.ts";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ScheduledTaskService from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as ThreadResultService from "../../../threadResults/ThreadResultService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PendingQuestionsMcpService from "../../PendingQuestionsMcpService.ts";
import * as ThreadSearchMcpService from "../../ThreadSearchMcpService.ts";

const ThreadOrganizeTool = Tool.make(agentSurfaceRegistry["thread.organize"].name, {
  description: agentSurfaceRegistry["thread.organize"].description,
  parameters: Schema.Struct({
    threadId: Schema.optional(ThreadId),
    action: Schema.Literals([
      "pin",
      "unpin",
      "snooze",
      "unsnooze",
      "settle",
      "unsettle",
      "archive",
      "unarchive",
      "mark_unread",
    ]),
    snoozedUntil: Schema.optional(IsoDateTime),
  }),
  success: Schema.Union([
    OrchestrationV2DispatchCommandResult,
    Schema.Struct({ settlesWhenTurnEnds: Schema.Literal(true) }),
  ]),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    Crypto.Crypto,
  ],
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["thread.organize"]));

const queueTarget = { threadId: Schema.optional(ThreadId), queuedRunId: RunId };
const commandTool = {
  success: OrchestrationV2DispatchCommandResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    Crypto.Crypto,
  ],
};
const queueEntry = Schema.Struct({
  queuedRunId: RunId,
  text: Schema.String,
  truncated: Schema.Boolean,
});
const QueueListTool = Tool.make(agentSurfaceRegistry["queue.list"].name, {
  ...commandTool,
  description: agentSurfaceRegistry["queue.list"].description,
  parameters: Schema.Struct({
    threadId: Schema.optional(ThreadId),
    cursor: Schema.optional(NonNegativeInt),
    limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  }),
  success: Schema.Struct({
    items: Schema.Array(queueEntry),
    nextCursor: Schema.NullOr(NonNegativeInt),
  }),
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["queue.list"]));
const QueueReadTool = Tool.make(agentSurfaceRegistry["queue.read"].name, {
  ...commandTool,
  description: agentSurfaceRegistry["queue.read"].description,
  parameters: Schema.Struct(queueTarget),
  success: queueEntry,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["queue.read"]));
const QueueEditTool = Tool.make(agentSurfaceRegistry["queue.edit"].name, {
  ...commandTool,
  description: agentSurfaceRegistry["queue.edit"].description,
  parameters: Schema.Struct({
    ...queueTarget,
    text: Schema.String.check(Schema.isMaxLength(100000)),
  }),
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["queue.edit"]));
const QueueCancelTool = Tool.make(agentSurfaceRegistry["queue.cancel"].name, {
  ...commandTool,
  description: agentSurfaceRegistry["queue.cancel"].description,
  parameters: Schema.Struct(queueTarget),
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["queue.cancel"]));
const QueueReorderTool = Tool.make(agentSurfaceRegistry["queue.reorder"].name, {
  ...commandTool,
  description: agentSurfaceRegistry["queue.reorder"].description,
  parameters: Schema.Struct({ ...queueTarget, beforeRunId: Schema.NullOr(RunId) }),
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["queue.reorder"]));
const QueuePromoteTool = Tool.make(agentSurfaceRegistry["queue.promote_to_steer"].name, {
  ...commandTool,
  description: agentSurfaceRegistry["queue.promote_to_steer"].description,
  parameters: Schema.Struct({ ...queueTarget, targetRunId: RunId }),
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["queue.promote_to_steer"]));

const pendingTool = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    PendingQuestionsMcpService.PendingQuestionsMcpService,
    Crypto.Crypto,
  ],
};
const PendingRequestListTool = Tool.make(agentSurfaceRegistry["pending_request.list"].name, {
  ...pendingTool,
  description: agentSurfaceRegistry["pending_request.list"].description,
  parameters: OrchestratorMcpPendingRequestListInput,
  success: OrchestratorMcpPendingRequestListResult,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["pending_request.list"]));
const PendingRequestReadTool = Tool.make(agentSurfaceRegistry["pending_request.read"].name, {
  ...pendingTool,
  description: agentSurfaceRegistry["pending_request.read"].description,
  parameters: OrchestratorMcpPendingRequestReadInput,
  success: OrchestratorMcpPendingRequestReadResult,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["pending_request.read"]));
const PendingRequestRespondTool = Tool.make(agentSurfaceRegistry["pending_request.respond"].name, {
  ...pendingTool,
  description: agentSurfaceRegistry["pending_request.respond"].description,
  parameters: OrchestratorMcpPendingRequestRespondInput,
  success: OrchestratorMcpPendingRequestRespondResult,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["pending_request.respond"]));

const ThreadConfigurationTool = Tool.make(agentSurfaceRegistry["thread.configuration_read"].name, {
  ...commandTool,
  description: agentSurfaceRegistry["thread.configuration_read"].description,
  parameters: Schema.Struct({ threadId: Schema.optional(ThreadId) }),
  success: Schema.Struct({
    threadId: ThreadId,
    modelSelection: ModelSelection,
    runtimeMode: RuntimeMode,
    interactionMode: ProviderInteractionMode,
  }),
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["thread.configuration_read"]));
const ThreadConfigureTool = Tool.make(agentSurfaceRegistry["thread.configure"].name, {
  ...commandTool,
  description: agentSurfaceRegistry["thread.configure"].description,
  parameters: withClientRequestId(
    Schema.Struct({
      threadId: Schema.optional(ThreadId),
      modelSelection: ModelSelection,
    }),
  ),
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["thread.configure"]));

const transferResult = Schema.Struct({ sequence: NonNegativeInt, targetThreadId: ThreadId });
const ThreadForkTool = Tool.make(agentSurfaceRegistry["thread.fork"].name, {
  ...commandTool,
  description: agentSurfaceRegistry["thread.fork"].description,
  parameters: withClientRequestId(
    Schema.Struct({
      threadId: Schema.optional(ThreadId),
      sourcePoint: OrchestrationV2ThreadForkSourcePoint,
      title: Schema.optional(TrimmedNonEmptyString),
    }),
  ),
  success: transferResult,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["thread.fork"]));
const ThreadMergeBackTool = Tool.make(agentSurfaceRegistry["thread.merge_back"].name, {
  ...commandTool,
  description: agentSurfaceRegistry["thread.merge_back"].description,
  parameters: withClientRequestId(
    Schema.Struct({
      sourceThreadId: Schema.optional(ThreadId),
      targetThreadId: ThreadId,
      sourcePoint: OrchestrationV2ThreadForkSourcePoint,
    }),
  ),
  success: transferResult,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["thread.merge_back"]));
const ThreadTransfersTool = Tool.make(agentSurfaceRegistry["thread.transfers"].name, {
  ...commandTool,
  description: agentSurfaceRegistry["thread.transfers"].description,
  parameters: Schema.Struct({ threadId: Schema.optional(ThreadId) }),
  success: Schema.Struct({
    transfers: Schema.Array(
      Schema.Struct({
        id: OrchestrationV2ContextTransfer.fields.id,
        sourceThreadId: OrchestrationV2ContextTransfer.fields.sourceThreadId,
        targetThreadId: OrchestrationV2ContextTransfer.fields.targetThreadId,
        status: OrchestrationV2ContextTransfer.fields.status,
      }),
    ),
  }),
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["thread.transfers"]));

const ThreadSearchTool = Tool.make(agentSurfaceRegistry["thread.search"].name, {
  ...commandTool,
  description: agentSurfaceRegistry["thread.search"].description,
  parameters: OrchestratorMcpThreadSearchInput,
  success: OrchestratorMcpThreadSearchResult,
  dependencies: [...commandTool.dependencies, ThreadSearchMcpService.ThreadSearchMcpService],
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["thread.search"]));

const ScheduledTaskRunTool = Tool.make(agentSurfaceRegistry["schedule.run"].name, {
  ...commandTool,
  description: agentSurfaceRegistry["schedule.run"].description,
  parameters: withClientRequestId(Schema.Struct({ taskId: ScheduledTaskId })),
  success: Schema.Struct({
    taskId: ScheduledTaskId,
    threadId: ScheduledTask.fields.threadId,
    lastRunStatus: ScheduledTask.fields.lastRunStatus,
    runCount: NonNegativeInt,
    nextRunAt: ScheduledTask.fields.nextRunAt,
  }),
  dependencies: [...commandTool.dependencies, ScheduledTaskService.ScheduledTaskService],
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["schedule.run"]));

const ThreadReportResultTool = Tool.make(agentSurfaceRegistry["thread.report_result"].name, {
  description: agentSurfaceRegistry["thread.report_result"].description,
  parameters: ThreadResultReport,
  success: ThreadResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ThreadResultService.ThreadResultService,
  ],
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["thread.report_result"]));

export const ThreadToolkit = Toolkit.make(
  ScheduledTaskRunTool,
  ThreadReportResultTool,
  ThreadSearchTool,
  ThreadForkTool,
  ThreadMergeBackTool,
  ThreadTransfersTool,
  ThreadConfigurationTool,
  ThreadConfigureTool,
  PendingRequestListTool,
  PendingRequestReadTool,
  PendingRequestRespondTool,
  ThreadOrganizeTool,
  QueueListTool,
  QueueReadTool,
  QueueEditTool,
  QueueCancelTool,
  QueueReorderTool,
  QueuePromoteTool,
);
