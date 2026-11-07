import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { advanceQuiet, awaitQuiet } from "./stallAwareQuiet.ts";

it("credits late ticks and resets quiet on activity", () => {
  let state = { lastActivity: 0, lastTick: 0n, quiet: 0n };
  state = advanceQuiet(state, 20n, 0, 5n);
  assert.equal(state.quiet, 5n);
  state = advanceQuiet(state, 40n, 0, 5n);
  assert.equal(state.quiet, 10n);
  state = advanceQuiet(state, 45n, 0, 5n);
  assert.equal(state.quiet, 15n);
  state = advanceQuiet(state, 50n, 1, 5n);
  assert.equal(state.quiet, 0n);
  state = advanceQuiet(state, 49n, 1, 5n);
  assert.equal(state.quiet, 0n);
});

it.effect("inbound activity during the drain prevents expiration", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const gate = yield* Deferred.make<void>();
    let generation = 0;
    const expired = yield* Deferred.make<void>();
    yield* Effect.forkScoped(
      awaitQuiet({
        windowMs: 5_000,
        activity: () => generation,
        drainIo: Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(gate))),
      }).pipe(Effect.andThen(Deferred.succeed(expired, undefined))),
    );
    yield* TestClock.adjust("5 seconds");
    yield* Deferred.await(entered);
    generation++;
    yield* Deferred.succeed(gate, undefined);
    yield* TestClock.adjust("4 seconds");
    assert.isFalse(yield* Deferred.isDone(expired));
    yield* TestClock.adjust("1 second");
    yield* Deferred.await(expired);
  }),
);
