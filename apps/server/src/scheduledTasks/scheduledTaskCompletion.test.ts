import { assert, it } from "@effect/vitest";
import { CommandId, MessageId, RunAttemptId, ScheduledTaskId, EventId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import { withWebhookService, webhookTaskInput } from "./ScheduledRunFixture.testkit.ts";

it.effect("evaluates policy at completion and freezes the recorded decision", () =>
  withWebhookService(
    ({ service, sink, projections }) =>
      Effect.gen(function* () {
        const input = yield* webhookTaskInput({
          schedule: { type: "interval", everyMs: 60000 },
          notificationPolicy: "all_runs",
        });
        const task = (yield* service.upsert(input)).task;
        const ran = yield* service.runNow({ id: task.id });
        const run = (yield* projections.getThreadProjection(ran.threadId!)).runs[0]!;
        yield* service.upsert({ ...input, notificationPolicy: "failed_runs_only" });
        const now = yield* DateTime.now;
        const event = {
          id: EventId.make("terminal"),
          type: "run.updated" as const,
          threadId: run.threadId,
          occurredAt: now,
          payload: { ...run, status: "completed" as const, completedAt: now },
        };
        const stored = yield* sink.write({ events: [event] });
        const terminal = stored[0]?.event;
        assert.equal(
          terminal?.type === "run.updated" ? terminal.payload.completionNotification : undefined,
          "silent",
        );
        const projection = yield* projections.getThreadProjection(run.threadId);
        assert.equal(projection.runs[0]?.completionNotification, "silent");
        assert.isNull(projection.thread.notificationCompletedAt);
        yield* service.upsert({ ...input, notificationPolicy: "all_runs" });
        yield* sink.write({ events: [{ ...event, id: EventId.make("terminal-duplicate") }] });
        assert.equal(
          (yield* projections.getThreadProjection(run.threadId)).runs[0]?.completionNotification,
          "silent",
        );
      }),
    { runStatus: "queued" },
  ),
);

it.effect.each([
  ["all_runs", "completed", "succeeded", "no_update", "B", "notify"],
  ["failed_runs_only", "completed", null, null, null, "silent"],
  ["failed_runs_only", "completed", "blocked", "no_update", "B", "notify"],
  ["failed_runs_only", "failed", "succeeded", "no_update", "B", "notify"],
  ["important_updates", "completed", "succeeded", "no_update", "B", "silent"],
  ["important_updates", "completed", "succeeded", "important", "B", "notify"],
  ["important_updates", "completed", "succeeded", "future", "B", "notify"],
  ["important_updates", "completed", "succeeded", "no_update", null, "notify"],
  ["important_updates", "completed", "succeeded", "no_update", "A", "notify"],
  ["future", "completed", "succeeded", "no_update", "B", "notify"],
] as const)(
  "%s %s report %s/%s from attempt %s records %s",
  ([policy, status, outcome, relevance, attempt, expected]) =>
    withWebhookService(
      ({ service, sink, projections, sql }) =>
        Effect.gen(function* () {
          const input = yield* webhookTaskInput({ schedule: { type: "interval", everyMs: 60000 } });
          const task = (yield* service.upsert(input)).task;
          const ran = yield* service.runNow({ id: task.id });
          const initial = (yield* projections.getThreadProjection(ran.threadId!)).runs[0]!;
          const now = yield* DateTime.now;
          const run = { ...initial, activeAttemptId: RunAttemptId.make("B") };
          yield* sink.write({
            events: [
              {
                id: EventId.make("attempt-B"),
                type: "run.updated",
                threadId: run.threadId,
                occurredAt: now,
                payload: run,
              },
            ],
          });
          yield* sql`UPDATE scheduled_tasks SET notification_policy=${policy},thread_id=${run.threadId} WHERE task_id=${task.id}`;
          if (outcome !== null)
            yield* sql`INSERT INTO thread_run_results(thread_id,run_id,report_json,reported_at) VALUES (${run.threadId},${run.id},${JSON.stringify({ runId: run.id, expectedAttemptId: attempt, outcome, notificationRelevance: relevance })},'2026-10-15')`;
          yield* sink.write({
            events: [
              {
                id: EventId.make("terminal"),
                type: "run.updated",
                threadId: run.threadId,
                occurredAt: now,
                payload: { ...run, status, completedAt: now },
              },
            ],
          });
          assert.equal(
            (yield* projections.getThreadProjection(run.threadId)).runs[0]?.completionNotification,
            expected,
          );
        }),
      { runStatus: "queued" },
    ),
);

it.effect.each([true, false])(
  "any notifying firing wins regardless of admission order (%s)",
  (allFirst) =>
    withWebhookService(
      ({ service, sink, projections, runs, sql }) =>
        Effect.gen(function* () {
          const input = yield* webhookTaskInput({
            schedule: { type: "interval", everyMs: 60000 },
            notificationPolicy: allFirst ? "all_runs" : "failed_runs_only",
          });
          const first = (yield* service.upsert(input)).task;
          const ran = yield* service.runNow({ id: first.id });
          const projection = yield* projections.getThreadProjection(ran.threadId!);
          const run = projection.runs[0]!;
          const second = (yield* service.upsert({
            ...input,
            id: ScheduledTaskId.make("task-peer"),
            threadId: run.threadId,
            notificationPolicy: allFirst ? "failed_runs_only" : "all_runs",
          })).task;
          const now = yield* DateTime.now;
          const messageId = MessageId.make("peer-message");
          yield* runs.begin({
            task: second,
            firingId: CommandId.make("peer"),
            messageId,
            requestedAt: DateTime.formatIso(now),
            triggerKind: "manual",
            webhookDeliveryId: null,
          });
          const message = {
            ...projection.messages[0]!,
            id: messageId,
            scheduledTaskId: second.id,
            runId: run.id,
          };
          yield* sink.write({
            events: [
              {
                id: EventId.make("peer-message-event"),
                type: "message.updated",
                threadId: run.threadId,
                occurredAt: now,
                payload: message,
              },
            ],
          });
          const event = {
            id: EventId.make("terminal"),
            type: "run.updated" as const,
            threadId: run.threadId,
            occurredAt: now,
            payload: { ...run, status: "completed" as const, completedAt: now },
          };
          const before =
            yield* sql`SELECT firing_id,last_sequence,status FROM scheduled_task_runs ORDER BY firing_id`;
          const resolved = yield* runs.resolveBatchAttributions([event]);
          assert.equal(resolved.length, 2);
          assert.deepStrictEqual(
            yield* sql`SELECT firing_id,last_sequence,status FROM scheduled_task_runs ORDER BY firing_id`,
            before,
          );
          yield* sink.write({ events: [event] });
          assert.equal(
            (yield* projections.getThreadProjection(run.threadId)).runs[0]?.completionNotification,
            "notify",
          );
        }),
      { runStatus: "queued" },
    ),
);

it.effect("keeps undecided legacy terminal epochs notifying despite a stale silent duplicate", () =>
  withWebhookService(({ service, sink, projections, sql }) =>
    Effect.gen(function* () {
      const task = (yield* service.upsert(
        yield* webhookTaskInput({ schedule: { type: "interval", everyMs: 60000 } }),
      )).task;
      const fired = yield* service.runNow({ id: task.id });
      const run = (yield* projections.getThreadProjection(fired.threadId!)).runs[0]!;
      yield* sql`UPDATE orchestration_v2_projection_runs SET completion_notification=NULL,payload_json=json_remove(payload_json,'$.completionNotification') WHERE run_id=${run.id}`;
      const now = yield* DateTime.now;
      yield* sink.write({
        events: [
          {
            id: EventId.make("legacy-duplicate"),
            type: "run.updated",
            threadId: run.threadId,
            occurredAt: now,
            payload: { ...run, completionNotification: "silent" },
          },
        ],
      });
      assert.equal(
        (yield* projections.getThreadProjection(run.threadId)).runs[0]?.completionNotification,
        "notify",
      );
    }),
  ),
);

it.effect.each(["terminal-first", "binding-first"] as const)(
  "uses final message rebinding instead of a cancellation placeholder (%s)",
  (order) =>
    withWebhookService(
      ({ service, sink, projections, runs }) =>
        Effect.gen(function* () {
          const input = yield* webhookTaskInput({
            schedule: { type: "interval", everyMs: 60000 },
            notificationPolicy: "failed_runs_only",
          });
          const task = (yield* service.upsert(input)).task;
          const first = yield* service.runNow({ id: task.id });
          const old = (yield* projections.getThreadProjection(first.threadId!)).runs[0]!;
          const secondTask = (yield* service.upsert({
            ...input,
            id: ScheduledTaskId.make("all-task"),
            notificationPolicy: "all_runs",
          })).task;
          const second = yield* service.runNow({ id: secondTask.id });
          const secondProjection = yield* projections.getThreadProjection(second.threadId!);
          const run = secondProjection.runs[0]!;
          const initialMessage = (yield* projections.getThreadProjection(old.threadId))
            .messages[0]!;
          const at = yield* DateTime.now;
          const rebound = {
            id: EventId.make("rebound-message"),
            type: "message.updated" as const,
            threadId: run.threadId,
            occurredAt: at,
            payload: { ...initialMessage, threadId: run.threadId, runId: run.id },
          };
          const terminal = {
            id: EventId.make("actual-terminal"),
            type: "run.updated" as const,
            threadId: run.threadId,
            occurredAt: at,
            payload: { ...run, status: "completed" as const, completedAt: at },
          };
          const placeholder = {
            id: EventId.make("placeholder"),
            type: "run.updated" as const,
            threadId: old.threadId,
            occurredAt: at,
            payload: { ...old, status: "cancelled" as const, completedAt: at },
          };
          yield* sink.write({
            events:
              order === "terminal-first"
                ? [placeholder, terminal, rebound]
                : [rebound, placeholder, terminal],
          });
          const attributed = yield* runs.resolveAttribution({
            firingId: CommandId.make(first.task.lastRun!.firingId),
            acceptedRun: old,
          });
          assert.equal(attributed.run?.id, run.id);
          assert.equal(
            (yield* projections.getThreadProjection(run.threadId)).runs[0]?.completionNotification,
            "notify",
          );
          assert.equal(
            (yield* projections.getThreadProjection(old.threadId)).runs[0]?.completionNotification,
            "notify",
          );
        }),
      { runStatus: "queued" },
    ),
);
