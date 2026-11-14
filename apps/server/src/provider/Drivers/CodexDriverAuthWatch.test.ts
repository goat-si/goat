import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { CodexDriver } from "./CodexDriver.ts";
import { layerTest } from "./CodexDriver.testkit.ts";

const noExecutable = PlatformError.badArgument({
  module: "ChildProcessSpawner",
  method: "spawn",
  description: "The fixture has no Codex executable",
});

// OS watchers can miss events written right after they start, so the tests supply them.
const startAuthWatch = Effect.fn("test.startCodexAuthWatch")(function* (
  onProbe: (count: number) => Effect.Effect<void>,
) {
  const fs = yield* FileSystem.FileSystem;
  const codexHome = yield* fs.makeTempDirectoryScoped({ prefix: "goat-codex-auth-watch-" });
  let watchedPath: string | undefined;
  let probeCount = 0;
  const homeEvents = yield* Queue.unbounded<FileSystem.WatchEvent>();
  // The watcher pulls again only after the previous event passed its filter into the debounce.
  const pulls = yield* Queue.unbounded<void>();
  const probes = yield* Queue.unbounded<void>();
  const watchEnded = yield* Deferred.make<void>();
  yield* CodexDriver.create({
    instanceId: ProviderInstanceId.make("codex-auth-watch"),
    displayName: "Codex auth watch",
    enabled: true,
    environment: [],
    config: { ...CodexDriver.defaultConfig(), homePath: codexHome },
  }).pipe(
    Effect.provideService(FileSystem.FileSystem, {
      ...fs,
      watch: (path) => {
        watchedPath = path;
        return Stream.fromEffectRepeat(
          Queue.offer(pulls, undefined).pipe(Effect.andThen(Queue.take(homeEvents))),
        ).pipe(Stream.ensuring(Deferred.succeed(watchEnded, undefined)));
      },
    }),
    Effect.provideService(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) =>
        ChildProcess.isStandardCommand(command) && command.args.includes("app-server")
          ? Queue.offer(probes, undefined).pipe(
              Effect.andThen(Effect.suspend(() => onProbe(++probeCount))),
              Effect.andThen(Effect.fail(noExecutable)),
            )
          : Effect.fail(noExecutable),
      ),
    ),
  );
  expect(watchedPath).toBe(codexHome);
  yield* Queue.take(probes);
  yield* Queue.take(pulls);
  const consume = (path: string) =>
    Queue.offer(homeEvents, { _tag: "Update", path }).pipe(Effect.andThen(Queue.take(pulls)));
  const deliver = (path: string) =>
    consume(path).pipe(Effect.andThen(TestClock.adjust("250 millis")));
  return { probes, watchEnded, consume, deliver };
});

it.layer(layerTest)("CodexDriver auth.json watch", (it) => {
  it.effect("probes again when auth.json in the Codex home changes", () =>
    Effect.gen(function* () {
      const { probes, consume, deliver } = yield* startAuthWatch(() => Effect.void);
      yield* deliver("other.json");
      yield* deliver("auth.json");
      // Refreshes run in order; the debounce pulls past a later event only after the last one ends.
      yield* consume("auth.json");
      expect((yield* Queue.takeAll(probes)).length).toBe(1);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps watching auth.json after a refresh dies", () =>
    Effect.gen(function* () {
      const { probes, watchEnded, deliver } = yield* startAuthWatch((count) =>
        count === 2 ? Effect.die(new Error("injected probe defect")) : Effect.void,
      );
      yield* deliver("auth.json");
      yield* Queue.take(probes);
      const outcome = yield* Effect.raceFirst(
        Deferred.await(watchEnded).pipe(Effect.as("watch ended")),
        deliver("auth.json").pipe(Effect.andThen(Queue.take(probes)), Effect.as("probed again")),
      );
      expect(outcome).toBe("probed again");
    }).pipe(Effect.scoped),
  );
});
