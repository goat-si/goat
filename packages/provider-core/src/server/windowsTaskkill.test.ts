import * as NodeChildProcess from "node:child_process";
import { expect, it, vi } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import { terminateWindowsTree, WindowsTaskkillError } from "./windowsTaskkill.ts";

it.effect("bounds a silent taskkill helper and permits a later tree request", () =>
  Effect.gen(function* () {
    const helper = new NodeChildProcess.ChildProcess();
    using kill = vi.spyOn(helper, "kill").mockReturnValue(true);
    const entered = Promise.withResolvers<void>();
    const done = yield* Deferred.make<void>();
    let callback: ((error: Error | null) => void) | undefined;
    using _exec = vi.spyOn(NodeChildProcess, "execFile").mockImplementation(((
      ...args: unknown[]
    ) => {
      const candidate = args.at(-1);
      if (typeof candidate === "function") callback = (error) => candidate(error, "", "");
      entered.resolve();
      return helper;
    }) as typeof NodeChildProcess.execFile);
    const pending = yield* terminateWindowsTree(4242).pipe(
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
      Effect.forkChild({ startImmediately: true }),
    );
    expect(callback).toBeDefined();
    callback?.(null);
    yield* Fiber.join(next);
  }),
);

it.effect("reports native taskkill failures without treating the tree as terminated", () =>
  Effect.gen(function* () {
    const helper = new NodeChildProcess.ChildProcess();
    using _kill = vi.spyOn(helper, "kill").mockReturnValue(true);
    const failure = new Error("taskkill exceeded its output buffer");
    using _exec = vi.spyOn(NodeChildProcess, "execFile").mockImplementation(((
      ...args: unknown[]
    ) => {
      const callback = args.at(-1);
      if (typeof callback === "function") callback(failure, "", "");
      return helper;
    }) as typeof NodeChildProcess.execFile);
    const error = yield* terminateWindowsTree(4242).pipe(Effect.flip);
    expect(error).toBeInstanceOf(WindowsTaskkillError);
    expect(error.pid).toBe(4242);
    expect(error.cause).toBe(failure);
  }),
);

it.effect("rejects invalid owned PIDs before starting taskkill", () =>
  Effect.gen(function* () {
    using exec = vi.spyOn(NodeChildProcess, "execFile");
    for (const pid of [0, 1, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      const error = yield* terminateWindowsTree(pid).pipe(Effect.flip);
      expect(error).toBeInstanceOf(WindowsTaskkillError);
    }
    expect(exec).not.toHaveBeenCalled();
  }),
);
