import {
  ChannelGatewayError,
  type RunId,
  type ChannelTask,
  type ChannelDeliverable,
  type ChannelDeliverableView,
  type ChannelTaskReportInput,
  type ChannelChildWorkId,
  requiredDeliverableRequestKey,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import {
  confirmRequiredChildStopped,
  retryRequiredDeliverable,
} from "./channelDeliverableRetry.ts";
import { commitTransition } from "./channelTaskWrites.ts";
import type * as ChannelLedger from "./ChannelLedger.ts";
import { childWorkIdFor } from "./channelIds.ts";
import type { ChannelChildWorkStore } from "./channelChildWorkStore.ts";

const encodeIds = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const invalid = (deliverableProblem?: string) =>
  new ChannelGatewayError({
    reason: "invalid_input",
    ...(deliverableProblem ? { deliverableProblem } : {}),
  });
const unavailable = () => new ChannelGatewayError({ reason: "persistence_failed" });

export const hasDeliverableReport = (input: ChannelTaskReportInput) =>
  input.requiredDeliverables !== undefined ||
  input.reviewDeliverable !== undefined ||
  input.retryDeliverable !== undefined;

/** A terminal runtime state (including a successful run with no report) cannot attest to a criterion. */
export const readRequiredDeliverables = Effect.fn("ChannelTask.readRequiredDeliverables")(
  function* (sql: SqlClient.SqlClient, task: ChannelTask) {
    const items = task.requiredDeliverables;
    if (!items) return undefined;
    const ids = items.map((item) =>
      childWorkIdFor(
        task.taskId,
        task.generation,
        requiredDeliverableRequestKey(item.id, item.attempt),
      ),
    );
    const rows = yield* sql<{
      id: ChannelChildWorkId;
      childState: string;
      observationReady: number;
      host: string | null;
      subagentStatus: string | null;
      reported: string | null;
    }>`
    WITH attempts AS (
      SELECT ids.value AS id, stored.value_json AS child FROM json_each(${encodeIds(ids)}) ids
      JOIN channel_runtime_state stored ON stored.key = 'child-work:' || ${task.taskId} || ':' || ids.value
    )
    SELECT a.id, json_extract(child,'$.state') AS childState, json_extract(child,'$.destination.host') AS host, s.status AS subagentStatus,
      (json_extract(child,'$.surface') <> 'delegate_remote' OR
        (remote.state='settled' AND remote.known_run_id=remote.launched_run_id
         AND remote.known_run_status='completed')) AS observationReady,
      CASE json_extract(child,'$.surface')
      WHEN 'delegate_remote' THEN
        CASE WHEN remote.known_run_id = remote.launched_run_id
          AND json_extract(remote.observation,'$.result.runId') = remote.launched_run_id
          THEN json_extract(remote.observation,'$.result.reportedOutcome') END
      WHEN 'delegate_local' THEN (
        SELECT CASE WHEN run.status='completed' THEN json_extract(report.report_json,'$.outcome') END
        FROM orchestration_v2_projection_context_transfers transfer
        JOIN orchestration_v2_projection_runs run
          ON run.thread_id=transfer.source_thread_id AND run.run_id=json_extract(transfer.payload_json,'$.sourcePoint.runId')
        LEFT JOIN thread_run_results report ON report.thread_id=run.thread_id AND report.run_id=run.run_id
        WHERE transfer.type='subagent_result' AND transfer.status='consumed' AND transfer.source_thread_id=s.child_thread_id
          AND transfer.target_thread_id=s.thread_id AND transfer.target_run_id=s.run_id
        ORDER BY run.ordinal DESC,transfer.updated_at DESC LIMIT 1
      ) END AS reported
    FROM attempts a
    LEFT JOIN remote_dispatches remote ON json_extract(child,'$.surface')='delegate_remote'
      AND remote.correlation_id=json_extract(child,'$.destination.correlationId')
      AND remote.origin_thread_id=json_extract(child,'$.callerThreadId') AND remote.kind='task'
      AND remote.host=json_extract(child,'$.destination.host')
      AND (json_extract(child,'$.destination.threadId') IS NULL
        OR remote.remote_thread_id=json_extract(child,'$.destination.threadId'))
    LEFT JOIN orchestration_v2_projection_subagents s ON s.thread_id=json_extract(child,'$.callerThreadId')
      AND s.origin='app_owned' AND
        ((remote.task_id IS NOT NULL AND s.subagent_id=remote.task_id) OR
        (json_extract(child,'$.surface')='delegate_local' AND s.child_thread_id=json_extract(child,'$.destination.threadId')))
  `;
    return items.map((item, index): ChannelDeliverableView => {
      const { id, criterion, attempt, review } = item;
      const row = rows.find((entry) => entry.id === ids[index]);
      const host = row?.host ? { host: row.host } : {};
      if (review)
        return {
          id,
          criterion,
          attempt,
          state: review.decision === "accepted" ? "accepted" : "failed",
          childWorkId: review.childWorkId,
          evidence: review.evidence,
          ...host,
        };
      if (!row) return { id, criterion, attempt, state: "pending" };
      const failed =
        ["failed", "cancelled", "released"].includes(row.childState) ||
        ["failed", "cancelled", "interrupted"].includes(row.subagentStatus ?? "");
      const completed =
        row.observationReady &&
        row.subagentStatus === "completed" &&
        (row.childState === "completed" || row.reported === "succeeded");
      return {
        id,
        criterion,
        attempt,
        childWorkId: row.id,
        ...host,
        state: failed
          ? "failed"
          : completed
            ? row.reported === "succeeded"
              ? "awaiting_acceptance"
              : "failed"
            : "running",
      };
    });
  },
);

const prepareRequiredDeliverables = Effect.fn("ChannelTask.prepareRequiredDeliverables")(function* (
  sql: SqlClient.SqlClient,
  store: Pick<ChannelChildWorkStore["Service"], "get"> | undefined,
  task: ChannelTask,
  input: ChannelTaskReportInput,
  ownedRuns: ReadonlyArray<RunId>,
) {
  const {
    requiredDeliverables: declaration,
    reviewDeliverable: review,
    retryDeliverable: retry,
  } = input;
  if (
    [declaration, review, retry].filter(Boolean).length !== 1 ||
    task.kind !== "turn" ||
    input.status !== "running"
  )
    return yield* invalid();
  if (declaration) {
    if (task.requiredDeliverables || task.proposedCompletion)
      return yield* invalid("Declare the full list once, before proposing completion.");
    const ended = yield* sql`SELECT 1 FROM json_each(${encodeIds(ownedRuns)}) runs
        JOIN thread_run_results r ON r.thread_id=${task.worker?.threadId ?? null} AND r.run_id=runs.value LIMIT 1`.pipe(
      Effect.mapError(unavailable),
    );
    if (ended.length) return yield* invalid("A run for this task has already reported its result.");
    const prefix = "child-work:" + task.taskId + ":";
    const started = yield* sql<{
      found: number;
    }>`SELECT 1 AS found FROM channel_runtime_state WHERE key >= ${prefix}
      AND key < ${"child-work:" + task.taskId + ";"} AND json_extract(value_json,'$.generation')=${task.generation} LIMIT 1`.pipe(
      Effect.mapError(unavailable),
    );
    if (started.length)
      return yield* invalid("Declare the required results before launching the first worker.");
    return declaration.map((item) => ({ ...item, attempt: 1 }));
  }
  const items = task.requiredDeliverables;
  const request = review ?? retry;
  const item = items?.find((entry) => entry.id === request?.id);
  if (!items || !item || !request || item.attempt !== request.attempt)
    return yield* invalid(
      "Read channel.task_read and use the current required item ID and attempt.",
    );
  const childWorkId = childWorkIdFor(
    task.taskId,
    task.generation,
    requiredDeliverableRequestKey(item.id, item.attempt),
  );
  const current = (yield* readRequiredDeliverables(sql, task).pipe(
    Effect.mapError(unavailable),
  ))?.find((value) => value.id === item.id);
  if (retry) {
    if (!store) return yield* unavailable();
    const child = yield* store.get(task.taskId, childWorkId).pipe(Effect.mapError(unavailable));
    if (
      !child ||
      !(yield* confirmRequiredChildStopped(sql, child).pipe(Effect.mapError(unavailable)))
    )
      return yield* invalid(
        "Wait for this worker's host to confirm that the launched run stopped before retrying.",
      );
    const updated = retryRequiredDeliverable(items, retry, child, current);
    if (!updated)
      return yield* invalid(
        "Only a failed or rejected worker attempt confirmed to have stopped can be retried.",
      );
    return updated;
  }
  if (!review || item.review) return yield* invalid("This attempt already has a review.");
  if (
    !current ||
    (current.state !== "awaiting_acceptance" &&
      !(current.state === "failed" && review.decision === "rejected"))
  )
    return yield* invalid(
      "The current worker must finish and report success with thread.report_result before its output can be accepted.",
    );
  return items.map((entry): ChannelDeliverable =>
    entry.id === item.id
      ? { ...item, review: { decision: review.decision, evidence: review.evidence, childWorkId } }
      : entry,
  );
});

/** Re-read sibling decisions on the same transaction as their next ledger event. */
export const recordRequiredProgress = Effect.fn("ChannelTask.recordRequiredProgress")(function* (
  sql: SqlClient.SqlClient,
  ledger: ChannelLedger.ChannelLedger["Service"],
  store: Pick<ChannelChildWorkStore["Service"], "get"> | undefined,
  prior: ChannelLedger.ChannelStoredTask,
  input: ChannelTaskReportInput,
  ownedRuns: ReadonlyArray<RunId>,
) {
  return yield* sql
    .withTransaction(
      Effect.gen(function* () {
        if (yield* ledger.hasTaskEvent(input.eventId)) return;
        const stored = yield* ledger.getTask(prior.task.taskId);
        if (
          !stored ||
          stored.task.generation !== prior.task.generation ||
          stored.task.worker?.runId !== prior.task.worker?.runId
        )
          return yield* invalid();
        const task = stored.task;
        const requiredDeliverables = yield* prepareRequiredDeliverables(
          sql,
          store,
          task,
          input,
          ownedRuns,
        );
        const milestone = input.milestone ?? true;
        const written = yield* commitTransition(
          ledger,
          stored,
          {
            type: "task.progress",
            payload: {
              generation: task.generation,
              summary: input.summary,
              requiredDeliverables,
              milestone,
              ...(task.doneMeans === undefined && input.doneMeans !== undefined
                ? { doneMeans: input.doneMeans }
                : {}),
            },
          },
          { actor: "agent", eventId: input.eventId, narrate: milestone },
        );
        if (!written) return yield* invalid();
      }),
    )
    .pipe(Effect.catchTags({ SqlError: () => Effect.fail(unavailable()) }));
});
