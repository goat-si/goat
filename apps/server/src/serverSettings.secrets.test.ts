import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as ServerConfig from "./config.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import * as ServerSettings from "./serverSettings.ts";

it.effect(
  "reuses materialized settings without file reads and observes settings and secret changes",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const events = yield* PubSub.unbounded<{
        event: FileSystem.WatchEvent;
        seen: Deferred.Deferred<void>;
      }>();
      let reads = 0;
      let failRead = false;
      const controlledFs = FileSystem.FileSystem.of({
        ...fs,
        readFile: (path) => {
          if (path.endsWith(".bin")) {
            reads++;
            if (failRead)
              return Effect.fail(
                PlatformError.systemError({
                  _tag: "PermissionDenied",
                  module: "FileSystem",
                  method: "readFile",
                  pathOrDescriptor: path,
                }),
              );
          }
          return fs.readFile(path);
        },
        watch: (_path, options) =>
          Stream.unwrap(
            Effect.sync(() => {
              options?.onReady?.();
              return Stream.fromPubSub(events).pipe(
                Stream.flatMap(({ event, seen }) =>
                  Stream.concat(
                    Stream.make(event),
                    Stream.drain(Stream.fromEffect(Deferred.succeed(seen, undefined))),
                  ),
                ),
              );
            }),
          ),
      });
      const layers = ServerSettings.layer.pipe(
        Layer.provideMerge(ServerSecretStore.layer),
        Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
        Layer.provideMerge(
          ServerConfig.layerTest(process.cwd(), { prefix: "goat-settings-cache-" }),
        ),
      );
      yield* Effect.gen(function* () {
        const settings = yield* ServerSettings.ServerSettingsService;
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        const config = yield* ServerConfig.ServerConfig;
        const name = "completion-webhook-secret";
        yield* secrets.set(name, new TextEncoder().encode("first"));
        yield* fs.writeFileString(
          config.settingsPath,
          JSON.stringify({
            completionWebhook: { secret: "••••••" },
          }),
        );
        assert.equal((yield* settings.getSettings).completionWebhook.secret, "first");
        reads = 0;
        const results = yield* Effect.all(
          Array.from({ length: 20 }, () => settings.getSettings),
          {
            concurrency: "unbounded",
          },
        );
        for (const result of results) assert.equal(result.completionWebhook.secret, "first");
        assert.equal(reads, 0, "20 unchanged reads must not access secret files");
        yield* secrets.set(name, new TextEncoder().encode("rotated"));
        reads = 0;
        yield* Effect.all(
          Array.from({ length: 20 }, () => settings.getSettings),
          {
            concurrency: "unbounded",
          },
        );
        assert.equal(reads, 1, "concurrent misses must share one materialization");
        assert.equal((yield* settings.getSettings).completionWebhook.secret, "rotated");
        const updated = yield* settings.updateSettings({ completionWebhook: { secret: "saved" } });
        assert.equal(updated.completionWebhook.secret, "saved");
        assert.equal((yield* settings.getSettings).completionWebhook.secret, "saved");
        yield* fs.writeFile(
          `${config.secretsDir}/${name}.bin`,
          new TextEncoder().encode("external"),
        );
        const seen = yield* Deferred.make<void>();
        yield* PubSub.publish(events, {
          event: { _tag: "Update" as const, path: `${name}.bin` },
          seen,
        });
        yield* Deferred.await(seen);
        assert.equal((yield* settings.getSettings).completionWebhook.secret, "external");
        yield* secrets.set(name, new TextEncoder().encode("retry"));
        failRead = true;
        assert.equal((yield* Effect.flip(settings.getSettings)).operation, "read-secret");
        failRead = false;
        assert.equal((yield* settings.getSettings).completionWebhook.secret, "retry");
        yield* secrets.remove(name);
        assert.equal((yield* settings.getSettings).completionWebhook.secret, "");
      }).pipe(Effect.provide(layers), Effect.provideService(FileSystem.FileSystem, controlledFs));
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("reads secrets afresh when the directory watcher is unavailable", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const layers = ServerSettings.layer.pipe(
      Layer.provideMerge(ServerSecretStore.layer),
      Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), { prefix: "goat-settings-no-watch-" }),
      ),
    );
    yield* Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      const config = yield* ServerConfig.ServerConfig;
      yield* fs.writeFileString(
        config.settingsPath,
        JSON.stringify({
          completionWebhook: { secret: "••••••" },
        }),
      );
      for (const value of ["first", "external"]) {
        yield* fs.writeFile(
          `${config.secretsDir}/completion-webhook-secret.bin`,
          new TextEncoder().encode(value),
        );
        assert.equal((yield* settings.getSettings).completionWebhook.secret, value);
      }
    }).pipe(
      Effect.provide(layers),
      Effect.provideService(FileSystem.FileSystem, { ...fs, watch: () => Stream.empty }),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
