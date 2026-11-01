/**
 * remoteDispatchRow - the remote_dispatches table's row contract, its decoder, and the
 * launch-conflict lookup behind RemoteDispatchCoordinator.launch. Split from the coordinator
 * so that file stays under its recorded line budget.
 *
 * @module remoteDispatchRow
 */
import {
  ChannelWorkerObservation,
  IsoDateTime,
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
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

export const RemoteDispatchRow = Schema.Struct({
  memory_grant_ceiling: Schema.optional(MemoryTaskGrantCeiling),
  correlation_id: Schema.String,
  kind: Schema.Literals(["thread", "task"]),
  origin_thread_id: ThreadId,
  host: Schema.String,
  remote_thread_id: Schema.NullOr(Schema.String),
  launched_run_id: Schema.NullOr(RunId),
  read_key: Schema.String,
  delivery: RemoteReportDeliveryMode,
  reports_supported: Schema.Number,
  state: RemoteDispatchState,
  report_cursor: Schema.Number,
  known_run_id: Schema.NullOr(RunId),
  known_run_status: Schema.NullOr(OrchestrationV2RunStatus),
  latest_kind: Schema.NullOr(RemoteReportKind),
  latest_summary: Schema.NullOr(Schema.String),
  latest_at: Schema.NullOr(IsoDateTime),
  cancel_requested_at: Schema.NullOr(IsoDateTime),
  cancel_ceiling: Schema.NullOr(RuntimeMode),
  task_id: Schema.NullOr(NodeId),
  parent_run_id: Schema.NullOr(RunId),
  pending_request_ids: Schema.NullOr(Schema.fromJsonString(Schema.Array(RuntimeRequestId))),
  observation: Schema.optional(Schema.NullOr(Schema.fromJsonString(ChannelWorkerObservation))),
  relay_send: Schema.Number,
  relay_attempted: Schema.Number,
  last_error: Schema.NullOr(Schema.String),
  created_at: IsoDateTime,
  updated_at: IsoDateTime,
}).check(
  Schema.makeFilter((r) => r.kind !== "task" || (r.task_id !== null && r.parent_run_id !== null)),
);
export type RemoteDispatchRow = typeof RemoteDispatchRow.Type;

export const decodeRemoteDispatchRows = Schema.decodeUnknownEffect(Schema.Array(RemoteDispatchRow));

/**
 * Which existing row a retried launch collided with: a task on its origin task key, a thread
 * with a durable caller identity (a channel child-work record) on the correlation id it
 * supplied. No durable identity means no conflict, and the original insert failure surfaces.
 */
export const findLaunchConflict = (
  sql: SqlClient.SqlClient,
  input: {
    readonly originThreadId: ThreadId;
    readonly task?: { readonly taskId: NodeId } | undefined;
    readonly correlationId?: string | undefined;
  },
) => {
  if (input.task !== undefined)
    return sql`SELECT * FROM remote_dispatches WHERE kind = 'task' AND origin_thread_id = ${input.originThreadId} AND task_id = ${input.task.taskId}`;
  if (input.correlationId !== undefined)
    return sql`SELECT * FROM remote_dispatches WHERE correlation_id = ${input.correlationId}`;
  return Effect.succeed([]);
};
