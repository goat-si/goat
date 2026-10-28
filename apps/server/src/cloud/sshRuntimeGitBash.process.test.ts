import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";
import { defaultWindowsGitBash } from "./sshRuntimeGitBash.ts";

const nativeMocks = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn(), access: vi.fn() }));

vi.mock("node:child_process", () => ({
  spawn: nativeMocks.spawn,
  execFile: nativeMocks.execFile,
}));
vi.mock("node:fs", () => ({ promises: { access: nativeMocks.access } }));

function setup() {
  const started = Promise.withResolvers<void>();
  const child = {
    exitCode: null,
    stdout: { on: vi.fn() },
    once: vi.fn(),
    kill: vi.fn(() => true),
  };
  const spawn = () => {
    started.resolve();
    return child;
  };
  nativeMocks.spawn.mockReset().mockImplementation(spawn);
  nativeMocks.execFile.mockReset().mockImplementation(spawn);
  nativeMocks.access.mockReset().mockResolvedValue(undefined);
  return { child, started: Effect.promise(() => started.promise) };
}

it.effect("registry timeout falls back and cancels only its captured helper", () =>
  Effect.gen(function* () {
    const { child, started } = setup();
    vi.stubEnv("ProgramFiles", "C:\\Fixture");
    const pending = yield* defaultWindowsGitBash().pipe(Effect.forkChild);
    try {
      yield* started;
      yield* TestClock.adjust("5 seconds");
      expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
      expect(yield* Fiber.join(pending)).toBe("C:\\Fixture\\Git\\bin\\bash.exe");
    } finally {
      yield* Fiber.interrupt(pending);
      vi.unstubAllEnvs();
    }
  }),
);
