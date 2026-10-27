import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeStream from "node:stream";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";
import { defaultWindowsGitBash } from "./sshRuntimeGitBash.ts";

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ChildProcess: original.ChildProcess,
    spawn: vi.fn(),
    execFile: vi.fn(),
  };
});

it.effect("registry timeout falls back and cancels only its captured helper", () =>
  Effect.gen(function* () {
    const started = Promise.withResolvers<void>();
    const child = new NodeChildProcess.ChildProcess();
    Object.defineProperty(child, "stdout", { value: new NodeStream.PassThrough() });
    using kill = vi.spyOn(child, "kill").mockReturnValue(true);
    const spawn = () => {
      started.resolve();
      return child;
    };
    vi.mocked(NodeChildProcess.spawn).mockReset().mockImplementation(spawn);
    vi.mocked(NodeChildProcess.execFile).mockReset().mockImplementation(spawn);
    using _exists = vi.spyOn(NodeFS.promises, "access").mockResolvedValue(undefined);
    vi.stubEnv("ProgramFiles", "C:\\Fixture");
    const pending = yield* defaultWindowsGitBash().pipe(Effect.forkChild);
    try {
      yield* Effect.promise(() => started.promise);
      yield* TestClock.adjust("5 seconds");
      expect(kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
      expect(yield* Fiber.join(pending)).toBe("C:\\Fixture\\Git\\bin\\bash.exe");
    } finally {
      yield* Fiber.interrupt(pending);
      vi.unstubAllEnvs();
    }
  }),
);
