// @effect-diagnostics nodeBuiltinImport:off -- Checks the thread owning a real child process.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as NonBlockingSpawner from "./NonBlockingSpawner.ts";

const support = vi.hoisted(() => ({ available: false }));
vi.mock("@goat/shared/envTrampoline", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@goat/shared/envTrampoline")>()),
  supportsEnvChdir: () => Promise.resolve(support.available),
}));

it.live("uses a worker on Linux when GNU env -C is unavailable", () => {
  support.available = false;
  return Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(process.execPath, [
        "-e",
        "process.stdout.write('ready'); process.stdin.resume()",
      ]),
    );
    expect(yield* child.stdout.pipe(Stream.take(1), Stream.decodeText(), Stream.mkString)).toBe(
      "ready",
    );
    expect(process.getActiveResourcesInfo()).not.toContain("ProcessWrap");
  }).pipe(
    Effect.scoped,
    Effect.provide(NonBlockingSpawner.layer.pipe(Layer.provideMerge(NodeServices.layer))),
    Effect.provideService(HostProcess.Platform, "linux"),
  );
});

it.live("keeps the env trampoline on Linux when it is available", () => {
  support.available = true;
  return Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(process.execPath, [
        "-e",
        "process.stdout.write('ready'); process.stdin.resume()",
      ]),
    );
    expect(yield* child.stdout.pipe(Stream.take(1), Stream.decodeText(), Stream.mkString)).toBe(
      "ready",
    );
    expect(process.getActiveResourcesInfo()).toContain("ProcessWrap");
  }).pipe(
    Effect.scoped,
    Effect.provide(NonBlockingSpawner.layer.pipe(Layer.provideMerge(NodeServices.layer))),
    Effect.provideService(HostProcess.Platform, "linux"),
  );
});
