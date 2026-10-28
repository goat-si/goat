import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { ServerSettings } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as References from "effect/References";
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
  it.effect.each([
    ["primary", "error"],
    ["symlink target", "error"],
    ["primary", "end"],
    ["symlink target", "end"],
  ] as const)(
    "reattaches the settings %s watcher after %s and resyncs detached edits and repointing",
    ([source, outcome]) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fail = yield* Deferred.make<void>();
        const closed = yield* Deferred.make<void>();
        const diagnosed = yield* Deferred.make<void>();
        const reattached = yield* Deferred.make<void>();
        const counts = new Map<string, number>();
        let failedDirectory = "";
        let settingsFile = "";
        let replacementDirectory = "";
        let detached = false;
        let retryLookups = 0;
        let armed = false;
        const logger = Logger.make(({ message }) => {
          if (
            armed &&
            Array.isArray(message) &&
            message[0] === "Background operation stopped; retrying"
          ) {
            Deferred.doneUnsafe(diagnosed, Effect.void);
          }
        });
        const controlledFs = FileSystem.FileSystem.of({
          ...fs,
          readLink: (file) =>
            Effect.suspend(() => {
              if (detached && file === settingsFile) retryLookups++;
              return fs.readLink(file);
            }),
          watch: (directory, options) =>
            Stream.unwrap(
              Effect.sync(() => {
                const count = (counts.get(directory) ?? 0) + 1;
                counts.set(directory, count);
                options?.onReady?.();
                if (
                  (counts.get(path.dirname(settingsFile)) ?? 0) >= 4 &&
                  (source === "primary" || counts.has(replacementDirectory))
                ) {
                  Deferred.doneUnsafe(reattached, Effect.void);
                }
                return directory === failedDirectory && count === 1
                  ? Stream.fromEffect(
                      Effect.gen(function* () {
                        yield* Deferred.await(fail);
                        if (outcome === "error")
                          return yield* PlatformError.systemError({
                            _tag: "Unknown",
                            module: "FileSystem",
                            method: "watch",
                          });
                      }),
                    ).pipe(Stream.drain, Stream.ensuring(Deferred.succeed(closed, undefined)))
                  : Stream.never;
              }),
            ),
        });
        yield* Effect.gen(function* () {
          const service = yield* ServerSettingsModule.ServerSettingsService;
          const { settingsPath } = yield* ServerConfig.ServerConfig;
          settingsFile = settingsPath;
          const original = yield* fs.makeTempDirectoryScoped({ prefix: "goat-watch-original-" });
          const replacement = yield* fs.makeTempDirectoryScoped({
            prefix: "goat-watch-replacement-",
          });
          replacementDirectory = replacement;
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
          yield* service.withSettingsSnapshot(() => Effect.void);
          const seen = yield* Queue.unbounded<ServerSettings>();
          const subscription = yield* service.subscribeChanges;
          yield* subscription.pipe(
            Stream.filter((event) => event.responseStreamingMode === "paragraph"),
            Stream.runForEach((event) => Queue.offer(seen, event)),
            Effect.forkScoped,
          );
          armed = true;
          yield* Deferred.succeed(fail, undefined);
          yield* Deferred.await(closed);
          if (outcome === "error") yield* Deferred.await(diagnosed);
          detached = true;
          const changed = '{ "responseStreamingMode": "paragraph" }';
          if (source === "primary") yield* fs.writeFileString(settingsPath, changed);
          else {
            yield* fs.writeFileString(newTarget, changed);
            yield* fs.remove(settingsPath);
            yield* fs.symlink(newTarget, settingsPath);
          }
          yield* TestClock.adjust("1100 millis");
          assert.isAbove(retryLookups, 0);
          yield* Deferred.await(reattached);
          yield* TestClock.adjust("100 millis");
          assert.equal(counts.get(path.dirname(settingsPath)), 4);
          if (source !== "primary") assert.equal(counts.get(replacement), 1);
          assert.equal((yield* Queue.take(seen)).responseStreamingMode, "paragraph");
          yield* TestClock.adjust("60 seconds");
          assert.equal(counts.get(path.dirname(settingsPath)), 4);
          assert.equal(yield* Queue.size(seen), 0);
        }).pipe(
          Effect.provide(layerServerSettings()),
          Effect.provideService(FileSystem.FileSystem, controlledFs),
          Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
          Effect.provideService(References.MinimumLogLevel, "Trace"),
        );
      }).pipe(Effect.scoped),
  );

  it.effect("repointing settings cancels the old target without restarting healthy watchers", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const notifications = yield* PubSub.unbounded<FileSystem.WatchEvent>();
      const oldAttached = yield* Deferred.make<void>();
      const oldClosed = yield* Deferred.make<void>();
      const newAttached = yield* Deferred.make<void>();
      const counts = new Map<string, number>();
      const active = new Map<string, number>();
      let oldDirectory = "";
      let newDirectory = "";
      const controlledFs = FileSystem.FileSystem.of({
        ...fs,
        watch: (directory, options) =>
          Stream.unwrap(
            Effect.gen(function* () {
              const subscription = yield* PubSub.subscribe(notifications);
              counts.set(directory, (counts.get(directory) ?? 0) + 1);
              active.set(directory, (active.get(directory) ?? 0) + 1);
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  active.set(directory, (active.get(directory) ?? 0) - 1);
                  if (directory === oldDirectory) Deferred.doneUnsafe(oldClosed, Effect.void);
                }),
              );
              options?.onReady?.();
              if (directory === oldDirectory) Deferred.doneUnsafe(oldAttached, Effect.void);
              if (directory === newDirectory) Deferred.doneUnsafe(newAttached, Effect.void);
              return Stream.fromSubscription(subscription).pipe(
                Stream.filter((event) => path.dirname(event.path) === directory),
              );
            }),
          ),
      });
      yield* Effect.gen(function* () {
        const service = yield* ServerSettingsModule.ServerSettingsService;
        const { settingsPath } = yield* ServerConfig.ServerConfig;
        oldDirectory = yield* fs.makeTempDirectoryScoped({ prefix: "goat-watch-old-" });
        newDirectory = yield* fs.makeTempDirectoryScoped({ prefix: "goat-watch-new-" });
        const oldTarget = path.join(oldDirectory, "settings.json");
        const newTarget = path.join(newDirectory, "settings.json");
        yield* fs.writeFileString(oldTarget, '{ "responseStreamingMode": "turn" }');
        yield* fs.writeFileString(newTarget, '{ "responseStreamingMode": "paragraph" }');
        yield* fs.remove(settingsPath, { force: true });
        yield* fs.symlink(oldTarget, settingsPath);
        yield* service.start;
        yield* Deferred.await(oldAttached);
        yield* TestClock.adjust("100 millis");
        yield* service.withSettingsSnapshot(() => Effect.void);
        const seen = yield* Queue.unbounded<ServerSettings>();
        const changes = yield* service.subscribeChanges;
        yield* changes.pipe(
          Stream.filter((settings) => settings.responseStreamingMode === "paragraph"),
          Stream.runForEach((settings) => Queue.offer(seen, settings)),
          Effect.forkScoped,
        );
        yield* fs.remove(settingsPath);
        yield* fs.symlink(newTarget, settingsPath);
        yield* PubSub.publish(notifications, { _tag: "Update", path: settingsPath });
        yield* Deferred.await(newAttached);
        yield* Deferred.await(oldClosed);
        yield* TestClock.adjust("100 millis");
        assert.equal((yield* Queue.take(seen)).responseStreamingMode, "paragraph");
        yield* TestClock.adjust("60 seconds");
        assert.equal(counts.get(path.dirname(settingsPath)), 2);
        assert.equal(counts.get(oldDirectory), 1);
        assert.equal(counts.get(newDirectory), 1);
        assert.equal(active.get(oldDirectory), 0);
        assert.equal(active.get(newDirectory), 1);
      }).pipe(
        Effect.provide(layerServerSettings()),
        Effect.provideService(FileSystem.FileSystem, controlledFs),
      );
    }).pipe(Effect.scoped),
  );
});
