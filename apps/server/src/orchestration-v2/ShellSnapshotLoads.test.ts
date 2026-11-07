import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scheduler from "effect/Scheduler";
import * as Scope from "effect/Scope";

import { makeSingleFlight } from "./ShellSnapshotLoads.ts";

vi.mock("./ThreadManagementService.ts", () => ({}));

const setup = Effect.gen(function* () {
  const scope = yield* Scope.make();
  const flight = yield* makeSingleFlight<number, string>().pipe(
    Effect.provideService(Scope.Scope, scope),
  );
  return { scope, flight };
});

const interrupted = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause);

it.effect(
  "with scheduler yields disabled, same-key callers share a load and different keys do not",
  () =>
    Effect.gen(function* () {
      const { scope, flight } = yield* setup;
      const gate = yield* Deferred.make<void>();
      let calls = 0;
      const load = Effect.sync(() => ++calls).pipe(
        Effect.flatMap((n) => Deferred.await(gate).pipe(Effect.as(n))),
      );
      const a = yield* flight.run(false, load).pipe(Effect.forkChild({ startImmediately: true }));
      const b = yield* flight.run(false, load).pipe(Effect.forkChild({ startImmediately: true }));
      const c = yield* flight.run(true, load).pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.succeed(gate, undefined);
      const [av, bv, cv] = yield* Effect.all([Fiber.join(a), Fiber.join(b), Fiber.join(c)]);
      expect(av).toBe(bv);
      expect(cv).not.toBe(av);
      expect(calls).toBe(2);
      yield* Scope.close(scope, Exit.void);
    }).pipe(Effect.provideService(Scheduler.PreventSchedulerYield, true)),
);

it.effect("with scheduler yields disabled, interrupted callers cannot cancel a shared load", () =>
  Effect.gen(function* () {
    const { scope, flight } = yield* setup;
    const entered = yield* Deferred.make<void>();
    const gate = yield* Deferred.make<void>();
    let calls = 0;
    const load = Effect.sync(() => {
      calls++;
    }).pipe(
      Effect.andThen(Deferred.succeed(entered, undefined)),
      Effect.andThen(Deferred.await(gate)),
      Effect.as(42),
    );
    const first = yield* flight.run(false, load).pipe(Effect.forkChild({ startImmediately: true }));
    yield* Fiber.interrupt(first);
    yield* Deferred.await(entered);
    const second = yield* flight
      .run(false, load)
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Fiber.interrupt(second);
    const third = yield* flight.run(false, load).pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.succeed(gate, undefined);
    expect(yield* Fiber.join(third)).toBe(42);
    expect(calls).toBe(1);
    yield* Scope.close(scope, Exit.void);
  }).pipe(Effect.provideService(Scheduler.PreventSchedulerYield, true)),
);

it.effect("settled results are not retained", () =>
  Effect.gen(function* () {
    const { scope, flight } = yield* setup;
    let calls = 0;
    const load = Effect.sync(() => ++calls);
    expect(yield* flight.run(false, load)).toBe(1);
    expect(yield* flight.run(false, load)).toBe(2);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect(
  "with scheduler yields disabled, failure reaches every waiter and the next load starts fresh",
  () =>
    Effect.gen(function* () {
      const { scope, flight } = yield* setup;
      const gate = yield* Deferred.make<void>();
      let calls = 0;
      const load = Effect.sync(() => {
        calls++;
      }).pipe(Effect.andThen(Deferred.await(gate)), Effect.andThen(Effect.fail("failed")));
      const a = yield* flight
        .run(false, load)
        .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
      const b = yield* flight
        .run(false, load)
        .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
      yield* Deferred.succeed(gate, undefined);
      expect(yield* Fiber.join(a)).toBe("failed");
      expect(yield* Fiber.join(b)).toBe("failed");
      expect(calls).toBe(1);
      expect(yield* flight.run(false, Effect.succeed(7))).toBe(7);
      yield* Scope.close(scope, Exit.void);
    }).pipe(Effect.provideService(Scheduler.PreventSchedulerYield, true)),
);

it.effect(
  "with scheduler yields disabled, closing before or after registration interrupts waiters and future calls",
  () =>
    Effect.gen(function* () {
      const first = yield* setup;
      const entered = yield* Deferred.make<void>();
      const load = Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never));
      const waiter = yield* first.flight
        .run(false, load)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(entered);
      const joined = yield* first.flight
        .run(false, load)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Scope.close(first.scope, Exit.void);
      expect(interrupted(yield* Fiber.await(waiter))).toBe(true);
      expect(interrupted(yield* Fiber.await(joined))).toBe(true);
      expect(interrupted(yield* Effect.exit(first.flight.run(false, Effect.succeed(1))))).toBe(
        true,
      );

      const second = yield* setup;
      let ran = false;
      const pending = yield* second.flight
        .run(
          false,
          Effect.sync(() => {
            ran = true;
            return 1;
          }),
        )
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Scope.close(second.scope, Exit.void);
      expect(ran).toBe(false);
      expect(interrupted(yield* Fiber.await(pending))).toBe(true);
      expect(interrupted(yield* Effect.exit(second.flight.run(true, Effect.succeed(1))))).toBe(
        true,
      );
    }).pipe(Effect.provideService(Scheduler.PreventSchedulerYield, true)),
);
