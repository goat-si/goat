import { assert } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

export const layerTestDatabase = SqlitePersistence.layerMemory;
export const layerTestStores = Layer.merge(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provide(layerTestDatabase),
);
export const layerTestEventSink = EventSink.layer.pipe(
  Layer.provide(Layer.mergeAll(layerTestStores, layerTestDatabase)),
);
export const layerFailingReleaseEventSink = Layer.effect(
  EventSink.EventSinkV2,
  Effect.gen(function* () {
    const delegate = yield* EventSink.EventSinkV2;
    return EventSink.EventSinkV2.of({
      ...delegate,
      write: (input) =>
        input.events.some(
          (event) =>
            event.type === "provider-session.updated" &&
            (event.payload.status === "stopped" || event.payload.status === "error"),
        )
          ? Effect.fail(new EventSink.EventSinkWriteError({ eventCount: input.events.length }))
          : delegate.write(input),
    });
  }),
).pipe(Layer.provide(layerTestEventSink));

export interface FlakyReleaseWrites {
  readonly failing: Ref.Ref<"none" | "session" | "session-and-requests">;
  readonly failures: Queue.Queue<void>;
  readonly pauseRequestWrites?: {
    readonly paused: Deferred.Deferred<void>;
    readonly resume: Deferred.Deferred<void>;
  };
}

export const layerFlakyReleaseEventSink = (flaky: FlakyReleaseWrites) =>
  Layer.effect(
    EventSink.EventSinkV2,
    Effect.gen(function* () {
      const delegate = yield* EventSink.EventSinkV2;
      return EventSink.EventSinkV2.of({
        ...delegate,
        write: (input) =>
          Effect.gen(function* () {
            const failing = yield* Ref.get(flaky.failing);
            const fails = input.events.some(
              (event) =>
                (failing !== "none" &&
                  event.type === "provider-session.updated" &&
                  (event.payload.status === "stopped" || event.payload.status === "error")) ||
                (failing === "session-and-requests" && event.type === "runtime-request.updated"),
            );
            const pause = flaky.pauseRequestWrites;
            if (
              pause !== undefined &&
              input.events.some((event) => event.type === "runtime-request.updated")
            ) {
              yield* Deferred.succeed(pause.paused, undefined);
              yield* Deferred.await(pause.resume);
            }
            if (!fails) return yield* delegate.write(input);
            yield* Queue.offer(flaky.failures, undefined);
            return yield* Effect.die(new Error("simulated commit failure"));
          }),
      });
    }),
  ).pipe(Layer.provide(layerTestEventSink));

export const layerPausingAttachEventSink = (pause: {
  readonly armed: Ref.Ref<boolean>;
  readonly paused: Deferred.Deferred<void>;
}) =>
  Layer.effect(
    EventSink.EventSinkV2,
    Effect.gen(function* () {
      const delegate = yield* EventSink.EventSinkV2;
      return EventSink.EventSinkV2.of({
        ...delegate,
        write: (input) =>
          Effect.gen(function* () {
            const attach = input.events.some((event) => event.type === "provider-session.attached");
            if (attach && (yield* Ref.getAndSet(pause.armed, false))) {
              yield* Deferred.succeed(pause.paused, undefined);
              return yield* Effect.never;
            }
            return yield* delegate.write(input);
          }),
      });
    }),
  ).pipe(Layer.provide(layerTestEventSink));

export const layerBeforeUnchangedWriteEventSink = (before: Ref.Ref<Effect.Effect<void>>) =>
  Layer.effect(
    EventSink.EventSinkV2,
    Effect.gen(function* () {
      const delegate = yield* EventSink.EventSinkV2;
      return EventSink.EventSinkV2.of({
        ...delegate,
        writeIfProviderThreadUnchanged: (input) =>
          Ref.getAndSet(before, Effect.void).pipe(
            Effect.flatten,
            Effect.andThen(delegate.writeIfProviderThreadUnchanged(input)),
          ),
      });
    }),
  ).pipe(Layer.provide(layerTestEventSink));

type RequestFixture = {
  readonly requestId: import("@goat/contracts").RuntimeRequestId;
  readonly events: ReadonlyArray<import("@goat/contracts").OrchestrationV2DomainEvent>;
};
export const seedRequestFilter = Effect.fn("test.seedRequestFilter")(function* (input: {
  readonly sink: EventSink.EventSinkV2["Service"];
  readonly projections: ProjectionStore.ProjectionStoreV2["Service"];
  readonly threadId: import("@goat/contracts").ThreadId;
  readonly pending: RequestFixture;
  readonly historical: RequestFixture;
  readonly now: import("effect/DateTime").Utc;
}) {
  yield* input.sink.write({ events: input.pending.events });
  yield* input.sink.write({
    events: input.historical.events.map((event) =>
      event.type === "runtime-request.updated"
        ? { ...event, payload: { ...event.payload, status: "resolved", resolvedAt: input.now } }
        : event,
    ),
  });
  assert.deepEqual(
    (yield* input.projections.getThreadRecords(input.threadId, ["turnItems"], {
      turnItemRequestIds: [input.pending.requestId],
    })).turnItems.map((item) => item.id),
    [input.pending.events.find((event) => event.type === "turn-item.updated")?.payload.id],
  );
});
export function assertReleasedRequest(
  projection: import("@goat/contracts").OrchestrationV2ThreadProjection,
  pending: RequestFixture,
  historical: RequestFixture,
) {
  const request = projection.runtimeRequests.find((item) => item.id === pending.requestId);
  assert.equal(
    projection.runtimeRequests.find((item) => item.id === historical.requestId)?.status,
    "resolved",
  );
  const node = projection.nodes.find((item) => item.id === request?.nodeId);
  const item = projection.turnItems.find(
    (item) => item.type === "approval_request" && item.requestId === request?.id,
  );
  assert.equal(request?.status, "expired");
  assert.equal(request?.responseCapability.type, "not_resumable");
  assert.equal(node?.status, "failed");
  assert.equal(item?.status, "failed");
}
