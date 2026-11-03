import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as StopIntent from "./desktopStopIntent.ts";

const intent = {
  version: 1,
  pid: 123,
  reason: "relaunch",
  requestedAt: "2026-01-01T00:00:00Z",
} as const;

it.effect.each(["match", "other-pid", "invalid", "no-pid", "oversized"] as const)(
  "reads and removes %s intent",
  (scenario) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = (yield* Path.Path).join(yield* fs.makeTempDirectoryScoped(), "intent.json");
      const noPid = {
        version: intent.version,
        reason: intent.reason,
        requestedAt: intent.requestedAt,
      };
      yield* fs.writeFileString(
        path,
        scenario === "invalid"
          ? "{"
          : scenario === "oversized"
            ? JSON.stringify(intent).padEnd(4097, " ")
            : JSON.stringify(scenario === "no-pid" ? noPid : intent),
      );
      yield* Effect.gen(function* () {
        const reader = yield* StopIntent.DesktopStopIntentReader;
        const expected =
          scenario === "match"
            ? Option.some(intent)
            : scenario === "no-pid"
              ? Option.some(noPid)
              : Option.none();
        assert.deepStrictEqual(yield* reader.atShutdown, expected);
        assert.isFalse(yield* fs.exists(path));
        yield* fs.writeFileString(path, JSON.stringify({ ...intent, reason: "quit" }));
        assert.deepStrictEqual(yield* reader.atShutdown, expected);
      }).pipe(Effect.provide(StopIntent.layer(path, scenario === "other-pid" ? 456 : 123)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("missing intent can appear later and concurrent readers share the result", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = (yield* Path.Path).join(yield* fs.makeTempDirectoryScoped(), "intent.json");
    let removes = 0;
    const countedFs = FileSystem.FileSystem.of({
      ...fs,
      remove: (...args) => {
        removes++;
        return fs.remove(...args);
      },
    });
    yield* Effect.gen(function* () {
      const reader = yield* StopIntent.DesktopStopIntentReader;
      assert.deepStrictEqual(yield* reader.atShutdown, Option.none());
      yield* fs.writeFileString(path, JSON.stringify(intent));
      const results = yield* Effect.all([reader.atShutdown, reader.atShutdown], {
        concurrency: "unbounded",
      });
      assert.deepStrictEqual(results, [Option.some(intent), Option.some(intent)]);
      assert.isFalse(yield* fs.exists(path));
      assert.equal(removes, 1);
      assert.deepStrictEqual(yield* reader.atShutdown, Option.some(intent));
    }).pipe(
      Effect.provide(StopIntent.layer(path, 123)),
      Effect.provideService(FileSystem.FileSystem, countedFs),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("an absent channel returns none", () =>
  Effect.gen(function* () {
    const reader = yield* StopIntent.DesktopStopIntentReader;
    assert.deepStrictEqual(yield* reader.atShutdown, Option.none());
  }).pipe(Effect.provide(StopIntent.layer(undefined, 123).pipe(Layer.provide(NodeServices.layer)))),
);

it.effect("permission denied is cached as a terminal result", () =>
  Effect.gen(function* () {
    let reads = 0;
    const fs = FileSystem.layerNoop({
      stream: (path) => {
        reads++;
        return Stream.fail(
          PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "stream",
            pathOrDescriptor: path,
          }),
        );
      },
    });
    yield* Effect.gen(function* () {
      const reader = yield* StopIntent.DesktopStopIntentReader;
      assert.deepStrictEqual(yield* reader.atShutdown, Option.none());
      assert.deepStrictEqual(yield* reader.atShutdown, Option.none());
      assert.equal(reads, 1);
    }).pipe(Effect.provide(StopIntent.layer("/intent.json", 123).pipe(Layer.provide(fs))));
  }),
);

it.effect.each(["read", "delete", "concurrent"] as const)("stalled %s is bounded", (scenario) =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const fs = FileSystem.layerNoop({
      stream: () =>
        scenario === "delete"
          ? Stream.fromIterable([new TextEncoder().encode(JSON.stringify(intent))])
          : Stream.fromEffect(
              Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
            ),
      remove: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
    });
    yield* Effect.gen(function* () {
      const reader = yield* StopIntent.DesktopStopIntentReader;
      const calls =
        scenario === "concurrent" ? [reader.atShutdown, reader.atShutdown] : [reader.atShutdown];
      const fiber = yield* Effect.all(calls, { concurrency: "unbounded" }).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.await(started);
      yield* TestClock.adjust("1 second");
      assert.deepStrictEqual(
        yield* Fiber.join(fiber),
        calls.map(() => Option.none()),
      );
    }).pipe(Effect.provide(StopIntent.layer("/intent", 123).pipe(Layer.provide(fs))));
  }),
);
