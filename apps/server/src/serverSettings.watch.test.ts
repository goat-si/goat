import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { ServerSettings } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
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
import { makeCuaCommittedPolicy } from "./cuaCommittedPolicy.ts";

const layerServerSettings = () =>
  ServerSettingsModule.layer.pipe(
    Layer.provide(ServerSecretStore.layer),
    Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
    Layer.provideMerge(
      Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "goat-settings-watch-" })),
    ),
  );

it.effect("acknowledging a policy batch preserves newer unprocessed restrictions", () =>
  Effect.gen(function* () {
    const service = yield* ServerSettingsModule.ServerSettingsService;
    const feed = yield* service.committedPolicyChanges ?? Effect.die("missing policy feed");
    const changes = yield* feed.changes.pipe(Stream.toQueue({ capacity: "unbounded" }));
    (yield* Queue.take(changes)).acknowledge();
    yield* service.updateSettings({ blockedBrowserHosts: ["a.test"] });
    const batch = yield* Queue.take(changes);
    assert.deepEqual(batch.hosts, ["a.test"]);
    yield* service.updateSettings({ blockedBrowserHosts: ["b.test"] });
    yield* service.updateSettings({ blockedBrowserHosts: [] });
    batch.acknowledge();
    assert.deepEqual(yield* feed.pending, ["b.test"]);
  }).pipe(Effect.scoped, Effect.provide(ServerSettingsModule.layerTest())),
);

it.effect(
  "committed policy feeds fail closed when a host list exceeds the history size limit",
  () =>
    Effect.gen(function* () {
      const settings = yield* (yield* ServerSettingsModule.ServerSettingsService).getSettings;
      const policy = yield* makeCuaCommittedPolicy;
      yield* policy.publish(settings, Option.none());
      const feed = yield* policy.subscribeRestrictions;
      yield* policy.publish(
        { ...settings, blockedBrowserHosts: ["a".repeat(262_145)] },
        Option.none(),
      );
      const changes = yield* feed.changes.pipe(Stream.toQueue({ capacity: "unbounded" }));
      assert.isUndefined((yield* Queue.take(changes)).hosts);
    }).pipe(Effect.scoped, Effect.provide(ServerSettingsModule.layerTest())),
);

it.effect("committed policy feeds retain transient blocks while a subscriber is held", () =>
  Effect.gen(function* () {
    const service = yield* ServerSettingsModule.ServerSettingsService;
    const feed = yield* service.committedPolicyChanges ?? Effect.die("missing policy feed");
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let first = true;
    const changes = yield* feed.changes.pipe(
      Stream.mapEffect((value) => {
        if (!first) return Effect.succeed(value);
        first = false;
        return Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as(value),
        );
      }),
      Stream.toQueue({ capacity: "unbounded" }),
    );
    yield* Deferred.await(entered);
    yield* service.updateSettings({ blockedBrowserHosts: ["a.test"] });
    yield* service.updateSettings({ blockedBrowserHosts: ["b.test"] });
    yield* service.updateSettings({ blockedBrowserHosts: [] });
    yield* Deferred.succeed(release, undefined);
    yield* Queue.take(changes);
    assert.deepEqual((yield* Queue.take(changes)).hosts, ["a.test", "b.test"]);
  }).pipe(Effect.scoped, Effect.provide(ServerSettingsModule.layerTest())),
);

it.effect("committed policy feeds fail closed when a subscriber falls behind", () =>
  Effect.gen(function* () {
    const service = yield* ServerSettingsModule.ServerSettingsService;
    const feed = yield* service.committedPolicyChanges ?? Effect.die("missing policy feed");
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let first = true;
    const changes = yield* feed.changes.pipe(
      Stream.mapEffect((value) => {
        if (!first) return Effect.succeed(value);
        first = false;
        return Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as(value),
        );
      }),
      Stream.toQueue({ capacity: "unbounded" }),
    );
    yield* Deferred.await(entered);
    for (let i = 0; i < 65; i++)
      yield* service.updateSettings({ blockedBrowserHosts: [`site${i}.test`] });
    assert.isUndefined(yield* feed.pending);
    yield* Deferred.succeed(release, undefined);
    yield* Queue.take(changes);
    assert.isUndefined((yield* Queue.take(changes)).hosts);
  }).pipe(Effect.scoped, Effect.provide(ServerSettingsModule.layerTest())),
);

it.effect(
  "independent policy subscribers each receive restrictions published before stream startup",
  () =>
    Effect.gen(function* () {
      const service = yield* ServerSettingsModule.ServerSettingsService;
      const subscribe = service.committedPolicyChanges;
      if (subscribe === undefined) return assert.fail("missing policy feed");
      const first = yield* subscribe;
      const second = yield* subscribe;
      yield* service.updateSettings({ blockedBrowserHosts: ["example.test"] });
      yield* service.updateSettings({ blockedBrowserHosts: [] });
      const firstQueue = yield* first.changes.pipe(Stream.toQueue({ capacity: "unbounded" }));
      const secondQueue = yield* second.changes.pipe(Stream.toQueue({ capacity: "unbounded" }));
      assert.deepEqual((yield* Queue.take(firstQueue)).hosts, ["example.test"]);
      assert.deepEqual((yield* Queue.take(secondQueue)).hosts, ["example.test"]);
    }).pipe(Effect.scoped, Effect.provide(ServerSettingsModule.layerTest())),
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
        const links = new Map<string, string>();
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
            Effect.gen(function* () {
              if (detached && file === settingsFile) retryLookups++;
              const target = links.get(file);
              if (target === undefined)
                return yield* PlatformError.systemError({
                  _tag: "NotFound",
                  module: "FileSystem",
                  method: "readLink",
                });
              return target;
            }),
          realPath: (file) => Effect.succeed(path.resolve(file)),
          makeDirectory: (directory, options) =>
            directory === failedDirectory || directory === replacementDirectory
              ? Effect.void
              : fs.makeDirectory(directory, options),
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
            links.set(settingsPath, oldTarget);
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
            links.set(settingsPath, newTarget);
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
        const update: FileSystem.WatchEvent = { _tag: "Update", path: settingsPath };
        yield* PubSub.publish(notifications, update);
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

// File operations remain real; this external watch seam delivers notifications
// after their commits instead of relying on macOS's first native event timing.
const withRegisteredSettingsWatchers = <A, E, R>(
  use: (
    awaitWatch: (directory: string, count?: number) => Effect.Effect<void>,
    notify: (filePath: string) => Effect.Effect<void>,
  ) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const events = yield* PubSub.unbounded<{
      event: FileSystem.WatchEvent;
      seen: Deferred.Deferred<void>;
    }>();
    const registrations = new Map<string, Deferred.Deferred<void>>();
    const counts = new Map<string, number>();
    const registration = (directory: string, count = 1) => {
      const key = `${directory}:${count}`;
      let deferred = registrations.get(key);
      if (!deferred) {
        deferred = Deferred.makeUnsafe<void>();
        registrations.set(key, deferred);
      }
      return deferred;
    };
    const notify = (filePath: string) =>
      Effect.gen(function* () {
        const seen = yield* Deferred.make<void>();
        yield* PubSub.publish(events, { event: { _tag: "Update" as const, path: filePath }, seen });
        if ((counts.get(path.dirname(filePath)) ?? 0) > 0) yield* Deferred.await(seen);
      });
    const controlledFs = FileSystem.FileSystem.of({
      ...fs,
      rename: (from, to) => fs.rename(from, to).pipe(Effect.tap(() => notify(to))),
      remove: (filePath, options) =>
        fs.remove(filePath, options).pipe(Effect.tap(() => notify(filePath))),
      symlink: (from, to) => fs.symlink(from, to).pipe(Effect.tap(() => notify(to))),
      watch: (directory, options) =>
        Stream.unwrap(
          PubSub.subscribe(events).pipe(
            Effect.tap(() => {
              options?.onReady?.();
              const count = (counts.get(directory) ?? 0) + 1;
              counts.set(directory, count);
              return Deferred.succeed(registration(directory, count), undefined);
            }),
            Effect.map((subscription) =>
              Stream.fromSubscription(subscription).pipe(
                Stream.filter(({ event }) => path.dirname(event.path) === directory),
                Stream.tap(({ seen }) => Deferred.succeed(seen, undefined)),
                Stream.map(({ event }) => event),
              ),
            ),
          ),
        ),
    });
    return yield* use(
      (directory, count) => Deferred.await(registration(directory, count)),
      notify,
    ).pipe(
      Effect.provide(layerServerSettings()),
      Effect.provideService(FileSystem.FileSystem, controlledFs),
    );
  });

it.effect("computer use policy is published at rename before cleanup", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let hold = false;
    const controlledFs = FileSystem.FileSystem.of({
      ...fs,
      remove: (path, options) =>
        Effect.gen(function* () {
          if (hold && path.includes("settings.json.")) {
            hold = false;
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
          }
          yield* fs.remove(path, options);
        }),
    });
    yield* Effect.gen(function* () {
      const service = yield* ServerSettingsModule.ServerSettingsService;
      yield* service.start;
      assert.isDefined(service.committedPolicy);
      assert.deepStrictEqual(
        yield* service.committedPolicy ?? Effect.die("missing committed policy"),
        {
          _tag: "committed",
          enableCua: false,
          blockedBrowserHosts: [],
        },
      );
      yield* service.updateSettings({ enableCua: true });
      hold = true;
      const writer = yield* service.updateSettings({ enableCua: false }).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      assert.deepStrictEqual(
        yield* service.committedPolicy ?? Effect.die("missing committed policy"),
        {
          _tag: "committed",
          enableCua: false,
          blockedBrowserHosts: [],
        },
      );
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(writer);
    }).pipe(
      Effect.provide(layerServerSettings()),
      Effect.provideService(FileSystem.FileSystem, controlledFs),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("computer use policy follows locked reloads and fails closed on read failure", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    let failRead = false;
    const failure = PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method: "readFileString",
      description: "test read failure",
    });
    const controlledFs = FileSystem.FileSystem.of({
      ...fs,
      readFileString: (path, options) =>
        Effect.suspend(() => (failRead ? Effect.fail(failure) : fs.readFileString(path, options))),
    });
    yield* Effect.gen(function* () {
      const service = yield* ServerSettingsModule.ServerSettingsService;
      const config = yield* ServerConfig.ServerConfig;
      yield* fs.writeFileString(
        config.settingsPath,
        JSON.stringify({ enableCua: true, blockedBrowserHosts: ["example.com"] }),
      );
      assert.deepStrictEqual(
        yield* service.committedPolicy ?? Effect.die("missing committed policy"),
        { _tag: "unavailable" },
      );
      yield* service.start;
      assert.deepStrictEqual(
        yield* service.committedPolicy ?? Effect.die("missing committed policy"),
        {
          _tag: "committed",
          enableCua: true,
          blockedBrowserHosts: ["example.com"],
        },
      );
      failRead = true;
      yield* Effect.exit(service.updateSettings({ standingInstructions: "test" }));
      assert.deepStrictEqual(
        yield* service.committedPolicy ?? Effect.die("missing committed policy"),
        { _tag: "unavailable" },
      );
      failRead = false;
      yield* fs.writeFileString(config.settingsPath, "{");
      yield* Effect.exit(service.updateSettings({ standingInstructions: "test" }));
      assert.deepStrictEqual(
        yield* service.committedPolicy ?? Effect.die("missing committed policy"),
        { _tag: "unavailable" },
      );
      yield* fs.writeFileString(config.settingsPath, JSON.stringify({ enableCua: false }));
      yield* service.updateSettings({ standingInstructions: "test" });
      assert.deepStrictEqual(
        yield* service.committedPolicy ?? Effect.die("missing committed policy"),
        {
          _tag: "committed",
          enableCua: false,
          blockedBrowserHosts: [],
        },
      );
    }).pipe(
      Effect.provide(layerServerSettings()),
      Effect.provideService(FileSystem.FileSystem, controlledFs),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("computer use policy follows external edits at watcher revalidation", () =>
  withRegisteredSettingsWatchers((awaitWatch, notify) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const service = yield* ServerSettingsModule.ServerSettingsService;
      yield* service.start;
      yield* awaitWatch(path.dirname(config.settingsPath), 2);
      const changes = yield* service.subscribeChanges;
      yield* fs.writeFileString(
        config.settingsPath,
        JSON.stringify({ enableCua: true, blockedBrowserHosts: ["example.com"] }),
      );
      yield* notify(config.settingsPath);
      yield* TestClock.adjust(100);
      yield* changes.pipe(Stream.runHead);
      assert.deepStrictEqual(
        yield* service.committedPolicy ?? Effect.die("missing committed policy"),
        {
          _tag: "committed",
          enableCua: true,
          blockedBrowserHosts: ["example.com"],
        },
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
