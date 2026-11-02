import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import type * as Harness from "./DesktopBackendManager.test.ts";

export function registerBackendStopTests({
  makeTestInstance,
  makeProcess,
}: {
  makeTestInstance: typeof Harness.makeTestInstance;
  makeProcess: typeof Harness.makeProcess;
}) {
  it.effect.each([
    ["a backend still running after the grace is recorded with its stop reason and output", "kill"],
    ["output written after the stop begins reaches the persisted session", "output"],
    ["a stop requested before the process reports its pid still marks the output", "pending"],
  ] as const)("%s", ([_title, mode]) =>
    Effect.scoped(
      Effect.gen(function* () {
        const spawned = yield* Deferred.make<void>();
        const spawnAllowed = yield* Deferred.make<void>();
        const releasing = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const output = yield* Deferred.make<void>();
        const exited = yield* Deferred.make<void>();
        const stopRecorded = yield* Deferred.make<void>();
        const records: string[] = [];
        let persisted = "";
        let stopOutput = "";
        let text = "";
        const signal = PlatformError.systemError({
          _tag: "Unknown",
          module: "ChildProcess",
          method: "exitCode",
          cause: new Error("Process interrupted due to receipt of signal: 'SIGKILL'"),
        });
        const layer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.gen(function* () {
              const scope = yield* Scope.Scope;
              yield* Deferred.succeed(spawned, undefined);
              if (mode === "pending") yield* Deferred.await(spawnAllowed);
              yield* Scope.addFinalizer(
                scope,
                Deferred.succeed(releasing, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(Deferred.succeed(output, undefined)),
                  Effect.andThen(Deferred.succeed(exited, undefined)),
                  Effect.asVoid,
                ),
              );
              return makeProcess({
                stdout: Stream.fromEffect(
                  Deferred.await(output).pipe(
                    Effect.as(new TextEncoder().encode("shutdown line\n")),
                  ),
                ),
                exitCode: Deferred.await(exited).pipe(
                  Effect.andThen(
                    mode === "pending"
                      ? Effect.succeed(ChildProcessSpawner.ExitCode(0))
                      : Effect.fail(signal),
                  ),
                ),
              });
            }),
          ),
        );
        const instance = yield* makeTestInstance({
          spawnerLayer: layer,
          backendOutputLog: {
            recordStop: ({ message, details }) =>
              Effect.sync(() => {
                records.push(`${message} ${details}`);
              }).pipe(Effect.andThen(Deferred.succeed(stopRecorded, undefined)), Effect.asVoid),
            markStop: Effect.sync(() => {
              records.push("marked");
            }),
            writeOutputChunk: (_stream, chunk) =>
              Effect.sync(() => {
                text += new TextDecoder().decode(chunk);
              }),
            persistFailure: ({ details }) =>
              Effect.sync(() => {
                persisted = `${details} ${text}`;
              }),
            persistStopOutput: ({ details }: { details: string }) =>
              Effect.sync(() => {
                stopOutput = `${details} ${text}`;
              }),
          },
        });
        yield* instance.start;
        yield* Deferred.await(spawned);
        const stopping = yield* instance.stop("quit").pipe(Effect.forkChild);
        if (mode === "pending") {
          yield* Deferred.await(stopRecorded);
          yield* Deferred.succeed(spawnAllowed, undefined);
        }
        yield* Deferred.await(releasing);
        yield* TestClock.adjust("6 seconds");
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(stopping);
        assert.isTrue(
          records.some(
            (record) =>
              record.includes("backend stop requested") &&
              record.includes(mode === "pending" ? "pid=pending" : "reason=quit"),
          ),
        );
        if (mode === "pending") assert.include(stopOutput, "shutdown line");
        else {
          assert.include(persisted, "during stop reason=quit");
          assert.include(persisted, "shutdown line");
        }
      }),
    ),
  );

  it.effect.each([false, true])(
    "closing the instance's scope stops the run through stop(): sequential child=%s",
    (child) =>
      Effect.scoped(
        Effect.gen(function* () {
          const parent = yield* Scope.make("sequential");
          const scope = child ? yield* Scope.fork(parent, "sequential") : parent;
          const spawned = yield* Deferred.make<void>();
          const started = yield* Deferred.make<void>();
          const exited = yield* Deferred.make<void>();
          const records: string[] = [];
          let requestAtRelease = false;
          const layer = Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() =>
              Effect.gen(function* () {
                const runScope = yield* Scope.Scope;
                yield* Scope.addFinalizer(
                  runScope,
                  Effect.sync(() => {
                    requestAtRelease = records.some(
                      (record) =>
                        record.includes("backend stop requested") &&
                        record.includes("reason=instance-closed"),
                    );
                  }).pipe(Effect.andThen(Deferred.succeed(exited, undefined)), Effect.asVoid),
                );
                yield* Deferred.succeed(spawned, undefined);
                return makeProcess({
                  exitCode: Deferred.await(exited).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
                });
              }),
            ),
          );
          const instance = yield* makeTestInstance({
            spawnerLayer: layer,
            backendOutputLog: {
              beginSession: () => Deferred.succeed(started, undefined).pipe(Effect.asVoid),
              recordStop: ({ message, details }) =>
                Effect.sync(() => {
                  records.push(`${message} ${details}`);
                }),
            },
          }).pipe(Scope.provide(scope));
          yield* instance.start;
          yield* Deferred.await(spawned);
          yield* Deferred.await(started);
          yield* Scope.close(parent, Exit.void);
          assert.isTrue(requestAtRelease);
          assert.isTrue(
            records.some(
              (record) =>
                record.includes("backend stop requested") &&
                record.includes("reason=instance-closed"),
            ),
          );
        }),
      ),
  );

  it.effect("stop output keeps its first and newest lines when it overflows", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-stop-output-" });
        const environment = DesktopEnvironment.layer({
          dirname: "/repo/apps/desktop/dist-electron",
          homeDirectory: baseDir,
          platform: "darwin",
          processArch: "arm64",
          appVersion: "1.2.3",
          appPath: "/repo",
          isPackaged: false,
          resourcesPath: "/repo/resources",
          runningUnderArm64Translation: false,
        }).pipe(
          Layer.provide(
            Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ GOAT_HOME: baseDir })),
          ),
        );
        const path = yield* Effect.gen(function* () {
          return (yield* DesktopEnvironment.DesktopEnvironment).path.join(
            (yield* DesktopEnvironment.DesktopEnvironment).logDir,
            "server-child.log",
          );
        }).pipe(Effect.provide(environment));
        yield* Effect.gen(function* () {
          const log =
            yield* (yield* DesktopObservability.DesktopBackendOutputLogFactory).forInstance(
              "primary",
            );
          yield* log.beginSession({ details: "pid=123" });
          yield* log.writeOutputChunk(
            "stdout",
            new TextEncoder().encode("x".repeat(1024 * 1024 + 10)),
          );
          yield* log.markStop;
          yield* log.writeOutputChunk(
            "stdout",
            new TextEncoder().encode("FIRST\n" + "y".repeat(300 * 1024) + "LAST\n"),
          );
          yield* log.persistStopOutput({ details: "done" });
        }).pipe(Effect.provide(DesktopObservability.layer.pipe(Layer.provideMerge(environment))));
        const log = yield* fs.readFileString(path);
        assert.isTrue(log.indexOf("FIRST") < log.indexOf("bytes of stop output omitted"));
        assert.isTrue(log.indexOf("bytes of stop output omitted") < log.indexOf("LAST"));
        assert.notInclude(log, "xxxxxxxxxx");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            NodeHttpClient.layerUndici,
            ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
          ),
        ),
      ),
    ),
  );
}
