import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  RunAttemptId,
  ThreadId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as CommandReceipts from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

import {
  withWebhookService,
  webhookTaskInput,
} from "../scheduledTasks/ScheduledRunFixture.testkit.ts";

const layerTest = EventSink.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      EventStore.layer,
      ProjectionStore.layer,
      CommandReceipts.layer,
      EffectOutbox.layer,
    ),
  ),
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

it.effect(
  "effect-only recovery commits a receipt and outbox once at the thread high-water mark",
  () =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const receipts = yield* CommandReceipts.CommandReceiptStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:effect-only");
      const thread = idleThreadProjection(liveThreadShell(threadId)).thread;
      const stored = yield* sink.write({
        events: [
          {
            id: EventId.make("event:effect-only"),
            type: "thread.created",
            threadId,
            occurredAt: now,
            payload: thread,
          },
        ],
      });
      const otherThreadId = ThreadId.make("thread:other-sequence");
      yield* sink.write({
        events: [
          {
            id: EventId.make("event:other-sequence"),
            type: "thread.created",
            threadId: otherThreadId,
            occurredAt: now,
            payload: { ...thread, id: otherThreadId },
          },
        ],
      });
      const sequence = yield* sink.latestSequence();
      const commandId = CommandId.make("command:effect-only");
      const runId = RunId.make("run:effect-only");
      yield* outbox.enqueue([
        {
          id: "effect:obsolete-start",
          commandId: CommandId.make("command:obsolete-start"),
          threadId,
          request: { type: "provider-turn.start", runId },
        },
      ]);
      const input = {
        commandId,
        threadId,
        commandType: "provider-runtime.reconcile",
        acceptedAt: now,
        events: [],
        allowEffectOnly: true,
        effects: [
          {
            id: "effect:reattach",
            commandId,
            threadId,
            request: { type: "provider-turn.reattach" as const, runId },
          },
        ],
        cancelUnsettledEffects: {
          effectTypes: EffectOutbox.PROCESS_BOUND_EFFECT_TYPES,
          reason: "Process lost",
        },
      };
      const committed = yield* sink.commitCommand(input);
      assert.isTrue(committed.committed);
      assert.deepEqual(committed.storedEvents, []);
      assert.equal(committed.receipt.resultSequence, stored[0]!.sequence);
      assert.equal(committed.cancelledEffectCount, 1);
      assert.deepEqual(
        Option.getOrThrow(yield* receipts.getByCommandId(commandId)),
        committed.receipt,
      );
      assert.equal(
        Option.getOrThrow(yield* outbox.get("effect:obsolete-start")).status,
        "cancelled",
      );
      const duplicate = yield* sink.commitCommand({
        ...input,
        effects: [{ ...input.effects[0]!, id: "effect:must-not-enqueue" }],
      });
      assert.isFalse(duplicate.committed);
      assert.deepEqual(duplicate.receipt, committed.receipt);
      assert.deepEqual(duplicate.storedEvents, []);
      assert.equal(duplicate.cancelledEffectCount, 0);
      assert.equal((yield* outbox.listByCommandId(commandId)).length, 1);
      assert.isTrue(Option.isNone(yield* outbox.get("effect:must-not-enqueue")));
      assert.equal(yield* sink.latestSequence(), sequence);
      assert.deepEqual(yield* sink.readByCommandId({ commandId }).pipe(Stream.runCollect), []);
    }).pipe(Effect.provide(layerTest)),
);

it.effect.each([
  { allowEffectOnly: false, hasEffect: true },
  { allowEffectOnly: true, hasEffect: false },
])(
  "rejects empty-event commits allowEffectOnly=$allowEffectOnly hasEffect=$hasEffect",
  ({ allowEffectOnly, hasEffect }) =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const receipts = yield* CommandReceipts.CommandReceiptStoreV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const commandId = CommandId.make("command:invalid-effect-only");
      const threadId = ThreadId.make("thread:invalid-effect-only");
      const result = yield* sink
        .commitCommand({
          commandId,
          threadId,
          commandType: "provider-runtime.reconcile",
          acceptedAt: yield* DateTime.now,
          events: [],
          allowEffectOnly,
          effects: hasEffect
            ? [
                {
                  id: "effect:invalid",
                  commandId,
                  threadId,
                  request: { type: "provider-turn.reattach", runId: RunId.make("run:invalid") },
                },
              ]
            : [],
        })
        .pipe(Effect.exit);
      assert.equal(result._tag, "Failure");
      assert.isTrue(Option.isNone(yield* receipts.getByCommandId(commandId)));
      assert.deepEqual(yield* outbox.listByCommandId(commandId), []);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("rolls back the effect-only receipt and outbox together when enqueue fails", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const receipts = yield* CommandReceipts.CommandReceiptStoreV2;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TRIGGER reject_reattach BEFORE INSERT ON orchestration_v2_effect_outbox
      WHEN NEW.effect_id = 'effect:rejected-reattach'
      BEGIN SELECT RAISE(ABORT, 'Injected enqueue failure'); END`;
    const commandId = CommandId.make("command:rollback-effect-only");
    const threadId = ThreadId.make("thread:rollback-effect-only");
    const result = yield* sink
      .commitCommand({
        commandId,
        threadId,
        commandType: "provider-runtime.reconcile",
        acceptedAt: yield* DateTime.now,
        events: [],
        allowEffectOnly: true,
        effects: ["effect:first-reattach", "effect:rejected-reattach"].map((id) => ({
          id,
          commandId,
          threadId,
          request: { type: "provider-turn.reattach" as const, runId: RunId.make("run:rollback") },
        })),
      })
      .pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    assert.isTrue(Option.isNone(yield* receipts.getByCommandId(commandId)));
    assert.deepEqual(yield* outbox.listByCommandId(commandId), []);
    assert.equal(yield* sink.latestSequence(), 0);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("onSubscribed runs after acquisition and retains replay/live overlap", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:subscription");
    const instanceId = ProviderInstanceId.make("codex");
    const thread = {
      id: threadId,
      projectId: ProjectId.make("project:subscription"),
      title: "Subscription",
      createdBy: "user" as const,
      creationSource: "web" as const,
      providerInstanceId: instanceId,
      modelSelection: { instanceId, model: "gpt-5" },
      runtimeMode: "full-access" as const,
      interactionMode: "default" as const,
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    };
    const replay = yield* sink.write({
      events: [
        {
          id: EventId.make("subscription:replay"),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: thread,
        },
      ],
    });
    const acquired = yield* Deferred.make<void>();
    const releaseReplay = yield* Deferred.make<void>();
    const listener = yield* sink
      .stream({
        eventType: "thread.created",
        onSubscribed: Deferred.succeed(acquired, undefined).pipe(
          Effect.andThen(Deferred.await(releaseReplay)),
        ),
      })
      .pipe(Stream.take(2), Stream.runCollect, Effect.forkScoped);
    yield* Deferred.await(acquired);
    // This commit happens after subscription but before replay is allowed to start.
    const liveId = ThreadId.make("thread:subscription:live");
    const live = yield* sink.write({
      events: [
        {
          id: EventId.make("subscription:live"),
          type: "thread.created",
          threadId: liveId,
          occurredAt: now,
          payload: { ...thread, id: liveId },
        },
      ],
    });
    yield* Deferred.succeed(releaseReplay, undefined);
    const received = yield* Fiber.join(listener);
    assert.deepEqual(
      received.map((stored) => stored.sequence),
      [...replay, ...live].map((e) => e.sequence),
    );
  }).pipe(Effect.provide(layerTest), Effect.scoped),
);

it.effect.each(["stage", "setter", "append", "receipt", "outbox"] as const)(
  "rolls back provisional notification, log, receipt and outbox on %s failure",
  (point) =>
    withWebhookService(
      ({ service, sink, projections, sql }) =>
        Effect.gen(function* () {
          const task = (yield* service.upsert(
            yield* webhookTaskInput({
              schedule: { type: "interval", everyMs: 60000 },
              notificationPolicy: "failed_runs_only",
            }),
          )).task;
          const ran = yield* service.runNow({ id: task.id });
          const projection = yield* projections.getThreadProjection(ran.threadId!);
          const run = projection.runs[0]!;
          const now = yield* DateTime.now;
          const beforeRuns = yield* sql`SELECT * FROM orchestration_v2_projection_runs`;
          const beforeThreads = yield* sql`SELECT * FROM orchestration_v2_projection_threads`;
          const beforeReceipts = yield* sql`SELECT * FROM scheduled_task_runs`;
          const sequence = yield* sink.latestSequence();
          switch (point) {
            case "stage":
              yield* sql`CREATE TRIGGER reject_wp2 BEFORE UPDATE ON orchestration_v2_projection_runs WHEN NEW.status='completed' BEGIN SELECT RAISE(ABORT,'Synthetic stage failure'); END`;
              break;
            case "setter":
              yield* sql`CREATE TRIGGER reject_wp2 BEFORE UPDATE ON orchestration_v2_projection_runs WHEN NEW.completion_notification IS NOT NULL BEGIN SELECT RAISE(ABORT,'Synthetic setter failure'); END`;
              break;
            case "append":
              yield* sql`CREATE TRIGGER reject_wp2 BEFORE INSERT ON orchestration_events WHEN NEW.event_id='terminal-rollback' BEGIN SELECT RAISE(ABORT,'Synthetic append failure'); END`;
              break;
            case "receipt":
              yield* sql`CREATE TRIGGER reject_wp2 BEFORE UPDATE ON scheduled_task_runs WHEN NEW.status='completed' BEGIN SELECT RAISE(ABORT,'Synthetic receipt failure'); END`;
              break;
            case "outbox":
              yield* sql`CREATE TRIGGER reject_wp2 BEFORE INSERT ON orchestration_v2_effect_outbox BEGIN SELECT RAISE(ABORT,'Synthetic outbox failure'); END`;
              break;
          }
          const commandId = CommandId.make("rollback");
          const result = yield* sink
            .writeWithEffects({
              commandId,
              events: [
                {
                  id: EventId.make("terminal-rollback"),
                  type: "run.updated",
                  threadId: run.threadId,
                  occurredAt: now,
                  payload: { ...run, status: "completed", completedAt: now },
                },
              ],
              effects: [
                {
                  id: "rollback-effect",
                  commandId,
                  threadId: run.threadId,
                  request: { type: "provider-turn.reattach", runId: run.id },
                },
              ],
            })
            .pipe(Effect.result);
          assert.equal(result._tag, "Failure");
          assert.deepStrictEqual(
            yield* sql`SELECT * FROM orchestration_v2_projection_runs`,
            beforeRuns,
          );
          assert.deepStrictEqual(
            yield* sql`SELECT * FROM orchestration_v2_projection_threads`,
            beforeThreads,
          );
          assert.deepStrictEqual(yield* sql`SELECT * FROM scheduled_task_runs`, beforeReceipts);
          assert.equal(yield* sink.latestSequence(), sequence);
          assert.deepStrictEqual(yield* sql`SELECT * FROM orchestration_v2_effect_outbox`, []);
        }),
      { runStatus: "queued" },
    ),
);

it.effect(
  "publishes the decorated log once and retains a superseded notified epoch in a terminal-reopen-terminal batch",
  () =>
    withWebhookService(
      ({ service, sink, projections }) =>
        Effect.gen(function* () {
          const task = (yield* service.upsert(
            yield* webhookTaskInput({
              schedule: { type: "interval", everyMs: 60000 },
              notificationPolicy: "failed_runs_only",
            }),
          )).task;
          const fired = yield* service.runNow({ id: task.id });
          const projection = yield* projections.getThreadProjection(fired.threadId!);
          const run = projection.runs[0]!;
          const at = yield* DateTime.now;
          const afterSequence = yield* sink.latestSequence();
          const acquired = yield* Deferred.make<void>();
          const live = yield* sink
            .stream({
              threadId: run.threadId,
              afterSequence,
              onSubscribed: Deferred.succeed(acquired, undefined),
            })
            .pipe(Stream.take(4), Stream.runCollect, Effect.forkScoped);
          yield* Deferred.await(acquired);
          const commandId = CommandId.make("epoch-batch");
          const event = {
            id: EventId.make("notify-failure"),
            type: "run.updated" as const,
            threadId: run.threadId,
            occurredAt: at,
            payload: { ...run, status: "failed" as const, completedAt: at },
          };
          const later = DateTime.add(at, { seconds: 1 });
          const stored = yield* sink.write({
            commandId,
            events: [
              {
                id: EventId.make("redacted-message"),
                type: "message.updated",
                threadId: run.threadId,
                occurredAt: at,
                payload: {
                  ...projection.messages[0]!,
                  text: "GOAT_MCP_BEARER_TOKEN=otherrunSyntheticMcpTokenNotARealCredential00000000",
                },
              },
              event,
              {
                ...event,
                id: EventId.make("reopen"),
                payload: {
                  ...run,
                  status: "preparing",
                  completedAt: null,
                  activeAttemptId: RunAttemptId.make("next"),
                },
              },
              {
                ...event,
                id: EventId.make("quiet-next"),
                payload: {
                  ...run,
                  status: "completed",
                  completedAt: later,
                  activeAttemptId: RunAttemptId.make("next"),
                },
              },
            ],
          });
          const decisions = stored.flatMap((s) =>
            s.event.type === "run.updated" ? [s.event.payload.completionNotification] : [],
          );
          assert.deepStrictEqual(decisions, ["notify", undefined, "silent"]);
          assert.deepStrictEqual(yield* Fiber.join(live), stored);
          assert.deepStrictEqual(
            yield* sink.readByCommandId({ commandId }).pipe(Stream.runCollect),
            stored,
          );
          const final = yield* projections.getThreadProjection(run.threadId);
          assert.deepStrictEqual(final.thread.notificationCompletedAt, at);
          assert.equal(final.runs[0]?.completionNotification, "silent");
          assert.equal(final.messages[0]?.text, "GOAT_MCP_BEARER_TOKEN=[redacted]");
        }).pipe(Effect.scoped),
      { runStatus: "queued" },
    ),
);
