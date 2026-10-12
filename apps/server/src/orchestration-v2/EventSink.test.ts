import { assert, it } from "@effect/vitest";
import { EventId, ProjectId, ProviderInstanceId, ThreadId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const layerTest = EventSink.layer.pipe(
  Layer.provide(Layer.mergeAll(EventStore.layer, ProjectionStore.layer)),
  Layer.provide(SqlitePersistence.layerMemory),
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
