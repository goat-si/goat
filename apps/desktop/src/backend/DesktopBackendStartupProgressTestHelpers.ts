import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import type * as Harness from "./DesktopBackendManager.test.ts";

export function registerStartupProgressTests({
  makeTestInstance,
  makeProcess,
}: {
  makeTestInstance: typeof Harness.makeTestInstance;
  makeProcess: typeof Harness.makeProcess;
}) {
  it.effect("a chatty backend stays out of startup recovery until output stops", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const chunks = yield* Queue.unbounded<Uint8Array>();
        const consumed = yield* Queue.unbounded<void>();
        const reports = yield* Queue.unbounded<string>();
        const probed = yield* Deferred.make<void>();
        const spawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.gen(function* () {
              const exit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
              yield* Scope.addFinalizer(
                yield* Scope.Scope,
                Deferred.succeed(exit, ChildProcessSpawner.ExitCode(0)).pipe(Effect.asVoid),
              );
              return makeProcess({
                stderr: Stream.fromQueue(chunks).pipe(Stream.take(12)),
                exitCode: Deferred.await(exit),
              });
            }),
          ),
        );
        const httpClientLayer = Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make(() =>
            Deferred.succeed(probed, undefined).pipe(Effect.andThen(Effect.never)),
          ),
        );
        const instance = yield* makeTestInstance({
          spawnerLayer,
          httpClientLayer,
          onStartupFailure: (failure) => Queue.offer(reports, failure.reason).pipe(Effect.asVoid),
          backendOutputLog: {
            writeOutputChunk: () => Queue.offer(consumed, undefined).pipe(Effect.asVoid),
          },
        });
        yield* instance.start;
        yield* Deferred.await(probed);
        for (let n = 0; n < 12; n++) {
          yield* TestClock.adjust("15 seconds");
          yield* Queue.offer(chunks, new TextEncoder().encode("still starting"));
          yield* Queue.take(consumed);
        }
        const beforeStall = yield* Queue.size(reports);
        yield* TestClock.adjust("60 seconds");
        const report = yield* Queue.take(reports);
        assert.equal(beforeStall, 0);
        assert.equal(report, "The server printed nothing for 60 seconds.");
        yield* TestClock.adjust("2 minutes");
        assert.equal(yield* Queue.size(reports), 0);
      }),
    ),
  );
}
