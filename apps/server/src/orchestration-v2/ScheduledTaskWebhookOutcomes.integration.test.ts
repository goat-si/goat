import { EventId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import {
  withWebhookService as withService,
  waitForSpan,
  drainPendingDispatch,
  webhookTaskInput,
  requestFor,
} from "../scheduledTasks/ScheduledRunFixture.testkit.ts";

it.effect(
  "a launch defect without durable acceptance stays unknown and retains replay protection",
  () =>
    withService(
      ({ service, sql, launches }) =>
        Effect.gen(function* () {
          const { task } = yield* service.upsert(
            yield* webhookTaskInput({
              schedule: { type: "webhook", dedupe: { replayKey: "{{body}}" } },
            }),
          );
          const request = requestFor(task, { relayDeliveryId: "defect" });
          yield* waitForSpan(
            service.triggerWebhook(request),
            "ScheduledTaskService.runWebhookDelivery",
          );
          yield* Queue.take(launches);
          assert.equal((yield* service.list()).tasks[0]?.lastRun?.status, "unknown");
          assert.equal((yield* sql`SELECT 1 FROM scheduled_task_webhook_replay_keys`).length, 1);
          assert.equal(
            (yield* sql`SELECT 1 FROM scheduled_task_webhook_relay_deliveries`).length,
            1,
          );
          const duplicate = yield* service.triggerWebhook(request);
          assert.equal(duplicate._tag === "accepted" && duplicate.outcome, "duplicate");
          assert.equal(yield* Queue.size(launches), 0);
        }),
      { defectLaunches: { remaining: 1 } },
    ),
);
it.effect(
  "A rejection and late cleanup cannot change B, and redelivering A admits attempt two as latest",
  () =>
    withService(
      ({ service, sql, launches, runs }) =>
        Effect.gen(function* () {
          const { task } = yield* service.upsert(
            yield* webhookTaskInput({
              schedule: { type: "webhook", dedupe: { replayKey: "{{headers.delivery-id}}" } },
            }),
          );
          const request = (id: string) =>
            requestFor(task, { relayDeliveryId: id, headers: { "delivery-id": id } });
          yield* waitForSpan(
            service.triggerWebhook(request("A")),
            "ScheduledTaskService.runWebhookDelivery",
          );
          yield* Queue.take(launches);
          const a = yield* runs.deliveryReceipt("delivery:relay:A");
          assert.equal(a?.dispatchStatus, "failed");
          yield* waitForSpan(
            service.triggerWebhook(request("B")),
            "ScheduledTaskService.runWebhookDelivery",
          );
          yield* Queue.take(launches);
          const b = yield* runs.deliveryReceipt("delivery:relay:B");
          const before = (yield* service.list()).tasks[0]!;
          yield* runs.finishDispatch({
            firingId: a!.firingId,
            acceptedRun: null,
            at: before.updatedAt,
            dispatchEvidence: "unresolved",
          });
          assert.deepEqual((yield* service.list()).tasks[0]?.lastRun, b);
          assert.equal(before.runCount, 2);
          assert.deepEqual(
            yield* sql`SELECT delivery_id,outcome FROM scheduled_task_webhook_deliveries ORDER BY delivery_id`,
            [
              { delivery_id: "delivery:relay:A", outcome: "dispatch_failed" },
              { delivery_id: "delivery:relay:B", outcome: "accepted" },
            ],
          );
          assert.equal((yield* sql`SELECT 1 FROM scheduled_task_webhook_replay_keys`).length, 1);
          yield* TestClock.adjust("1 second");
          yield* waitForSpan(
            service.triggerWebhook(request("A")),
            "ScheduledTaskService.runWebhookDelivery",
          );
          yield* Queue.take(launches);
          const latest = (yield* service.list()).tasks[0]!;
          assert.equal(latest.lastRun?.firingId, a?.firingId);
          assert.equal(latest.lastRun?.dispatchStatus, "accepted");
          assert.equal(latest.runCount, 3);
          assert.deepEqual(yield* runs.deliveryReceipt("delivery:relay:B"), b);
          assert.deepEqual(
            yield* sql`SELECT attempt FROM scheduled_task_runs WHERE webhook_delivery_id='delivery:relay:A'`,
            [{ attempt: 2 }],
          );
          assert.equal((yield* sql`SELECT 1 FROM scheduled_task_webhook_replay_keys`).length, 2);
          assert.equal(
            (yield* sql`SELECT 1 FROM scheduled_task_webhook_relay_deliveries`).length,
            2,
          );
        }),
      { failLaunches: { remaining: 1 }, runStatus: "queued" },
    ),
);

it.effect("dispatch error after durable acceptance retains delivery replay protection", () =>
  withService(
    ({ service, sql, launches }) =>
      Effect.gen(function* () {
        const { task } = yield* service.upsert(
          yield* webhookTaskInput({
            schedule: { type: "webhook", dedupe: { replayKey: "{{body}}" } },
          }),
        );
        const request = requestFor(task, { relayDeliveryId: "accepted-then-failed" });
        yield* waitForSpan(
          service.triggerWebhook(request),
          "ScheduledTaskService.runWebhookDelivery",
        );
        yield* Queue.take(launches);
        const observed = (yield* service.list()).tasks[0]!;
        assert.equal(observed.lastRun?.dispatchStatus, "accepted");
        assert.equal(observed.lastRun?.status, "queued");
        assert.equal((yield* sql`SELECT 1 FROM scheduled_task_webhook_replay_keys`).length, 1);
        assert.equal(
          (yield* sql<{
            outcome: string;
          }>`SELECT outcome FROM scheduled_task_webhook_deliveries`)[0]?.outcome,
          "accepted",
        );
        const retry = yield* service.triggerWebhook(request);
        assert.equal(retry._tag === "accepted" && retry.outcome, "duplicate");
        assert.equal(yield* Queue.size(launches), 0);
      }),
    { failAfterAcceptance: true, runStatus: "queued" },
  ),
);
it.effect(
  "return-only launch response becomes unknown and restart drops pending work without releasing replay keys",
  () =>
    withService(
      ({ service, sql, launches }) =>
        Effect.gen(function* () {
          const { task } = yield* service.upsert(
            yield* webhookTaskInput({
              schedule: { type: "webhook", dedupe: { replayKey: "{{body}}" } },
            }),
          );
          const request = requestFor(task, { relayDeliveryId: "return-only" });
          yield* waitForSpan(
            service.triggerWebhook(request),
            "ScheduledTaskService.runWebhookDelivery",
          );
          yield* Queue.take(launches);
          assert.equal((yield* service.list()).tasks[0]?.lastRun?.status, "unknown");
          yield* sql`INSERT INTO scheduled_task_webhook_pending (delivery_id,task_id,coalesce_key,task_json,request_json,due_at,state,delivery_ids_json)
      VALUES ('delivery:relay:return-only',${task.id},'return-only','{}','{}',0,'running','["delivery:relay:return-only"]')`;
          const workers = new Map<string, Effect.Effect<void>>();
          yield* withService(
            ({ service: restarted, launches: recovered }) =>
              Effect.gen(function* () {
                yield* drainPendingDispatch(workers);
                assert.equal((yield* sql`SELECT 1 FROM scheduled_task_webhook_pending`).length, 0);
                assert.equal(
                  (yield* sql`SELECT 1 FROM scheduled_task_webhook_replay_keys`).length,
                  1,
                );
                assert.equal(
                  (yield* sql`SELECT 1 FROM scheduled_task_webhook_relay_deliveries`).length,
                  1,
                );
                const duplicate = yield* restarted.triggerWebhook(request);
                assert.equal(duplicate._tag === "accepted" && duplicate.outcome, "duplicate");
                assert.equal(yield* Queue.size(recovered), 0);
                assert.equal((yield* restarted.list()).tasks[0]?.runCount, 1);
              }),
            { sql, workers },
          );
        }),
      { returnOnly: true },
    ),
);

it.effect("accepted provider failure never releases webhook replay or relay protection", () =>
  withService(
    ({ service, sql, launches, sink, projections }) =>
      Effect.gen(function* () {
        const { task } = yield* service.upsert(
          yield* webhookTaskInput({
            schedule: { type: "webhook", dedupe: { replayKey: "{{body}}" } },
          }),
        );
        const request = requestFor(task, { relayDeliveryId: "provider-failed" });
        yield* waitForSpan(
          service.triggerWebhook(request),
          "ScheduledTaskService.runWebhookDelivery",
        );
        yield* Queue.take(launches);
        const accepted = (yield* service.list()).tasks[0]!.lastRun!;
        const projection = yield* projections.getThreadProjection(accepted.threadId!);
        const run = projection.runs[0]!;
        const now = yield* DateTime.now;
        yield* sink.write({
          events: [
            {
              id: EventId.make("provider-failed"),
              threadId: run.threadId,
              occurredAt: now,
              type: "run.updated",
              payload: {
                ...run,
                status: "failed",
                completedAt: now,
                terminationCause: { kind: "provider_error" },
              },
            },
          ],
        });
        assert.equal((yield* service.list()).tasks[0]?.lastRun?.status, "failed");
        assert.equal(
          (yield* sql<{
            outcome: string;
          }>`SELECT outcome FROM scheduled_task_webhook_deliveries WHERE delivery_id='delivery:relay:provider-failed'`)[0]
            ?.outcome,
          "accepted",
        );
        assert.equal((yield* sql`SELECT 1 FROM scheduled_task_webhook_replay_keys`).length, 1);
        assert.equal((yield* sql`SELECT 1 FROM scheduled_task_webhook_relay_deliveries`).length, 1);
        const retry = yield* service.triggerWebhook(request);
        assert.equal(retry._tag === "accepted" && retry.outcome, "duplicate");
        assert.equal(yield* Queue.size(launches), 0);
      }),
    { runStatus: "queued" },
  ),
);
