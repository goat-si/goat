import { assert, it } from "@effect/vitest";
import { EventId, RunAttemptId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as ProjectionStore from "./ProjectionStore.ts";
import {
  withWebhookService,
  webhookTaskInput,
} from "../scheduledTasks/ScheduledRunFixture.testkit.ts";
import {
  applyToProjection,
  emptyProjection,
  threadShellFromProjection,
} from "./ProjectionStore.ts";

it.effect(
  "retains notified failure through same-run reopen, quiet success, stale thread update and full replay",
  () =>
    withWebhookService(
      ({ service, sink, projections, sql }) =>
        Effect.gen(function* () {
          const input = yield* webhookTaskInput({
            schedule: { type: "interval", everyMs: 60000 },
            notificationPolicy: "failed_runs_only",
          });
          const task = (yield* service.upsert(input)).task;
          const ran = yield* service.runNow({ id: task.id });
          const initial = yield* projections.getThreadProjection(ran.threadId!);
          const run = initial.runs[0]!;
          const now = yield* DateTime.now;
          const emit = (suffix: string, payload: typeof run) =>
            sink.write({
              events: [
                {
                  id: EventId.make(suffix),
                  type: "run.updated",
                  threadId: run.threadId,
                  occurredAt: now,
                  payload,
                },
              ],
            });
          yield* emit("failure", { ...run, status: "failed", completedAt: now });
          yield* emit("reopen", {
            ...run,
            status: "preparing",
            completedAt: null,
            activeAttemptId: RunAttemptId.make("retry"),
          });
          assert.deepStrictEqual(
            (yield* projections.getThreadProjection(run.threadId)).thread.notificationCompletedAt,
            now,
          );
          const later = DateTime.add(now, { seconds: 1 });
          yield* emit("quiet", {
            ...run,
            status: "completed",
            completedAt: later,
            activeAttemptId: RunAttemptId.make("retry"),
          });
          yield* sink.write({
            events: [
              {
                id: EventId.make("stale-thread"),
                type: "thread.metadata-updated",
                threadId: run.threadId,
                occurredAt: later,
                payload: initial.thread,
              },
            ],
          });
          const projection = yield* projections.getThreadProjection(run.threadId);
          assert.deepStrictEqual(projection.thread.notificationCompletedAt, now);
          assert.equal(projection.runs[0]?.completionNotification, "silent");
          const shell = yield* projections.getThreadShell(run.threadId);
          assert.equal(shell?.latestRunCompletionNotification, "silent");
          assert.deepStrictEqual(shell?.notificationCompletedAt, now);
          const scalar = yield* sql<{
            completion_notification: string;
            payload_json: string;
          }>`SELECT completion_notification,payload_json FROM orchestration_v2_projection_runs WHERE run_id=${run.id}`;
          assert.equal(
            scalar[0]?.completion_notification,
            JSON.parse(scalar[0]?.payload_json ?? "{}").completionNotification,
          );
          const stored = yield* sink
            .stream({ threadId: run.threadId })
            .pipe(Stream.take(7), Stream.runCollect);
          const replayEvents = stored
            .filter((s) => s.event.threadId === run.threadId)
            .map((s) => s.event);
          const created = replayEvents.find((e) => e.type === "thread.created");
          assert.isDefined(created);
          if (created?.type !== "thread.created") return;
          let replay = emptyProjection(created);
          for (const event of replayEvents) replay = applyToProjection(replay, event);
          assert.deepStrictEqual(replay.thread.notificationCompletedAt, now);
          assert.equal(replay.runs[0]?.completionNotification, "silent");
          const memory = yield* ProjectionStore.ProjectionStoreV2.pipe(
            Effect.provide(ProjectionStore.layerMemory),
          );
          for (const event of replayEvents) yield* memory.apply(event);
          const memoryProjection = yield* memory.getThreadProjection(run.threadId);
          assert.deepStrictEqual(
            memoryProjection.thread.notificationCompletedAt,
            projection.thread.notificationCompletedAt,
          );
          assert.equal(
            (yield* memory.getThreadShell(run.threadId))?.latestRunCompletionNotification,
            "silent",
          );
          const guard = {
            threadId: run.threadId,
            runId: run.id,
            expectedCompletedAt: later,
            expectedActiveAttemptId: RunAttemptId.make("wrong"),
            decision: "notify",
          };
          yield* projections.setCompletionNotification(guard).pipe(Effect.flip);
          yield* memory.setCompletionNotification(guard).pipe(Effect.flip);
          assert.equal(
            (yield* projections.getThreadProjection(run.threadId)).runs[0]?.completionNotification,
            "silent",
          );
          assert.equal(
            (yield* memory.getThreadProjection(run.threadId)).runs[0]?.completionNotification,
            "silent",
          );

          assert.deepStrictEqual(
            threadShellFromProjection(projection).notificationCompletedAt,
            now,
          );
        }),
      { runStatus: "queued" },
    ),
);

it.effect(
  "keeps idle compaction out of completion unread cursors but records its failure in live state and replay",
  () =>
    withWebhookService(
      ({ service, sink, projections }) =>
        Effect.gen(function* () {
          const input = yield* webhookTaskInput({ schedule: { type: "interval", everyMs: 60000 } });
          const task = (yield* service.upsert(input)).task;
          const ran = yield* service.runNow({ id: task.id });
          const initial = yield* projections.getThreadProjection(ran.threadId!);
          const run = initial.runs[0]!;
          const now = yield* DateTime.now;
          const messageEvent = {
            id: EventId.make("idle-message"),
            type: "message.updated" as const,
            threadId: run.threadId,
            occurredAt: now,
            payload: {
              ...initial.messages[0]!,
              text: "/compact",
              createdBy: "agent" as const,
              creationSource: "server" as const,
            },
          };
          const completionEvent = {
            id: EventId.make("idle-completed"),
            type: "run.updated" as const,
            threadId: run.threadId,
            occurredAt: now,
            payload: { ...run, status: "completed" as const, completedAt: now },
          };
          yield* sink.write({ events: [messageEvent, completionEvent] });
          const memory = yield* ProjectionStore.ProjectionStoreV2.pipe(
            Effect.provide(ProjectionStore.layerMemory),
          );
          yield* memory.apply({
            id: EventId.make("idle-thread"),
            type: "thread.created",
            threadId: run.threadId,
            occurredAt: now,
            payload: initial.thread,
          });
          yield* memory.apply(messageEvent);
          yield* memory.apply(completionEvent);
          let replay = applyToProjection(applyToProjection(initial, messageEvent), completionEvent);
          assert.isNull((yield* projections.getThreadShell(run.threadId))?.notificationCompletedAt);
          assert.isNull((yield* memory.getThreadShell(run.threadId))?.notificationCompletedAt);
          assert.isNull(threadShellFromProjection(replay).notificationCompletedAt);
          const later = DateTime.add(now, { seconds: 1 });
          const failureEvent = {
            ...completionEvent,
            id: EventId.make("idle-failed"),
            occurredAt: later,
            payload: { ...run, status: "failed" as const, completedAt: later },
          };
          yield* sink.write({ events: [failureEvent] });
          yield* memory.apply(failureEvent);
          replay = applyToProjection(replay, failureEvent);
          assert.deepStrictEqual(
            (yield* projections.getThreadShell(run.threadId))?.notificationCompletedAt,
            later,
          );
          assert.deepStrictEqual(
            (yield* memory.getThreadShell(run.threadId))?.notificationCompletedAt,
            later,
          );
          assert.deepStrictEqual(threadShellFromProjection(replay).notificationCompletedAt, later);
        }),
      { runStatus: "queued" },
    ),
);
