import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";
import type * as Harness from "./DesktopBackendManager.test.ts";
import type { SlowCrashInfo, RecoveryActions } from "./DesktopBackendSlowCrash.ts";

export function registerSlowCrashTests({
  makeTestInstance,
  makeProcess,
  baseConfig,
}: {
  makeTestInstance: typeof Harness.makeTestInstance;
  makeProcess: typeof Harness.makeProcess;
  baseConfig: Parameters<typeof Harness.makeTestInstance>[0]["config"] & {};
}) {
  it.effect(
    "slow crashes survive healthy resets, notify once, keep restarting and remain visible until expired",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const exits = yield* Queue.unbounded<Deferred.Deferred<ChildProcessSpawner.ExitCode>>();
          const ready = yield* Queue.unbounded<void>();
          const notices = yield* Queue.unbounded<SlowCrashInfo>();
          const dialogs = yield* Queue.unbounded<RecoveryActions>();
          const spawnerLayer = Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() =>
              Effect.gen(function* () {
                const exit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
                yield* Scope.addFinalizer(
                  yield* Scope.Scope,
                  Deferred.succeed(exit, ChildProcessSpawner.ExitCode(0)).pipe(Effect.asVoid),
                );
                yield* Queue.offer(exits, exit);
                return makeProcess({ exitCode: Deferred.await(exit) });
              }),
            ),
          );
          const instance = yield* makeTestInstance({
            config: { ...baseConfig, backendLogPath: "/logs" },
            spawnerLayer,
            onReady: Queue.offer(ready, undefined).pipe(Effect.asVoid),
            onSlowCrash: (info) => Queue.offer(notices, info).pipe(Effect.asVoid),
            onRecoveryPaused: (actions) => Queue.offer(dialogs, actions).pipe(Effect.asVoid),
          });
          yield* instance.start;
          let exit = yield* Queue.take(exits);
          yield* Queue.take(ready);
          for (let n = 0; n < 5; n++) {
            yield* TestClock.adjust("10 minutes");
            yield* Deferred.succeed(exit, ChildProcessSpawner.ExitCode(1));
            yield* TestClock.adjust("30 seconds");
            exit = yield* Queue.take(exits);
            yield* Queue.take(ready);
          }
          assert.equal(yield* Queue.size(notices), 1);
          const notice = yield* Queue.take(notices);
          assert.equal(notice.history.length, 4);
          yield* instance.showRecovery ?? Effect.void;
          assert.equal(yield* Queue.size(dialogs), 1);
          const dialog = yield* Queue.take(dialogs);
          assert.equal(dialog.reason, "slow-crash");
          yield* TestClock.adjust("6 hours");
          yield* instance.showRecovery ?? Effect.void;
          assert.equal(yield* Queue.size(dialogs), 0);
        }),
      ),
  );
}
