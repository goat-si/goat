import type {
  OrchestrationV2AppThread,
  OrchestrationV2DomainEvent,
  OrchestrationV2Run,
  RunId,
  RunAttemptId,
  ThreadId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import { makeShellThreadRows } from "./ProjectionShellThreadRows.ts";

export interface CompletionNotificationInput {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly expectedCompletedAt: DateTime.Utc;
  readonly expectedActiveAttemptId: RunAttemptId | null;
  readonly decision: string;
}
export const sameNotificationEpoch = (a: OrchestrationV2Run, b: OrchestrationV2Run) =>
  a.completedAt !== null &&
  b.completedAt !== null &&
  DateTime.toEpochMillis(a.completedAt) === DateTime.toEpochMillis(b.completedAt) &&
  a.activeAttemptId === b.activeAttemptId;

export function preserveRunNotification(
  current: OrchestrationV2Run | undefined,
  next: OrchestrationV2Run,
): OrchestrationV2Run {
  const { completionNotification: _stale, ...reopened } = next;
  if (next.completedAt === null) return reopened;
  return current !== undefined &&
    sameNotificationEpoch(current, next) &&
    current.completionNotification !== undefined
    ? { ...next, completionNotification: current.completionNotification }
    : next;
}
const maxDate = (a: DateTime.Utc | null | undefined, b: DateTime.Utc | null | undefined) =>
  a == null
    ? (b ?? null)
    : b == null || DateTime.toEpochMillis(a) >= DateTime.toEpochMillis(b)
      ? a
      : b;
export const preserveThreadNotification = (
  current: OrchestrationV2AppThread | undefined,
  next: OrchestrationV2AppThread,
): OrchestrationV2AppThread => ({
  ...next,
  notificationCompletedAt: maxDate(current?.notificationCompletedAt, next.notificationCompletedAt),
  ...(next.markedUnreadCompletionAt !== undefined || current?.markedUnreadCompletionAt !== undefined
    ? {
        markedUnreadCompletionAt: maxDate(
          current?.markedUnreadCompletionAt,
          next.markedUnreadCompletionAt,
        ),
      }
    : {}),
});

/** GOAT's own idle compactions stay out of unread unless they fail, like the shell's latest run. */
export interface NotificationCursorContext {
  /** Runs prompted by an idle compaction whose compaction item has not failed. */
  readonly idleRunIds: ReadonlySet<RunId>;
  /** Completed, non-silent runs whose compaction item failed in these events. */
  readonly failedCompactions: ReadonlyArray<{
    readonly threadId: ThreadId;
    readonly completedAt: DateTime.Utc;
  }>;
}
const noCursorContext: NotificationCursorContext = { idleRunIds: new Set(), failedCompactions: [] };

export const failedCompactionRunIds = (events: ReadonlyArray<OrchestrationV2DomainEvent>) =>
  new Set(
    events.flatMap((event) =>
      event.type === "turn-item.updated" &&
      event.payload.type === "compaction" &&
      event.payload.status === "failed" &&
      event.payload.runId !== null
        ? [event.payload.runId]
        : [],
    ),
  );

export function notificationCompletions(
  events: ReadonlyArray<OrchestrationV2DomainEvent>,
  context: NotificationCursorContext = noCursorContext,
) {
  const completions = new Map<ThreadId, DateTime.Utc>();
  const advance = (threadId: ThreadId, at: DateTime.Utc) => {
    const prior = completions.get(threadId);
    if (prior === undefined || DateTime.toEpochMillis(prior) < DateTime.toEpochMillis(at))
      completions.set(threadId, at);
  };
  for (const event of events) {
    if (
      (event.type !== "run.created" && event.type !== "run.updated") ||
      event.payload.completedAt === null ||
      event.payload.completionNotification === "silent" ||
      (event.payload.status !== "failed" && context.idleRunIds.has(event.payload.id))
    )
      continue;
    advance(event.threadId, event.payload.completedAt);
  }
  for (const failed of context.failedCompactions) advance(failed.threadId, failed.completedAt);
  return completions;
}
// These fragments run inside the enclosing projection operation's span.
export const runNotificationUpdate = (sql: SqlClient.SqlClient) => sql`
  CASE WHEN excluded.completed_at IS NULL THEN NULL
    WHEN orchestration_v2_projection_runs.completed_at IS excluded.completed_at
      AND json_extract(orchestration_v2_projection_runs.payload_json,'$.activeAttemptId') IS json_extract(excluded.payload_json,'$.activeAttemptId')
    THEN COALESCE(orchestration_v2_projection_runs.completion_notification, excluded.completion_notification)
    ELSE excluded.completion_notification END`;
export const runNotificationPayload = (sql: SqlClient.SqlClient) => sql`
  CASE WHEN ${runNotificationUpdate(sql)} IS NULL THEN json_remove(excluded.payload_json,'$.completionNotification')
    ELSE json_set(excluded.payload_json,'$.completionNotification',${runNotificationUpdate(sql)}) END`;
export const threadNotificationPayload = (sql: SqlClient.SqlClient) => {
  const automatic = sql`json_set(excluded.payload_json,'$.notificationCompletedAt', CASE
    WHEN json_extract(orchestration_v2_projection_threads.payload_json,'$.notificationCompletedAt') > COALESCE(json_extract(excluded.payload_json,'$.notificationCompletedAt'),'')
    THEN json_extract(orchestration_v2_projection_threads.payload_json,'$.notificationCompletedAt')
    ELSE json_extract(excluded.payload_json,'$.notificationCompletedAt') END)`;
  return sql`CASE WHEN json_type(excluded.payload_json,'$.markedUnreadCompletionAt') IS NULL
    AND json_type(orchestration_v2_projection_threads.payload_json,'$.markedUnreadCompletionAt') IS NULL
    THEN ${automatic} ELSE json_set(${automatic},'$.markedUnreadCompletionAt',CASE
      WHEN json_extract(orchestration_v2_projection_threads.payload_json,'$.markedUnreadCompletionAt') > COALESCE(json_extract(excluded.payload_json,'$.markedUnreadCompletionAt'),'')
      THEN json_extract(orchestration_v2_projection_threads.payload_json,'$.markedUnreadCompletionAt')
      ELSE json_extract(excluded.payload_json,'$.markedUnreadCompletionAt') END) END`;
};
export const recordNotificationCompletions = Effect.fn(
  "ProjectionRunNotification.recordCompletions",
)(function* (sql: SqlClient.SqlClient, events: ReadonlyArray<OrchestrationV2DomainEvent>) {
  const shell = makeShellThreadRows(sql);
  const runIds = [
    ...new Set(
      events.flatMap((event) =>
        (event.type === "run.created" || event.type === "run.updated") &&
        event.payload.completedAt !== null
          ? [event.payload.id]
          : [],
      ),
    ),
  ];
  const failedIds = [...failedCompactionRunIds(events)];
  const idle =
    runIds.length === 0
      ? []
      : yield* sql<{
          readonly run_id: RunId;
        }>`SELECT r.run_id FROM orchestration_v2_projection_runs r
          WHERE r.run_id IN ${sql.in(runIds)} AND ${shell.isIdleCompactionRun("r")}`;
  const failed =
    failedIds.length === 0
      ? []
      : yield* sql<{
          readonly thread_id: ThreadId;
          readonly completed_at: string;
        }>`SELECT thread_id, completed_at
          FROM orchestration_v2_projection_runs WHERE run_id IN ${sql.in(failedIds)}
            AND completed_at IS NOT NULL AND completion_notification IS NOT 'silent'`;
  const context: NotificationCursorContext = {
    idleRunIds: new Set(idle.map((row) => row.run_id)),
    failedCompactions: failed.map((row) => ({
      threadId: row.thread_id,
      completedAt: DateTime.makeUnsafe(row.completed_at),
    })),
  };
  for (const [threadId, at] of notificationCompletions(events, context)) {
    const iso = DateTime.formatIso(at);
    yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.notificationCompletedAt',${iso})
      WHERE thread_id=${threadId} AND COALESCE(json_extract(payload_json,'$.notificationCompletedAt'),'') < ${iso}`;
  }
});
export const setCompletionNotification = Effect.fn("ProjectionRunNotification.setCompletion")(
  function* (sql: SqlClient.SqlClient, input: CompletionNotificationInput) {
    return yield* sql`UPDATE orchestration_v2_projection_runs
    SET completion_notification=${input.decision}, payload_json=json_set(payload_json,'$.completionNotification',${input.decision})
    WHERE run_id=${input.runId} AND thread_id=${input.threadId} AND completed_at IS ${DateTime.formatIso(input.expectedCompletedAt)}
      AND json_extract(payload_json,'$.activeAttemptId') IS ${input.expectedActiveAttemptId} RETURNING run_id`;
  },
);

export const markThreadUnread = (
  thread: OrchestrationV2AppThread,
  completedAt: DateTime.Utc | null,
): OrchestrationV2AppThread => ({
  ...thread,
  lastVisitedAt: completedAt === null ? null : DateTime.subtract(completedAt, { milliseconds: 1 }),
  markedUnreadCompletionAt: completedAt,
});
