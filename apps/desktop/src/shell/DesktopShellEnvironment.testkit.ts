import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as NodeOS from "node:os";
import { vi } from "vite-plus/test";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopShellEnvironment from "./DesktopShellEnvironment.ts";
const textEncoder = new TextEncoder();
export function envOutput(values: Readonly<Record<string, string>>): string {
  return Object.entries(values)
    .flatMap(([name, value]) => [`__GOAT_ENV_${name}_START__`, value, `__GOAT_ENV_${name}_END__`])
    .join("\n");
}

export function makeProcess(output: string, exitCode = 0): ChildProcessSpawner.ChildProcessHandle {
  const stdout = output.length === 0 ? Stream.empty : Stream.make(textEncoder.encode(output));
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout,
    stderr: Stream.empty,
    all: stdout,
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
}

/** Never answers. It counts as running until `exited` completes; without one it never exits. */
export function makeHungProcess(
  exited?: Deferred.Deferred<void>,
): ChildProcessSpawner.ChildProcessHandle {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(124),
    stdout: Stream.never,
    stderr: Stream.never,
    all: Stream.never,
    exitCode: exited
      ? Deferred.await(exited).pipe(Effect.as(ChildProcessSpawner.ExitCode(143)))
      : Effect.never,
    isRunning: exited ? Effect.map(Deferred.isDone(exited), (done) => !done) : Effect.succeed(true),
    kill: () => Effect.never,
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
}

function withProcessEnv<A, E, R>(
  env: NodeJS.ProcessEnv,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env;
      process.env = env;
      return previous;
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        process.env = previous;
      }),
  );
}

export function runShellEnvironment(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly userShell?: string;
  readonly stateDir?: string;
  readonly use?: (
    service: DesktopShellEnvironment.DesktopShellEnvironment["Service"],
  ) => Effect.Effect<boolean, never, import("effect/Scope").Scope>;
  readonly handler: (
    command: ChildProcess.Command,
  ) => string | { output: string; exitCode: number };
  readonly failure?: PlatformError.PlatformError;
  readonly processSpawner?: ChildProcessSpawner.ChildProcessSpawner["Service"];
  /** Completed when the service moves a finished cache file into place. */
  readonly cacheWritten?: Deferred.Deferred<void>;
}) {
  const layerEnvironment = Layer.effect(
    DesktopEnvironment.DesktopEnvironment,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = input.stateDir ?? (yield* fs.makeTempDirectoryScoped());
      return DesktopEnvironment.DesktopEnvironment.of({
        platform: input.platform,
        stateDir,
        homeDirectory: "/test-home",
      } as DesktopEnvironment.DesktopEnvironment["Service"]);
    }),
  ).pipe(Layer.provide(NodeServices.layer));
  const layerSpawner = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      if (input.processSpawner) return input.processSpawner.spawn(command);
      if (input.failure !== undefined) return Effect.fail(input.failure);
      const result = input.handler(command);
      return Effect.succeed(
        typeof result === "string"
          ? makeProcess(result)
          : makeProcess(result.output, result.exitCode),
      );
    }),
  );
  const { cacheWritten } = input;
  const layerFileSystem = Layer.effect(
    FileSystem.FileSystem,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      if (cacheWritten === undefined) return fs;
      return {
        ...fs,
        rename: (from: string, to: string) =>
          fs.rename(from, to).pipe(Effect.tap(() => Deferred.succeed(cacheWritten, undefined))),
      };
    }),
  ).pipe(Layer.provide(NodeServices.layer));

  const program = Effect.gen(function* () {
    const shellEnvironment = yield* DesktopShellEnvironment.DesktopShellEnvironment;
    if (input.use) return yield* input.use(shellEnvironment);
    const prepared = yield* shellEnvironment.awaitDiscovery;
    assert.equal(yield* shellEnvironment.awaitDiscovery, prepared);
    return prepared;
  }).pipe(
    Effect.provide(
      DesktopShellEnvironment.layer.pipe(
        Layer.provide(layerFileSystem),
        Layer.provide(Layer.mergeAll(layerEnvironment, NodeServices.layer, layerSpawner)),
      ),
    ),
  );

  return Effect.acquireUseRelease(
    Effect.sync(() =>
      vi.spyOn(NodeOS, "userInfo").mockReturnValue({
        ...NodeOS.userInfo(),
        shell: input.userShell ?? null,
      }),
    ),
    () => withProcessEnv(input.env, program),
    (spy) => Effect.sync(() => spy.mockRestore()),
  );
}
