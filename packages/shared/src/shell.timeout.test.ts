import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { expect, vi } from "vite-plus/test";
import { readEnvironmentFromWindowsShell } from "./shell.ts";

const probe = vi.hoisted(() => ({
  execFile: vi.fn<typeof import("node:child_process").execFile>(),
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: probe.execFile,
}));

it.effect("abandons a shell that survives the kill and holds stdout open", () =>
  Effect.gen(function* () {
    const started = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const stdout = { destroy: vi.fn() };
    const unref = vi.fn();
    const child = { kill: vi.fn(() => true), stdout, unref } as unknown as ReturnType<
      typeof import("node:child_process").execFile
    >;
    let count = 0;
    probe.execFile.mockImplementation(() => {
      started[count++]?.resolve();
      return child;
    });
    const fiber = yield* readEnvironmentFromWindowsShell(["PATH"]).pipe(Effect.forkChild);
    yield* Effect.promise(() => started[0]!.promise);
    yield* TestClock.adjust("6 seconds");
    yield* Effect.promise(() => started[1]!.promise);
    yield* TestClock.adjust("6 seconds");
    expect(yield* Fiber.join(fiber)).toEqual({});
    expect(stdout.destroy).toHaveBeenCalledTimes(2);
    expect(unref).toHaveBeenCalledTimes(2);
  }),
);
