import { it } from "@effect/vitest";
import { ServerSettingsError, type StorageCleanupReport } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import { expect } from "vite-plus/test";
import { makeStorageCleanupWorker } from "./storageCleanupWorker.ts";

const report = (trigger: "automatic" | "manual"): StorageCleanupReport => ({
  trigger,
  startedAt: "2026-01-01T00:00:00.000Z",
  finishedAt: "2026-01-01T00:00:00.000Z",
  entries: [],
  counts: { removed: 0, kept: 0, failed: 0 },
  bytesFreed: 0,
  omittedCount: 0,
});

it.effect("settles manual callers when constructing a sweep defects and accepts later work", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let fail = true;
      const worker = yield* makeStorageCleanupWorker((trigger) => {
        if (fail) throw new Error("sweep construction failed");
        return Effect.succeed(report(trigger));
      });
      const caller = yield* worker.runNow.pipe(Effect.forkChild({ startImmediately: true }));
      yield* worker.drain;
      expect(caller.pollUnsafe()?._tag).toBe("Failure");
      fail = false;
      expect((yield* worker.runNow).trigger).toBe("manual");
    }),
  ),
);

it.effect("shares a queued sweep's failure and recovers on the next request", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const error = new ServerSettingsError({ settingsPath: "/fixture", operation: "read-file" });
      let runs = 0;
      const worker = yield* makeStorageCleanupWorker((trigger) =>
        Effect.gen(function* () {
          runs++;
          if (runs === 1) {
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
          }
          if (runs === 2) return yield* error;
          return report(trigger);
        }),
      );
      const first = yield* worker.runNow.pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(started);
      const pending = yield* Effect.forEach([1, 2, 3], () =>
        worker.runNow.pipe(Effect.result, Effect.forkChild({ startImmediately: true })),
      );
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);
      for (const caller of pending) {
        expect(yield* Fiber.join(caller)).toEqual(Result.fail(error));
      }
      expect((yield* worker.runNow).trigger).toBe("manual");
      expect(runs).toBe(3);
    }),
  ),
);

it.effect("interrupts active, queued, and late manual callers when its scope closes", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const started = yield* Deferred.make<void>();
    const worker = yield* makeStorageCleanupWorker(() =>
      Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
    ).pipe(Scope.provide(scope));
    const active = yield* worker.runNow.pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(started);
    const pending = yield* worker.runNow.pipe(Effect.forkChild({ startImmediately: true }));
    yield* Scope.close(scope, Exit.void);
    expect(Exit.hasInterrupts(yield* Fiber.await(active))).toBe(true);
    expect(Exit.hasInterrupts(yield* Fiber.await(pending))).toBe(true);
    expect(Exit.hasInterrupts(yield* Effect.exit(worker.runNow))).toBe(true);
    yield* worker.drain;
  }),
);

it.effect("rejects manual callers while shutdown waits for an active sweep's finalizer", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const started = yield* Deferred.make<void>();
    const finalizing = yield* Deferred.make<void>();
    const releaseFinalizer = yield* Deferred.make<void>();
    const worker = yield* makeStorageCleanupWorker(() =>
      Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(
          Deferred.succeed(finalizing, undefined).pipe(
            Effect.andThen(Deferred.await(releaseFinalizer)),
          ),
        ),
      ),
    ).pipe(Scope.provide(scope));
    const active = yield* worker.runNow.pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(started);
    const queued = yield* Effect.forEach([1, 2, 3], () =>
      worker.runNow.pipe(Effect.forkChild({ startImmediately: true })),
    );
    const closing = yield* Scope.close(scope, Exit.void).pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    yield* Deferred.await(finalizing);
    const duringClose = yield* Effect.forEach([1, 2, 3], () =>
      worker.runNow.pipe(Effect.forkChild({ startImmediately: true })),
    );
    const duringCloseExits = duringClose.map((caller) => caller.pollUnsafe());
    yield* Deferred.succeed(releaseFinalizer, undefined);
    yield* Fiber.join(closing);
    yield* worker.drain;
    expect(Exit.hasInterrupts(yield* Fiber.await(active))).toBe(true);
    for (const caller of queued) {
      expect(Exit.hasInterrupts(yield* Fiber.await(caller))).toBe(true);
    }
    for (const exit of duringCloseExits) {
      expect(exit?._tag).toBe("Failure");
      expect(exit && Exit.hasInterrupts(exit)).toBe(true);
    }
    expect(Exit.hasInterrupts(yield* Effect.exit(worker.runNow))).toBe(true);
  }),
);

it.effect("keeps a shared queued sweep when one waiter cancels and automatic wakes overflow", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const triggers: string[] = [];
      const worker = yield* makeStorageCleanupWorker((trigger) =>
        Effect.gen(function* () {
          triggers.push(trigger);
          if (triggers.length === 1) {
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
          }
          return report(trigger);
        }),
      );
      yield* worker.requestSweep;
      yield* Deferred.await(started);
      yield* worker.requestSweep;
      const cancelled = yield* worker.runNow.pipe(Effect.forkChild({ startImmediately: true }));
      const survivor = yield* worker.runNow.pipe(Effect.forkChild({ startImmediately: true }));
      yield* Fiber.interrupt(cancelled);
      for (let index = 0; index < 32; index++) yield* worker.requestSweep;
      yield* Deferred.succeed(release, undefined);
      expect((yield* Fiber.join(survivor)).trigger).toBe("manual");
      yield* worker.drain;
      expect(triggers).toEqual(["automatic", "manual"]);
    }),
  ),
);
