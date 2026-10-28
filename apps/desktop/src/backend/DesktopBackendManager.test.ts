import {
  SERVER_EXIT_CODE_DATABASE_AHEAD,
  SERVER_EXIT_CODE_STATE_DIR_OWNED,
  DesktopBackendBootstrap,
  type DesktopBackendBootstrap as DesktopBackendBootstrapValue,
  DesktopTelemetryControlMessage,
} from "@goat/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as DesktopBackendManager from "./DesktopBackendManager.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopTelemetryPublisher from "../telemetry/DesktopTelemetryPublisher.ts";
import * as DesktopBrowserHost from "../preview/DesktopBrowserHost.ts";
import * as DesktopWslEnvironment from "../wsl/DesktopWslEnvironment.ts";

const decodeDesktopBackendBootstrap = Schema.decodeEffect(
  Schema.fromJsonString(DesktopBackendBootstrap),
);
const encodeDesktopTelemetryControl = Schema.encodeSync(
  Schema.fromJsonString(DesktopTelemetryControlMessage),
);

const baseConfig: DesktopBackendManager.DesktopBackendStartConfig = {
  executablePath: "/electron",
  args: ["/server/bin.mjs", "--bootstrap-fd", "3"],
  entryPath: "/server/bin.mjs",
  cwd: "/server",
  env: { ELECTRON_RUN_AS_NODE: "1" },
  bootstrap: {
    mode: "desktop",
    noBrowser: true,
    port: 3773,
    goatHome: "/tmp/t3",
    host: "127.0.0.1",
    desktopBootstrapToken: "token",
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
    desktopTelemetryFd: 4,
    desktopTelemetryControlFd: 5,
  },
  bootstrapDelivery: "fd3",
  extendEnv: true,
  httpBaseUrl: new URL("http://127.0.0.1:3773"),
  captureOutput: true,
  preflightFailure: Option.none(),
};

const configWithObservability: DesktopBackendBootstrapValue = {
  ...baseConfig.bootstrap,
  tailscaleServeEnabled: true,
  desktopTelemetryFd: 4,
  otlpTracesUrl: "http://127.0.0.1:4318/v1/traces",
};

function makeProcess(options?: {
  readonly stdout?: Stream.Stream<Uint8Array, PlatformError.PlatformError>;
  readonly stderr?: Stream.Stream<Uint8Array, PlatformError.PlatformError>;
  readonly exitCode?: Effect.Effect<ChildProcessSpawner.ExitCode, PlatformError.PlatformError>;
  readonly kill?: ChildProcessSpawner.ChildProcessHandle["kill"];
  readonly getOutputFd?: ChildProcessSpawner.ChildProcessHandle["getOutputFd"];
}): ChildProcessSpawner.ChildProcessHandle {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: options?.stdout ?? Stream.empty,
    stderr: options?.stderr ?? Stream.empty,
    all: Stream.merge(options?.stdout ?? Stream.empty, options?.stderr ?? Stream.empty),
    exitCode: options?.exitCode ?? Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: options?.kill ?? (() => Effect.void),
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: options?.getOutputFd ?? (() => Stream.empty),
    unref: Effect.succeed(Effect.void),
  });
}

function layerHttpClient(
  handler: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse>,
) {
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => handler(request)),
  );
}

const layerHealthyHttpClient = layerHttpClient((request) =>
  Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 200 }))),
);

function decodeBootstrap(raw: string) {
  return decodeDesktopBackendBootstrap(raw);
}

interface MakeInstanceInput {
  readonly fileSystem?: Partial<FileSystem.FileSystem>;
  readonly onRecoveryPaused?: DesktopBackendManager.BackendInstanceSpec["onRecoveryPaused"];
  readonly spawnerLayer: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>;
  readonly httpClientLayer?: Layer.Layer<HttpClient.HttpClient>;
  readonly backendOutputLog?: Partial<DesktopObservability.DesktopBackendOutputLogShape>;
  readonly onStartupFailure?: (
    failure: DesktopBackendManager.BackendStartupFailure,
  ) => Effect.Effect<void>;
  readonly onReady?: Effect.Effect<void>;
  readonly onShutdown?: Effect.Effect<void>;
  readonly onStateDirOwned?: Effect.Effect<void>;
  readonly onDatabaseAhead?: Effect.Effect<void>;
  readonly onPreflightFailed?: (
    failure: DesktopBackendManager.PreflightFailure,
  ) => Effect.Effect<boolean>;
  readonly config?: DesktopBackendManager.DesktopBackendStartConfig;
  readonly configResolve?: Effect.Effect<
    DesktopBackendManager.DesktopBackendStartConfig,
    PlatformError.PlatformError
  >;
  readonly desktopTelemetryStream?: Stream.Stream<Uint8Array>;
  readonly desktopTelemetryPublisher?: Partial<
    DesktopTelemetryPublisher.DesktopTelemetryPublisher["Service"]
  >;
  readonly pruneRuntimes?: (distro: string | null, runtimeId: string) => Effect.Effect<void>;
}

function makeTestInstance(input: MakeInstanceInput) {
  const stubLog: DesktopObservability.DesktopBackendOutputLogShape = {
    beginSession: () => Effect.void,
    writeOutputChunk: () => Effect.void,
    persistFailureSnapshot: () => Effect.void,
    persistFailure: () => Effect.void,
    discardSession: Effect.void,
    ...input.backendOutputLog,
  };
  const layerServices = Layer.mergeAll(
    FileSystem.layerNoop({
      exists: () => Effect.succeed(true),
      ...input.fileSystem,
    }),
    input.spawnerLayer,
    input.httpClientLayer ?? layerHealthyHttpClient,
    Layer.succeed(DesktopObservability.DesktopBackendOutputLogFactory, {
      forInstance: () => Effect.succeed(stubLog),
    } satisfies DesktopObservability.DesktopBackendOutputLogFactory["Service"]),
    Layer.succeed(DesktopTelemetryPublisher.DesktopTelemetryPublisher, {
      latest: Effect.succeedNone,
      changes: Stream.empty,
      encoded: input.desktopTelemetryStream ?? Stream.empty,
      encodedForSource: () => input.desktopTelemetryStream ?? Stream.empty,
      cuaAppsRequests: Stream.empty,
      takeCuaAppsRequests: Effect.succeed({ requestIds: [], publish: () => Effect.void }),
      cuaRequests: Stream.empty,
      cuaWatch: Stream.empty,
      cuaWatchApps: Stream.empty,
      publishCuaReport: () => Effect.void,
      publishCuaReadiness: () => Effect.void,
      publishCuaSafety: () => Effect.void,
      cuaFrames: Stream.empty,
      publishCuaFrame: () => Effect.void,
      handleControlForSource: () => Effect.void,
      removeControlSource: () => Effect.void,
      publishUpdateReport: () => Effect.void,
      updateRequests: Stream.empty,
      updateCommits: Stream.empty,
      updateCancellations: Stream.empty,
      ...input.desktopTelemetryPublisher,
    }),
    DesktopBrowserHost.layer,
    DesktopWslEnvironment.layerTest(
      input.pruneRuntimes === undefined ? {} : { pruneRuntimes: input.pruneRuntimes },
    ),
  );

  const instance = DesktopBackendManager.makeBackendInstance({
    id: DesktopBackendManager.PRIMARY_INSTANCE_ID,
    label: Effect.succeed("Windows"),
    ...(input.onRecoveryPaused ? { onRecoveryPaused: input.onRecoveryPaused } : {}),
    configResolve: input.configResolve ?? Effect.succeed(input.config ?? baseConfig),
    ...(input.onStartupFailure ? { onStartupFailure: input.onStartupFailure } : {}),
    ...(input.onReady ? { onReady: () => input.onReady! } : {}),
    ...(input.onShutdown ? { onShutdown: () => input.onShutdown! } : {}),
    ...(input.onStateDirOwned ? { onStateDirOwned: () => input.onStateDirOwned! } : {}),
    ...(input.onDatabaseAhead ? { onDatabaseAhead: () => input.onDatabaseAhead! } : {}),
    ...(input.onPreflightFailed ? { onPreflightFailed: input.onPreflightFailed } : {}),
  });

  return instance.pipe(Effect.provide(layerServices));
}

describe("DesktopBackendManager", () => {
  it.effect("spawns the backend with fd3 bootstrap and fd4 telemetry", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let spawnedCommand: ChildProcess.Command | undefined;
        let bootstrapJson = "";
        let telemetryJson = "";
        let readyCount = 0;
        const ready = yield* Deferred.make<void>();
        const exited = yield* Queue.unbounded<void>();

        const layerSpawner = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) =>
            Effect.gen(function* () {
              spawnedCommand = command;
              if (command._tag === "StandardCommand") {
                const fd3 = command.options.additionalFds?.fd3;
                if (fd3?.type === "input" && fd3.stream) {
                  bootstrapJson = yield* fd3.stream.pipe(Stream.decodeText(), Stream.mkString);
                }
                const fd4 = command.options.additionalFds?.fd4;
                if (fd4?.type === "input" && fd4.stream) {
                  telemetryJson = yield* fd4.stream.pipe(Stream.decodeText(), Stream.mkString);
                }
              }

              return makeProcess({
                exitCode: Deferred.await(ready).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
              });
            }),
          ),
        );

        const instance = yield* makeTestInstance({
          config: {
            ...baseConfig,
            bootstrap: configWithObservability,
          },
          spawnerLayer: layerSpawner,
          desktopTelemetryStream: Stream.encodeText(
            Stream.make('{"version":1,"type":"desktopTelemetryHello","electronPid":123}\n'),
          ),
          onReady: Effect.sync(() => {
            readyCount += 1;
          }).pipe(Effect.andThen(Deferred.succeed(ready, void 0)), Effect.asVoid),
          backendOutputLog: {
            persistFailure: () => Queue.offer(exited, void 0).pipe(Effect.asVoid),
          },
        });

        yield* instance.start;
        yield* Queue.take(exited);

        assert.equal(readyCount, 1);
        assert.isDefined(spawnedCommand);
        if (spawnedCommand._tag !== "StandardCommand") {
          throw new Error("Expected backend to spawn a standard command.");
        }

        assert.equal(spawnedCommand.command, "/electron");
        assert.deepEqual(spawnedCommand.args, ["/server/bin.mjs", "--bootstrap-fd", "3"]);
        assert.equal(spawnedCommand.options.cwd, "/server");
        assert.equal(spawnedCommand.options.extendEnv, true);
        assert.equal(spawnedCommand.options.stdout, "pipe");
        assert.equal(spawnedCommand.options.stderr, "pipe");
        assert.equal(spawnedCommand.options.killSignal, "SIGTERM");
        assert.isDefined(spawnedCommand.options.forceKillAfter);
        assert.equal(spawnedCommand.options.additionalFds?.fd4?.type, "input");
        assert.equal(spawnedCommand.options.additionalFds?.fd5?.type, "output");
        assert.equal(
          Duration.toMillis(Duration.fromInputUnsafe(spawnedCommand.options.forceKillAfter)),
          5_000,
        );

        assert.deepEqual(yield* decodeBootstrap(bootstrapJson), configWithObservability);
        assert.equal(
          telemetryJson,
          '{"version":1,"type":"desktopTelemetryHello","electronPid":123}\n',
        );
      }),
    ),
  );

  it.effect("reports a SIGKILL exit without an exit code", () =>
    Effect.gen(function* () {
      const exitCause = PlatformError.systemError({
        _tag: "Unknown",
        module: "ChildProcess",
        method: "exitCode",
        cause: new Error("Process interrupted due to receipt of signal: 'SIGKILL'"),
      });
      const layerSpawner = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.succeed(makeProcess({ exitCode: Effect.fail(exitCause) })),
        ),
      );

      const exit = yield* DesktopBackendManager.runBackendProcess({
        ...baseConfig,
        desktopTelemetryStream: Stream.empty,
      }).pipe(Effect.scoped, Effect.provide(Layer.merge(layerSpawner, layerHealthyHttpClient)));

      assert.deepEqual(exit, { code: Option.none(), reason: "killed by SIGKILL" });
    }),
  );

  it.effect("reports child exit before waiting for trailing output to drain", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const exitObserved = yield* Deferred.make<void>();
        const finishOutputDrain = yield* Deferred.make<void>();
        const layerSpawner = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.succeed(
              makeProcess({
                stdout: Stream.fromEffect(
                  Deferred.await(finishOutputDrain).pipe(
                    Effect.as(new TextEncoder().encode("trailing output\n")),
                  ),
                ),
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
              }),
            ),
          ),
        );

        const runFiber = yield* DesktopBackendManager.runBackendProcess({
          ...baseConfig,
          desktopTelemetryStream: Stream.empty,
          onExitObserved: () => Deferred.succeed(exitObserved, void 0).pipe(Effect.asVoid),
        }).pipe(
          Effect.provide(Layer.merge(layerSpawner, layerHealthyHttpClient)),
          Effect.forkChild,
        );

        yield* Deferred.await(exitObserved);
        assert.isUndefined(runFiber.pollUnsafe());

        yield* Deferred.succeed(finishOutputDrain, void 0);
        assert.equal((yield* Fiber.join(runFiber)).code.pipe(Option.getOrUndefined), 1);
      }),
    ),
  );

  it.effect("continues routing desktop telemetry control messages after an invalid line", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const handled = yield* Deferred.make<boolean>();
        const controlMessage = encodeDesktopTelemetryControl({
          version: 1,
          type: "setDiagnosticsDemand",
          enabled: true,
        });
        const layerSpawner = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.succeed(
              makeProcess({
                getOutputFd: (fd) =>
                  fd === 5
                    ? Stream.encodeText(
                        Stream.make(
                          `not-json\n{"version":1,"type":"futureControl"}\n${controlMessage}\n`,
                        ),
                      )
                    : Stream.empty,
                exitCode: Deferred.await(handled).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
              }),
            ),
          ),
        );
        const instance = yield* makeTestInstance({
          spawnerLayer: layerSpawner,
          desktopTelemetryPublisher: {
            handleControlForSource: (_sourceId, message) =>
              message.type === "setDiagnosticsDemand"
                ? Deferred.succeed(handled, message.enabled).pipe(Effect.asVoid)
                : Effect.void,
          },
        });

        yield* instance.start;
        assert.isTrue(yield* Deferred.await(handled));
      }),
    ),
  );

  it.effect("starts the configured backend and closes the scoped process on stop", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let startCount = 0;
        let closedCount = 0;
        const closed = yield* Deferred.make<void>();
        const teardownStarted = yield* Deferred.make<void>();
        const finishTeardown = yield* Deferred.make<void>();
        const startedPids = yield* Queue.unbounded<number>();
        const ready = yield* Deferred.make<void>();
        const backendReadyFlag = yield* Ref.make(false);
        let shutdownCount = 0;
        let persistedFailureCount = 0;
        let discardedSessionCount = 0;
        let removedTelemetrySources = 0;

        const layerSpawner = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.gen(function* () {
              const scope = yield* Scope.Scope;
              startCount += 1;
              yield* Queue.offer(startedPids, 123);
              const close = Deferred.succeed(teardownStarted, undefined).pipe(
                Effect.andThen(Deferred.await(finishTeardown)),
                Effect.andThen(
                  Effect.sync(() => {
                    closedCount += 1;
                  }),
                ),
                Effect.andThen(Deferred.succeed(closed, void 0)),
                Effect.asVoid,
              );

              yield* Scope.addFinalizer(scope, close);

              return makeProcess({
                exitCode: Deferred.await(closed).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
                kill: () => close,
              });
            }),
          ),
        );

        const instance = yield* makeTestInstance({
          spawnerLayer: layerSpawner,
          onReady: Ref.set(backendReadyFlag, true).pipe(
            Effect.andThen(Deferred.succeed(ready, void 0)),
            Effect.asVoid,
          ),
          onShutdown: Ref.set(backendReadyFlag, false).pipe(
            Effect.andThen(
              Effect.sync(() => {
                shutdownCount += 1;
              }),
            ),
          ),
          backendOutputLog: {
            persistFailure: () =>
              Effect.sync(() => {
                persistedFailureCount += 1;
              }),
            discardSession: Effect.sync(() => {
              discardedSessionCount += 1;
            }),
          },
          desktopTelemetryPublisher: {
            removeControlSource: () =>
              Effect.sync(() => {
                removedTelemetrySources += 1;
              }),
          },
        });
        assert.isTrue(Option.isNone(yield* instance.currentConfig));

        yield* instance.start;
        assert.equal(yield* Queue.take(startedPids), 123);
        yield* Deferred.await(ready);
        assert.isTrue(yield* Ref.get(backendReadyFlag));
        assert.deepEqual(yield* instance.currentConfig, Option.some(baseConfig));

        const runningSnapshot = yield* instance.snapshot;
        assert.equal(runningSnapshot.ready, true);
        assert.deepEqual(runningSnapshot.activePid, Option.some(123));

        const stopFiber = yield* instance.stop().pipe(Effect.forkChild);
        yield* Deferred.await(teardownStarted).pipe(Effect.timeout("1 second"));
        assert.isFalse(yield* Ref.get(backendReadyFlag));
        assert.equal(shutdownCount, 1);
        yield* Deferred.succeed(finishTeardown, undefined);
        yield* Fiber.join(stopFiber).pipe(Effect.timeout("1 second"));
        assert.equal(startCount, 1);
        assert.equal(closedCount, 1);
        assert.equal(persistedFailureCount, 0);
        assert.equal(discardedSessionCount, 1);
        assert.equal(removedTelemetrySources, 1);

        const stoppedSnapshot = yield* instance.snapshot;
        assert.isFalse(yield* Ref.get(backendReadyFlag));
        assert.equal(shutdownCount, 1);
        assert.equal(stoppedSnapshot.desiredRunning, false);
        assert.equal(stoppedSnapshot.ready, false);
        assert.equal(Option.isNone(stoppedSnapshot.activePid), true);
      }),
    ),
  );

  it.effect("restarts when start is requested during stop teardown", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const starts = yield* Queue.unbounded<number>();
        const teardownStarted = yield* Deferred.make<void>();
        const finishTeardown = yield* Deferred.make<void>();
        let startCount = 0;

        const layerSpawner = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.gen(function* () {
              const scope = yield* Scope.Scope;
              const closed = yield* Deferred.make<void>();
              startCount += 1;
              yield* Queue.offer(starts, startCount);
              if (startCount === 1) {
                yield* Scope.addFinalizer(
                  scope,
                  Deferred.succeed(teardownStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(finishTeardown)),
                    Effect.andThen(Deferred.succeed(closed, undefined)),
                    Effect.asVoid,
                  ),
                );
              } else {
                yield* Scope.addFinalizer(
                  scope,
                  Deferred.succeed(closed, undefined).pipe(Effect.asVoid),
                );
              }
              return makeProcess({
                exitCode: Deferred.await(closed).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
              });
            }),
          ),
        );

        const instance = yield* makeTestInstance({
          spawnerLayer: layerSpawner,
          httpClientLayer: layerHttpClient(() => Effect.never),
        });

        yield* instance.start;
        assert.equal(yield* Queue.take(starts), 1);

        const stopFiber = yield* instance.stop().pipe(Effect.forkChild);
        yield* Deferred.await(teardownStarted).pipe(Effect.timeout("1 second"));
        yield* instance.start;
        assert.equal((yield* instance.snapshot).desiredRunning, true);

        yield* Deferred.succeed(finishTeardown, undefined);
        yield* Fiber.join(stopFiber).pipe(Effect.timeout("1 second"));
        yield* TestClock.adjust(Duration.millis(1000));

        assert.equal(yield* Queue.take(starts).pipe(Effect.timeout("1 second")), 2);
        const restarted = yield* instance.snapshot;
        assert.equal(restarted.desiredRunning, true);
        assert.deepEqual(restarted.activePid, Option.some(123));
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.effect("reports state-directory ownership once without scheduling another backend", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let startCount = 0;
        const refused = yield* Deferred.make<void>();
        const instance = yield* makeTestInstance({
          spawnerLayer: Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() =>
              Effect.sync(() => {
                startCount += 1;
                return makeProcess({
                  exitCode: Effect.succeed(
                    ChildProcessSpawner.ExitCode(SERVER_EXIT_CODE_STATE_DIR_OWNED),
                  ),
                });
              }),
            ),
          ),
          httpClientLayer: layerHttpClient(() => Effect.never),
          onStateDirOwned: Deferred.succeed(refused, undefined).pipe(Effect.asVoid),
        });
        yield* instance.start;
        yield* Deferred.await(refused);
        const snapshot = yield* instance.snapshot;
        assert.isFalse(snapshot.desiredRunning);
        assert.isFalse(snapshot.restartScheduled);
        yield* TestClock.adjust(Duration.minutes(1));
        assert.equal(startCount, 1);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.effect("reports a newer-build database once without scheduling another backend", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let startCount = 0;
        const ahead = yield* Deferred.make<void>();
        const instance = yield* makeTestInstance({
          spawnerLayer: Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() =>
              Effect.sync(() => {
                startCount += 1;
                return makeProcess({
                  exitCode: Effect.succeed(
                    ChildProcessSpawner.ExitCode(SERVER_EXIT_CODE_DATABASE_AHEAD),
                  ),
                });
              }),
            ),
          ),
          httpClientLayer: layerHttpClient(() => Effect.never),
          onDatabaseAhead: Deferred.succeed(ahead, undefined).pipe(Effect.asVoid),
        });
        yield* instance.start;
        yield* Deferred.await(ahead);
        const snapshot = yield* instance.snapshot;
        assert.isFalse(snapshot.desiredRunning);
        assert.isFalse(snapshot.restartScheduled);
        yield* TestClock.adjust(Duration.minutes(1));
        assert.equal(startCount, 1);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );
  it.effect("reports a crash loop with the server output on the third restart", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const message = "Error: Cannot find module 'zod/v4' in /work/fixture-é";
        let exitCount = 0;
        const firstExit = yield* Deferred.make<void>();
        const reports: Array<{
          exitCount: number;
          failure: DesktopBackendManager.BackendStartupFailure;
        }> = [];
        const instance = yield* makeTestInstance({
          spawnerLayer: Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() =>
              Effect.succeed(
                makeProcess({
                  // "é" split across chunks must not decode as U+FFFD, and the 4,000-char cut
                  // lands inside the emoji's surrogate pair.
                  stderr: Stream.make(
                    new TextEncoder().encode(
                      `😀${"x".repeat(3_999 - message.length)}${message.slice(0, -1)}`,
                    ),
                    new Uint8Array([0xc3]),
                    new Uint8Array([0xa9]),
                  ),
                  exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
                }),
              ),
            ),
          ),
          httpClientLayer: layerHttpClient(() => Effect.never),
          backendOutputLog: {
            persistFailure: () => {
              exitCount += 1;
              return Deferred.succeed(firstExit, undefined).pipe(Effect.asVoid);
            },
          },
          onStartupFailure: (failure) =>
            Effect.sync(() => {
              reports.push({ exitCount, failure });
            }),
        });
        yield* instance.start;
        yield* Deferred.await(firstExit);
        yield* TestClock.adjust(Duration.minutes(1));
        assert.isNotEmpty(reports);
        const { exitCount: exitsWhenReported, failure } = reports[0]!;
        assert.equal(exitsWhenReported, 3);
        assert.equal(failure.reason, "The server could not start (code=1).");
        assert.isTrue(failure.output.endsWith(message));
        assert.isTrue(failure.output.isWellFormed());
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );
  it.effect("reports a backend that stays alive without becoming ready", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const probed = yield* Deferred.make<void>();
        const reports = yield* Queue.unbounded<DesktopBackendManager.BackendStartupFailure>();
        const instance = yield* makeTestInstance({
          spawnerLayer: Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() =>
              Effect.succeed(
                makeProcess({
                  stderr: Stream.make(new TextEncoder().encode("Server bootstrap stalled")),
                  exitCode: Effect.never,
                }),
              ),
            ),
          ),
          httpClientLayer: layerHttpClient(() =>
            Deferred.succeed(probed, undefined).pipe(Effect.andThen(Effect.never)),
          ),
          onStartupFailure: (failure) => Queue.offer(reports, failure).pipe(Effect.asVoid),
        });
        yield* instance.start;
        yield* Deferred.await(probed);
        yield* TestClock.adjust(Duration.minutes(1));
        const failure = yield* Queue.take(reports);
        assert.equal(failure.reason, "The server started but did not become ready in time.");
        assert.equal(failure.output, "Server bootstrap stalled");
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );
});

it.effect("WSL preflight reaches fallback without spending the exit recovery budget", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const ready = yield* Queue.unbounded<void>();
      const exits = yield* Queue.unbounded<Deferred.Deferred<ChildProcessSpawner.ExitCode>>();
      let attempts = 0;
      let fallbacks = 0;
      let spawns = 0;
      const instance = yield* makeTestInstance({
        configResolve: Effect.sync(() => {
          attempts++;
          return fallbacks > 0
            ? baseConfig
            : {
                ...baseConfig,
                preflightFailure: Option.some({
                  reason: "WSL is booting",
                  fatal: false,
                  retryLimit: 12,
                }),
              };
        }),
        onPreflightFailed: () =>
          Effect.sync(() => {
            fallbacks++;
            return true;
          }),
        onReady: Queue.offer(ready, undefined).pipe(Effect.asVoid),
        spawnerLayer: Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.gen(function* () {
              spawns++;
              const exit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
              yield* Effect.addFinalizer(() =>
                Deferred.succeed(exit, ChildProcessSpawner.ExitCode(0)),
              );
              yield* Queue.offer(exits, exit);
              return makeProcess({ exitCode: Deferred.await(exit) });
            }),
          ),
        ),
      });
      yield* instance.start;
      for (let attempt = 1; attempt < 12; attempt++) yield* TestClock.adjust("32 seconds");
      assert.equal(attempts, 12);
      assert.equal(fallbacks, 1);
      assert.equal((yield* instance.snapshot).restartAttempt, 0);
      yield* TestClock.adjust("32 seconds");
      for (let cycle = 0; cycle < 5; cycle++) {
        yield* Queue.take(ready);
        yield* Deferred.succeed(yield* Queue.take(exits), ChildProcessSpawner.ExitCode(80));
        yield* TestClock.adjust("32 seconds");
        assert.equal((yield* instance.snapshot).restartAttempt, cycle + 1);
      }
      yield* Queue.take(ready);
      assert.equal(spawns, 6);
      yield* instance.stop();
    }),
  ),
);

it.effect("a healthy backend stays ready when resetting the recovery record fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const ready = yield* Deferred.make<void>();
      const exit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      const notices = yield* Queue.unbounded<string>();
      let shutdowns = 0;
      let spawns = 0;
      const instance = yield* makeTestInstance({
        config: { ...baseConfig, recoveryStateDirectory: "/isolated/recovery" },
        fileSystem: { makeDirectory: () => Effect.void },
        onReady: Deferred.succeed(ready, undefined).pipe(Effect.asVoid),
        onShutdown: Effect.sync(() => {
          shutdowns++;
        }),
        onRecoveryPaused: (actions) => Queue.offer(notices, actions.reason).pipe(Effect.asVoid),
        spawnerLayer: Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.gen(function* () {
              spawns++;
              yield* Effect.addFinalizer(() =>
                Deferred.succeed(exit, ChildProcessSpawner.ExitCode(0)),
              );
              return makeProcess({ exitCode: Deferred.await(exit) });
            }),
          ),
        ),
      });
      yield* instance.start;
      yield* Deferred.await(ready);
      yield* TestClock.adjust("10 minutes");
      assert.equal(yield* Queue.take(notices), "record-unavailable");
      const healthy = yield* instance.snapshot;
      assert.isTrue(healthy.ready);
      assert.isTrue(healthy.desiredRunning);
      assert.deepEqual(healthy.activePid, Option.some(123));
      assert.equal(healthy.recovery, "record-unavailable");
      assert.equal(shutdowns, 0);
      assert.isTrue(yield* instance.waitForReady(Duration.seconds(1)));
      yield* Deferred.succeed(exit, ChildProcessSpawner.ExitCode(80));
      yield* TestClock.adjust("32 seconds");
      assert.equal(yield* Queue.take(notices), "record-unavailable");
      assert.equal(spawns, 1);
      assert.equal(shutdowns, 1);
      assert.isFalse((yield* instance.snapshot).restartScheduled);
      assert.isFalse((yield* instance.snapshot).desiredRunning);
    }),
  ),
);

it.effect("six ready-then-exit80 runs pause; Retry explicitly restores the same start path", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const ready = yield* Queue.unbounded<void>();
      const exits = yield* Queue.unbounded<Deferred.Deferred<ChildProcessSpawner.ExitCode>>();
      const paused =
        yield* Deferred.make<
          Parameters<NonNullable<DesktopBackendManager.BackendInstanceSpec["onRecoveryPaused"]>>[0]
        >();
      let spawns = 0;
      const spawner = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.gen(function* () {
            spawns++;
            const exit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
            yield* Effect.addFinalizer(() =>
              Deferred.succeed(exit, ChildProcessSpawner.ExitCode(0)),
            );
            yield* Queue.offer(exits, exit);
            return makeProcess({ exitCode: Deferred.await(exit) });
          }),
        ),
      );
      const instance = yield* makeTestInstance({
        spawnerLayer: spawner,
        onReady: Queue.offer(ready, undefined).pipe(Effect.asVoid),
        onRecoveryPaused: (actions) => Deferred.succeed(paused, actions).pipe(Effect.asVoid),
      });
      yield* instance.start;
      for (let cycle = 0; cycle < 6; cycle++) {
        yield* Queue.take(ready);
        yield* Deferred.succeed(yield* Queue.take(exits), ChildProcessSpawner.ExitCode(80));
        yield* TestClock.adjust("32 seconds");
        if (cycle < 5) assert.equal((yield* instance.snapshot).restartAttempt, cycle + 1);
      }
      const actions = yield* Deferred.await(paused);
      assert.equal(actions.reason, "crash-loop");
      assert.equal(spawns, 6);
      assert.isFalse((yield* instance.snapshot).restartScheduled);
      yield* actions.retry;
      yield* Queue.take(ready);
      assert.equal(spawns, 7);
      assert.equal((yield* instance.snapshot).restartAttempt, 0);
      yield* Deferred.succeed(yield* Queue.take(exits), ChildProcessSpawner.ExitCode(80));
      yield* TestClock.adjust("32 seconds");
      yield* Queue.take(ready);
      assert.equal((yield* instance.snapshot).restartAttempt, 1);
      yield* TestClock.adjust("10 minutes");
      assert.equal((yield* instance.snapshot).restartAttempt, 0);
      yield* instance.stop();
    }),
  ),
);
