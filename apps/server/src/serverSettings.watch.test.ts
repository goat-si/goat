import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { ServerSettings } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as ServerConfig from "./config.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import * as ServerSettingsModule from "./serverSettings.ts";

const layerServerSettings = () =>
  ServerSettingsModule.layer.pipe(
    Layer.provide(ServerSecretStore.layer),
    Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
    Layer.provideMerge(
      Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "goat-settings-watch-" })),
    ),
  );

it.layer(NodeServices.layer)("settings watcher recovery", (it) => {
  it.effect.each(["primary", "symlink target"] as const)(
    "reattaches the settings %s watcher and resyncs detached edits and repointing",
    (source) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fail = yield* Deferred.make<void>();
        const closed = yield* Deferred.make<void>();
        const counts = new Map<string, number>();
        let failedDirectory = "";
        const controlledFs = FileSystem.FileSystem.of({
          ...fs,
          watch: (directory, options) =>
            Stream.unwrap(
              Effect.sync(() => {
                const count = (counts.get(directory) ?? 0) + 1;
                counts.set(directory, count);
                options?.onReady?.();
                return directory === failedDirectory && count <= (source === "primary" ? 2 : 1)
                  ? Stream.fromEffect(
                      Effect.gen(function* () {
                        yield* Deferred.await(fail);
                        return yield* PlatformError.systemError({
                          _tag: "Unknown",
                          module: "FileSystem",
                          method: "watch",
                        });
                      }),
                    ).pipe(Stream.ensuring(Deferred.succeed(closed, undefined)))
                  : Stream.never;
              }),
            ),
        });
        yield* Effect.gen(function* () {
          const service = yield* ServerSettingsModule.ServerSettingsService;
          const { settingsPath } = yield* ServerConfig.ServerConfig;
          const original = yield* fs.makeTempDirectoryScoped({ prefix: "goat-watch-original-" });
          const replacement = yield* fs.makeTempDirectoryScoped({
            prefix: "goat-watch-replacement-",
          });
          const oldTarget = path.join(original, "settings.json");
          const newTarget = path.join(replacement, "settings.json");
          const initial = '{ "responseStreamingMode": "turn" }';
          yield* fs.writeFileString(source === "primary" ? settingsPath : oldTarget, initial);
          if (source !== "primary") {
            yield* fs.remove(settingsPath, { force: true });
            yield* fs.symlink(oldTarget, settingsPath);
          }
          failedDirectory = source === "primary" ? path.dirname(settingsPath) : original;
          yield* service.start;
          yield* TestClock.adjust("100 millis");
          const seen = yield* Queue.unbounded<ServerSettings>();
          const subscription = yield* service.subscribeChanges;
          yield* subscription.pipe(
            Stream.runForEach((event) => Queue.offer(seen, event)),
            Effect.forkScoped,
          );
          yield* Deferred.succeed(fail, undefined);
          yield* Deferred.await(closed);
          const changed = '{ "responseStreamingMode": "paragraph" }';
          if (source === "primary") yield* fs.writeFileString(settingsPath, changed);
          else {
            yield* fs.writeFileString(newTarget, changed);
            yield* fs.remove(settingsPath);
            yield* fs.symlink(newTarget, settingsPath);
          }
          yield* TestClock.adjust("1100 millis");
          assert.equal(counts.get(path.dirname(settingsPath)), 4);
          if (source !== "primary") assert.equal(counts.get(replacement), 1);
          assert.equal(yield* Queue.size(seen), 1);
          assert.equal((yield* Queue.take(seen)).responseStreamingMode, "paragraph");
          yield* TestClock.adjust("60 seconds");
          assert.equal(counts.get(path.dirname(settingsPath)), 4);
          assert.equal(yield* Queue.size(seen), 0);
        }).pipe(
          Effect.provide(layerServerSettings()),
          Effect.provideService(FileSystem.FileSystem, controlledFs),
        );
      }).pipe(Effect.scoped),
  );
});
