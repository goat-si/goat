import {
  CommandId,
  type NodeId,
  type RunId,
  ThreadId,
  OrchestratorMcpThreadInterruptResult,
  OrchestratorMcpThreadWaitResult,
  RemoteOriginReportsWaitResult,
  RuntimeMode,
  type RemoteObservedRun,
  type RemoteKnownRun,
  type RemoteReport,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";

export class RemoteTaskError extends Schema.TaggedError<RemoteTaskError>()("RemoteTaskError", {
  stage: Schema.Literals(["storage", "decode", "delivery"]),
  cause: Schema.optional(Schema.Defect()),
}) {}
export interface TaskDispatch {
  readonly correlationId: string;
  readonly originThreadId: ThreadId;
  readonly host: string;
  readonly remoteThreadId: string | null;
  readonly launchedRunId: string | null;
  readonly task: { readonly taskId: NodeId; readonly parentRunId: RunId };
  readonly cancelRequestedAt: string | null;
  readonly cancelCeiling: RuntimeMode | null;
}
export const recordRemoteTaskResult = Effect.fn("remoteReports.recordRemoteTaskResult")(
  function* (input: {
    readonly originThreadId: ThreadId;
    readonly task: TaskDispatch["task"];
    readonly correlationId: string;
    readonly status: "completed" | "failed" | "cancelled" | "interrupted";
    readonly summary: string;
  }) {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    yield* threads
      .dispatch({
        type: "delegated_task.remote.result",
        commandId: CommandId.make(`remote-task-result:${input.correlationId}`),
        parentThreadId: input.originThreadId,
        taskId: input.task.taskId,
        correlationId: input.correlationId,
        status: input.status,
        summary: input.summary.slice(0, 4_000),
      })
      .pipe(Effect.mapError((cause) => new RemoteTaskError({ stage: "delivery", cause })));
  },
);
export const recordRemoteTaskProgress = Effect.fn("remoteReports.recordRemoteTaskProgress")(
  function* (row: TaskDispatch, key: string, summary: string) {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    yield* threads
      .dispatch({
        type: "delegated_task.remote.progress",
        commandId: CommandId.make(`remote-task-progress:${row.correlationId}:${key}`),
        parentThreadId: row.originThreadId,
        taskId: row.task.taskId,
        correlationId: row.correlationId,
        remoteThreadId: row.remoteThreadId === null ? null : ThreadId.make(row.remoteThreadId),
        summary: summary.slice(0, 4_000),
      })
      .pipe(Effect.mapError((cause) => new RemoteTaskError({ stage: "delivery", cause })));
  },
);
export const importRemoteTaskClaim = Effect.fn("remoteReports.importRemoteTaskClaim")(function* (
  row: TaskDispatch,
  report: RemoteReport,
) {
  if (row.launchedRunId === null || report.runId !== row.launchedRunId) return false;
  yield* recordRemoteTaskProgress(
    row,
    String(report.sequence),
    `${report.kind}: ${report.summary}`,
  );
  return report.kind === "needs_input";
});
const decodeReportWait = Schema.decodeUnknownEffect(RemoteOriginReportsWaitResult);
const decodeThreadWait = Schema.decodeUnknownEffect(OrchestratorMcpThreadWaitResult);
const decodeInterrupt = Schema.decodeUnknownEffect(OrchestratorMcpThreadInterruptResult);
const decodeRuntimeMode = Schema.decodeUnknownEffect(RuntimeMode);

export const waitForRemoteTask = Effect.fn("remoteReports.waitForRemoteTask")(function* (input: {
  readonly row: TaskDispatch;
  readonly reportsSupported: boolean;
  readonly readKey: string;
  readonly afterSequence: number;
  readonly knownRun: RemoteKnownRun | null;
}) {
  const row = input.row;
  if (row.remoteThreadId === null || row.launchedRunId === null)
    return yield* new RemoteTaskError({ stage: "decode" });
  const ssh = yield* SshRemoteDispatch.SshRemoteDispatch;
  const value = yield* ssh.callHostTool(
    {
      host: row.host,
      writes: false,
      timeoutMs: 360_000,
      tool: input.reportsSupported ? "goat_origin_reports_wait" : "goat_thread_wait",
      arguments: input.reportsSupported
        ? {
            correlationId: row.correlationId,
            readKey: input.readKey,
            afterSequence: input.afterSequence,
            watchRunId: row.launchedRunId,
            knownRun: input.knownRun,
            timeoutMs: 300_000,
          }
        : { threadId: row.remoteThreadId, runId: row.launchedRunId, timeoutMs: 300_000 },
    },
    Effect.succeed("approval-required" as const),
  );
  if (input.reportsSupported) {
    const answer = yield* decodeReportWait(value).pipe(
      Effect.mapError((cause) => new RemoteTaskError({ stage: "decode", cause })),
    );
    if (answer.threadId !== row.remoteThreadId)
      return yield* new RemoteTaskError({ stage: "decode" });
    return answer;
  }
  const answer = yield* decodeThreadWait(value).pipe(
    Effect.mapError((cause) => new RemoteTaskError({ stage: "decode", cause })),
  );
  if (answer.threadId !== row.remoteThreadId)
    return yield* new RemoteTaskError({ stage: "decode" });
  return {
    threadId: answer.threadId,
    reports: [],
    hasMore: false,
    latestRunId: null,
    observedRun:
      answer.runId === null || answer.status === "idle"
        ? null
        : { runId: answer.runId, status: answer.status, summary: null },
    timedOut: answer.timedOut,
  } satisfies RemoteOriginReportsWaitResult;
});
export const observeRemoteTask = Effect.fn("remoteReports.observeRemoteTask")(function* (
  row: TaskDispatch,
  run: RemoteObservedRun | null,
) {
  if (run === null || row.launchedRunId === null || run.runId !== row.launchedRunId) return null;
  const status = run.status === "rolled_back" ? "interrupted" : run.status;
  if (
    status !== "completed" &&
    status !== "failed" &&
    status !== "cancelled" &&
    status !== "interrupted"
  )
    return null;
  const resultStatus =
    row.cancelRequestedAt !== null && (run.status === "interrupted" || run.status === "cancelled")
      ? "cancelled"
      : status;
  yield* recordRemoteTaskResult({
    ...row,
    status: resultStatus,
    summary: run.summary ?? `The launched remote run ended with status ${run.status}.`,
  });
  return resultStatus === "cancelled" ? ("cancelled" as const) : ("settled" as const);
});
const ranks: Readonly<Record<RuntimeMode, number>> = {
  "approval-required": 0,
  "auto-accept-edits": 1,
  auto: 2,
  "full-access": 3,
};
export const replayRemoteTaskCancel = Effect.fn("remoteReports.replayRemoteTaskCancel")(function* (
  row: TaskDispatch,
) {
  if (row.cancelRequestedAt === null || row.remoteThreadId === null || row.launchedRunId === null)
    return;
  const ceiling = row.cancelCeiling;
  if (ceiling === null) return yield* new RemoteTaskError({ stage: "delivery" });
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const ssh = yield* SshRemoteDispatch.SshRemoteDispatch;
  // Persisted intent survives its provider token; present origin modes must still cover it.
  const authorize = Effect.gen(function* () {
    const origin = yield* threads
      .getThreadShell(row.originThreadId)
      .pipe(Effect.mapError((cause) => new RemoteTaskError({ stage: "delivery", cause })));
    if (
      origin === null ||
      origin.deletedAt !== null ||
      origin.archivedAt !== null ||
      origin.interactionMode !== "default" ||
      ranks[origin.runtimeMode] < ranks[ceiling]
    )
      return yield* new RemoteTaskError({ stage: "delivery" });
    return ceiling;
  });
  const answer = yield* ssh.callHostTool(
    {
      host: row.host,
      tool: "goat_thread_interrupt",
      writes: true,
      timeoutMs: 120_000,
      arguments: {
        threadId: row.remoteThreadId,
        runId: row.launchedRunId,
        reason: "Cancellation requested by the origin task owner.",
        clientRequestId: `remote-task-cancel:${row.correlationId}`,
      },
    },
    authorize,
  );
  yield* decodeInterrupt(answer).pipe(
    Effect.mapError((cause) => new RemoteTaskError({ stage: "decode", cause })),
  );
  // interrupt_requested/no_active_run are not evidence of A's settlement.
});
export const requestRemoteTaskCancel = Effect.fn("remoteReports.requestRemoteTaskCancel")(
  function* <E, R>(row: TaskDispatch, authorize: Effect.Effect<RuntimeMode, E, R>) {
    const ceiling = yield* authorize;
    const sql = yield* SqlClient.SqlClient;
    const now = DateTime.formatIso(yield* DateTime.now);
    const persisted = yield* sql<{ cancel_requested_at: string; cancel_ceiling: RuntimeMode }>`
      UPDATE remote_dispatches SET cancel_requested_at = COALESCE(cancel_requested_at, ${now}),
        cancel_ceiling = COALESCE(cancel_ceiling, ${ceiling}), updated_at = ${now}
      WHERE correlation_id = ${row.correlationId} AND kind = 'task' AND state IN ('launching', 'running', 'idle')
      RETURNING cancel_requested_at, cancel_ceiling
    `.pipe(Effect.mapError((cause) => new RemoteTaskError({ stage: "storage", cause })));
    const intent = persisted[0];
    if (intent === undefined) return "already_settled" as const;
    yield* authorize;
    const recordedCeiling = yield* decodeRuntimeMode(intent.cancel_ceiling).pipe(
      Effect.mapError((cause) => new RemoteTaskError({ stage: "decode", cause })),
    );
    yield* replayRemoteTaskCancel({
      ...row,
      cancelRequestedAt: intent.cancel_requested_at,
      cancelCeiling: recordedCeiling,
    });
    return "cancel_requested" as const;
  },
);
export const recoverUnknownRemoteTaskLaunch = Effect.fn(
  "remoteReports.recoverUnknownRemoteTaskLaunch",
)(function* (row: TaskDispatch) {
  if (row.remoteThreadId !== null)
    yield* recordRemoteTaskProgress(row, "launched", "Remote launch outcome unknown.");
  yield* recordRemoteTaskResult({
    ...row,
    status: "failed",
    summary: `launch outcome unknown; inspect goat_thread_list with host ${row.host} before retrying`,
  });
});
