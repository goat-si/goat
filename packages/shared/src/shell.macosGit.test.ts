// @effect-diagnostics nodeBuiltinImport:off -- Native probes are mocked without spawning processes.
import * as NodeChildProcess from "node:child_process";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { expect, vi } from "vite-plus/test";

import * as HostProcess from "./HostProcess.ts";
import { CommandResolutionCache, resolveSpawnCommand, SpawnExecutableResolution } from "./shell.ts";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
}));

const XCODE_GIT = "/fixture/xcode-git";
const SYNC_GIT = "/fixture/sync-git";

function setup() {
  const probes: Array<{
    readonly complete: (output: string) => void;
    readonly kill: ReturnType<typeof vi.spyOn<NodeChildProcess.ChildProcess, "kill">>;
  }> = [];
  const sync = vi.spyOn(NodeChildProcess, "execFileSync").mockReturnValue(`${SYNC_GIT}\n`);
  const asyncProbe = vi.spyOn(NodeChildProcess, "execFile").mockImplementation(((
    ...args: unknown[]
  ) => {
    const child = new NodeChildProcess.ChildProcess();
    const kill = vi.spyOn(child, "kill").mockReturnValue(true);
    const callback = args.at(-1);
    probes.push({
      complete: (output) => {
        if (typeof callback === "function") callback(null, output, "");
      },
      kill,
    });
    return child;
  }) as typeof NodeChildProcess.execFile);
  const resolve = resolveSpawnCommand("git", [], { env: { PATH: "/fixture" } }).pipe(
    Effect.provideService(HostProcess.Platform, "darwin"),
    Effect.provideService(SpawnExecutableResolution, (command) =>
      command === "git"
        ? "/usr/bin/git"
        : command === XCODE_GIT || command === SYNC_GIT
          ? command
          : undefined,
    ),
  );
  return {
    probes,
    resolve,
    asyncProbe,
    [Symbol.dispose]() {
      for (const probe of probes) probe.kill.mockRestore();
      asyncProbe.mockRestore();
      sync.mockRestore();
    },
  };
}

it.effect("keeps command resolution pending while async xcrun is running", () =>
  Effect.gen(function* () {
    using native = setup();
    const done = yield* Deferred.make<void>();
    const fiber = yield* native.resolve.pipe(
      Effect.tap(() => Deferred.succeed(done, undefined)),
      Effect.forkChild({ startImmediately: true }),
    );
    try {
      yield* TestClock.adjust("1 second");
      expect(yield* Deferred.isDone(done)).toBe(false);
      yield* TestClock.adjust("4 seconds");
      expect((yield* Fiber.join(fiber)).command).toBe("git");
      expect(native.probes).toHaveLength(1);
      expect(native.probes[0]?.kill).toHaveBeenCalledWith("SIGKILL");
    } finally {
      yield* Fiber.interrupt(fiber);
    }
  }).pipe(Effect.provideService(CommandResolutionCache, new Map())),
);

it.effect("shares concurrent xcrun lookups and starts the cache TTL after completion", () =>
  Effect.gen(function* () {
    using native = setup();
    const first = yield* Effect.forkChild(native.resolve, { startImmediately: true });
    const second = yield* Effect.forkChild(native.resolve, { startImmediately: true });
    try {
      expect(native.probes).toHaveLength(1);
      yield* TestClock.adjust("4 seconds");
      native.probes[0]?.complete(`${XCODE_GIT}\n`);
      expect((yield* Fiber.join(first)).command).toBe(XCODE_GIT);
      expect((yield* Fiber.join(second)).command).toBe(XCODE_GIT);
      expect(native.probes).toHaveLength(1);
      yield* TestClock.adjust("29 seconds");
      expect((yield* native.resolve).command).toBe(XCODE_GIT);
      expect(native.probes).toHaveLength(1);
      yield* TestClock.adjust("1 second");
      const expired = yield* Effect.forkChild(native.resolve, { startImmediately: true });
      try {
        expect(native.probes).toHaveLength(2);
        native.probes[1]?.complete(`${XCODE_GIT}\n`);
        expect((yield* Fiber.join(expired)).command).toBe(XCODE_GIT);
      } finally {
        yield* Fiber.interrupt(expired);
      }
    } finally {
      yield* Fiber.interrupt(first);
      yield* Fiber.interrupt(second);
    }
  }).pipe(Effect.provideService(CommandResolutionCache, new Map())),
);

it.effect("cancels the captured xcrun child and permits the next lookup", () =>
  Effect.gen(function* () {
    using native = setup();
    const first = yield* Effect.forkChild(native.resolve, { startImmediately: true });
    yield* Fiber.interrupt(first);
    expect(native.probes).toHaveLength(1);
    expect(native.probes[0]?.kill).toHaveBeenCalledWith("SIGKILL");
    const next = yield* Effect.forkChild(native.resolve, { startImmediately: true });
    try {
      expect(native.probes).toHaveLength(2);
      native.probes[1]?.complete(`${XCODE_GIT}\n`);
      expect((yield* Fiber.join(next)).command).toBe(XCODE_GIT);
    } finally {
      yield* Fiber.interrupt(next);
    }
  }).pipe(Effect.provideService(CommandResolutionCache, new Map())),
);

it.effect("keeps git when starting the xcrun probe throws", () =>
  Effect.gen(function* () {
    using native = setup();
    native.asyncProbe.mockImplementation(() => {
      throw new Error("Unable to spawn xcrun");
    });
    expect((yield* native.resolve).command).toBe("git");
  }).pipe(Effect.provideService(CommandResolutionCache, new Map())),
);
