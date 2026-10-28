import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@goat/contracts";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

it.effect(
  "promotes a queued run exactly once after replay fails and its predecessor completes during backoff",
  () =>
    Effect.gen(function* () {
      const failed = yield* Deferred.make<void>();
      const reattached = yield* Deferred.make<void>();
      const subscribed = yield* Deferred.make<void>();
      const promoted = yield* Deferred.make<void>();
      const databaseLayer = SqlitePersistence.layerMemory;
      const instanceId = ProviderInstanceId.make("codex");
      const modelSelection = { instanceId, model: "gpt-5.1-codex" };
      const adapter = {
        instanceId,
        driver: ProviderDriverKind.make("codex"),
        getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
        openSession: () => Effect.die("The effect worker is stopped in this recovery fixture"),
      } as ProviderAdapter.ProviderAdapterV2["Service"];
      // Prime the shared store before the harness constructs its production EventSink and reactors.
      const fault = Layer.effect(
        EventStore.EventStoreV2,
        Effect.gen(function* () {
          const store = yield* EventStore.EventStoreV2;
          const read = store.read;
          let failNext = true;
          yield* Effect.acquireRelease(
            Effect.sync(() =>
              vi.spyOn(store, "read").mockImplementation((input) => {
                if (input?.eventType !== "run.updated" || input.threadId !== undefined)
                  return read(input);
                if (failNext) {
                  failNext = false;
                  return Stream.fromEffect(
                    Deferred.succeed(failed, undefined).pipe(
                      Effect.andThen(
                        Effect.fail(
                          new EventStore.EventStoreReadEventsError({
                            afterSequence: input.afterSequence ?? 0,
                            cause: new Error("injected replay read failure"),
                          }),
                        ),
                      ),
                    ),
                  );
                }
                return Stream.unwrap(
                  Deferred.succeed(reattached, undefined).pipe(Effect.as(read(input))),
                );
              }),
            ),
            (spy) => Effect.sync(() => spy.mockRestore()),
          );
          return store;
        }),
      ).pipe(Layer.provide(EventStore.layer), Layer.provide(databaseLayer));
      const layer = ProviderReplayHarness.layerWithRegistry(
        { name: "reactor-supervision" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { databaseLayer, runEffectWorker: false },
      ).pipe(Layer.provideMerge(fault), Layer.provideMerge(databaseLayer));

      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const store = yield* EventStore.EventStoreV2;
        const sql = yield* SqlClient.SqlClient;
        yield* Deferred.await(failed);
        const threadId = ThreadId.make("thread:reactor-supervision");
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create:reactor-supervision"),
          threadId,
          projectId: ProjectId.make("project:reactor-supervision"),
          title: "Replay recovery",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("active:reactor-supervision"),
          threadId,
          messageId: MessageId.make("message:active"),
          text: "Active work",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        const queuedMessageId = MessageId.make("message:queued");
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("queue:reactor-supervision"),
          threadId,
          messageId: queuedMessageId,
          text: "Queued work",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });
        const before = yield* projections.getThreadProjection(threadId);
        const activeRun = before.runs.find((run) => run.userMessageId !== queuedMessageId)!;
        const queuedRun = before.runs.find((run) => run.userMessageId === queuedMessageId)!;
        assert.equal(queuedRun.status, "queued");
        const observer = yield* sink
          .stream({
            threadId,
            eventType: "run.updated",
            afterSequence: yield* sink.latestSequence(),
            onSubscribed: Deferred.succeed(subscribed, undefined).pipe(Effect.asVoid),
          })
          .pipe(
            Stream.filter(
              (stored) =>
                stored.event.type === "run.updated" &&
                stored.event.payload.id === queuedRun.id &&
                stored.event.payload.status === "starting",
            ),
            Stream.take(1),
            Stream.runForEach(() => Deferred.succeed(promoted, undefined)),
            Effect.forkScoped,
          );
        yield* Deferred.await(subscribed);
        const now = yield* DateTime.now;
        yield* sink.write({
          commandId: CommandId.make("terminal:reactor-supervision"),
          events: [
            {
              id: EventId.make("terminal:reactor-supervision"),
              type: "run.updated",
              threadId,
              occurredAt: now,
              payload: { ...activeRun, status: "completed", completedAt: now },
            },
          ],
        });
        assert.isFalse(yield* Deferred.isDone(reattached));
        assert.equal(
          (yield* projections.getThreadProjection(threadId)).runs.find(
            (run) => run.id === queuedRun.id,
          )?.status,
          "queued",
        );
        yield* TestClock.adjust("1 second");
        assert.isTrue(yield* Deferred.isDone(reattached));
        yield* Deferred.await(promoted);
        yield* Fiber.join(observer);
        assert.equal(
          (yield* projections.getThreadProjection(threadId)).runs.find(
            (run) => run.id === queuedRun.id,
          )?.status,
          "starting",
        );
        yield* TestClock.adjust("1 minute");
        const events = yield* store
          .read({ threadId, eventType: "run.updated" })
          .pipe(Stream.runCollect);
        const promotions = events.filter(
          (stored) =>
            stored.event.type === "run.updated" &&
            stored.event.payload.id === queuedRun.id &&
            stored.event.payload.status === "starting",
        );
        assert.lengthOf(promotions, 1);
        const starts = yield* sql<{ readonly runId: string }>`
          SELECT json_extract(payload_json, '$.runId') AS runId
          FROM orchestration_v2_effect_outbox
          WHERE thread_id = ${threadId} AND effect_type = 'provider-turn.start'
        `;
        assert.lengthOf(
          starts.filter((effect) => effect.runId === queuedRun.id),
          1,
        );
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
);
