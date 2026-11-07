import { idleEffectWorker } from "./EffectWorker.testkit.ts";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  ProviderSessionId,
  ProviderThreadId,
  RunId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderRuntimeRecovery from "./ProviderRuntimeRecoveryService.ts";
import {
  layerTest,
  providerDriver,
  providerInstanceId,
  modelSelection,
  makeThread,
  threadCreatedEvent,
} from "./FoundationPersistence.testkit.ts";

it.effect.each([false, true])("groups shutdown commits with rollback=%s", (fail) => {
  let commits = 0;
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      const end = span.end.bind(span);
      span.end = (time, exit) => {
        end(time, exit);
        if (span.name === "orchestrationV2.EventSink.providerBatch" && Exit.isSuccess(exit))
          commits++;
      };
      return span;
    },
  });
  return Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const events = yield* EventStore.EventStoreV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const now = yield* DateTime.now;
    const threads = Array.from({ length: 65 }, (_, i) =>
      ThreadId.make(`shutdown-group:${String(i).padStart(2, "0")}`),
    );
    const sharedSession = {
      id: ProviderSessionId.make("shutdown-shared"),
      driver: providerDriver,
      providerInstanceId,
      status: "ready" as const,
      cwd: process.cwd(),
      model: modelSelection.model,
      capabilities: CodexProviderCapabilitiesV2,
      createdAt: now,
      updatedAt: now,
      lastError: null,
    };
    yield* sink.write({
      events: threads.flatMap((threadId, i): OrchestrationV2DomainEvent[] => [
        threadCreatedEvent({ id: `shutdown-create:${i}`, thread: makeThread(threadId, now), now }),
        ...(i < 2
          ? [
              {
                id: EventId.make(`shutdown-session:${i}`),
                type: "provider-session.attached" as const,
                threadId,
                occurredAt: now,
                payload: sharedSession,
              },
            ]
          : []),
        {
          id: EventId.make(`shutdown-provider:${i}`),
          type: "provider-thread.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: ProviderThreadId.make(`shutdown-provider:${i}`),
            driver: providerDriver,
            providerInstanceId,
            providerSessionId: i < 2 ? sharedSession.id : null,
            appThreadId: threadId,
            ownerNodeId: null,
            nativeThreadRef: null,
            nativeConversationHeadRef: null,
            status: i === 1 || i === 32 ? "idle" : "active",
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
          },
        },
      ]),
    });
    yield* outbox.enqueue(
      threads.map((threadId, i) => ({
        id: `shutdown-effect:${i}`,
        commandId: CommandId.make(`shutdown-command:${i}`),
        threadId,
        request: { type: "provider-turn.start" as const, runId: RunId.make(`shutdown-run:${i}`) },
      })),
    );
    let eventlessNotifications = 0;
    let armed = fail;
    const recovery = yield* ProviderRuntimeRecovery.make.pipe(
      Effect.provide(ServerSettings.layerTest()),
      Effect.provideService(EffectOutbox.EffectOutboxV2, {
        ...outbox,
        signalCancellations: (ids) =>
          Effect.gen(function* () {
            assert.isTrue(Option.isNone(yield* Effect.serviceOption(sql.transactionService)));
            eventlessNotifications += ids.length;
            yield* outbox.signalCancellations(ids);
          }),
      }),
      Effect.provideService(EffectWorker.OrchestrationEffectWorkerV2, idleEffectWorker()),
      Effect.provideService(EventSink.EventSinkV2, {
        ...sink,
        commitCommand: (input) =>
          armed && input.threadId === threads[33]
            ? Effect.die("injected shutdown failure")
            : sink.commitCommand(input),
      }),
    );
    commits = 0;
    const result = yield* recovery.reconcile("shutdown").pipe(Effect.exit);
    assert.equal(Exit.isFailure(result), fail);
    assert.equal(commits, fail ? 1 : 3);
    const receipts =
      yield* sql`SELECT aggregate_id FROM orchestration_command_receipts WHERE command_type = 'provider-runtime.reconcile' ORDER BY aggregate_id`;
    assert.deepEqual(
      receipts.map((r) => r.aggregate_id),
      threads.slice(0, fail ? 32 : 65).filter((_, i) => i !== 1 && i !== 32),
    );
    assert.deepEqual(
      yield* projections.getRecoveryThreadIds("runtime"),
      fail ? threads.slice(32) : [],
    );
    assert.equal(eventlessNotifications, fail ? 1 : 2);
    for (const [i] of threads.entries()) {
      const effect = Option.getOrThrow(yield* outbox.get(`shutdown-effect:${i}`));
      assert.equal(effect.status, !fail || i < 32 ? "cancelled" : "pending");
    }
    assert.equal(
      (yield* events.read({ afterSequence: 0 }).pipe(Stream.runCollect)).filter(
        (e) =>
          e.event.type === "provider-session.updated" && e.event.payload.id === sharedSession.id,
      ).length,
      1,
    );
    armed = false;
    yield* recovery.reconcile("shutdown");
    assert.deepEqual(yield* projections.getRecoveryThreadIds("runtime"), []);
    const highWater = yield* sink.latestSequence();
    yield* recovery.reconcile("shutdown");
    assert.equal(yield* sink.latestSequence(), highWater);
  }).pipe(
    Effect.provide(Layer.fresh(layerTest)),
    Effect.withTracer(tracer),
    Effect.withTracerEnabled(true),
    Effect.provideService(Statement.SpanPropagationEnabled, true),
  );
});
