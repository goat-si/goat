import { sha256 } from "@noble/hashes/sha2";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as HostProcess from "./HostProcess.ts";
import * as RelayClient from "./relayClient.ts";

const windowsHost = HostProcess.Platform.defaultValue() === "win32";

const layerHostRuntime = (env: Record<string, string> = {}, platform: NodeJS.Platform = "linux") =>
  Layer.mergeAll(
    Layer.succeed(HostProcess.Platform, platform),
    Layer.succeed(HostProcess.Architecture, "x64"),
    Layer.succeed(HostProcess.Environment, env),
    ConfigProvider.layer(ConfigProvider.fromEnv({ env })),
  );

function makeHandle(exitCode = 0, output = "") {
  const stdout = output ? Stream.make(new TextEncoder().encode(output)) : Stream.empty;
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(100),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout,
    stderr: Stream.empty,
    all: stdout,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

const layerHttpClient = (bytes: Uint8Array) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(bytes.buffer as ArrayBuffer)),
      ),
    ),
  );

const layerSpawner = (versions: Record<string, string> = {}) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        if (!ChildProcess.isStandardCommand(command)) return makeHandle();
        if (command.args[0] === "version") {
          const version = versions[command.command] ?? RelayClient.CLOUDFLARED_VERSION;
          return makeHandle(0, `cloudflared version ${version} (built 2026-01-01-00:00 UTC)\n`);
        }
        return makeHandle();
      }),
    ),
  );

const writeExecutable = (filePath: string, contents = "cloudflared") =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.makeDirectory(filePath.slice(0, filePath.lastIndexOf("/")), {
      recursive: true,
    });
    yield* fileSystem.writeFileString(filePath, contents);
    yield* fileSystem.chmod(filePath, 0o755);
  });

const testBinary = new TextEncoder().encode("test-cloudflared-binary");
const testReleaseAsset = {
  url: "https://example.test/cloudflared",
  sha256: Hex.encode(sha256(testBinary)),
  archive: "binary",
} as const;

describe("RelayClient edge cases", () => {
  it.effect.skipIf(windowsHost)(
    "removes a staged client whose rename lands after cancellation",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const scope = yield* Effect.scope;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "goat-cloudflared-test-",
        });
        const directory = `${baseDir}/tools/cloudflared/${RelayClient.CLOUDFLARED_VERSION}/linux-x64`;
        const renamePending = yield* Deferred.make<void>();
        const allowRename = yield* Deferred.make<void>();
        const renameFinished = yield* Deferred.make<void, PlatformError.PlatformError>();
        const manager = yield* RelayClient.makeCloudflaredRelayClient({
          baseDir,
          releaseAsset: testReleaseAsset,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fileSystem,
            // Like Node's rename, the staging rename completes even if its caller is interrupted.
            rename: (from, to) =>
              to.endsWith(".tmp")
                ? Effect.forkIn(
                    Deferred.complete(
                      renameFinished,
                      Deferred.await(allowRename).pipe(Effect.andThen(fileSystem.rename(from, to))),
                    ),
                    scope,
                  ).pipe(
                    Effect.andThen(Deferred.succeed(renamePending, undefined)),
                    Effect.andThen(Deferred.await(renameFinished)),
                  )
                : fileSystem.rename(from, to),
            // Land the rename before the install temp directory is removed.
            remove: (path, options) =>
              path.endsWith(".tmp")
                ? fileSystem
                    .remove(path, options)
                    .pipe(
                      Effect.andThen(Deferred.succeed(allowRename, undefined)),
                      Effect.andThen(Deferred.await(renameFinished)),
                    )
                : fileSystem.remove(path, options),
          }),
        );

        const installing = yield* manager.install.pipe(Effect.forkChild);
        yield* Deferred.await(renamePending);
        yield* Effect.yieldNow;
        const cancelling = yield* Fiber.interrupt(installing).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.yieldNow;
        yield* Deferred.succeed(allowRename, undefined);
        yield* Fiber.join(cancelling);
        yield* Deferred.await(renameFinished);

        expect(yield* fileSystem.readDirectory(directory)).toEqual([]);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            NodeCrypto.layer,
            layerHttpClient(testBinary),
            layerSpawner(),
            layerHostRuntime({ PATH: "" }, "linux"),
          ),
        ),
      ),
  );

  it.effect.skipIf(windowsHost)(
    "finds a PATH binary through an empty entry by its absolute path",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "goat-cloudflared-test-",
        });
        const cwd = `${baseDir}/work`;
        const inCwd = `${cwd}/cloudflared`;
        yield* writeExecutable(inCwd);
        const manager = yield* RelayClient.makeCloudflaredRelayClient({ baseDir });
        const resolveWith = (searchPath: string) => {
          const env = { PATH: searchPath };
          return manager.resolve.pipe(
            Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env })),
            Effect.provideService(HostProcess.Environment, env),
            Effect.provideService(HostProcess.WorkingDirectory, cwd),
          );
        };
        const found = {
          status: "available",
          executablePath: inCwd,
          source: "path",
          version: RelayClient.CLOUDFLARED_VERSION,
        };

        expect(yield* resolveWith(`:${baseDir}/missing`)).toEqual(found);
        expect(yield* resolveWith(`${baseDir}/missing:`)).toEqual(found);
        const missing = { status: "missing", version: RelayClient.CLOUDFLARED_VERSION };
        // An empty PATH searches nothing, not even the working directory.
        expect(yield* resolveWith("")).toEqual(missing);
        // A whitespace entry is not an empty one.
        expect(yield* resolveWith(` :${baseDir}/missing`)).toEqual(missing);
        expect(yield* resolveWith(`${baseDir}/missing: `)).toEqual(missing);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            NodeCrypto.layer,
            layerHttpClient(new Uint8Array()),
            layerSpawner(),
            layerHostRuntime({ PATH: "" }),
          ),
        ),
      ),
  );
});
