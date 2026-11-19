import { EventId, ProviderSessionId, ThreadId } from "@goat/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as EventSink from "./EventSink.ts";
import * as Foundation from "./FoundationPersistence.testkit.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";

const instances = Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
  getInstance: () => Effect.succeed(undefined),
});
const dependencies = Layer.mergeAll(
  Foundation.layerTest,
  instances,
  ThreadCommandExecutor.layer,
  Layer.mock(GitVcsDriver.GitVcsDriver)({}),
);
const testLayer = ProviderEventIngestor.layer.pipe(Layer.provideMerge(dependencies));

it.effect.each([true, false])(
  "user title wins when it is committed first=$userFirst",
  (userFirst) =>
    Effect.gen(function* () {
      const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
      const sink = yield* EventSink.EventSinkV2;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const lock = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make(`auto-title-${userFirst}`);
      const thread = { ...Foundation.makeThread(threadId, now), title: "New thread" };
      yield* sink.write({
        events: [Foundation.threadCreatedEvent({ id: `created-${userFirst}`, thread, now })],
      });
      const offered = {
        type: "app_thread.created" as const,
        driver: Foundation.providerDriver,
        appThread: { ...thread, title: "Automatic title" },
        onlyIfDefaultTitle: true,
      };
      const auto = ingestor.ingestNormalized({
        providerSessionId: ProviderSessionId.make("title-session"),
        providerInstanceId: Foundation.providerInstanceId,
        threadId,
        event: offered,
      });
      const writeManual = lock.withLock(
        threadId,
        Effect.gen(function* () {
          const current = yield* store.getThread(threadId);
          yield* sink.write({
            events: [
              {
                id: EventId.make(`manual-${userFirst}`),
                type: "thread.metadata-updated",
                threadId,
                providerInstanceId: Foundation.providerInstanceId,
                occurredAt: now,
                payload: { ...current, title: "My title" },
              },
            ],
          });
        }),
      );
      if (userFirst) {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const held = yield* lock
          .withLock(
            threadId,
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              const current = yield* store.getThread(threadId);
              yield* sink.write({
                events: [
                  {
                    id: EventId.make(`held-${userFirst}`),
                    type: "thread.metadata-updated",
                    threadId,
                    providerInstanceId: Foundation.providerInstanceId,
                    occurredAt: now,
                    payload: { ...current, title: "My title" },
                  },
                ],
              });
            }),
          )
          .pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        const waiting = yield* auto.pipe(Effect.forkScoped);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(held);
        yield* Fiber.join(waiting);
      } else {
        yield* auto;
        yield* writeManual;
      }
      assert.equal((yield* store.getThread(threadId)).title, "My title");
    }).pipe(Effect.provide(testLayer)),
);

it.effect("applies an explicit provider rename unconditionally when the flag is absent", () =>
  Effect.gen(function* () {
    const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
    const sink = yield* EventSink.EventSinkV2;
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("native-title-explicit");
    const thread = { ...Foundation.makeThread(threadId, now), title: "My title" };
    yield* sink.write({
      events: [Foundation.threadCreatedEvent({ id: "created-explicit", thread, now })],
    });
    yield* ingestor.ingestNormalized({
      providerSessionId: ProviderSessionId.make("title-session"),
      providerInstanceId: Foundation.providerInstanceId,
      threadId,
      event: {
        type: "app_thread.created",
        driver: Foundation.providerDriver,
        appThread: { ...thread, title: "Native title" },
      },
    });
    assert.equal((yield* store.getThread(threadId)).title, "Native title");
  }).pipe(Effect.provide(testLayer)),
);
