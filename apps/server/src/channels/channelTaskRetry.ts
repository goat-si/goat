/**
 * A retry is only as safe as a stop: the next generation starts only on the evidence a stop
 * accepts before completing. Work that ever ran on another machine is never retried here.
 * @module channelTaskRetry
 */
import {
  ChannelGatewayError,
  type ChannelRequester,
  type ChannelRetryTaskInput,
  type ChannelRetryTaskResult,
  type ChannelTask,
  type ChannelTaskEventId,
  type ChannelTaskRetryRefusal,
  isChannelChildWorkActive,
  isGoatBotSessionThreadId,
  MAIN_BOT_ID,
} from "@goat/contracts";
import { derivePendingBackgroundWork } from "@goat/shared/orchestrationV2PendingBackgroundWork";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { isActiveMember } from "./channelBotLedger.ts";
import * as ChannelChildWorkStore from "./channelChildWorkStore.ts";
import { mayAnswerFor } from "./ChannelGateway.ts";
import type { ChannelConnectionOwner } from "./ChannelIngressContext.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelWake from "./ChannelWake.ts";
import { retiredWorkerKeyFor, taskRetryEventIdFor, workerLaunchIdsFor } from "./channelIds.ts";
import { prepareTransition } from "./channelTaskWrites.ts";
import {
  ENDED_RUN_STATUSES,
  isThreadMissing,
  STOP_LAUNCH_GRACE_MS,
} from "./channelWorkerObservation.ts";

const LIVE_SUBAGENT = new Set(["idle", "pending", "running", "waiting"]);
const isLedgerError = Schema.is(ChannelLedger.ChannelLedgerError);
const isGatewayError = Schema.is(ChannelGatewayError);
const encodeRetired = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ taskId: Schema.String, generation: Schema.Number })),
);
const ROUNDS = 3;

class Changed {
  readonly _tag = "Changed";
}

const refused = (task: ChannelTask, reason: ChannelTaskRetryRefusal): ChannelRetryTaskResult => ({
  status: "refused",
  taskId: task.taskId,
  reason,
});

/** The person behind a client session, compared with the requester the way a stop compares. */
const callerFor = (owner: ChannelConnectionOwner): ChannelRequester => ({
  ownerId: owner.ownerId,
  principalId: owner.principalId,
  displayName: owner.displayName,
  originKind: "goat",
  runtimeModeCeiling: owner.runtimeModeCeiling,
  grantedScopes: owner.grantedScopes,
});

const placedElsewhere = (task: ChannelTask) =>
  task.host !== undefined ||
  task.target?.remote !== undefined ||
  task.worker?.host !== undefined ||
  task.movedFrom !== undefined;

export const makeTaskRetry = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const ledger = yield* ChannelLedger.ChannelLedger;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const childWork = yield* ChannelChildWorkStore.ChannelChildWorkStore;
  const wake = yield* ChannelWake.ChannelWake;

  const retryGeneration = (eventId: string) =>
    sql<{ readonly generation: number }>`
      SELECT json_extract(event_json, '$.payload.generation') AS generation
      FROM channel_task_events WHERE event_id = ${eventId} AND type = 'task.retry.requested'
    `.pipe(Effect.map((rows) => rows[0]?.generation));

  /** Any generation that ran on, was placed on, or moved from another machine. */
  const ranElsewhere = (task: ChannelTask) =>
    placedElsewhere(task)
      ? Effect.succeed(true)
      : sql<{ readonly found: number }>`
          SELECT 1 AS found FROM channel_task_events WHERE task_id = ${task.taskId} AND (
            type = 'task.moved'
            OR (type = 'task.dispatch.claimed'
              AND json_extract(event_json, '$.payload.target.remote') IS NOT NULL)
            OR (type = 'task.worker.bound'
              AND json_extract(event_json, '$.payload.worker.host') IS NOT NULL))
          LIMIT 1
        `.pipe(Effect.map((rows) => rows.length > 0));

  /** Whether the worker thread of the generation being retired may still do anything. */
  const workerLive = Effect.fn("channelTaskRetry.workerLive")(function* (task: ChannelTask) {
    const threadId =
      task.worker?.threadId ?? workerLaunchIdsFor(task.taskId, task.generation).threadId;
    const read = yield* threads
      .getThreadRecords(
        threadId,
        ["runs", "providerThreads", "turnItems", "subagents", "runtimeRequests"],
        { turnItemStatuses: ["pending", "running", "waiting"] },
      )
      .pipe(Effect.result);
    if (read._tag === "Failure") {
      if (!isThreadMissing(read.failure)) return true;
      // Never claimed for a launch: there is no thread to wait for.
      if (task.target === undefined) return false;
      // A launch still in flight lands on this id; the same grace a stop waits.
      const endedAt = Date.parse(task.completedAt ?? task.updatedAt);
      return DateTime.toEpochMillis(yield* DateTime.now) - endedAt <= STOP_LAUNCH_GRACE_MS;
    }
    const records = read.success;
    const runs = records.runs;
    const latestRun = runs.findLast((run) => run.status !== "queued");
    const background =
      latestRun !== undefined &&
      derivePendingBackgroundWork({
        latestRun,
        providerThreads: records.providerThreads,
        turnItems: records.turnItems,
        activeProviderThreadId: records.thread.activeProviderThreadId,
        runs,
      }).length > 0;
    const cloud = records.providerThreads.some(
      (thread) =>
        thread.cloudTask?.status === "running" || thread.cloudTask?.status === "submitting",
    );
    return (
      runs.some((run) => !ENDED_RUN_STATUSES.has(run.status)) ||
      background ||
      cloud ||
      records.runtimeRequests.some((request) => request.status === "pending") ||
      records.subagents.some(
        (child) =>
          LIVE_SUBAGENT.has(child.status) ||
          child.completionDelivery?.state === "pending" ||
          child.completionDelivery?.state === "claimed",
      )
    );
  });

  const commit = (seen: ChannelLedger.ChannelStoredTask, eventId: ChannelTaskEventId) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const current = yield* ledger.getTask(seen.task.taskId);
        if (current === undefined || current.task.version !== seen.task.version)
          return yield* Effect.fail(new Changed());
        const task = current.task;
        const pendingStop = yield* sql<{ readonly found: number }>`
          SELECT 1 AS found FROM channel_task_events
          WHERE task_id = ${task.taskId} AND forward_state = 'pending' LIMIT 1
        `;
        if (pendingStop.length > 0) return refused(task, "still_running");
        if (yield* ranElsewhere(task)) return refused(task, "elsewhere");
        const children = yield* childWork.listForTask(task.taskId);
        if (
          children.some(
            (record) =>
              record.generation === task.generation && isChannelChildWorkActive(record.state),
          )
        )
          return refused(task, "still_running");
        if (
          current.botId !== MAIN_BOT_ID &&
          !(yield* isActiveMember(sql, current.ownerId, current.botId))
        )
          return refused(task, "bot_inactive");
        const bot = yield* ledger.getBotById(current.ownerId, current.botId);
        const now = DateTime.formatIso(yield* DateTime.now);
        const prepared = prepareTransition(
          current,
          { type: "task.retry.requested", payload: { generation: task.generation + 1 } },
          now,
          bot?.bot,
          { actor: "user", eventId, pendingAnswerMessageId: null, completionHold: null },
        );
        if (!prepared.ok) return refused(task, "not_finished");
        yield* ledger.applyTaskEvent({ write: prepared.write, deliveries: prepared.deliveries });
        const retiredThread =
          task.worker?.threadId ?? workerLaunchIdsFor(task.taskId, task.generation).threadId;
        yield* sql`
          INSERT INTO channel_runtime_state (key, value_json, updated_at)
          VALUES (${retiredWorkerKeyFor(retiredThread)},
            ${encodeRetired({ taskId: task.taskId, generation: task.generation })}, ${now})
          ON CONFLICT (key) DO NOTHING
        `;
        return {
          status: "started",
          taskId: task.taskId,
          generation: task.generation + 1,
        } satisfies ChannelRetryTaskResult;
      }),
    );

  const attempt = Effect.fn("channelTaskRetry.attempt")(function* (
    input: ChannelRetryTaskInput,
    owner: ChannelConnectionOwner,
  ) {
    const stored = yield* ledger.getTask(input.taskId);
    if (stored === undefined || stored.ownerId !== owner.ownerId || stored.task.kind === "turn")
      return yield* new ChannelGatewayError({ reason: "task_not_found" });
    if (!mayAnswerFor(callerFor(owner), stored.task.requester))
      return yield* new ChannelGatewayError({ reason: "forbidden" });
    const eventId = taskRetryEventIdFor(input.taskId, input.clientRequestId);
    const replayed = yield* retryGeneration(eventId);
    if (replayed !== undefined)
      return { status: "started", taskId: input.taskId, generation: replayed } as const;
    const task = stored.task;
    if (task.status === "completed") return refused(task, "completed");
    if (task.status !== "failed" && task.status !== "cancelled")
      return refused(task, "not_finished");
    if (placedElsewhere(task)) return refused(task, "elsewhere");
    if (task.worker !== undefined && isGoatBotSessionThreadId(task.worker.threadId))
      return refused(task, "not_retryable");
    if (yield* workerLive(task)) return refused(task, "still_running");
    return yield* commit(stored, eventId);
  });

  const restarts = (error: unknown) =>
    error instanceof Changed || (isLedgerError(error) && error.reason === "version_conflict");

  return Effect.fn("channelTaskRetry.retry")(
    function* (input: ChannelRetryTaskInput, owner: ChannelConnectionOwner) {
      // A task that moved between the checks and the write is judged again from its new state.
      for (let round = 1; round <= ROUNDS; round += 1) {
        const result = yield* attempt(input, owner).pipe(
          Effect.asSome,
          Effect.catchIf(restarts, () => Effect.succeedNone),
        );
        if (Option.isNone(result)) continue;
        if (result.value.status === "started") yield* wake.wake;
        return result.value;
      }
      return {
        status: "refused",
        taskId: input.taskId,
        reason: "not_finished",
      } satisfies ChannelRetryTaskResult;
    },
    Effect.catchIf(
      (error) => !isGatewayError(error),
      (error) =>
        Effect.logWarning("GOAT Bot task retry failed", { cause: error }).pipe(
          Effect.andThen(Effect.fail(new ChannelGatewayError({ reason: "persistence_failed" }))),
        ),
    ),
  );
});
