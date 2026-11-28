import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Cause from "effect/Cause";
import * as Scope from "effect/Scope";
import { makeShellDeltaLoads } from "./ShellDeltaLoads.ts";

it.effect("overlapping subscriber batches share each event's projection, including replay", () =>
  Effect.gen(function* () {
    const loads = yield* makeShellDeltaLoads<number, never>();
    const release = yield* Deferred.make<void>();
    const started = yield* Deferred.make<void>();
    const reads = new Map<number, number>();
    const load = (events: ReadonlyArray<{ readonly sequence: number }>) =>
      Effect.sync(() => {
        for (const event of events) reads.set(event.sequence, (reads.get(event.sequence) ?? 0) + 1);
      }).pipe(
        Effect.andThen(Deferred.succeed(started, undefined)),
        Effect.andThen(Deferred.await(release)),
        Effect.as(events.map((event) => event.sequence)),
      );
    const first = yield* loads
      .run([{ sequence: 1 }, { sequence: 2 }], load)
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(started);
    const second = yield* loads
      .run([{ sequence: 2 }, { sequence: 3 }], load)
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.succeed(release, undefined);
    expect(yield* Fiber.join(first)).toEqual([1, 2]);
    expect(yield* Fiber.join(second)).toEqual([2, 3]);
    expect(yield* loads.run([{ sequence: 2 }], load)).toEqual([2]);
    expect([...reads]).toEqual([
      [1, 1],
      [2, 1],
      [3, 1],
    ]);
  }).pipe(Effect.scoped),
);

it.effect("a failed shared projection reaches each subscriber and is not cached", () =>
  Effect.gen(function* () {
    const loads = yield* makeShellDeltaLoads<number, string>();
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const fail = () =>
      Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.andThen(Effect.fail("unavailable")),
      );
    const first = yield* loads
      .run([{ sequence: 9 }], fail)
      .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(entered);
    const second = yield* loads
      .run([{ sequence: 9 }], fail)
      .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
    yield* Deferred.succeed(release, undefined);
    expect(yield* Fiber.join(first)).toBe("unavailable");
    expect(yield* Fiber.join(second)).toBe("unavailable");
    expect(yield* loads.run([{ sequence: 9 }], () => Effect.succeed([42]))).toEqual([42]);
  }).pipe(Effect.scoped),
);

it.effect("interrupting one subscriber does not cancel another subscriber's projection", () =>
  Effect.gen(function* () {
    const loads = yield* makeShellDeltaLoads<number, never>();
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let reads = 0;
    const load = () =>
      Effect.sync(() => {
        reads++;
      }).pipe(
        Effect.andThen(Deferred.succeed(entered, undefined)),
        Effect.andThen(Deferred.await(release)),
        Effect.as([5]),
      );
    const first = yield* loads
      .run([{ sequence: 5 }], load)
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(entered);
    const second = yield* loads
      .run([{ sequence: 5 }], load)
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Fiber.interrupt(first);
    yield* Deferred.succeed(release, undefined);
    expect(yield* Fiber.join(second)).toEqual([5]);
    expect(reads).toBe(1);
  }).pipe(Effect.scoped),
);

it.effect("closing the shared scope interrupts pending and later callers", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const loads = yield* makeShellDeltaLoads<number, never>().pipe(
      Effect.provideService(Scope.Scope, scope),
    );
    const entered = yield* Deferred.make<void>();
    const pending = yield* loads
      .run([{ sequence: 1 }], () =>
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
      )
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(entered);
    yield* Scope.close(scope, Exit.void);
    const pendingExit = yield* Fiber.await(pending);
    expect(Exit.isFailure(pendingExit) && Cause.hasInterrupts(pendingExit.cause)).toBe(true);
    const lateExit = yield* Effect.exit(loads.run([{ sequence: 2 }], () => Effect.succeed([2])));
    expect(Exit.isFailure(lateExit) && Cause.hasInterrupts(lateExit.cause)).toBe(true);
  }),
);
