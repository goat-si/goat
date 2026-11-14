import { assert, it } from "@effect/vitest";
import { ProviderTurnId } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import { makeCodexRetryTimers } from "./CodexRetryTimers.ts";

it.effect("replaces a retry deadline and cancels it when the retry recovers", () =>
  Effect.gen(function* () {
    const timers = makeCodexRetryTimers(yield* Effect.scope);
    const id = ProviderTurnId.make("retry-turn");
    const fired = yield* Ref.make<Array<string>>([]);
    const finished = yield* Deferred.make<void>();
    yield* timers.start(
      id,
      Ref.update(fired, (current) => [...current, "old"]),
    );
    yield* TestClock.adjust("9 minutes");
    yield* timers.start(
      id,
      Ref.update(fired, (current) => [...current, "new"]).pipe(
        Effect.andThen(Deferred.succeed(finished, undefined)),
      ),
    );
    yield* TestClock.adjust("1 minute");
    assert.deepEqual(yield* Ref.get(fired), []);
    yield* TestClock.adjust("9 minutes");
    yield* Deferred.await(finished);
    assert.deepEqual(yield* Ref.get(fired), ["new"]);
    yield* timers.start(
      id,
      Ref.update(fired, (current) => [...current, "cancelled"]),
    );
    yield* timers.cancel(id);
    yield* TestClock.adjust("10 minutes");
    assert.deepEqual(yield* Ref.get(fired), ["new"]);
  }).pipe(Effect.scoped),
);
