import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import { waitForCodexStartupWork } from "./CodexProbeShutdown.ts";

it.effect("closes a probe after startup work finishes", () =>
  Effect.gen(function* () {
    const busy = yield* Ref.make(true);
    const checked = yield* Deferred.make<void>();
    const closed = yield* Deferred.make<void>();
    const wait = yield* waitForCodexStartupWork(
      Deferred.succeed(checked, undefined).pipe(Effect.andThen(Ref.get(busy))),
      Deferred.succeed(closed, undefined).pipe(Effect.asVoid),
    ).pipe(Effect.forkScoped);
    yield* Deferred.await(checked);
    assert.isFalse(yield* Deferred.isDone(closed));
    yield* Ref.set(busy, false);
    yield* TestClock.adjust("500 millis");
    yield* Fiber.join(wait);
    assert.isTrue(yield* Deferred.isDone(closed));
  }),
);

it.effect("closes a probe after the bounded startup grace even if work remains", () =>
  Effect.gen(function* () {
    const checked = yield* Deferred.make<void>();
    const closed = yield* Deferred.make<void>();
    const wait = yield* waitForCodexStartupWork(
      Deferred.succeed(checked, undefined).pipe(Effect.as(true)),
      Deferred.succeed(closed, undefined).pipe(Effect.asVoid),
    ).pipe(Effect.forkScoped);
    yield* Deferred.await(checked);
    yield* TestClock.adjust("1 minute");
    yield* Fiber.join(wait);
    assert.isTrue(yield* Deferred.isDone(closed));
  }),
);
