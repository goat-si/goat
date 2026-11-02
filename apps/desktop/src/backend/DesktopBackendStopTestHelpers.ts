import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Clock from "effect/Clock";
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

  it.effect("persists output drained before startup acquires the manager lock", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const spawnEntered = yield* Deferred.make<void>();
        const allowSpawn = yield* Deferred.make<void>();
        const stopEntered = yield* Deferred.make<void>();
        const allowStop = yield* Deferred.make<void>();
        const outputObserved = yield* Deferred.make<void>();
        const exited = yield* Deferred.make<void>();
        let session = false;
        let text = "";
        let saved = "";
        const layer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.gen(function* () {
              const scope = yield* Scope.Scope;
              yield* Deferred.succeed(spawnEntered, undefined);
              yield* Deferred.await(allowSpawn);
              yield* Scope.addFinalizer(
                scope,
                Deferred.succeed(exited, undefined).pipe(Effect.asVoid),
              );
              return makeProcess({
                stdout: Stream.make(new TextEncoder().encode("startup shutdown line")),
                exitCode: Deferred.await(exited).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
              });
            }),
          ),
        );
        const instance = yield* makeTestInstance({
          spawnerLayer: layer,
          backendOutputLog: {
            beginSession: () =>
              Effect.sync(() => {
                session = true;
              }),
            recordStop: () =>
              Deferred.succeed(stopEntered, undefined).pipe(
                Effect.andThen(Deferred.await(allowStop)),
              ),
            writeOutputChunk: (_stream, chunk) =>
              Effect.sync(() => {
                if (session) text += new TextDecoder().decode(chunk);
              }).pipe(Effect.andThen(Deferred.succeed(outputObserved, undefined)), Effect.asVoid),
            persistStopOutput: () =>
              Effect.sync(() => {
                saved = text;
              }),
          },
        });
        yield* instance.start;
        yield* Deferred.await(spawnEntered);
        const stopping = yield* instance.stop("quit").pipe(Effect.forkChild);
        yield* Deferred.await(stopEntered);
        yield* Deferred.succeed(allowSpawn, undefined);
        yield* Deferred.await(outputObserved);
        yield* Deferred.succeed(allowStop, undefined);
        yield* Fiber.join(stopping);
        assert.include(saved, "startup shutdown line");
      }),
    ),
  );

  it.effect("an exit observed before a concurrent stop remains unrequested", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const realClock = yield* Clock.Clock;
        const readingExit = yield* Deferred.make<void>();
        const allowExit = yield* Deferred.make<void>();
        const spawned = yield* Deferred.make<void>();
        const exited = yield* Deferred.make<void>();
        let reads = 0;
        const clock = {
          currentTimeMillisUnsafe: () => realClock.currentTimeMillisUnsafe(),
          currentTimeMillis: realClock.currentTimeMillis,
          currentTimeNanosUnsafe: () => realClock.currentTimeNanosUnsafe(),
          currentTimeNanos: realClock.currentTimeNanos,
          monotonicTimeNanosUnsafe: () => realClock.monotonicTimeNanosUnsafe(),
          sleep: realClock.sleep.bind(realClock),
          monotonicTimeNanos: Effect.suspend(() =>
            ++reads === 1
              ? Deferred.succeed(readingExit, undefined).pipe(
                  Effect.andThen(Deferred.await(allowExit)),
                  Effect.as(10_000_000n),
                )
              : Effect.succeed(20_000_000n),
          ),
        } satisfies Clock.Clock;
        const records: string[] = [];
        let failure = "";
        let stopped = "";
        const layer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.gen(function* () {
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
            recordStop: ({ message }) =>
              Effect.sync(() => {
                records.push(message);
              }),
            persistFailure: ({ details }) =>
              Effect.sync(() => {
                failure = details;
              }),
            persistStopOutput: ({ details }) =>
              Effect.sync(() => {
                stopped = details;
              }),
          },
        }).pipe(Effect.provideService(Clock.Clock, clock));
        yield* instance.start.pipe(Effect.provideService(Clock.Clock, clock));
        yield* Deferred.await(spawned);
        yield* Deferred.succeed(exited, undefined);
        yield* Deferred.await(readingExit);
        const stopping = yield* instance
          .stop("quit")
          .pipe(
            Effect.provideService(Clock.Clock, clock),
            Effect.forkChild({ startImmediately: true }),
          );
        yield* Deferred.succeed(allowExit, undefined);
        yield* Fiber.join(stopping);
        assert.equal(failure, "pid=123 code=0");
        assert.equal(stopped, "");
        assert.notInclude(records, "backend stop requested");
      }),
    ),
  );

  it.effect("instance scope closes within the backend stop budget while release continues", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const owner = yield* Scope.make("sequential");
        const started = yield* Deferred.make<void>();
        const releasing = yield* Deferred.make<void>();
        const allowRelease = yield* Deferred.make<void>();
        const exited = yield* Deferred.make<void>();
        const persisted = yield* Deferred.make<void>();
        const records: Array<{ message: string; details: string }> = [];
        const layer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.gen(function* () {
              const scope = yield* Scope.Scope;
              yield* Scope.addFinalizer(
                scope,
                Deferred.succeed(releasing, undefined).pipe(
                  Effect.andThen(Deferred.await(allowRelease)),
                  Effect.andThen(Deferred.succeed(exited, undefined)),
                  Effect.asVoid,
                ),
              );
              return makeProcess({
                exitCode: Deferred.await(exited).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
              });
            }),
          ),
        );
        const instance = yield* makeTestInstance({
          spawnerLayer: layer,
          backendOutputLog: {
            beginSession: ({ details }) =>
              details.includes("pid=123")
                ? Deferred.succeed(started, undefined).pipe(Effect.asVoid)
                : Effect.void,
            recordStop: (record) =>
              Effect.sync(() => {
                records.push(record);
              }),
            persistStopOutput: () => Deferred.succeed(persisted, undefined).pipe(Effect.asVoid),
          },
        }).pipe(Scope.provide(owner));
        yield* instance.start;
        yield* Deferred.await(started);
        const closing = yield* Scope.close(owner, Exit.void).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Deferred.await(releasing);
        yield* TestClock.adjust("7 seconds");
        const stillWaitingAtSevenSeconds = closing.pollUnsafe() === undefined;
        yield* TestClock.adjust("1 second");
        const closedInBudget = closing.pollUnsafe() !== undefined;
        const warning = records.find((record) => record.message === "backend stop timed out");
        yield* Deferred.succeed(allowRelease, undefined);
        yield* Fiber.join(closing);
        yield* Deferred.await(persisted);
        assert.isTrue(stillWaitingAtSevenSeconds);
        assert.isTrue(closedInBudget);
        assert.include(warning?.details ?? "", "reason=instance-closed");
      }),
    ),
  );

  it.effect("closing an instance releases a late child without recording its output", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const owner = yield* Scope.make("sequential");
        const entered = yield* Deferred.make<void>();
        const allowSpawn = yield* Deferred.make<void>();
        const released = yield* Deferred.make<void>();
        const exited = yield* Deferred.make<void>();
        const drained = yield* Deferred.make<void>();
        let loggedOutput = "";
        const records: Array<{ message: string; level: string; details: string }> = [];
        const layer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.gen(function* () {
              const scope = yield* Scope.Scope;
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(allowSpawn);
              yield* Scope.addFinalizer(
                scope,
                Deferred.succeed(released, undefined).pipe(
                  Effect.andThen(Deferred.succeed(exited, undefined)),
                  Effect.asVoid,
                ),
              );
              return makeProcess({
                stdout: Stream.make(new TextEncoder().encode("late output")).pipe(
                  Stream.ensuring(Deferred.succeed(drained, undefined).pipe(Effect.asVoid)),
                ),
                exitCode: Deferred.await(exited).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
              });
            }),
          ),
        );
        const instance = yield* makeTestInstance({
          spawnerLayer: layer,
          backendOutputLog: {
            writeOutputChunk: (_stream, chunk) =>
              Effect.sync(() => {
                loggedOutput += new TextDecoder().decode(chunk);
              }),
            recordStop: (record) =>
              Effect.sync(() => {
                records.push(record);
              }),
          },
        }).pipe(Scope.provide(owner));
        yield* instance.start;
        yield* Deferred.await(entered);
        const closing = yield* Scope.close(owner, Exit.void).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* TestClock.adjust("1 second");
        const closedBeforeSpawn = closing.pollUnsafe() !== undefined;
        const warning = records.find(
          (record) => record.message === "backend spawn still pending at stop",
        );
        yield* Deferred.succeed(allowSpawn, undefined);
        yield* Fiber.join(closing);
        yield* Deferred.await(released);
        yield* Deferred.await(drained);
        assert.equal(loggedOutput, "");
        assert.isTrue(closedBeforeSpawn);
        assert.equal(warning?.level, "WARN");
        assert.include(warning?.details ?? "", "pid=pending");
        assert.include(warning?.details ?? "", "reason=instance-closed");
      }),
    ),
  );

  it.effect("a failed spawn does not delay a concurrent stop", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const allowFailure = yield* Deferred.make<void>();
        const cause = PlatformError.systemError({
          _tag: "Unknown",
          module: "ChildProcess",
          method: "spawn",
          cause: new Error("spawn failed"),
        });
        const records: string[] = [];
        const layer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(allowFailure)),
              Effect.andThen(Effect.fail(cause)),
            ),
          ),
        );
        const instance = yield* makeTestInstance({
          spawnerLayer: layer,
          backendOutputLog: {
            recordStop: ({ message }) =>
              Effect.sync(() => {
                records.push(message);
              }),
          },
        });
        yield* instance.start;
        yield* Deferred.await(entered);
        const stopping = yield* instance
          .stop("quit")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.succeed(allowFailure, undefined);
        yield* Fiber.join(stopping);
        assert.isFalse((yield* instance.snapshot).desiredRunning);
        assert.notInclude(records, "backend spawn still pending at stop");
      }),
    ),
  );

  it.effect("does not release a process before its spawn finishes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const spawned = yield* Deferred.make<void>();
        const allowSpawn = yield* Deferred.make<void>();
        const exited = yield* Deferred.make<void>();
        let spawnReturned = false;
        let releasedAfterSpawn = false;
        const layer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.gen(function* () {
              const scope = yield* Scope.Scope;
              yield* Deferred.succeed(spawned, undefined);
              yield* Deferred.await(allowSpawn);
              yield* Scope.addFinalizer(
                scope,
                Effect.sync(() => {
                  releasedAfterSpawn = spawnReturned;
                }).pipe(Effect.andThen(Deferred.succeed(exited, undefined)), Effect.asVoid),
              );
              spawnReturned = true;
              return makeProcess({
                exitCode: Deferred.await(exited).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
              });
            }),
          ),
        );
        const instance = yield* makeTestInstance({ spawnerLayer: layer });
        yield* instance.start;
        yield* Deferred.await(spawned);
        const stopping = yield* instance
          .stop("quit")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.succeed(allowSpawn, undefined);
        yield* Fiber.join(stopping);
        assert.isTrue(releasedAfterSpawn);
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
  it.effect.each([false, true])(
    "preserves Korean UTF-8 split across chunks, streams and buffer blocks: failure=%s",
    (failure) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-stop-utf8-" });
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
            const env = yield* DesktopEnvironment.DesktopEnvironment;
            return env.path.join(env.logDir, "server-child.log");
          }).pipe(Effect.provide(environment));
          yield* Effect.gen(function* () {
            const log =
              yield* (yield* DesktopObservability.DesktopBackendOutputLogFactory).forInstance(
                "primary",
              );
            yield* log.beginSession({ details: "pid=123" });
            yield* log.markStop;
            const korean = new TextEncoder().encode("한");
            yield* log.writeOutputChunk("stdout", new TextEncoder().encode("x".repeat(4095)));
            yield* log.writeOutputChunk("stdout", korean.subarray(0, 1));
            yield* log.beginSession({ details: "pid=123", preserve: true });
            yield* log.writeOutputChunk("stderr", new TextEncoder().encode("국"));
            yield* log.writeOutputChunk("stdout", korean.subarray(1));
            yield* failure
              ? log.persistFailure({ details: "done" })
              : log.persistStopOutput({ details: "done" });
          }).pipe(Effect.provide(DesktopObservability.layer.pipe(Layer.provideMerge(environment))));
          const records = (yield* fs.readFileString(path))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
          const stdout = records
            .filter((record) => record.annotations.stream === "stdout")
            .map((record) => record.annotations.text)
            .join("");
          const stderr = records
            .filter((record) => record.annotations.stream === "stderr")
            .map((record) => record.annotations.text)
            .join("");
          assert.equal(stdout, "x".repeat(4095) + "한");
          assert.equal(stderr, "국");
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
