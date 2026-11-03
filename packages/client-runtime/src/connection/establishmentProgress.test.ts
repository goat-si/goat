import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import * as EnvironmentSupervisor from "./supervisor.ts";
import { makeHarness, TARGET } from "./supervisorTestSupport.ts";

const TARGET_ENTRY = { target: TARGET, profile: Option.none(), enabled: true };

it.effect("progress renews the ordinary setup deadline while duplicate progress does not", () =>
  Effect.gen(function* () {
    const start = yield* Deferred.make<void>();
    const advance = yield* Deferred.make<void>();
    const duplicate = yield* Deferred.make<void>();
    const advanced = yield* Deferred.make<void>();
    const duplicated = yield* Deferred.make<void>();
    const harness = yield* makeHarness({
      prepare: (_attempt, _target, progress) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(start, undefined);
          yield* Deferred.await(advance);
          yield* progress({ stage: "preparing", hostAnswered: true });
          yield* Deferred.succeed(advanced, undefined);
          yield* Deferred.await(duplicate);
          yield* progress({ stage: "preparing", hostAnswered: true });
          yield* Deferred.succeed(duplicated, undefined);
          return yield* Effect.never;
        }),
    });
    const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
      initiallyDesired: true,
    }).pipe(Effect.provide(harness.dependencies));
    yield* Deferred.await(start);
    yield* TestClock.adjust("14 seconds");
    yield* Deferred.succeed(advance, undefined);
    yield* Deferred.await(advanced);
    yield* TestClock.adjust("14 seconds");
    expect(yield* Ref.get(harness.prepareCount)).toBe(1);
    yield* Deferred.succeed(duplicate, undefined);
    yield* Deferred.await(duplicated);
    yield* TestClock.adjust("1 second");
    expect(yield* Ref.get(harness.prepareCount)).toBeGreaterThan(1);
    yield* supervisor.disconnect;
  }),
);
