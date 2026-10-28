import { assert, it } from "@effect/vitest";
import type { ServerLifecycleStreamEvent } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";

it.effect("a blocked lifecycle subscriber resumes at the latest state for each type", () =>
  Effect.gen(function* () {
    const service = yield* ServerLifecycleEvents.ServerLifecycleEvents;
    const blocked = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const seen = yield* Queue.unbounded<number>();
    let first = true;
    yield* service.stream.pipe(
      Stream.runForEach((event) => {
        if (first) {
          first = false;
          return Deferred.succeed(blocked, undefined).pipe(Effect.andThen(Deferred.await(release)));
        }
        return Queue.offer(seen, event.sequence);
      }),
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* service.publish({
      version: 1,
      type: "legacyThreadMigration",
      payload: { status: "running", totalThreadCount: 1 },
    });
    yield* Deferred.await(blocked);
    for (let count = 2; count <= 1001; count++) {
      yield* service.publish({
        version: 1,
        type: "legacyThreadMigration",
        payload: { status: count === 1001 ? "complete" : "running", totalThreadCount: count },
      });
    }
    yield* Deferred.succeed(release, undefined);
    assert.equal(yield* Queue.take(seen), 1001);
  }).pipe(Effect.provide(ServerLifecycleEvents.layer), Effect.scoped),
);

it.effect("a migration burst preserves the latest drain cancellation in sequence order", () =>
  Effect.gen(function* () {
    const service = yield* ServerLifecycleEvents.ServerLifecycleEvents;
    const blocked = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const seen = yield* Queue.unbounded<ServerLifecycleStreamEvent>();
    let first = true;
    yield* service.stream.pipe(
      Stream.runForEach((event) => {
        if (first) {
          first = false;
          return Deferred.succeed(blocked, undefined).pipe(Effect.andThen(Deferred.await(release)));
        }
        return Queue.offer(seen, event);
      }),
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* service.publish({
      version: 1,
      type: "legacyThreadMigration",
      payload: { status: "running", totalThreadCount: 1 },
    });
    yield* Deferred.await(blocked);
    const drain = {
      version: 1,
      type: "runtimeDrain",
      payload: {
        status: "draining",
        targetVersion: "1.0.0",
        deadline: "2026-10-28T00:00:00.000Z",
        forced: false,
      },
    } as const;
    yield* service.publish(drain);
    for (let count = 2; count <= 1001; count++) {
      yield* service.publish({
        version: 1,
        type: "legacyThreadMigration",
        payload: { status: count === 1001 ? "complete" : "running", totalThreadCount: count },
      });
    }
    const cancelled = yield* service.publish({
      ...drain,
      payload: { ...drain.payload, status: "cancelled" },
    });
    const snapshot = yield* service.snapshot;
    yield* Deferred.succeed(release, undefined);
    assert.deepEqual(
      [yield* Queue.take(seen), yield* Queue.take(seen)],
      [snapshot.events.find((event) => event.type === "legacyThreadMigration"), cancelled],
    );
  }).pipe(Effect.provide(ServerLifecycleEvents.layer), Effect.scoped),
);

it.effect("new lifecycle subscribers replay current state before live changes", () =>
  Effect.gen(function* () {
    const service = yield* ServerLifecycleEvents.ServerLifecycleEvents;
    const initial = yield* service.publish({
      version: 1,
      type: "legacyThreadMigration",
      payload: { status: "running", totalThreadCount: 1 },
    });
    const subscriber = yield* service.stream.pipe(
      Stream.take(1),
      Stream.runCollect,
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* service.publish({
      version: 1,
      type: "legacyThreadMigration",
      payload: { status: "complete", totalThreadCount: 2 },
    });
    assert.deepEqual(yield* Fiber.join(subscriber), [initial]);
  }).pipe(Effect.provide(ServerLifecycleEvents.layer), Effect.scoped),
);
