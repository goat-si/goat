import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import { withCheckpointRestoreReservation } from "./checkpointRestoreReservation.ts";
import { tryTurnStartReservation } from "./testkit/turnStartReservation.ts";

// realPath models a symlink alias and a worktree storage cleanup removed.
const makeFileSystem = (realPaths: Record<string, string>, missing: ReadonlyArray<string> = []) =>
  FileSystem.makeNoop({
    realPath: (candidate) =>
      missing.includes(candidate)
        ? Effect.fail(
            PlatformError.systemError({
              _tag: "NotFound",
              module: "FileSystem",
              method: "realPath",
              pathOrDescriptor: candidate,
            }),
          )
        : Effect.succeed(realPaths[candidate] ?? candidate),
  });

const holdRestore = (fileSystem: FileSystem.FileSystem, cwd: string) =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const fiber = yield* withCheckpointRestoreReservation(
      fileSystem,
      yield* Path.Path,
      cwd,
      Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
    ).pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(entered);
    return { fiber, release };
  });

const tryStart = (fileSystem: FileSystem.FileSystem, cwd: string) =>
  Effect.flatMap(Path.Path, (path) =>
    tryTurnStartReservation(fileSystem, path, cwd, Effect.succeed("started")),
  );

it.effect.each([
  {
    overlap: "the same checkout",
    restore: "/repo/a",
    start: "/repo/a",
    realPaths: {},
    missing: [],
  },
  {
    overlap: "a folder inside it",
    restore: "/repo/a",
    start: "/repo/a/pkg",
    realPaths: {},
    missing: [],
  },
  {
    overlap: "the folder holding it",
    restore: "/repo/a/pkg",
    start: "/repo/a",
    realPaths: {},
    missing: [],
  },
  {
    overlap: "a symlink alias of it",
    restore: "/links/a",
    start: "/repo/a",
    realPaths: { "/links/a": "/repo/a" },
    missing: [],
  },
  {
    overlap: "a removed worktree under an alias of it",
    restore: "/links/a/gone",
    start: "/repo/a/gone",
    realPaths: { "/links/a": "/repo/a" },
    missing: ["/links/a/gone", "/repo/a/gone"],
  },
] as const)("a turn start in $overlap of a running file restore goes back to retry", (testCase) =>
  Effect.gen(function* () {
    const fileSystem = makeFileSystem(testCase.realPaths, testCase.missing);
    const restore = yield* holdRestore(fileSystem, testCase.restore);
    assert.isTrue(Option.isNone(yield* tryStart(fileSystem, testCase.start)));
    yield* Deferred.succeed(restore.release, undefined);
    yield* Fiber.join(restore.fiber);
    assert.deepStrictEqual(yield* tryStart(fileSystem, testCase.start), Option.some("started"));
  }).pipe(Effect.provide(Path.layer)),
);

it.effect("a sibling folder and other turn starts are not held back", () =>
  Effect.gen(function* () {
    const fileSystem = makeFileSystem({});
    const restore = yield* holdRestore(fileSystem, "/repo/a");
    assert.deepStrictEqual(yield* tryStart(fileSystem, "/repo/ab"), Option.some("started"));
    const path = yield* Path.Path;
    const inner = yield* tryTurnStartReservation(
      fileSystem,
      path,
      "/repo/b",
      tryStart(fileSystem, "/repo/b"),
    );
    assert.deepStrictEqual(inner, Option.some(Option.some("started")));
    yield* Deferred.succeed(restore.release, undefined);
    yield* Fiber.join(restore.fiber);
  }).pipe(Effect.provide(Path.layer)),
);

it.effect("a restore waits for a running turn start, and a failed restore releases", () =>
  Effect.gen(function* () {
    const fileSystem = makeFileSystem({});
    const path = yield* Path.Path;
    const events: Array<string> = [];
    const startEntered = yield* Deferred.make<void>();
    const finishStart = yield* Deferred.make<void>();
    const start = yield* tryTurnStartReservation(
      fileSystem,
      path,
      "/repo/a",
      Deferred.succeed(startEntered, undefined).pipe(
        Effect.andThen(Deferred.await(finishStart)),
        Effect.andThen(Effect.sync(() => events.push("start done"))),
      ),
    ).pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(startEntered);
    const restore = yield* withCheckpointRestoreReservation(
      fileSystem,
      path,
      "/repo/a",
      Effect.sync(() => events.push("restore ran")).pipe(Effect.andThen(Effect.fail("boom"))),
    ).pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
    yield* Deferred.succeed(finishStart, undefined);
    yield* Fiber.join(start);
    assert.strictEqual(yield* Fiber.join(restore), "boom");
    assert.deepStrictEqual(events, ["start done", "restore ran"]);
    assert.deepStrictEqual(yield* tryStart(fileSystem, "/repo/a"), Option.some("started"));
  }).pipe(Effect.provide(Path.layer)),
);

it.effect("an interrupted restore releases its reservation", () =>
  Effect.gen(function* () {
    const fileSystem = makeFileSystem({});
    const restore = yield* holdRestore(fileSystem, "/repo/a");
    yield* Fiber.interrupt(restore.fiber);
    assert.deepStrictEqual(yield* tryStart(fileSystem, "/repo/a"), Option.some("started"));
  }).pipe(Effect.provide(Path.layer)),
);
