import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import { DesktopStopIntent } from "@goat/contracts";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";
import type * as Harness from "./DesktopBackendManager.test.ts";

const decodeStopIntent = Schema.decodeEffect(Schema.fromJsonString(DesktopStopIntent));

export function registerStopIntentTests({
  makeTestInstance,
  makeProcess,
  baseConfig,
}: {
  makeTestInstance: typeof Harness.makeTestInstance;
  makeProcess: typeof Harness.makeProcess;
  baseConfig: Parameters<typeof Harness.makeTestInstance>[0]["config"] & {};
}) {
  it.effect.each([false, true])(
    "writes the stop reason before releasing a pending spawn (late: %s)",
    (late) =>
      Effect.scoped(
        Effect.gen(function* () {
          const spawning = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const stopping = yield* Deferred.make<void>();
          const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
          let temporary = "";
          let written = "";
          let intentAtKill = "";
          const spawnerLayer = Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() =>
              Effect.gen(function* () {
                yield* Deferred.succeed(spawning, undefined);
                yield* Deferred.await(release);
                const kill = Effect.sync(() => {
                  intentAtKill = written;
                }).pipe(
                  Effect.andThen(Deferred.succeed(exited, ChildProcessSpawner.ExitCode(0))),
                  Effect.asVoid,
                );
                yield* Scope.addFinalizer(yield* Scope.Scope, kill);
                return makeProcess({ exitCode: Deferred.await(exited), kill: () => kill });
              }),
            ),
          );
          const instance = yield* makeTestInstance({
            spawnerLayer,
            config: {
              ...baseConfig,
              bootstrap: { ...baseConfig.bootstrap, desktopStopIntentPath: "/intent.json" },
            },
            fileSystem: {
              makeDirectory: () => Effect.void,
              writeFileString: (_path, content) =>
                Effect.sync(() => {
                  temporary = content;
                }),
              rename: () =>
                Effect.sync(() => {
                  written = temporary;
                }),
            },
            backendOutputLog: {
              markStop: Deferred.succeed(stopping, undefined).pipe(Effect.asVoid),
            },
          });
          yield* instance.start;
          yield* Deferred.await(spawning);
          const stop = yield* instance.stop("relaunch").pipe(Effect.forkChild);
          yield* Deferred.await(stopping);
          if (late) {
            yield* TestClock.adjust("1 second");
            yield* Fiber.join(stop);
          }
          yield* Deferred.succeed(release, undefined);
          if (!late) yield* Fiber.join(stop);
          else yield* Deferred.await(exited);
          const intent = yield* decodeStopIntent(intentAtKill);
          assert.isUndefined(intent.pid);
          assert.equal(intent.reason, "relaunch");
        }),
      ),
  );

  it.effect.each(["write", "concurrent", "failure", "timeout", "unobserved", "no-path"] as const)(
    "stop intent is safe before release: %s",
    (scenario) =>
      Effect.scoped(
        Effect.gen(function* () {
          const ready = yield* Deferred.make<void>();
          const renameStarted = yield* Deferred.make<void>();
          const allowRename = yield* Deferred.make<void>();
          const released = yield* Deferred.make<void>();
          const renameFinished = yield* Deferred.make<void>();
          const removed = yield* Deferred.make<void>();
          const warned = yield* Deferred.make<void>();
          const exit = yield* Deferred.make<
            ChildProcessSpawner.ExitCode,
            PlatformError.PlatformError
          >();
          const files = new Map<string, string>();
          const warnings: string[] = [];
          let writes = 0;
          let fileMode = 0;
          let directoryMode = 0;
          const path = "/state/runtime/desktop-stop-intent/run.json";
          let atRelease: string | undefined;
          const failure = PlatformError.systemError({
            _tag: "Unknown",
            module: "FileSystem",
            method: "rename",
            cause: new Error("failed"),
          });
          const spawnerLayer = Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() =>
              Effect.gen(function* () {
                const scope = yield* Scope.Scope;
                yield* Scope.addFinalizer(
                  scope,
                  Effect.sync(() => {
                    atRelease = files.get(path);
                  }).pipe(
                    Effect.andThen(Deferred.succeed(released, undefined)),
                    Effect.andThen(
                      scenario === "unobserved"
                        ? Deferred.fail(exit, failure)
                        : Deferred.succeed(exit, ChildProcessSpawner.ExitCode(0)),
                    ),
                    Effect.asVoid,
                  ),
                );
                return makeProcess({ exitCode: Deferred.await(exit) });
              }),
            ),
          );
          const instance = yield* makeTestInstance({
            config: {
              ...baseConfig,
              bootstrap: {
                ...baseConfig.bootstrap,
                ...(scenario === "no-path" ? {} : { desktopStopIntentPath: path }),
              },
            },
            spawnerLayer,
            onReady: Deferred.succeed(ready, undefined).pipe(Effect.asVoid),
            backendOutputLog: {
              recordStop: ({ message }) =>
                Effect.sync(() => {
                  warnings.push(message);
                }).pipe(
                  Effect.andThen(
                    message === "backend stop intent not written"
                      ? Deferred.succeed(warned, undefined).pipe(Effect.asVoid)
                      : Effect.void,
                  ),
                ),
            },
            fileSystem: {
              makeDirectory: (_name, options) =>
                Effect.sync(() => {
                  directoryMode = options?.mode ?? 0;
                }),
              writeFileString: (name, text, options) =>
                Effect.sync(() => {
                  writes++;
                  fileMode = options?.mode ?? 0;
                  files.set(name, text);
                }),
              rename: (from, to) =>
                Deferred.succeed(renameStarted, undefined).pipe(
                  Effect.andThen(
                    scenario === "failure"
                      ? Effect.fail(failure)
                      : scenario === "concurrent" || scenario === "timeout"
                        ? Deferred.await(allowRename)
                        : Effect.void,
                  ),
                  Effect.andThen(
                    Effect.sync(() => {
                      const value = files.get(from);
                      if (value !== undefined) files.set(to, value);
                      files.delete(from);
                    }).pipe(
                      Effect.andThen(Deferred.succeed(renameFinished, undefined)),
                      Effect.asVoid,
                    ),
                  ),
                ),
              remove: (name) =>
                Effect.sync(() => {
                  files.delete(name);
                }).pipe(
                  Effect.andThen(
                    name === path ? Deferred.succeed(removed, undefined) : Effect.void,
                  ),
                  Effect.asVoid,
                ),
            },
          });
          yield* instance.start;
          yield* Deferred.await(ready);
          const stop = yield* instance
            .stop("update-install", { timeout: Duration.seconds(9) })
            .pipe(Effect.forkChild({ startImmediately: true }));
          if (scenario === "concurrent" || scenario === "timeout") {
            yield* Deferred.await(renameStarted);
            const second = yield* instance
              .stop("quit", { timeout: Duration.seconds(9) })
              .pipe(Effect.forkChild({ startImmediately: true }));
            assert.isFalse(yield* Deferred.isDone(released));
            if (scenario === "concurrent") yield* Deferred.succeed(allowRename, undefined);
            else {
              yield* TestClock.adjust("999 millis");
              assert.isFalse(yield* Deferred.isDone(released));
              yield* TestClock.adjust("1 millis");
            }
            yield* Fiber.join(second);
          }
          yield* Fiber.join(stop);
          yield* Deferred.await(released);
          if (scenario === "write" || scenario === "concurrent" || scenario === "unobserved") {
            assert.isDefined(atRelease);
            const written = yield* decodeStopIntent(atRelease);
            assert.equal(written.pid, 123);
            assert.equal(written.reason, "update-install");
            assert.equal(written.version, 1);
            assert.isString(written.requestedAt);
            if (scenario !== "unobserved") yield* Deferred.await(removed);
            assert.equal(files.has(path), scenario === "unobserved");
          } else {
            assert.isUndefined(atRelease);
          }
          if (scenario === "failure" || scenario === "timeout") {
            yield* Deferred.await(warned);
            assert.include(warnings, "backend stop intent not written");
            if (scenario === "failure") assert.isFalse(files.has(`${path}.tmp`));
          }
          if (scenario === "timeout") {
            yield* Deferred.succeed(allowRename, undefined);
            yield* Deferred.await(renameFinished);
            assert.isFalse(files.has(`${path}.tmp`));
          }
          if (scenario === "no-path") assert.equal(writes, 0);
          else {
            assert.equal(writes, 1);
            assert.equal(directoryMode, 0o700);
            assert.equal(fileMode, 0o600);
          }
        }),
      ),
  );
  it.effect.each(["settled", "timeout"] as const)(
    "exit observation failure waits for a pending intent before release: %s",
    (outcome) =>
      Effect.scoped(
        Effect.gen(function* () {
          const ready = yield* Deferred.make<void>();
          const renameStarted = yield* Deferred.make<void>();
          const allowRename = yield* Deferred.make<void>();
          const exit = yield* Deferred.make<
            ChildProcessSpawner.ExitCode,
            PlatformError.PlatformError
          >();
          const killed = yield* Deferred.make<void>();
          const paused = yield* Deferred.make<void>();
          const failure = PlatformError.systemError({
            _tag: "Unknown",
            module: "ChildProcess",
            method: "exitCode",
            cause: new Error("status failed"),
          });
          const spawnerLayer = Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() =>
              Effect.gen(function* () {
                yield* Scope.addFinalizer(
                  yield* Scope.Scope,
                  Deferred.succeed(killed, undefined).pipe(Effect.asVoid),
                );
                return makeProcess({ exitCode: Deferred.await(exit) });
              }),
            ),
          );
          const instance = yield* makeTestInstance({
            spawnerLayer,
            config: {
              ...baseConfig,
              bootstrap: { ...baseConfig.bootstrap, desktopStopIntentPath: "/intent.json" },
            },
            onReady: Deferred.succeed(ready, undefined).pipe(Effect.asVoid),
            onRecoveryPaused: () => Deferred.succeed(paused, undefined).pipe(Effect.asVoid),
            fileSystem: {
              makeDirectory: () => Effect.void,
              writeFileString: () => Effect.void,
              rename: () =>
                Deferred.succeed(renameStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(allowRename)),
                ),
            },
          });
          yield* instance.start;
          yield* Deferred.await(ready);
          const stop = yield* instance
            .stop("quit")
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(renameStarted);
          yield* Deferred.fail(exit, failure);
          yield* Deferred.await(paused);
          const earlyKill = yield* Deferred.await(killed).pipe(
            Effect.timeoutOption("1 millis"),
            Effect.forkChild({ startImmediately: true }),
          );
          yield* TestClock.adjust("1 millis");
          const result = yield* Fiber.join(earlyKill);
          if (outcome === "timeout") {
            yield* TestClock.adjust("999 millis");
            yield* Deferred.await(killed);
          }
          yield* Deferred.succeed(allowRename, undefined);
          yield* Fiber.join(stop);
          assert.isTrue(Option.isNone(result));
        }),
      ),
  );

  it.effect("late intent rename is removed after the observed exit", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const ready = yield* Deferred.make<void>();
        const renameStarted = yield* Deferred.make<void>();
        const allowRename = yield* Deferred.make<void>();
        const removed = yield* Deferred.make<void>();
        const renamed = yield* Deferred.make<void>();
        const exit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
        const files = new Map<string, string>();
        const path = "/intent.json";
        const spawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.gen(function* () {
              yield* Scope.addFinalizer(
                yield* Scope.Scope,
                Deferred.succeed(exit, ChildProcessSpawner.ExitCode(0)).pipe(Effect.asVoid),
              );
              return makeProcess({ exitCode: Deferred.await(exit) });
            }),
          ),
        );
        const instance = yield* makeTestInstance({
          spawnerLayer,
          config: {
            ...baseConfig,
            bootstrap: { ...baseConfig.bootstrap, desktopStopIntentPath: path },
          },
          onReady: Deferred.succeed(ready, undefined).pipe(Effect.asVoid),
          fileSystem: {
            makeDirectory: () => Effect.void,
            writeFileString: (name, value) =>
              Effect.sync(() => {
                files.set(name, value);
              }),
            rename: (from, to) =>
              Deferred.succeed(renameStarted, undefined).pipe(
                Effect.andThen(Deferred.await(allowRename)),
                Effect.andThen(
                  Effect.sync(() => {
                    const value = files.get(from);
                    if (value !== undefined) files.set(to, value);
                    files.delete(from);
                  }),
                ),
                Effect.andThen(Deferred.succeed(renamed, undefined)),
                Effect.asVoid,
              ),
            remove: (name) =>
              Effect.sync(() => {
                files.delete(name);
              }).pipe(
                Effect.andThen(name === path ? Deferred.succeed(removed, undefined) : Effect.void),
                Effect.asVoid,
              ),
          },
        });
        yield* instance.start;
        yield* Deferred.await(ready);
        const stop = yield* instance
          .stop("quit")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(renameStarted);
        yield* TestClock.adjust("1 second");
        yield* Fiber.join(stop);
        yield* Deferred.succeed(allowRename, undefined);
        yield* Deferred.await(renamed);
        yield* Deferred.await(removed);
        assert.isFalse(files.has(path));
      }),
    ),
  );

  it.effect("stalled intent removal does not block recovery scheduling", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const ready = yield* Deferred.make<void>();
        const exit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
        const removing = yield* Deferred.make<void>();
        const allowRemove = yield* Deferred.make<void>();
        const scheduled = yield* Deferred.make<void>();
        const spawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.succeed(makeProcess({ exitCode: Deferred.await(exit) })),
          ),
        );
        const instance = yield* makeTestInstance({
          spawnerLayer,
          config: {
            ...baseConfig,
            bootstrap: { ...baseConfig.bootstrap, desktopStopIntentPath: "/intent.json" },
          },
          onReady: Deferred.succeed(ready, undefined).pipe(Effect.asVoid),
          backendOutputLog: {
            persistFailure: () => Deferred.succeed(scheduled, undefined).pipe(Effect.asVoid),
          },
          fileSystem: {
            remove: () =>
              Deferred.succeed(removing, undefined).pipe(
                Effect.andThen(Deferred.await(allowRemove)),
              ),
          },
        });
        yield* instance.start;
        yield* Deferred.await(ready);
        yield* Deferred.succeed(exit, ChildProcessSpawner.ExitCode(1));
        yield* Deferred.await(removing);
        const observed = yield* Deferred.await(scheduled).pipe(
          Effect.timeoutOption("1 millis"),
          Effect.forkChild({ startImmediately: true }),
        );
        yield* TestClock.adjust("1 millis");
        const result = yield* Fiber.join(observed);
        const restartScheduled = (yield* instance.snapshot).restartScheduled;
        yield* Deferred.succeed(allowRemove, undefined);
        assert.isTrue(Option.isSome(result));
        assert.isTrue(restartScheduled);
      }),
    ),
  );
}
