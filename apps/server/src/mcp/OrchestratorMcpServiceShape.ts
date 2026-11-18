import type {
  NodeId,
  OrchestratorMcpCapabilitiesResult,
  OrchestratorMcpCapabilitiesInput,
  OrchestratorMcpCreateThreadsInput,
  OrchestratorMcpCreateThreadsResult,
  OrchestratorMcpDelegateTaskInput,
  OrchestratorMcpDelegateTaskResult,
  OrchestratorMcpDeleteScheduledTaskInput,
  OrchestratorMcpDeleteScheduledTaskResult,
  OrchestratorMcpFailure,
  OrchestratorMcpListScheduledTasksInput,
  OrchestratorMcpListScheduledTasksResult,
  OrchestratorMcpRequestSecretInput,
  OrchestratorMcpRequestSecretResult,
  OrchestratorMcpReviewFindingsExportInput,
  OrchestratorMcpReviewFindingsExportResult,
  OrchestratorMcpReviewFindingsRecordInput,
  OrchestratorMcpReviewFindingsRecordResult,
  OrchestratorMcpScheduleTaskInput,
  OrchestratorMcpScheduleTaskResult,
  OrchestratorMcpTaskCancelInput,
  OrchestratorMcpTaskCancelResult,
  OrchestratorMcpThreadInterruptInput,
  OrchestratorMcpThreadRetryInput,
  OrchestratorMcpThreadRetryResult,
  OrchestratorMcpThreadInterruptResult,
  OrchestratorMcpThreadListInput,
  OrchestratorMcpThreadListResult,
  OrchestratorMcpThreadReadInput,
  OrchestratorMcpThreadReadResult,
  OrchestratorMcpThreadSendDelivered,
  OrchestratorMcpThreadSendInput,
  OrchestratorMcpThreadStatusInput,
  OrchestratorMcpThreadStatusResult,
  OrchestratorMcpThreadWaitInput,
  OrchestratorMcpThreadWaitResult,
  OrchestratorMcpUpdateScheduledTaskInput,
  ThreadId,
} from "@goat/contracts";
import type * as Effect from "effect/Effect";
import type { McpInvocationScope } from "./McpInvocationContext.ts";

export interface OrchestratorMcpServiceShape {
  readonly permissionProfile: (
    scope: McpInvocationScope,
  ) => Effect.Effect<import("@goat/contracts").PermissionProfileView, OrchestratorMcpFailure>;
  /**
   * goatclaw admission for a follow-up send to a thread on another host: the caller needs
   * `threads.remote` for it and a lane. `ceiling` is what the destination must enforce; undefined
   * while goatclaw is off. `settle` keeps the lane on that thread's dispatch, or frees it.
   */
  readonly admitRemoteSend: (
    scope: McpInvocationScope,
    input: { readonly host: string; readonly threadId: string; readonly clientRequestId?: string },
  ) => Effect.Effect<
    {
      readonly ceiling: import("@goat/contracts").PermissionProfile | undefined;
      readonly settle: (sent: boolean) => Effect.Effect<void, OrchestratorMcpFailure>;
    },
    OrchestratorMcpFailure
  >;
  readonly capabilities: (
    scope: McpInvocationScope,
    input?: OrchestratorMcpCapabilitiesInput,
  ) => Effect.Effect<OrchestratorMcpCapabilitiesResult, OrchestratorMcpFailure>;
  readonly delegateTask: (
    scope: McpInvocationScope,
    input: OrchestratorMcpDelegateTaskInput,
  ) => Effect.Effect<OrchestratorMcpDelegateTaskResult, OrchestratorMcpFailure>;
  readonly taskStatus: (
    scope: McpInvocationScope,
    taskId: NodeId,
  ) => Effect.Effect<OrchestratorMcpDelegateTaskResult, OrchestratorMcpFailure>;
  readonly recordReviewFindings: (
    scope: McpInvocationScope,
    input: OrchestratorMcpReviewFindingsRecordInput,
  ) => Effect.Effect<OrchestratorMcpReviewFindingsRecordResult, OrchestratorMcpFailure>;
  readonly exportReviewFindings: (
    scope: McpInvocationScope,
    input: OrchestratorMcpReviewFindingsExportInput,
  ) => Effect.Effect<OrchestratorMcpReviewFindingsExportResult, OrchestratorMcpFailure>;
  readonly cancelTask: (
    scope: McpInvocationScope,
    input: OrchestratorMcpTaskCancelInput,
  ) => Effect.Effect<OrchestratorMcpTaskCancelResult, OrchestratorMcpFailure>;
  readonly createThreads: (
    scope: McpInvocationScope,
    input: OrchestratorMcpCreateThreadsInput,
  ) => Effect.Effect<OrchestratorMcpCreateThreadsResult, OrchestratorMcpFailure>;
  readonly scheduleTask: (
    scope: McpInvocationScope,
    input: OrchestratorMcpScheduleTaskInput,
  ) => Effect.Effect<OrchestratorMcpScheduleTaskResult, OrchestratorMcpFailure>;
  readonly listScheduledTasks: (
    scope: McpInvocationScope,
    input: OrchestratorMcpListScheduledTasksInput,
  ) => Effect.Effect<OrchestratorMcpListScheduledTasksResult, OrchestratorMcpFailure>;
  readonly updateScheduledTask: (
    scope: McpInvocationScope,
    input: OrchestratorMcpUpdateScheduledTaskInput,
    /**
     * Admits a keyed call once the caller may change this task, before it saves, so a replay
     * passes these checks again and never consumes a secretRef twice.
     */
    admit?: Effect.Effect<void>,
  ) => Effect.Effect<OrchestratorMcpScheduleTaskResult, OrchestratorMcpFailure>;
  readonly deleteScheduledTask: (
    scope: McpInvocationScope,
    input: OrchestratorMcpDeleteScheduledTaskInput,
  ) => Effect.Effect<OrchestratorMcpDeleteScheduledTaskResult, OrchestratorMcpFailure>;
  /** Only status reaches the agent, never this value. */
  readonly requestSecret: (
    scope: McpInvocationScope,
    input: OrchestratorMcpRequestSecretInput,
  ) => Effect.Effect<OrchestratorMcpRequestSecretResult, OrchestratorMcpFailure>;
  readonly listThreads: (
    scope: McpInvocationScope,
    input: OrchestratorMcpThreadListInput,
  ) => Effect.Effect<OrchestratorMcpThreadListResult, OrchestratorMcpFailure>;
  readonly readThread: (
    scope: McpInvocationScope,
    input: OrchestratorMcpThreadReadInput,
  ) => Effect.Effect<OrchestratorMcpThreadReadResult, OrchestratorMcpFailure>;
  /** thread.read's caller and visibility check alone, with none of its reads or acknowledgements. */
  readonly assertReadableThread: (
    scope: McpInvocationScope,
    threadId: ThreadId,
  ) => Effect.Effect<void, OrchestratorMcpFailure>;
  /** A summary or tail read of the caller's finished task child, here or on a host, has seen it. */
  readonly acknowledgeChildRead: (
    scope: McpInvocationScope,
    input: OrchestratorMcpThreadReadInput,
    observed: Pick<
      OrchestratorMcpThreadReadResult["thread"],
      "status" | "activeRunId" | "latestRunId"
    >,
  ) => Effect.Effect<void, OrchestratorMcpFailure>;
  readonly sendToThread: (
    scope: McpInvocationScope,
    input: OrchestratorMcpThreadSendInput,
  ) => Effect.Effect<OrchestratorMcpThreadSendDelivered, OrchestratorMcpFailure>;
  readonly waitForThread: (
    scope: McpInvocationScope,
    input: OrchestratorMcpThreadWaitInput,
  ) => Effect.Effect<OrchestratorMcpThreadWaitResult, OrchestratorMcpFailure>;
  /** Where a thread's current run is, from its shell; never waits. */
  readonly threadStatus: (
    scope: McpInvocationScope,
    input: Omit<OrchestratorMcpThreadStatusInput, "host">,
  ) => Effect.Effect<Omit<OrchestratorMcpThreadStatusResult, "watch">, OrchestratorMcpFailure>;
  readonly interruptThread: (
    scope: McpInvocationScope,
    input: OrchestratorMcpThreadInterruptInput,
  ) => Effect.Effect<OrchestratorMcpThreadInterruptResult, OrchestratorMcpFailure>;
  /** Runs a failed run's workspace preparation again, like Retry in the thread. */
  readonly retryThread: (
    scope: McpInvocationScope,
    input: Omit<OrchestratorMcpThreadRetryInput, "host">,
  ) => Effect.Effect<Omit<OrchestratorMcpThreadRetryResult, "host">, OrchestratorMcpFailure>;
}
