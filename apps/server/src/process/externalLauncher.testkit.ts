import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as HostProcess from "@goat/shared/HostProcess";
import { SpawnExecutableResolution } from "@goat/shared/shell";
import * as ExternalLauncher from "./externalLauncher.ts";

// Windows drive letters break mocked POSIX PATH splitting; these tests also require /bin/sh stubs.
export const windowsHost = HostProcess.Platform.defaultValue() === "win32";

export interface MockSpawnResult {
  readonly spawnError?: PlatformError.PlatformError;
  readonly exitCode?: number;
  readonly stdout?: string;
  readonly stall?: boolean;
}

export function makeMockDetachedHandle(
  input: MockSpawnResult & { readonly onUnref?: () => void } = {},
) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: input.stall
      ? Effect.never
      : Effect.succeed(ChildProcessSpawner.ExitCode(input.exitCode ?? 0)),
    isRunning: Effect.succeed(true),
    kill: () => Effect.void,
    unref: Effect.sync(() => {
      input.onUnref?.();
      return Effect.void;
    }),
    stdin: Sink.drain,
    stdout:
      input.stdout === undefined
        ? Stream.empty
        : Stream.make(new TextEncoder().encode(input.stdout)),
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

export const layerTest = (input: {
  readonly platform: NodeJS.Platform;
  readonly env?: Record<string, string>;
  readonly path?: Path.Path;
  readonly resolveExecutable?: (command: string) => string | undefined;
  readonly onSpawn?: (command: ChildProcess.StandardCommand) => void;
  readonly onUnref?: () => void;
  readonly spawnResult?: (command: ChildProcess.StandardCommand) => MockSpawnResult | undefined;
}) => {
  const layerSpawner = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        assert.equal(ChildProcess.isStandardCommand(command), true);
        if (!ChildProcess.isStandardCommand(command)) {
          throw new Error("Expected a standard command");
        }
        input.onSpawn?.(command);
        const result = input.spawnResult?.(command);
        if (result?.spawnError) return yield* result.spawnError;
        return makeMockDetachedHandle({
          ...(input.onUnref === undefined ? {} : { onUnref: input.onUnref }),
          ...result,
        });
      }),
    ),
  );

  return Layer.mergeAll(
    ExternalLauncher.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          NodeServices.layer,
          layerSpawner,
          input.path ? Layer.succeed(Path.Path, input.path) : Layer.empty,
        ),
      ),
    ),
    Layer.succeed(HostProcess.Platform, input.platform),
    Layer.succeed(
      SpawnExecutableResolution,
      (command) => input.resolveExecutable?.(command) ?? command,
    ),
    ConfigProvider.layer(ConfigProvider.fromEnv({ env: input.env ?? {} })),
  );
};
