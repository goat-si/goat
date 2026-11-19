// @effect-diagnostics nodeBuiltinImport:off -- Exercises real worker-backed pipe backpressure.
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { guardErrors } from "@goat/shared/errorGuards";
import * as SpawnWorker from "./SpawnWorker.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

it.live("bounds buffered stdin even when a producer ignores backpressure", () =>
  Effect.gen(function* () {
    const failed = Promise.withResolvers<Error>();
    const child = guardErrors(
      SpawnWorker.spawnPiped(
        process.execPath,
        ["-e", "process.stdin.pause(); setInterval(() => {}, 1000)"],
        {},
      ),
      failed.resolve,
    );
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        child.kill("SIGKILL");
      }),
    );
    const chunk = Buffer.alloc(1024 * 1024);
    for (let index = 0; index < 10; index++) child.stdin.write(chunk);
    expect(child.stdin.writableLength).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect((yield* Effect.promise(() => failed.promise)).message).toContain("limit");
  }).pipe(Effect.scoped),
);

it.live("rejects launches at capacity without stopping the existing child", () =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const first = yield* spawner.spawn(
      ChildProcess.make(process.execPath, [
        "-e",
        "process.stdout.write('ready'); process.stdin.resume()",
      ]),
    );
    yield* first.stdout.pipe(Stream.take(1), Stream.runDrain);
    const second = yield* spawner
      .spawn(ChildProcess.make(process.execPath, ["-e", "process.exit(0)"]))
      .pipe(Effect.result);
    expect(Result.isFailure(second)).toBe(true);
    expect(yield* first.isRunning).toBe(true);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      SpawnWorker.layerWithLimits({ workers: 1, childrenPerWorker: 1 }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
    Effect.provideService(HostProcess.Platform, "linux"),
  ),
);
