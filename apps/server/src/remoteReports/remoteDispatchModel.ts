import {
  MemoryTaskGrantCeiling,
  NodeId,
  OrchestrationV2RunStatus,
  RemoteDispatchState,
  RemoteReportDeliveryMode,
  RemoteReportKind,
  RunId,
  RuntimeMode,
  RuntimeRequestId,
  ThreadId,
  type ChannelWorkerObservation as ChannelWorkerObservationType,
  type RemoteDispatchView,
} from "@goat/contracts";
import * as Schema from "effect/Schema";

import * as RemoteDispatchRow from "./remoteDispatchRow.ts";

export class RemoteDispatchError extends Schema.TaggedError<RemoteDispatchError>()(
  "RemoteDispatchError",
  {
    stage: Schema.Literals([
      "storage",
      "decode",
      "delivery",
      "unsupported_task",
      "not_found",
      "launch",
      "authorize",
    ]),
    reason: Schema.optional(Schema.Literal("duplicate_task")),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return "Remote dispatch operation failed.";
  }
}

export interface RemoteDispatchRecord {
  readonly memoryGrantCeiling: MemoryTaskGrantCeiling;
  readonly correlationId: string;
  readonly kind: "thread" | "task";
  readonly originThreadId: ThreadId;
  readonly host: string;
  readonly remoteThreadId: string | null;
  readonly launchedRunId: RunId | null;
  readonly delivery: typeof RemoteReportDeliveryMode.Type;
  readonly reportsSupported: boolean;
  readonly state: typeof RemoteDispatchState.Type;
  readonly reportCursor: number;
  readonly knownRunId: RunId | null;
  readonly knownRunStatus: typeof OrchestrationV2RunStatus.Type | null;
  readonly latestKind: typeof RemoteReportKind.Type | null;
  readonly latestSummary: string | null;
  readonly latestAt: string | null;
  readonly cancelRequestedAt: string | null;
  readonly cancelCeiling: RuntimeMode | null;
  readonly task: { readonly taskId: NodeId; readonly parentRunId: RunId } | null;
  readonly pendingRequestIds: ReadonlyArray<RuntimeRequestId>;
  readonly observation: ChannelWorkerObservationType | null;
  readonly lastError: string | null;
  /** Start of the current run of unreachable outcomes; kept when that run ended tracking. */
  readonly hostUnavailableSince: string | null;
  readonly endReason: RemoteDispatchRow.RemoteDispatchEndReason | null;
  readonly endedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const publicRow = (r: RemoteDispatchRow.RemoteDispatchRow): RemoteDispatchRecord => ({
  memoryGrantCeiling: r.memory_grant_ceiling ?? "none",
  correlationId: r.correlation_id,
  kind: r.kind,
  originThreadId: r.origin_thread_id,
  host: r.host,
  remoteThreadId: r.remote_thread_id,
  launchedRunId: r.launched_run_id,
  delivery: r.delivery,
  reportsSupported: r.reports_supported === 1,
  state: r.state,
  reportCursor: r.report_cursor,
  knownRunId: r.known_run_id,
  knownRunStatus: r.known_run_status,
  latestKind: r.latest_kind,
  latestSummary: r.latest_summary,
  latestAt: r.latest_at,
  cancelRequestedAt: r.cancel_requested_at,
  cancelCeiling: r.cancel_ceiling,
  task:
    r.task_id !== null && r.parent_run_id !== null
      ? { taskId: r.task_id, parentRunId: r.parent_run_id }
      : null,
  pendingRequestIds: r.pending_request_ids ?? [],
  observation: r.observation ?? null,
  lastError: r.last_error,
  hostUnavailableSince: r.host_unavailable_since ?? null,
  endReason: r.end_reason ?? null,
  endedAt: r.ended_at ?? null,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export const dispatchView = (r: RemoteDispatchRecord): RemoteDispatchView => ({
  correlationId: r.correlationId,
  host: r.host,
  threadId: r.remoteThreadId,
  kind: r.kind,
  delivery: r.delivery,
  state: r.state,
  reportsSupported: r.reportsSupported,
  latest:
    r.latestKind !== null && r.latestSummary !== null && r.latestAt !== null
      ? { kind: r.latestKind, summary: r.latestSummary, at: r.latestAt }
      : null,
  lastError: r.lastError,
  createdAt: r.createdAt,
});
