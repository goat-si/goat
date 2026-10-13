import {
  ScheduledTaskId,
  ScheduledTask,
  OrchestrationV2ThreadForkSourcePoint,
  OrchestrationV2ContextTransfer,
  TrimmedNonEmptyString,
  ModelSelection,
  RuntimeMode,
  ProviderInteractionMode,
  IsoDateTime,
  OrchestratorMcpFailure,
  OrchestratorMcpPendingRequestListInput,
  OrchestratorMcpPendingRequestListResult,
  OrchestratorMcpPendingRequestReadInput,
  OrchestratorMcpPendingRequestReadResult,
  OrchestratorMcpPendingRequestRespondInput,
  OrchestratorMcpPendingRequestRespondResult,
  OrchestratorMcpThreadSearchInput,
  OrchestratorMcpThreadSearchResult,
  OrchestrationV2DispatchCommandResult,
  ThreadId,
  RunId,
  NonNegativeInt,
  ThreadResult,
  ThreadResultReport,
} from "@goat/contracts";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ScheduledTaskService from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadResultService from "../../../threadResults/ThreadResultService.ts";
import * as PendingQuestionsMcpService from "../../PendingQuestionsMcpService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadSearchMcpService from "../../ThreadSearchMcpService.ts";

const ThreadOrganizeTool = Tool.make("goat_thread_organize", {
  description:
    "Pin, snooze, settle, archive, or mark a thread unread. Omit threadId for this thread. snooze requires snoozedUntil. Existing thread lifecycle rules apply. Settling this thread takes effect when your turn completes, returning settlesWhenTurnEnds=true; a turn that fails or is interrupted, or a queued message, leaves it active.",
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
})
  .annotate(Tool.Title, "Organize a thread")
  .annotate(Tool.Destructive, true);

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
const QueueListTool = Tool.make("goat_queue_list", {
  ...commandTool,
  description:
    "List queued messages in delivery order. Results are a live offset page; use goat_thread_read for full thread history.",
  parameters: Schema.Struct({
    threadId: Schema.optional(ThreadId),
    cursor: Schema.optional(NonNegativeInt),
    limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  }),
  success: Schema.Struct({
    items: Schema.Array(queueEntry),
    nextCursor: Schema.NullOr(NonNegativeInt),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const QueueReadTool = Tool.make("goat_queue_read", {
  ...commandTool,
  description: "Read up to 16,000 characters of a queued message. Omit threadId for this thread.",
  parameters: Schema.Struct(queueTarget),
  success: queueEntry,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const QueueEditTool = Tool.make("goat_queue_edit", {
  ...commandTool,
  description:
    "Replace a queued message's text, preserving its attachments. The service rejects runs that are no longer queued.",
  parameters: Schema.Struct({
    ...queueTarget,
    text: Schema.String.check(Schema.isMaxLength(100000)),
  }),
}).annotate(Tool.Destructive, true);
const QueueCancelTool = Tool.make("goat_queue_cancel", {
  ...commandTool,
  description: "Cancel a queued run using the existing queue command.",
  parameters: Schema.Struct(queueTarget),
}).annotate(Tool.Destructive, true);
const QueueReorderTool = Tool.make("goat_queue_reorder", {
  ...commandTool,
  description: "Move a queued run before another queued run, or to the end with beforeRunId=null.",
  parameters: Schema.Struct({ ...queueTarget, beforeRunId: Schema.NullOr(RunId) }),
}).annotate(Tool.Destructive, true);
const QueuePromoteTool = Tool.make("goat_queue_promote_to_steer", {
  ...commandTool,
  description:
    "Deliver a queued message as steering to the specified active run. Existing provider and run-state rules apply.",
  parameters: Schema.Struct({ ...queueTarget, targetRunId: RunId }),
}).annotate(Tool.Destructive, true);

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
const PendingRequestListTool = Tool.make("goat_pending_request_list", {
  ...pendingTool,
  description:
    "List pending user-input questions. Approvals are human-only and excluded, except that an MCP client token with orchestration:approve also gets approvalRequestIds for one thread. Omit threadId for this thread, or pass host and threadId for another machine. scope='launched' shows your launched threads' questions locally and on connected hosts plus hosts[]. Host fan-out caps at 16; unavailableHosts reports skipped aliases and hosts that could not be queried. Results cap at 100; when truncated, answer questions or narrow with host and threadId. Launcher filters are reserved for outside host transport.",
  parameters: OrchestratorMcpPendingRequestListInput,
  success: OrchestratorMcpPendingRequestListResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const PendingRequestReadTool = Tool.make("goat_pending_request_read", {
  ...pendingTool,
  description:
    "Read a pending or resolved user question, including status, responder and resolution time when available. A caller with orchestration:approve can also read an approval, returned with approval.kind and approval.prompt. Pass host and threadId for another machine. Answer with goat_pending_request_respond or forward to the user; old remotes may omit status and provenance.",
  parameters: OrchestratorMcpPendingRequestReadInput,
  success: OrchestratorMcpPendingRequestReadResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const PendingRequestRespondTool = Tool.make("goat_pending_request_respond", {
  ...pendingTool,
  description:
    "Answer a pending user-input question with answers and a required reason (1–2000 characters, including non-whitespace text). Pass host and threadId for another machine; remote writes need default interaction mode. Approvals are human-only, except for an MCP client token with orchestration:approve, which answers one with decision ('accept' or 'decline') instead of answers. Forward humanRequired questions to the user. respondedBy is reserved for outside host transport; thread callers must omit it.",
  parameters: OrchestratorMcpPendingRequestRespondInput,
  success: OrchestratorMcpPendingRequestRespondResult,
})
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

const ThreadConfigurationTool = Tool.make("goat_thread_configuration", {
  ...commandTool,
  description:
    "Read a thread's provider/model selection and modes. Omit threadId for this thread. orchestrator_capabilities lists available providers and models.",
  parameters: Schema.Struct({ threadId: Schema.optional(ThreadId) }),
  success: Schema.Struct({
    threadId: ThreadId,
    modelSelection: ModelSelection,
    runtimeMode: RuntimeMode,
    interactionMode: ProviderInteractionMode,
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const ThreadConfigureTool = Tool.make("goat_thread_configure", {
  ...commandTool,
  description:
    "Set a thread's provider, model and options with the existing selection command. Omit threadId for this thread. This does not change permission modes. Use orchestrator_capabilities to choose a selection.",
  parameters: Schema.Struct({
    threadId: Schema.optional(ThreadId),
    modelSelection: ModelSelection,
  }),
}).annotate(Tool.Destructive, true);

const transferResult = Schema.Struct({ sequence: NonNegativeInt, targetThreadId: ThreadId });
const ThreadForkTool = Tool.make("goat_thread_fork", {
  ...commandTool,
  description:
    "Fork a thread from a stable run or checkpoint using the existing fork command. Omit threadId to fork this thread. The fork inherits the source configuration. Acceptance does not mean a provider turn has completed.",
  parameters: Schema.Struct({
    threadId: Schema.optional(ThreadId),
    sourcePoint: OrchestrationV2ThreadForkSourcePoint,
    title: Schema.optional(TrimmedNonEmptyString),
  }),
  success: transferResult,
}).annotate(Tool.Destructive, true);
const ThreadMergeBackTool = Tool.make("goat_thread_merge_back", {
  ...commandTool,
  description:
    "Merge context from a thread back to a related thread in the same project. Omit sourceThreadId to merge from this thread. Existing lineage and transfer rules apply.",
  parameters: Schema.Struct({
    sourceThreadId: Schema.optional(ThreadId),
    targetThreadId: ThreadId,
    sourcePoint: OrchestrationV2ThreadForkSourcePoint,
  }),
  success: transferResult,
}).annotate(Tool.Destructive, true);
const ThreadTransfersTool = Tool.make("goat_thread_transfers", {
  ...commandTool,
  description: "Read context transfer status for a thread. Omit threadId for this thread.",
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
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const ThreadSearchTool = Tool.make("goat_thread_search", {
  ...commandTool,
  description:
    "Find threads whose title or finished user/assistant messages contain query (case-insensitive substring). Each match is one thread, newest first, with host, title, project, status, updatedAt and a snippet; source says whether a user message, assistant message, or only the title matched. Searches one project (projectId, else the calling thread's project) unless allProjects; a caller outside a GOAT thread searches every project. Filter by statuses, updatedAfter/updatedBefore, and includeArchived. With host, searches that machine (every project there unless projectId names one of its projects). hosts searches those SSH hosts, and allHosts this environment plus every SSH host it is connected to; matches are merged newest first, and hosts that cannot be searched are listed in unavailableHosts without failing the call and left out of later pages. Page with nextCursor, passing the same arguments. Each environment considers its newest 1000 matching threads; truncated says one had more, so narrow the filters. Read a match with goat_thread_read, passing its host and threadId.",
  parameters: OrchestratorMcpThreadSearchInput,
  success: OrchestratorMcpThreadSearchResult,
  dependencies: [...commandTool.dependencies, ThreadSearchMcpService.ThreadSearchMcpService],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const ScheduledTaskRunTool = Tool.make("run_scheduled_task_now", {
  ...commandTool,
  description:
    "Run a scheduled task now through the existing scheduler. Requires a full-access/default caller. Each call is a new manual run; completion means dispatch/bookkeeping completed, not that the provider turn finished.",
  parameters: Schema.Struct({ taskId: ScheduledTaskId }),
  success: Schema.Struct({
    taskId: ScheduledTaskId,
    threadId: ScheduledTask.fields.threadId,
    lastRunStatus: ScheduledTask.fields.lastRunStatus,
    runCount: NonNegativeInt,
    nextRunAt: ScheduledTask.fields.nextRunAt,
  }),
  dependencies: [...commandTool.dependencies, ScheduledTaskService.ScheduledTaskService],
})
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

const ThreadReportResultTool = Tool.make("goat_thread_report_result", {
  description:
    "Record the structured result of this thread's current run, so whoever dispatched it can read the outcome from goat_thread_read or goat_thread_wait instead of parsing your messages. Call it once you finish a dispatched task, and again to replace it if the result changes. outcome is succeeded, failed, blocked (you need something you cannot get), or cancelled. Report only facts you checked: pull request URLs you opened or updated, the test command you ran with its counts, and commit SHAs you pushed. Pull requests linked to this thread and its branch are added automatically. Recording a result does not end the run.",
  parameters: ThreadResultReport,
  success: ThreadResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ThreadResultService.ThreadResultService,
  ],
})
  .annotate(Tool.Title, "Report this thread's result")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

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
