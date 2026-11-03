import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
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
  it.effect.each(["write", "concurrent", "failure", "timeout", "unobserved", "no-path"] as const)(
    "stop intent is safe before release: %s",
    (scenario) =>
      Effect.scoped(
        Effect.gen(function* () {
          const ready = yield* Deferred.make<void>();
          const renameStarted = yield* Deferred.make<void>();
          const allowRename = yield* Deferred.make<void>();
          const released = yield* Deferred.make<void>();
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
                    }),
                  ),
                ),
              remove: (name) =>
                Effect.sync(() => {
                  files.delete(name);
                }),
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
            assert.equal(files.has(path), scenario === "unobserved");
          } else {
            assert.isUndefined(atRelease);
          }
          if (scenario === "failure" || scenario === "timeout") {
            yield* Deferred.await(warned);
            assert.include(warnings, "backend stop intent not written");
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
}
