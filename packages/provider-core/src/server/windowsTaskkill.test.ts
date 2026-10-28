import { expect, it, vi } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import { TaskkillSpawner, terminateWindowsTree, WindowsTaskkillError } from "./windowsTaskkill.ts";

it.effect("bounds a silent taskkill helper and permits a later tree request", () =>
  Effect.gen(function* () {
    const kill = vi.fn(() => true);
    const helper = { exitCode: null, kill };
    const entered = Promise.withResolvers<void>();
    const done = yield* Deferred.make<void>();
    let callback: ((error: Error | null) => void) | undefined;
    const start = vi.fn((_pid: number, onExit: (error: Error | null) => void) => {
      callback = onExit;
      entered.resolve();
      return helper;
    });
    const pending = yield* terminateWindowsTree(4242).pipe(
      Effect.provideService(TaskkillSpawner, start),
      Effect.result,
      Effect.tap(() => Deferred.succeed(done, undefined)),
      Effect.forkChild,
    );
    yield* Effect.promise(() => entered.promise);
    yield* TestClock.adjust("5 seconds");
    expect(yield* Deferred.isDone(done)).toBe(true);
    const failed = yield* Fiber.join(pending);
    expect(failed._tag).toBe("Failure");
    if (failed._tag === "Failure") expect(failed.failure).toBeInstanceOf(WindowsTaskkillError);
    expect(kill).toHaveBeenCalledWith("SIGKILL");
    const next = yield* terminateWindowsTree(4243).pipe(
      Effect.provideService(TaskkillSpawner, start),
      Effect.forkChild({ startImmediately: true }),
    );
    expect(callback).toBeDefined();
    callback?.(null);
    yield* Fiber.join(next);
    expect(start.mock.calls.map(([pid]) => pid)).toEqual([4242, 4243]);
  }),
);

it.effect("reports native taskkill failures without treating the tree as terminated", () =>
  Effect.gen(function* () {
    const helper = { exitCode: null, kill: vi.fn(() => true) };
    const failure = new Error("taskkill exceeded its output buffer");
    const start = (_pid: number, onExit: (error: Error | null) => void) => {
      onExit(failure);
      return helper;
    };
    const error = yield* terminateWindowsTree(4242).pipe(
      Effect.provideService(TaskkillSpawner, start),
      Effect.flip,
    );
    expect(error).toBeInstanceOf(WindowsTaskkillError);
    expect(error.pid).toBe(4242);
    expect(error.cause).toBe(failure);
  }),
);

it.effect("rejects invalid owned PIDs before starting taskkill", () =>
  Effect.gen(function* () {
    const start = vi.fn(() => {
      throw new Error("Invalid PID reached native start.");
    });
    for (const pid of [0, 1, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      const error = yield* terminateWindowsTree(pid).pipe(
        Effect.provideService(TaskkillSpawner, start),
        Effect.flip,
      );
      expect(error).toBeInstanceOf(WindowsTaskkillError);
    }
    expect(start).not.toHaveBeenCalled();
  }),
);
