import { expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import { makeFreshFlight } from "./ShellFreshFlight.ts";

it.effect("one interrupted caller does not cancel another caller's shared snapshot", () =>
  Effect.gen(function* () {
    const flight = yield* makeFreshFlight<number, Error>(() => new Error("sequence regressed"));
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let reads = 0;
    const build = Effect.sync(() => ++reads).pipe(
      Effect.flatMap((value) =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as({ sequence: 1, value }),
        ),
      ),
    );
    const first = yield* flight
      .run("active", Effect.succeed(1), build)
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(entered);
    const second = yield* flight
      .run("active", Effect.succeed(1), build)
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Fiber.interrupt(first);
    yield* Deferred.succeed(release, undefined);
    expect(yield* Fiber.join(second)).toBe(1);
    expect(reads).toBe(1);
  }).pipe(Effect.scoped),
);

it.effect("closing the shared scope interrupts pending and later callers", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const flight = yield* makeFreshFlight<number, Error>(
      () => new Error("sequence regressed"),
    ).pipe(Effect.provideService(Scope.Scope, scope));
    const entered = yield* Deferred.make<void>();
    const first = yield* flight
      .run(
        "active",
        Effect.succeed(1),
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
      )
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(entered);
    yield* Scope.close(scope, Exit.void);
    const prior = yield* Fiber.await(first);
    expect(Exit.isFailure(prior) && Cause.hasInterrupts(prior.cause)).toBe(true);
    const late = yield* Effect.exit(
      flight.run("active", Effect.succeed(1), Effect.succeed({ sequence: 1, value: 1 })),
    );
    expect(Exit.isFailure(late) && Cause.hasInterrupts(late.cause)).toBe(true);
  }),
);
